// Copia de workers/public-site/src/worker.js cspFor(). Si el worker cambia, este test debe cambiar con él.
const CSP_BASE =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** Directivas de una cabecera CSP, sin importar el orden. `_headers` y `cspFor` ponen connect-src en distinto sitio; la política es la misma. */
export function cspParts(header) {
  return String(header ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .sort();
}

export function expectedCsp(pathname = '/') {
  let connect = "'self'";
  if (pathname.startsWith('/checkout/')) {
    connect = "'self' https://pay.swal.network";
  } else if (pathname.startsWith('/guardian/')) {
    connect =
      "'self' https://fapi.binance.com https://api.binance.com https://api.telegram.org https://pay.swal.network";
  } else if (pathname.startsWith('/analisis/')) {
    connect = "'self' https://fapi.binance.com wss://fstream.binance.com https://api.alternative.me";
  }
  return `${CSP_BASE}; connect-src ${connect}`;
}

export const PAGES = [
  '/',
  '/pricing/',
  '/analisis/',
  '/guardian/',
  '/guardian/self-host/',
  '/checkout/',
  '/operativa/',
  '/terms/',
  '/privacy/',
  '/risk/',
  '/contact/',
  '/apoyar/',
  '/extension/',
];

// Misma regla que workers/public-site/test/site-pages.test.mjs.
export const FORBIDDEN = /ganancia[s]? garantizad|rentabilidad|win\s?rate|ingreso[s]? pasivo|retorno[s]? garantizad|\bROI\b|\+\d+(\.\d+)?\s?%/i;

/**
 * Texto visible que no debe prometer rentabilidad.
 * /risk/ puede decir "rentabilidad pasada" (advertencia).
 * /operativa/ muestra el KPI "Win Rate" del snapshot público; el propio test de
 * páginas lo deja fuera del escaneo de marketing. Aquí se quita solo esa etiqueta.
 */
export function textForClaimCheck(pathname, text) {
  let out = text;
  if (pathname === '/risk/' || pathname.startsWith('/risk')) out = out.replaceAll('rentabilidad pasada', '');
  if (pathname === '/operativa/' || pathname.startsWith('/operativa')) out = out.replaceAll(/win\s?rate/gi, '');
  return out;
}
