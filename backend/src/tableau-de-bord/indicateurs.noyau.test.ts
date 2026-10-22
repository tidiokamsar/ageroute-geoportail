import { describe, expect, it } from "vitest";
import {
  GROUPES, defautsRegistre, disponibilite, enParallele, regionsDuPerimetre, valeursEgales,
  type DefinitionIndicateur,
} from "./indicateurs.noyau";

/**
 * Le noyau du registre d'indicateurs (A12) : ce que ces tests defendent.
 *   - un indicateur sans perimetre, sans controle, ou dont le controle EST le calcul, est un defaut ;
 *   - `null` n'est egal qu'a `null` : un zero n'est pas « rien a mesurer » ;
 *   - un montant en GNF se compare en chaine, jamais en nombre ;
 *   - un compte regional ne recoit jamais un indicateur qui ne se ventile pas par region.
 */

const perimetre = { code: "RESEAU_CLASSE_SAISI", libelle: "Réseau classé saisi", definition: "tronçons classés non supprimés" };
const calcul = async () => 1;
const controle = async () => 1;
function def(over: Partial<DefinitionIndicateur<unknown>> = {}): DefinitionIndicateur<unknown> {
  return { code: "x_un", libelle: "Un", groupe: "reseau", unite: "nombre", perimetre, regionalisable: true, calcul, controle, ...over };
}

describe("defautsRegistre", () => {
  it("un registre conforme n'a aucun defaut", () => {
    expect(defautsRegistre([def(), def({ code: "x_deux" })])).toEqual([]);
  });

  it("refuse un registre vide", () => {
    expect(defautsRegistre([])).toEqual(["registre vide"]);
  });

  it("refuse un indicateur sans perimetre, ou au perimetre incomplet", () => {
    expect(defautsRegistre([def({ perimetre: undefined as never })])[0]).toMatch(/perimetre absent/);
    expect(defautsRegistre([def({ perimetre: { code: "A", libelle: "", definition: "d" } })])[0]).toMatch(/perimetre absent ou incomplet/);
    expect(defautsRegistre([def({ perimetre: { code: "A", libelle: "L", definition: " " } })])[0]).toMatch(/perimetre absent ou incomplet/);
  });

  it("refuse un indicateur sans requete de controle, et un controle qui est le calcul lui-meme", () => {
    expect(defautsRegistre([def({ controle: undefined as never })])[0]).toMatch(/requete de controle absente/);
    expect(defautsRegistre([def({ controle: calcul })])[0]).toMatch(/independant/);
  });

  it("refuse un code en double, invalide, un libelle vide, un groupe inconnu, une ventilation non declaree", () => {
    expect(defautsRegistre([def(), def()])).toContain("x_un : code en double");
    expect(defautsRegistre([def({ code: "Mauvais Code" })])[0]).toMatch(/code absent ou invalide/);
    expect(defautsRegistre([def({ libelle: " " })])[0]).toMatch(/libelle absent/);
    expect(defautsRegistre([def({ groupe: "inconnu" as never })])[0]).toMatch(/groupe inconnu/);
    expect(defautsRegistre([def({ regionalisable: undefined as never })])[0]).toMatch(/regionalisable/);
  });

  it("refuse de dire « reseau national » pour un perimetre qui est la base saisie (D-06)", () => {
    expect(defautsRegistre([def({ libelle: "Longueur du réseau national" })])[0]).toMatch(/reseau national/);
    expect(defautsRegistre([def({ perimetre: { ...perimetre, libelle: "Réseau national" } })])[0]).toMatch(/reseau national/);
  });

  it("les groupes connus sont ceux du tableau de bord et de la Control Tower", () => {
    expect([...GROUPES]).toEqual(["reseau", "portions", "qualite", "veille", "patrouilles", "teledetection", "programmation"]);
  });
});

describe("valeursEgales", () => {
  it("entiers : exacts", () => {
    expect(valeursEgales(4, 4, "nombre")).toBe(true);
    expect(valeursEgales(4, 5, "nombre")).toBe(false);
  });

  it("mesures : a l'arrondi pres (km au centieme, part au dix-millieme)", () => {
    expect(valeursEgales(7.74, 7.75, "km")).toBe(true);
    expect(valeursEgales(7.74, 7.80, "km")).toBe(false);
    expect(valeursEgales(0.6587, 0.6588, "part")).toBe(true);
    expect(valeursEgales(0.6587, 0.67, "part")).toBe(false);
  });

  it("montants : chaines exactes, au-dela de 2^53", () => {
    expect(valeursEgales("9007199254740993", "9007199254740993", "GNF")).toBe(true);
    expect(valeursEgales("9007199254740993", "9007199254740992", "GNF")).toBe(false);
    expect(valeursEgales("10", 10, "GNF")).toBe(false);
  });

  it("null n'est egal qu'a null ; NaN n'est egal a rien", () => {
    expect(valeursEgales(null, null, "part")).toBe(true);
    expect(valeursEgales(null, 0, "part")).toBe(false);
    expect(valeursEgales(0, null, "nombre")).toBe(false);
    expect(valeursEgales(Number.NaN, Number.NaN, "nombre")).toBe(false);
  });
});

describe("disponibilite (A10)", () => {
  it("un compte national lit tout", () => {
    expect(disponibilite({ regionalisable: false }, { regions: null })).toEqual({ disponible: true });
  });

  it("un compte regional lit ce qui se ventile par region", () => {
    expect(disponibilite({ regionalisable: true }, { regions: [3] })).toEqual({ disponible: true });
  });

  it("un compte regional ne lit pas un indicateur sans ventilation, et le motif le dit", () => {
    const d = disponibilite({ regionalisable: false }, { regions: [3] });
    expect(d.disponible).toBe(false);
    if (!d.disponible) expect(d.motif).toMatch(/national/);
  });
});

describe("regionsDuPerimetre", () => {
  it("national -> null ; regional -> regions triees", () => {
    expect(regionsDuPerimetre({ national: true })).toBeNull();
    expect(regionsDuPerimetre({ national: false, regions: new Set([5, 2]) })).toEqual([2, 5]);
  });
});

describe("enParallele", () => {
  it("conserve l'ordre des resultats et ne depasse jamais la limite de concurrence", async () => {
    let actifs = 0, max = 0;
    const r = await enParallele([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      actifs++; max = Math.max(max, actifs);
      await new Promise((ok) => setTimeout(ok, 5 * (8 - n)));
      actifs--;
      return n * 10;
    });
    expect(r).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(max).toBeLessThanOrEqual(3);
  });

  it("liste vide : aucun appel", async () => {
    expect(await enParallele([], 4, async () => 1)).toEqual([]);
  });
});
