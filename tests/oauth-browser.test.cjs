// Real local BFF + browser cookies. GitHub is entirely synthetic; no real notes are accessed.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');

async function main() {
  const { Store } = await import('../server/store.mjs');
  const { createApp } = await import('../server/app.mjs');
  const store = new Store(':memory:', 'ab'.repeat(32));
  const config = { origin: '', secure: false, clientId: 'fixture-client', clientSecret: 'fixture-secret',
    userId: '60850311', owner: '3r0xy', repo: 'my-vault', write: false, lifetime: 2592000000 };
  const sha = 'a'.repeat(40);
  let writes = 0, revoked = false, authenticated = 0, handler;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/login/oauth/access_token')) { authenticated++; return Response.json({ access_token: 'fixture-github-token', scope: 'repo', token_type: 'bearer' }); }
    assert.equal(options.headers.Authorization, 'Bearer fixture-github-token');
    if (options.method && options.method !== 'GET') writes++;
    if (url === 'https://api.github.com/user') return Response.json({ id: 60850311 });
    assert.ok(url.startsWith('https://api.github.com/repos/3r0xy/my-vault'));
    if (revoked) return Response.json({ message: 'fixture-github-token' }, { status: 401 });
    const path = new URL(url).pathname.replace('/repos/3r0xy/my-vault', '');
    return Response.json(path === '' ? { default_branch: 'main' }
      : path === '/branches/main' ? { commit: { commit: { tree: { sha } } } }
      : path === '/git/trees/' + sha ? { tree: [{ type: 'blob', path: 'Welcome.md', sha, size: 25 }] }
      : { sha, content: Buffer.from('# Welcome\nSynthetic note').toString('base64') });
  };
  const server = createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.origin = `http://127.0.0.1:${server.address().port}`;
  handler = createApp(config, store, { fetchImpl });
  const browser = await chromium.launch({ headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  try {
    const errors = [], external = [], requests = [];
    async function context(options = {}) {
      const ctx = await browser.newContext(options);
      await ctx.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === config.origin) {
          requests.push(route.request());
          return route.continue();
        }
        if (url.origin === 'https://github.com' && url.pathname === '/login/oauth/authorize') {
          return route.fulfill({ status: 302, headers: { Location: config.origin + '/auth/callback?code=fixture-code&state=' + url.searchParams.get('state') } });
        }
        external.push(url.href); return route.abort();
      });
      ctx.on('page', page => page.on('pageerror', error => errors.push(error.message)));
      return ctx;
    }
    let ctx = await context({ viewport: { width: 1024, height: 1366 }, isMobile: true, hasTouch: true });
    let page = await ctx.newPage(); await page.goto(config.origin);
    await page.locator('#githubLoginBtn:not([disabled])').waitFor();
    assert.equal(await page.locator('#tokenInput').isVisible(), false);
    await page.locator('#githubLoginBtn').click(); await page.locator('#appView').waitFor({ state: 'visible' });
    assert.equal(page.url(), config.origin + '/');
    await page.locator('.file-item').filter({ hasText: 'Welcome' }).click();
    await page.locator('.cm-editor').waitFor({ state: 'visible' });
    assert.match(await page.locator('.cm-content').innerText(), /Synthetic note/);
    assert.equal(await page.evaluate(() => document.cookie.includes('luna-session')), false);
    const snapshot = await ctx.storageState();
    assert.equal(snapshot.cookies.find(x => x.name === 'luna-session').httpOnly, true);
    assert.ok(snapshot.cookies.find(x => x.name === 'luna-session').expires > Date.now() / 1000);
    assert.ok(!JSON.stringify(snapshot).includes('fixture-github-token'));
    assert.ok(!JSON.stringify(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).includes('fixture-github-token'));
    await ctx.close();
    ctx = await context({ storageState: snapshot, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    page = await ctx.newPage(); await page.goto(config.origin);
    await page.locator('#appView').waitFor({ state: 'visible' });
    assert.equal(authenticated, 1, 'persistent cookie restores login after a browser-context restart');
    await page.locator('#logoutBtn').click(); await page.locator('#githubLoginBtn:not([disabled])').waitFor();
    assert.equal(await page.locator('#appView').isVisible(), false);
    assert.ok(!(await ctx.cookies()).some(x => x.name === 'luna-session'));
    await page.reload(); await page.locator('#githubLoginBtn:not([disabled])').waitFor();
    assert.equal(await page.locator('#appView').isVisible(), false);
    await ctx.close();
    console.log('PASS OAuth navigation, cookie persistence, tablet/phone layouts and logout');

    ctx = await context();
    await ctx.addInitScript(() => {
      for (const method of ['getItem', 'setItem', 'removeItem']) Storage.prototype[method] = () => { throw new DOMException('Denied', 'SecurityError'); };
    });
    page = await ctx.newPage(); await page.goto(config.origin);
    await page.locator('#githubLoginBtn:not([disabled])').waitFor(); await page.locator('#githubLoginBtn').click();
    await page.locator('#appView').waitFor({ state: 'visible' });
    await page.reload(); await page.locator('#appView').waitFor({ state: 'visible' });
    revoked = true;
    await page.locator('.file-item').filter({ hasText: 'Welcome' }).click();
    await page.locator('#loginView').waitFor({ state: 'visible' });
    assert.match(await page.locator('#loginError').innerText(), /Сессия истекла/);
    await ctx.close();
    console.log('PASS denied browser storage, cookie restore and revoked GitHub access');
    revoked = false;
    ctx = await context();
    await ctx.route('**/auth/session', route => route.fulfill({ status: 503, json: { message: 'Temporary failure' } }));
    page = await ctx.newPage(); await page.goto(config.origin);
    await page.locator('#githubLoginBtn:not([disabled])').waitFor();
    assert.equal(await page.locator('#legacyLogin').isVisible(), false, 'failed backend never downgrades to PAT');
    assert.match(await page.locator('#loginError').innerText(), /Не удалось проверить/);
    await ctx.unroute('**/auth/session');
    await page.locator('#githubLoginBtn').click(); await page.locator('#appView').waitFor({ state: 'visible' });
    await ctx.close();
    console.log('PASS backend outage stays in OAuth mode and retry recovers');
    assert.equal(writes, 0, 'login and reading never write notes');
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    for (const request of requests) {
      assert.ok(!request.headers().authorization, 'browser never gets a GitHub Authorization header');
      assert.ok(!request.url().includes('fixture-github-token'));
    }
    console.log('PASS same-origin requests, CSP, no GitHub token in browser, no note writes');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); store.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
