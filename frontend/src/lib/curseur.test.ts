import { describe, expect, it } from "vitest";
import {
  aujourdhui, avertissements, bornes, decaler, ecrireCurseur, etiquetteJour, indexVersJour, jourValide,
  jourVersIndex, lireCurseur, messageVide, resume,
  type Chronologie, type ReponseCurseur,
} from "./curseur";

/**
 * Le curseur temporel, la logique : ce que ces tests defendent.
 *
 *   - un lien est une ENTREE EXTERIEURE : une date mal formee, inexistante ou FUTURE eteint tout le
 *     curseur, il n'est jamais applique a moitie ;
 *   - le curseur ne va JAMAIS au-dela d'aujourd'hui ;
 *   - un ecran vide DIT pourquoi : « aucune portion n'a de date d'effet » n'est pas « aucune
 *     portion a cette date » ;
 *   - rien de ce que la vue ecarte n'est passe sous silence.
 */

const AUJ = "2026-10-22";

function reponse(partiel: Partial<ReponseCurseur> = {}): ReponseCurseur {
  return {
    dateTerrain: "2026-03-15", connuLe: null, inclureAValider: false, tronque: false, plafond: 5000,
    comptes: { retenues: 0, aValiderEcartees: 0, sansDateEffet: 0, datesIncoherentes: 0, remplaceesSansFin: 0, ambigues: 0 },
    longueurCouverteM: 0, portions: [], ...partiel,
  };
}
const portionBidon = { id: "p" } as ReponseCurseur["portions"][number];
const chrono = (p: Partial<Chronologie> = {}): Chronologie => ({ total: 10, avecDateEffet: 6, sansDateEffet: 4, premiere: "2026-01-01", derniere: "2026-08-01", parMois: [], ...p });

describe("dates", () => {
  it("jourValide : reconnait une vraie date, refuse le reste", () => {
    expect(jourValide("2026-03-15")).toBe(true);
    for (const x of ["2026-02-30", "2026-13-01", "15/03/2026", "2026-3-5", "", null, undefined, "2026-03-15T00:00:00Z"]) {
      expect(jourValide(x as string)).toBe(false);
    }
    expect(jourValide("2024-02-29")).toBe(true);
    expect(jourValide("2026-02-29")).toBe(false);
  });
  it("aujourdhui : le jour UTC", () => {
    expect(aujourdhui(new Date("2026-10-22T23:59:59Z"))).toBe("2026-10-22");
    expect(aujourdhui(new Date("2026-10-23T00:00:01Z"))).toBe("2026-10-23");
  });
  it("etiquetteJour : en francais, le 1er prend « 1er »", () => {
    expect(etiquetteJour("2026-03-15")).toBe("15 mars 2026");
    expect(etiquetteJour("2026-08-01")).toBe("1er août 2026");
    expect(etiquetteJour("2026-02-03")).toBe("3 février 2026");
    expect(etiquetteJour("n'importe quoi")).toBe("n'importe quoi");
  });
});

describe("lireCurseur : le lien est une entree exterieure", () => {
  it("lit date, connu et propositions", () => {
    expect(lireCurseur("date=2026-03-15&connu=2026-04-01&propositions=1", AUJ)).toEqual({ actif: true, date: "2026-03-15", connu: "2026-04-01", inclureAValider: true });
    expect(lireCurseur("date=2026-03-15", AUJ)).toEqual({ actif: true, date: "2026-03-15", connu: null, inclureAValider: false });
  });
  it("sans date, le curseur est eteint", () => {
    expect(lireCurseur("lat=9.5&lng=-13.7", AUJ)).toBeNull();
  });
  it.each([
    ["date mal formee", "date=15-03-2026"],
    ["date inexistante", "date=2026-02-30"],
    ["date FUTURE", "date=2026-10-23"],
    ["connu mal forme", "date=2026-03-15&connu=hier"],
    ["connu FUTUR", "date=2026-03-15&connu=2027-01-01"],
  ])("%s : tout le curseur est ignore, jamais applique a moitie", (_n, search) => {
    expect(lireCurseur(search, AUJ)).toBeNull();
  });
  it("aujourd'hui est accepte", () => {
    expect(lireCurseur("date=2026-10-22", AUJ)).not.toBeNull();
  });
  it("les propositions ne s'activent que par propositions=1", () => {
    expect(lireCurseur("date=2026-03-15&propositions=oui", AUJ)?.inclureAValider).toBe(false);
  });
});

