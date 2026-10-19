/** Código de error del background => una frase corta en español. Nunca incluye secretos. */
const TEXTS: Record<string, string> = {
  ip_or_perm: 'Binance rechazó la clave: revisa que esté activa, con lectura, y la restricción de IP.',
  clock: 'El reloj de tu equipo difiere del de Binance. Sincronízalo e inténtalo de nuevo.',
  net: 'No hay conexión con el servicio. Revisa tu red e inténtalo otra vez.',
  no_key: 'Aún no hay clave guardada.',
  bad_response: 'Respuesta inesperada de Binance. Inténtalo más tarde.',
  key_has_trading_or_withdraw: 'Esta clave puede retirar fondos. Créala sin permiso de retiros.',
  unsupported: 'Este navegador no admite claves Ed25519. Usa la opción HMAC.',
  no_private_key: 'Primero genera la clave (paso 1).',
  vault: 'No se pudo guardar en el almacén de la extensión.',
  bad_request: 'Dato no válido.',
  forbidden: 'Acción no permitida desde aquí.',
  internal: 'Error interno de la extensión.',
  no_models_url: 'Este proveedor no ofrece lista de modelos: escribe el modelo a mano.',
};

export function errorText(code: unknown): string {
  if (typeof code !== 'string' || code === '') return 'Error desconocido.';
  const known = TEXTS[code];
  if (known) return known;
  const http = /^http_(\d{3})$/.exec(code);
  if (http) {
    const status = Number(http[1]);
    if (status === 401 || status === 403) return `El servicio rechazó la clave (HTTP ${status}).`;
    if (status === 429) return 'Demasiadas peticiones (HTTP 429). Espera un momento.';
    if (status >= 500) return `El servicio falló (HTTP ${status}). Inténtalo más tarde.`;
    return `El servicio respondió con error (HTTP ${status}).`;
  }
  return 'Error desconocido.';
}
