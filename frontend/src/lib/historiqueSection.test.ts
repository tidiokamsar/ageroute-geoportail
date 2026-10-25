import { describe, expect, it } from "vitest";
import { celluleCsv, csvAControler, libelleGravite, type ResultatAControler } from "./historiqueSection";

/** Export du classement : une cellule ne devient jamais une formule, l'étiquette « provisoire » voyage avec le fichier. */
const POIDS = { provenance: "PROVISOIRE_NON_CALIBRE", parConstatGrave: 3, parConstatEnAttente: 1, parRecurrence: 2, siInformationAncienne: 2, joursFenetreRecente: 180, joursSansConstat: 365 };
const RESULTAT: ResultatAControler = {
  genereLe: "2026-10-25T12:00:00.000Z", totalClasses: 1, sansConstatSurLeReseau: 4, constatsLus: 3, lectureIncomplete: false, avertissements: [], poids: POIDS,
  lignes: [{ tronconId: "t1", tronconCode: "GN N0001", tronconNom: "Conakry ; Coyah", regionId: 1, regionNom: "Conakry", score: 11, dernierConstat: "2026-10-20", facteurs: [], explication: "2 constat(s) grave(s) (2 × 3 = 6) : total 11." }],
};

describe("celluleCsv", () => {
  it("double les guillemets et protège les séparateurs et les sauts de ligne", () => {
    expect(celluleCsv('dit "ok"')).toBe('"dit ""ok"""');
    expect(celluleCsv("a;b")).toBe('"a;b"');
    expect(celluleCsv("a\nb")).toBe('"a\nb"');
    expect(celluleCsv(null)).toBe("");
    expect(celluleCsv(12)).toBe("12");
  });
  it("une cellule qui commence par = + - @ n'est jamais lue comme une formule", () => {
    for (const t of ["=SOMME(A1)", "+1", "-2", "@cmd"]) expect(celluleCsv(t).startsWith("'")).toBe(true);
  });
});

describe("csvAControler", () => {
  it("rang, code, nom (protégé), région, score, dernier constat, raison ; et la note provisoire en dernière ligne", () => {
    const lignes = csvAControler(RESULTAT).split("\r\n");
    expect(lignes[0]).toBe("Rang;Code;Nom;Région;Score;Dernier constat;Pourquoi");
    expect(lignes[1]).toBe('1;GN N0001;"Conakry ; Coyah";Conakry;11;2026-10-20;2 constat(s) grave(s) (2 × 3 = 6) : total 11.');
    expect(lignes[2]).toContain("pas une decision");
    expect(lignes[2]).toContain("PROVISOIRE_NON_CALIBRE");
  });
});

describe("libelleGravite", () => {
  it("défaut sur 4, observation en mots, absente dite absente", () => {
    expect(libelleGravite(3, "DEFAUT")).toBe("3 sur 4");
    expect(libelleGravite("FORTE", "OBSERVATION")).toBe("forte");
    expect(libelleGravite(null, "DEFAUT")).toBe("non précisée");
  });
});
