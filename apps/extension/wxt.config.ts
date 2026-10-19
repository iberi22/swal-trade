import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';
import { analysisCoreAlias } from './analysis-alias';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Rutas de fapi: velas y libro (pulso) más las de solo lectura de la cuenta.
// Chrome ignora las rutas en los permisos de host; lo que limita el alcance es
// `connect-src` de la CSP.
const FAPI_PATHS = [
  '/fapi/v1/klines*',
  '/fapi/v1/depth*',
  '/fapi/v1/time*',
  '/fapi/v2/positionRisk*',
  '/fapi/v3/account*',
  '/fapi/v1/openOrders*',
  '/fapi/v1/openAlgoOrders*',
  '/fapi/v1/userTrades*',
  '/fapi/v1/income*',
  '/fapi/v1/premiumIndex*',
  // Escaner: datos publicos de todo el mercado, sin clave.
  '/fapi/v1/ticker/24hr*',
  '/fapi/v1/exchangeInfo*',
];

// Se piden en tiempo de ejecucion: clave de lectura (sapi) y proveedores de IA.
const OPTIONAL_HOSTS = [
  'https://api.binance.com/sapi/v1/account/apiRestrictions*',
  'https://opencode.ai/inference/*',
  'https://openrouter.ai/api/*',
  'https://api.openai.com/v1/*',
  'https://api.anthropic.com/v1/*',
  'https://generativelanguage.googleapis.com/*',
];

// En la CSP el `*` final no es comodin: la ruta sin el va como prefijo.
const cspPath = (url: string) => url.replace(/\*$/, '');

const CONNECT_SRC = [
  ...FAPI_PATHS.map((path) => cspPath(`https://fapi.binance.com${path}`)),
  'wss://fstream.binance.com',
  'https://api.alternative.me/fng/',
  'https://trade.swal.network/api/',
  'http://127.0.0.1:*',
  'ws://127.0.0.1:*',
  ...OPTIONAL_HOSTS.map(cspPath),
];

const CSP = `script-src 'self'; object-src 'self'; connect-src ${CONNECT_SRC.join(' ')}`;

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
    // `alarms`: escaneo periodico solo si el usuario enciende la vigilancia.
    permissions: browser === 'firefox' ? ['storage', 'alarms'] : ['storage', 'sidePanel', 'alarms'],
    // Avisos del escaner: se piden al encender el interruptor.
    optional_permissions: ['notifications'],
    host_permissions: [
      'https://www.binance.com/*/futures/*',
      // El iframe de la pestaña Trading View. Es donde se pinta.
      'https://www.binance.com/static/chart/tradingview/*',
      'https://www.tradingview.com/chart/*',
      ...FAPI_PATHS.map((path) => `https://fapi.binance.com${path}`),
      // Pulso de mercado: muros del libro e índice de miedo/codicia.
      'https://api.alternative.me/fng/*',
      'wss://fstream.binance.com/*',
      'https://trade.swal.network/api/news*',
      // Explicador con IA. Solo se llama si el usuario enciende el interruptor;
      // el cuerpo lleva símbolo, temporalidad y patrones, nunca datos de cuenta.
      'https://trade.swal.network/api/explain*',
      // Escaner: estadisticas publicas de movimientos. Su CSP ya la cubre
      // el prefijo https://trade.swal.network/api/.
      'https://trade.swal.network/api/movers-stats*',
      // Puente local Claude: comunicación con el servidor MCP en localhost.
      'ws://127.0.0.1/*',
      // Radar local: lectura de alertas y estadísticas en localhost.
      'http://127.0.0.1/*',
    ],
    optional_host_permissions: OPTIONAL_HOSTS,
    action: {
      default_title: '__MSG_actionTitle__',
    },
    content_security_policy: {
      extension_pages: CSP,
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
