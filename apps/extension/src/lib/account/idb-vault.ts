// Boveda en IndexedDB (origen de la extension). Delgada a proposito.
import type { Vault } from './vault';

const DB_NAME = 'swal-vault';
const STORE = 'kv';

export function createIdbVault(factory: IDBFactory = indexedDB): Vault {
  let opened: Promise<IDBDatabase> | null = null;

  function db(): Promise<IDBDatabase> {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        opened = null;
        reject(new Error('idb'));
      };
    });
    return opened;
  }

  async function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const database = await db();
    return new Promise<T>((resolve, reject) => {
      const tx = database.transaction(STORE, mode);
      const req = op(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(new Error('idb'));
      tx.onabort = () => reject(new Error('idb'));
    });
  }

  return {
    get: (key) => run<unknown>('readonly', (s) => s.get(key)),
    put: async (key, value) => {
      await run('readwrite', (s) => s.put(value, key));
    },
    delete: async (key) => {
      await run('readwrite', (s) => s.delete(key));
    },
    clear: async () => {
      await run('readwrite', (s) => s.clear());
    },
  };
}
