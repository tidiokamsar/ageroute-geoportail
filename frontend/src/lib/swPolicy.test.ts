import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { precachePlugin } from "../../vite-plugin-precache";

/**
 * La politique de cache du service worker : ce que ces tests défendent.
 *
 * LE SERVICE WORKER EST LE SEUL CODE QUI NE PRÉVIENT PAS QUAND IL SE TROMPE
 *
 * Une erreur ici ne lève rien : elle se manifeste des semaines plus tard, sur un téléphone
 * hors couverture, par une carte grise ou une application qui ne s'ouvre plus. D'où ce
 * fichier de politique séparé, importable et testé.
 *
 * TROIS PIÈGES, ET LES TROIS ÉTAIENT PRÉSENTS DANS LA VERSION D'ORIGINE
 *
 * **Les réponses opaques.** Une tuile vient d'un autre domaine sans CORS : son `status` vaut
 * 0 et `ok` vaut `false`. Le contrôle `if (res.ok)` d'origine aurait donc refusé TOUTES les
 * tuiles, et le cache serait resté vide sans qu'aucune erreur n'apparaisse.
 *
 * **Le cache unique.** Des centaines de tuiles dans le cache de l'enveloppe finissent par en
 * provoquer l'éviction par le navigateur, et l'application ne s'ouvre plus hors ligne —
 * exactement la fonction qu'on cherchait à garantir.
 *
 * **L'absence de plafond.** Un cache qui grossit sans fin est évincé en bloc par le
 * navigateur, et l'agent perd tout d'un coup, au pire moment.
 */

/**
 * La forme attendue de la politique.
 *
 * Decrite ici plutot que globalement : si `sw-policy.js` cessait d'exposer l'une de ces
 * fonctions, c'est ce fichier qui doit casser, pas une declaration lointaine.
 */
interface EntreeManifeste { url: string; integrite: string }
type VerdictManifeste =
  | { ok: true; entrees: EntreeManifeste[] }
  | { ok: false; raison: string };

interface PolitiqueSw {
  PREFIXE_PRECACHE: string;
  CACHE_RUNTIME: string;
  CACHE_TUILES: string;
  MAX_TUILES: number;
  URL_MANIFESTE: string;
  URL_SHELL: string;
  VERSION_MANIFESTE: number;
  DELAI_NAVIGATION_MS: number;
  CONCURRENCE_PRECACHE: number;
  EXCLUS_PRECACHE: string[];
  estTuile(url: string): boolean;
  aLaisserPasser(url: string, methode: string): boolean;
  cachePour(url: string, origine: string): string | null;
  aMettreEnCache(reponse: { type?: string; ok?: boolean } | null): boolean;
  aEvincer<T>(clefs: T[], plafond: number): T[];
  cheminNormalise(url: string): string | null;
  nomCachePrecache(revision: string): string;
  cheminPrecachable(chemin: unknown): boolean;
  validerManifeste(manifeste: unknown, revisionWorker: string): VerdictManifeste;
  cachesAPurger(noms: string[], precacheCourant: string): string[];
  navigationUtilisable(reponse: { type?: string; status?: number } | null): boolean;
  decouperEnLots<T>(liste: T[], taille: number): T[][];
}

let P: PolitiqueSw;

beforeAll(async () => {
  // Le fichier de politique est un script classique qui pose `globalThis.politiqueSw` :
  // `importScripts` ne comprend pas les modules ES, donc il ne peut pas exporter.
  await import("../../public/sw-policy.js");
  P = (globalThis as unknown as { politiqueSw: PolitiqueSw }).politiqueSw;
});

const ORIGINE = "https://carte.ageroute.gov.gn";

