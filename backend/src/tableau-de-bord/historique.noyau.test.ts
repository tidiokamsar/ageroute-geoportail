import { describe, expect, it } from "vitest";
import { classerAControler, estGrave, historiqueDeConstats, POIDS_PROVISOIRES, type Constat } from "./historique.noyau";

/**
 * Historique d'une section et classement « à contrôler » : ce que ces tests défendent. Tous les cas sont fabriqués et
 * calculables à la main.
 *   - un constat rejeté n'est jamais un fait ; confirmé et proposé ne se mélangent pas ;
 *   - une récurrence = le même type constaté à au moins deux JOURS distincts (deux constats le même jour n'en font pas une) ;
 *   - le classement est EXPLICABLE (facteurs, points, phrase) et REPRODUCTIBLE (égalités départagées) ;
 *   - sans constat, un tronçon n'est pas classé : l'absence de donnée n'est pas un risque.
 */
const MAINTENANT = new Date("2026-10-25T12:00:00.000Z");
const jour = (n: number) => new Date(MAINTENANT.getTime() - n * 86_400_000);
let compteur = 0;
const defaut = (code: string, gravite: number | null, statut: string, joursAvant: number, etatDefaut = "ACTIF"): Constat =>
  ({ nature: "DEFAUT", id: `d${++compteur}`, type: code, libelle: code, gravite, statut, etatDefaut, constateA: jour(joursAvant) });
const obs = (type: string, gravite: "FAIBLE" | "MOYENNE" | "FORTE" | null, statut: string, joursAvant: number): Constat =>
  ({ nature: "OBSERVATION", id: `o${++compteur}`, type, libelle: type, gravite, statut, constateA: jour(joursAvant) });

describe("estGrave", () => {
  it("défaut de gravité 3 ou 4, observation FORTE ; rien d'autre, et une gravité absente n'est pas grave", () => {
    expect(estGrave(defaut("NID", 3, "VALIDE", 1))).toBe(true);
    expect(estGrave(defaut("NID", 4, "VALIDE", 1))).toBe(true);
    expect(estGrave(defaut("NID", 2, "VALIDE", 1))).toBe(false);
    expect(estGrave(defaut("NID", null, "VALIDE", 1))).toBe(false);
    expect(estGrave(obs("DEGRADATION", "FORTE", "PROPOSEE", 1))).toBe(true);
    expect(estGrave(obs("DEGRADATION", "MOYENNE", "PROPOSEE", 1))).toBe(false);
  });
});

describe("historiqueDeConstats", () => {
  it("regroupe par jour, sépare défauts et observations, confirmés et proposés, et écarte les rejetés en le disant", () => {
    const h = historiqueDeConstats([
      defaut("NID", 3, "VALIDE", 10), defaut("NID", 2, "A_VALIDER", 10), obs("DEGRADATION", "FORTE", "PROPOSEE", 10),
      obs("ASSAINISSEMENT", "FAIBLE", "VALIDEE", 3), defaut("FISSURE", 1, "REJETE", 3), obs("AUTRE", null, "REJETEE", 2),
    ]);
    expect(h).toMatchObject({ total: 4, defauts: 2, observations: 2, confirmes: 2, proposes: 2, rejetesEcartes: 2 });
    expect(h.parJour).toEqual([
      { date: jour(10).toISOString().slice(0, 10), defauts: 2, observations: 1, graves: 2, confirmes: 1, proposes: 2 },
      { date: jour(3).toISOString().slice(0, 10), defauts: 0, observations: 1, graves: 0, confirmes: 1, proposes: 0 },
    ]);
    expect(h.premierConstat).toBe(jour(10).toISOString().slice(0, 10));
    expect(h.dernierConstat).toBe(jour(3).toISOString().slice(0, 10));
  });

  it("une récurrence exige deux JOURS distincts : deux constats le même jour n'en font pas une", () => {
    expect(historiqueDeConstats([defaut("NID", 2, "VALIDE", 5), defaut("NID", 3, "VALIDE", 5)]).recurrents).toEqual([]);
    const h = historiqueDeConstats([defaut("NID", 2, "VALIDE", 40), defaut("NID", 3, "VALIDE", 5), defaut("NID", 3, "VALIDE", 5)]);
    expect(h.recurrents).toEqual([{ cle: "DEFAUT:NID", libelle: "NID", nature: "DEFAUT", nbDates: 2, premiereFois: jour(40).toISOString().slice(0, 10), derniereFois: jour(5).toISOString().slice(0, 10), nbConstats: 3 }]);
  });

  it("un défaut et une observation de même nom ne se confondent pas", () => {
    const h = historiqueDeConstats([defaut("AUTRE", 1, "VALIDE", 20), obs("AUTRE", null, "PROPOSEE", 5)]);
    expect(h.recurrents).toEqual([]);
  });

  it("un constat rejeté ne fait pas une récurrence", () => {
    expect(historiqueDeConstats([defaut("NID", 2, "VALIDE", 40), defaut("NID", 2, "REJETE", 5)]).recurrents).toEqual([]);
  });

  it("aucun constat : histoire vide, dates nulles", () => {
    expect(historiqueDeConstats([])).toMatchObject({ total: 0, premierConstat: null, dernierConstat: null, parJour: [], recurrents: [] });
  });
});

