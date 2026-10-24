import { describe, expect, it, vi } from "vitest";
import { RAYON_ACTIFS_M, contexteTerrain, type SourcesContexte } from "./contexte";
import type { Portion } from "../reseau/portions";
import type { Appariement } from "../geo/appariement";

/**
 * Le contexte terrain : ce que ces tests defendent.
 *
 * LE RISQUE EST DE REPONDRE QUELQUE CHOSE PLUTOT QUE RIEN
 *
 * Un ecran de terrain qui affiche « RN1, portion bitumee en bon etat » alors que le GPS
 * n'a pas conclu, ou alors qu'aucune portion ne couvre l'endroit, envoie l'agent qualifier
 * une route sur laquelle il n'est peut-etre pas. Ces tests defendent les trois absences et
 * leurs motifs, parce que chaque motif appelle un GESTE DIFFERENT :
 *
 *   AUCUN_CANDIDAT_SUR      attendre une meilleure precision
 *   TRONCON_NON_QUALIFIE    commencer l'inventaire
 *   TROU_DE_QUALIFICATION   combler un inventaire commence
 */

const POS = { lat: 9.5, lon: -13.7, precisionM: 5 };

const APPARIEMENT: Appariement = {
  tronconId: "t-1",
  code: "GN N0001 3-1216",
  nom: "Conakry - Coyah",
  classe: "RN",
  distanceM: 4.2,
  abscisseM: 10_000,
  pk: 10,
  pkMotif: "CALCULE",
  confiance: 0.91,
  ambigu: false,
};

function portion(partiel: Partial<Portion> & Pick<Portion, "id" | "debutM" | "finM">): Portion {
  return {
    tronconId: "t-1",
    revetement: "BETON_BITUMINEUX",
    etat: "BON",
    praticabilite: null,
    largeurM: null,
    source: "mission-2026-10",
    observeeLe: new Date("2026-10-01T00:00:00Z"),
    confiance: "HIGH",
    statutValidation: "VALIDE",
    origine: "SAISIE_TERRAIN",
    clientOperationId: null,
    remplaceeLe: null,
    deletedAt: null,
    ...partiel,
  };
}

function sources(over: Partial<SourcesContexte> = {}): SourcesContexte {
  return {
    apparier: vi.fn(async () => APPARIEMENT),
    longueurTronconM: vi.fn(async () => 20_000),
    portionsDuTroncon: vi.fn(async () => [] as Portion[]),
    actifsProches: vi.fn(async () => []),
    ...over,
  };
}

describe("Quand le GPS ne permet pas de conclure", () => {
  it("ne rend AUCUN troncon, et dit pourquoi", () => {
    // Afficher un troncon ici enverrait l'agent qualifier une route sur laquelle il n'est
    // peut-etre pas.
    return contexteTerrain(POS, sources({ apparier: vi.fn(async () => null) })).then((c) => {
      expect(c.troncon).toBeNull();
      expect(c.motifSansTroncon).toBe("AUCUN_CANDIDAT_SUR");
      expect(c.portion).toBeNull();
      expect(c.couverture).toBeNull();
    });
  });

  it("rend QUAND MEME les actifs autour, cherches depuis la POSITION", async () => {
    // C'est la seule information exploitable la ou l'appariement echoue : un pont visible
    // reste un pont visible, meme si on ne sait pas sur quel troncon il est rattache.
    const actifs = vi.fn(async () => [
      { id: "o-1", type: "PONT", nom: "Pont de la Moribaya", distanceM: 40, etat: "MOYEN", derniereInspectionLe: null },
    ]);
    const c = await contexteTerrain(POS, sources({ apparier: vi.fn(async () => null), actifsProches: actifs }));
    expect(c.actifsProches).toHaveLength(1);
    expect(actifs).toHaveBeenCalledWith(POS, RAYON_ACTIFS_M);
  });
});

