// Service worker du mode terrain.
//
// CE QU'IL GARANTIT
//
// Que l'application se ROUVRE sans reseau (demarrage a froid) et que la CARTE s'affiche.
//
// Le demarrage a froid n'etait pas garanti avant : le worker ne gardait que les fichiers
// DEJA lus, donc une page chargee en `lazy()` mais jamais ouverte en ligne manquait hors
// ligne, et rien n'assurait que l'index soit en cache apres la premiere visite. Il PRECHARGE
// maintenant toute l'application a l'installation, d'apres `/precache-manifest.json` (genere
// a la construction par `vite-plugin-precache.ts`, voir docs/securite/SERVICE-WORKER-HORS-
// LIGNE.md). Sans cela, la session hors ligne chiffree ne servirait a rien : le coffre
// existerait mais l'application qui l'ouvre ne demarrerait pas.
//
// Les tuiles viennent de `tile.openstreetmap.org` et d'ArcGIS, pas de notre domaine : elles
// ont leur propre cache (voir `sw-policy.js`).
//
// LES DECISIONS SONT AILLEURS, ET C'EST VOULU
//
// Ce que l'on cache, ce que l'on refuse, comment on nomme les caches, quand on purge : tout est
// dans `sw-policy.js`, qui ne contient que des fonctions pures et qui est TESTE. Un worker ne
// s'importe pas depuis un test, donc enfouir ces regles ici les aurait rendues
// inverifiables — et ce sont elles qui comptent. Ce fichier ne contient que les evenements.
//
// CE QU'IL NE FAIT PAS, DELIBEREMENT
//
// Il ne PRECHARGE pas une zone de mission. Le §11 du cahier le demande, et la politique
// d'usage d'OpenStreetMap interdit le telechargement en masse de ses tuiles : un
// prechargement de region la violerait, et ferait bannir l'adresse du serveur. Le cache des
// tuiles se remplit de ce que l'agent a REELLEMENT consulte.
//
// Il ne met JAMAIS en cache une reponse de `/api/` (donnees authentifiees).
//
// Il n'appelle PAS `skipWaiting()` de lui-meme. Une nouvelle version attend que toutes les
// fenetres de l'ancienne soient fermees : sinon une page ouverte, chargee avec l'index et les
// morceaux (chunks) de l'ancien build, verrait l'ancien precache supprime sous ses pieds, et le
// prochain `import()` d'une page demanderait un fichier qui n'existe plus ni en cache ni sur le
// serveur. Le message "activer-maintenant" existe pour qu'une interface, plus tard, le
// declenche a un moment sur (aucune page n'utilise cette voie aujourd'hui).
importScripts("/sw-policy.js");

const P = globalThis.politiqueSw;

// Revision du build, GRAVEE par le plugin de construction dans la copie de ce fichier qui
// part dans `dist/` (voir `vite-plugin-precache.ts`). Elle change des que l'application, la
// politique ou ce fichier changent : c'est elle qui fait detecter la mise a jour par le
// navigateur (un `sw.js` identique octet pour octet n'est jamais reinstalle) et qui nomme le
// precache. Non remplacee (developpement), l'installation echoue au controle de coherence.
const REVISION_BUILD = "__REVISION_BUILD__";

const NOM_PRECACHE = P.nomCachePrecache(REVISION_BUILD);

/**
 * Telecharge UN fichier du precache et le range.
 *
 * `integrity` fait verifier l'empreinte du manifeste par le navigateur lui-meme : un fichier
 * qui ne correspond pas (deploiement a moitie fait, intermediaire qui reecrit) fait echouer
 * le telechargement, donc l'installation. `cache: "no-cache"` force la revalidation aupres du
 * serveur : le cache HTTP ne doit pas nous rendre une version perimee d'un fichier non hache
 * (index, icones, manifeste web).
 */
async function telecharger(cache, entree) {
  const requete = new Request(entree.url, {
    cache: "no-cache",
    integrity: entree.integrite,
    credentials: "same-origin",
  });
  const reponse = await fetch(requete);
  if (!reponse.ok) {
    throw new Error("Precache : HTTP " + reponse.status + " pour " + entree.url);
  }
  // Une reponse issue d'une redirection ne peut pas servir une navigation.
  if (reponse.redirected) {
    throw new Error("Precache : redirection inattendue pour " + entree.url);
  }
  await cache.put(entree.url, reponse);
}

/**
 * Installation ATOMIQUE : tout le precache, ou rien.
 *
 * Si un seul fichier echoue, la promesse est rejetee, l'installation echoue et l'ancien worker
 * reste actif avec son ancien precache complet. Le cache de cette revision, s'il est a moitie
 * rempli, est supprime. Le navigateur retentera a la prochaine verification de `sw.js`.
 */
