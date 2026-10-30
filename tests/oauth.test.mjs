import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, hash } from '../server/store.mjs';
import { createApp, allowedTarget, vaultData } from '../server/app.mjs';
import { readConfig } from '../server/config.mjs';

const key = 'ab'.repeat(32); // Synthetic fixture, never used outside tests.
async function fixture(t, change = {}) {
  let time = Date.now();
  const store = new Store(':memory:', key), calls = [];
  const config = { origin: '', secure: true, clientId: 'fixture-client', clientSecret: 'fixture-secret',
    userId: '60850311', owner: '3r0xy', repo: 'my-vault', write: false, lifetime: 30 * 86400_000, ...change };
  const provider = { userId: 60850311, scope: 'repo', expires: null, denied: false, api401: false, refreshFail: false };
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    assert.equal(options.redirect, 'error');
    if (url === 'https://github.com/login/oauth/access_token') {
      const params = new URLSearchParams(options.body);
      assert.equal(params.get('client_secret'), 'fixture-secret');
      if (provider.denied || (provider.refreshFail && params.has('refresh_token'))) return Response.json({ error: 'bad_verification_code' });
      return Response.json({ access_token: params.has('refresh_token') ? 'fixture-refreshed' : 'fixture-token',
        token_type: 'bearer', scope: provider.scope, ...(provider.expires ? { expires_in: provider.expires,
          refresh_token: 'fixture-refresh', refresh_token_expires_in: 180 * 86400 } : {}) });
    }
    assert.ok(options.headers.Authorization?.startsWith('Bearer fixture-'));
    if (url === 'https://api.github.com/user') return Response.json({ id: provider.userId });
    assert.ok(url.startsWith('https://api.github.com/repos/3r0xy/my-vault'));
    if (provider.api401) return Response.json({ message: 'fixture-token' }, { status: 401 });
    return Response.json(url.endsWith('my-vault') ? { default_branch: 'main' } : { content: 'fixture-note', sha: 'a'.repeat(40) });
  };
  let handler;
  const server = createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.origin = `http://127.0.0.1:${server.address().port}`;
  handler = createApp(config, store, { fetchImpl, now: () => time });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const request = (path, options = {}) => fetch(config.origin + path, { redirect: 'manual', ...options,
    headers: { Origin: config.origin, ...options.headers } });
  async function start() {
    const res = await request('/auth/start', { method: 'POST' }); assert.equal(res.status, 200);
    const url = new URL((await res.json()).authorizeUrl);
    const cookie = res.headers.getSetCookie()[0];
    return { url, cookie: cookie.split(';')[0], fullCookie: cookie };
  }
  async function finish(flow) {
    return request('/auth/callback?code=fixture-code&state=' + flow.url.searchParams.get('state'), { headers: { Cookie: flow.cookie } });
  }
  async function login() {
    const response = await finish(await start()); assert.equal(response.headers.get('location'), '/');
    const cookie = response.headers.getSetCookie()[0].split(';')[0];
    const session = await (await request('/auth/session', { headers: { Cookie: cookie } })).json();
    return { cookie, session, response };
  }
  return { store, config, calls, provider, request, start, finish, login, advance: ms => { time += ms; } };
}

