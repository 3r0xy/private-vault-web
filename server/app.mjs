import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { random, hash } from './store-core.mjs';

let root;
try { root = fileURLToPath(new URL('../', import.meta.url)); }
catch { root = '/'; } // Workers inject readAsset instead of filesystem access.
const files = new Set(['index.html', 'app.js', 'domain.mjs', 'task-hub.mjs', 'auth.mjs', 'loader.js',
  'styles.css', 'manifest.webmanifest', 'favicon.ico', 'vendor/codemirror.js', 'vendor/d3.js',
  'icons/note-cat-192.png', 'icons/note-cat-512.png']);
const mime = { html: 'text/html; charset=utf-8', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css',
  webmanifest: 'application/manifest+json', png: 'image/png', ico: 'image/x-icon' };
const httpError = (status, message) => Object.assign(new Error(message), { status });
const publicFields = new Set(['default_branch', 'commit', 'tree', 'sha', 'object', 'content',
  'encoding', 'size', 'type', 'path', 'mode', 'truncated', 'parents', 'name']);
// Private Contents responses can include download_url with a temporary GitHub token.
// Luna reads inline base64 content, so return only the fields its API adapter needs.
export function vaultData(value) {
  if (Array.isArray(value)) return value.map(vaultData);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => publicFields.has(key)).map(([key, data]) => [key, vaultData(data)]));
  return value;
}

