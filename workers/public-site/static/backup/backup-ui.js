// Respaldo E2EE: lógica del navegador para /backup/. Sin servidores de confianza: cifra en
// local con backup-core.js y solo manda el sobre a /api/backup. La frase y la clave NUNCA
// salen de aquí. Reutiliza la verificación de licencia de /guardian/.
import { ed25519Supported, loadPubkey, checkLicense, tokenFromStored, LICENSE_KEY } from '../guardian/guardian-license.js';
import {
  buildBackupData,
  decryptBackup,
  encryptBackup,
  passphraseProblem,
  passphraseStrength,
} from './backup-core.js';

const $ = (id) => document.getElementById(id);
const CFG_KEY = 'swal.guardian.cfg';   // límites del guardián
const TG_KEY = 'swal.guardian.tg';     // {token, chat} de Telegram
const ANALYSIS_KEY = 'swal.analisis.cfg';
const JOURNAL_KEY = 'swal.backup.journal';

let token = null;

const readJson = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const text = (el, t, cls) => { el.textContent = t; if (cls !== undefined) el.className = cls; };

/** Muestra el estado de la licencia y si se puede respaldar. */
async function initLicense() {
  if (!(await ed25519Supported(crypto.subtle))) {
    text($('lic-info'), 'Este navegador no soporta Ed25519: no se puede verificar la licencia Socio.', 'err');
    return false;
  }
  token = tokenFromStored(localStorage.getItem(LICENSE_KEY));
  if (!token) {
    text($('lic-info'), 'Sin licencia Socio activa. Obtén el respaldo cifrado en /checkout/.');
    return true; // el servidor puede aceptar el token en modo desarrollo
  }
  const pubkey = await loadPubkey({ fetchFn: fetch.bind(globalThis), storage: localStorage });
  if (!pubkey) { text($('lic-info'), 'No se pudo obtener la clave pública de licencias.', 'err'); return false; }
  const lic = await checkLicense({ token, pubkeySpki: pubkey, subtle: crypto.subtle });
  // checkLicense devuelve 'pro' cuando la firma y la caducidad son buenas: es el estado válido.
  const msg = {
    pro: 'Licencia Socio válida. Respaldo cifrado disponible.',
    none: 'Sin licencia Socio activa. Obtén el respaldo cifrado en /checkout/.',
    expired: 'Licencia caducada: el servidor puede rechazar el respaldo.',
    invalid: 'Licencia inválida: el servidor puede rechazar el respaldo.',
    unsupported: 'Este navegador no puede verificar la licencia Socio.',
  }[lic.status] || 'Licencia no verificada.';
  text($('lic-info'), msg, lic.status === 'pro' ? 'ok' : 'err');
  return lic.status === 'pro';
}

/** Pista de fuerza bajo el campo de frase. */
function renderStrength() {
  const pass = $('pass').value;
  const s = passphraseStrength(pass);
  const meter = $('meter');
  meter.className = `meter s${s.score}`;
  meter.firstElementChild.style.width = `${(s.score / 4) * 100}%`;
  text($('strength'), pass ? `${s.label}. ${s.hint}` : '');
}

function readJournal() {
  const j = readJson(JOURNAL_KEY);
  return Array.isArray(j) ? j : [];
}

/** Serializa las notas del textarea al diario local (una nota por línea). */
function saveJournalFromTextarea() {
  const notes = $('journal').value.split('\n').map((l) => l.trim()).filter(Boolean);
  const journal = notes.map((note, i) => ({ at: new Date().toISOString(), note, i }));
  localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal));
  return journal;
}

function loadJournalIntoTextarea() {
  $('journal').value = readJournal().map((n) => n.note ?? n).join('\n');
}