describe("Reconnaître une tuile", () => {
  it("reconnaît les hôtes de tuiles, sous-domaines compris", () => {
    expect(P.estTuile("https://a.tile.openstreetmap.org/12/2048/1024.png")).toBe(true);
    expect(P.estTuile("https://tile.openstreetmap.org/12/2048/1024.png")).toBe(true);
    expect(P.estTuile("https://server.arcgisonline.com/ArcGIS/rest/.../12/1024/2048")).toBe(true);
  });

  it("ne se laisse PAS tromper par un hôte qui contient le nom", () => {
    // `faux-tile.openstreetmap.org.exemple.com` ne doit pas passer : sans l'ancrage sur un
    // point, n'importe quel domaine pourrait se faire mettre en cache sans limite.
    expect(P.estTuile("https://tile.openstreetmap.org.exemple.com/1/2/3.png")).toBe(false);
    expect(P.estTuile("https://fauxtile.openstreetmap.org.mechant.net/1/2/3.png")).toBe(false);
  });

  it("reconnaît par l'HÔTE et non par l'extension", () => {
    // `.png` couvre aussi les icônes de l'application : les ranger dans le cache des tuiles
    // les ferait évincer par le plafond, et l'application perdrait ses icônes hors ligne.
    expect(P.estTuile(`${ORIGINE}/icones/logo.png`)).toBe(false);
  });

  it("ne lève pas sur une URL illisible", () => {
    expect(P.estTuile("pas-une-url")).toBe(false);
  });
});

describe("Ce qui doit passer sans être touché", () => {
  it("laisse passer TOUS les appels /api/", () => {
    // La file hors ligne vit dans l'application, en IndexedDB. Un worker qui rejouerait une
    // réponse d'API servirait des données périmées sans que personne le sache.
    expect(P.aLaisserPasser(`${ORIGINE}/api/v2/portions`, "GET")).toBe(true);
    expect(P.aLaisserPasser(`${ORIGINE}/api/v2/field/current-context?lat=9.5`, "GET")).toBe(true);
  });

  it("laisse passer tout ce qui n'est pas un GET", () => {
    // Un POST mis en cache serait une catastrophe silencieuse.
    expect(P.aLaisserPasser(`${ORIGINE}/quoi-que-ce-soit`, "POST")).toBe(true);
    expect(P.aLaisserPasser(`${ORIGINE}/quoi-que-ce-soit`, "DELETE")).toBe(true);
  });

  it("laisse passer le worker et le manifeste de précache", () => {
    // Les mettre en cache empêcherait la mise à jour de l'application : le manifeste dit QUELLE
    // révision installer, le servir depuis un cache ferait installer une révision périmée.
    expect(P.aLaisserPasser(`${ORIGINE}/sw.js`, "GET")).toBe(true);
    expect(P.aLaisserPasser(`${ORIGINE}/sw-policy.js`, "GET")).toBe(true);
    expect(P.aLaisserPasser(`${ORIGINE}/precache-manifest.json`, "GET")).toBe(true);
  });

  it("ne laisse plus passer le manifeste web : il est dans le précache, versionné", () => {
    expect(P.aLaisserPasser(`${ORIGINE}/manifest.webmanifest`, "GET")).toBe(false);
  });

  it("n'écarte PAS le fond de carte local, qui doit être disponible hors ligne", () => {
    // `osm-routes.geojson` fait environ 2 Mo et porte le réseau : sans lui, la carte
    // s'affiche sans routes.
    expect(P.aLaisserPasser(`${ORIGINE}/osm-routes.geojson`, "GET")).toBe(false);
  });
});

