import { describe, expect, it } from "vitest";
import {
  ACTIONS, CORRESPONDANCE_CAHIER, DEFINITION_ACTIONS, MATRICE_DEFAUT, PROFILS, autorise, droitsDe, estDecideurProfil, lireMatrice, profilEffectif,
} from "./profils.noyau";

describe("profil effectif : jamais de role global parallele", () => {
  it("un compte avec un rattachement actif est REFERENT, quel que soit son role technique", () => {
    for (const r of ["ADMIN", "GESTIONNAIRE", "INSPECTEUR", "LECTEUR"]) expect(profilEffectif(r, true)).toBe("REFERENT");
  });

  it("sans rattachement, le profil est le role technique ; un role inconnu est un LECTEUR (echec ferme)", () => {
    expect(profilEffectif("ADMIN", false)).toBe("ADMIN");
    expect(profilEffectif("GESTIONNAIRE", false)).toBe("GESTIONNAIRE");
    expect(profilEffectif("INSPECTEUR", false)).toBe("INSPECTEUR");
    expect(profilEffectif("LECTEUR", false)).toBe("LECTEUR");
    expect(profilEffectif("SUPER_ROOT", false)).toBe("LECTEUR");
    expect(profilEffectif("", false)).toBe("LECTEUR");
  });

  it("seuls ADMIN et GESTIONNAIRE decident", () => {
    expect(PROFILS.filter(estDecideurProfil)).toEqual(["ADMIN", "GESTIONNAIRE"]);
  });
});

describe("matrice par defaut (prudente, provisoire)", () => {
  it("couvre chaque action, avec ADMIN toujours present", () => {
    for (const a of ACTIONS) expect(MATRICE_DEFAUT[a], a).toContain("ADMIN");
  });

  it("un observateur ou un auditeur (LECTEUR) n'a aucun droit par defaut ; un referent ne gere ni ne valide rien", () => {
    expect(droitsDe(MATRICE_DEFAUT, "LECTEUR")).toEqual([]);
    expect(droitsDe(MATRICE_DEFAUT, "REFERENT").sort()).toEqual(["preuve.ajouter", "tache.executer", "workflow.lire"]);
  });

  it("un agent de terrain execute ses taches et ajoute des preuves, sans lire le workflow ni rien ecrire d'autre", () => {
    expect(droitsDe(MATRICE_DEFAUT, "INSPECTEUR").sort()).toEqual(["preuve.ajouter", "tache.executer"]);
  });

  it("un gestionnaire ecrit le workflow mais ne valide pas un recolement et ne gere pas les referents", () => {
    const d = droitsDe(MATRICE_DEFAUT, "GESTIONNAIRE");
    expect(d).toEqual(expect.arrayContaining(["demande.ecrire", "tache.gerer", "recolement.ecrire", "workflow.lire", "referent.lire"]));
    expect(d).not.toContain("recolement.valider");
    expect(d).not.toContain("referent.gerer");
  });

  it("poser ou revoquer un rattachement est reserve a l'ADMIN", () => {
    expect(MATRICE_DEFAUT["referent.gerer"]).toEqual(["ADMIN"]);
    expect(autorise(MATRICE_DEFAUT, "referent.gerer", "GESTIONNAIRE")).toBe(false);
  });

  it("chaque action a un libelle et la correspondance du cahier couvre les sept roles", () => {
    for (const a of ACTIONS) expect(DEFINITION_ACTIONS[a].libelle.length, a).toBeGreaterThan(10);
    expect(CORRESPONDANCE_CAHIER.map((l) => l.roleCahier)).toEqual(expect.arrayContaining([
      "Administrateur BDRI", "Gestionnaire de projet AGEROUTE", "Referent concessionnaire", "Responsable de validation AGEROUTE", "Auditeur", "Agent terrain", "Observateur / lecture seule",
    ]));
    // Aucun nouveau role technique : tous les comptes proposes sont des roles existants.
    expect(CORRESPONDANCE_CAHIER.every((l) => /^(ADMIN|GESTIONNAIRE|LECTEUR|INSPECTEUR)/.test(l.compte))).toBe(true);
  });
});

describe("configuration PROJETS_VOIRIE_WORKFLOW_MATRICE : jamais plus ouverte que ce que le code permet", () => {
  it("absente ou vide : le defaut, sans avertissement", () => {
    expect(lireMatrice(undefined)).toEqual({ matrice: MATRICE_DEFAUT, avertissements: [] });
    expect(lireMatrice("  ")).toEqual({ matrice: MATRICE_DEFAUT, avertissements: [] });
  });

  it("illisible, ou pas un objet : le defaut et un avertissement", () => {
    for (const brut of ["{pas du json", "[]", "42", "null", '"x"']) {
      const l = lireMatrice(brut);
      expect(l.matrice, brut).toEqual(MATRICE_DEFAUT);
      expect(l.avertissements.length, brut).toBe(1);
    }
  });

  it("une entree valide remplace la liste de l'action, ADMIN est ajoute d'office, les doublons sont retires", () => {
    const l = lireMatrice(JSON.stringify({ "recolement.valider": ["GESTIONNAIRE", "GESTIONNAIRE"], "workflow.lire": ["LECTEUR"] }));
    expect(l.avertissements).toEqual([]);
    expect(l.matrice["recolement.valider"]).toEqual(["ADMIN", "GESTIONNAIRE"]);
    expect(l.matrice["workflow.lire"]).toEqual(["ADMIN", "LECTEUR"]);
    // Le reste est inchange.
    expect(l.matrice["tache.gerer"]).toEqual(MATRICE_DEFAUT["tache.gerer"]);
  });

  it("on ne peut pas retirer ADMIN : une liste vide donne ADMIN seul", () => {
    expect(lireMatrice(JSON.stringify({ "demande.ecrire": [] })).matrice["demande.ecrire"]).toEqual(["ADMIN"]);
  });

  it("action inconnue, non configurable, profil inconnu ou non candidat : l'entree est ignoree avec un avertissement, le defaut s'applique", () => {
    const cas: Record<string, unknown> = {
      "action.inconnue": ["ADMIN"],
      "referent.gerer": ["GESTIONNAIRE"],
      "referent.lire": ["LECTEUR"],
      "demande.ecrire": ["REFERENT"],
      "tache.gerer": ["INSPECTEUR"],
      "recolement.ecrire": ["LECTEUR"],
      "recolement.valider": ["SUPER_ROOT"],
      "workflow.lire": "LECTEUR",
      "preuve.ajouter": [42],
    };
    for (const [action, valeur] of Object.entries(cas)) {
      const l = lireMatrice(JSON.stringify({ [action]: valeur }));
      expect(l.avertissements.length, action).toBe(1);
      expect(l.matrice, action).toEqual(MATRICE_DEFAUT);
    }
  });

  it("un referent ne peut jamais recevoir referent.*, demande.ecrire, tache.gerer ni recolement.* (candidats fixes dans le code)", () => {
    for (const a of ["referent.gerer", "referent.lire", "demande.ecrire", "tache.gerer", "recolement.ecrire", "recolement.valider"] as const) {
      expect(DEFINITION_ACTIONS[a].candidats === null || !DEFINITION_ACTIONS[a].candidats.includes("REFERENT"), a).toBe(true);
    }
  });

  it("une liste demesuree est ignoree (borne)", () => {
    const l = lireMatrice(JSON.stringify({ "workflow.lire": Array(50).fill("LECTEUR") }));
    expect(l.matrice).toEqual(MATRICE_DEFAUT);
    expect(l.avertissements.length).toBe(1);
  });
});
