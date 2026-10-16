import { describe, expect, it } from 'vitest';
import { buildAnalysisUrl, buildFooterLinks, SITE_BASE } from './footer-links';

describe('footer-links', () => {
  describe('buildAnalysisUrl', () => {
    it('construye la URL de análisis con el símbolo estándar', () => {
      expect(buildAnalysisUrl('BTCUSDT')).toBe('https://trade.swal.network/analisis/?symbol=BTCUSDT');
      expect(buildAnalysisUrl('ETHUSDC')).toBe('https://trade.swal.network/analisis/?symbol=ETHUSDC');
    });

    it('codifica correctamente caracteres especiales en el símbolo', () => {
      expect(buildAnalysisUrl('1000PEPE/USDT')).toBe('https://trade.swal.network/analisis/?symbol=1000PEPE%2FUSDT');
      expect(buildAnalysisUrl('BTC USDC')).toBe('https://trade.swal.network/analisis/?symbol=BTC%20USDC');
      expect(buildAnalysisUrl('SOL&USDT')).toBe('https://trade.swal.network/analisis/?symbol=SOL%26USDT');
      expect(buildAnalysisUrl('TEST?123')).toBe('https://trade.swal.network/analisis/?symbol=TEST%3F123');
    });
  });

  describe('buildFooterLinks', () => {
    it('devuelve los 4 enlaces de navegación esperados', () => {
      const links = buildFooterLinks('BTCUSDT');
      expect(links).toHaveLength(4);

      expect(links[0]).toEqual({
        label: 'Análisis completo',
        href: 'https://trade.swal.network/analisis/?symbol=BTCUSDT',
      });
      expect(links[1]).toEqual({
        label: 'Guardián',
        href: 'https://trade.swal.network/guardian/',
      });
      expect(links[2]).toEqual({
        label: 'Apoya SWAL',
        href: 'https://trade.swal.network/apoyar/',
      });
      expect(links[3]).toEqual({
        label: 'Privacidad',
        href: 'https://trade.swal.network/extension-privacy/',
      });
    });

    it('todos los enlaces usan el host del sitio público', () => {
      const links = buildFooterLinks('ETHUSDT');
      for (const link of links) {
        expect(link.href.startsWith(SITE_BASE)).toBe(true);
      }
    });
  });
});