describe("Deux caches, et pas un seul", () => {
  it("range les tuiles à part de l'enveloppe", () => {
    // Le choix principal de ce fichier : des centaines de tuiles dans le cache de
    // l'enveloppe la feraient évincer, et l'application ne s'ouvrirait plus hors ligne.
    expect(P.cachePour("https://a.tile.openstreetmap.org/12/2048/1024.png", ORIGINE))
      .toBe(P.CACHE_TUILES);
    expect(P.cachePour(`${ORIGINE}/assets/index-abc.js`, ORIGINE)).toBe(P.CACHE_RUNTIME);
    expect(P.CACHE_TUILES).not.toBe(P.CACHE_RUNTIME);
    // Le précache porte la révision dans son nom : il n'est jamais confondu avec les deux autres.
    expect(P.nomCachePrecache("0123456789abcdef")).not.toBe(P.CACHE_RUNTIME);
    expect(P.nomCachePrecache("0123456789abcdef")).not.toBe(P.CACHE_TUILES);
  });

  it("ne met en cache AUCUN tiers inconnu", () => {
    // Faire grossir le stockage d'un téléphone de terrain avec ce dont il n'a pas besoin.
    expect(P.cachePour("https://un-tiers-quelconque.example/script.js", ORIGINE)).toBeNull();
  });
});

describe("Le piège des réponses opaques", () => {
  it("ACCEPTE une réponse opaque, sinon aucune tuile ne serait jamais mise en cache", () => {
    // Le piège qui aurait vidé le cache en silence : une tuile transfrontalière sans CORS a
    // `status: 0` et `ok: false`. Un `if (res.ok)` les aurait toutes refusées.
    expect(P.aMettreEnCache({ type: "opaque", ok: false })).toBe(true);
    expect(P.aMettreEnCache({ type: "opaqueredirect", ok: false })).toBe(true);
  });

  it("accepte une réponse normale qui a réussi", () => {
    expect(P.aMettreEnCache({ type: "basic", ok: true })).toBe(true);
  });

  it("REFUSE une réponse normale en échec", () => {
    // Mettre un 404 en cache le servirait ensuite indéfiniment.
    expect(P.aMettreEnCache({ type: "basic", ok: false })).toBe(false);
    expect(P.aMettreEnCache(null)).toBe(false);
  });
});

describe("Le plafond des tuiles", () => {
  it("n'évince RIEN sous le plafond", () => {
    expect(P.aEvincer(["a", "b", "c"], 600)).toEqual([]);
    expect(P.aEvincer(Array.from({ length: 600 }, (_, i) => i), 600)).toEqual([]);
  });

  it("évince juste ce qu'il faut pour revenir au plafond", () => {
    const clefs = Array.from({ length: 605 }, (_, i) => i);
    const partantes = P.aEvincer(clefs, 600);
    expect(partantes).toHaveLength(5);
    // Les PREMIÈRES INSÉRÉES : l'API Cache ne porte aucun horodatage, et `keys()` rend les
    // entrées dans leur ordre d'insertion. C'est du premier entré, premier sorti, et NON du
    // moins récemment utilisé — la différence est documentée dans la politique.
    expect(partantes).toEqual([0, 1, 2, 3, 4]);
  });

  it("supporte une liste vide", () => {
    expect(P.aEvincer([], 600)).toEqual([]);
  });

  it("porte un plafond, quelle qu'en soit la valeur", () => {
    // Sans plafond, le navigateur évince le cache en bloc et l'agent perd tout d'un coup.
    expect(P.MAX_TUILES).toBeGreaterThan(0);
    expect(Number.isFinite(P.MAX_TUILES)).toBe(true);
  });
});

