import { describe, expect, it } from 'vitest';
import { FREE_MODEL_WARNING, PROVIDERS, getProvider, isFreeModel } from './providers';

describe('providers registry', () => {
  it('lists the six fixed providers with https hosts (local excepted)', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(['opencode', 'openrouter', 'openai', 'anthropic', 'gemini', 'local']);
    for (const p of PROVIDERS) {
      if (p.id !== 'local') expect(p.chatUrl.startsWith('https://')).toBe(true);
      expect(p.hostPermission.endsWith('/*')).toBe(true);
      expect(p.hostPermission).not.toContain('*://');
    }
  });

  it('local needs no key and points at Ollama', () => {
    const local = getProvider('local');
    expect(local?.needsKey).toBe(false);
    expect(local?.chatUrl).toBe('http://127.0.0.1:11434/v1/chat/completions');
  });

  it('opencode urls match the spec', () => {
    const p = getProvider('opencode');
    expect(p?.chatUrl).toBe('https://opencode.ai/inference/openai/v1/chat/completions');
    expect(p?.modelsUrl).toBe('https://opencode.ai/inference/v1/models');
    expect(p?.hostPermission).toBe('https://opencode.ai/inference/*');
  });

  it('flags free models per provider', () => {
    expect(isFreeModel('opencode', 'grok-code-free')).toBe(true);
    expect(isFreeModel('opencode', 'big-pickle')).toBe(true);
    expect(isFreeModel('opencode', 'big-pickle-2')).toBe(false);
    expect(isFreeModel('opencode', 'gpt-5')).toBe(false);
    expect(isFreeModel('openrouter', 'meta/llama:free')).toBe(true);
    expect(isFreeModel('openrouter', 'meta/llama')).toBe(false);
    expect(isFreeModel('openai', 'gpt-4o-free')).toBe(false);
    expect(isFreeModel('nope', 'x-free')).toBe(false);
  });

  it('getProvider rejects unknown ids', () => {
    expect(getProvider('evil')).toBeNull();
    expect(getProvider(42)).toBeNull();
  });

  it('warning is one Spanish line', () => {
    expect(FREE_MODEL_WARNING).not.toContain('\n');
    expect(FREE_MODEL_WARNING).toContain('entrenar');
  });
});
