import { dayStartMs, realizedUsd, positionsFrom, breaches, unprotected, stopAlertsDue, newBreaches, parseConfig, tierFor, monitoredPositions } from './guardian-core.js';
import { createClient, saveCredentials, loadCredentials, clearCredentials, importSecret } from './binance-ro.js';
import { checkLicense, loadPubkey, ed25519Supported, LICENSE_KEY } from './guardian-license.js';
import { sendTelegram } from './telegram.js';

const $ = (id) => document.getElementById(id);
const CFG_KEY = 'swal.guardian.cfg';
const TG_KEY = 'swal.guardian.tg';
const POLL_MS = 15000;
const STOP_EVERY_S = 900;

let client = null;
let timer = null;
let tier = tierFor(null);
let alerted = new Set();
let alertDay = null;
const stopLast = new Map();

const text = (el, t) => { el.textContent = t; };
const readJson = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };

async function initLicense() {
  const info = $('lic-info');
  if (!window.crypto?.subtle || !(await ed25519Supported(crypto.subtle))) {
    text(info, 'Navegador no compatible con Ed25519: se usa el plan gratuito.');
    return tierFor({ status: 'unsupported' });
  }
  const token = localStorage.getItem(LICENSE_KEY);
  if (!token) { text(info, 'Plan gratuito. La licencia Pro se obtiene en /checkout/.'); return tierFor(null); }
  const pubkeySpki = await loadPubkey({ fetchFn: fetch.bind(globalThis), storage: localStorage });
  if (!pubkeySpki) { text(info, 'No se pudo obtener la clave publica de licencias; plan gratuito.'); return tierFor(null); }
  const lic = await checkLicense({ token, pubkeySpki, subtle: crypto.subtle });
  const msg = { pro: 'Licencia Pro valida.', expired: 'Licencia caducada: plan gratuito.', invalid: 'Licencia invalida: plan gratuito.', unsupported: 'Navegador no compatible.', none: 'Plan gratuito.' };
  text(info, msg[lic.status] || 'Plan gratuito.');
  return tierFor(lic);
}

function applyTierUi() {
  $('tg-section').classList.toggle('hidden', !tier.telegram);
  $('tg-locked').classList.toggle('hidden', tier.telegram);
  $('selfhost-link').classList.toggle('hidden', !tier.selfHostLink);
  text($('tier-badge'), tier.tier === 'pro' ? 'Pro' : 'Gratis (1 posicion vigilada)');
}

function notify(msg) {
  if ('Notification' in window && Notification.permission === 'granted') new Notification('Guardian de riesgo', { body: msg });
}

async function tgSend(msg) {
  const tg = readJson(TG_KEY);
  if (!tier.telegram || !tg?.token || !tg?.chat) return;
  const r = await sendTelegram({ token: tg.token, chatId: tg.chat, text: msg });
  text($('tg-status'), r.ok ? 'Ultimo envio: correcto.' : r.error);
  $('tg-status').className = r.ok ? 'ok' : 'err';
}