describe("Ne JAMAIS mettre en cache l'API (données authentifiées)", () => {
  // Le worker ne répond à une requête que si `aLaisserPasser` rend false, et ne range que ce que
  // `cachePour` désigne. Ces tests couvrent toutes les écritures d'un chemin d'API qu'un serveur
  // nginx (barres fusionnées, pourcentages décodés) enverrait à l'API.
  const CHEMINS_API = [
    "/api/v2/portions",
    "/api/v2/auth/me?x=1",
    "/api",
    "/api/",
    "//api/v2/portions",
    "///api/v2/portions",
    "/%61pi/v2/portions",
    "/%61%70%69/v2/portions",
    "/API/v2/portions",
    "/portions/../api/v2/portions",
    "/./api/v2/portions",
  ];

  it.each(CHEMINS_API)("laisse passer %s, en GET", (chemin) => {
    expect(P.aLaisserPasser(`${ORIGINE}${chemin}`, "GET")).toBe(true);
  });

  it.each(CHEMINS_API)("laisse passer %s, quelle que soit la méthode", (chemin) => {
    for (const methode of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
      expect(P.aLaisserPasser(`${ORIGINE}${chemin}`, methode)).toBe(true);
    }
  });

  it("laisse passer une URL dont le décodage est illisible, par prudence", () => {
    expect(P.aLaisserPasser(`${ORIGINE}/%E0%A4%A`, "GET")).toBe(true);
  });

  it("ne confond pas l'API avec un chemin qui commence par les mêmes lettres", () => {
    // Sinon la page `/apiculture` (si elle existait) ne serait jamais servie hors ligne.
    expect(P.aLaisserPasser(`${ORIGINE}/apiculture`, "GET")).toBe(false);
    expect(P.aLaisserPasser(`${ORIGINE}/assets/api-client-abc.js`, "GET")).toBe(false);
  });

  it("refuse toute entrée d'API dans un précache, sous toutes ses formes", () => {
    for (const chemin of CHEMINS_API) {
      expect(P.cheminPrecachable(chemin), chemin).toBe(false);
    }
  });

  it("refuse un manifeste ENTIER dès qu'il contient une entrée d'API", () => {
    const m = manifesteValide();
    m.entrees.push({ url: "/api/v2/portions", integrite: INTEGRITE });
    const verdict = P.validerManifeste(m, REVISION);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.raison).toContain("/api/v2/portions");
  });
});

// Une empreinte SRI bien formée (32 octets en base64) et une révision bien formée.
const INTEGRITE = "sha256-" + Buffer.alloc(32, 7).toString("base64");
const REVISION = "0123456789abcdef";

function manifesteValide(): { version: number; revision: string; entrees: EntreeManifeste[] } {
  return {
    version: 1,
    revision: REVISION,
    entrees: [
      { url: "/index.html", integrite: INTEGRITE },
      { url: "/assets/index-abc123.js", integrite: INTEGRITE },
      { url: "/assets/ProgrammationPage-d4e5f6.js", integrite: INTEGRITE },
      { url: "/assets/index-abc123.css", integrite: INTEGRITE },
      { url: "/icons/icon-192.png", integrite: INTEGRITE },
      { url: "/manifest.webmanifest", integrite: INTEGRITE },
      { url: "/osm-routes.geojson", integrite: INTEGRITE },
    ],
  };
}

describe("Ce qui peut entrer dans le précache", () => {
  it("accepte les fichiers de l'application", () => {
    for (const chemin of [
      "/index.html", "/assets/index-D1qFbNRm.js", "/assets/maps-3yaWYNWa.css",
      "/icons/icon-512-maskable.png", "/manifest.webmanifest", "/osm-routes.geojson",
      "/data/ponts-osm.geojson", "/favicon.ico", "/ageroute-logo.svg",
    ]) {
      expect(P.cheminPrecachable(chemin), chemin).toBe(true);
    }
  });

  it("refuse le worker, sa politique et le manifeste lui-même", () => {
    // Un worker qui se précacherait lui-même ne se mettrait plus à jour.
    for (const chemin of P.EXCLUS_PRECACHE) expect(P.cheminPrecachable(chemin), chemin).toBe(false);
    expect(P.EXCLUS_PRECACHE).toEqual(["/sw.js", "/sw-policy.js", "/precache-manifest.json"]);
  });

  it("refuse tout ce qui sort de l'alphabet fermé", () => {
    for (const chemin of [
      "assets/a.js", "//evil.example/a.js", "https://evil.example/a.js", "/a b.js", "/a%20b.js",
      "/a?x=1", "/a#x", "/../etc/passwd", "/assets/../index.html", "/assets/", "/", "",
      "/assets/index.js.map", "/é.js", "/a\\b.js",
    ]) {
      expect(P.cheminPrecachable(chemin), chemin).toBe(false);
    }
    expect(P.cheminPrecachable(undefined)).toBe(false);
    expect(P.cheminPrecachable(42)).toBe(false);
  });
});

