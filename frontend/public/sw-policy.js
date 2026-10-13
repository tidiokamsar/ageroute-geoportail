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
 * Ce fichier ne contient que des fonctions PURES. `sw.js` le charge par `importScripts`, et
 * les tests l'importent directement. Une seule source de verite, verifiee.
 *
 * Il pose `globalThis.politiqueSw` plutot que d'exporter : `importScripts` ne comprend pas
 * les modules ES.
 */
(function () {
  /** Cache de l'enveloppe applicative : HTML, JS, CSS, fond de carte local. */
  var CACHE_SHELL = "bdri-shell-v2";

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

  /** Hotes de tuiles connus. Une tuile d'ailleurs n'est pas mise en cache. */
  var HOTES_TUILES = [
    "tile.openstreetmap.org",
    "server.arcgisonline.com",
  ];

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
   * Faut-il laisser passer cette requete sans y toucher ?
   *
   * TROIS CAS, ET CHACUN A UNE RAISON
   *
   * `/api/` : la file hors ligne vit dans l'application, en IndexedDB. Un service worker qui
   * rejouerait une reponse d'API servirait des donnees perimees sans que personne le sache,
   * et un POST mis en cache serait une catastrophe silencieuse.
   *
   * Methode autre que GET : rien d'autre ne se met en cache. Mentionne explicitement parce
   * que l'oublier est l'erreur classique.
   *
   * `/sw` et le manifeste : les mettre en cache empecherait la mise a jour de l'application.
   */
  function aLaisserPasser(url, methode) {
    if (methode !== "GET") return true;
    var u;
    try { u = new URL(url); } catch (e) { return true; }
    if (u.pathname.indexOf("/api/") === 0) return true;
    if (u.pathname === "/sw.js" || u.pathname === "/sw-policy.js") return true;
    if (u.pathname === "/manifest.webmanifest") return true;
    return false;
  }

  /**
   * Dans quel cache ranger cette requete, ou `null` pour ne rien ranger.
   *
   * Seuls l'origine de l'application et les hotes de tuiles connus sont caches. Une
   * ressource d'un tiers quelconque ne l'est pas : la mettre en cache ferait grossir le
   * stockage avec ce dont le terrain n'a pas besoin.
   */
  function cachePour(url, origine) {
    if (estTuile(url)) return CACHE_TUILES;
    var u;
    try { u = new URL(url); } catch (e) { return null; }
    if (u.origin === origine) return CACHE_SHELL;
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

  globalThis.politiqueSw = {
    CACHE_SHELL: CACHE_SHELL,
    CACHE_TUILES: CACHE_TUILES,
    MAX_TUILES: MAX_TUILES,
    HOTES_TUILES: HOTES_TUILES,
    estTuile: estTuile,
    aLaisserPasser: aLaisserPasser,
    cachePour: cachePour,
    aMettreEnCache: aMettreEnCache,
    aEvincer: aEvincer,
  };
})();
