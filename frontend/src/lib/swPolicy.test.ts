import { beforeAll, describe, expect, it } from "vitest";

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
interface PolitiqueSw {
  CACHE_SHELL: string;
  CACHE_TUILES: string;
  MAX_TUILES: number;
  estTuile(url: string): boolean;
  aLaisserPasser(url: string, methode: string): boolean;
  cachePour(url: string, origine: string): string | null;
  aMettreEnCache(reponse: { type?: string; ok?: boolean } | null): boolean;
  aEvincer<T>(clefs: T[], plafond: number): T[];
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

  it("laisse passer le worker et le manifeste", () => {
    // Les mettre en cache empêcherait la mise à jour de l'application.
    expect(P.aLaisserPasser(`${ORIGINE}/sw.js`, "GET")).toBe(true);
    expect(P.aLaisserPasser(`${ORIGINE}/sw-policy.js`, "GET")).toBe(true);
    expect(P.aLaisserPasser(`${ORIGINE}/manifest.webmanifest`, "GET")).toBe(true);
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
    expect(P.cachePour(`${ORIGINE}/assets/index-abc.js`, ORIGINE)).toBe(P.CACHE_SHELL);
    expect(P.CACHE_TUILES).not.toBe(P.CACHE_SHELL);
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
