// Alertas por Telegram con el bot del propio usuario, texto plano. Solo Pro.
export async function sendTelegram({ token, chatId, text, fetchFn = fetch.bind(globalThis) }) {
  try {
    const r = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!r.ok) return { ok: false, error: `Telegram respondio HTTP ${r.status}` };
    return { ok: true };
  } catch {
    // Sin detalles: el mensaje de error de fetch puede incluir la URL con el token.
    return { ok: false, error: 'No se pudo contactar con Telegram (red o bloqueo CORS/CSP del navegador).' };
  }
}
