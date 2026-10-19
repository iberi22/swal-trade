// Almacén del historial leído de la página, en IndexedDB del origen de la
// extensión (mismo patrón que `account/idb-history.ts`, con prefijo de clave
// 'pagehist:'). Una fila por posición cerrada: deduplicar y recortar es barato
// y no hay que reescribir 2000 filas cada vez.
//
// Nada sale del navegador y `clear()` lo borra todo.

import type { ClosedPosition } from './parse-history';
import { PAGE_HISTORY_KEEP, parseClosedPosition } from './messages';
import { droppedHistoryKeys, mergePageHistory } from './page-history';

const DB_NAME = 'swal-page-account';
const DB_VERSION = 1;
const STORE = 'kv';
const KEY_PREFIX = 'pagehist:';

export interface PageHistoryStorage {
  /** Filas guardadas, de la más nueva a la más vieja. */
  load(): Promise<ClosedPosition[]>;
  /** Une `rows` con lo guardado y devuelve el resultado ya ordenado. */
  merge(rows: readonly ClosedPosition[]): Promise<ClosedPosition[]>;
  clear(): Promise<void>;
}

export function createIdbPageHistory(factory: IDBFactory = indexedDB): PageHistoryStorage {
  let opened: Promise<IDBDatabase> | null = null;

  function db(): Promise<IDBDatabase> {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        opened = null;
        reject(new Error('idb'));
      };
    });
    return opened;
  }

  function run<T>(
    mode: IDBTransactionMode,
    op: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    return db().then(
      (database) =>
        new Promise<T>((resolve, reject) => {
          const tx = database.transaction(STORE, mode);
          const req = op(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(req.result);
          tx.onerror = () => reject(new Error('idb'));
          tx.onabort = () => reject(new Error('idb'));
        }),
    );
  }

  async function keys(): Promise<string[]> {
    const all = await run<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
    return all.filter((key): key is string => typeof key === 'string' && key.startsWith(KEY_PREFIX));
  }

  async function readAll(): Promise<ClosedPosition[]> {
    const stored = await keys();
    if (stored.length === 0) return [];
    const values = await run<unknown[]>('readonly', (store) => store.getAll());
    const rows: ClosedPosition[] = [];
    for (const value of values) {
      const row = parseClosedPosition(value);
      if (row) rows.push(row);
    }
    return rows;
  }

  return {
    async load() {
      try {
        return mergePageHistory(await readAll(), [], PAGE_HISTORY_KEEP);
      } catch {
        return [];
      }
    },
    async merge(rows) {
      let before: ClosedPosition[] = [];
      try {
        before = await readAll();
      } catch {
        before = [];
      }
      const merged = mergePageHistory(before, rows, PAGE_HISTORY_KEEP);
      try {
        const dropped = droppedHistoryKeys(before, merged);
        const database = await db();
        await new Promise<void>((resolve, reject) => {
          const tx = database.transaction(STORE, 'readwrite');
          const store = tx.objectStore(STORE);
          for (const row of merged) store.put(row, `${KEY_PREFIX}${row.key}`);
          for (const key of dropped) store.delete(`${KEY_PREFIX}${key}`);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(new Error('idb'));
          tx.onabort = () => reject(new Error('idb'));
        });
      } catch {
        // Sin IndexedDB el historial no se guarda; el aviso ya se procesó.
      }
      return merged;
    },
    async clear() {
      try {
        const stored = await keys();
        const database = await db();
        await new Promise<void>((resolve, reject) => {
          const tx = database.transaction(STORE, 'readwrite');
          const store = tx.objectStore(STORE);
          for (const key of stored) store.delete(key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(new Error('idb'));
          tx.onabort = () => reject(new Error('idb'));
        });
      } catch {
        // Nada que borrar.
      }
    },
  };
}

/** Versión en memoria para pruebas y para entornos sin IndexedDB. */
export function createMemoryPageHistory(initial: readonly ClosedPosition[] = []): PageHistoryStorage {
  let rows = mergePageHistory(initial, [], PAGE_HISTORY_KEEP);
  return {
    async load() {
      return [...rows];
    },
    async merge(incoming) {
      rows = mergePageHistory(rows, incoming, PAGE_HISTORY_KEEP);
      return [...rows];
    },
    async clear() {
      rows = [];
    },
  };
}
