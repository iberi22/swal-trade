// analisis.js — UI de /analisis/. Toda la logica de deteccion vive en analysis-core.js (pura).
import { analyzeSync, trendOf, NO_HISTORY_TEXT } from './analysis-core.js';
import {
  EXPLAIN_DISCLAIMER,
  EXPLAIN_ENDPOINT,
  explainButtonLabel,
  explainErrorText,
  explainRequestFrom,
  explainSourceLabel,
  explainView,
} from './explain-ui.js';

const FAPI = 'https://fapi.binance.com/fapi/v1/klines';
// Ruta actual de streams de mercado de USD-M (2025): /market/ws para kline. Si falla, se cae a /ws.
const WS_ROUTES = ['wss://fstream.binance.com/market/ws/', 'wss://fstream.binance.com/ws/'];
const FNG_URL = 'https://api.alternative.me/fng/?limit=1';
const FNG_KEY = 'swal.analisis.fng';
const FNG_TTL_MS = 3600 * 1000;
const TREND_TFS = ['1m', '5m', '1h', '4h'];

const $ = (id) => document.getElementById(id);
const FG = '34, 31, 27'; // --foreground en rgb (un solo tono)
const BG = '247, 244, 238';
const fg = (a) => `rgba(${FG}, ${a})`;

const state = { symbol: 'BTCUSDT', timeframe: '15m', candles: [], result: null, selected: null, ws: null, wsRoute: 0, gen: 0, priceLines: [], lastAnalysis: 0 };

const chart = LightweightCharts.createChart($('chart'), {
  autoSize: true,
  layout: { background: { type: 'solid', color: 'rgba(0,0,0,0)' }, textColor: fg(0.6), fontFamily: 'ui-sans-serif, system-ui, sans-serif' },
  grid: { vertLines: { color: fg(0.05) }, horzLines: { color: fg(0.05) } },
  rightPriceScale: { borderVisible: false },
  timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
  crosshair: { vertLine: { color: fg(0.3), labelBackgroundColor: fg(0.8) }, horzLine: { color: fg(0.3), labelBackgroundColor: fg(0.8) } },
});
// Alcista = hueca (borde en el tono), bajista = rellena.
const series = chart.addCandlestickSeries({
  upColor: `rgb(${BG})`, borderUpColor: fg(1), wickUpColor: fg(1),
  downColor: fg(1), borderDownColor: fg(1), wickDownColor: fg(1),
  borderVisible: true, priceLineVisible: false,
});

// ---------- datos ----------
const toCandle = (r) => ({ time: Math.floor(r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] });
async function fetchKlines(symbol, tf, limit = 500) {
  const res = await fetch(`${FAPI}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(tf)}&limit=${limit}`);
  if (!res.ok) throw new Error(`klines ${res.status}`);
  return (await res.json()).map(toCandle);
}

function setConn(t) { $('conn').textContent = t; }

function connectWs() {
  const gen = state.gen;
  if (state.ws) { state.ws.onclose = null; state.ws.close(); }
  const url = `${WS_ROUTES[state.wsRoute]}${state.symbol.toLowerCase()}@kline_${state.timeframe}`;
  let gotMessage = false;
  const ws = new WebSocket(url);
  state.ws = ws;
  ws.onopen = () => setConn('En vivo');
  ws.onmessage = (ev) => {
    if (gen !== state.gen) return;
    gotMessage = true;
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    const k = m && m.k; if (!k) return;
    onLiveCandle({ time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v }, !!k.x);
  };
  ws.onclose = () => {
    if (gen !== state.gen) return;
    if (!gotMessage && state.wsRoute < WS_ROUTES.length - 1) { state.wsRoute++; connectWs(); return; }
    setConn('Sin conexión en vivo; reintentando…');
    setTimeout(() => { if (gen === state.gen) connectWs(); }, 5000);
  };
  ws.onerror = () => ws.close();
}

function onLiveCandle(c, closed) {
  const cs = state.candles, last = cs[cs.length - 1];
  if (last && last.time === c.time) cs[cs.length - 1] = c; else { cs.push(c); if (cs.length > 1000) cs.shift(); }
  series.update(c);
  const now = Date.now();
  if (closed || now - state.lastAnalysis > 5000) runAnalysis(false);
}

