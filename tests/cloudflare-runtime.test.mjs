import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

// Entirely local Workers runtime. No GitHub exchange or real credentials.
const root = resolve(import.meta.dirname, '..'), origin = 'http://127.0.0.1:8803';
const config = JSON.parse(await readFile(resolve(root, 'wrangler.jsonc'), 'utf8'));
config.name = 'luna-runtime-test';
config.main = resolve(root, config.main);
config.assets.directory = resolve(root, config.assets.directory);
delete config.build;
config.vars = { ...config.vars, PUBLIC_ORIGIN: origin, ALLOW_HTTP_LOCALHOST: 'true',
  GITHUB_CLIENT_ID: 'fixture-client', GITHUB_CLIENT_SECRET: 'fixture-secret', TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32) };
await mkdir(resolve(root, 'work'), { recursive: true });
const file = resolve(root, 'work/runtime-test.json');
await writeFile(file, JSON.stringify(config));
await writeFile(resolve(root, 'work/.dev.vars'), 'GITHUB_CLIENT_SECRET=fixture-secret\nTOKEN_ENCRYPTION_KEY=' + 'ab'.repeat(32) + '\n');
const persistence = await mkdtemp(join(tmpdir(), 'luna-test-'));
const child = spawn(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'),
  'dev', '--local', '--config', file, '--port', '8803', '--ip', '127.0.0.1', '--persist-to', persistence],
{ cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
let startupLog = '';
child.stdout.on('data', data => { startupLog += data; });
child.stderr.on('data', data => { startupLog += data; });
try {
  const deadline = Date.now() + 45_000;
  let ready = false;
  while (Date.now() < deadline) {
    try { if ((await fetch(origin, { signal: AbortSignal.timeout(1500) })).status === 200) { ready = true; break; } } catch {}
    await setTimeout(250);
  }
  assert.ok(ready, 'local Worker starts: ' + startupLog.replace(/\b[a-f0-9]{32,}\b/gi, '[redacted]').slice(0, 4000));
  const home = await fetch(origin); assert.match(await home.text(), /name="luna-auth"/);
  assert.equal((await (await fetch(origin + '/auth/session')).json()).authenticated, false);
  const start = await fetch(origin + '/auth/start', { method: 'POST', headers: { Origin: origin } });
  assert.equal(start.status, 200);
  const target = new URL((await start.json()).authorizeUrl);
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  const cookie = start.headers.getSetCookie()[0].split(';')[0];
  const cancelled = await fetch(origin + '/auth/callback?error=access_denied&state=' + target.searchParams.get('state'),
    { redirect: 'manual', headers: { Cookie: cookie } });
  assert.equal(cancelled.status, 303); assert.equal(cancelled.headers.get('location')?.split('&')[0], '/?auth=failed');
  assert.equal((await fetch(origin + '/server/store-core.mjs')).status, 404);
  assert.equal((await fetch(origin + '/.dev.vars')).status, 404);
  assert.equal((await fetch(origin + '/api/github/repos/3r0xy/my-vault')).status, 401);
  for (let i = 1; i < 20; i++) assert.equal((await fetch(origin + '/auth/start', { method: 'POST', headers: { Origin: origin } })).status, 200);
  assert.equal((await fetch(origin + '/auth/start', { method: 'POST', headers: { Origin: origin } })).status, 429);
  console.log('PASS Workers runtime: SQLite, encrypted state, callback, public assets, unauthenticated access, login rate limit');
} finally {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}