describe("Valider le manifeste de précache", () => {
  it("accepte un manifeste cohérent avec le worker et rend ses entrées", () => {
    const verdict = P.validerManifeste(manifesteValide(), REVISION);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.entrees).toHaveLength(7);
      // Y compris les morceaux chargés à la demande, jamais ouverts en ligne.
      expect(verdict.entrees.map((e) => e.url)).toContain("/assets/ProgrammationPage-d4e5f6.js");
    }
  });

  it("refuse une révision différente de celle gravée dans le worker", () => {
    // Deux déploiements mélangés : le worker de l'un, le manifeste de l'autre.
    const verdict = P.validerManifeste(manifesteValide(), "fedcba9876543210");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.raison).toContain("incoherent");
  });

  it("refuse le worker de développement, dont la révision n'a pas été gravée", () => {
    expect(P.validerManifeste(manifesteValide(), "__REVISION_BUILD__").ok).toBe(false);
  });

  it("refuse tout ce qui n'est pas un manifeste lisible", () => {
    for (const mauvais of [null, undefined, "x", 3, [], {}, { version: 1 }]) {
      expect(P.validerManifeste(mauvais, REVISION).ok, JSON.stringify(mauvais)).toBe(false);
    }
  });

  it("refuse une autre version de format", () => {
    expect(P.validerManifeste({ ...manifesteValide(), version: 2 }, REVISION).ok).toBe(false);
  });

  it("refuse une révision mal formée", () => {
    expect(P.validerManifeste({ ...manifesteValide(), revision: "ABC" }, "ABC").ok).toBe(false);
  });

  it("refuse une liste vide", () => {
    expect(P.validerManifeste({ ...manifesteValide(), entrees: [] }, REVISION).ok).toBe(false);
  });

  it("refuse un manifeste sans index : il n'y aurait rien à servir hors ligne", () => {
    const m = manifesteValide();
    m.entrees = m.entrees.filter((e) => e.url !== P.URL_SHELL);
    expect(P.validerManifeste(m, REVISION).ok).toBe(false);
  });

  it("refuse un doublon", () => {
    const m = manifesteValide();
    m.entrees.push({ ...m.entrees[1] });
    expect(P.validerManifeste(m, REVISION).ok).toBe(false);
  });

  it("refuse une entrée sans empreinte valable", () => {
    for (const integrite of [undefined, "", "sha256-court", "md5-" + "A".repeat(22) + "==", 12]) {
      const m = manifesteValide();
      m.entrees[1] = { url: "/assets/x.js", integrite: integrite as unknown as string };
      expect(P.validerManifeste(m, REVISION).ok, String(integrite)).toBe(false);
    }
  });

  it("refuse un manifeste démesuré", () => {
    const m = manifesteValide();
    for (let i = 0; i < 2001; i++) m.entrees.push({ url: `/assets/f${i}.js`, integrite: INTEGRITE });
    expect(P.validerManifeste(m, REVISION).ok).toBe(false);
  });

  it("ne rend que l'URL et l'empreinte, rien d'autre venu du réseau", () => {
    const m = manifesteValide();
    (m.entrees[1] as unknown as Record<string, unknown>).extra = "<script>";
    const verdict = P.validerManifeste(m, REVISION);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(Object.keys(verdict.entrees[1]).sort()).toEqual(["integrite", "url"]);
  });
});

