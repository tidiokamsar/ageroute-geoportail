import { describe, expect, it } from "vitest";
import { cellule, cleConflit, cleCouvertureAxe, cleReseau, empreinteMesure, finaliserCandidats, lireMesure, type CandidatBrut } from "./classification.noyau";
import { DETAIL_MORCEAUX_MAX, identiteAxe, morceauxDe, regrouperCouverture, type MorceauAxe } from "./couverture.noyau";

import type { Mesure } from "./types.noyau";

// Correctif D7 (pilote local du 09/11/2026) : un dossier de couverture insuffisante par AXE, plus par objet. Donnees synthetiques.
const morceau = (i: number, s: Partial<MorceauAxe> = {}): MorceauAxe => ({
  objetId: String(100 + i), jeuAxesId: "ja", ordre: i, nom: "Corridor synthetique", identifiant: null, libelle: "Corridor synthetique", longueurM: 250 + i, nbCouvrants: 0, ...s,
});
const corridor = (n: number) => Array.from({ length: n }, (_, i) => morceau(i));

const bruts = (groupes: ReturnType<typeof regrouperCouverture>): CandidatBrut[] => groupes.map((g) => ({
  type: "COUVERTURE_INSUFFISANTE", axe: g.axe, jeuReseauId: null, jeuAxesId: g.jeuAxesId, objetId: null, concessionnaireId: null, nomObjet: null, empreinteObjet: null,
  classePrecision: null, identiteAxe: g.identite, cellule: cellule(-10.1 + g.morceaux[0].ordre * 0.01, 9.1), geomHex: "00",
  mesure: { longueurChausseeM: 0, longueurEmpriseM: 0, distanceMinM: null, nbCroisements: 0, longueurPieceM: g.morceaux.reduce((s, m) => s + m.longueurM, 0), ...(g.identite ? { morceaux: morceauxDe(g) } : {}) },
}));

describe("identite d'un axe", () => {
  it("identifiant mappe d'abord, sinon nom normalise (casse, espaces), sinon aucune", () => {
    expect(identiteAxe("Corridor  A", "RN-12 ")).toBe("i:rn-12");
    expect(identiteAxe("  Corridor   A ", null)).toBe("n:corridor a");
    expect(identiteAxe("corridor a", "")).toBe("n:corridor a");
    expect(identiteAxe(null, null)).toBeNull();
    expect(identiteAxe("   ", "  ")).toBeNull();
  });
});

describe("regroupement des morceaux non couverts", () => {
  it("128 morceaux d'un meme axe (un par feuille de plan) : UN groupe, 128 morceaux tries par ordre", () => {
    const g = regrouperCouverture([...corridor(128)].reverse());
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ identite: "n:corridor synthetique", jeuAxesId: "ja", axe: "Corridor synthetique" });
    expect(g[0].morceaux.map((m) => m.ordre)).toEqual(Array.from({ length: 128 }, (_, i) => i));
  });

  it("les morceaux couverts n'entrent dans aucun dossier ; un axe entierement couvert n'en a pas", () => {
    const g = regrouperCouverture([...corridor(4).map((m, i) => ({ ...m, nbCouvrants: i % 2 })), morceau(9, { nom: "Autre axe", nbCouvrants: 2 })]);
    expect(g).toHaveLength(1);
    expect(g[0].morceaux.map((m) => m.ordre)).toEqual([0, 2]);
  });

  it("un objet sans nom garde son propre dossier, avec son libelle d'avant", () => {
    const g = regrouperCouverture([morceau(0, { nom: null, libelle: "Axe 1" }), morceau(1, { nom: null, libelle: "Axe 2" }), morceau(2)]);
    expect(g.map((x) => [x.identite, x.axe, x.morceaux.length])).toEqual([["n:corridor synthetique", "Corridor synthetique", 1], [null, "Axe 1", 1], [null, "Axe 2", 1]]);
  });

  it("la colonne identifiant du mapping regroupe des morceaux de noms differents, et separe deux axes de meme nom", () => {
    const g = regrouperCouverture([
      morceau(0, { nom: "Feuille 1", identifiant: "AX-1" }), morceau(1, { nom: "Feuille 2", identifiant: "AX-1" }),
      morceau(2, { nom: "Feuille 1", identifiant: "AX-2" }), morceau(3, { nom: null, identifiant: "AX-3", libelle: "Axe 4" }),
    ]);
    expect(g.map((x) => [x.identite, x.axe, x.morceaux.map((m) => m.ordre)])).toEqual([
      ["i:ax-1", "Feuille 1", [0, 1]], ["i:ax-2", "Feuille 1", [2]], ["i:ax-3", "Axe AX-3", [3]],
    ]);
  });

  it("deux plans d'axes : jamais un groupe commun", () => {
    const g = regrouperCouverture([morceau(0), morceau(1, { jeuAxesId: "jb" })]);
    expect(g.map((x) => x.jeuAxesId)).toEqual(["ja", "jb"]);
  });

  it("resultat independant de l'ordre de lecture", () => {
    const l = [...corridor(5), morceau(7, { nom: "B" }), morceau(8, { nom: null, libelle: "Axe 9" })];
    expect(regrouperCouverture([...l].reverse())).toEqual(regrouperCouverture(l));
  });

  it("detail des morceaux : nombre exact, longueur totale, detail borne", () => {
    const [g] = regrouperCouverture(corridor(DETAIL_MORCEAUX_MAX + 5));
    const m = morceauxDe(g);
    expect(m.nb).toBe(DETAIL_MORCEAUX_MAX + 5);
    expect(m.detail).toHaveLength(DETAIL_MORCEAUX_MAX);
    expect(m.detailTronque).toBe(true);
    expect(m.longueurTotaleM).toBeCloseTo(g.morceaux.reduce((s, x) => s + x.longueurM, 0), 2);
    expect(m.detail[0]).toEqual({ objetId: "100", ordre: 0, nom: "Corridor synthetique", longueurM: 250 });
    expect(morceauxDe(regrouperCouverture(corridor(3))[0]).detailTronque).toBe(false);
  });
});

