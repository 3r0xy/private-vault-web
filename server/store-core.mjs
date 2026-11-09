import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const random = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('base64url');

// Only hashes of browser credentials and AES-GCM encrypted OAuth credentials go to disk.
export class StoreCore {
  constructor(database, key) {
    if (!/^[a-f0-9]{64}$/i.test(key || '')) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 random bytes in hex');
    this.key = Buffer.from(key, 'hex');
    this.db = database;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS flows (id TEXT PRIMARY KEY, binding TEXT, secret TEXT, expires INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, secret TEXT, csrf TEXT, expires INTEGER);`);
  }
  seal(value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value))), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  open(value) {
    const data = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]));
  }
  cleanup(now) {
    this.db.prepare('DELETE FROM flows WHERE expires <= ?').run(now);
    this.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(now);
  }
  flow(state, binding, verifier, now) {
    this.cleanup(now);
    this.db.prepare('INSERT INTO flows VALUES (?, ?, ?, ?)').run(hash(state), hash(binding), this.seal(verifier), now + 600_000);
  }
  consume(state, binding, now) {
    // DELETE RETURNING is atomic even when two callbacks race.
    const row = this.db.prepare('DELETE FROM flows WHERE id = ? RETURNING *').get(hash(state));
    if (!row || row.expires <= now || row.binding !== hash(binding)) return null;
    return this.open(row.secret);
  }
  session(credentials, now, lifetime) {
    const id = random(), csrf = random();
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(hash(id), this.seal(credentials), csrf, now + lifetime);
    return { id, csrf };
  }
  get(id, now) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(hash(id));
    if (!row || row.expires <= now) { this.remove(id); return null; }
    return { ...row, credentials: this.open(row.secret) };
  }
  update(id, credentials) {
    this.db.prepare('UPDATE sessions SET secret = ? WHERE id = ?').run(this.seal(credentials), hash(id));
  }
  remove(id) { this.db.prepare('DELETE FROM sessions WHERE id = ?').run(hash(id)); }
  close() { this.db.close(); }
}
