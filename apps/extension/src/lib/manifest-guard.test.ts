import { describe, it, expect } from 'vitest';
import config from '../../wxt.config';

// The helper to check host_permissions
function checkHosts(hosts: string[]) {
  const allowedExact = [
    'https://www.binance.com/*/futures/*',
    'https://www.binance.com/static/chart/tradingview/*',
    'https://www.tradingview.com/chart/*',
    'https://fapi.binance.com/fapi/v1/klines*',
    'https://fapi.binance.com/fapi/v1/depth*',
    'https://api.alternative.me/fng/*',
    'wss://fstream.binance.com/*',
    'https://trade.swal.network/api/news*',
    'https://trade.swal.network/api/explain*',
    'ws://127.0.0.1/*',
    'http://127.0.0.1/*'
  ];

  const allowedPrefixes = [
    'https://www.binance.com/',
    'https://www.tradingview.com/',
    'https://fapi.binance.com/',
    'https://api.alternative.me/',
    'wss://fstream.binance.com/',
    'https://trade.swal.network/api/news',
    'https://trade.swal.network/api/explain',
    'ws://127.0.0.1/',
    'http://127.0.0.1/'
  ];

  for (const host of hosts) {
    if (host === '<all_urls>' || host.includes('://*/*') || host === 'https://*/*' || host === 'http://*/*') {
       throw new Error(`Broad host permission found: ${host}`);
    }

    if (host.includes('trade.swal.network') && !host.includes('/api/news') && !host.includes('/api/explain')) {
      throw new Error(`trade.swal.network host permission too broad: ${host}`);
    }

    if (host.startsWith('wss://') && !host.includes('fstream.binance.com')) {
       throw new Error(`wss:// only allowed for fstream.binance.com: ${host}`);
    }

    if (host.startsWith('ws://') && !host.includes('127.0.0.1')) {
       throw new Error(`ws:// only allowed for 127.0.0.1: ${host}`);
    }

    const isAllowedExact = allowedExact.includes(host);
    const isAllowedPrefix = allowedPrefixes.some(p => host.startsWith(p));

    if (!isAllowedExact && !isAllowedPrefix) {
      throw new Error(`Host permission not in allow-list: ${host}`);
    }
  }
}

