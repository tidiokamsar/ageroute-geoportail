import { describe, expect, it } from "vitest";
import {
  decider, resolutionAutomatiquePossible, delaiAvantReessai,
  ENTITES_PATRIMONIALES,
  type OperationEntrante, type EtatObserve,
} from "./sync";

/**
 * Le protocole de synchronisation, cas par cas.
 *
 * CE QUE CES TESTS DEFENDENT
 *
 * Les six cas de la section 15 du cahier des charges, et surtout celui qui n'a pas
 * l'air d'un cas : la REPONSE PERDUE. Le serveur enregistre, l'accuse n'arrive pas,
 * le client conclut a l'echec et reessaie. Sans idempotence, chaque coupure produit
 * un doublon — et sur un reseau guineen les coupures ne sont pas l'exception.
 *
 * Ce projet l'a deja paye deux fois : `Inspection.clientInspectionId` a ete ajoute
 * apres coup pour cette raison, et le 05/09 un import a perdu 349 lignes sur 963
 * parce que la cle d'unicite ne distinguait pas ce qu'elle pretendait distinguer.
 */

const op = (p: Partial<OperationEntrante> = {}): OperationEntrante => ({
  operationId: "op-1", entityType: "Observation", entityId: "e1",
  operation: "UPDATE", baseVersion: 3, payload: {},
  ...p,
});

const etat = (p: EtatObserve = {}): EtatObserve => ({ dejaTraitee: null, versionActuelle: 3, ...p });

describe("Une operation deja traitee ne l'est pas deux fois", () => {
  it("rend le resultat precedent sans rien ecrire", () => {
    const d = decider(op(), etat({ dejaTraitee: { entityId: "e1", statut: "SYNCHRONISE" } }));
    expect(d).toEqual({ action: "REJOUEE", entityId: "e1" });
  });

  it("l'emporte sur TOUT le reste, y compris un conflit apparent", () => {
    // Le piege : la premiere application a elle-meme incremente la version. Reexaminer
    // l'operation la verrait en conflit avec le resultat de sa propre application, et
    // le client recevrait un conflit avec lui-meme. L'idempotence passe donc avant.
    const d = decider(
      op({ baseVersion: 3 }),
      etat({ dejaTraitee: { entityId: "e1", statut: "SYNCHRONISE" }, versionActuelle: 4 }),
    );
    expect(d.action).toBe("REJOUEE");
  });

  it("vaut aussi pour une creation rejouee", () => {
    const d = decider(
      op({ operation: "CREATE", baseVersion: null }),
      etat({ dejaTraitee: { entityId: "e1", statut: "SYNCHRONISE" }, versionActuelle: 1 }),
    );
    expect(d.action).toBe("REJOUEE");
  });
});

describe("Creation", () => {
  it("accepte ce qui n'existe pas", () => {
    expect(decider(op({ operation: "CREATE", baseVersion: null }), etat({ versionActuelle: null })))
      .toEqual({ action: "CREER" });
  });

  it("met en conflit deux creations du meme objet par deux appareils", () => {
    // operationId neuf mais entite deja la : ce n'est pas un rejeu, ce sont deux
    // agents qui ont cree le meme ouvrage hors ligne. En departager un revient a
    // perdre le travail de l'autre.
    const d = decider(op({ operation: "CREATE", baseVersion: null }), etat({ versionActuelle: 1 }));
    expect(d).toEqual({ action: "CONFLIT", motif: "DEJA_EXISTANTE" });
  });
});