// ---------- analisis y dibujo ----------
function runAnalysis(refit) {
  state.lastAnalysis = Date.now();
  const res = analyzeSync({ symbol: state.symbol, timeframe: state.timeframe, candles: state.candles });
  state.result = res;
  drawPriceLinesAndMarkers(res);
  renderFindings(res);
  renderTrend(TREND_TFS.includes(state.timeframe) ? state.timeframe : null, res.trend);
  drawOverlay();
  if (refit) chart.timeScale().fitContent();
}

const top5 = (res) => (Array.isArray(res.top)
  ? res.top.slice(0, 5)
  : res.findings.filter((f) => f.kind !== 'shock' || f.strength > 0.5).slice(0, 5));

function drawPriceLinesAndMarkers(res) {
  for (const l of state.priceLines) series.removePriceLine(l);
  state.priceLines = [];
  const add = (price, alpha, style, title) => state.priceLines.push(series.createPriceLine({ price, color: fg(alpha), lineWidth: 1, lineStyle: style, axisLabelVisible: false, title }));
  for (const f of top5(res)) {
    const sel = f.id === state.selected;
    for (const l of f.levels) {
      if (l.role === 'support' || l.role === 'resistance') add(l.price, sel ? 0.8 : 0.3, 0, '');
      else if (l.role === 'neckline') add(l.price, sel ? 0.9 : 0.5, 2, 'cuello');
      else if (l.role === 'poc') add(l.price, sel ? 0.8 : 0.4, 1, 'POC');
      else if (l.role === 'range_high' || l.role === 'range_low') add(l.price, sel ? 0.8 : 0.35, 2, '');
    }
  }
  const markers = [];
  for (const p of res.pivots) {
    markers.push({ time: p.time, position: p.type === 'high' ? 'aboveBar' : 'belowBar', shape: 'circle', color: fg(0.35), size: 0.5 });
  }
  for (const f of res.findings.filter((x) => x.kind === 'shock')) {
    markers.push({ time: f.from, position: f.direction === 'up' ? 'aboveBar' : 'belowBar', shape: f.direction === 'up' ? 'arrowDown' : 'arrowUp', color: fg(0.8), text: '!' });
  }
  markers.sort((a, b) => a.time - b.time);
  series.setMarkers(markers);
}

