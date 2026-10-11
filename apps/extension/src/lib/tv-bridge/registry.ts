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
 * haya resuelto: al resolver se comprueba la pertenencia y se borra al momento.
 */

/** Lo mínimo del gráfico que hace falta para borrar. */
export interface EntitySink {
  removeEntity(id: string): void;
}

/** Id de entidad: la API lo da como Promesa, pero acaba en texto. */
export type EntityId = string | Promise<unknown> | unknown;

function asId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export class ShapeRegistry {
  /** id estable de la forma → id de entidad del gráfico. */
  private owned = new Map<string, string>();
  /** id estable → promesa de creación sin resolver. */
  private pending = new Map<string, Promise<void>>();
  /** Ids ya borrados, para no borrarlos dos veces. */
  private retired = new Set<string>();
  private sink: EntitySink | null = null;

  /** El gráfico del que se borra. Se fija al arrancar la sesión. */
  bind(sink: EntitySink): void {
    this.sink = sink;
  }

  /** Cuántas entidades nuestras hay en el gráfico ahora mismo. */
  get size(): number {
    return this.owned.size;
  }

  /** Promesas de creación sin resolver. */
  get pendingCount(): number {
    return this.pending.size;
  }

  keys(): string[] {
    return [...this.owned.keys()];
  }

  has(shapeId: string): boolean {
    return this.owned.has(shapeId);
  }

  /** Espera a que todas las creaciones en vuelo hayan resuelto. */
  async settled(): Promise<void> {
    for (let turn = 0; turn < 20 && this.pending.size > 0; turn++) {
      await Promise.allSettled([...this.pending.values()]);
    }
  }

  /**
   * Anota una forma nuestra. El id puede llegar envuelto en una Promesa; cuando
   * resuelva se guarda, o se borra si la forma ya no interesa.
   */
  track(shapeId: string, entityId: EntityId): void {
    const direct = asId(entityId);
    if (direct !== null) {
      this.owned.set(shapeId, direct);
      this.retired.delete(direct);
      return;
    }
    if (!entityId || typeof (entityId as Promise<unknown>).then !== 'function') {
      // Ni texto ni promesa: no se puede borrar después. Se ignora.
      return;
    }
    const promise = Promise.resolve(entityId as Promise<unknown>)
      .then((value) => {
        const id = asId(value);
        if (id === null) return;
        if (!this.pending.has(shapeId)) {
          // La forma cayó del mensaje mientras se creaba: se borra al nacer.
          this.remove(id);
          return;
        }
        this.owned.set(shapeId, id);
        this.retired.delete(id);
      })
      .catch(() => {
        // Crear puede fallar (el gráfico se recarga). No queda nada que borrar.
      })
      .finally(() => {
        this.pending.delete(shapeId);
      });
    this.pending.set(shapeId, promise);
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
