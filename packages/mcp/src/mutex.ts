// In-process mutex for the write tools.
//
// Three tools can be called in the same process by the same client, and the
// guard is not atomic: two tools reading the account at the same time both see
// "no position" and both place. Every write tool runs inside this lock, so the
// reads, the guard decision, the entry and the stop of one tool finish before
// the next one starts.

export interface WriteMutex {
  /** Runs `fn` with the lock held. Calls queue in arrival order. */
  run: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Number of callers waiting (0 when the lock is free). */
  depth: () => number;
}

export function createWriteMutex(): WriteMutex {
  let tail: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      waiting += 1;
      const previous = tail;
      let release: () => void = () => undefined;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      waiting -= 1;
      try {
        return await fn();
      } finally {
        release();
      }
    },
    depth: () => waiting,
  };
}
