import { describe, expect, it } from "vitest";
import {
  validationPermise, transitionPermise, TRANSITIONS, ROLES_VALIDATEURS, EXPLICATIONS,
  type DemandeValidation,
} from "./observations.regles";

/**
 * La validation d'une observation : la porte entre proposition et donnee officielle.
 *
 * CE QUE CES TESTS DEFENDENT
 *
 * Point 13 du master prompt : une observation de terrain est une PROPOSITION, elle ne
 * devient officielle qu'apres validation. Point 30 : nul ne doit pouvoir « valider sa
 * propre operation sensible si separation de role requise ».
 *
 * Ces deux phrases se tiennent ou s'effondrent ensemble. Un systeme qui valide mais
 * laisse l'auteur valider lui-meme n'a pas de validation : il a une formalite. Le
 * controle a deux personnes que suppose toute la chaine — defaut, etat, traitement,
 * cout — n'existerait alors que sur le papier, et personne ne s'en apercevrait avant
 * un audit.
 */

const d = (p: Partial<DemandeValidation> = {}): DemandeValidation => ({
  statutActuel: "PROPOSEE",
  agentId: "agent-1",
  validateurId: "gestionnaire-1",
  validateurRole: "GESTIONNAIRE",
  decision: "VALIDEE",
  ...p,
});

describe("Nul ne valide sa propre observation", () => {
  it("refuse l'auto-validation, meme a un ADMIN", () => {
    // Le role le plus eleve n'y change rien : la separation protege la donnee, pas
    // la hierarchie.
    const r = validationPermise(d({ agentId: "x", validateurId: "x", validateurRole: "ADMIN" }));
    expect(r).toEqual({ permis: false, motif: "AUTO_VALIDATION" });
  });

  it("refuse aussi l'auto-rejet", () => {
    // Se rejeter soi-meme parait inoffensif, mais cela permettrait de faire
    // disparaitre une observation genante sans qu'un tiers l'ait vue.
    const r = validationPermise(d({ agentId: "x", validateurId: "x", decision: "REJETEE", motif: "erreur" }));
    expect(r).toEqual({ permis: false, motif: "AUTO_VALIDATION" });
  });

  it("accepte un validateur distinct", () => {
    expect(validationPermise(d())).toEqual({ permis: true });
  });

  it("nomme l'auto-validation AVANT la transition", () => {
    // Un message qui designe la mauvaise cause fait chercher au mauvais endroit : si
    // les deux echouent, c'est l'auto-validation qu'il faut lire.
    const r = validationPermise(d({ agentId: "x", validateurId: "x", statutActuel: "CONVERTIE" }));
    expect(r).toEqual({ permis: false, motif: "AUTO_VALIDATION" });
  });
});

describe("Qui a le droit de trancher", () => {
  it("laisse valider un GESTIONNAIRE et un ADMIN", () => {
    for (const role of ["GESTIONNAIRE", "ADMIN"]) {
      expect(validationPermise(d({ validateurRole: role })).permis, role).toBe(true);
    }
  });

  it("refuse a un agent de terrain", () => {
    // Un INSPECTEUR propose, il ne valide pas. C'est la raison d'etre de la chaine.
    const r = validationPermise(d({ validateurRole: "INSPECTEUR" }));
    expect(r).toEqual({ permis: false, motif: "ROLE_INSUFFISANT" });
  });

  it("refuse a un LECTEUR", () => {
    expect(validationPermise(d({ validateurRole: "LECTEUR" })).permis).toBe(false);
  });

  it("refuse un role inconnu plutot que de le laisser passer", () => {
    // Le cahier des charges decrit neuf roles metier, le systeme en connait quatre.
    // Un cinquieme ajoute demain doit tomber du cote restreint sans qu'on y pense.
    expect(validationPermise(d({ validateurRole: "CHEF_DE_SERVICE" })).permis).toBe(false);
    expect(ROLES_VALIDATEURS.has("CHEF_DE_SERVICE")).toBe(false);
  });
});

describe("Un rejet dit ce qu'il reproche", () => {
  it("exige un motif", () => {
    // Sans motif, l'agent ignore ce qu'on lui demande de corriger et represente la
    // meme chose : le rejet ne sert a rien et la boucle tourne.
    const r = validationPermise(d({ decision: "REJETEE" }));
    expect(r).toEqual({ permis: false, motif: "MOTIF_REQUIS" });
  });

  it("ne se contente pas d'espaces", () => {
    expect(validationPermise(d({ decision: "REJETEE", motif: "   " })).permis).toBe(false);
  });

  it("accepte un motif renseigne", () => {
    expect(validationPermise(d({ decision: "REJETEE", motif: "Photo illisible" })).permis).toBe(true);
  });

  it("n'exige aucun motif pour une validation", () => {
    expect(validationPermise(d({ decision: "VALIDEE" })).permis).toBe(true);
  });
});

describe("Le cycle de vie d'une observation", () => {
  it("mene un brouillon jusqu'a la conversion", () => {
    const chemin = ["BROUILLON", "PROPOSEE", "VALIDEE", "CONVERTIE"];
    for (let i = 1; i < chemin.length; i++) {
      expect(transitionPermise(chemin[i - 1], chemin[i]), `${chemin[i - 1]} vers ${chemin[i]}`).toBe(true);
    }
  });

  it("laisse un rejet revenir en proposition apres correction", () => {
    // REJETEE n'est pas une impasse : c'est le circuit normal d'une donnee qu'on
    // demande de reprendre.
    expect(transitionPermise("REJETEE", "PROPOSEE")).toBe(true);
  });

  it("NE DEVALIDE JAMAIS", () => {
    // Une donnee devenue officielle a pu etre lue, citee, reprise dans un marche. La
    // devalider en silence reecrirait l'histoire ; on produit une nouvelle
    // observation, et les deux restent.
    expect(transitionPermise("VALIDEE", "PROPOSEE")).toBe(false);
    expect(transitionPermise("VALIDEE", "REJETEE")).toBe(false);
  });

  it("ferme la conversion", () => {
    expect(TRANSITIONS.CONVERTIE).toEqual([]);
  });

  it("interdit de valider un brouillon sans le proposer", () => {
    expect(transitionPermise("BROUILLON", "VALIDEE")).toBe(false);
  });

  it("refuse tout retour sur soi-meme", () => {
    for (const s of Object.keys(TRANSITIONS)) {
      expect(transitionPermise(s, s), `${s} vers lui-meme`).toBe(false);
    }
  });
});

describe("Les refus s'expliquent a un agent, pas a un developpeur", () => {
  it("donne un message pour chaque motif", () => {
    for (const m of ["ROLE_INSUFFISANT", "AUTO_VALIDATION", "TRANSITION_INTERDITE", "MOTIF_REQUIS"] as const) {
      expect(EXPLICATIONS[m].length).toBeGreaterThan(20);
      // Ni code, ni jargon : ces phrases s'affichent sur un telephone, en mission.
      expect(EXPLICATIONS[m]).not.toMatch(/_|undefined|null|[A-Z]{4,}/);
    }
  });
});