describe('Manifest Guard', () => {
  const getManifest = async (browser: 'chrome' | 'firefox') => {
    // config.manifest is either an object or a function returning an object
    if (typeof config.manifest === 'function') {
      return await config.manifest({ browser } as any);
    }
    return config.manifest as any;
  };

  describe('Chrome Manifest', () => {
    it('should have minimal permissions for chrome', async () => {
      const manifest = await getManifest('chrome');
      const permissions = manifest.permissions || [];
      const allowed = ['storage', 'sidePanel'];
      permissions.forEach((p: string) => expect(allowed).toContain(p));
      expect(permissions.every((p: string) => allowed.includes(p))).toBe(true);
    });

    it('should not contain forbidden permissions for chrome', async () => {
      const manifest = await getManifest('chrome');
      const permissions = manifest.permissions || [];
      const forbidden = ['tabs', 'cookies', 'webRequest', 'webRequestBlocking', 'history', 'bookmarks', 'downloads', 'management', 'scripting', 'declarativeNetRequest', 'activeTab'];
      permissions.forEach((p: string) => expect(forbidden).not.toContain(p));
    });

    it('should lock content security policy', async () => {
      const manifest = await getManifest('chrome');
      const csp = manifest.content_security_policy?.extension_pages;
      expect(csp).toBe("script-src 'self'; object-src 'self'");
      expect(csp).not.toContain('unsafe-eval');
    });

    it('should check homepage url', async () => {
      const manifest = await getManifest('chrome');
      expect(manifest.homepage_url).toBe('https://trade.swal.network');
    });

    it('should not contain broad host permissions', async () => {
      const manifest = await getManifest('chrome');
      const hosts = manifest.host_permissions || [];
      expect(() => checkHosts(hosts)).not.toThrow();
    });

    it('should have exact set of host_permissions (snapshot-style)', async () => {
      const manifest = await getManifest('chrome');
      const hosts = manifest.host_permissions || [];

      const expectedHosts = [
        'https://www.binance.com/*/futures/*',
        'https://www.binance.com/static/chart/tradingview/*',
        'https://www.tradingview.com/chart/*',
        'https://fapi.binance.com/fapi/v1/klines*',
        'https://fapi.binance.com/fapi/v1/depth*',
        'https://api.alternative.me/fng/*',
        'wss://fstream.binance.com/*',
        'https://trade.swal.network/api/news*',
        'https://trade.swal.network/api/explain*',
        'ws://127.0.0.1/*',
        'http://127.0.0.1/*'
      ];

      expect(hosts).toEqual(expectedHosts);
    });
  });

  describe('Firefox Manifest', () => {
    it('should have minimal permissions for firefox', async () => {
      const manifest = await getManifest('firefox');
      const permissions = manifest.permissions || [];
      const allowed = ['storage'];
      permissions.forEach((p: string) => expect(allowed).toContain(p));
      expect(permissions.every((p: string) => allowed.includes(p))).toBe(true);
    });

    it('should not contain forbidden permissions for firefox', async () => {
      const manifest = await getManifest('firefox');
      const permissions = manifest.permissions || [];
      const forbidden = ['tabs', 'cookies', 'webRequest', 'webRequestBlocking', 'history', 'bookmarks', 'downloads', 'management', 'scripting', 'declarativeNetRequest', 'activeTab'];
      permissions.forEach((p: string) => expect(forbidden).not.toContain(p));
    });

    it('should lock content security policy', async () => {
      const manifest = await getManifest('firefox');
      const csp = manifest.content_security_policy?.extension_pages;
      expect(csp).toBe("script-src 'self'; object-src 'self'");
      expect(csp).not.toContain('unsafe-eval');
    });

    it('should check homepage url', async () => {
      const manifest = await getManifest('firefox');
      expect(manifest.homepage_url).toBe('https://trade.swal.network');
    });

    it('should not contain broad host permissions', async () => {
      const manifest = await getManifest('firefox');
      const hosts = manifest.host_permissions || [];
      expect(() => checkHosts(hosts)).not.toThrow();
    });

    it('should have exact set of host_permissions (snapshot-style)', async () => {
      const manifest = await getManifest('firefox');
      const hosts = manifest.host_permissions || [];

      const expectedHosts = [
        'https://www.binance.com/*/futures/*',
        'https://www.binance.com/static/chart/tradingview/*',
        'https://www.tradingview.com/chart/*',
        'https://fapi.binance.com/fapi/v1/klines*',
        'https://fapi.binance.com/fapi/v1/depth*',
        'https://api.alternative.me/fng/*',
        'wss://fstream.binance.com/*',
        'https://trade.swal.network/api/news*',
        'https://trade.swal.network/api/explain*',
        'ws://127.0.0.1/*',
        'http://127.0.0.1/*'
      ];

      expect(hosts).toEqual(expectedHosts);
    });
  });

  describe('checkHosts helper (Negative testing)', () => {
    it('should throw on <all_urls>', () => {
      expect(() => checkHosts(['<all_urls>'])).toThrow('Broad host permission found: <all_urls>');
    });

    it('should throw on *://*/*', () => {
      expect(() => checkHosts(['*://*/*'])).toThrow('Broad host permission found: *://*/*');
    });

    it('should throw on https://*/*', () => {
      expect(() => checkHosts(['https://*/*'])).toThrow('Broad host permission found: https://*/*');
    });

    it('should throw on http://*/*', () => {
      expect(() => checkHosts(['http://*/*'])).toThrow('Broad host permission found: http://*/*');
    });

    it('should throw on unknown host', () => {
      expect(() => checkHosts(['https://evil.com/*'])).toThrow('Host permission not in allow-list: https://evil.com/*');
    });

    it('should throw on broad trade.swal.network', () => {
      expect(() => checkHosts(['https://trade.swal.network/*'])).toThrow('trade.swal.network host permission too broad: https://trade.swal.network/*');
    });

    it('should throw on broad trade.swal.network API', () => {
      expect(() => checkHosts(['https://trade.swal.network/api/*'])).toThrow('trade.swal.network host permission too broad: https://trade.swal.network/api/*');
    });

    it('should throw on unallowed wss://', () => {
      expect(() => checkHosts(['wss://evil.com/*'])).toThrow('wss:// only allowed for fstream.binance.com: wss://evil.com/*');
    });

    it('should throw on unallowed ws://', () => {
      expect(() => checkHosts(['ws://evil.com/*'])).toThrow('ws:// only allowed for 127.0.0.1: ws://evil.com/*');
    });
  });
});
