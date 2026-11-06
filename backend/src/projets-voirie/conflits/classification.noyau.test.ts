import { describe, expect, it } from "vitest";
import {
  arrondirMesure, cellule, classerInitial, cleConflit, cleReseau, empreinteMesure, finaliserCandidats, normaliserNom, type CandidatBrut,
} from "./classification.noyau";
import { TYPES_CONFLIT, type ClassePrecision, type Mesure, type TypeConflit } from "./types.noyau";

const M: Mesure = { longueurChausseeM: 7, longueurEmpriseM: 7, distanceMinM: 0, nbCroisements: 1, longueurPieceM: 7 };
const brut = (s: Partial<CandidatBrut> = {}): CandidatBrut => ({
  type: "INTERSECTION_CHAUSSEE", axe: "Axe A", jeuReseauId: "j1", objetId: "10", concessionnaireId: "c1", nomObjet: "Fibre-Marqueur P", empreinteObjet: "e".repeat(40),
  classePrecision: "B", mesure: M, lon: -10.0908815, lat: 9.1805913, geomHex: "00", ...s,
});

describe("classification initiale", () => {
  const geometriques: TypeConflit[] = ["INTERSECTION_CHAUSSEE", "INTERSECTION_EMPRISE", "PROXIMITE", "TRAVERSEE"];

  it("precision A, B ou C : POTENTIEL pour les quatre types geometriques", () => {
    for (const type of geometriques) for (const c of ["A", "B", "C"] as ClassePrecision[]) {
      const r = classerInitial({ type, classePrecision: c, verticalEvalue: false });
      expect(r.statut, `${type} ${c}`).toBe("POTENTIEL");
      expect(r.motifs).toEqual([]);
    }
  });

  it("precision D, E ou inconnue : A_INVESTIGUER avec son motif, jamais POTENTIEL", () => {
    for (const type of geometriques) {
      expect(classerInitial({ type, classePrecision: "D", verticalEvalue: false })).toMatchObject({ statut: "A_INVESTIGUER", motifs: ["PRECISION_INSUFFISANTE"] });
      expect(classerInitial({ type, classePrecision: "E", verticalEvalue: false })).toMatchObject({ statut: "A_INVESTIGUER", motifs: ["PRECISION_INSUFFISANTE"] });
      expect(classerInitial({ type, classePrecision: null, verticalEvalue: false })).toMatchObject({ statut: "A_INVESTIGUER", motifs: ["PRECISION_INCONNUE"] });
    }
  });

  it("couverture insuffisante et divergence de sources : toujours A_INVESTIGUER, quelle que soit la classe", () => {
    for (const c of ["A", "B", "C", "D", "E", null] as ClassePrecision[]) {
      expect(classerInitial({ type: "COUVERTURE_INSUFFISANTE", classePrecision: c, verticalEvalue: false }).statut).toBe("A_INVESTIGUER");
      expect(classerInitial({ type: "DIVERGENCE_SOURCES", classePrecision: c, verticalEvalue: false }).statut).toBe("A_INVESTIGUER");
    }
  });

  it("aucun calcul ne produit un statut humain : seuls A_INVESTIGUER et POTENTIEL sortent, pour tous les types et toutes les classes", () => {
    for (const type of TYPES_CONFLIT) for (const c of ["A", "B", "C", "D", "E", null] as ClassePrecision[]) for (const v of [false, true]) {
      expect(["A_INVESTIGUER", "POTENTIEL"]).toContain(classerInitial({ type, classePrecision: c, verticalEvalue: v }).statut);
    }
  });

  it("vertical non evalue (AT-07) : mention portee par le dossier ; motif d'investigation seulement si une regle l'exige", () => {
    const sans = classerInitial({ type: "INTERSECTION_CHAUSSEE", classePrecision: "A", verticalEvalue: false });
    expect(sans.statut).toBe("POTENTIEL");
    expect(sans.notes).toEqual(["VERTICAL_NON_EVALUE"]);
    const exige = classerInitial({ type: "INTERSECTION_CHAUSSEE", classePrecision: "A", verticalEvalue: false, verticalRequis: true });
    expect(exige).toMatchObject({ statut: "A_INVESTIGUER", motifs: ["VERTICAL_NON_EVALUE"] });
    expect(classerInitial({ type: "INTERSECTION_CHAUSSEE", classePrecision: "A", verticalEvalue: true, verticalRequis: true }).statut).toBe("POTENTIEL");
  });
});

