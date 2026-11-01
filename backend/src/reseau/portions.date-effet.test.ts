import { beforeEach, describe, expect, it } from "vitest";
import {
  creerPortion,
  decouperPortion,
  fusionnerPortions,
  requalifierPortion,
  type DepotPortions,
  type Ecriture,
} from "./portions.service";
import { refusFusion, type Portion } from "./portions";
import { dateEffet, jourUtc } from "./date-effet";

/**
 * La date d'effet des portions : ce que ces tests defendent.
 *
 * Sans elle, l'axe TERRAIN de la bitemporalite existe en colonnes et n'est exerce par aucune
 * donnee (migration 20261014200000) : le curseur temporel n'aurait rien a montrer. Ces tests
 * garantissent que la date est SAISISSIBLE, qu'elle ne s'invente jamais, et qu'elle suit la
 * vie d'une portion.
 *
 *   - une date absente reste INCONNUE : elle n'est jamais remplacee par « depuis toujours » ;
 *   - requalifier avec une date CLOT l'ancienne version a cette date, sans toucher `remplaceeLe`,
 *     qui est l'axe systeme ;
 *   - sans date, rien n'est ferme : le comportement d'avant est conserve ;
 *   - decouper n'invente aucune date, les morceaux heritent ; fusionner deux portions vraies a des
 *     periodes differentes est REFUSE.
 */

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
    statutValidation: "A_VALIDER",
    origine: "SAISIE_TERRAIN",
    clientOperationId: null,
    remplaceeLe: null,
    deletedAt: null,
    ...partiel,
  };
}

let dernier: Ecriture | null = null;
function depot(over: Partial<DepotPortions> = {}): DepotPortions {
  return {
    longueurTronconM: async () => 20_000,
    portionsDuTroncon: async () => [],
    portionParId: async () => null,
    portionParCleClient: async () => null,
    appliquer: async (e) => { dernier = e; return e.inserer.map((p, i) => ({ ...p, id: `neuf-${i}` })); },
    decider: async () => portion({ id: "x", debutM: 0, finM: 1 }),
    ...over,
  };
}
beforeEach(() => { dernier = null; });

const J = (s: string) => new Date(`${s}T00:00:00Z`);

describe("dateEffet (validation d'entree)", () => {
  it("ramene toute heure au jour UTC, a minuit : un meme jour ne donne qu'une date", () => {
    expect(jourUtc(new Date("2026-03-15T23:59:59Z")).toISOString()).toBe("2026-03-15T00:00:00.000Z");
    const r = dateEffet.parse("2026-03-15T18:30:00Z");
    expect(r?.toISOString()).toBe("2026-03-15T00:00:00.000Z");
  });
  it("accepte l'absence : une date inconnue reste inconnue", () => {
    expect(dateEffet.parse(undefined)).toBeUndefined();
    expect(dateEffet.parse(null)).toBeNull();
  });
  it("REFUSE une date future : un fait de terrain est deja vrai", () => {
    const demain = new Date(Date.now() + 2 * 86_400_000).toISOString();
    expect(dateEffet.safeParse(demain).success).toBe(false);
  });
  it("accepte aujourd'hui", () => {
    expect(dateEffet.safeParse(new Date().toISOString()).success).toBe(true);
  });
  it("refuse une chaine qui n'est pas une date", () => {
    expect(dateEffet.safeParse("pas-une-date").success).toBe(false);
  });
});

describe("Creer avec une date d'effet", () => {
  it("la porte sur la portion neuve, et laisse `valideAu` vide", async () => {
    const r = await creerPortion({ tronconId: "t-1", debutM: 0, finM: 1_000, etat: "BON", valideDu: J("2026-03-15") }, "u-1", depot());
    if (r.refus !== null) throw new Error("refus inattendu");
    expect(r.valeur.valideDu).toEqual(J("2026-03-15"));
    expect(r.valeur.valideAu).toBeNull();
  });
  it("sans date : INCONNUE (null), jamais « depuis toujours »", async () => {
    const r = await creerPortion({ tronconId: "t-1", debutM: 0, finM: 1_000, etat: "BON" }, "u-1", depot());
    if (r.refus !== null) throw new Error("refus inattendu");
    expect(r.valeur.valideDu).toBeNull();
    expect(r.valeur.valideAu).toBeNull();
  });
});

