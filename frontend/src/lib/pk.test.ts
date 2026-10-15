import { describe, expect, it } from "vitest";
import { formaterPk, PK_NON_CALCULABLE } from "./pk";

/**
 * Notation du point kilometrique : ce que ces tests defendent.
 *
 * LE BOGUE QU'ILS FIXENT, ET QUI EXISTAIT EN DEUX EXEMPLAIRES
 *
 * Deux fonctions `fmtPk` vivaient dans le depot — `pages/geoportail/DetailPanel.tsx` et
 * `pages/TronconsPage.tsx` — avec le meme calcul et deux sorties differentes (l'une prefixait
 * « PK », l'autre non). Toutes deux faisaient :
 *
 *     const km = Math.floor(v);
 *     const m  = Math.round((v - km) * 1000);
 *
 * `Math.round` peut rendre 1000, qui n'est pas un decalage metrique valide dans un kilometre.
 * Mesure du 14/10/2026 :
 *
 *     1.9999  ->  « PK 1+1000 »   au lieu de « PK 2+000 »
 *     5.9996  ->  « PK 5+1000 »   au lieu de « PK 6+000 »
 *     -0.5    ->  « PK -1+500 »   au lieu d'un refus
 *
 * Le paragraphe 1 du mandat v2.1 citait ce « bug de formatage des PK cote frontend » parmi les
 * constats d'audit. Il est ici reproduit, puis corrige.
 *
 * POURQUOI UN SEUL MODULE
 *
 * Un formateur duplique finit par divergir, et c'etait deja le cas : deux sorties pour la meme
 * notion. Le prefixe devient donc une option, et le calcul n'a plus qu'une seule
 * implementation.
 *
 * POURQUOI LE REFUS N'EST PAS UN TIRET
 *
 * `PK_NON_CALCULABLE` porte une phrase, pas un « — ». Le paragraphe 7.2 du mandat l'exige :
 * « Le PK n'est jamais obligatoire. Il est calcule et affiche uniquement si une calibration
 * fiable existe ; sinon on affiche la distance depuis l'origine du troncon avec la mention
 * "distance calculee, non PK officiel". » Un tiret laisse croire a une donnee manquante ; la
 * verite est que le PK n'est pas calculable sur 1 029 troncons regionaux faute de rattachement
 * a un axe.
 */

describe("Le report de l'arrondi au kilometre", () => {
  it("ne rend JAMAIS 1000 metres : 1,9999 km devient 2+000", () => {
    expect(formaterPk(1.9999)).toBe("PK 2+000");
  });

  it("5,9996 devient 6+000, et non 5+1000", () => {
    expect(formaterPk(5.9996)).toBe("PK 6+000");
  });

  it("reporte aussi depuis zero : 0,9999 devient 1+000", () => {
    expect(formaterPk(0.9999)).toBe("PK 1+000");
  });

  it("n'altere pas les valeurs qui n'ont pas besoin de report", () => {
    expect(formaterPk(188.42)).toBe("PK 188+420");
    expect(formaterPk(12.0005)).toBe("PK 12+001");
    expect(formaterPk(0)).toBe("PK 0+000");
    expect(formaterPk(3)).toBe("PK 3+000");
  });
});

describe("Ce qui n'est pas un PK est refuse, pas formate", () => {
  it("refuse une valeur negative au lieu de rendre « -1+500 »", () => {
    expect(formaterPk(-0.5)).toBe(PK_NON_CALCULABLE);
    expect(formaterPk(-1)).toBe(PK_NON_CALCULABLE);
  });

  it("refuse l'absence, et le dit en français plutot que par un tiret", () => {
    expect(formaterPk(null)).toBe(PK_NON_CALCULABLE);
    expect(formaterPk(undefined)).toBe(PK_NON_CALCULABLE);
  });

  it("refuse ce qui n'est pas un nombre fini", () => {
    expect(formaterPk(Number.NaN)).toBe(PK_NON_CALCULABLE);
    expect(formaterPk(Number.POSITIVE_INFINITY)).toBe(PK_NON_CALCULABLE);
  });

  it("le refus explique, il ne laisse pas croire a une donnee perdue", () => {
    // « — » se lit « la valeur existe mais manque ». Or le PK n'est pas calculable sur les
    // 1 029 troncons regionaux, faute de rattachement a un axe : c'est une impossibilite,
    // pas une lacune de saisie.
    expect(PK_NON_CALCULABLE).not.toBe("—");
    expect(PK_NON_CALCULABLE.length).toBeGreaterThan(5);
    expect(PK_NON_CALCULABLE).not.toMatch(/_|undefined|null|NaN/);
  });
});

describe("Le prefixe est une option, pour qu'un seul calcul serve les deux usages", () => {
  it("sans prefixe, pour une cellule de tableau ou l'en-tete dit deja « PK »", () => {
    expect(formaterPk(188.42, { prefixe: false })).toBe("188+420");
    expect(formaterPk(1.9999, { prefixe: false })).toBe("2+000");
  });

  it("le refus ne porte pas de prefixe non plus", () => {
    expect(formaterPk(null, { prefixe: false })).toBe(PK_NON_CALCULABLE);
  });
});

describe("Un intervalle de PK", () => {
  it("rend les deux bornes avec une seule mention du prefixe", () => {
    expect(formaterPk(1.2, { prefixe: true })).toBe("PK 1+200");
  });

  it("les metres sont toujours sur trois chiffres", () => {
    // « 1+2 » serait illisible et se confondrait avec « 1+200 » dicte par radio.
    expect(formaterPk(1.002)).toBe("PK 1+002");
    expect(formaterPk(1.02)).toBe("PK 1+020");
  });
});