test('OAuth code + PKCE + bound state, session cookie and private proxy; no credentials returned', async t => {
  const f = await fixture(t), flow = await f.start();
  assert.equal(flow.url.searchParams.get('scope'), 'repo');
  assert.equal(flow.url.searchParams.get('redirect_uri'), f.config.origin + '/auth/callback');
  assert.equal(flow.url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(flow.fullCookie, /HttpOnly; SameSite=Lax; Max-Age=600; Secure/);
  const callback = await f.finish(flow);
  assert.equal(callback.status, 303); assert.equal(callback.headers.get('location'), '/');
  const exchange = f.calls.find(x => x.url.includes('access_token'));
  const verifier = new URLSearchParams(exchange.body).get('code_verifier');
  assert.equal(hash(verifier), flow.url.searchParams.get('code_challenge'));
  assert.equal(new URLSearchParams(exchange.body).get('code'), 'fixture-code');
  const cookie = callback.headers.getSetCookie()[0].split(';')[0];
  assert.match(callback.headers.getSetCookie()[0], /__Host-luna-session=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure/);
  const res = await f.request('/auth/session', { headers: { Cookie: cookie } });
  const text = await res.text(); assert.ok(!/fixture-(token|secret|refresh|code)/.test(text));
  const session = JSON.parse(text); assert.equal(session.authenticated, true); assert.equal(session.repo, 'my-vault');
  assert.equal(res.headers.get('cache-control'), 'no-store'); assert.equal(res.headers.get('access-control-allow-origin'), null);
  const file = await f.request('/api/github/repos/3r0xy/my-vault/contents/%D0%97.md?ref=main', { headers: { Cookie: cookie, Authorization: 'Bearer attacker' } });
  assert.equal(file.status, 200); assert.equal((await file.json()).content, 'fixture-note');
  const replay = await f.finish(flow); assert.equal(replay.headers.get('location'), '/?auth=failed');
  assert.equal(f.calls.filter(x => x.url.includes('access_token')).length, 1);
  const row = f.store.db.prepare('SELECT * FROM sessions').get();
  assert.ok(!JSON.stringify(row).includes('fixture-token')); assert.ok(!JSON.stringify(row).includes(cookie.split('=')[1]));
});

test('missing/wrong browser binding and expired state fail before exchange', async t => {
  const f = await fixture(t);
  for (const binding of ['', '__Host-luna-flow=attacker']) {
    const flow = await f.start();
    const response = await f.request('/auth/callback?code=fixture-code&state=' + flow.url.searchParams.get('state'), { headers: { Cookie: binding } });
    assert.equal(response.headers.get('location'), '/?auth=failed');
  }
  const flow = await f.start(); f.advance(600_001);
  assert.equal((await f.finish(flow)).headers.get('location'), '/?auth=failed');
  assert.equal(f.calls.length, 0);
});

test('state is single-use when callbacks race', async t => {
  const f = await fixture(t), flow = await f.start();
  const responses = await Promise.all([f.finish(flow), f.finish(flow)]);
  assert.deepEqual(responses.map(x => x.headers.get('location')).sort(), ['/', '/?auth=failed']);
  assert.equal(f.calls.filter(x => x.url.includes('access_token')).length, 1);
});

test('wrong GitHub identity, insufficient scope, denial and provider error never establish a session', async t => {
  for (const setting of [{ userId: 1 }, { scope: 'public_repo' }, { denied: true }]) {
    const f = await fixture(t); Object.assign(f.provider, setting);
    const res = await f.finish(await f.start());
    assert.equal(res.headers.get('location'), '/?auth=failed');
    assert.ok(!res.headers.getSetCookie().some(x => x.startsWith('__Host-luna-session=')));
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
  }
  const f = await fixture(t), flow = await f.start();
  const res = await f.request('/auth/callback?error=access_denied&state=' + flow.url.searchParams.get('state'), { headers: { Cookie: flow.cookie } });
  assert.equal(res.headers.get('location'), '/?auth=failed'); assert.equal(f.calls.length, 0);
});

test('fixed vault and API allowlist reject traversal, other repos, arbitrary hosts and non-Luna operations', () => {
  const c = { owner: '3r0xy', repo: 'my-vault', write: true };
  for (const target of ['/repos/3r0xy/other', '/repos/3r0xy/my-vault-other', '//evil.test',
    '/repos/3r0xy/my-vault/contents/%2e%2e/secrets', '/repos/3r0xy/my-vault/contents/%252e%252e/file',
    '/repos/3r0xy/my-vault/contents/a%3fb', '/repos/3r0xy/my-vault/actions/secrets',
    '/repos/3r0xy/my-vault/contents/a?access_token=bad', '/repos/3r0xy/my-vault/contents/a#bad']) {
    assert.equal(allowedTarget(target, 'GET', c), false, target);
  }
  for (const [method, path] of [['GET', ''], ['GET', '/branches/main'], ['GET', '/git/ref/heads/main'],
    ['GET', '/git/commits/' + 'a'.repeat(40)], ['GET', '/git/blobs/' + 'a'.repeat(40)],
    ['GET', '/git/trees/' + 'a'.repeat(40) + '?recursive=1'], ['PUT', '/contents/a.md'], ['DELETE', '/contents/a.md'],
    ['POST', '/git/blobs'], ['POST', '/git/trees'], ['POST', '/git/commits'], ['PATCH', '/git/refs/heads/main']]) {
    assert.equal(allowedTarget('/repos/3r0xy/my-vault' + path, method, c), true);
  }
  assert.equal(allowedTarget('/repos/3r0xy/my-vault/contents/a.md', 'PUT', { ...c, write: false }), false);
});

test('private download URLs and provider metadata never reach the browser', () => {
  assert.deepEqual(vaultData({ content: 'base64-note', sha: 'abc', download_url: 'https://raw.example/file?token=fixture-token',
    html_url: 'https://github.com/example', access_token: 'fixture-token', _links: { token: 'fixture-token' },
    tree: [{ path: 'note.md', type: 'blob', sha: 'abc', url: 'https://api.example' }] }),
  { content: 'base64-note', sha: 'abc', tree: [{ path: 'note.md', type: 'blob', sha: 'abc' }] });
});

test('CSRF, origin, unauthenticated requests, read-only mode and logout are enforced', async t => {
  const f = await fixture(t), api = '/api/github/repos/3r0xy/my-vault/contents/a.md';
  assert.equal((await f.request('/auth/start', { method: 'POST', headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await f.request(api)).status, 401);
  const { cookie, session } = await f.login();
  assert.equal((await f.request(api, { method: 'PUT', headers: { Cookie: cookie, 'X-Luna-CSRF': session.csrf } })).status, 403);
  for (const headers of [{}, { 'X-Luna-CSRF': session.csrf, Origin: 'https://evil.test' }]) {
    assert.equal((await f.request('/auth/logout', { method: 'POST', headers: { Cookie: cookie, ...headers } })).status, 403);
  }
  assert.equal((await f.request(api, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const res = await f.request('/auth/logout', { method: 'POST', headers: { Cookie: cookie, 'X-Luna-CSRF': session.csrf } });
  assert.equal(res.status, 200); assert.match(res.headers.getSetCookie()[0], /Max-Age=0/);
  assert.equal((await f.request(api, { headers: { Cookie: cookie } })).status, 401);
});

test('explicitly enabled writes require CSRF and use only server credentials', async t => {
  const f = await fixture(t, { write: true }), { cookie, session } = await f.login();
  const api = '/api/github/repos/3r0xy/my-vault/contents/a.md';
  assert.equal((await f.request(api, { method: 'PUT', headers: { Cookie: cookie } })).status, 403);
  const response = await f.request(api, { method: 'PUT', headers: { Cookie: cookie, 'X-Luna-CSRF': session.csrf }, body: JSON.stringify({ content: 'fixture-content' }) });
  assert.equal(response.status, 200); assert.equal(f.calls.at(-1).headers.Authorization, 'Bearer fixture-token');
  assert.equal(f.calls.at(-1).method, 'PUT');
});

test('session rotation, absolute expiry and upstream revocation', async t => {
  const f = await fixture(t), first = await f.login();
  const flow = await f.start();
  const res = await f.request('/auth/callback?code=fixture-code&state=' + flow.url.searchParams.get('state'), { headers: { Cookie: flow.cookie + '; ' + first.cookie } });
  assert.equal(res.headers.get('location'), '/');
  assert.equal((await (await f.request('/auth/session', { headers: { Cookie: first.cookie } })).json()).authenticated, false);
  const { cookie } = await f.login(); f.provider.api401 = true;
  const failure = await f.request('/api/github/repos/3r0xy/my-vault', { headers: { Cookie: cookie } });
  assert.equal(failure.status, 401); assert.ok(!(await failure.text()).includes('fixture-token'));
  f.provider.api401 = false;
  const last = await f.login(); f.advance(f.config.lifetime + 1);
  assert.equal((await (await f.request('/auth/session', { headers: { Cookie: last.cookie } })).json()).authenticated, false);
});

test('expiring token refresh is serialized, identity rechecked and refresh rejection invalidates the session', async t => {
  const f = await fixture(t); f.provider.expires = 120;
  const { cookie } = await f.login(); f.advance(70_000);
  const api = '/api/github/repos/3r0xy/my-vault';
  const responses = await Promise.all([1, 2, 3].map(() => f.request(api, { headers: { Cookie: cookie } })));
  assert.ok(responses.every(x => x.status === 200));
  assert.equal(f.calls.filter(x => x.url.includes('access_token')).length, 2);
  assert.ok(f.calls.some(x => x.url.endsWith('/user') && x.headers.Authorization === 'Bearer fixture-refreshed'));
  f.provider.refreshFail = true; f.advance(70_000);
  assert.equal((await f.request(api, { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await (await f.request('/auth/session', { headers: { Cookie: cookie } })).json()).authenticated, false);
});

test('only public assets are served, OAuth marker and security headers present; no source/data/config exposure', async t => {
  const f = await fixture(t), res = await f.request('/');
  assert.match(await res.text(), /name="luna-auth" content="oauth"/);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self';/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  for (const path of ['/.env', '/.git/config', '/server/store.mjs', '/data/luna.sqlite', '/package.json', '/auth/not-real', '/%2e%2e/server/start.mjs']) {
    assert.equal((await f.request(path)).status, 404, path);
  }
});

test('encrypted sessions survive restart; changed key fails closed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'luna-oauth-')), file = join(directory, 'sessions.sqlite');
  try {
    let store = new Store(file, key);
    const session = store.session({ token: 'fixture-private-value' }, Date.now(), 100000);
    store.close(); assert.ok(!readFileSync(file).includes(Buffer.from('fixture-private-value')));
    store = new Store(file, key); assert.equal(store.get(session.id, Date.now()).credentials.token, 'fixture-private-value'); store.close();
    store = new Store(file, 'cd'.repeat(32)); assert.throws(() => store.get(session.id, Date.now())); store.close();
  } finally { rmSync(directory, { recursive: true }); }
});

test('production configuration fails closed on missing secrets, unsafe origins or invalid settings', () => {
  assert.throws(() => readConfig({}));
  const env = { PUBLIC_ORIGIN: 'https://luna.example.com', GITHUB_CLIENT_ID: 'fixture-client',
    GITHUB_CLIENT_SECRET: 'fixture-secret', TOKEN_ENCRYPTION_KEY: key, ALLOWED_GITHUB_USER_ID: '60850311' };
  assert.equal(readConfig(env).write, false);
  for (const patch of [{ PUBLIC_ORIGIN: 'http://luna.example.com' }, { PUBLIC_ORIGIN: env.PUBLIC_ORIGIN + '/' },
    { ALLOWED_GITHUB_USER_ID: '3r0xy' }, { SESSION_DAYS: '1000' }, { VAULT_REPO: '..' }]) assert.throws(() => readConfig({ ...env, ...patch }));
});
