// Utilidades de URL compartidas por los adaptadores. Nada de DOM: `new URL`
// basta y se puede probar en Node.

/** Host en minusculas, o null si la URL no se puede leer. */
export function urlHost(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Path de la URL (sin query ni hash), o null. */
export function urlPath(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/** true si el host es el indicado o un subdominio suyo. */
export function hostMatches(hosts: readonly string[], host: string | null): boolean {
  if (!host) return false;
  return hosts.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/** Simbolo canonico: mayusculas y solo digitos/letras. Null si no vale. */
export function normalizeSymbolToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const token = raw.trim().toUpperCase();
  return /^[0-9A-Z]{3,20}$/.test(token) ? token : null;
}
