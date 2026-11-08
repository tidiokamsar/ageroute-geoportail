import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  selectionner,
  statutConnuLe,
  type DecisionValidation,
  type PortionDatee,
  type StatutValidation,
} from "./curseur.noyau";

/**
 * Le curseur temporel, les regles : ce que ces tests defendent.
 *
 *   - le curseur N'INVENTE RIEN : sans date d'effet, une portion n'est placee a aucune date ;
 *   - par defaut seul le VALIDE fait foi, et les propositions restent identifiables ;
 *   - sur l'axe systeme, le statut est celui d'ALORS, pas celui d'aujourd'hui ;
 *   - une version remplacee sans date de fin n'est pas montree : elle se superposerait a sa
 *     remplacante, et on ne sait pas quand la realite a changé ;
 *   - un metre couvert deux fois est signale et ne compte qu'une fois.
 */

const J = (s: string) => new Date(`${s}T00:00:00Z`);
const T = (s: string) => new Date(s);

function p(partiel: Partial<PortionDatee> & Pick<PortionDatee, "id">): PortionDatee {
  return {
    tronconId: "t-1",
    debutM: 0,
    finM: 1_000,
    statutValidation: "VALIDE",
    valideDu: J("2026-01-01"),
    valideAu: null,
    enregistreLe: T("2026-01-10T08:00:00Z"),
    remplaceeLe: null,
    deletedAt: null,
    ...partiel,
  };
}

const AUJOURD_HUI = { dateTerrain: J("2026-06-15"), connuLe: null, inclureAValider: false };

describe("selectionner : l'axe terrain", () => {
  it("retient une portion vraie a la date, intervalle semi-ouvert [valideDu, valideAu)", () => {
    const l = [p({ id: "a", valideDu: J("2026-01-01"), valideAu: J("2026-06-15") })];
    // Le jour de la fin est EXCLU : a la bascule, une seule version est vraie.
    expect(selectionner(l, [], { ...AUJOURD_HUI, dateTerrain: J("2026-06-14") }).retenues).toHaveLength(1);
    expect(selectionner(l, [], { ...AUJOURD_HUI, dateTerrain: J("2026-06-15") }).retenues).toHaveLength(0);
    expect(selectionner(l, [], { ...AUJOURD_HUI, dateTerrain: J("2026-01-01") }).retenues).toHaveLength(1);
    expect(selectionner(l, [], { ...AUJOURD_HUI, dateTerrain: J("2025-12-31") }).retenues).toHaveLength(0);
  });

  it("deux versions successives d'une meme emprise : UNE seule a chaque date", () => {
    const l = [
      p({ id: "ancienne", etat: undefined, valideDu: J("2026-01-01"), valideAu: J("2026-06-01"), remplaceeLe: T("2026-06-02T09:00:00Z") } as Partial<PortionDatee> & { id: string }),
      p({ id: "nouvelle", valideDu: J("2026-06-01"), valideAu: null }),
    ];
    expect(selectionner(l, [], { ...AUJOURD_HUI, dateTerrain: J("2026-03-01") }).retenues.map((r) => r.id)).toEqual(["ancienne"]);
    expect(selectionner(l, [], { ...AUJOURD_HUI, dateTerrain: J("2026-06-01") }).retenues.map((r) => r.id)).toEqual(["nouvelle"]);
    expect(selectionner(l, [], AUJOURD_HUI).retenues.map((r) => r.id)).toEqual(["nouvelle"]);
  });

  it("une portion SANS date d'effet n'est placee a aucune date : comptee, jamais supposee", () => {
    const l = [p({ id: "x", valideDu: null })];
    const r = selectionner(l, [], AUJOURD_HUI);
    expect(r.retenues).toHaveLength(0);
    expect(r.comptes.sansDateEffet).toBe(1);
  });

  it("une date incoherente est ecartee ET comptee, pas corrigee", () => {
    const l = [p({ id: "x", valideDu: J("2026-05-01"), valideAu: J("2026-04-01") })];
    const r = selectionner(l, [], AUJOURD_HUI);
    expect(r.retenues).toHaveLength(0);
    expect(r.comptes.datesIncoherentes).toBe(1);
  });

  it("ignore une portion supprimee logiquement", () => {
    const l = [p({ id: "x", deletedAt: T("2026-02-01T00:00:00Z") })];
    expect(selectionner(l, [], AUJOURD_HUI).retenues).toHaveLength(0);
  });

  it("n'invente RIEN pour un metre non couvert : seul ce qui est couvert est rendu", () => {
    const l = [p({ id: "a", debutM: 0, finM: 400 }), p({ id: "b", debutM: 600, finM: 1_000 })];
    const r = selectionner(l, [], AUJOURD_HUI);
    expect(r.retenues.map((x) => [x.debutM, x.finM])).toEqual([[0, 400], [600, 1_000]]);
    expect(r.longueurCouverteM).toBe(800);
  });
});

