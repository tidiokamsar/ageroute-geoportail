import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../lib/prisma", () => ({ prisma: {} }));

import { PERIMETRES, REGISTRE, couvertureParBalayage } from "./indicateurs.registre";
import { GROUPES, defautsRegistre } from "./indicateurs.noyau";
import { MODULES_CONTROL_TOWER } from "./control-tower.service";

/**
 * GARDE DU REGISTRE (A12). Le registre reel ne doit contenir aucun indicateur sans perimetre ni sans
 * requete de controle independante. Les valeurs elles-memes sont eprouvees contre PostGIS par
 * `tests-integration/tableau-de-bord.integration.mts` (calcul = controle = valeur attendue a la main).
 */

describe("le registre reel", () => {
  it("ne declare aucun defaut : chaque indicateur a un perimetre affichable et un controle independant", () => {
    expect(defautsRegistre(REGISTRE)).toEqual([]);
  });

  it("couvre chaque groupe du tableau de bord et de la Control Tower", () => {
    const groupes = new Set(REGISTRE.map((d) => d.groupe));
    for (const g of GROUPES) expect(groupes.has(g), `groupe ${g} vide`).toBe(true);
  });

  it("chaque perimetre utilise est declare dans PERIMETRES (code, libelle, definition lisibles)", () => {
    const declares = new Set<string>(Object.values(PERIMETRES).map((p) => p.code));
    for (const d of REGISTRE) {
      expect(declares.has(d.perimetre.code), `${d.code} : perimetre ${d.perimetre.code} non declare`).toBe(true);
      expect(d.perimetre.definition.length).toBeGreaterThan(20);
    }
  });

  it("le perimetre « reseau classe saisi » ne se dit jamais « reseau national » dans un libelle", () => {
    for (const d of REGISTRE) {
      expect(`${d.libelle} ${d.perimetre.libelle}`).not.toMatch(/r[eé]seau national/i);
    }
    expect(PERIMETRES.RESEAU_CLASSE_SAISI.libelle).toBe("Réseau classé saisi");
  });

  it("un indicateur non ventile par region est declare tel (il sera refuse a un compte regional)", () => {
    const nationaux = REGISTRE.filter((d) => !d.regionalisable).map((d) => d.code).sort();
    expect(nationaux).toEqual(["documents", "regles_escalade_actives", "valeurs_observees", "valeurs_qualifiees"]);
  });

  it("un montant est une chaine : chaque indicateur en GNF le declare", () => {
    expect(REGISTRE.filter((d) => d.unite === "GNF").map((d) => d.code).sort()).toEqual([
      "chantiers_montant_gnf", "previsions_realisees_gnf", "previsions_retenues_gnf",
    ]);
  });

  it("chaque module de la Control Tower ne cite que des indicateurs du registre, sans doublon", () => {
    const codes = new Set(REGISTRE.map((d) => d.code));
    const cites = MODULES_CONTROL_TOWER.flatMap((m) => m.codes);
    for (const c of cites) expect(codes.has(c), `${c} absent du registre`).toBe(true);
    expect(new Set(cites).size).toBe(cites.length);
  });

  it("n'emploie ni $queryRawUnsafe ni concatenation : seul du SQL etiquete, valeurs liees (par. 7.1)", () => {
    const source = readFileSync(join(__dirname, "indicateurs.registre.ts"), "utf8");
    expect(source).not.toMatch(/queryRawUnsafe|executeRawUnsafe/);
  });
});

describe("couvertureParBalayage (le controle de la couverture)", () => {
  const troncons = new Map([["a", 1000], ["b", 500]]);

  it("fusionne les recouvrements : la part commune n'est comptee qu'une fois", () => {
    const r = couvertureParBalayage(troncons, [
      { tronconId: "a", debutM: 0, finM: 400 },
      { tronconId: "a", debutM: 300, finM: 700 },
      { tronconId: "a", debutM: 800, finM: 900 },
    ]);
    expect(r).toEqual({ longueurM: 1500, qualifieM: 800 });
  });

  it("deux portions jointives a la tolerance pres ne forment qu'une ile", () => {
    const r = couvertureParBalayage(troncons, [
      { tronconId: "a", debutM: 0, finM: 400 },
      { tronconId: "a", debutM: 400.04, finM: 600 },
    ]);
    expect(r.qualifieM).toBeCloseTo(600, 5);
    // Au-dela de la tolerance (5 cm), le trou est reel et n'est pas comble.
    const separe = couvertureParBalayage(troncons, [
      { tronconId: "a", debutM: 0, finM: 400 },
      { tronconId: "a", debutM: 400.06, finM: 600 },
    ]);
    expect(separe.qualifieM).toBeCloseTo(400 + 199.94, 5);
  });

  it("borne a la longueur du troncon, ignore les troncons inconnus et les portions vides", () => {
    const r = couvertureParBalayage(troncons, [
      { tronconId: "b", debutM: -50, finM: 900 },
      { tronconId: "zz", debutM: 0, finM: 100 },
      { tronconId: "a", debutM: 100, finM: 100 },
    ]);
    expect(r).toEqual({ longueurM: 1500, qualifieM: 500 });
  });

  it("aucune portion : zero metre qualifie", () => {
    expect(couvertureParBalayage(troncons, [])).toEqual({ longueurM: 1500, qualifieM: 0 });
  });
});
