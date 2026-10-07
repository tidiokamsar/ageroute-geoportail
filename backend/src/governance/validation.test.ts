import { describe, expect, it } from "vitest";
import {
  validationPermise, transitionPermise, comptePourLeReseauNational,
  TRANSITIONS, ENTITES_VALIDABLES, ROLES_VALIDATEURS, PERIMETRES_PUBLIES, EXPLICATIONS,
  type DemandeValidation, type StatutValidation, type PerimetreReseau,
} from "./validation";

/**
 * La porte entre donnee presente et donnee officielle.
 *
 * CE QUE CES TESTS DEFENDENT
 *
 * Deux situations mesurees sur la production ont motive cette couche :
 *
 *   - 81 ouvrages issus du document DTOAA sont publics, 78 en confiance HIGH, aucun ne
 *     porte de marqueur de validation. Rien ne distingue un ouvrage releve et contredit
 *     d'un ouvrage lu dans un PDF.
 *
 *   - 7 troncons hors du territoire guineen sont comptes dans les 21 157 km publies,
 *     parce que leur exclusion repose sur un prefixe de chaine et non sur un statut.
 *
 * Le danger n'est pas qu'une validation echoue : cela se voit. Le danger est qu'un
 * objet non valide se presente comme officiel, ou qu'un objet valide soit compte dans
 * un perimetre auquel il n'appartient pas. Ces tests defendent ces deux silences.
 */

const d = (p: Partial<DemandeValidation> = {}): DemandeValidation => ({
  entityType: "Ouvrage",
  statutActuel: "A_VALIDER",
  auteurId: "agent-1",
  validateurId: "gestionnaire-1",
  validateurRole: "GESTIONNAIRE",
  decision: "VALIDE",
  ...p,
});

describe("Un seul etat d'attente, pour toutes les origines", () => {
  it("mene un objet en attente vers les trois issues", () => {
    expect(TRANSITIONS.A_VALIDER).toEqual(["VALIDE", "REJETE", "A_CORRIGER"]);
  });

  it("renvoie une correction vers une nouvelle attente", () => {
    expect(transitionPermise("A_CORRIGER", "A_VALIDER")).toBe(true);
  });

  it("NE DEVALIDE JAMAIS", () => {
    // Une donnee officielle a pu etre lue, citee, chiffree, inscrite dans un marche.
    // La devalider en silence reecrirait l'histoire.
    expect(TRANSITIONS.VALIDE).toEqual([]);
  });

  it("ferme le rejet, puisque A_CORRIGER existe pour reprendre", () => {
    expect(TRANSITIONS.REJETE).toEqual([]);
  });

  it("n'expose aucun second etat d'attente", () => {
    // Deux noms pour « en attente » obligeraient chaque requete a ecrire une liste, et
    // un oubli quelque part laisserait passer pour officiel ce qui ne l'est pas.
    const etats = Object.keys(TRANSITIONS) as StatutValidation[];
    const enAttente = etats.filter((e) => TRANSITIONS[e].includes("VALIDE"));
    expect(enAttente).toEqual(["A_VALIDER"]);
  });

  it("refuse tout retour sur soi-meme et tout statut inconnu", () => {
    for (const s of Object.keys(TRANSITIONS)) {
      expect(transitionPermise(s, s), `${s} vers lui-meme`).toBe(false);
    }
    expect(transitionPermise("IMPORTE", "VALIDE")).toBe(false);
    expect(transitionPermise("PROPOSE", "VALIDE")).toBe(false);
  });
});

describe("Nul ne rend officiel ce qu'il a produit", () => {
  it("refuse l'auto-validation, meme a un ADMIN", () => {
    // Le role le plus eleve n'y change rien : la separation protege la donnee, pas la
    // hierarchie.
    expect(validationPermise(d({ auteurId: "x", validateurId: "x", validateurRole: "ADMIN" })))
      .toEqual({ permis: false, motif: "AUTO_VALIDATION" });
  });

  it("refuse aussi l'auto-rejet", () => {
    // Se rejeter soi-meme parait inoffensif, mais cela permettrait de faire disparaitre
    // un constat genant sans qu'un tiers l'ait vu.
    expect(validationPermise(d({
      auteurId: "x", validateurId: "x", decision: "REJETE", commentaire: "erreur",
    }))).toEqual({ permis: false, motif: "AUTO_VALIDATION" });
  });

  it("laisse valider un import sans auteur identifie", () => {
    // LE cas des 81 ouvrages DTOAA : ils viennent d'un document, pas d'une personne. La
    // separation des roles n'a personne a opposer au validateur, et la faire jouer quand
    // meme rendrait ces 81 ouvrages INVALIDABLES — donc eternellement non officiels et
    // pourtant publics, c'est-a-dire exactement le probleme qu'on corrige.
    for (const auteur of [null, undefined]) {
      expect(validationPermise(d({ auteurId: auteur, validateurId: "gestionnaire-1" })).permis,
        String(auteur)).toBe(true);
    }
  });

  it("nomme l'auto-validation AVANT la transition", () => {
    expect(validationPermise(d({ auteurId: "x", validateurId: "x", statutActuel: "VALIDE" })))
      .toEqual({ permis: false, motif: "AUTO_VALIDATION" });
  });
});