describe("cle stable d'un dossier de couverture regroupe", () => {
  it("128 morceaux : un seul dossier calcule ; meme entree, meme cle ; cle par identite, sans cellule", () => {
    const a = finaliserCandidats("p1", bruts(regrouperCouverture(corridor(128))));
    const b = finaliserCandidats("p1", bruts(regrouperCouverture([...corridor(128)].reverse())));
    expect(a).toHaveLength(1);
    expect(a[0].cle).toBe(cleCouvertureAxe("p1", "n:corridor synthetique"));
    expect(b.map((c) => [c.cle, c.empreinteMesure])).toEqual(a.map((c) => [c.cle, c.empreinteMesure]));
    expect(a[0].mesure.morceaux?.nb).toBe(128);
  });

  it("ajouter un morceau garde la cle et change la mesure (dossier marque a reexaminer au rejeu)", () => {
    const a = finaliserCandidats("p1", bruts(regrouperCouverture(corridor(3))))[0];
    const b = finaliserCandidats("p1", bruts(regrouperCouverture(corridor(4))))[0];
    expect(b.cle).toBe(a.cle);
    expect(b.empreinteMesure).not.toBe(a.empreinteMesure);
  });

  it("redecouper un axe a longueur totale egale change l'empreinte (le detail des morceaux y entre)", () => {
    const deux = finaliserCandidats("p1", bruts(regrouperCouverture([morceau(0, { longueurM: 100 }), morceau(1, { longueurM: 300 })])))[0];
    const trois = finaliserCandidats("p1", bruts(regrouperCouverture([morceau(0, { longueurM: 100 }), morceau(1, { longueurM: 100 }), morceau(2, { longueurM: 200 })])))[0];
    expect(trois.cle).toBe(deux.cle);
    expect(trois.mesure.longueurPieceM).toBe(deux.mesure.longueurPieceM);
    expect(trois.empreinteMesure).not.toBe(deux.empreinteMesure);
  });

  it("espace de cles distinct : la cle regroupee ne coincide jamais avec la cle par objet d'avant", () => {
    const parObjet = cleConflit({ projetId: "p1", axe: "Corridor synthetique", reseau: cleReseau(null, null, null), type: "COUVERTURE_INSUFFISANTE", cellule: [0, 0] });
    expect(cleCouvertureAxe("p1", "n:corridor synthetique")).not.toBe(parObjet);
    expect(cleCouvertureAxe("p2", "n:corridor synthetique")).not.toBe(cleCouvertureAxe("p1", "n:corridor synthetique"));
  });

  it("objet sans nom : cle et empreinte EXACTEMENT celles d'avant le correctif (meme dossier au rejeu)", () => {
    const [c] = finaliserCandidats("p1", bruts(regrouperCouverture([morceau(4, { nom: null, libelle: "Axe 5" })])));
    const avant = cleConflit({ projetId: "p1", axe: "Axe 5", reseau: cleReseau(null, null, null), type: "COUVERTURE_INSUFFISANTE", cellule: cellule(-10.1 + 4 * 0.01, 9.1) });
    expect(c.cle).toBe(avant);
    expect(c.mesure.morceaux).toBeUndefined();
    expect(c.empreinteMesure).toBe(empreinteMesure({ longueurChausseeM: 0, longueurEmpriseM: 0, distanceMinM: null, nbCroisements: 0, longueurPieceM: 254 }));
  });
});

describe("mesure relue (rejeu)", () => {
  it("une mesure regroupee relue de la base redonne la meme empreinte (rejeu idempotent)", () => {
    const [c] = finaliserCandidats("p1", bruts(regrouperCouverture(corridor(6))));
    const relue = lireMesure(JSON.parse(JSON.stringify(c.mesure)));
    expect(empreinteMesure(relue)).toBe(c.empreinteMesure);
  });

  it("une mesure d'avant le correctif (sans morceaux) garde son empreinte d'avant", () => {
    const m: Mesure = { longueurChausseeM: 0, longueurEmpriseM: 0, distanceMinM: null, nbCroisements: 0, longueurPieceM: 150.04 };
    expect(lireMesure(m)).toEqual(m);
    expect(empreinteMesure(lireMesure(m))).toBe(empreinteMesure(m));
  });
});
