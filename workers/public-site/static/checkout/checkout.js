// SPDX-License-Identifier: AGPL-3.0-only
// Checkout de SWAL Trade: JS sin dependencias; la CSP solo permite scripts propios.
import {
  API_BASE, LS_ACCOUNT, LS_LICENSE, POLL_INTERVAL_MS,
  parsePlan, formatAmount, mapStatus, methodKey, methodLabel, formatPrice,
  apiErrorMessage, isPlausibleSecret, safeParse, formatDate, secretFileContents,
  PLAN_LABELS, NETWORK_LABELS, qrSvg,
} from './lib.js';

const LS_INVOICE = 'swal.invoice'; // factura en curso, para reanudar al recargar
const $ = (id) => document.getElementById(id);
const show = (id, on = true) => $(id).classList.toggle('hidden', !on);

const state = { plans: [], methods: [], freeUntil: null, plan: parsePlan(location.search), account: null, invoice: null, timer: null, pollDelay: POLL_INTERVAL_MS };

function showError(msg) { const e = $('error'); e.textContent = msg || ''; show('error', !!msg); }

async function api(path, { method = 'GET', body, secret } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (secret) headers.authorization = `Bearer ${secret}`;
  let res;
  try {
    res = await fetch(API_BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw Object.assign(new Error('No se pudo conectar con el servicio de pagos. Revisa tu conexión.'), { status: 0 });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(apiErrorMessage(res.status, data)), { status: res.status });
  return data;
}

async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); } catch {
    const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); } catch { /* sin portapapeles */ }
    t.remove();
  }
  const old = btn.textContent; btn.textContent = 'Copiado'; setTimeout(() => { btn.textContent = old; }, 1500);
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- plan -------------------------------------------------------------------
function renderPlans() {
  const box = $('plan-list'); box.replaceChildren();
  for (const p of state.plans) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn plan-opt'; b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(p.id === state.plan));
    b.textContent = `${PLAN_LABELS[p.id] || p.id} — ${formatPrice(p.price_display)}`;
    b.addEventListener('click', () => { state.plan = p.id; renderPlans(); });
    box.appendChild(b);
  }
}

// --- cuenta -----------------------------------------------------------------
function loadAccount() {
  const a = safeParse(localStorage.getItem(LS_ACCOUNT) || 'null');
  return a && isPlausibleSecret(a.account_secret) ? a : null;
}

function accountReady(account) {
  state.account = account;
  show('account-choice', false); show('existing-box', false); show('secret-box', false);
  $('account-ok').textContent = 'Cuenta lista en este navegador.';
  show('account-ok');
  if (state.freeUntil) { show('step-free'); return; }
  show('step-method');
  renderMethods();
}

async function createAccount() {
  showError('');
  $('btn-create').disabled = true;
  try {
    const acc = await api('/v1/accounts', { method: 'POST', body: {} });
    state.pending = acc;
    $('secret-value').textContent = acc.account_secret;
    show('account-choice', false); show('secret-box');
  } catch (e) { showError(e.message); $('btn-create').disabled = false; }
}

function useExisting() {
  const s = $('existing-secret').value.trim();
  if (!isPlausibleSecret(s)) return showError('Ese secreto no tiene el formato esperado.');
  showError('');
  const acc = { account_id: null, account_secret: s };
  localStorage.setItem(LS_ACCOUNT, JSON.stringify(acc));
  accountReady(acc);
}

// --- factura ----------------------------------------------------------------
function renderMethods() {
  const box = $('method-list'); box.replaceChildren();
  for (const m of state.methods) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn plan-opt'; b.dataset.key = methodKey(m);
    b.textContent = methodLabel(m);
    b.addEventListener('click', () => createInvoice(m));
    box.appendChild(b);
  }
}

async function createInvoice(m) {
  showError('');
  for (const b of $('method-list').children) b.disabled = true;
  try {
    const inv = await api('/v1/invoices', { method: 'POST', secret: state.account.account_secret, body: { plan: state.plan, network: m.network, token: m.token } });
    inv.decimals = m.decimals;
    localStorage.setItem(LS_INVOICE, JSON.stringify(inv));
    showInvoice(inv);
  } catch (e) {
    showError(e.message);
    for (const b of $('method-list').children) b.disabled = false;
  }
}

function showInvoice(inv) {
  state.invoice = inv;
  show('step-plan', false); show('step-method', false); show('step-invoice');
  const a = formatAmount(inv);
  const el = $('amount'); el.replaceChildren();
  el.append(`${a.whole}.${a.base}`);
  const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = a.tag; el.append(tag);
  $('amount-tag').textContent = a.tag;
  $('amount-token').textContent = `${inv.token} · ${NETWORK_LABELS[inv.network] || inv.network}`;
  $('net-name').textContent = NETWORK_LABELS[inv.network] || inv.network;
  $('pay-address').textContent = inv.pay_address;
  $('expires').textContent = formatDate(inv.expires_at);
  $('qr').innerHTML = qrSvg(inv.pay_address); // SVG generado localmente a partir de una direccion validada por el Worker
  $('btn-copy-amount').onclick = (e) => copy(a.text, e.currentTarget);
  $('btn-copy-address').onclick = (e) => copy(inv.pay_address, e.currentTarget);
  setStatus('pending');
  schedulePoll(POLL_INTERVAL_MS);
}