describe("Requalifier avec une date d'effet", () => {
  const ancienne = portion({ id: "p-1", debutM: 0, finM: 5_000, etat: "BON", statutValidation: "VALIDE", valideDu: J("2026-01-01") });
  const d = () => depot({ portionParId: async () => ancienne, portionsDuTroncon: async () => [ancienne] });

  it("CLOT l'ancienne version a cette date, et ouvre la nouvelle ce jour-la", async () => {
    const r = await requalifierPortion("p-1", { etat: "MAUVAIS", valideDu: J("2026-06-01") }, "u-1", d());
    if (r.refus !== null) throw new Error("refus inattendu");
    expect(r.valeur.valideDu).toEqual(J("2026-06-01"));
    expect(r.valeur.valideAu).toBeNull();
    expect(dernier?.cloreTerrain).toEqual({ valideAu: J("2026-06-01") });
    // L'axe SYSTEME reste a part : `remplaceeLe` est pose par la couche de persistance.
    expect(dernier?.remplacer).toEqual(["p-1"]);
  });

  it("SANS date : rien n'est ferme, comme avant", async () => {
    const r = await requalifierPortion("p-1", { etat: "MAUVAIS" }, "u-1", d());
    if (r.refus !== null) throw new Error("refus inattendu");
    expect(r.valeur.valideDu).toBeNull();
    expect(dernier?.cloreTerrain).toBeUndefined();
  });

  it("REFUSE une date qui n'est pas POSTERIEURE a celle de l'ancienne, sans ecrire", async () => {
    for (const jour of ["2026-01-01", "2025-12-31"]) {
      const r = await requalifierPortion("p-1", { etat: "MAUVAIS", valideDu: J(jour) }, "u-1", d());
      expect(r.refus).toBe("DATE_EFFET_NON_POSTERIEURE");
    }
    expect(dernier).toBeNull();
  });

  it("accepte n'importe quelle date quand l'ancienne n'en avait pas", async () => {
    const sansDate = portion({ id: "p-2", debutM: 0, finM: 5_000, statutValidation: "VALIDE" });
    const r = await requalifierPortion("p-2", { etat: "MAUVAIS", valideDu: J("2020-01-01") }, "u-1",
      depot({ portionParId: async () => sansDate, portionsDuTroncon: async () => [sansDate] }));
    expect(r.refus).toBeNull();
    expect(dernier?.cloreTerrain).toEqual({ valideAu: J("2020-01-01") });
  });

  it("ne rouvre ni ne rechange la fin d'une version DEJA close", async () => {
    const close = portion({ id: "p-3", debutM: 0, finM: 5_000, valideDu: J("2026-01-01"), valideAu: J("2026-03-01") });
    const r = await requalifierPortion("p-3", { etat: "MAUVAIS", valideDu: J("2026-06-01") }, "u-1",
      depot({ portionParId: async () => close, portionsDuTroncon: async () => [close] }));
    expect(r.refus).toBeNull();
    expect(dernier?.cloreTerrain).toBeUndefined();
  });
});

describe("Decouper et fusionner, et la date d'effet", () => {
  it("les morceaux d'une decoupe HERITENT de la date d'effet, aucune n'est inventee", async () => {
    const p = portion({ id: "p-1", debutM: 0, finM: 10_000, valideDu: J("2026-02-01"), valideAu: J("2026-09-01") });
    const r = await decouperPortion("p-1", 4_000, "u-1", depot({ portionParId: async () => p }));
    if (r.refus !== null) throw new Error("refus inattendu");
    for (const m of r.valeur) {
      expect(m.valideDu).toEqual(J("2026-02-01"));
      expect(m.valideAu).toEqual(J("2026-09-01"));
    }
  });

  it("REFUSE de fusionner deux portions vraies a des periodes differentes", () => {
    const a = portion({ id: "a", debutM: 0, finM: 1_000, valideDu: J("2026-01-01") });
    const b = portion({ id: "b", debutM: 1_000, finM: 2_000, valideDu: J("2026-06-01") });
    expect(refusFusion(a, b)).toBe("PERIODES_DIFFERENTES");
  });

  it("une fin differente suffit a refuser : l'etat n'a pas dure aussi longtemps", () => {
    const a = portion({ id: "a", debutM: 0, finM: 1_000, valideDu: J("2026-01-01"), valideAu: J("2026-05-01") });
    const b = portion({ id: "b", debutM: 1_000, finM: 2_000, valideDu: J("2026-01-01"), valideAu: null });
    expect(refusFusion(a, b)).toBe("PERIODES_DIFFERENTES");
  });

  it("fusionne deux portions de MEME periode, et deux portions sans date", async () => {
    const a = portion({ id: "a", debutM: 0, finM: 1_000, valideDu: J("2026-01-01") });
    const b = portion({ id: "b", debutM: 1_000, finM: 2_000, valideDu: J("2026-01-01") });
    expect(refusFusion(a, b)).toBeNull();
    const c = portion({ id: "c", debutM: 0, finM: 1_000 });
    const e = portion({ id: "e", debutM: 1_000, finM: 2_000 });
    expect(refusFusion(c, e)).toBeNull();
    const r = await fusionnerPortions("c", "e", "u-1", depot({ portionParId: async (id) => (id === "c" ? c : e) }));
    expect(r.refus).toBeNull();
  });

  it("une date connue d'un cote et inconnue de l'autre = periodes differentes (rien n'est suppose egal)", () => {
    const a = portion({ id: "a", debutM: 0, finM: 1_000, valideDu: J("2026-01-01") });
    const b = portion({ id: "b", debutM: 1_000, finM: 2_000 });
    expect(refusFusion(a, b)).toBe("PERIODES_DIFFERENTES");
  });
});