function renderPositions(pos, lev, algo) {
  const body = $('pos-body');
  body.replaceChildren();
  const miss = new Set(unprotected(pos, algo).map((p) => p.symbol + p.positionSide));
  for (const p of pos) {
    const tr = document.createElement('tr');
    const stop = miss.has(p.symbol + p.positionSide) ? 'SIN STOP' : 'con stop';
    for (const v of [p.symbol, p.amt, `${lev[p.symbol] ?? '?'}x`, p.notional.toFixed(0), p.unrealized.toFixed(2), stop]) {
      const td = document.createElement('td');
      td.textContent = v;
      if (v === 'SIN STOP') td.className = 'err';
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  if (!pos.length) { const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 6; td.textContent = 'Sin posiciones abiertas.'; tr.appendChild(td); body.appendChild(tr); }
}

async function poll() {
  const cfg = readJson(CFG_KEY);
  if (!client || !cfg) return;
  try {
    const nowMs = Date.now();
    const start = dayStartMs(nowMs, cfg.tz);
    if (start !== alertDay) { alertDay = start; alerted = new Set(); }
    const [acct, risk, income] = await Promise.all([client.account(), client.positionRisk(), client.incomeSince(start)]);
    const all = positionsFrom(acct);
    const pos = monitoredPositions(all, tier);
    const lev = {};
    for (const r of risk) if (parseFloat(r.positionAmt) !== 0) lev[r.symbol] = parseFloat(r.leverage);
    const real = realizedUsd(income);
    const open = pos.reduce((a, p) => a + p.unrealized, 0);
    const pnl = real + open;
    const br = breaches(pnl, pos, lev, cfg);
    let algo = [];
    if (pos.length) { try { algo = await client.openAlgoOrders(); } catch { /* no fatal */ } }
    // Aviso de posiciones sin stop (rate limit 15 min por posicion).
    const stopMsgs = stopAlertsDue(unprotected(pos, algo), stopLast, nowMs / 1000, STOP_EVERY_S);
    const msgs = [...newBreaches(br, alerted).map((k) => br[k]), ...stopMsgs];
    for (const m of msgs) { notify(m); tgSend(m); }

    text($('pnl-text'), `PnL del dia: ${pnl.toFixed(2)} USD (realizado ${real.toFixed(2)}, abierto ${open.toFixed(2)}) / limite -${cfg.limit.toFixed(2)}`);
    const frac = Math.min(1, Math.max(0, -pnl / cfg.limit));
    const bar = $('pnl-bar');
    bar.firstElementChild.style.width = `${(frac * 100).toFixed(0)}%`;
    bar.className = 'bar' + (br.daily_hit ? ' hit' : br.daily_warn ? ' warn' : '');
    renderPositions(pos, lev, algo);
    if (all.length > pos.length) text($('free-note'), `Plan gratuito: se vigila solo la posicion de mayor nocional (${all.length - pos.length} sin vigilar). Pro: ilimitado.`);
    else text($('free-note'), '');
    const list = $('breach-list');
    list.replaceChildren();
    for (const m of [...Object.values(br), ...unprotected(pos, algo).map((p) => `SIN STOP: ${p.symbol}`)]) { const li = document.createElement('li'); li.textContent = m; list.appendChild(li); }
    text($('status'), `Actualizado ${new Date().toLocaleTimeString()}`);
    $('status').className = 'ok';
  } catch (e) {
    text($('status'), `Error: ${String(e.message || e).slice(0, 200)} (si dice "Failed to fetch": CORS/red/CSP)`);
    $('status').className = 'err';
  }
}

async function start() {
  const creds = await loadCredentials();
  const cfg = readJson(CFG_KEY);
  if (!creds || !cfg) return;
  client = createClient(creds);
  $('setup').classList.add('hidden');
  $('dash').classList.remove('hidden');
  try { await client.syncTime(); } catch { /* se reintenta implicitamente */ }
  await poll();
  clearInterval(timer);
  timer = setInterval(poll, POLL_MS);
}

async function probePerms() {
  try {
    const r = await client.apiRestrictions();
    const warn = [];
    if (r.enableWithdrawals) warn.push('RETIROS habilitados');
    if (r.enableFutures) warn.push('Futuros (trading) habilitado');
    if (r.enableSpotAndMarginTrading) warn.push('Spot/Margin habilitado');
    text($('perm-status'), warn.length ? `PELIGRO: tu clave tiene permisos de mas (${warn.join(', ')}). Crea otra con SOLO "Enable Reading".` : 'Permisos: solo lectura.');
    $('perm-status').className = warn.length ? 'err' : 'ok';
  } catch {
    text($('perm-status'), 'No se pudo verificar los permisos automaticamente. Revisa a mano que la clave tenga SOLO "Enable Reading".');
  }
}

$('setup-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const parsed = parseConfig({ limit: f.get('limit'), maxNotional: f.get('maxNotional'), maxLev: f.get('maxLev'), tz: f.get('tz') });
  if (parsed.error) { text($('setup-err'), parsed.error); return; }
  const apiKey = String(f.get('apiKey')).trim();
  const secret = String(f.get('secret')).trim();
  if (!apiKey || !secret) { text($('setup-err'), 'Falta la API key o el secreto.'); return; }
  text($('setup-err'), '');
  try {
    await importSecret(secret); // valida formato
    await saveCredentials(apiKey, secret);
  } catch { text($('setup-err'), 'No se pudo guardar la clave en este navegador.'); return; }
  ev.target.elements.secret.value = '';
  localStorage.setItem(CFG_KEY, JSON.stringify(parsed.cfg));
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  await start();
  if (client) probePerms();
});

$('reset').addEventListener('click', async () => {
  clearInterval(timer);
  client = null;
  await clearCredentials();
  localStorage.removeItem(CFG_KEY);
  $('dash').classList.add('hidden');
  $('setup').classList.remove('hidden');
});

$('tg-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  localStorage.setItem(TG_KEY, JSON.stringify({ token: String(f.get('token')).trim(), chat: String(f.get('chat')).trim() }));
  ev.target.elements.token.value = '';
  await tgSend('GUARDIAN: prueba de alerta por Telegram.');
});

(async () => {
  tier = await initLicense();
  applyTierUi();
  const cfg = readJson(CFG_KEY);
  if (cfg) for (const [k, v] of Object.entries({ limit: cfg.limit, maxNotional: cfg.maxNotional, maxLev: cfg.maxLev, tz: cfg.tz })) { const el = $('setup-form').elements[k]; if (el && v != null) el.value = v; }
  await start();
  if (client) probePerms();
})();
