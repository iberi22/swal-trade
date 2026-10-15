import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';
import { analysisCoreAlias } from './analysis-alias';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Permisos mínimos. `sidePanel` solo existe en Chromium; Firefox usa
 * `sidebar_action`, que WXT añade al ver el entrypoint sidepanel.
 * Hosts: la página donde corre el content script, el REST público de velas,
 * el websocket público, los titulares y el explicador con IA (solo si el
 * usuario enciende «Explicaciones con IA»). La justificación para la tienda
 * está en docs/STORE_LISTING.md. El aviso es
 * https://trade.swal.network/extension-privacy/
 */
export default defineConfig({
  srcDir: 'src',
  manifestVersion: 3,
  modules: ['@wxt-dev/module-svelte'],
  alias: {
    '@swal/analysis-core': analysisCoreAlias(),
  },
  zip: {
    // Los sourcemaps de desarrollo no entran en el paquete de la tienda.
    exclude: ['**/*.map'],
    // Las capturas no hacen falta para reconstruir el paquete en AMO.
    excludeSources: ['store-assets/**'],
  },
  vite: () => ({
    server: {
      fs: {
        allow: [repoRoot],
      },
    },
  }),
  manifest: ({ browser }) => ({
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'es',
    short_name: 'SWAL Trade',
    version: '0.1.0',
    homepage_url: 'https://trade.swal.network',
    permissions: browser === 'firefox' ? ['storage'] : ['storage', 'sidePanel'],
    host_permissions: [
      'https://www.binance.com/*/futures/*',
      // El iframe de la pestaña Trading View. Es donde se pinta.
      'https://www.binance.com/static/chart/tradingview/*',
      'https://www.tradingview.com/chart/*',
      'https://fapi.binance.com/fapi/v1/klines*',
      'wss://fstream.binance.com/*',
      'https://trade.swal.network/api/news*',
      // Explicador con IA. Solo se llama si el usuario enciende el interruptor;
      // el cuerpo lleva símbolo, temporalidad y patrones, nunca datos de cuenta.
      'https://trade.swal.network/api/explain*',
    ],
    action: {
      default_title: '__MSG_actionTitle__',
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'extension@swal.network',
              strict_min_version: '128.0',
              // El símbolo sale del navegador hacia el mercado público de Binance.
              data_collection_permissions: {
                required: ['websiteContent'],
              },
            },
          },
        }
      : {}),
  }),
});
