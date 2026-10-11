/**
 * Libro de cuentas de las entidades que crea el puente.
 *
 * La API de TradingView devuelve los ids en una Promesa y `removeEntity` es
 * sincrónico. Este registro cierra ese hueco: guarda qué id estable le
 * corresponde a qué entidad del gráfico y solo borra lo suyo. Si el usuario ha
 * dibujado algo, se queda.
 *
 * Si una forma deja de estar en el mensaje nuevo (porque cambió el símbolo o
 * porque el panel la retiró), su entidad se borra aunque la Promesa todavía no
 * haya resuelto: al resolver se comprueba que sigue siendo la ruta vigente y se
 * borra al momento.
 *
 * Cada `track` lleva un token. Cuando la Promesa de crear resuelve, solo manda
 * la ruta cuyo token siga siendo el actual de esa forma: si entretanto se volvió
 * a pedir la misma forma (una Promesa más nueva) o se retiró, la resolución
 * vieja es obsoleta y borra su propia entidad en vez de pisar la nueva. Esto
 * arregla la carrera de dos Promisas sobre la misma forma.
 */

/** Lo mínimo del gráfico que hace falta para borrar. */
export interface EntitySink {
  removeEntity(id: string): void;
}

/** Id de entidad: la API lo da como Promesa, pero acaba en texto. */
export type EntityId = string | Promise<unknown> | unknown;

/** Una ruta de creación sin resolver, con su token para detectar obsolescencia. */
interface Pending {
  token: number;
  id: EntityId;
}

function asId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export class ShapeRegistry {
  /** id estable de la forma → id de entidad del gráfico. */
  private owned = new Map<string, string>();
  /** id estable → ruta de creación sin resolver. */
  private pending = new Map<string, Pending>();
  /** Ids ya borrados, para no borrarlos dos veces. */
  private retired = new Set<string>();
  private sink: EntitySink | null = null;
  /** Contador de rutas: la huella que compara cada resolución. */
  private token = 0;

  /** El gráfico del que se borra. Se fija al arrancar la sesión. */
  bind(sink: EntitySink): void {
    this.sink = sink;
  }

  /** ¿Está esta forma pintada en el gráfico ahora mismo? */
  has(shapeId: string): boolean {
    return this.owned.has(shapeId);
  }

  /**
   * Anota una forma nuestra. El id puede llegar envuelto en una Promesa; cuando
   * resuelva se guarda, o se borra si la forma ya no interesa o si una ruta
   * más nueva la ha sustituido.
   */
  track(shapeId: string, entityId: EntityId): void {
    const direct = asId(entityId);
    if (direct !== null) {
      this.replace(shapeId, direct);
      return;
    }
    if (!isThenable(entityId)) {
      // Ni texto ni promesa: no se puede borrar después. Se ignora.
      return;
    }
    const current = { token: ++this.token, id: entityId };
    this.pending.set(shapeId, current);
    void Promise.resolve(entityId)
      .then((value) => {
        const id = asId(value);
        if (id === null) return;
        if (this.pending.get(shapeId)?.token !== current.token) {
          // La forma cayó, o una ruta más nueva la reemplazó: se borra al nacer.
          this.remove(id);
          return;
        }
        this.pending.delete(shapeId);
        this.replace(shapeId, id);
      })
      .catch(() => {
        // Crear puede fallar (el gráfico se recarga). No queda nada que borrar.
      })
      .finally(() => {
        // Solo limpia la ruta si sigue siendo esta (si no, ya pone otra).
        if (this.pending.get(shapeId)?.token === current.token) {
          this.pending.delete(shapeId);
        }
      });
  }

  /** Deja `shapeId` apuntando a `id`: sustituye y borra la entidad anterior. */
  private replace(shapeId: string, id: string): void {
    const previous = this.owned.get(shapeId);
    if (previous !== undefined) this.remove(previous);
    this.owned.set(shapeId, id);
    this.retired.delete(id);
  }

  private remove(id: string): void {
    if (this.retired.has(id)) return;
    this.retired.add(id);
    try {
      this.sink?.removeEntity(id);
    } catch {
      // El gráfico ya no existe: no hay nada que limpiar.
    }
  }

  /**
   * Deja en el registro solo las formas de `wanted`. Lo demás se borra del
   * gráfico. Las que están en vuelo se sueltan y se borran al resolver.
   */
  retain(wanted: ReadonlySet<string>): void {
    for (const shapeId of [...this.owned.keys()]) {
      if (wanted.has(shapeId)) continue;
      const id = this.owned.get(shapeId);
      this.owned.delete(shapeId);
      if (id !== undefined) this.remove(id);
    }
    for (const shapeId of [...this.pending.keys()]) {
      if (!wanted.has(shapeId)) this.pending.delete(shapeId);
    }
  }

  /** Borra todo lo nuestro. El resto del gráfico se queda como estaba. */
  clear(): void {
    for (const [shapeId, id] of this.owned) {
      this.owned.delete(shapeId);
      this.remove(id);
    }
    for (const shapeId of [...this.pending.keys()]) this.pending.delete(shapeId);
    this.retired.clear();
  }
}