describe("ecrireCurseur", () => {
  const actif = { actif: true, date: "2026-03-15", connu: null, inclureAValider: false };
  it("ecrit la date et conserve les autres parametres", () => {
    const p = new URLSearchParams(ecrireCurseur("lat=9.5&layers=troncons", actif));
    expect(p.get("date")).toBe("2026-03-15");
    expect(p.get("lat")).toBe("9.5");
    expect(p.get("layers")).toBe("troncons");
    expect(p.has("connu")).toBe(false);
    expect(p.has("propositions")).toBe(false);
  });
  it("ecrit connu et propositions quand ils sont demandes", () => {
    const p = new URLSearchParams(ecrireCurseur("", { ...actif, connu: "2026-04-01", inclureAValider: true }));
    expect([p.get("connu"), p.get("propositions")]).toEqual(["2026-04-01", "1"]);
  });
  it("RETIRE les trois parametres quand le curseur est eteint, sans toucher au reste", () => {
    const p = new URLSearchParams(ecrireCurseur("lat=9.5&date=2026-03-15&connu=2026-04-01&propositions=1", { actif: false, date: "", connu: null, inclureAValider: false }));
    expect([...p.keys()]).toEqual(["lat"]);
  });
  it("est l'inverse de lireCurseur", () => {
    const c = { actif: true, date: "2026-03-15", connu: "2026-04-01", inclureAValider: true };
    expect(lireCurseur(ecrireCurseur("", c), AUJ)).toEqual(c);
  });
});

describe("bornes et position", () => {
  it("va de la premiere date d'effet a aujourd'hui", () => {
    const b = bornes({ premiere: "2026-01-01" }, AUJ);
    expect(b).toEqual({ min: "2026-01-01", max: AUJ, nbJours: 294 });
  });
  it("sans aucune date d'effet : un an en arriere, pour que le curseur existe et puisse s'expliquer", () => {
    const b = bornes({ premiere: null }, AUJ);
    expect(b.min).toBe("2025-10-22");
    expect(b.nbJours).toBe(365);
    expect(bornes(null, AUJ).min).toBe("2025-10-22");
  });
  it("ne depasse JAMAIS aujourd'hui, meme si la premiere date est dans le futur", () => {
    const b = bornes({ premiere: "2027-05-01" }, AUJ);
    expect(b).toEqual({ min: AUJ, max: AUJ, nbJours: 0 });
  });
  it("decaler ramene dans les bornes", () => {
    const b = bornes({ premiere: "2026-01-01" }, AUJ);
    expect(decaler("2026-03-15", 30, b)).toBe("2026-04-14");
    expect(decaler("2026-03-15", -30, b)).toBe("2026-02-13");
    expect(decaler("2026-01-10", -30, b)).toBe("2026-01-01");
    expect(decaler("2026-10-10", 30, b)).toBe(AUJ);
  });
  it("jourVersIndex et indexVersJour sont inverses, et bornes", () => {
    const b = bornes({ premiere: "2026-01-01" }, AUJ);
    expect(jourVersIndex(b, "2026-01-01")).toBe(0);
    expect(jourVersIndex(b, AUJ)).toBe(b.nbJours);
    expect(indexVersJour(b, 74)).toBe("2026-03-16");
    expect(indexVersJour(b, jourVersIndex(b, "2026-06-30"))).toBe("2026-06-30");
    expect(indexVersJour(b, -5)).toBe("2026-01-01");
    expect(indexVersJour(b, 99999)).toBe(AUJ);
    expect(jourVersIndex(b, "2020-01-01")).toBe(0);
  });
});