// This is an allowlist of Luna's existing API operations, not an arbitrary GitHub proxy.
export function allowedTarget(raw, method, config) {
  if (!raw.startsWith('/repos/') || /[\\\x00-\x20#]/.test(raw)) return false;
  let parsed, decoded;
  try { parsed = new URL(`https://api.github.com${raw}`); decoded = decodeURIComponent(parsed.pathname); }
  catch { return false; }
  if (decoded.split('/').some(x => ['.', '..'].includes(x)) || /[\\\x00-\x1f%?#]/.test(decoded)) return false;
  const base = `/repos/${config.owner}/${config.repo}`;
  if (decoded !== base && !decoded.startsWith(base + '/')) return false;
  const tail = decoded.slice(base.length);
  const params = [...parsed.searchParams];
  if (method === 'GET') {
    if (!params.every(([k, v]) => (k === 'ref' && v.length < 256) || (k === 'recursive' && v === '1'))) return false;
    return tail === '' || /^\/branches\/.+$/.test(tail) || /^\/contents\/.+$/.test(tail) ||
      /^\/git\/(trees|blobs|commits)\/[a-f0-9]{40,64}$/.test(tail) || /^\/git\/ref\/heads\/.+$/.test(tail);
  }
  if (!config.write || params.length) return false;
  return (['PUT', 'DELETE'].includes(method) && /^\/contents\/.+$/.test(tail)) ||
    (method === 'POST' && /^\/git\/(blobs|trees|commits)$/.test(tail)) ||
    (method === 'PATCH' && /^\/git\/refs\/heads\/.+$/.test(tail));
}

export function createApp(config, store, { fetchImpl = fetch, now = Date.now, readAsset = file => readFile(resolve(root, file)), checkLogin = () => true } = {}) {
  const sidName = config.secure ? '__Host-luna-session' : 'luna-session';
  const flowName = config.secure ? '__Host-luna-flow' : 'luna-flow';
  const refreshes = new Map();
  const callback = `${config.origin}/auth/callback`;
  function cookie(name, value, seconds) {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${config.secure ? '; Secure' : ''}`;
  }
  async function upstream(url, options) {
    // Never follow a redirect with credentials; never log request URLs, bodies or headers.
    const response = await fetchImpl(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(12000) });
    if (response.status >= 300 && response.status < 400) throw Object.assign(httpError(502, 'GitHub вернул неожиданный переход.'), { oauthFailure: 'redirect' });
    return response;
  }
  async function exchange(body) {
    const response = await upstream('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...body }).toString(),
    });
    if (!response.ok) throw Object.assign(httpError(502, 'GitHub временно недоступен.'), { oauthFailure: 'http_' + response.status });
    const result = await response.json();
    if (result.error) {
      const known = ['bad_verification_code', 'incorrect_client_credentials', 'redirect_uri_mismatch', 'unverified_user_email', 'application_suspended'];
      throw Object.assign(httpError(401, 'Повтори вход через GitHub.'), { oauthFailure: known.includes(result.error) ? result.error : 'provider_error' });
    }
    if (!result.access_token || result.token_type?.toLowerCase() !== 'bearer') throw Object.assign(httpError(401, 'Повтори вход через GitHub.'), { oauthFailure: 'malformed_response' });
    if (!String(result.scope || '').split(/[ ,]+/).includes('repo')) throw httpError(403, 'Для приватного vault нужен доступ repo.');
    // Expiring tokens are supported, including refresh-token rotation.
    return { token: result.access_token, refresh: result.refresh_token,
      tokenExpires: result.expires_in ? now() + Number(result.expires_in) * 1000 : null,
      refreshExpires: result.refresh_token_expires_in ? now() + Number(result.refresh_token_expires_in) * 1000 : null };
  }
  async function github(path, credentials, options = {}) {
    return upstream(`https://api.github.com${path}`, { ...options, headers: {
      Accept: 'application/vnd.github+json', Authorization: `Bearer ${credentials.token}`,
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Luna-vault',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    } });
  }
  async function fresh(id, session) {
    const old = session.credentials;
    if (!old.tokenExpires || old.tokenExpires > now() + 60_000) return old;
    if (!old.refresh || (old.refreshExpires && old.refreshExpires <= now())) {
      store.remove(id); throw httpError(401, 'Сессия истекла. Войди через GitHub снова.');
    }
    const key = hash(id);
    if (!refreshes.has(key)) refreshes.set(key, (async () => {
      try {
        const updated = await exchange({ grant_type: 'refresh_token', refresh_token: old.refresh });
        // Revalidate identity after every new token, as required by GitHub.
        const user = await github('/user', updated);
        if (!user.ok || String((await user.json()).id) !== config.userId) throw httpError(401, 'Повтори вход через GitHub.');
        store.update(id, updated); return updated;
      } catch (error) {
        if (error.status === 401 || error.status === 403) store.remove(id);
        throw error;
      } finally { refreshes.delete(key); }
    })());
    return refreshes.get(key);
  }
  async function body(req) {
    let bytes = 0, parts = [];
    for await (const part of req) {
      bytes += part.length;
      if (bytes > 10 * 1024 * 1024) throw httpError(413, 'Файл слишком большой (лимит 10 МБ).');
      parts.push(part);
    }
    const text = Buffer.concat(parts).toString('utf8');
    if (text) { try { JSON.parse(text); } catch { throw httpError(400, 'Неверный JSON.'); } }
    return text;
  }
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (config.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    const redirect = (target, cookies = []) => { res.writeHead(303, { Location: target, 'Set-Cookie': cookies }); res.end(); };
    let route = '', authStep = 'state';
    try {
      if (req.headers.host !== new URL(config.origin).host) throw httpError(400, 'Неверный адрес приложения.');
      const url = new URL(req.url, config.origin); route = url.pathname;
      const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=')));
      const id = cookies[sidName] || '';
      const session = () => { const value = store.get(id, now()); if (!value) throw httpError(401, 'Сессия истекла. Войди через GitHub снова.'); return value; };
      const origin = () => {
        if (req.headers.origin !== config.origin || req.headers['sec-fetch-site'] === 'cross-site') throw httpError(403, 'Запрос с другого сайта запрещён.');
      };
      const csrf = value => { origin(); if (!value || req.headers['x-luna-csrf'] !== value.csrf) throw httpError(403, 'Обнови страницу и повтори действие.'); };
      if (route === '/auth/start' && req.method === 'POST') {
        origin();
        if (!checkLogin(req)) throw httpError(429, 'Слишком много попыток входа. Подожди несколько минут.');
        const state = random(), binding = random(), verifier = random();
        store.flow(state, binding, verifier, now());
        const url = new URL('https://github.com/login/oauth/authorize');
        url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: callback, scope: 'repo', state,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', allow_signup: 'false' });
        res.setHeader('Set-Cookie', cookie(flowName, binding, 600));
        return json(200, { authorizeUrl: url.href });
      }
      if (route === '/auth/callback' && req.method === 'GET') {
        const state = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '';
        const verifier = store.consume(state, cookies[flowName] || '', now());
        if (!verifier || !code || code.length > 1024 || url.searchParams.has('error')) throw httpError(401, 'Повтори вход через GitHub.');
        authStep = 'exchange';
        const credentials = await exchange({ code, redirect_uri: callback, code_verifier: verifier });
        authStep = 'identity';
        const user = await github('/user', credentials);
        if (!user.ok || String((await user.json()).id) !== config.userId) throw httpError(403, 'Этот аккаунт не имеет доступа к Luna.');
        authStep = 'vault';
        const repo = await github(`/repos/${config.owner}/${config.repo}`, credentials);
        if (!repo.ok) throw httpError(403, 'GitHub не дал доступ к vault.');
        authStep = 'session';
        store.remove(id); // Rotate the session on every successful login.
        store.cleanup(now());
        const created = store.session(credentials, now(), config.lifetime);
        return redirect('/', [cookie(sidName, created.id, config.lifetime / 1000), cookie(flowName, '', 0)]);
      }
      if (route === '/auth/session' && req.method === 'GET') {
        const value = store.get(id, now());
        if (value) await fresh(id, value);
        return json(200, { authenticated: Boolean(value), owner: config.owner, repo: config.repo,
          writeEnabled: config.write, ...(value ? { csrf: value.csrf, expiresAt: value.expires } : {}) });
      }
      if (route === '/auth/logout' && req.method === 'POST') {
        // An expired session can still clear its cookie; Origin is always checked.
        origin(); const value = store.get(id, now()); if (value) csrf(value);
        store.remove(id); res.setHeader('Set-Cookie', cookie(sidName, '', 0)); return json(200, { ok: true });
      }
      if (route.startsWith('/api/github/')) {
        const value = session();
        const target = req.url.slice('/api/github'.length);
        if (!allowedTarget(target, req.method, config)) throw httpError(403, 'Операция запрещена настройками vault.');
        if (req.method !== 'GET') csrf(value);
        else if (req.headers['sec-fetch-site'] === 'cross-site') throw httpError(403, 'Запрос с другого сайта запрещён.');
        const payload = req.method === 'GET' ? undefined : await body(req);
        const response = await github(target, await fresh(id, value), { method: req.method, body: payload });
        if (response.status === 401) { store.remove(id); throw httpError(401, 'GitHub отозвал доступ. Войди снова.'); }
        if (!response.ok) return json(response.status, { message: ({ 403: 'GitHub запретил доступ или исчерпан лимит запросов.',
          404: 'Файл или ветка не найдены.', 409: 'Конфликт версий. Обнови файл перед сохранением.', 422: 'GitHub отклонил изменение.' })[response.status] || 'GitHub временно недоступен.' });
        if (response.status === 204) { res.writeHead(204); return res.end(); }
        // Forward JSON only; no upstream headers, cookies, redirects or errors reach the client.
        return json(response.status, vaultData(await response.json()));
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw httpError(405, 'Метод не поддерживается.');
      const file = route === '/' ? 'index.html' : route.slice(1);
      if (!files.has(file)) throw httpError(404, 'Не найдено.');
      let data = await readAsset(file);
      if (file === 'index.html') data = Buffer.from(data.toString().replace('<head>', '<head>\n  <meta name="luna-auth" content="oauth">'));
      res.writeHead(200, { 'Content-Type': mime[file.split('.').pop()] || 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      // Deliberately do not log error objects: provider errors may contain credentials.
      if (res.headersSent) return res.destroy();
      if (route === '/auth/callback') return redirect('/?auth=failed&reason=' + authStep + '_' + (error.oauthFailure || (error.name === 'TimeoutError' ? 'timeout' : error.status ? String(error.status) : 'transport')), [cookie(flowName, '', 0)]);
      const status = error.status || 502;
      return json(status, { message: error.status ? error.message : 'Сервис временно недоступен. Повтори позже.' });
    }
  };
}
