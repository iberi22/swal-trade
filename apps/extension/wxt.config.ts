import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';
import { analysisCoreAlias } from './analysis-alias';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Permisos mínimos. `sidePanel` solo existe en Chromium; Firefox usa
 * `sidebar_action`, que WXT añade al ver el entrypoint sidepanel.
 * Hosts: la página (content script), el REST público y el websocket público.
 */
export default defineConfig({
  srcDir: 'src',
  manifestVersion: 3,
  modules: ['@wxt-dev/module-svelte'],
  alias: {
    '@swal/analysis-core': analysisCoreAlias(),
  },
  vite: () => ({
    server: {
      fs: {
        allow: [repoRoot],
      },
    },
  }),
  manifest: ({ browser }) => ({
    name: 'SWAL Trade',
    description:
      'Gráfico del símbolo que miras en Binance o TradingView, con hallazgos. Sin claves.',
    permissions: browser === 'firefox' ? ['storage'] : ['storage', 'sidePanel'],
    host_permissions: [
      'https://www.binance.com/*',
      'https://www.tradingview.com/*',
      'https://fapi.binance.com/*',
      'https://fstream.binance.com/*',
      'wss://fstream.binance.com/*',
    ],
    action: {
      default_title: 'SWAL Trade',
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