describe("messageVide : dire POURQUOI c'est vide", () => {
  it("aucune date d'effet nulle part : le curseur n'a rien a montrer, a aucune date, et dit ou la saisir", () => {
    const m = messageVide(chrono({ avecDateEffet: 0, sansDateEffet: 7, total: 7, premiere: null }), reponse());
    expect(m).toMatch(/Aucune portion ne porte de date d'effet/);
    expect(m).toMatch(/7 portions existent, toutes sans date d'effet/);
    expect(m).toMatch(/Portions terrain/);
  });
  it("aucune portion du tout : meme message, sans compte", () => {
    const m = messageVide(chrono({ avecDateEffet: 0, sansDateEffet: 0, total: 0, premiere: null }), reponse());
    expect(m).toMatch(/Aucune portion ne porte de date d'effet/);
    expect(m).not.toMatch(/existent|existe/);
  });
  it("des dates d'effet existent mais pas ici : ce n'est PAS un etat bon ni vide", () => {
    const m = messageVide(chrono(), reponse());
    expect(m).toMatch(/Aucune portion connue à cette date dans cette vue/);
    expect(m).toMatch(/Ce n'est pas un état « bon » ni « vide »/);
  });
  it("rien a dire quand la vue montre des portions", () => {
    expect(messageVide(chrono(), reponse({ portions: [portionBidon] }))).toBeNull();
  });
  it("rien a dire tant que la chronologie n'est pas chargee", () => {
    expect(messageVide(null, reponse())).toBeNull();
  });
});

describe("resume", () => {
  it("dit la date, le nombre et la longueur qualifiee, rien de plus", () => {
    const r = reponse({ portions: [portionBidon, portionBidon], longueurCouverteM: 2190 });
    expect(resume(r)).toBe("2 portions vraies le 15 mars 2026, soit 2,2 km qualifiés.");
  });
  it("accorde au singulier, et donne la longueur en metres sous le kilometre", () => {
    expect(resume(reponse({ portions: [portionBidon], longueurCouverteM: 350 }))).toBe("1 portion vraie le 15 mars 2026, soit 350 m qualifiés.");
  });
  it("rappelle l'axe systeme quand il est utilise", () => {
    const r = reponse({ connuLe: "2026-04-01", portions: [portionBidon], longueurCouverteM: 100 });
    expect(resume(r)).toContain("tel que connu le 1er avril 2026");
  });
  it("une vue vide le dit", () => {
    expect(resume(reponse())).toBe("Aucune portion connue le 15 mars 2026 dans cette vue.");
  });
});

describe("avertissements : rien de ce qui est ecarte n'est passe sous silence", () => {
  const comptes = (c: Partial<ReponseCurseur["comptes"]>) => ({ retenues: 1, aValiderEcartees: 0, sansDateEffet: 0, datesIncoherentes: 0, remplaceesSansFin: 0, ambigues: 0, ...c });

  it("aucun avertissement quand tout est montre", () => {
    expect(avertissements(chrono({ sansDateEffet: 0 }), reponse({ comptes: comptes({}), portions: [portionBidon] }))).toEqual([]);
  });
  it("signale la troncature", () => {
    expect(avertissements(null, reponse({ tronque: true, plafond: 5000 }))[0]).toMatch(/tronqué à 5.000 portions/);
  });
  it("signale les propositions non montrees, au singulier comme au pluriel", () => {
    expect(avertissements(null, reponse({ comptes: comptes({ aValiderEcartees: 1 }) }))).toEqual(["1 proposition non validée n'est pas montrée."]);
    expect(avertissements(null, reponse({ comptes: comptes({ aValiderEcartees: 3 }) }))).toEqual(["3 propositions non validées ne sont pas montrées."]);
  });
  it("ne parle pas de propositions non montrees quand elles le sont", () => {
    expect(avertissements(null, reponse({ inclureAValider: true, comptes: comptes({ aValiderEcartees: 2 }) }))).toEqual([]);
  });
  it("signale les recouvrements : le curseur ne tranche pas", () => {
    expect(avertissements(null, reponse({ comptes: comptes({ ambigues: 2 }) }))[0]).toMatch(/2 portions se recouvrent : le curseur ne tranche pas/);
  });
  it("signale les versions remplacees sans date de fin", () => {
    expect(avertissements(null, reponse({ comptes: comptes({ remplaceesSansFin: 2 }) }))[0]).toMatch(/2 versions remplacées sans date de fin ne sont pas montrées/);
  });
  it("signale les dates incoherentes", () => {
    expect(avertissements(null, reponse({ comptes: comptes({ datesIncoherentes: 1 }) }))[0]).toMatch(/1 portion aux dates incohérentes est écartée/);
  });
  it("donne le compte des portions sans date d'effet, quand il y a de quoi montrer", () => {
    expect(avertissements(chrono({ avecDateEffet: 6, sansDateEffet: 4 }), reponse())).toEqual(["4 portions du réseau n'ont pas de date d'effet : elles ne sont placées à aucune date."]);
    expect(avertissements(chrono({ avecDateEffet: 6, sansDateEffet: 1 }), reponse())[0]).toMatch(/1 portion du réseau n'a pas de date d'effet : elle n'est placée à aucune date/);
  });
  it("ne le repete pas quand AUCUNE n'a de date : messageVide le dit deja", () => {
    expect(avertissements(chrono({ avecDateEffet: 0, sansDateEffet: 7 }), reponse())).toEqual([]);
  });
});
