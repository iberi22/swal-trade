/* Registro del service worker y aviso de nueva version (archivo externo: la CSP no
 * permite scripts en linea). No cambia el comportamiento de ninguna pagina: si el
 * navegador no soporta service workers o falla el registro, se queda en silencio.
 */
(function () {
  'use strict';

  if (!('serviceWorker' in navigator)) return;

  var secure =
    location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!secure) return;

  var BAR_ID = 'pwa-update-bar';
  var refreshing = false;

  function showUpdateBar(worker) {
    if (document.getElementById(BAR_ID)) return;

    var bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-live', 'polite');
    bar.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;z-index:1000;display:flex;gap:0.75rem;' +
      'align-items:center;justify-content:center;padding:0.6rem 1rem;' +
      'background:hsl(var(--surface, 40 24% 92%));color:hsl(var(--foreground, 30 12% 12%));' +
      'font:0.85rem/1.4 var(--font-sans, system-ui, sans-serif)';

    var text = document.createElement('span');
    text.textContent = 'Nueva versión disponible';

    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Actualizar';
    button.style.cssText =
      'background:hsl(var(--primary, 30 12% 12%));color:hsl(var(--primary-foreground, 40 33% 96%));' +
      'border:0;border-radius:var(--radius, 0.75rem);padding:0.3rem 0.9rem;' +
      'font:inherit;cursor:pointer';
    button.addEventListener('click', function () {
      refreshing = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
      button.disabled = true;
      button.textContent = 'Actualizando…';
    });

    bar.appendChild(text);
    bar.appendChild(button);
    document.body.appendChild(bar);
  }

  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!refreshing) return;
    refreshing = false;
    location.reload();
  });

  navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then(function (registration) {
      if (registration.waiting && navigator.serviceWorker.controller) showUpdateBar(registration.waiting);

      registration.addEventListener('updatefound', function () {
        var installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', function () {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBar(installing);
          }
        });
      });
    })
    .catch(function () {
      /* Sin service worker el sitio funciona igual. */
    });
})();
