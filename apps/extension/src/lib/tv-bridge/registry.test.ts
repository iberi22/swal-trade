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

/** Pasa el turno de microtareas: deja que las rutas de creación resuelvan. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Promesa que el test resuelve cuando quiere. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

describe('ShapeRegistry', () => {
  it('guarda los ids que llegan en texto', () => {
    const registry = new ShapeRegistry();
    registry.track('a', 'ent-1');
    expect(registry.has('a')).toBe(true);
  });

  it('guarda los ids que llegan en una promesa', async () => {
    const sink = fakeSink();
    const registry = new ShapeRegistry();
    registry.bind(sink);
    const gate = deferred<string>();
    registry.track('a', gate.promise);
    expect(registry.has('a')).toBe(false);
    gate.resolve('ent-1');
    await flush();
    expect(registry.has('a')).toBe(true);
    // Al borrar, la entidad resuelta es la que se retira.
    registry.clear();
    expect(sink.removed).toEqual(['ent-1']);
  });

  it('borra solo lo suyo', () => {
    const sink = fakeSink();
    const registry = new ShapeRegistry();
    registry.bind(sink);
    registry.track('a', 'ent-a');
    registry.track('b', 'ent-b');
    registry.clear();
    expect(sink.removed).toEqual(['ent-a', 'ent-b']);
  });

  it('retain deja lo que sigue y borra el resto', () => {
    const sink = fakeSink();
    const registry = new ShapeRegistry();
    registry.bind(sink);
    registry.track('a', 'ent-a');
    registry.track('b', 'ent-b');
    registry.track('c', 'ent-c');
    registry.retain(new Set(['b', 'x']));
    expect(registry.has('a')).toBe(false);
    expect(registry.has('b')).toBe(true);
    expect(registry.has('c')).toBe(false);
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
    await flush();
    expect(registry.has('a')).toBe(false);
    expect(sink.removed).toEqual(['ent-a']);
  });

  it('no borra dos veces la misma entidad', async () => {
    const sink = fakeSink();
    const registry = new ShapeRegistry();
    registry.bind(sink);
    const gate = deferred<string>();
    registry.track('a', gate.promise);
    gate.resolve('ent-a');
    await flush();
    registry.clear();
    registry.clear();
    expect(sink.removed).toEqual(['ent-a']);
  });

  it('un id que no es texto ni promesa se ignora', () => {
    const sink = fakeSink();
    const registry = new ShapeRegistry();
    registry.bind(sink);
    registry.track('a', undefined);
    registry.track('b', 42);
    registry.track('c', null);
    expect(registry.has('a')).toBe(false);
    expect(registry.has('b')).toBe(false);
    expect(registry.has('c')).toBe(false);
  });

  it('una creación que falla no rompe el registro', async () => {
    const registry = new ShapeRegistry();
    registry.track('a', Promise.reject(new Error('Cannot create shape')));
    await flush();
    expect(registry.has('a')).toBe(false);
  });

  it('reapuntar la misma forma sustituye y borra la entidad anterior', () => {
    const sink = fakeSink();
    const registry = new ShapeRegistry();
    registry.bind(sink);
    registry.track('a', 'ent-1');
    registry.track('a', 'ent-2');
    registry.retain(new Set(['a']));
    registry.clear();
    // ent-1 quedó reemplazada (no se filtra); al limpiar se borra ent-2.
    expect(sink.removed).toEqual(['ent-1', 'ent-2']);
  });

  it('dos rutas sobre la misma forma: solo la última sobrevive (F11, token)', async () => {
    const sink = fakeSink();
    const registry = new ShapeRegistry();
    registry.bind(sink);
    const first = deferred<string>();
    const second = deferred<string>();
    registry.track('a', first.promise); // token viejo
    registry.track('a', second.promise); // token nuevo
    // Resuelve PRIMERO la ruta vieja: es obsoleta y debe borrarse al nacer.
    first.resolve('ent-old');
    await flush();
    expect(sink.removed).toEqual(['ent-old']);
    // La ruta nueva es la que manda.
    second.resolve('ent-new');
    await flush();
    expect(registry.has('a')).toBe(true);
    registry.clear();
    // ent-old ya se retiró; al limpiar solo queda ent-new.
    expect(sink.removed).toEqual(['ent-old', 'ent-new']);
  });

  it('una resolución obsoleta no pisa la entidad vigente (F11)', async () => {
    const sink = fakeSink();
    const registry = new ShapeRegistry();
    registry.bind(sink);
    const first = deferred<string>();
    const second = deferred<string>();
    registry.track('a', first.promise);
    registry.track('a', second.promise);
    second.resolve('ent-new');
    await flush();
    // Ahora resuelve la vieja: no debe tocar lo que apunta 'a' (ent-new) ni
    // provocar que al limpiar se borre ent-new dos veces.
    first.resolve('ent-old');
    await flush();
    registry.clear();
    expect(sink.removed).toEqual(['ent-old', 'ent-new']);
  });
});