describe("Quand le troncon est trouve", () => {
  it("rend la portion qui contient l'abscisse", async () => {
    const c = await contexteTerrain(POS, sources({
      portionsDuTroncon: vi.fn(async () => [
        portion({ id: "p-a", debutM: 0, finM: 8_000 }),
        portion({ id: "p-b", debutM: 8_000, finM: 13_000, etat: "MAUVAIS" }),
      ]),
    }));
    expect(c.troncon?.code).toBe("GN N0001 3-1216");
    expect(c.portion?.id).toBe("p-b");
    expect(c.motifSansPortion).toBeNull();
  });

  it("distingue UN TRONCON SANS AUCUNE PORTION d'un TROU dans l'inventaire", async () => {
    // Le test le plus important du fichier. Les deux absences appellent des gestes
    // opposes : commencer, ou completer.
    const vide = await contexteTerrain(POS, sources());
    expect(vide.portion).toBeNull();
    expect(vide.motifSansPortion).toBe("TRONCON_NON_QUALIFIE");
    expect(vide.couverture?.qualifieM).toBe(0);

    const troue = await contexteTerrain(POS, sources({
      portionsDuTroncon: vi.fn(async () => [
        portion({ id: "p-a", debutM: 0, finM: 8_000 }),
        portion({ id: "p-b", debutM: 13_000, finM: 20_000 }),
      ]),
    }));
    expect(troue.portion).toBeNull();
    expect(troue.motifSansPortion).toBe("TROU_DE_QUALIFICATION");
    // Et le trou est nomme par ses abscisses, pour que l'agent sache ou il commence.
    expect(troue.couverture?.trous).toEqual([{ debutM: 8_000, finM: 13_000, longueurM: 5_000 }]);
  });

  it("rend la couverture du troncon, pour que l'agent voie ce qui reste", async () => {
    const c = await contexteTerrain(POS, sources({
      portionsDuTroncon: vi.fn(async () => [portion({ id: "p-a", debutM: 0, finM: 5_000 })]),
    }));
    expect(c.couverture).toMatchObject({ longueurTronconM: 20_000, qualifieM: 5_000, part: 0.25 });
  });

  it("propage l'AMBIGUITE, pour que l'ecran propose un choix", async () => {
    // Pres de deux routes paralleles, afficher une certitude serait un mensonge : le
    // moteur dit lui-meme qu'un autre troncon est a portee de l'incertitude GPS.
    const c = await contexteTerrain(POS, sources({
      apparier: vi.fn(async () => ({ ...APPARIEMENT, ambigu: true, confiance: 0.42 })),
    }));
    expect(c.ambigu).toBe(true);
  });

  it("NE compte PAS les portions remplacees comme couvrantes", async () => {
    const c = await contexteTerrain(POS, sources({
      portionsDuTroncon: vi.fn(async () => [
        portion({ id: "vieille", debutM: 0, finM: 20_000, remplaceeLe: new Date("2026-09-01") }),
      ]),
    }));
    expect(c.portion).toBeNull();
    expect(c.motifSansPortion).toBe("TRONCON_NON_QUALIFIE");
  });
});

describe("Quand la longueur du troncon n'est pas mesurable", () => {
  it("ne rend AUCUNE couverture plutot qu'une couverture fausse", async () => {
    // Sans denominateur, un pourcentage serait invente. L'abscisse, elle, reste connue.
    const c = await contexteTerrain(POS, sources({
      longueurTronconM: vi.fn(async () => null),
      portionsDuTroncon: vi.fn(async () => [portion({ id: "p-a", debutM: 8_000, finM: 13_000 })]),
    }));
    expect(c.couverture).toBeNull();
    expect(c.portion?.id).toBe("p-a");
  });

  it("et le dit quand aucune portion ne couvre l'abscisse", async () => {
    const c = await contexteTerrain(POS, sources({ longueurTronconM: vi.fn(async () => null) }));
    expect(c.portion).toBeNull();
    expect(c.motifSansPortion).toBe("LONGUEUR_TRONCON_INCONNUE");
  });
});