async function backupNow() {
  const pass = $('pass').value;
  const problem = passphraseProblem(pass);
  if (problem) { text($('out'), problem, 'err'); return; }
  text($('out'), 'Cifrando en este navegador…');
  try {
    const guardian = { cfg: readJson(CFG_KEY), telegram: readJson(TG_KEY) };
    const analysis = readJson(ANALYSIS_KEY) || {};
    const journal = saveJournalFromTextarea();
    const includeBotToken = $('include-tg-token').checked;
    const data = buildBackupData({ guardian, analysis, journal, includeBotToken });
    const envelope = await encryptBackup(data, pass);
    const res = await fetch('/api/backup', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(envelope),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = { too_large: 'El respaldo supera el tamaño máximo (256 KB).', rate_limited: 'Demasiados intentos. Espera un rato.', license_required: 'Falta la licencia Socio (o activa el modo desarrollo).', license_invalid: 'Licencia no válida.', license_expired: 'Licencia caducada.', pubkey_unavailable: 'El servidor no pudo verificar licencias ahora.' }[body.error] || body.error || `Error ${res.status}`;
      text($('out'), `No se pudo respaldar: ${msg}`, 'err');
      return;
    }
    text($('out'), `Respaldo guardado (${body.size} bytes). Solo viajó el sobre cifrado.${body.dev ? ' (modo desarrollo)' : ''}`, 'ok');
    $('restore').disabled = false;
    $('delete').disabled = false;
  } catch (e) {
    text($('out'), `Error al cifrar o enviar: ${String(e.message || e).slice(0, 200)}`, 'err');
  }
}

async function restore() {
  const pass = $('pass').value;
  const problem = passphraseProblem(pass);
  if (problem) { text($('out'), problem, 'err'); return; }
  text($('out'), 'Descargando y descifrando…');
  try {
    const res = await fetch('/api/backup', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) { text($('out'), `No se pudo obtener el respaldo (${res.status}).`, 'err'); return; }
    const body = await res.json();
    const data = await decryptBackup(body.envelope, pass);
    if (data.guardian && data.guardian.cfg) localStorage.setItem(CFG_KEY, JSON.stringify(data.guardian.cfg));
    if (data.guardian && data.guardian.telegram && (data.guardian.telegram.chat || data.guardian.telegram.botToken)) {
      localStorage.setItem(TG_KEY, JSON.stringify({ chat: data.guardian.telegram.chat || '', token: data.guardian.telegram.botToken || '' }));
    }
    if (data.analysis && Object.keys(data.analysis).length) localStorage.setItem(ANALYSIS_KEY, JSON.stringify(data.analysis));
    if (Array.isArray(data.journal)) {
      localStorage.setItem(JOURNAL_KEY, JSON.stringify(data.journal));
      $('journal').value = data.journal.map((n) => n.note ?? n).join('\n');
    }
    text($('out'), 'Respaldo restaurado en este navegador. Los datos se leen con tu frase; el servidor nunca los vio en claro.', 'ok');
  } catch (e) {
    text($('out'), `No se pudo restaurar: ${String(e.message || e).slice(0, 200)}`, 'err');
  }
}

async function remove() {
  if (!confirm('¿Eliminar el respaldo cifrado guardado en el servidor? Esta acción no se puede deshacer.')) return;
  try {
    const res = await fetch('/api/backup', { method: 'DELETE', headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) { text($('out'), `No se pudo eliminar (${res.status}).`, 'err'); return; }
    text($('out'), 'Respaldo eliminado del servidor.', 'ok');
    $('delete').disabled = true;
  } catch (e) {
    text($('out'), `Error al eliminar: ${String(e.message || e).slice(0, 200)}`, 'err');
  }
}

// Cableado del DOM. Solo en navegador: así el módulo se puede importar desde los tests
// (node --test) para probar la lógica pura sin un DOM.
if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
  $('pass').addEventListener('input', renderStrength);
  $('backup').addEventListener('click', backupNow);
  $('restore').addEventListener('click', restore);
  $('delete').addEventListener('click', remove);

  (async () => {
    await initLicense();
    renderStrength();
    loadJournalIntoTextarea();
  })();
}