const overlay = $('overlay');
function drawOverlay() {
  const host = $('chart');
  const dpr = window.devicePixelRatio || 1;
  const w = host.clientWidth, h = host.clientHeight;
  if (overlay.width !== w * dpr || overlay.height !== h * dpr) { overlay.width = w * dpr; overlay.height = h * dpr; }
  const ctx = overlay.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const res = state.result; if (!res) return;
  const ts = chart.timeScale();
  const X = (t) => ts.timeToCoordinate(t);
  const Y = (p) => series.priceToCoordinate(p);
  const plotW = w - (chart.priceScale('right').width() || 0);
  for (const f of top5(res)) {
    const sel = f.id === state.selected;
    for (const l of f.levels) {
      if ((l.role === 'support' || l.role === 'resistance') && l.low != null) {
        const y1 = Y(l.high), y2 = Y(l.low); if (y1 == null || y2 == null) continue;
        const x = Math.max(0, X(f.from) ?? 0);
        ctx.fillStyle = fg(sel ? 0.18 : 0.07);
        ctx.fillRect(x, Math.min(y1, y2), plotW - x, Math.max(2, Math.abs(y2 - y1)));
      }
    }
    if (f.kind.endsWith('_triangle')) {
      ctx.strokeStyle = fg(sel ? 0.9 : 0.5); ctx.lineWidth = sel ? 2 : 1;
      for (const l of f.levels) {
        if (!l.line) continue;
        const a = X(l.line.from.time), b = X(l.line.to.time), ya = Y(l.line.from.price), yb = Y(l.line.to.price);
        if (a == null || b == null || ya == null || yb == null) continue;
        ctx.beginPath(); ctx.moveTo(a, ya); ctx.lineTo(b, yb); ctx.stroke();
      }
    }
    if (f.kind === 'range_breakout') {
      const hi = f.levels.find((l) => l.role === 'range_high'), lo = f.levels.find((l) => l.role === 'range_low');
      const y1 = Y(hi.price), y2 = Y(lo.price), x = X(f.from);
      if (y1 != null && y2 != null && x != null) { ctx.fillStyle = fg(sel ? 0.15 : 0.06); ctx.fillRect(x, y1, plotW - x, y2 - y1); }
    }
    if (f.kind === 'double_top' || f.kind === 'double_bottom') {
      ctx.strokeStyle = fg(sel ? 0.9 : 0.45); ctx.lineWidth = sel ? 2 : 1; ctx.setLineDash([4, 3]);
      const pts = f.levels.filter((l) => l.time != null).map((l) => [X(l.time), Y(l.price)]);
      if (pts.length === 2 && pts.every((p) => p[0] != null && p[1] != null)) { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]); ctx.stroke(); }
      ctx.setLineDash([]);
    }
    if (f.kind.startsWith('rsi_divergence')) {
      ctx.strokeStyle = fg(sel ? 0.9 : 0.5); ctx.lineWidth = sel ? 2 : 1;
      const pts = f.levels.map((l) => [X(l.time), Y(l.price)]);
      if (pts.every((p) => p[0] != null && p[1] != null)) { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]); ctx.stroke(); }
    }
  }
  // perfil de volumen: histograma horizontal pegado al borde derecho
  const vp = res.findings.find((f) => f.kind === 'volume_profile');
  if (vp) {
    const bins = vp.evidence.bins, max = Math.max(...bins.map((b) => b.volume));
    const step = bins.length > 1 ? Math.abs(bins[1].price - bins[0].price) : 0;
    for (const b of bins) {
      const y1 = Y(b.price + step / 2), y2 = Y(b.price - step / 2); if (y1 == null || y2 == null) continue;
      const bw = (b.volume / max) * plotW * 0.18;
      ctx.fillStyle = fg(0.09);
      ctx.fillRect(plotW - bw, Math.min(y1, y2), bw, Math.max(1, Math.abs(y2 - y1) - 1));
    }
  }
}
chart.timeScale().subscribeVisibleLogicalRangeChange(drawOverlay);
new ResizeObserver(drawOverlay).observe($('chart'));

// ---------- panel ----------
const PCT = (x) => Math.round(x * 100);
const DIR = { up: 'alcista', down: 'bajista', neutral: 'neutral' };
function renderFindings(res) {
  const ol = $('findings');
  ol.replaceChildren();
  const list = top5(res);
  if (!list.length) { const li = document.createElement('li'); li.textContent = 'Sin patrones claros en esta ventana.'; ol.append(li); return; }
  for (const f of list) {
    const li = document.createElement('li');
    if (f.id === state.selected) li.className = 'active';
    const row = document.createElement('div'); row.className = 'row';
    const a = document.createElement('span'); a.textContent = f.label;
    const b = document.createElement('span'); b.textContent = `fuerza del patrón ${PCT(f.strength)}`;
    row.append(a, b);
    const p = document.createElement('p'); p.className = 'expl'; p.textContent = f.explanation;
    const m = document.createElement('div'); m.className = 'meter'; const i = document.createElement('i'); i.style.width = `${PCT(f.strength)}%`; m.append(i);
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.textContent = `${DIR[f.direction]} · ${f.status === 'confirmed' ? 'confirmado' : 'en formación'} · acierto histórico: ${NO_HISTORY_TEXT}`;
    li.append(row, p, m, meta);
    li.addEventListener('click', () => focusFinding(f));
    ol.append(li);
  }
}

