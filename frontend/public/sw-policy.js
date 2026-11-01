/**
 * Politique de cache du service worker, isolee pour etre TESTABLE.
 *
 * POURQUOI UN FICHIER A PART
 *
 * `sw.js` s'execute dans un worker : il appelle `self.addEventListener` au chargement, donc
 * il ne s'importe pas depuis un test. Enfouir les decisions dedans les rendait invérifiables,
 * et ce sont precisement elles qui comptent — ce qu'on met en cache, ce qu'on refuse, et
 * quand on evince.
 *
 * Ce fichier ne contient que des fonctions PURES (ni horloge, ni API Cache, ni reseau).
 * `sw.js` le charge par `importScripts`, et les tests l'importent directement. Une seule
 * source de verite, verifiee.
 *
 * Il pose `globalThis.politiqueSw` plutot que d'exporter : `importScripts` ne comprend pas
 * les modules ES.
 *
 * TROIS FAMILLES DE CACHE, ET CHACUNE A SON CYCLE DE VIE
 *
 * 1. Le PRECACHE (`bdri-precache-<revision>`) : l'application entiere (index, JS, CSS, icones,
 *    fond de carte local), telechargee a l'installation d'apres le manifeste genere a la
 *    construction. Un cache par revision de build : jamais deux builds melanges.
 * 2. Le cache d'EXECUTION (`bdri-runtime-v1`) : ce qui est du meme domaine mais absent du
 *    precache. Filet de securite, normalement presque vide.
 * 3. Le cache des TUILES (`bdri-tuiles-v1`) : plafonne, survit aux mises a jour.
 */