function setStatus(status) {
  const s = mapStatus(status);
  const el = $('status'); el.textContent = s.label; el.className = `status ${s.tone}`;
  return s;
}

function schedulePoll(delay) {
  clearTimeout(state.timer);
  state.timer = setTimeout(poll, delay);
}

async function poll() {
  const inv = state.invoice;
  try {
    const cur = await api(`/v1/invoices/${encodeURIComponent(inv.invoice_id)}`, { secret: state.account.account_secret });
    const s = setStatus(cur.status);
    if (cur.tx_hash && cur.status !== 'pending') {
      $('tx-line').textContent = `Transacción: ${cur.tx_hash}`; show('tx-line');
    }
    if (cur.status === 'paid') { localStorage.removeItem(LS_INVOICE); return fetchLicense(); }
    if (s.final) { localStorage.removeItem(LS_INVOICE); return; }
    state.pollDelay = POLL_INTERVAL_MS;
  } catch (e) {
    if (e.status === 401 || e.status === 404) { showError(e.message); return; }
    // 429 o red caida: se espacia el siguiente intento sin abandonar
    state.pollDelay = Math.min(state.pollDelay * 2, 120000);
  }
  schedulePoll(state.pollDelay);
}

async function fetchLicense() {
  try {
    const lic = await api('/v1/license', { secret: state.account.account_secret });
    localStorage.setItem(LS_LICENSE, JSON.stringify({
      token: lic.token, plan: lic.plan, account_id: lic.account_id,
      expires_at: lic.expires_at, valid_until: lic.valid_until, grace_days: lic.grace_days,
      stored_at: new Date().toISOString(),
    }));
    show('step-invoice', false); show('step-free', false); show('step-done');
    if (lic.plan === 'early_access') {
      $('done-title').textContent = 'Listo, acceso gratuito activo';
      $('license-line').textContent = `Tu acceso gratuito de pruebas vale hasta el ${formatDate(lic.valid_until)}.`;
    } else {
      $('license-line').textContent = `Plan ${PLAN_LABELS[lic.plan] || lic.plan}. Tu membresía vale hasta el ${formatDate(lic.valid_until)}.`;
    }
  } catch (e) {
    if (state.freeUntil && !state.invoice) {
      show('btn-free'); $('btn-free').disabled = false;
      return showError(`No se pudo activar el acceso: ${e.message}`);
    }
    // El pago ya esta registrado; la licencia puede tardar un instante o fallar la red.
    showError(`Pago recibido, pero no se pudo obtener la licencia: ${e.message} Reintentando…`);
    setTimeout(fetchLicense, 10000);
  }
}

// --- arranque ---------------------------------------------------------------
async function init() {
  $('btn-create').addEventListener('click', createAccount);
  $('btn-existing').addEventListener('click', () => { show('existing-box'); show('account-choice', false); });
  $('btn-use-existing').addEventListener('click', useExisting);
  $('btn-copy-secret').addEventListener('click', (e) => copy(state.pending.account_secret, e.currentTarget));
  $('btn-download-secret').addEventListener('click', () => download('swal-trade-secreto.txt', secretFileContents(state.pending.account_id, state.pending.account_secret)));
  $('btn-free').addEventListener('click', () => { showError(''); $('btn-free').disabled = true; fetchLicense(); });
  $('saved-check').addEventListener('change', (e) => { $('btn-continue').disabled = !e.target.checked; });
  $('btn-continue').addEventListener('click', () => {
    localStorage.setItem(LS_ACCOUNT, JSON.stringify(state.pending));
    const acc = state.pending; state.pending = null; $('secret-value').textContent = '';
    accountReady(acc);
  });

  try {
    const data = await api('/v1/plans');
    state.plans = data.plans; state.methods = data.methods;
    state.freeUntil = data.free_until && new Date(data.free_until) > new Date() ? data.free_until : null;
    if (!state.plans.some((p) => p.id === state.plan)) state.plan = state.plans[0].id;
  } catch (e) { $('plan-loading').textContent = ''; return showError(e.message); }
  $('plan-loading').remove();
  if (state.freeUntil) {
    // Fase de pruebas: no hay plan que elegir ni factura que pagar.
    show('step-plan', false);
    $('intro').textContent = 'Durante las pruebas el acceso es gratis. Tu cuenta es un secreto que solo guardas tú; no pedimos datos personales.';
    $('free-line').textContent = `Tu acceso gratuito vale hasta el ${formatDate(state.freeUntil)}. Incluye el respaldo cifrado de extremo a extremo.`;
  } else {
    renderPlans();
  }
  show('step-account');

  const acc = loadAccount();
  if (acc) {
    accountReady(acc);
    const inv = state.freeUntil ? null : safeParse(localStorage.getItem(LS_INVOICE) || 'null');
    if (inv && inv.invoice_id && new Date(inv.expires_at) > new Date()) showInvoice(inv);
  }
}

init();
