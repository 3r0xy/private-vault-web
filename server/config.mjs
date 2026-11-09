import { resolve } from 'node:path';

export function readConfig(env = process.env) {
  const origin = new URL(env.PUBLIC_ORIGIN || 'https://luna.example.com');
  const dev = env.ALLOW_HTTP_LOCALHOST === 'true';
  if (origin.origin !== (env.PUBLIC_ORIGIN || '') || origin.username || origin.password ||
      (origin.protocol !== 'https:' && !(dev && origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname)))) {
    throw new Error('PUBLIC_ORIGIN must be an HTTPS origin without a trailing slash (HTTP loopback only with ALLOW_HTTP_LOCALHOST=true)');
  }
  for (const name of ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY', 'ALLOWED_GITHUB_USER_ID']) {
    if (!env[name]) throw new Error(`${name} is required`);
  }
  if (!/^\d+$/.test(env.ALLOWED_GITHUB_USER_ID)) throw new Error('ALLOWED_GITHUB_USER_ID must be numeric');
  const owner = env.VAULT_OWNER || '3r0xy', repo = env.VAULT_REPO || 'my-private-vault';
  if (![owner, repo].every(x => /^[A-Za-z0-9_.-]+$/.test(x) && !['.', '..'].includes(x))) throw new Error('Invalid vault name');
  const days = Number(env.SESSION_DAYS || 30);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('SESSION_DAYS must be 1..90');
  return { origin: origin.origin, secure: origin.protocol === 'https:', clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET, encryptionKey: env.TOKEN_ENCRYPTION_KEY,
    userId: env.ALLOWED_GITHUB_USER_ID, owner, repo, write: env.VAULT_WRITE_ENABLED === 'true',
    lifetime: days * 86400_000, database: env.SESSION_DB || resolve('data/luna.sqlite'),
    host: env.HOST || '127.0.0.1', port: Number(env.PORT || 8787) };
}
