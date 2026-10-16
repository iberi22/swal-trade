// Configuración de apoyo voluntario a SWAL Trade.
//
// DÓNDE COMPLETAR ESTOS VALORES (instrucciones para el titular / Bel):
// 1. GitHub Sponsors: Asignar la URL del perfil de patrocinio en GITHUB_SPONSORS_URL
//    (por ejemplo: 'https://github.com/sponsors/iberi22').
// 2. Donaciones cripto: Cuando existan las wallets de autocustodia (self-custody),
//    añadir cada entrada en CRYPTO_WALLETS con el formato:
//    { network: 'Red (ej. Bitcoin)', asset: 'Símbolo (ej. BTC)', address: 'dirección pública real' }
//
// REGLA FUNDAMENTAL: Nunca inventar direcciones ni URLs. Mientras estén vacíos,
// la interfaz mostrará honestamente "Disponible pronto".

export const DONATION_CONFIG = {
  GITHUB_SPONSORS_URL: '',
  CRYPTO_WALLETS: [],
};

export function renderSupport(config = DONATION_CONFIG, doc = document) {
  const sponsorsEl = doc.getElementById('sponsors-container');
  if (sponsorsEl) {
    if (config.GITHUB_SPONSORS_URL && typeof config.GITHUB_SPONSORS_URL === 'string' && config.GITHUB_SPONSORS_URL.trim() !== '') {
      const a = doc.createElement('a');
      a.className = 'btn';
      a.href = config.GITHUB_SPONSORS_URL.trim();
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'Patrocinar en GitHub Sponsors';
      sponsorsEl.replaceChildren(a);
    } else {
      const p = doc.createElement('p');
      p.className = 'muted';
      p.id = 'sponsors-status';
      p.textContent = 'Disponible pronto. Estamos configurando la cuenta de GitHub Sponsors.';
      sponsorsEl.replaceChildren(p);
    }
  }

  const cryptoEl = doc.getElementById('crypto-container');
  if (cryptoEl) {
    if (Array.isArray(config.CRYPTO_WALLETS) && config.CRYPTO_WALLETS.length > 0) {
      const list = doc.createElement('ul');
      list.className = 'bullets';
      for (const w of config.CRYPTO_WALLETS) {
        const item = doc.createElement('li');
        const h = doc.createElement('h3');
        h.textContent = `${w.asset} (${w.network})`;
        const addr = doc.createElement('code');
        addr.textContent = w.address;
        item.append(h, addr);
        list.append(item);
      }
      cryptoEl.replaceChildren(list);
    } else {
      const p = doc.createElement('p');
      p.className = 'muted';
      p.id = 'crypto-status';
      p.textContent = 'Disponible pronto. Solo aceptaremos donativos en cripto a wallets de autocustodia una vez estén configuradas.';
      cryptoEl.replaceChildren(p);
    }
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => renderSupport(DONATION_CONFIG, document));
  } else {
    renderSupport(DONATION_CONFIG, document);
  }
}