async function precharger() {
  const reponse = await fetch(P.URL_MANIFESTE, { cache: "no-store" });
  if (!reponse.ok) {
    throw new Error("Manifeste de precache indisponible (HTTP " + reponse.status + ")");
  }
  let manifeste;
  try {
    manifeste = await reponse.json();
  } catch {
    throw new Error("Manifeste de precache illisible");
  }
  const verdict = P.validerManifeste(manifeste, REVISION_BUILD);
  if (!verdict.ok) throw new Error("Precache refuse : " + verdict.raison);

  const existait = await caches.has(NOM_PRECACHE);
  try {
    const cache = await caches.open(NOM_PRECACHE);
    for (const lot of P.decouperEnLots(verdict.entrees, P.CONCURRENCE_PRECACHE)) {
      const issues = await Promise.allSettled(lot.map((entree) => telecharger(cache, entree)));
      const echec = issues.find((i) => i.status === "rejected");
      if (echec) throw echec.reason;
    }
  } catch (erreur) {
    if (!existait) await caches.delete(NOM_PRECACHE);
    throw erreur;
  }
}

self.addEventListener("install", (event) => {
  // Pas de skipWaiting() ici : voir l'en-tete.
  event.waitUntil(precharger());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      // Le precache de CETTE revision, le cache d'execution et les tuiles survivent ; les
      // precaches des revisions anterieures et l'ancien cache d'enveloppe partent.
      .then((noms) => Promise.all(P.cachesAPurger(noms, NOM_PRECACHE).map((n) => caches.delete(n))))
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

function delai(ms) {
  return new Promise((_, rejeter) => setTimeout(() => rejeter(new Error("delai depasse")), ms));
}

/**
 * NAVIGATION : reseau d'abord, repli sur l'INDEX DU PRECACHE.
 *
 * Le reseau d'abord parce qu'une application servie depuis le cache ne se met jamais a jour
 * (comportement conserve de la version precedente). Mais la reponse du reseau n'est PLUS rangee :
 * elle l'etait sous "/", et elle pouvait appartenir a un build plus recent que le precache,
 * dont les morceaux hashes manquent. Hors ligne, la seule page servie est l'index du build
 * precache, coherent avec ses propres fichiers.
 *
 * Le repli sert TOUTE navigation hors `/api/` (application a page unique) : `/geoportail`
 * rechargee sans reseau doit s'ouvrir comme `/`. Les navigations vers `/api/` ne passent pas
 * ici (laissees passer plus haut).
 */
async function repondreNavigation(requete) {
  let reponse = null;
  try {
    reponse = await Promise.race([fetch(requete), delai(P.DELAI_NAVIGATION_MS)]);
    if (P.navigationUtilisable(reponse)) return reponse;
  } catch {
    // Hors ligne, ou reseau trop lent : on retombe sur le precache.
  }
  const options = { cacheName: NOM_PRECACHE };
  const exacte = await caches.match(requete.url, options);
  if (exacte) return exacte;
  const index = await caches.match(P.URL_SHELL, options);
  if (index) return index;
  // Rien en cache (premiere visite, ou precache evince par le navigateur) : on rend ce que le
  // reseau a donne, ou une erreur reseau franche.
  return reponse || Response.error();
}

/**
 * Ressource (script, style, image, donnee) : precache d'abord pour le meme domaine, puis la
 * politique d'avant.
 */
async function repondreRessource(requete, nomCache) {
  const estTuile = nomCache === P.CACHE_TUILES;

  // PRECACHE : les fichiers hashes et les fichiers listes au manifeste sont servis tels
  // quels, sans aller au reseau. Leur contenu est celui du build installe, verifie par
  // empreinte.
  if (!estTuile) {
    const precharge = await caches.match(requete, { cacheName: NOM_PRECACHE });
    if (precharge) return precharge;
  }

  const cache = await caches.match(requete, { cacheName: nomCache });

  // TUILE : le cache d'abord, et on ne va au reseau que s'il n'a rien. Une tuile ne
  // change pas, et la rechercher a chaque fois sur un reseau de terrain coute cher pour
  // rien. Le reste se revalide en arriere-plan.
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
    .catch(() => cache || Response.error());

  return cache || reseau;
}

self.addEventListener("fetch", (event) => {
  const requete = event.request;
  if (P.aLaisserPasser(requete.url, requete.method)) return;

  if (requete.mode === "navigate") {
    event.respondWith(repondreNavigation(requete));
    return;
  }

  const nomCache = P.cachePour(requete.url, self.location.origin);
  if (nomCache === null) return;

  event.respondWith(repondreRessource(requete, nomCache));
});

/**
 * Messages de l'application.
 *
 * "vider-tuiles" : permet de vider les tuiles sans toucher a l'enveloppe. Utile quand l'agent
 * manque de place : il libere la carte, pas l'application, et celle-ci continue de s'ouvrir
 * hors ligne.
 *
 * "activer-maintenant" : saute l'attente d'une nouvelle version. A n'envoyer que depuis une
 * page qui accepte de se recharger aussitot (voir l'en-tete). Non utilise aujourd'hui.
 */
self.addEventListener("message", (event) => {
  if (event.data === "vider-tuiles") {
    event.waitUntil?.(caches.delete(P.CACHE_TUILES));
  } else if (event.data === "activer-maintenant") {
    self.skipWaiting();
  }
});