(function () {
  /** Prefixe commun a tous les caches de l'application : l'activation ne touche qu'a eux. */
  var PREFIXE_CACHES = "bdri-";

  /**
   * Prefixe des caches de precache. Le nom complet porte la revision du build : changer de
   * build change de cache, et l'ancien reste intact jusqu'a l'activation du nouveau worker.
   */
  var PREFIXE_PRECACHE = "bdri-precache-";

  /**
   * Cache d'execution : ressources du meme domaine absentes du precache (revalidees en
   * arriere-plan). Remplace l'ancien `bdri-shell-v2`, qui servait aussi d'enveloppe : les
   * reponses de navigation n'y sont plus rangees (voir `sw.js`, navigation).
   */
  var CACHE_RUNTIME = "bdri-runtime-v1";

  /**
   * Cache des TUILES de carte, separe de l'enveloppe.
   *
   * POURQUOI SEPARE, ET C'EST LE CHOIX PRINCIPAL DE CE FICHIER
   *
   * Les tuiles sont innombrables : un agent qui deplace la carte en genere des centaines par
   * minute. Dans le meme cache que l'enveloppe, elles finiraient par en provoquer l'eviction
   * par le navigateur, et l'application ne s'ouvrirait plus hors ligne — exactement la
   * fonction qu'on cherche a garantir.
   *
   * Deux caches permettent aussi de vider les tuiles sans toucher a l'enveloppe.
   */
  var CACHE_TUILES = "bdri-tuiles-v1";

  /**
   * Plafond du cache de tuiles, en nombre d'entrees.
   *
   * 600 tuiles de 256 pixels couvrent environ ce qu'un agent parcourt sur une journee de
   * mission a l'echelle d'un troncon, pour de l'ordre de 15 Mo. Sans plafond, le cache
   * grossit jusqu'a ce que le navigateur l'evince en bloc, et l'agent perd tout d'un coup
   * au pire moment.
   *
   * C'est un REGLAGE, pas une norme : il merite d'etre mesure sur un appareil reel.
   */
  var MAX_TUILES = 600;

  /** URL stable du manifeste de precache, genere par `vite-plugin-precache.ts`. */
  var URL_MANIFESTE = "/precache-manifest.json";

  /** La page d'index du build : repli de TOUTE navigation sans reseau (application a page unique). */
  var URL_SHELL = "/index.html";

  /** Version du format du manifeste. Un manifeste d'une autre version est refuse. */
  var VERSION_MANIFESTE = 1;

  /**
   * Combien de temps attendre le reseau pour une NAVIGATION avant de servir l'index du
   * precache, en millisecondes.
   *
   * POURQUOI UN DELAI : hors couverture "franche" (mode avion), l'echec est immediat. Mais
   * sur un reseau de terrain degrade (une barre de signal, un portail captif), la requete
   * peut rester pendante plusieurs dizaines de secondes : l'agent verrait un ecran blanc
   * alors que l'application complete est deja sur le telephone. PROVISOIRE : a mesurer sur
   * le terrain ; trop court, on sert un index un peu ancien (coherent avec ses fichiers) ;
   * trop long, l'agent attend.
   */
  var DELAI_NAVIGATION_MS = 5000;

  /** Telechargements simultanes a l'installation (le reseau de terrain n'aime pas 100 requetes). */
  var CONCURRENCE_PRECACHE = 6;

  /** Hotes de tuiles connus. Une tuile d'ailleurs n'est pas mise en cache. */
  var HOTES_TUILES = [
    "tile.openstreetmap.org",
    "server.arcgisonline.com",
  ];

  /** Fichiers du worker lui-meme et son manifeste : jamais precaches (voir `cheminPrecachable`). */
  var EXCLUS_PRECACHE = ["/sw.js", "/sw-policy.js", "/precache-manifest.json"];

  /** Une revision de build : 16 caracteres hexadecimaux. */
  var RE_REVISION = /^[0-9a-f]{16}$/;

  /** Empreinte SRI d'un fichier : `sha256-` puis 44 caracteres base64 (32 octets). */
  var RE_INTEGRITE = /^sha256-[A-Za-z0-9+\/]{43}=$/;

  /**
   * Alphabet ferme des chemins precaches : lettres, chiffres, point, tilde, tiret, souligne,
   * barre. Pas de `%` (un `/%61pi/` serait decode en `/api/` par le serveur), pas de `?`, pas
   * d'espace. Un fichier au nom exotique fait ECHOUER la construction plutot que d'entrer
   * dans une liste que l'on ne sait plus raisonner.
   */
  var RE_CHEMIN_SUR = /^\/[A-Za-z0-9._~\-\/]+$/;

  /** Garde-fou : un manifeste de plus de 2000 entrees est anormal pour cette application. */
  var MAX_ENTREES = 2000;

  /**
   * Est-ce une tuile de carte ?
   *
   * Reconnue par l'HOTE et non par l'extension : `.png` couvre aussi les icones de
   * l'application, qui appartiennent a l'enveloppe et ne doivent pas etre evincees par le
   * plafond des tuiles.
   */
  function estTuile(url) {
    var u;
    try { u = new URL(url); } catch (e) { return false; }
    for (var i = 0; i < HOTES_TUILES.length; i++) {
      var hote = HOTES_TUILES[i];
      // Suffixe precede d'un point, ou egalite : `a.tile.openstreetmap.org` passe,
      // `faux-tile.openstreetmap.org.exemple.com` non.
      if (u.hostname === hote || u.hostname.endsWith("." + hote)) return true;
    }
    return false;
  }

  /**
   * Le chemin d'une URL tel que le SERVEUR le comprendra, en minuscules.
   *
   * POURQUOI : `new URL(...).pathname` ne decode pas les pourcentages et ne fusionne pas les
   * barres doubles, alors que nginx fait les deux (`merge_slashes`, decodage avant de choisir
   * la `location`). `//api/v2/x` et `/%61pi/v2/x` arrivent donc sur l'API : ne comparer que
   * le chemin brut laisserait passer une reponse authentifiee dans le cache. Les segments `.`
   * et `..` sont deja resolus par `URL`. Retourne `null` si l'URL ou son decodage est illisible
   * (l'appelant traite alors la requete comme sensible).
   */
  function cheminNormalise(url) {
    var u;
    try { u = new URL(url); } catch (e) { return null; }
    var chemin;
    try { chemin = decodeURIComponent(u.pathname); } catch (e2) { return null; }
    return chemin.replace(/\/{2,}/g, "/").toLowerCase();
  }

  /** Ce chemin (normalise) est-il celui de l'API ? */
  function estApi(cheminNorm) {
    return cheminNorm === "/api" || cheminNorm.indexOf("/api/") === 0;
  }

  /**
   * Faut-il laisser passer cette requete sans y toucher ?
   *
   * QUATRE CAS, ET CHACUN A UNE RAISON
   *
   * `/api/` : donnees AUTHENTIFIEES. La file hors ligne vit dans l'application, en IndexedDB.
   * Un service worker qui rejouerait une reponse d'API servirait des donnees perimees sans que
   * personne le sache, et en laisserait une copie en clair dans le stockage du navigateur, hors
   * du coffre chiffre. Le test se fait sur le chemin NORMALISE (voir `cheminNormalise`).
   *
   * Methode autre que GET : rien d'autre ne se met en cache. Mentionne explicitement parce
   * que l'oublier est l'erreur classique.
   *
   * `/sw.js`, `/sw-policy.js` : les mettre en cache empecherait la mise a jour de l'application.
   *
   * `/precache-manifest.json` : il ne decrit que la revision a installer ; le servir depuis un
   * cache ferait installer une revision perimee. Le worker le lit avec `cache: "no-store"`.
   *
   * Le manifeste web (`/manifest.webmanifest`) n'est PLUS laisse passer : il est dans le
   * precache, donc versionne avec le reste. Auparavant il echappait au worker, sans effet hors
   * ligne.
   */
  function aLaisserPasser(url, methode) {
    if (methode !== "GET") return true;
    var chemin = cheminNormalise(url);
    if (chemin === null) return true;
    if (estApi(chemin)) return true;
    if (EXCLUS_PRECACHE.indexOf(chemin) !== -1) return true;
    return false;
  }

  /**
   * Dans quel cache ranger cette requete, ou `null` pour ne rien ranger.
   *
   * Seuls l'origine de l'application et les hotes de tuiles connus sont caches. Une
   * ressource d'un tiers quelconque ne l'est pas : la mettre en cache ferait grossir le
   * stockage avec ce dont le terrain n'a pas besoin.
   *
   * Pour le meme domaine, c'est le cache d'EXECUTION ; le precache est consulte avant, par
   * le worker, avec son propre nom (il porte la revision).
   */
  function cachePour(url, origine) {
    if (estTuile(url)) return CACHE_TUILES;
    var u;
    try { u = new URL(url); } catch (e) { return null; }
    if (u.origin === origine) return CACHE_RUNTIME;
    return null;
  }

  /**
   * Cette reponse est-elle digne d'etre mise en cache ?
   *
   * LE PIEGE DES REPONSES OPAQUES
   *
   * Une tuile vient d'un autre domaine sans CORS : la reponse est `opaque`, son `status` vaut
   * 0 et `ok` vaut false. Le controle `if (res.ok)` du service worker d'origine aurait donc
   * REFUSE toutes les tuiles, et le cache serait reste vide sans qu'aucune erreur n'apparaisse.
   *
   * On accepte donc une reponse opaque — on ne peut pas savoir si elle vaut 200 ou 404, et
   * une tuile manquante affichee en gris est moins grave qu'une carte absente.
   */
  function aMettreEnCache(reponse) {
    if (!reponse) return false;
    if (reponse.type === "opaque" || reponse.type === "opaqueredirect") return true;
    return reponse.ok === true;
  }

  /**
   * Quelles entrees evincer pour revenir sous le plafond ?
   *
   * Rend les plus ANCIENNEMENT INSEREES. L'API Cache ne porte aucun horodatage, et `keys()`
   * rend les entrees dans leur ordre d'insertion : l'eviction est donc du premier entre,
   * premier sorti, et NON du moins recemment utilise.
   *
   * La difference compte et il faut la dire : une tuile consultee cent fois sera evincee
   * avant une tuile vue une seule fois plus tard. Pour un agent qui avance le long d'une
   * route, l'ordre d'insertion suit a peu pres son trajet, donc le compromis tient. Pour
   * quelqu'un qui reviendrait sans cesse au meme carrefour, il serait mauvais.
   */
  function aEvincer(clefs, plafond) {
    if (!clefs || clefs.length <= plafond) return [];
    return clefs.slice(0, clefs.length - plafond);
  }

  // ------------------------------------------------------------------------------------
  // PRECACHE
  // ------------------------------------------------------------------------------------

  /** Nom du cache de precache d'une revision de build. */
  function nomCachePrecache(revision) {
    return PREFIXE_PRECACHE + revision;
  }

  /**
   * Ce chemin peut-il figurer dans le precache ?
   *
   * LA GARANTIE CENTRALE : aucune URL d'API n'entre jamais dans le precache, quelle que soit
   * la facon dont le manifeste a ete produit ou alteree. Le controle se fait deux fois, ici a
   * la lecture du manifeste (`validerManifeste`) et dans le plugin de construction, avec ce
   * meme alphabet ferme. Un manifeste qui contient une entree refusee est refuse EN ENTIER :
   * mieux vaut une installation qui echoue (l'ancien worker reste) qu'un precache partiel.
   */
  function cheminPrecachable(chemin) {
    if (typeof chemin !== "string") return false;
    if (!RE_CHEMIN_SUR.test(chemin)) return false;
    if (chemin.indexOf("//") !== -1 || chemin.indexOf("..") !== -1) return false;
    // Un segment "." (/./api/x) designe le meme fichier que sans lui : refuse, comme "..".
    if (chemin.indexOf("/./") !== -1 || chemin.slice(-2) === "/.") return false;
    if (chemin.charAt(chemin.length - 1) === "/") return false;
    if (/\.map$/i.test(chemin)) return false;
    if (estApi(chemin.toLowerCase())) return false;
    if (EXCLUS_PRECACHE.indexOf(chemin) !== -1) return false;
    return true;
  }

  /**
   * Valide le manifeste lu sur le reseau et rend la liste des entrees a telecharger.
   *
   * ATOMICITE : toute anomalie (version, revision, doublon, chemin refuse, empreinte absente,
   * index absent) refuse le manifeste ENTIER. `revisionWorker` est la revision gravee dans
   * `sw.js` par le plugin : si elle differe de celle du manifeste, le worker et le manifeste
   * viennent de deux deploiements differents (deploiement en cours, cache intermediaire) et
   * installer melangerait deux builds.
   *
   * @returns {{ok: true, entrees: Array<{url: string, integrite: string}>} | {ok: false, raison: string}}
   */
  function validerManifeste(manifeste, revisionWorker) {
    function refus(raison) { return { ok: false, raison: raison }; }
    if (!manifeste || typeof manifeste !== "object") return refus("manifeste illisible");
    if (manifeste.version !== VERSION_MANIFESTE) return refus("version de manifeste inconnue");
    if (typeof manifeste.revision !== "string" || !RE_REVISION.test(manifeste.revision)) {
      return refus("revision absente ou mal formee");
    }
    if (manifeste.revision !== revisionWorker) {
      return refus("revision du manifeste (" + manifeste.revision + ") differente de celle du worker ("
        + revisionWorker + ") : deploiement incoherent");
    }
    var entrees = manifeste.entrees;
    if (!Array.isArray(entrees) || entrees.length === 0) return refus("aucune entree");
    if (entrees.length > MAX_ENTREES) return refus("trop d'entrees");

    var vus = {};
    var propres = [];
    for (var i = 0; i < entrees.length; i++) {
      var e = entrees[i];
      if (!e || typeof e !== "object") return refus("entree " + i + " illisible");
      if (!cheminPrecachable(e.url)) return refus("chemin refuse : " + String(e.url));
      if (typeof e.integrite !== "string" || !RE_INTEGRITE.test(e.integrite)) {
        return refus("empreinte absente ou mal formee : " + e.url);
      }
      if (vus[e.url]) return refus("doublon : " + e.url);
      vus[e.url] = true;
      propres.push({ url: e.url, integrite: e.integrite });
    }
    if (!vus[URL_SHELL]) return refus("l'index (" + URL_SHELL + ") manque au manifeste");
    return { ok: true, entrees: propres };
  }

  /**
   * Quels caches supprimer a l'activation ?
   *
   * Tous les caches de l'application (prefixe `bdri-`) SAUF le precache de CETTE revision, le
   * cache d'execution et celui des tuiles : les anciennes revisions et l'ancien
   * `bdri-shell-v2` partent, les tuiles (donnees d'un agent sur le terrain) restent. Un cache
   * sans le prefixe n'est pas a nous et n'est pas touche.
   */
  function cachesAPurger(noms, precacheCourant) {
    var gardes = [precacheCourant, CACHE_RUNTIME, CACHE_TUILES];
    var partants = [];
    for (var i = 0; i < noms.length; i++) {
      var n = noms[i];
      if (n.indexOf(PREFIXE_CACHES) === 0 && gardes.indexOf(n) === -1) partants.push(n);
    }
    return partants;
  }

  /**
   * La reponse du reseau a une NAVIGATION est-elle utilisable ?
   *
   * Un echec de passerelle (502, 503, 504 quand le conteneur du frontend est arrete ou que
   * le proxy ne joint pas l'amont) n'est pas une page : l'afficher a la place de
   * l'application deja installee serait absurde. Une redirection non suivie
   * (`opaqueredirect`) est utilisable : le navigateur la suit lui-meme.
   */
  function navigationUtilisable(reponse) {
    if (!reponse) return false;
    if (reponse.type === "opaqueredirect") return true;
    return typeof reponse.status === "number" && reponse.status > 0 && reponse.status < 500;
  }

  /** Decoupe une liste en lots de `taille` elements (installation par vagues). */
  function decouperEnLots(liste, taille) {
    var lots = [];
    var t = taille > 0 ? Math.floor(taille) : 1;
    for (var i = 0; i < liste.length; i += t) lots.push(liste.slice(i, i + t));
    return lots;
  }

  globalThis.politiqueSw = {
    PREFIXE_PRECACHE: PREFIXE_PRECACHE,
    CACHE_RUNTIME: CACHE_RUNTIME,
    CACHE_TUILES: CACHE_TUILES,
    MAX_TUILES: MAX_TUILES,
    URL_MANIFESTE: URL_MANIFESTE,
    URL_SHELL: URL_SHELL,
    VERSION_MANIFESTE: VERSION_MANIFESTE,
    DELAI_NAVIGATION_MS: DELAI_NAVIGATION_MS,
    CONCURRENCE_PRECACHE: CONCURRENCE_PRECACHE,
    HOTES_TUILES: HOTES_TUILES,
    EXCLUS_PRECACHE: EXCLUS_PRECACHE,
    estTuile: estTuile,
    aLaisserPasser: aLaisserPasser,
    cachePour: cachePour,
    aMettreEnCache: aMettreEnCache,
    aEvincer: aEvincer,
    cheminNormalise: cheminNormalise,
    nomCachePrecache: nomCachePrecache,
    cheminPrecachable: cheminPrecachable,
    validerManifeste: validerManifeste,
    cachesAPurger: cachesAPurger,
    navigationUtilisable: navigationUtilisable,
    decouperEnLots: decouperEnLots,
  };
})();
