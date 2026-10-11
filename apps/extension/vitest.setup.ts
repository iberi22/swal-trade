import { vi } from 'vitest';
globalThis.defineContentScript = vi.fn((opts) => opts);