describe("selectionner : le statut de validation", () => {
  const propositions = [p({ id: "v", statutValidation: "VALIDE" }), p({ id: "a", statutValidation: "A_VALIDER", debutM: 1_000, finM: 2_000 })];

  it("par defaut, seul le VALIDE est retenu, et le nombre d'ecartees en attente est dit", () => {
    const r = selectionner(propositions, [], AUJOURD_HUI);
    expect(r.retenues.map((x) => x.id)).toEqual(["v"]);
    expect(r.comptes.aValiderEcartees).toBe(1);
  });

  it("sur demande, les propositions sont retenues, et restent identifiables", () => {
    const r = selectionner(propositions, [], { ...AUJOURD_HUI, inclureAValider: true });
    expect(r.retenues.map((x) => [x.id, x.statutConnu])).toEqual([["v", "VALIDE"], ["a", "A_VALIDER"]]);
    expect(r.comptes.aValiderEcartees).toBe(0);
  });

  it("un rejet n'est jamais montre, meme sur demande", () => {
    const l = [p({ id: "r", statutValidation: "REJETE" }), p({ id: "c", statutValidation: "A_CORRIGER" })];
    expect(selectionner(l, [], { ...AUJOURD_HUI, inclureAValider: true }).retenues).toHaveLength(0);
  });
});

describe("statutConnuLe : ce que l'on savait ALORS", () => {
  const d = (portionId: string, statut: StatutValidation, decideLe: string): DecisionValidation => ({ portionId, statut, decideLe: T(decideLe) });

  it("sans decision avant la date, la portion etait A_VALIDER, quel que soit son statut actuel", () => {
    expect(statutConnuLe("a", [d("a", "VALIDE", "2026-06-01T00:00:00Z")], T("2026-05-01T00:00:00Z"))).toBe("A_VALIDER");
  });
  it("prend la derniere decision AVANT la date", () => {
    const j = [d("a", "REJETE", "2026-02-01T00:00:00Z"), d("a", "VALIDE", "2026-04-01T00:00:00Z"), d("a", "REJETE", "2026-08-01T00:00:00Z")];
    expect(statutConnuLe("a", j, T("2026-03-01T00:00:00Z"))).toBe("REJETE");
    expect(statutConnuLe("a", j, T("2026-05-01T00:00:00Z"))).toBe("VALIDE");
    expect(statutConnuLe("a", j, T("2026-09-01T00:00:00Z"))).toBe("REJETE");
  });
  it("ignore les decisions des autres portions", () => {
    expect(statutConnuLe("a", [d("b", "VALIDE", "2026-01-01T00:00:00Z")], T("2026-12-01T00:00:00Z"))).toBe("A_VALIDER");
  });
  it("une decision a l'instant meme compte ; deux au meme instant : la derniere gagne", () => {
    expect(statutConnuLe("a", [d("a", "VALIDE", "2026-04-01T10:00:00Z")], T("2026-04-01T10:00:00Z"))).toBe("VALIDE");
    expect(statutConnuLe("a", [d("a", "VALIDE", "2026-04-01T10:00:00Z"), d("a", "REJETE", "2026-04-01T10:00:00Z")], T("2026-04-01T10:00:00Z"))).toBe("REJETE");
  });
});

describe("selectionner : l'axe systeme", () => {
  it("ne montre pas ce qui n'etait pas encore enregistre", () => {
    const l = [p({ id: "tard", enregistreLe: T("2026-05-01T00:00:00Z") })];
    const r = selectionner(l, [], { dateTerrain: J("2026-03-01"), connuLe: T("2026-04-01T00:00:00Z"), inclureAValider: true });
    expect(r.retenues).toHaveLength(0);
  });

  it("une portion validee APRES la date est vue comme une proposition, pas comme validee", () => {
    const l = [p({ id: "a", statutValidation: "VALIDE", enregistreLe: T("2026-01-10T00:00:00Z") })];
    const dec: DecisionValidation[] = [{ portionId: "a", statut: "VALIDE", decideLe: T("2026-06-01T00:00:00Z") }];
    const avant = { dateTerrain: J("2026-03-01"), connuLe: T("2026-04-01T00:00:00Z") };
    expect(selectionner(l, dec, { ...avant, inclureAValider: false }).retenues).toHaveLength(0);
    const avecProp = selectionner(l, dec, { ...avant, inclureAValider: true });
    expect(avecProp.retenues[0].statutConnu).toBe("A_VALIDER");
    // Et APRES la decision, elle est validee.
    expect(selectionner(l, dec, { dateTerrain: J("2026-03-01"), connuLe: T("2026-07-01T00:00:00Z"), inclureAValider: false }).retenues[0].statutConnu).toBe("VALIDE");
  });

  it("une version dont le remplacement n'etait pas encore enregistre reapparait OUVERTE", () => {
    const l = [p({ id: "a", valideDu: J("2026-01-01"), valideAu: J("2026-03-01"), remplaceeLe: T("2026-04-10T00:00:00Z") })];
    // Validee le 01/02 : sans decision enregistree, elle n'etait que proposee a toute date.
    const dec: DecisionValidation[] = [{ portionId: "a", statut: "VALIDE", decideLe: T("2026-02-01T00:00:00Z") }];
    // Terrain au 15/05, tel que connu le 01/04 : le remplacement (10/04) n'existait pas, la version est ouverte.
    const r = selectionner(l, dec, { dateTerrain: J("2026-05-15"), connuLe: T("2026-04-01T00:00:00Z"), inclureAValider: false });
    expect(r.retenues.map((x) => x.id)).toEqual(["a"]);
    // Tel que connu le 20/04, le remplacement est connu : la version est close au 01/03.
    expect(selectionner(l, dec, { dateTerrain: J("2026-05-15"), connuLe: T("2026-04-20T00:00:00Z"), inclureAValider: false }).retenues).toHaveLength(0);
  });
});