describe("classerAControler", () => {
  const P = POIDS_PROVISOIRES;

  it("calcule le score à la main et l'explique : graves récents, en attente, récurrences, information ancienne", () => {
    // 2 graves récents (3 chacun = 6), 3 en attente (3 × 1 = 3), 1 récurrence NID (2) : total 11. Dernier constat récent : pas d'ancienneté.
    const r = classerAControler([{
      tronconId: "t1",
      constats: [defaut("NID", 3, "A_VALIDER", 30), defaut("NID", 4, "A_VALIDER", 10), obs("DEGRADATION", "FORTE", "VALIDEE", 5), obs("ASSAINISSEMENT", "FAIBLE", "PROPOSEE", 5)],
    }], MAINTENANT);
    // graves récents : NID 3, NID 4, DEGRADATION FORTE = 3 ; en attente : 3 (deux défauts A_VALIDER + une observation PROPOSEE) ; récurrences : NID (2 dates) = 1
    expect(r.lignes).toHaveLength(1);
    const l = r.lignes[0];
    expect(l.facteurs.map((f) => [f.facteur, f.nombre, f.points])).toEqual([["constats_graves", 3, 9], ["constats_en_attente", 3, 3], ["recurrences", 1, 2]]);
    expect(l.score).toBe(14);
    expect(l.explication).toContain("3 constat(s) grave(s)");
    expect(l.explication.endsWith("total 14.")).toBe(true);
    expect(r.poids.provenance).toBe("PROVISOIRE_NON_CALIBRE");
  });

  it("un grave plus ancien que la fenêtre ne compte plus comme grave récent, et une information trop vieille ajoute son facteur", () => {
    const r = classerAControler([{ tronconId: "t1", constats: [defaut("NID", 4, "VALIDE", P.joursFenetreRecente + 10), defaut("FISSURE", 1, "VALIDE", P.joursSansConstat + 5)] }], MAINTENANT);
    // Dernier constat = il y a 190 jours : pas ancien (< 365). Graves récents : 0. En attente : 0. Récurrence : 0 => score 0, écarté.
    expect(r.lignes).toEqual([]);
    expect(r.ecartesSansPoints).toBe(1);
    const vieux = classerAControler([{ tronconId: "t2", constats: [defaut("NID", 4, "VALIDE", P.joursSansConstat + 5)] }], MAINTENANT);
    expect(vieux.lignes[0].facteurs.map((f) => f.facteur)).toEqual(["information_ancienne"]);
    expect(vieux.lignes[0].score).toBe(P.siInformationAncienne);
  });

  it("un défaut traité ou disparu n'est plus présent : il ne pèse pas dans « à contrôler maintenant »", () => {
    const r = classerAControler([{ tronconId: "t1", constats: [defaut("NID", 4, "A_VALIDER", 5, "TRAITE"), defaut("FISSURE", 3, "A_VALIDER", 5, "DISPARU")] }], MAINTENANT);
    expect(r.lignes).toEqual([]);
  });

  it("un constat rejeté ne pèse pas ; un tronçon sans constat n'est pas classé et est compté à part", () => {
    const r = classerAControler([
      { tronconId: "t1", constats: [defaut("NID", 4, "REJETE", 5)] },
      { tronconId: "t2", constats: [] },
    ], MAINTENANT);
    expect(r.lignes).toEqual([]);
    expect(r.sansConstat).toBe(2);
  });

  it("classement reproductible : par score décroissant, égalités départagées par le constat le plus récent puis l'identifiant", () => {
    const un = (id: string, jours: number) => ({ tronconId: id, constats: [obs("DEGRADATION", "FORTE", "VALIDEE", jours)] });
    const r = classerAControler([un("b", 10), un("a", 10), un("c", 2), { tronconId: "z", constats: [defaut("NID", 4, "A_VALIDER", 1), obs("DEGRADATION", "FORTE", "PROPOSEE", 1)] }], MAINTENANT);
    expect(r.lignes.map((l) => l.tronconId)).toEqual(["z", "c", "a", "b"]);
    expect(classerAControler([un("a", 10), un("b", 10), un("c", 2)], MAINTENANT).lignes.map((l) => l.tronconId)).toEqual(["c", "a", "b"]);
  });

  it("des poids passés en paramètre changent le résultat, et sont rendus avec lui", () => {
    const entree = [{ tronconId: "t1", constats: [obs("DEGRADATION", "FORTE", "VALIDEE", 5)] }];
    const r = classerAControler(entree, MAINTENANT, { ...POIDS_PROVISOIRES, parConstatGrave: 10 });
    expect(r.lignes[0].score).toBe(10);
    expect(r.poids.parConstatGrave).toBe(10);
  });
});