describe("Nommer et purger les caches", () => {
  it("nomme le précache d'après la révision du build", () => {
    expect(P.nomCachePrecache(REVISION)).toBe(`${P.PREFIXE_PRECACHE}${REVISION}`);
    expect(P.nomCachePrecache("aaaaaaaaaaaaaaaa")).not.toBe(P.nomCachePrecache(REVISION));
  });

  it("purge les anciennes révisions et l'ancienne enveloppe, garde le courant, l'exécution et les tuiles", () => {
    const courant = P.nomCachePrecache(REVISION);
    const noms = [
      courant,
      P.nomCachePrecache("aaaaaaaaaaaaaaaa"), // révision précédente
      "bdri-shell-v2", // ancienne enveloppe, avec l'index mis en cache sous "/"
      P.CACHE_RUNTIME,
      P.CACHE_TUILES,
    ];
    expect(P.cachesAPurger(noms, courant)).toEqual([P.nomCachePrecache("aaaaaaaaaaaaaaaa"), "bdri-shell-v2"]);
  });

  it("ne touche JAMAIS aux tuiles : ce sont des données de terrain", () => {
    expect(P.cachesAPurger([P.CACHE_TUILES], P.nomCachePrecache(REVISION))).toEqual([]);
  });

  it("ne touche pas à un cache qui n'est pas celui de l'application", () => {
    expect(P.cachesAPurger(["workbox-precache-v2", "autre"], P.nomCachePrecache(REVISION))).toEqual([]);
  });

  it("supprime tous les précaches anciens si le courant n'existe pas encore", () => {
    expect(P.cachesAPurger([P.nomCachePrecache("aaaaaaaaaaaaaaaa")], P.nomCachePrecache(REVISION)))
      .toEqual([P.nomCachePrecache("aaaaaaaaaaaaaaaa")]);
  });
});

describe("Navigation sans réseau", () => {
  it("juge utilisable une réponse normale, une redirection non suivie, un 404 de l'application", () => {
    expect(P.navigationUtilisable({ type: "basic", status: 200 })).toBe(true);
    expect(P.navigationUtilisable({ type: "basic", status: 404 })).toBe(true);
    expect(P.navigationUtilisable({ type: "opaqueredirect", status: 0 })).toBe(true);
  });

  it("juge inutilisable un échec de passerelle ou une absence de réponse", () => {
    // Un 502 de Traefik quand le conteneur du frontend est arrêté n'est pas une page.
    for (const status of [500, 502, 503, 504]) {
      expect(P.navigationUtilisable({ type: "basic", status }), String(status)).toBe(false);
    }
    expect(P.navigationUtilisable({ type: "error", status: 0 })).toBe(false);
    expect(P.navigationUtilisable(null)).toBe(false);
  });

  it("porte un délai fini et une page de repli unique", () => {
    expect(P.DELAI_NAVIGATION_MS).toBeGreaterThan(0);
    expect(Number.isFinite(P.DELAI_NAVIGATION_MS)).toBe(true);
    expect(P.URL_SHELL).toBe("/index.html");
    expect(P.URL_MANIFESTE).toBe("/precache-manifest.json");
  });

  it("normalise un chemin comme le serveur le fera", () => {
    expect(P.cheminNormalise(`${ORIGINE}//Api/V2/x?y=1`)).toBe("/api/v2/x");
    expect(P.cheminNormalise(`${ORIGINE}/%61pi`)).toBe("/api");
    expect(P.cheminNormalise("pas-une-url")).toBeNull();
  });
});

describe("Découper l'installation en vagues", () => {
  it("découpe sans perdre ni répéter", () => {
    const liste = Array.from({ length: 14 }, (_, i) => i);
    const lots = P.decouperEnLots(liste, 6);
    expect(lots.map((l) => l.length)).toEqual([6, 6, 2]);
    expect(lots.flat()).toEqual(liste);
  });

  it("supporte une liste vide et une taille absurde", () => {
    expect(P.decouperEnLots([], 6)).toEqual([]);
    expect(P.decouperEnLots([1, 2, 3], 0)).toEqual([[1], [2], [3]]);
    expect(P.CONCURRENCE_PRECACHE).toBeGreaterThan(0);
  });
});

