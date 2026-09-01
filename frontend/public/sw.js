// Service worker minimal : met en cache l'app shell (HTML/JS/CSS) au fil de la navigation
// pour permettre un premier rendu hors-ligne. Les appels /api/ ne sont jamais interceptes :
// la logique de file d'attente hors-ligne (IndexedDB) est geree cote application, pas ici.
const CACHE_NAME = "bdri-shell-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Ne jamais intercepter les appels API : la file d'attente offline gere ces cas cote app.
  if (url.pathname.startsWith("/api/")) return;
  if (event.request.method !== "GET") return;

  // Navigation (chargement de page) : reseau d'abord, repli sur le shell mis en cache.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("/", clone));
          return res;
        })
        .catch(() => caches.match("/").then((cached) => cached || caches.match(event.request)))
    );
    return;
  }

  // Assets statiques (JS/CSS/images) : cache d'abord, mise a jour en arriere-plan.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const network = fetch(event.request)
          .then((res) => {
            if (res.ok) {
              const clone = res.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
});
