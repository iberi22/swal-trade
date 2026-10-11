import { describe, expect, it } from 'vitest';
import { ShapeRegistry } from './registry';

/** Gráfico de mentira: apunta los ids que se le pide borrar. */
function fakeSink() {
  const removed: string[] = [];
  return {
    removed,
    removeEntity(id: string) {
      removed.push(id);
    },
  };
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('ShapeRegistry', () => {
  it('guarda los ids que llegan en texto', () => {
    const registry = new ShapeRegistry();
    registry.track('a', 'ent-1');
    expect(registry.keys()).toEqual(['a']);
    expect(registry.size).toBe(1);
    expect(registry.has('a')).toBe(true);
  });

  it('guarda los ids que llegan en una promesa', async () => {
    const registry = new ShapeRegistry();
    registry.track('a', Promise.resolve('ent-1'));
    expect(registry.pendingCount).toBe(1);
    expect(registry.size).toBe(0);
    await registry.settled();
    expect(registry.keys()).toEqual(['a']);
    expect(registry.pendingCount).toBe(0);
  });

  it('borra solo lo suyo', () => {
    const sink = fakeSink();
    const registry = new ShapeRegistry();
    registry.bind(sink);
    registry.track('a', 'ent-a');
    registry.track('b', 'ent-b');
    registry.clear();
    expect(sink.removed).toEqual(['ent-a', 'ent-b']);
    expect(registry.size).toBe(0);
  });

  it('retain deja lo que sigue y borra el resto', () => {
    const sink = fakeSink();
    const registry = new ShapeRegistry();
    registry.bind(sink);
    registry.track('a', 'ent-a');
    registry.track('b', 'ent-b');
    registry.track('c', 'ent-c');
    registry.retain(new Set(['b', 'x']));
    expect(registry.keys()).toEqual(['b']);
    expect(sink.removed).toEqual(['ent-a', 'ent-c']);
  });

  it('una forma que cae del mensaje se borra al nacer', async () => {
    const sink = fakeSink();
    const registry = new ShapeRegistry();
    registry.bind(sink);
    const gate = deferred<string>();
    registry.track('a', gate.promise);
    registry.retain(new Set(['b'])); // 'a' ya no interesa
    gate.resolve('ent-a');
    await registry.settled();
    expect(registry.keys()).toEqual([]);
    expect(sink.removed).toEqual(['ent-a']);
  });

  it('no borra dos veces la misma entidad', async () => {
    const sink = fakeSink();
    const registry = new ShapeRegistry();
    registry.bind(sink);
    registry.track('a', Promise.resolve('ent-a'));
    await registry.settled();
    registry.clear();
    registry.clear();
    expect(sink.removed).toEqual(['ent-a']);
  });

  it('un id que no es texto ni promesa se ignora', () => {
    const registry = new ShapeRegistry();
    registry.track('a', undefined);
    registry.track('b', 42);
    registry.track('c', null);
    expect(registry.size).toBe(0);
    expect(registry.pendingCount).toBe(0);
  });

  it('una creación que falla no rompe el registro', async () => {
    const registry = new ShapeRegistry();
    registry.track('a', Promise.reject(new Error('Cannot create shape')));
    await registry.settled();
    expect(registry.size).toBe(0);
    expect(registry.pendingCount).toBe(0);
  });

  it('reapuntar la misma forma sustituye la entidad anterior', async () => {
    const sink = fakeSink();
    const registry = new ShapeRegistry();
    registry.bind(sink);
    registry.track('a', 'ent-1');
    registry.track('a', 'ent-2');
    registry.retain(new Set(['a']));
    registry.clear();
    expect(sink.removed).toEqual(['ent-2']);
  });
});
