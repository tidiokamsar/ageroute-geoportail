import { describe, expect, it } from "vitest";
import { donneesHistoriqueVisibles, donneesReseauLisibles, dossierVisible, jeuLisible } from "./visibilite.noyau";

const STATUTS = ["RECU", "CONTROLE", "AUTORISE", "REJETE", "REMPLACE", "RETIRE"] as const;
const DECIDEURS = ["ADMIN", "GESTIONNAIRE"];
const AUTRES = ["LECTEUR", "INSPECTEUR", "OPERATEUR", "role-inconnu", ""];

describe("revue RC-3, M1 : lisibilite d'un dossier selon le statut du jeu dont il depend", () => {
  it("un jeu RETIRE n'est montre a PERSONNE : ni donnees du reseau, meme pour ADMIN et GESTIONNAIRE", () => {
    for (const r of [...DECIDEURS, ...AUTRES]) {
      expect(donneesReseauLisibles(r, ["RETIRE"]), r).toBe(false);
      expect(jeuLisible(r, "RETIRE"), r).toBe(false);
    }
  });

  it("un jeu autre qu'AUTORISE (recu, controle, rejete, REMPLACE) n'est montre qu'a ADMIN et GESTIONNAIRE", () => {
    for (const s of STATUTS.filter((x) => x !== "AUTORISE" && x !== "RETIRE")) {
      for (const r of DECIDEURS) expect(donneesReseauLisibles(r, [s]), `${r} ${s}`).toBe(true);
      for (const r of AUTRES) expect(donneesReseauLisibles(r, [s]), `${r} ${s}`).toBe(false);
    }
  });

  it("un jeu AUTORISE est montre a tout compte ; aucun jeu lie (ni reseau ni axes) : tout est lisible", () => {
    for (const r of [...DECIDEURS, ...AUTRES]) {
      expect(donneesReseauLisibles(r, ["AUTORISE"]), r).toBe(true);
      expect(donneesReseauLisibles(r, []), r).toBe(true);
      expect(jeuLisible(r, null), r).toBe(true);
    }
  });

  it("DOSSIER VISIBLE : un compte qui ne decide pas ne voit que les dossiers dont CHAQUE jeu est AUTORISE ; un decideur voit toujours le dossier (archive)", () => {
    for (const s of STATUTS) {
      for (const r of DECIDEURS) expect(dossierVisible(r, [s]), `${r} ${s}`).toBe(true);
      for (const r of AUTRES) expect(dossierVisible(r, [s]), `${r} ${s}`).toBe(s === "AUTORISE");
    }
    expect(dossierVisible("LECTEUR", [])).toBe(true);
    expect(dossierVisible("LECTEUR", ["AUTORISE", "REMPLACE"])).toBe(false);
    expect(dossierVisible("LECTEUR", ["AUTORISE", "AUTORISE"])).toBe(true);
  });

  it("deux jeux lies (reseau et plan d'axes) : le plus restrictif l'emporte", () => {
    expect(donneesReseauLisibles("ADMIN", ["AUTORISE", "RETIRE"])).toBe(false);
    expect(donneesReseauLisibles("GESTIONNAIRE", ["REMPLACE", "AUTORISE"])).toBe(true);
    expect(donneesReseauLisibles("LECTEUR", ["REMPLACE", "AUTORISE"])).toBe(false);
  });

  it("un dossier d'un jeu RETIRE reste visible d'un decideur mais SANS donnees du reseau ; il n'est pas visible d'un lecteur", () => {
    expect(dossierVisible("ADMIN", ["RETIRE"])).toBe(true);
    expect(donneesReseauLisibles("ADMIN", ["RETIRE"])).toBe(false);
    expect(dossierVisible("LECTEUR", ["RETIRE"])).toBe(false);
  });
});

describe("details de l'historique selon le compte", () => {
  const calcul = { mesure: { longueurChausseeM: 12 }, jeuReseauId: "jeu-1", motifs: ["PRECISION_INCONNUE"] };

  it("donnees du reseau non lisibles : les lignes du CALCUL perdent leurs details, celles des personnes les gardent", () => {
    for (const a of ["CREATION", "RETROUVE", "MESURE_MODIFIEE", "REEXAMEN"]) {
      expect(donneesHistoriqueVisibles(a, calcul, { role: "ADMIN", reseauLisible: false }), a).toEqual({ masquees: true });
    }
    const humain = { derogationSeparation: "motif de la derogation", decisionId: "d1" };
    for (const a of ["STATUT", "ATTRIBUTION", "PREUVE", "DECISION_PROPOSEE", "DECISION_APPROUVEE", "DECISION_REFUSEE"]) {
      expect(donneesHistoriqueVisibles(a, humain, { role: "ADMIN", reseauLisible: false }), a).toEqual(humain);
    }
  });

  it("un compte qui ne decide pas ne recoit pas l'identifiant du jeu ; un decideur recoit tout (reseau lisible)", () => {
    expect(donneesHistoriqueVisibles("CREATION", calcul, { role: "LECTEUR", reseauLisible: true })).toEqual({ mesure: calcul.mesure, motifs: calcul.motifs });
    expect(donneesHistoriqueVisibles("CREATION", calcul, { role: "GESTIONNAIRE", reseauLisible: true })).toEqual(calcul);
  });

  it("des donnees qui ne sont pas un objet traversent telles quelles", () => {
    expect(donneesHistoriqueVisibles("PREUVE", null, { role: "LECTEUR", reseauLisible: true })).toBeNull();
    expect(donneesHistoriqueVisibles("PREUVE", [1], { role: "LECTEUR", reseauLisible: true })).toEqual([1]);
  });
});
