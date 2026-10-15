import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MESURES_PAR_UNITE, SOURCE_RAI, SOURCE_V10, TYPES_DEFAUT } from "./catalogue-defauts.referentiel";

/**
 * Le catalogue de reference : ce que ces tests defendent.
 *
 * - le plancher du paragraphe 7.16 : >= 21 types, revetu ET non revetu representes ;
 * - les treize types de production sont la, INCHANGES dans leur code -- ils sont references
 *   par des defauts, et un code qui change casserait une cle etrangere ;
 * - chaque type dit sa source, et aucune source n'est inventee ;
 * - la metrique est coherente : les mesures requises couvrent au moins celles de l'unite.
 */

const CODES_PRODUCTION = [
  "NID_POULE", "FISS_LONG", "FISS_TRANS", "FAIENCAGE", "ORNIERAGE", "AFFAISSEMENT", "RAVINEMENT",
  "ARRACHEMENT", "DEFORMATION", "DRAINAGE", "ACCOTEMENT", "SIGNALISATION", "AUTRE",
];

describe("Le referentiel ne depend de rien", () => {
  it("n'a aucun import", () => {
    const src = readFileSync(join(__dirname, "catalogue-defauts.referentiel.ts"), "utf8");
    expect([...src.matchAll(/^import .*?from\s+["']/gm)]).toHaveLength(0);
  });
});

describe("Plancher du paragraphe 7.16", () => {
  it("compte au moins 21 types", () => {
    expect(TYPES_DEFAUT.length).toBeGreaterThanOrEqual(21);
    expect(TYPES_DEFAUT.length).toBe(31);
  });

  it("couvre le revetu ET le non revetu, et pas seulement « tous »", () => {
    const revetu = TYPES_DEFAUT.filter((t) => t.applicabilite === "REVETU").length;
    const nonRevetu = TYPES_DEFAUT.filter((t) => t.applicabilite === "NON_REVETU").length;
    expect(revetu).toBeGreaterThanOrEqual(5);
    // En Guinee la majorite du reseau n'est pas revetue : la tole ondulee, les bourbiers, les
    // tetes de chat doivent etre la.
    expect(nonRevetu).toBeGreaterThanOrEqual(5);
    for (const code of ["TOLE_ONDULEE", "BOURBIER", "TETES_DE_CHAT", "POUSSIERE"]) {
      expect(TYPES_DEFAUT.find((t) => t.code === code)?.applicabilite).toBe("NON_REVETU");
    }
  });
});

describe("Les treize types de production sont intacts", () => {
  it.each(CODES_PRODUCTION)("%s est present, avec la source du cahier des charges", (code) => {
    const t = TYPES_DEFAUT.find((x) => x.code === code);
    expect(t).toBeDefined();
    expect(t!.source).toBe(SOURCE_RAI);
  });

  it("et tous les autres portent la source du paragraphe 7.4 du mandat", () => {
    const autres = TYPES_DEFAUT.filter((t) => !CODES_PRODUCTION.includes(t.code));
    expect(autres).toHaveLength(18);
    expect(autres.every((t) => t.source === SOURCE_V10)).toBe(true);
    expect(autres.every((t) => t.description.includes("§ 7.4"))).toBe(true);
  });
});

describe("Coherence interne", () => {
  it("les codes sont uniques, en majuscules et sans espace", () => {
    const codes = TYPES_DEFAUT.map((t) => t.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((c) => /^[A-Z][A-Z0-9_]+$/.test(c))).toBe(true);
  });

  it("les mesures requises couvrent au moins celles que l'unite impose", () => {
    for (const t of TYPES_DEFAUT) {
      for (const m of MESURES_PAR_UNITE[t.unite]) {
        expect(t.mesuresRequises, `${t.code} (${t.unite}) devrait exiger ${m}`).toContain(m);
      }
    }
  });

  it("un comptage exige NOMBRE, sauf le type ouvert AUTRE", () => {
    for (const t of TYPES_DEFAUT.filter((x) => x.unite === "UNITE" && x.code !== "AUTRE")) {
      expect(t.mesuresRequises, t.code).toEqual(["NOMBRE"]);
    }
  });

  it("un parent cite existe et appartient a la meme famille", () => {
    for (const t of TYPES_DEFAUT.filter((x) => x.parentCode)) {
      const parent = TYPES_DEFAUT.find((x) => x.code === t.parentCode);
      expect(parent, `${t.code} cite ${t.parentCode}`).toBeDefined();
      expect(parent!.famille).toBe(t.famille);
    }
  });

  it("la gravite maximale, quand elle existe, est entre 1 et 4 ; les equipements ne se graduent pas", () => {
    for (const t of TYPES_DEFAUT) {
      if (t.graviteMax !== null) { expect(t.graviteMax).toBeGreaterThanOrEqual(1); expect(t.graviteMax).toBeLessThanOrEqual(4); }
    }
    for (const code of ["SIGNALISATION", "GLISSIERE", "MARQUAGE", "ECLAIRAGE", "BORNE"]) {
      expect(TYPES_DEFAUT.find((t) => t.code === code)!.graviteMax).toBeNull();
    }
  });
});
