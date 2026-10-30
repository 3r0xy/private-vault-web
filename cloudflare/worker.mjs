import { DurableObject } from 'cloudflare:workers';
import { StoreCore, hash } from '../server/store-core.mjs';
import { createApp } from '../server/app.mjs';
import { readConfig } from '../server/config.mjs';

// One personal-vault coordinator serializes refreshes across all Worker instances.
export class LunaSessions extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    const sql = ctx.storage.sql;
    const database = {
      exec: query => sql.exec(query),
      prepare: query => ({
        run: (...args) => sql.exec(query, ...args).toArray(),
        get: (...args) => sql.exec(query, ...args).toArray()[0],
      }),
    };
    this.store = new StoreCore(database, env.TOKEN_ENCRYPTION_KEY);
    sql.exec('CREATE TABLE IF NOT EXISTS login_limits (id TEXT PRIMARY KEY, attempts INTEGER, expires INTEGER)');
    ctx.blockConcurrencyWhile(async () => {
      if (await ctx.storage.getAlarm() === null) await ctx.storage.setAlarm(Date.now() + 86400_000);
    });
    this.app = createApp(readConfig(env), this.store, { checkLogin: req => {
      const time = Date.now(), id = hash(req.headers['cf-connecting-ip'] || 'local');
      sql.exec('DELETE FROM login_limits WHERE expires <= ?', time);
      sql.exec('INSERT INTO login_limits VALUES (?, 1, ?) ON CONFLICT(id) DO UPDATE SET attempts = attempts + 1', id, time + 600_000);
      return sql.exec('SELECT attempts FROM login_limits WHERE id = ?', id).one().attempts <= 20;
    }, readAsset: async file => {
      const response = await env.ASSETS.fetch(new Request(env.PUBLIC_ORIGIN + '/' + file));
      if (!response.ok) throw new Error('Missing public asset');
      return Buffer.from(await response.arrayBuffer());
    } });
  }
  async alarm() {
    this.store.cleanup(Date.now());
    this.ctx.storage.sql.exec('DELETE FROM login_limits WHERE expires <= ?', Date.now());
    await this.ctx.storage.setAlarm(Date.now() + 86400_000);
  }
  async fetch(request) {
    const url = new URL(request.url);
    const headers = Object.fromEntries(request.headers);
    headers.host = url.host;
    const req = { method: request.method, url: url.pathname + url.search, headers,
      async *[Symbol.asyncIterator]() {
        if (!request.body) return;
        const reader = request.body.getReader();
        try { while (true) { const result = await reader.read(); if (result.done) break; yield Buffer.from(result.value); } }
        finally { reader.releaseLock(); }
      },
    };
    let status = 200, result;
    const output = new Headers();
    const set = (key, value) => {
      output.delete(key);
      for (const item of Array.isArray(value) ? value : [value]) output.append(key, String(item));
    };
    const res = { headersSent: false, setHeader: set,
      writeHead(code, values = {}) { status = code; for (const [key, value] of Object.entries(values)) set(key, value); this.headersSent = true; },
      end(data) { result = new Response(data ?? null, { status, headers: output }); },
      destroy() { result = new Response(null, { status: 502, headers: { 'Cache-Control': 'no-store' } }); },
    };
    await this.app(req, res);
    return result;
  }
}

export default {
  async fetch(request, env) {
    // Fail closed until all real credentials and the canonical address are configured.
    if (!env.PUBLIC_ORIGIN || !env.GITHUB_CLIENT_SECRET || !env.TOKEN_ENCRYPTION_KEY || !env.GITHUB_CLIENT_ID) {
      return new Response('Luna: настройка безопасного входа ещё не завершена.', { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    if (new URL(request.url).origin !== env.PUBLIC_ORIGIN) return new Response(null, { status: 404 });
    try { return await env.LUNA_SESSIONS.getByName('personal-vault').fetch(request); }
    catch { return new Response('Luna временно недоступна.', { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
  },
};
