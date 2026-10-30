import { DatabaseSync } from 'node:sqlite';
import { StoreCore } from './store-core.mjs';
export { hash, random } from './store-core.mjs';
export class Store extends StoreCore {
  constructor(filename, key) {
    const database = new DatabaseSync(filename);
    database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    super(database, key);
  }
}