describe("Qui a le droit de trancher", () => {
  it("laisse trancher un GESTIONNAIRE et un ADMIN", () => {
    for (const role of ["GESTIONNAIRE", "ADMIN"]) {
      expect(validationPermise(d({ validateurRole: role })).permis, role).toBe(true);
    }
  });

  it("refuse a un agent de terrain et a un lecteur", () => {
    for (const role of ["INSPECTEUR", "LECTEUR"]) {
      expect(validationPermise(d({ validateurRole: role })), role)
        .toEqual({ permis: false, motif: "ROLE_INSUFFISANT" });
    }
  });

  it("refuse un role inconnu plutot que de le laisser passer", () => {
    // Le cahier des charges decrit neuf roles metier, le systeme en connait quatre. Un
    // cinquieme ajoute demain doit tomber du cote restreint sans qu'on y pense.
    expect(validationPermise(d({ validateurRole: "CHEF_DE_SERVICE" })).permis).toBe(false);
    expect(ROLES_VALIDATEURS.has("CHEF_DE_SERVICE")).toBe(false);
  });
});

describe("Toutes les entites du patrimoine, et elles seules", () => {
  it("couvre les objets nommes par la decision", () => {
    for (const e of ["Troncon", "Ouvrage", "Defaut", "Observation", "PointNoir", "Poste", "Chantier"]) {
      expect(ENTITES_VALIDABLES.has(e), e).toBe(true);
      expect(validationPermise(d({ entityType: e })).permis, e).toBe(true);
    }
  });

  it("refuse une table de parametrage", () => {
    // L'y soumettre produirait une file d'attente que personne ne traiterait, et cette
    // file finirait par faire ignorer les vraies validations.
    for (const e of ["User", "Region", "MatriceDegradation", "AuditLog"]) {
      expect(validationPermise(d({ entityType: e })), e)
        .toEqual({ permis: false, motif: "ENTITE_NON_VALIDABLE" });
    }
  });

  it("nomme l'entite non validable en premier", () => {
    // Avant meme le role : une entite hors perimetre n'a pas de validateur legitime, et
    // repondre « role insuffisant » enverrait chercher un droit qui n'existe pas.
    expect(validationPermise(d({ entityType: "Region", validateurRole: "LECTEUR" })))
      .toEqual({ permis: false, motif: "ENTITE_NON_VALIDABLE" });
  });
});

describe("Un refus dit ce qu'il reproche", () => {
  it("exige un commentaire pour un rejet et pour une demande de correction", () => {
    expect(validationPermise(d({ decision: "REJETE" })))
      .toEqual({ permis: false, motif: "COMMENTAIRE_REQUIS" });
    expect(validationPermise(d({ decision: "A_CORRIGER" })))
      .toEqual({ permis: false, motif: "COMMENTAIRE_REQUIS" });
  });

  it("ne se contente pas d'espaces", () => {
    expect(validationPermise(d({ decision: "REJETE", commentaire: "   " })).permis).toBe(false);
  });

  it("n'exige aucun commentaire pour une validation", () => {
    expect(validationPermise(d({ decision: "VALIDE" })).permis).toBe(true);
  });
});

describe("Perimetre statistique : validation et territoire sont deux axes", () => {
  it("compte le reseau national", () => {
    expect(comptePourLeReseauNational("NATIONAL")).toBe(true);
  });

  it("exclut les troncons hors territoire", () => {
    // Les 7 troncons de 72 km encore comptes dans les 21 157 km publies.
    expect(comptePourLeReseauNational("HORS_TERRITOIRE_NATIONAL")).toBe(false);
  });

  it("exclut la voirie locale", () => {
    expect(comptePourLeReseauNational("VOIRIE_LOCALE")).toBe(false);
  });

  it("compte un perimetre absent comme national", () => {
    // Choix INVERSE de celui fait pour la validation, et pour une raison opposee : ici
    // l'omission est une absence de classement, pas une absence de decision. Exclure
    // par defaut effacerait les 1 691 troncons du reseau classe, qui existaient avant
    // ce champ.
    expect(comptePourLeReseauNational(null)).toBe(true);
    expect(comptePourLeReseauNational(undefined)).toBe(true);
  });

  it("exclut un perimetre inconnu plutot que de le compter", () => {
    // Une valeur presente et non reconnue est un classement qu'on ne sait pas lire : la
    // compter dans un chiffre publie serait pire que de l'omettre.
    expect(comptePourLeReseauNational("TRANSFRONTALIER")).toBe(false);
  });

  it("ne publie qu'un seul perimetre", () => {
    expect([...PERIMETRES_PUBLIES]).toEqual(["NATIONAL"] as PerimetreReseau[]);
  });

  it("n'oppose pas le perimetre a la validation", () => {
    // Un troncon malien a la frontiere est une donnee juste et hors perimetre. Le
    // marquer REJETE serait faux : il existe, il n'est simplement pas guineen.
    expect(validationPermise(d({ entityType: "Troncon", decision: "VALIDE" })).permis).toBe(true);
  });
});

describe("Les refus s'expliquent a un agent, pas a un developpeur", () => {
  it("donne un message pour chaque motif", () => {
    const motifs = [
      "ENTITE_NON_VALIDABLE", "ROLE_INSUFFISANT", "AUTO_VALIDATION",
      "TRANSITION_INTERDITE", "COMMENTAIRE_REQUIS",
    ] as const;
    for (const x of motifs) {
      expect(EXPLICATIONS[x].length, x).toBeGreaterThan(20);
      // Ni code, ni jargon : ces phrases s'affichent sur un telephone, en mission.
      expect(EXPLICATIONS[x], x).not.toMatch(/_|\bundefined\b|\bnull\b|[A-Z]{4,}/);
    }
  });
});