describe("Le fichier sw.js respecte le contrat avec le plugin et la politique", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../public/sw.js"), "utf8");
  const LIGNE = 'const REVISION_BUILD = "__REVISION_BUILD__";';

  it("porte l'emplacement de la révision exactement une fois", () => {
    // Le plugin échoue la construction sinon : ce test l'attrape avant.
    expect(source.split(LIGNE)).toHaveLength(2);
  });

  it("n'appelle pas skipWaiting à l'installation", () => {
    // Un skipWaiting brutal remplacerait le code d'une page ouverte (voir l'en-tête de sw.js).
    const debut = source.indexOf('addEventListener("install"');
    const fin = source.indexOf("addEventListener(", debut + 10);
    expect(debut).toBeGreaterThan(-1);
    // Commentaires retires : l'en-tête du gestionnaire explique justement pourquoi il n'y en a pas.
    const code = source.slice(debut, fin).replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("skipWaiting");
  });

  it("ne range pas la réponse d'une navigation", () => {
    // L'ancienne version rangeait l'index du réseau sous "/" : il pouvait venir d'un autre build.
    const debut = source.indexOf("async function repondreNavigation");
    const fin = source.indexOf("async function repondreRessource");
    expect(debut).toBeGreaterThan(-1);
    expect(source.slice(debut, fin)).not.toMatch(/\.put\(/);
  });

  it("charge la politique et délègue ses décisions", () => {
    expect(source).toContain('importScripts("/sw-policy.js")');
    for (const fonction of ["aLaisserPasser", "validerManifeste", "cachesAPurger", "navigationUtilisable"]) {
      expect(source, fonction).toContain(`P.${fonction}(`);
    }
  });
});

