// Service worker minimal pour Zonako — sert surtout à rendre le site
// "installable" comme une application, avec un repli simple hors-ligne.
// Les données (API) ne sont JAMAIS mises en cache ici : elles doivent
// toujours être fraîches (commandes, produits, prix...).

const CACHE_NAME = "zonako-shell-v1";
const APP_SHELL = ["/", "/manifest.json", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Ne jamais intercepter les appels API — toujours du réseau, données fraîches.
  if (url.pathname.startsWith("/api/")) return;

  // Pour le reste (page principale, icônes...) : réseau d'abord, secours au
  // cache si hors-ligne, pour éviter une page d'erreur blanche du navigateur.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/")))
  );
});
