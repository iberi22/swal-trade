/**
 * Salto del tooltip a la pestaña Aprender. Un canal diminuto y sin framework:
 * el término pulsa, las demás piezas escuchan. Nadie necesita props cruzadas y
 * el tooltip puede vivir dentro de cualquier tarjeta.
 */
export type LearnRequest = { entryId: string; nonce: number };

type Listener = (request: LearnRequest) => void;

const listeners = new Set<Listener>();
let nonce = 0;

/** Abre el glosario centrado en la entrada dada. */
export function openInLearn(entryId: string): void {
  if (!entryId) return;
  nonce += 1;
  const request: LearnRequest = { entryId, nonce };
  for (const listener of listeners) {
    try {
      listener(request);
    } catch {
      // Un oyente roto no puede romper el tooltip de los demás.
    }
  }
}

/** Escucha las peticiones; devuelve la función para dejar de escuchar. */
export function onOpenInLearn(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