describe("Le plugin de construction du manifeste", () => {
  const dossiers: string[] = [];
  const publicDir = path.resolve(__dirname, "../../public");

  afterEach(() => {
    while (dossiers.length) fs.rmSync(dossiers.pop()!, { recursive: true, force: true });
  });

  /** Un faux `dist/` : les vrais sw.js et sw-policy.js, quelques fichiers d'application. */
  function fauxDist(modif: (dist: string) => void = () => {}): string {
    const racine = fs.mkdtempSync(path.join(os.tmpdir(), "bdri-precache-test-"));
    dossiers.push(racine);
    const dist = path.join(racine, "dist");
    fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
    fs.mkdirSync(path.join(dist, "icons"), { recursive: true });
    fs.writeFileSync(path.join(dist, "index.html"), '<script type="module" src="/assets/index-aaa.js"></script>');
    fs.writeFileSync(path.join(dist, "assets", "index-aaa.js"), "console.log('entree')");
    fs.writeFileSync(path.join(dist, "assets", "PageLazy-bbb.js"), "export default 1");
    fs.writeFileSync(path.join(dist, "assets", "index-aaa.js.map"), "{}");
    fs.writeFileSync(path.join(dist, "icons", "icon-192.png"), Buffer.from([137, 80, 78, 71, 0, 1, 2]));
    fs.writeFileSync(path.join(dist, "manifest.webmanifest"), "{}");
    fs.copyFileSync(path.join(publicDir, "sw.js"), path.join(dist, "sw.js"));
    fs.copyFileSync(path.join(publicDir, "sw-policy.js"), path.join(dist, "sw-policy.js"));
    modif(dist);
    return dist;
  }

  /** Lance les deux crochets du plugin comme Vite le ferait. */
  function construire(dist: string): void {
    const plugin = precachePlugin();
    const racine = path.dirname(dist);
    (plugin.configResolved as unknown as (c: unknown) => void)({
      root: racine, build: { outDir: "dist" }, publicDir: "",
    });
    (plugin.closeBundle as unknown as () => void)();
  }

  function lireManifeste(dist: string) {
    return JSON.parse(fs.readFileSync(path.join(dist, "precache-manifest.json"), "utf8")) as {
      version: number; revision: string; tailleTotale: number;
      entrees: Array<{ url: string; integrite: string; taille: number }>;
    };
  }

  it("liste tout dist/, morceaux lazy compris, sans le worker ni les cartes de sources", () => {
    const dist = fauxDist();
    construire(dist);
    const m = lireManifeste(dist);
    expect(m.entrees.map((e) => e.url)).toEqual([
      "/assets/PageLazy-bbb.js",
      "/assets/index-aaa.js",
      "/icons/icon-192.png",
      "/index.html",
      "/manifest.webmanifest",
    ]);
    expect(m.tailleTotale).toBe(m.entrees.reduce((s, e) => s + e.taille, 0));
  });

  it("calcule l'empreinte SRI réelle de chaque fichier", () => {
    const dist = fauxDist();
    construire(dist);
    for (const e of lireManifeste(dist).entrees) {
      const contenu = fs.readFileSync(path.join(dist, e.url.slice(1)));
      expect(e.integrite).toBe("sha256-" + createHash("sha256").update(contenu).digest("base64"));
      expect(e.taille).toBe(contenu.length);
    }
  });

  it("produit un manifeste que la politique accepte, avec la révision gravée dans sw.js", () => {
    const dist = fauxDist();
    construire(dist);
    const m = lireManifeste(dist);
    const sw = fs.readFileSync(path.join(dist, "sw.js"), "utf8");
    const gravee = /const REVISION_BUILD = "([0-9a-f]{16})";/.exec(sw);
    expect(gravee?.[1]).toBe(m.revision);
    expect(sw).not.toContain("__REVISION_BUILD__");
    expect(P.validerManifeste(m, m.revision).ok).toBe(true);
  });

  it("ne contient aucune URL d'API", () => {
    const dist = fauxDist();
    construire(dist);
    expect(JSON.stringify(lireManifeste(dist))).not.toMatch(/\/api\b/i);
  });

  it("donne la même révision pour la même construction, une autre si un fichier change", () => {
    const a = fauxDist();
    const b = fauxDist();
    const c = fauxDist((dist) => fs.writeFileSync(path.join(dist, "assets", "PageLazy-bbb.js"), "export default 2"));
    construire(a); construire(b); construire(c);
    expect(lireManifeste(b).revision).toBe(lireManifeste(a).revision);
    // Le point essentiel : un changement d'application seul change `sw.js`, donc le navigateur
    // détecte la mise à jour et réinstalle.
    expect(lireManifeste(c).revision).not.toBe(lireManifeste(a).revision);
    expect(fs.readFileSync(path.join(c, "sw.js"), "utf8")).not.toBe(fs.readFileSync(path.join(a, "sw.js"), "utf8"));
  });

  it("change de révision quand la politique change", () => {
    const a = fauxDist();
    const b = fauxDist((dist) => fs.appendFileSync(path.join(dist, "sw-policy.js"), "\n// autre regle\n"));
    construire(a); construire(b);
    expect(lireManifeste(b).revision).not.toBe(lireManifeste(a).revision);
  });

  it("fait ÉCHOUER la construction si sw.js n'a pas l'emplacement de la révision", () => {
    const dist = fauxDist((d) => fs.writeFileSync(path.join(d, "sw.js"), "// worker sans emplacement\n"));
    expect(() => construire(dist)).toThrow(/REVISION_BUILD/);
  });

  it("fait ÉCHOUER la construction sur un nom de fichier hors de l'alphabet sûr", () => {
    const dist = fauxDist((d) => fs.writeFileSync(path.join(d, "assets", "a b.js"), "x"));
    expect(() => construire(dist)).toThrow(/alphabet/);
  });

  it("fait ÉCHOUER la construction sans index.html", () => {
    const dist = fauxDist((d) => fs.rmSync(path.join(d, "index.html")));
    expect(() => construire(dist)).toThrow(/index\.html/);
  });
});
