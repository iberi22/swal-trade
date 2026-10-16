// Configuración de la instalación asistida de SWAL Trade.
//
// DÓNDE COMPLETAR ESTOS VALORES (instrucciones para el titular / Bel):
// 1. PRICE_TEXT: Texto del precio tal como debe verse en la página (por ejemplo,
//    el importe de la sesión y lo que incluye).
// 2. CONTACT_URL: Enlace para agendar la sesión. Solo se aceptan URLs que empiecen
//    por https:// o mailto:. Cualquier otro valor se trata como no configurado.
// 3. PAYMENT_METHODS: Lista de medios de pago realmente aceptados, un texto por entrada.
//
// REGLA FUNDAMENTAL: Nunca inventar precios, contactos ni medios de pago. Mientras
// PRICE_TEXT o CONTACT_URL estén vacíos (o CONTACT_URL no sea válida), la interfaz
// mostrará honestamente "Disponible pronto".

export const INSTALL_CONFIG = {
  PRICE_TEXT: '',
  CONTACT_URL: '',
  PAYMENT_METHODS: [],
};

// Devuelve la URL de contacto si es https: o mailto:, o cadena vacía en otro caso.
function safeContactUrl(raw) {
  if (typeof raw !== 'string') return '';
  const url = raw.trim();
  if (url === '') return '';
  let protocol = '';
  try {
    protocol = new URL(url).protocol;
  } catch {
    return '';
  }
  return protocol === 'https:' || protocol === 'mailto:' ? url : '';
}

export function renderInstallOffer(config = INSTALL_CONFIG, doc = document) {
  const offerEl = doc.getElementById('install-offer');
  if (!offerEl) return;

  const priceText = typeof config.PRICE_TEXT === 'string' ? config.PRICE_TEXT.trim() : '';
  const contactUrl = safeContactUrl(config.CONTACT_URL);

  if (priceText === '' || contactUrl === '') {
    const p = doc.createElement('p');
    p.className = 'muted';
    p.id = 'install-status';
    p.textContent = 'Disponible pronto. Estamos preparando la agenda y los medios de pago.';
    offerEl.replaceChildren(p);
    return;
  }

  const nodes = [];

  const price = doc.createElement('p');
  price.className = 'price';
  price.textContent = priceText;
  nodes.push(price);

  const methods = Array.isArray(config.PAYMENT_METHODS)
    ? config.PAYMENT_METHODS.filter((m) => typeof m === 'string' && m.trim() !== '')
    : [];
  if (methods.length > 0) {
    const label = doc.createElement('p');
    label.className = 'muted';
    label.textContent = 'Medios de pago aceptados:';
    nodes.push(label);

    const list = doc.createElement('ul');
    list.className = 'bullets';
    for (const method of methods) {
      const item = doc.createElement('li');
      item.textContent = method.trim();
      list.append(item);
    }
    nodes.push(list);
  }

  const a = doc.createElement('a');
  a.className = 'btn';
  a.href = contactUrl;
  a.rel = 'noopener noreferrer';
  a.textContent = 'Agendar la sesión';
  nodes.push(a);

  offerEl.replaceChildren(...nodes);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => renderInstallOffer(INSTALL_CONFIG, document));
  } else {
    renderInstallOffer(INSTALL_CONFIG, document);
  }
}