describe("cle stable", () => {
  const base = { projetId: "p1", axe: "Axe A", reseau: cleReseau("c1", "Fibre-Marqueur P", null), type: "TRAVERSEE" as TypeConflit, cellule: [1, 2] as const };

  it("est une empreinte SHA-256 en hexadecimal, identique d'un appel a l'autre", () => {
    expect(cleConflit(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(cleConflit(base)).toBe(cleConflit({ ...base }));
  });

  it("change des qu'une composante change : projet, axe, objet, type, cellule", () => {
    const k = cleConflit(base);
    const autres = [
      cleConflit({ ...base, projetId: "p2" }), cleConflit({ ...base, axe: "Axe B" }), cleConflit({ ...base, reseau: cleReseau("c1", "Autre", null) }),
      cleConflit({ ...base, reseau: cleReseau("c2", "Fibre-Marqueur P", null) }), cleConflit({ ...base, type: "PROXIMITE" }),
      cleConflit({ ...base, cellule: [2, 2] }), cleConflit({ ...base, cellule: [1, 3] }),
    ];
    expect(new Set([k, ...autres]).size).toBe(8);
  });

  it("ne depend ni de la casse ni des espaces du nom d'axe ou d'objet", () => {
    expect(cleConflit({ ...base, axe: "  axe   A " })).toBe(cleConflit(base));
    expect(cleReseau("c1", "  FIBRE-marqueur   P ", null)).toBe(cleReseau("c1", "Fibre-Marqueur P", null));
    expect(normaliserNom("  É  t ")).toBe("é t");
  });

  it("un objet sans nom est identifie par l'empreinte de sa geometrie ; deux composantes ne se confondent pas par concatenation", () => {
    expect(cleReseau("c1", null, "abc")).not.toBe(cleReseau("c1", null, "abd"));
    expect(cleReseau("c1", "  ", "abc")).toBe(cleReseau("c1", null, "abc"));
    expect(cleConflit({ ...base, axe: "a", reseau: "b|c" })).not.toBe(cleConflit({ ...base, axe: "a|b", reseau: "c" }));
  });

  it("la cellule arrondit : deux points voisins (moins d'une dizaine de metres) tombent dans la meme cellule, deux points eloignes non", () => {
    expect(cellule(-10.0908815, 9.1805913)).toEqual(cellule(-10.0908900, 9.1805950));
    expect(cellule(-10.0908815, 9.1805913)).not.toEqual(cellule(-10.0900000, 9.1805913));
    expect(cellule(-10.0908815, 9.1805913, 0.1)).toEqual([-101, 92]);
  });
});

describe("mesure : arrondi et empreinte", () => {
  it("arrondit au centimetre et ignore le bruit flottant", () => {
    const a = arrondirMesure({ ...M, longueurChausseeM: 7.0000001, longueurEmpriseM: 6.99999999, distanceMinM: 0.0049999, longueurPieceM: 7.004 });
    expect(a).toEqual({ longueurChausseeM: 7, longueurEmpriseM: 7, distanceMinM: 0, nbCroisements: 1, longueurPieceM: 7 });
    expect(empreinteMesure({ ...M, longueurChausseeM: 7.0000001 })).toBe(empreinteMesure(M));
  });

  it("une modification d'un centimetre change l'empreinte ; null et 0 se distinguent", () => {
    expect(empreinteMesure({ ...M, longueurPieceM: 7.01 })).not.toBe(empreinteMesure(M));
    expect(empreinteMesure({ ...M, distanceMinM: null })).not.toBe(empreinteMesure({ ...M, distanceMinM: 0 }));
    expect(empreinteMesure(M)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("candidats : cles uniques et ordre indifferent", () => {
  it("la classification vient de la classe de precision du candidat", () => {
    const [a, b] = finaliserCandidats("p1", [brut({ classePrecision: "B" }), brut({ classePrecision: null, nomObjet: "Autre", lon: -10.08, lat: 9.2 })]);
    const parNom = [a, b].sort((x, y) => (x.classePrecision ?? "z").localeCompare(y.classePrecision ?? "z"));
    expect(parNom[0].classification.statut).toBe("POTENTIEL");
    expect(parNom[1].classification.statut).toBe("A_INVESTIGUER");
  });

  it("le resultat est trie par cle et ne depend pas de l'ordre de lecture", () => {
    const l = [brut({ lon: -10.09 }), brut({ lon: -10.08 }), brut({ type: "TRAVERSEE" }), brut({ axe: "Axe B" })];
    const a = finaliserCandidats("p1", l).map((c) => c.cle);
    const b = finaliserCandidats("p1", [...l].reverse()).map((c) => c.cle);
    expect(a).toEqual(b);
    expect(a).toEqual([...a].sort());
    expect(new Set(a).size).toBe(4);
  });

  it("deux objets de meme nom, meme axe, meme type et meme cellule restent deux dossiers (empreintes differentes) ; deux copies exactes n'en font qu'un", () => {
    const distincts = finaliserCandidats("p1", [brut({ objetId: "10", empreinteObjet: "a".repeat(40) }), brut({ objetId: "11", empreinteObjet: "b".repeat(40) })]);
    expect(distincts).toHaveLength(2);
    expect(new Set(distincts.map((c) => c.cle)).size).toBe(2);
    const copies = finaliserCandidats("p1", [brut({ objetId: "12", empreinteObjet: "a".repeat(40) }), brut({ objetId: "11", empreinteObjet: "a".repeat(40) })]);
    expect(copies).toHaveLength(1);
    expect(copies[0].objetId).toBe("11");
  });

  it("l'identifiant de jeu et d'objet ne fait pas partie de la cle : une nouvelle version du jeu retrouve le meme dossier", () => {
    const v1 = finaliserCandidats("p1", [brut({ jeuReseauId: "j1", objetId: "10" })])[0];
    const v2 = finaliserCandidats("p1", [brut({ jeuReseauId: "j2", objetId: "99" })])[0];
    expect(v2.cle).toBe(v1.cle);
  });

  it("un autre projet donne d'autres cles", () => {
    expect(finaliserCandidats("p1", [brut()])[0].cle).not.toBe(finaliserCandidats("p2", [brut()])[0].cle);
  });

  it("la mesure du dossier est celle arrondie", () => {
    const c = finaliserCandidats("p1", [brut({ mesure: { ...M, longueurPieceM: 7.0049 } })])[0];
    expect(c.mesure.longueurPieceM).toBe(7);
    expect(c.empreinteMesure).toBe(empreinteMesure(M));
  });
});