describe("selectionner : les versions remplacees", () => {
  it("une version remplacee SANS date de fin n'est pas montree : on ne sait pas quand elle a cesse", () => {
    const l = [p({ id: "parent", remplaceeLe: T("2026-03-01T00:00:00Z"), valideAu: null })];
    const r = selectionner(l, [], AUJOURD_HUI);
    expect(r.retenues).toHaveLength(0);
    expect(r.comptes.remplaceesSansFin).toBe(1);
  });

  it("une decoupe : le parent est ecarte, les deux morceaux couvrent les memes metres sans doublon", () => {
    const l = [
      p({ id: "parent", debutM: 0, finM: 1_000, remplaceeLe: T("2026-03-01T00:00:00Z") }),
      p({ id: "g", debutM: 0, finM: 400 }),
      p({ id: "d", debutM: 400, finM: 1_000 }),
    ];
    const r = selectionner(l, [], AUJOURD_HUI);
    expect(r.retenues.map((x) => x.id)).toEqual(["g", "d"]);
    expect(r.comptes.ambigues).toBe(0);
    expect(r.longueurCouverteM).toBe(1_000);
  });

  it("une requalification AVEC date : l'ancienne couvre avant, la nouvelle apres, jamais les deux", () => {
    const l = [
      p({ id: "ancienne", valideDu: J("2026-01-01"), valideAu: J("2026-06-01"), remplaceeLe: T("2026-06-02T00:00:00Z") }),
      p({ id: "nouvelle", valideDu: J("2026-06-01") }),
    ];
    for (const [jour, attendu] of [["2026-05-31", "ancienne"], ["2026-06-01", "nouvelle"], ["2026-09-01", "nouvelle"]] as const) {
      expect(selectionner(l, [], { ...AUJOURD_HUI, dateTerrain: J(jour) }).retenues.map((x) => x.id)).toEqual([attendu]);
    }
  });
});

describe("selectionner : recouvrements", () => {
  it("signale deux portions retenues qui se recouvrent, et ne compte le metre qu'une fois", () => {
    const l = [
      p({ id: "a", debutM: 0, finM: 600, statutValidation: "A_VALIDER" }),
      p({ id: "b", debutM: 400, finM: 1_000, statutValidation: "A_VALIDER" }),
      p({ id: "c", debutM: 2_000, finM: 2_100 }),
    ];
    const r = selectionner(l, [], { ...AUJOURD_HUI, inclureAValider: true });
    expect(r.retenues.filter((x) => x.ambigue).map((x) => x.id)).toEqual(["a", "b"]);
    expect(r.comptes.ambigues).toBe(2);
    expect(r.longueurCouverteM).toBe(1_000 + 100);
  });

  it("deux portions qui se touchent sans se recouvrir ne sont pas ambigues", () => {
    const l = [p({ id: "a", debutM: 0, finM: 500 }), p({ id: "b", debutM: 500, finM: 1_000 })];
    expect(selectionner(l, [], AUJOURD_HUI).comptes.ambigues).toBe(0);
  });

  it("des portions de troncons differents ne se recouvrent jamais", () => {
    const l = [p({ id: "a", tronconId: "t-1" }), p({ id: "b", tronconId: "t-2" })];
    const r = selectionner(l, [], AUJOURD_HUI);
    expect(r.comptes.ambigues).toBe(0);
    expect(r.longueurCouverteM).toBe(2_000);
  });

  it("est deterministe : le meme jeu rend le meme resultat, quel que soit l'ordre d'entree", () => {
    const l = [p({ id: "b", debutM: 500, finM: 1_000 }), p({ id: "a", debutM: 0, finM: 500 }), p({ id: "c", tronconId: "t-0" })];
    const a = selectionner(l, [], AUJOURD_HUI).retenues.map((x) => x.id);
    const b = selectionner([...l].reverse(), [], AUJOURD_HUI).retenues.map((x) => x.id);
    expect(a).toEqual(b);
    expect(a).toEqual(["c", "a", "b"]);
  });
});

describe("noyau pur", () => {
  it("ne depend que de bitemporel.ts, lui-meme pur : ni base, ni horloge implicite", () => {
    const source = readFileSync(join(__dirname, "curseur.noyau.ts"), "utf8");
    const imports = [...source.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports).toEqual(["./bitemporel"]);
    expect(source).not.toMatch(/@prisma\/client|from "express"|node:|Date\.now\(|new Date\(\)/);
  });
});
