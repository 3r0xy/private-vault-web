// The server injects this marker. Never silently downgrade a failed OAuth backend to PAT.
export const oauthMode = document.querySelector('meta[name="luna-auth"]')?.content === 'oauth';
export let session = null;
export async function authRequest(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin',
    signal: AbortSignal.timeout(15000), ...options,
    headers: { ...(session?.csrf ? { 'X-Luna-CSRF': session.csrf } : {}), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.message || 'Не удалось связаться с сервером Luna.'), { status: response.status });
  return data;
}
export async function loadSession() {
  session = await authRequest('/auth/session');
  return session;
}
export async function startLogin() {
  const data = await authRequest('/auth/start', { method: 'POST' });
  const target = new URL(data.authorizeUrl);
  if (target.origin !== 'https://github.com' || target.pathname !== '/login/oauth/authorize') throw new Error('Неверный адрес входа GitHub.');
  location.assign(target.href); // Top-level navigation, no popups or third-party cookies.
}
export async function endSession() {
  await authRequest('/auth/logout', { method: 'POST' });
  session = null;
  location.replace('/');
}