describe("Modification", () => {
  it("applique quand la version de depart correspond", () => {
    expect(decider(op({ baseVersion: 3 }), etat({ versionActuelle: 3 })))
      .toEqual({ action: "APPLIQUER", versionSuivante: 4 });
  });

  it("met en CONFLIT une version perimee, sans jamais ecraser", () => {
    // Le cas central. L'agent est parti avec la version 3, quelqu'un a publie la 4
    // pendant sa mission. Appliquer effacerait ce travail sans trace.
    expect(decider(op({ baseVersion: 3 }), etat({ versionActuelle: 5 })))
      .toEqual({ action: "CONFLIT", motif: "VERSION_PERIMEE" });
  });

  it("met en conflit meme une version plus RECENTE que le serveur", () => {
    // Une version superieure ne veut pas dire « plus a jour » : elle veut dire que
    // les historiques ont diverge. La traiter comme valable ferait confiance a
    // l'horloge d'un telephone.
    expect(decider(op({ baseVersion: 7 }), etat({ versionActuelle: 5 })).action).toBe("CONFLIT");
  });

  it("refuse de modifier ce qui n'existe plus", () => {
    // L'objet a ete supprime pendant que l'agent etait hors ligne. Le recreer
    // annulerait silencieusement la suppression.
    expect(decider(op(), etat({ versionActuelle: null })))
      .toEqual({ action: "REFUSER", motif: "ENTITE_INTROUVABLE" });
  });

  it("refuse une modification sans version de depart", () => {
    // Sans elle, impossible de savoir si l'agent a modifie la valeur courante ou une
    // valeur perimee. Refuser vaut mieux que parier.
    expect(decider(op({ baseVersion: null }), etat()))
      .toEqual({ action: "REFUSER", motif: "VERSION_MANQUANTE" });
    expect(decider(op({ baseVersion: undefined }), etat()).action).toBe("REFUSER");
  });

  it("traite la version 0 comme une version, pas comme une absence", () => {
    // `baseVersion: 0` est falsy. Un test ecrit avec `!op.baseVersion` rejetterait une
    // operation parfaitement valide, et personne ne saurait pourquoi.
    expect(decider(op({ baseVersion: 0 }), etat({ versionActuelle: 0 })))
      .toEqual({ action: "APPLIQUER", versionSuivante: 1 });
  });
});

describe("Une donnee patrimoniale ne s'ecrase jamais toute seule", () => {
  it("nomme les entites concernees", () => {
    for (const e of ["Troncon", "Ouvrage", "Chantier", "PointNoir", "Poste"]) {
      expect(ENTITES_PATRIMONIALES.has(e), `${e} devrait etre patrimonial`).toBe(true);
      expect(resolutionAutomatiquePossible(e)).toBe(false);
    }
  });

  it("laisse une observation resoluble automatiquement", () => {
    // Une observation est une PROPOSITION (section 10), pas de la donnee officielle :
    // elle ne porte pas le meme risque.
    expect(resolutionAutomatiquePossible("Observation")).toBe(true);
  });
});

describe("Le reessai attend, mais pas indefiniment", () => {
  it("croit avec les tentatives", () => {
    const d = [0, 1, 2, 3].map((n) => delaiAvantReessai(n, 0));
    for (let i = 1; i < d.length; i++) expect(d[i]).toBeGreaterThan(d[i - 1]);
  });

  it("PLAFONNE a cinq minutes", () => {
    // Sans plafond, dix echecs feraient attendre des heures et l'agent croirait la
    // synchronisation terminee alors qu'elle dort.
    expect(delaiAvantReessai(20, 0)).toBe(5 * 60 * 1000);
    expect(delaiAvantReessai(50, 1)).toBeLessThanOrEqual(5 * 60 * 1000 * 1.3);
  });

  it("disperse les appareils entre eux", () => {
    // Tous les telephones d'une mission retrouvent le reseau au meme virage. Sans
    // dispersion, ils reessaient a la seconde pres et se refusent mutuellement.
    expect(delaiAvantReessai(3, 0)).not.toBe(delaiAvantReessai(3, 1));
    expect(delaiAvantReessai(3, 1) / delaiAvantReessai(3, 0)).toBeCloseTo(1.3, 1);
  });

  it("ne rend jamais un delai negatif ou nul", () => {
    for (const n of [-5, 0, 1]) expect(delaiAvantReessai(n, 0)).toBeGreaterThan(0);
  });
});
