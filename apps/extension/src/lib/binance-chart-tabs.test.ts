import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';
import {
  findChartTabElement,
  getActiveChartTab,
  isTabActive,
  switchChartTab,
} from './binance-chart-tabs';

function loadFixture(name: string): Document {
  const html = readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');
  return parseHTML(html).document as unknown as Document;
}

describe('binance-chart-tabs', () => {
  describe('findChartTabElement', () => {
    it('finds Trading View and Original tabs in en fixture', () => {
      const doc = loadFixture('binance-tabs-en-original.html');
      const orig = findChartTabElement(doc, 'original');
      const tv = findChartTabElement(doc, 'tradingView');
      const depth = findChartTabElement(doc, 'depth');

      expect(orig).not.toBeNull();
      expect(orig?.textContent?.trim()).toBe('Original');
      expect(tv).not.toBeNull();
      expect(tv?.textContent?.trim()).toBe('Trading View');
      expect(depth).not.toBeNull();
      expect(depth?.textContent?.trim()).toBe('Depth');
    });

    it('finds Trading View, Original, and Profundidad in es fixture', () => {
      const doc = loadFixture('binance-tabs-es-original.html');
      const orig = findChartTabElement(doc, 'original');
      const tv = findChartTabElement(doc, 'tradingView');
      const depth = findChartTabElement(doc, 'depth');

      expect(orig).not.toBeNull();
      expect(orig?.textContent?.trim()).toBe('Original');
      expect(tv).not.toBeNull();
      expect(tv?.textContent?.trim()).toBe('Trading View');
      expect(depth).not.toBeNull();
      expect(depth?.textContent?.trim()).toBe('Profundidad');
    });

    it('returns null when tab control is missing', () => {
      const doc = loadFixture('binance-tabs-missing.html');
      expect(findChartTabElement(doc, 'tradingView')).toBeNull();
      expect(findChartTabElement(doc, 'original')).not.toBeNull();
    });
  });

  describe('isTabActive and getActiveChartTab', () => {
    it('detects Original tab as active in en fixture', () => {
      const doc = loadFixture('binance-tabs-en-original.html');
      expect(getActiveChartTab(doc)).toBe('original');

      const orig = findChartTabElement(doc, 'original')!;
      const tv = findChartTabElement(doc, 'tradingView')!;
      expect(isTabActive(orig)).toBe(true);
      expect(isTabActive(tv)).toBe(false);
    });

    it('detects Trading View tab as active in en fixture', () => {
      const doc = loadFixture('binance-tabs-en-tv.html');
      expect(getActiveChartTab(doc)).toBe('tradingView');

      const orig = findChartTabElement(doc, 'original')!;
      const tv = findChartTabElement(doc, 'tradingView')!;
      expect(isTabActive(orig)).toBe(false);
      expect(isTabActive(tv)).toBe(true);
    });

    it('detects Original tab as active in es-LA fixture', () => {
      const doc = loadFixture('binance-tabs-es-original.html');
      expect(getActiveChartTab(doc)).toBe('original');

      const orig = findChartTabElement(doc, 'original')!;
      const tv = findChartTabElement(doc, 'tradingView')!;
      expect(isTabActive(orig)).toBe(true);
      expect(isTabActive(tv)).toBe(false);
    });

    it('detects Trading View tab as active in es-LA fixture', () => {
      const doc = loadFixture('binance-tabs-es-tv.html');
      expect(getActiveChartTab(doc)).toBe('tradingView');

      const orig = findChartTabElement(doc, 'original')!;
      const tv = findChartTabElement(doc, 'tradingView')!;
      expect(isTabActive(orig)).toBe(false);
      expect(isTabActive(tv)).toBe(true);
    });
  });

  describe('switchChartTab', () => {
    it('returns switched:false when tab is already active without clicking', () => {
      const doc = loadFixture('binance-tabs-en-tv.html');
      const tv = findChartTabElement(doc, 'tradingView')!;
      const clickSpy = vi.fn();
      tv.addEventListener('click', clickSpy);

      const result = switchChartTab(doc, 'tradingView');
      expect(result).toEqual({ ok: true, switched: false });
      expect(clickSpy).not.toHaveBeenCalled();
    });

    it('clicks element and returns switched:true when tab is inactive', () => {
      const doc = loadFixture('binance-tabs-en-original.html');
      const tv = findChartTabElement(doc, 'tradingView')!;
      const clickSpy = vi.fn();
      tv.addEventListener('click', clickSpy);

      const result = switchChartTab(doc, 'tradingView');
      expect(result).toEqual({ ok: true, switched: true });
      expect(clickSpy).toHaveBeenCalledTimes(1);
    });

    it('returns clean error when Trading View tab control is missing', () => {
      const doc = loadFixture('binance-tabs-missing.html');
      const result = switchChartTab(doc, 'tradingView');
      expect(result).toEqual({
        ok: false,
        switched: false,
        error: 'no se encontró la pestaña Trading View',
      });
    });

    it('switches back to Original tab when requested', () => {
      const doc = loadFixture('binance-tabs-en-tv.html');
      const orig = findChartTabElement(doc, 'original')!;
      const clickSpy = vi.fn();
      orig.addEventListener('click', clickSpy);

      const result = switchChartTab(doc, 'original');
      expect(result).toEqual({ ok: true, switched: true });
      expect(clickSpy).toHaveBeenCalledTimes(1);
    });
  });
});
