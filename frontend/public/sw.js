// Service worker du mode terrain.
//
// CE QU'IL GARANTIT
//
// Que l'application s'ouvre sans reseau, et que la CARTE s'affiche. La version precedente
// ne tenait que la premiere promesse : elle n'interceptait que les requetes de son propre
// domaine, or les tuiles viennent de `tile.openstreetmap.org` et d'ArcGIS. Un agent hors
// couverture voyait donc l'application se charger sur un fond gris, ce qui la rend
// inutilisable pour localiser quoi que ce soit.
//
// LES DECISIONS SONT AILLEURS, ET C'EST VOULU
//
// Ce que l'on cache, ce que l'on refuse, et quand on evince : tout est dans
// `sw-policy.js`, qui ne contient que des fonctions pures et qui est TESTE. Un worker ne
// s'importe pas depuis un test, donc enfouir ces regles ici les aurait rendues
// inverifiables — et ce sont elles qui comptent.
//
// CE QU'IL NE FAIT PAS, DELIBEREMENT
//
// Il ne PRECHARGE pas une zone de mission. Le §11 du cahier le demande, et la politique
// d'usage d'OpenStreetMap interdit le telechargement en masse de ses tuiles : un
// prechargement de region la violerait, et ferait bannir l'adresse du serveur. Le cache se
// remplit de ce que l'agent a REELLEMENT consulte.
//
// Precharger pour de vrai demanderait un fond de carte dont AGEROUTE maitrise la
// distribution, ou des tuiles vectorielles hebergees par le serveur. C'est une decision
// d'infrastructure, pas un reglage de ce fichier.
importScripts("/sw-policy.js");

const P = globalThis.politiqueSw;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((clefs) => Promise.all(
        // Les deux caches courants survivent ; les versions anterieures partent.
        clefs.filter((k) => k !== P.CACHE_SHELL && k !== P.CACHE_TUILES)
          .map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

/**
 * Ramene le cache des tuiles sous son plafond.
 *
 * Appele APRES avoir repondu, jamais avant : faire attendre un agent le temps d'une
 * eviction serait absurde, et l'echec de l'eviction ne doit pas empecher l'affichage.
 */
async function limiterTuiles() {
  const cache = await caches.open(P.CACHE_TUILES);
  const clefs = await cache.keys();
  for (const clef of P.aEvincer(clefs, P.MAX_TUILES)) {
    await cache.delete(clef);
  }
}

self.addEventListener("fetch", (event) => {
  const requete = event.request;
  if (P.aLaisserPasser(requete.url, requete.method)) return;

  // NAVIGATION : reseau d'abord, repli sur l'enveloppe en cache. Le reseau d'abord parce
  // qu'une application servie depuis le cache ne se met jamais a jour.
  if (requete.mode === "navigate") {
    event.respondWith(
      fetch(requete)
        .then((res) => {
          if (P.aMettreEnCache(res)) {
            const copie = res.clone();
            caches.open(P.CACHE_SHELL).then((c) => c.put("/", copie));
          }
          return res;
        })
        .catch(() => caches.match("/").then((cache) => cache || caches.match(requete))),
    );
    return;
  }

  const nomCache = P.cachePour(requete.url, self.location.origin);
  if (nomCache === null) return;

  const estTuile = nomCache === P.CACHE_TUILES;

  event.respondWith(
    caches.match(requete).then((cache) => {
      // TUILE : le cache d'abord, et on ne va au reseau que s'il n'a rien. Une tuile ne
      // change pas, et la rechercher a chaque fois sur un reseau de terrain coute cher pour
      // rien. L'enveloppe, elle, se revalide en arriere-plan pour recevoir les mises a jour.
      if (estTuile && cache) return cache;

      const reseau = fetch(requete)
        .then((res) => {
          if (P.aMettreEnCache(res)) {
            const copie = res.clone();
            caches.open(nomCache)
              .then((c) => c.put(requete, copie))
              .then(() => { if (estTuile) return limiterTuiles(); })
              .catch(() => { /* stockage plein : on a deja repondu */ });
          }
          return res;
        })
        .catch(() => cache);

      return cache || reseau;
    }),
  );
});

/**
 * Permet a l'application de vider les tuiles sans toucher a l'enveloppe.
 *
 * Utile quand l'agent manque de place : il libere la carte, pas l'application, et celle-ci
 * continue de s'ouvrir hors ligne.
 */
self.addEventListener("message", (event) => {
  if (event.data === "vider-tuiles") {
    event.waitUntil?.(caches.delete(P.CACHE_TUILES));
  }
});