function focusFinding(f) {
  state.selected = state.selected === f.id ? null : f.id;
  if (state.selected) {
    const span = Math.max(f.to - f.from, 20 * tfSeconds(state.timeframe));
    chart.timeScale().setVisibleRange({ from: f.from - span * 0.3, to: Math.max(f.to, f.from) + span * 0.3 });
  }
  drawPriceLinesAndMarkers(state.result); renderFindings(state.result); drawOverlay();
}
const tfSeconds = (tf) => ({ '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 })[tf];

function trendRow(tf, t) {
  const li = document.createElement('li');
  const a = document.createElement('span'); a.textContent = tf;
  const b = document.createElement('span'); b.className = 'v'; b.textContent = `${t.label} (${PCT(t.strength)})`;
  li.append(a, b); return li;
}
const trendCache = new Map();
function renderTrend(tf, t) { if (tf) trendCache.set(tf, t); paintTrends(); }
function paintTrends() {
  const ul = $('trends'); ul.replaceChildren();
  for (const tf of TREND_TFS) { const t = trendCache.get(tf); ul.append(trendRow(tf, t || { label: '…', strength: 0 })); }
}
async function refreshTrends() {
  const symbol = state.symbol;
  await Promise.all(TREND_TFS.map(async (tf) => {
    try { const c = await fetchKlines(symbol, tf, 200); if (symbol === state.symbol) trendCache.set(tf, trendOf(c)); } catch { /* se mantiene el ultimo valor */ }
  }));
  paintTrends();
}

function newsAsset(symbol) {
  if (symbol.startsWith('BTC')) return 'BTC';
  if (symbol.startsWith('ETH')) return 'ETH';
  return null;
}

function relativeTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'fecha desconocida';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'hace un momento';
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} d`;
}

function sentimentText(label) {
  if (label === 'positivo' || label === 'negativo' || label === 'neutral') return label;
  return 'neutral';
}

// ---------- explicador IA ----------
// Los helpers puros (cuerpo de la petición, vista y errores) viven en explain-ui.js.
// Aquí solo queda el pintado y el fetch, que es lo que necesita un DOM real.
const explainState = { busy: false };

function explainNodes() {
  return {
    card: $('explain-card'),
    button: $('explain'),
    status: $('explain-status'),
    out: $('explain-out'),
  };
}

// Al cambiar de símbolo o temporalidad la explicación anterior miente: se borra.
function resetExplain() {
  const { card, out } = explainNodes();
  if (out) { out.replaceChildren(); out.hidden = true; }
  if (card) card.hidden = true;
}

function paintExplain(view) {
  const { card, out } = explainNodes();
  if (!card || !out) return;
  card.hidden = false;
  out.replaceChildren();
  out.hidden = false;

  const sum = document.createElement('p');
  sum.className = 'sum';
  sum.textContent = view.summary;
  out.append(sum);

  if (view.scenarios.length) {
    const ol = document.createElement('ol');
    for (const scenario of view.scenarios) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = scenario.name;
      li.append(name);
      const line = (label, value) => {
        if (!value) return null;
        const p = document.createElement('p');
        p.className = 'line';
        const b = document.createElement('b');
        b.textContent = `${label}: `;
        p.append(b, document.createTextNode(value));
        return p;
      };
      for (const node of [
        line('Confirma', scenario.condition),
        line('Invalida', scenario.invalidation),
        line('Riesgo', scenario.riskNote),
      ]) if (node) li.append(node);
      ol.append(li);
    }
    out.append(ol);
  }

  for (const [text_, className] of [[view.caution, 'caution'], [view.note, 'caution'], [explainSourceLabel(view.source, view.reason), 'src'], [view.disclaimer || EXPLAIN_DISCLAIMER, 'caution']]) {
    if (!text_) continue;
    const p = document.createElement('p');
    p.className = className;
    p.textContent = text_;
    out.append(p);
  }
}

function paintExplainError(message) {
  const { card, out } = explainNodes();
  if (!card || !out) return;
  card.hidden = false;
  out.hidden = false;
  const p = document.createElement('p');
  p.className = 'caution';
  p.textContent = message;
  out.replaceChildren(p);
}

async function explain() {
  if (explainState.busy) return;
  const { button, status, out } = explainNodes();
  if (!button) return;
  explainState.busy = true;
  button.disabled = true;
  button.textContent = explainButtonLabel(true);
  if (status) status.textContent = 'Enviando el análisis al explicador…';
  try {
    const res = await fetch(EXPLAIN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(explainRequestFrom(state)),
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) {
      paintExplainError(explainErrorText(res.status, body));
      return;
    }
    const parsed = explainView(body);
    if (!parsed.ok) {
      paintExplainError(parsed.error);
      return;
    }
    paintExplain(parsed.view);
  } catch {
    paintExplainError('Sin conexión con el explicador. Vuelve a intentarlo.');
  } finally {
    explainState.busy = false;
    button.disabled = false;
    button.textContent = explainButtonLabel(false);
    if (status) status.textContent = '';
    if (out && !out.childElementCount) out.hidden = true;
  }
}

function httpsUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

async function loadNews() {
  const ol = $('news');
  if (!ol) return;
  ol.replaceChildren();
  const asset = newsAsset(state.symbol);
  const note = document.createElement('li');
  note.className = 'meta';
  if (!asset) {
    note.textContent = 'Sin titulares para este símbolo.';
    ol.append(note);
    return;
  }
  try {
    const res = await fetch(`/api/news?symbol=${asset}&limit=5`);
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    const items = Array.isArray(body.items) ? body.items.slice(0, 5) : [];
    if (!items.length) {
      note.textContent = 'Sin titulares recientes.';
      ol.append(note);
      return;
    }
    for (const item of items) {
      const href = httpsUrl(item && item.url);
      const title = item && typeof item.title === 'string' ? item.title : '';
      if (!href || !title) continue;
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = title;
      const meta = document.createElement('div');
      meta.className = 'meta';
      const source = item.source ? String(item.source) : 'fuente';
      const tone = sentimentText(item.sentiment && item.sentiment.label);
      meta.textContent = `${source} · ${relativeTime(item.publishedAt)} · ${tone}`;
      li.append(a, meta);
      ol.append(li);
    }
    if (!ol.childElementCount) {
      note.textContent = 'Sin titulares recientes.';
      ol.append(note);
    }
  } catch {
    note.textContent = 'No se pudieron cargar las noticias.';
    ol.append(note);
  }
}

async function loadFng() {
  try {
    let cached = null; try { cached = JSON.parse(localStorage.getItem(FNG_KEY) || 'null'); } catch { /* ignore */ }
    let d = cached && Date.now() - cached.at < FNG_TTL_MS ? cached.data : null;
    if (!d) {
      const res = await fetch(FNG_URL); if (!res.ok) throw new Error(res.status);
      d = (await res.json()).data[0];
      try { localStorage.setItem(FNG_KEY, JSON.stringify({ at: Date.now(), data: d })); } catch { /* ignore */ }
    }
    const names = { 'Extreme Fear': 'Miedo extremo', Fear: 'Miedo', Neutral: 'Neutral', Greed: 'Codicia', 'Extreme Greed': 'Codicia extrema' };
    $('fng').textContent = d.value;
    $('fng-label').textContent = `${names[d.value_classification] || d.value_classification}. 0 = miedo extremo, 100 = codicia extrema (alternative.me, se actualiza cada hora).`;
  } catch { $('fng').textContent = '—'; $('fng-label').textContent = 'No disponible ahora.'; }
}

// ---------- arranque ----------
async function load() {
  const gen = ++state.gen;
  state.selected = null; state.wsRoute = 0;
  resetExplain();
  setConn('Cargando…');
  try {
    const c = await fetchKlines(state.symbol, state.timeframe);
    if (gen !== state.gen) return;
    state.candles = c;
    series.setData(c);
    runAnalysis(true);
    connectWs();
    refreshTrends();
  } catch (e) {
    setConn(`Error al cargar datos (${e.message})`);
  }
}
$('controls').addEventListener('submit', (e) => e.preventDefault());
const explainButton = $('explain');
if (explainButton) explainButton.addEventListener('click', explain);
$('symbol').addEventListener('change', (e) => { state.symbol = e.target.value; trendCache.clear(); load(); loadNews(); });
$('timeframe').addEventListener('change', (e) => { state.timeframe = e.target.value; load(); });
setInterval(refreshTrends, 60000);
setInterval(loadNews, 300000);
paintTrends(); loadFng(); loadNews(); load();
