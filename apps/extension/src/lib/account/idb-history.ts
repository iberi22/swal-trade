// Punto de control del historial en IndexedDB ('swal-history', origen de la extension). Delgado a proposito.
import type { HistoryStorage, StoredHistory } from './history-runner';

const DB_NAME = 'swal-history';
const STORE = 'kv';
const KEY = 'history';

export function createIdbHistoryStorage(factory: IDBFactory = indexedDB): HistoryStorage {
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
    load: async () => ((await run<unknown>('readonly', (s) => s.get(KEY))) as StoredHistory | undefined) ?? null,
    save: async (state) => {
      await run('readwrite', (s) => s.put(state, KEY));
    },
    clear: async () => {
      await run('readwrite', (s) => s.delete(KEY));
    },
  };
}
