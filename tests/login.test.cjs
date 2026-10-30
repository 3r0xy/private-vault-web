/* Browser regression tests use only synthetic credentials and an intercepted,
   read-only GitHub API. No real vault is contacted. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const prefix = '/private-vault-web/';
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const target = path.resolve(root, pathname.slice(prefix.length) || 'index.html');
  if (!pathname.startsWith(prefix) || !target.startsWith(root + path.sep) || !fs.existsSync(target)) {
    res.writeHead(404); return res.end();
  }
  res.setHeader('Content-Type', target.endsWith('.html') ? 'text/html; charset=utf-8'
    : /\.(mjs|js)$/.test(target) ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : 'application/octet-stream');
  res.end(fs.readFileSync(target));
});
const requests = [];
async function mockApi(route) {
  const req = route.request();
  requests.push(req.method());
  assert.equal(req.method(), 'GET', 'login, editor and graph must not change notes');
  const endpoint = new URL(req.url()).pathname.replace('/repos/test/vault', '');
  const data = endpoint === '' ? { default_branch: 'main' }
    : endpoint === '/branches/main' ? { commit: { commit: { tree: { sha: 'test-tree' } } } }
    : endpoint === '/git/trees/test-tree' ? { tree: [{ type: 'blob', path: 'Welcome.md', sha: 'test-blob', size: 10 }] }
    : endpoint === '/contents/Welcome.md' ? { sha: 'test-blob', content: Buffer.from('# Welcome\nTest note').toString('base64') }
    : null;
  assert.ok(data, 'unexpected test API endpoint');
  await route.fulfill({ json: data });
}
async function fill(page) {
  await page.locator('#ownerInput').fill('test');
  await page.locator('#repoInput').fill('vault');
  await page.locator('#tokenInput').fill('synthetic-test-credential');
}
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = process.env.TEST_URL || `http://127.0.0.1:${server.address().port}${prefix}`;
  const browser = await chromium.launch({ headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  async function check(name, run, init) {
    const context = await browser.newContext();
    const errors = [], external = [];
    // Deny all non-local network except the mock API, including esm.sh/jsdelivr.
    await context.route('**/*', route => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.origin === new URL(url).origin) return route.continue();
      if (requestUrl.hostname === 'api.github.com') return mockApi(route);
      external.push(requestUrl.hostname); return route.abort();
    });
    if (init) await context.addInitScript(init);
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    try {
      await run(page, context);
      assert.deepEqual(errors, [], 'no unhandled application errors');
      assert.deepEqual(external, [], 'no CDN dependencies at runtime');
      console.log('PASS ' + name);
    } finally { await context.close(); }
  }
  try {
    await check('CDNs blocked: login, local CodeMirror, graph, restored session; GET only', async page => {
      await page.goto(url); await fill(page); await page.locator('#connectBtn').click();
      await page.locator('#appView').waitFor({ state: 'visible' });
      await page.locator('.file-item').filter({ hasText: 'Welcome' }).click();
      await page.locator('.cm-editor').waitFor({ state: 'visible' });
      assert.match(await page.locator('.cm-content').innerText(), /Test note/);
      await page.reload(); await page.locator('#appView').waitFor({ state: 'visible' });
      await page.locator('.cm-editor').waitFor({ state: 'visible' });
      await page.locator('#graphModeBtn').click();
      await page.locator('.graph-node').waitFor({ state: 'visible' });
    });
    await check('required fields show an error', async page => {
      await page.goto(url); await page.locator('#connectBtn').click();
      assert.match(await page.locator('#loginError').innerText(), /Заполни/);
    });
    for (const [status, message] of [[401, /действителен/], [403, /Contents: Read/], [404, /не найдены/], [409, /нет файлов/], [429, /Слишком много/], [500, /временно недоступен/]]) {
      await check('GitHub ' + status + ': clear error, enabled retry, no credential echo', async page => {
        await page.route('https://api.github.com/**', route => route.fulfill({ status,
          json: { message: 'synthetic-test-credential' } }));
        await page.goto(url); await fill(page); await page.locator('#connectBtn').click();
        await page.waitForFunction(() => document.querySelector('#loginError').textContent);
        const error = await page.locator('#loginError').innerText();
        assert.match(error, message); assert.ok(!error.includes('synthetic-test-credential'));
        assert.equal(await page.locator('#connectBtn').isEnabled(), true);
        assert.equal(await page.locator('#loginView').isVisible(), true);
        await page.unroute('https://api.github.com/**');
        await page.locator('#connectBtn').click(); await page.locator('#appView').waitFor({ state: 'visible' });
      });
    }
    await check('network failure shows a retryable error', async page => {
      await page.route('https://api.github.com/**', route => route.abort());
      await page.goto(url); await fill(page); await page.locator('#connectBtn').click();
      await page.waitForFunction(() => document.querySelector('#loginError').textContent);
      assert.match(await page.locator('#loginError').innerText(), /интернет-соединение/);
      assert.equal(await page.locator('#connectBtn').isEnabled(), true);
    });
    await check('slow API: visible progress, no duplicate login, 15-second timeout', async page => {
      let calls = 0;
      await page.route('https://api.github.com/**', () => { calls++; });
      await page.goto(url); await fill(page); await page.clock.install();
      await page.locator('#connectBtn').click();
      assert.equal(await page.locator('#connectBtn').isDisabled(), true);
      assert.match(await page.locator('#connectBtn').innerText(), /Подключение/);
      await page.locator('#connectBtn').evaluate(button => button.click());
      await page.clock.runFor(15001);
      await page.waitForFunction(() => document.querySelector('#loginError').textContent);
      assert.match(await page.locator('#loginError').innerText(), /15 секунд/);
      assert.equal(calls, 1);
      assert.equal(await page.locator('#connectBtn').isEnabled(), true);
    });
    await check('storage denied: application loads and login still works', async page => {
      await page.goto(url); await fill(page); await page.locator('#connectBtn').click();
      await page.locator('#appView').waitFor({ state: 'visible' });
      assert.match(await page.locator('#toast').innerText(), /не сохраняет сессию/);
      await page.reload(); await page.locator('#connectBtn').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#loginView').isVisible(), true);
    }, () => {
      for (const method of ['getItem', 'setItem', 'removeItem']) {
        Storage.prototype[method] = () => { throw new DOMException('Storage denied', 'SecurityError'); };
      }
    });
    await check('missing local module: visible startup error and reload recovery', async page => {
      await page.route('**/vendor/codemirror.js', route => route.abort());
      await page.goto(url); await page.locator('#reloadBtn').waitFor({ state: 'visible' });
      assert.match(await page.locator('#loginError').innerText(), /Не удалось загрузить приложение/);
      assert.equal(await page.locator('#connectBtn').isDisabled(), true);
      await page.unroute('**/vendor/codemirror.js');
      await page.locator('#reloadBtn').click();
      await page.waitForFunction(() => !document.querySelector('#connectBtn').disabled);
      assert.equal(await page.locator('#loginError').innerText(), '');
    });
    await check('module initialization error is reported by the independent loader', async page => {
      await page.route('**/app.js?*', route => route.fulfill({ contentType: 'text/javascript',
        body: 'throw new Error("Synthetic initialization failure");' }));
      await page.goto(url); await page.locator('#reloadBtn').waitFor({ state: 'visible' });
      assert.match(await page.locator('#loginError').innerText(), /Не удалось загрузить приложение/);
      assert.equal(await page.locator('#connectBtn').isDisabled(), true);
    });
    await check('slow module: startup timeout is visible and late success recovers', async page => {
      let release;
      await page.route('**/vendor/codemirror.js', route => { release = () => route.continue(); });
      await page.clock.install(); await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.clock.runFor(20001);
      await page.locator('#reloadBtn').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#connectBtn').isDisabled(), true);
      await release();
      await page.waitForFunction(() => !document.querySelector('#connectBtn').disabled);
      assert.equal(await page.locator('#reloadBtn').isVisible(), false);
      assert.equal(await page.locator('#loginError').innerText(), '');
    });
    assert.ok(requests.length > 0); assert.ok(requests.every(method => method === 'GET'));
  } finally { await browser.close(); }
}
main().then(() => server.close(), e => { console.error(e); server.close(); process.exitCode = 1; });
