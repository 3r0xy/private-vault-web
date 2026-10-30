import { createServer } from 'node:http';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { readConfig } from './config.mjs';
import { Store } from './store.mjs';
import { createApp } from './app.mjs';

process.umask(0o077);
const config = readConfig();
mkdirSync(dirname(config.database), { recursive: true, mode: 0o700 });
const store = new Store(config.database, config.encryptionKey);
chmodSync(config.database, 0o600);
const server = createServer(createApp(config, store));
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(config.port, config.host, () => console.info('Luna backend ready'));
const cleanup = setInterval(() => store.cleanup(Date.now()), 3600_000).unref();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  clearInterval(cleanup); server.close(() => { store.close(); process.exit(0); });
});
