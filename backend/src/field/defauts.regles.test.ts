import { describe, expect, it } from "vitest";
import {
  quantite, metrer, mesuresManquantes, statutQualiteQuantite, graviteValide,
  tauxOccupation, transitionEtatPermise,
  TRANSITIONS_ETAT, ETENDUES, GRAVITE_MAX_PAR_DEFAUT, NOMS_MESURES, EXPLICATIONS,
  type MesuresDefaut, type UniteDefaut, type MethodeQuantite,
  type TypeDefaut, type MesureDefaut,
} from "./defauts.regles";

/**
 * La quantite d'un defaut : le premier chiffre dont un cout dependra.
 *
 * CE QUE CES TESTS DEFENDENT
 *
 * Aujourd'hui une degradation se note dans `Inspection.defautsConstates`, en texte
 * libre. Demain elle portera une quantite, et cette quantite remontera telle quelle dans
 * un metre, un prix, un marche. C'est le premier endroit de la chaine ou une erreur
 * devient de l'argent.
 *
 * Un calcul faux se verrait. Ce qui ne se verrait pas, c'est une quantite PLAUSIBLE
 * tiree d'un releve fautif ou incomplet — une largeur saisie a zero qu'on ignore, un
 * ornierage sans profondeur qu'on accepte, un defaut plus long que son troncon. Ces
 * tests defendent surtout les refus.
 */

const m = (p: Partial<MesuresDefaut> = {}): MesuresDefaut => ({ ...p });

/** Types calques sur le catalogue demande, pour tester les cas qui divergent. */
const NID_POULE: TypeDefaut = {
  code: "NID_POULE", unite: "METRE_CUBE",
  mesuresRequises: ["LONGUEUR", "LARGEUR", "PROFONDEUR"], graviteMax: 4,
};
const FISS_LONG: TypeDefaut = {
  code: "FISS_LONG", unite: "METRE", mesuresRequises: ["LONGUEUR"], graviteMax: 4,
};
const FAIENCAGE: TypeDefaut = {
  code: "FAIENCAGE", unite: "METRE_CARRE", mesuresRequises: ["LONGUEUR", "LARGEUR"], graviteMax: 4,
};
/** Le cas qui separe les deux listes : profondeur exigee, metre lineaire. */
const ORNIERAGE: TypeDefaut = {
  code: "ORNIERAGE", unite: "METRE", mesuresRequises: ["LONGUEUR", "PROFONDEUR"], graviteMax: 4,
};
const SIGNALISATION: TypeDefaut = {
  code: "SIGNALISATION", unite: "UNITE", mesuresRequises: ["NOMBRE"], graviteMax: null,
};

describe("Deriver une quantite depuis les mesures du terrain", () => {
  it("compte les defauts qui se comptent", () => {
    expect(quantite(m({ nombre: 12 }), "UNITE")).toEqual({ valeur: 12, methode: "COMPTAGE" });
  });

  it("prend la longueur pour un defaut lineaire", () => {
    // Une fissure se mesure en metres : sa largeur n'interesse personne pour la chiffrer.
    expect(quantite(m({ longueurM: 48.5, largeurM: 0.01 }), "METRE")).toEqual({
      valeur: 48.5, methode: "LONGUEUR",
    });
  });

  it("multiplie longueur par largeur pour une surface", () => {
    // L'exemple du cahier : 4,20 par 1,80 vaut 7,56 m2.
    expect(quantite(m({ longueurM: 4.2, largeurM: 1.8 }), "METRE_CARRE")).toEqual({
      valeur: 7.56, methode: "LONGUEUR_LARGEUR",
    });
  });

  it("multiplie les trois dimensions pour un volume", () => {
    expect(quantite(m({ longueurM: 4, largeurM: 3, profondeurM: 0.25 }), "METRE_CUBE")).toEqual({
      valeur: 3, methode: "LONGUEUR_LARGEUR_PROFONDEUR",
    });
  });

  it("arrondit a trois decimales plutot que d'afficher du bruit", () => {
    // 1,1 fois 1,1 vaut 1,2100000000000002 en flottant. Ce chiffre recopie dans un
    // bordereau ferait douter de tout le reste.
    expect(quantite(m({ longueurM: 1.1, largeurM: 1.1 }), "METRE_CARRE")).toEqual({
      valeur: 1.21, methode: "LONGUEUR_LARGEUR",
    });
  });
});

describe("Le catalogue dit quelles mesures sont exigees", () => {
  it("nomme les mesures manquantes au lieu de dire seulement incomplet", () => {
    // L'agent doit savoir QUOI retourner mesurer. « Releve incomplet » sans precision
    // le renvoie sur place a l'aveugle.
    expect(mesuresManquantes(m({ longueurM: 4 }), NID_POULE.mesuresRequises))
      .toEqual(["LARGEUR", "PROFONDEUR"]);
  });

  it("ne reclame rien quand tout est releve", () => {
    expect(mesuresManquantes(m({ longueurM: 4, largeurM: 3, profondeurM: 0.1 }), NID_POULE.mesuresRequises))
      .toEqual([]);
  });

  it("traite une mesure a zero comme absente", () => {
    expect(mesuresManquantes(m({ longueurM: 4, largeurM: 0 }), FAIENCAGE.mesuresRequises))
      .toEqual(["LARGEUR"]);
  });

  it("donne un nom lisible a chaque mesure", () => {
    const toutes: MesureDefaut[] = ["NOMBRE", "LONGUEUR", "LARGEUR", "PROFONDEUR", "QUANTITE"];
    for (const x of toutes) {
      expect(NOMS_MESURES[x], x).toBeTruthy();
      expect(NOMS_MESURES[x], x).not.toMatch(/[A-Z]{4,}/);
    }
  });
});

describe("Mesures requises et unite du metre sont deux listes distinctes", () => {
  it("exige la profondeur d'un ornierage sans la faire entrer dans son metre", () => {
    // LE cas qui separe les deux notions. La profondeur qualifie la gravite ; le metre
    // reste lineaire. Confondre les listes rendrait un volume la ou on veut des metres.
    expect(metrer(m({ longueurM: 120, profondeurM: 0.04 }), ORNIERAGE))
      .toEqual({ valeur: 120, unite: "METRE", methode: "LONGUEUR" });
  });

  it("refuse un ornierage sans profondeur, alors que son metre serait calculable", () => {
    // Sans profondeur, personne ne pourra classer la gravite ni choisir le traitement.
    // Laisser passer donnerait une quantite juste sur un releve inutilisable.
    expect(metrer(m({ longueurM: 120 }), ORNIERAGE)).toEqual({
      valeur: null, motif: "RELEVE_INCOMPLET", manquantes: ["PROFONDEUR"],
    });
  });

  it("metre un nid-de-poule en volume", () => {
    expect(metrer(m({ longueurM: 1.2, largeurM: 0.8, profondeurM: 0.15 }), NID_POULE))
      .toEqual({ valeur: 0.144, unite: "METRE_CUBE", methode: "LONGUEUR_LARGEUR_PROFONDEUR" });
  });

  it("metre une signalisation au comptage", () => {
    expect(metrer(m({ nombre: 3 }), SIGNALISATION))
      .toEqual({ valeur: 3, unite: "UNITE", methode: "COMPTAGE" });
  });

  it("signale une mesure fausse avant de parler d'incompletude", () => {
    // Un zero compte comme absent : sans cet ordre, une largeur saisie a zero
    // ressortirait en « releve incomplet » et l'agent chercherait une mesure qu'il a
    // pourtant saisie, au lieu de corriger sa valeur.
    expect(metrer(m({ longueurM: 4, largeurM: 0, profondeurM: 0.1 }), NID_POULE)).toEqual({
      valeur: null, motif: "MESURE_ABERRANTE",
    });
  });

  it("transmet le refus de depassement du troncon", () => {
    expect(metrer(m({ longueurM: 2000 }), FISS_LONG, 1940)).toEqual({
      valeur: null, motif: "DEPASSE_LE_TRONCON",
    });
  });
});

describe("Une mesure prise au metre vaut mieux qu'un produit", () => {
  it("prefere la quantite saisie a la derivation", () => {
    // L'agent a mesure 11 m2 au decametre sur une forme irreguliere ; le rectangle
    // 4 par 3 en annonce 12. On garde le constat.
    expect(quantite(m({ quantiteSaisie: 11, longueurM: 4, largeurM: 3 }), "METRE_CARRE")).toEqual({
      valeur: 11, methode: "SAISIE",
    });
  });

  it("marque le constat OBSERVED et le produit DERIVED", () => {
    expect(statutQualiteQuantite("SAISIE")).toBe("OBSERVED");
    expect(statutQualiteQuantite("COMPTAGE")).toBe("OBSERVED");
    for (const d of ["LONGUEUR", "LONGUEUR_LARGEUR", "LONGUEUR_LARGEUR_PROFONDEUR"] as const) {
      expect(statutQualiteQuantite(d), d).toBe("DERIVED");
    }
  });

  it("couvre toutes les methodes connues", () => {
    const toutes: MethodeQuantite[] = [
      "SAISIE", "COMPTAGE", "LONGUEUR", "LONGUEUR_LARGEUR", "LONGUEUR_LARGEUR_PROFONDEUR",
    ];
    for (const x of toutes) expect(["OBSERVED", "DERIVED"]).toContain(statutQualiteQuantite(x));
  });
});

describe("Une mesure fausse fait refuser, elle n'est jamais ignoree", () => {
  it("refuse une largeur a zero au lieu de deriver sans elle", () => {
    // C'est LE cas dangereux. Ignorer la largeur et rendre 4 m2 au lieu de refuser
    // produirait une quantite plausible issue d'une saisie fausse, et plus personne ne
    // pourrait la mettre en doute.
    expect(quantite(m({ longueurM: 4, largeurM: 0 }), "METRE_CARRE")).toEqual({
      valeur: null, motif: "MESURE_ABERRANTE",
    });
  });

  it("refuse une mesure negative", () => {
    expect(quantite(m({ longueurM: -4, largeurM: 3 }), "METRE_CARRE").valeur).toBeNull();
  });

  it("refuse NaN et Infinity", () => {
    // Un champ vide converti par Number() donne NaN, et NaN fois 3 vaut NaN : sans ce
    // garde-fou la base stockerait une quantite NaN.
    expect(quantite(m({ longueurM: Number.NaN, largeurM: 3 }), "METRE_CARRE").valeur).toBeNull();
    expect(quantite(m({ longueurM: Number.POSITIVE_INFINITY, largeurM: 3 }), "METRE_CARRE").valeur).toBeNull();
  });

  it("refuse une mesure fausse meme dans un champ inutile a l'unite demandee", () => {
    // Une profondeur negative sur un defaut surfacique ne sert pas au calcul, mais elle
    // signale une saisie qu'on ne doit pas enregistrer en silence.
    expect(quantite(m({ longueurM: 4, largeurM: 3, profondeurM: -1 }), "METRE_CARRE")).toEqual({
      valeur: null, motif: "MESURE_ABERRANTE",
    });
  });

  it("refuse une quantite saisie a zero plutot que de retomber sur la derivation", () => {
    expect(quantite(m({ quantiteSaisie: 0, longueurM: 4, largeurM: 3 }), "METRE_CARRE")).toEqual({
      valeur: null, motif: "MESURE_ABERRANTE",
    });
  });
});

describe("Un defaut ne depasse pas le troncon qui le porte", () => {
  it("refuse une longueur superieure a celle du troncon", () => {
    // 2 000 m de fissure sur un troncon de 1 940 m : erreur de saisie ou mauvais
    // rattachement. Dans les deux cas la quantite est fausse.
    expect(quantite(m({ longueurM: 2000 }), "METRE", 1940)).toEqual({
      valeur: null, motif: "DEPASSE_LE_TRONCON",
    });
  });

  it("accepte une longueur egale a celle du troncon", () => {
    // Un troncon entierement fissure existe, et c'est meme l'information la plus utile.
    expect(quantite(m({ longueurM: 1940 }), "METRE", 1940).valeur).toBe(1940);
  });

  it("n'oppose pas la longueur du troncon a une SURFACE", () => {
    // 400 m2 sur un troncon de 200 m est banal : une chaussee a plusieurs metres de
    // large. Comparer une surface a une longueur serait une faute d'unite.
    expect(quantite(m({ longueurM: 100, largeurM: 4 }), "METRE_CARRE", 200).valeur).toBe(400);
  });

  it("ne borne rien quand la longueur du troncon est inconnue", () => {
    // Mesure du 07/10/2026 : 1 028 des 1 691 troncons du reseau classe portent une
    // longueur nulle ou absente. Refuser faute de borne bloquerait le terrain la ou il
    // est le plus utile.
    for (const l of [null, undefined, 0]) {
      expect(quantite(m({ longueurM: 5000 }), "METRE", l).valeur, String(l)).toBe(5000);
    }
  });
});

describe("Des mesures insuffisantes rendent null, pas zero", () => {
  it("refuse une surface sans largeur", () => {
    // Rendre 0 serait pire que rendre null : zero se somme, s'affiche, et dit « pas de
    // degradation » la ou on voulait dire « on ne sait pas ».
    expect(quantite(m({ longueurM: 4 }), "METRE_CARRE")).toEqual({
      valeur: null, motif: "MESURES_INSUFFISANTES",
    });
  });

  it("refuse un volume sans profondeur", () => {
    expect(quantite(m({ longueurM: 4, largeurM: 3 }), "METRE_CUBE").valeur).toBeNull();
  });

  it("refuse un comptage sans nombre", () => {
    expect(quantite(m({ longueurM: 4 }), "UNITE").valeur).toBeNull();
  });

  it("refuse des mesures entierement vides, quelle que soit l'unite", () => {
    for (const u of ["UNITE", "METRE", "METRE_CARRE", "METRE_CUBE"] as UniteDefaut[]) {
      expect(quantite(m(), u), u).toEqual({ valeur: null, motif: "MESURES_INSUFFISANTES" });
    }
  });
});

describe("La gravite est un jugement borne", () => {
  it("accepte les quatre crans de l'echelle par defaut", () => {
    expect(GRAVITE_MAX_PAR_DEFAUT).toBe(4);
    for (const g of [1, 2, 3, 4]) expect(graviteValide(g, 4).permis, String(g)).toBe(true);
  });

  it("refuse une gravite hors echelle", () => {
    expect(graviteValide(5, 4)).toEqual({ permis: false, motif: "HORS_ECHELLE" });
    expect(graviteValide(0, 4)).toEqual({ permis: false, motif: "HORS_ECHELLE" });
  });

  it("respecte une echelle plus courte portee par le catalogue", () => {
    // L'echelle est administrable : un type a trois crans doit exister sans toucher au
    // code.
    expect(graviteValide(4, 3)).toEqual({ permis: false, motif: "HORS_ECHELLE" });
    expect(graviteValide(3, 3).permis).toBe(true);
  });

  it("refuse une gravite non entiere", () => {
    // Une gravite 2,5 laisserait croire a une mesure continue alors que l'echelle est un
    // classement en crans.
    expect(graviteValide(2.5, 4)).toEqual({ permis: false, motif: "HORS_ECHELLE" });
  });

  it("refuse une gravite sur un type qui ne se gradue pas", () => {
    // Un panneau manquant est absent ou present. Une gravite 2 remplirait un champ sans
    // rien mesurer.
    expect(graviteValide(2, null)).toEqual({ permis: false, motif: "TYPE_SANS_GRAVITE" });
  });

  it("exige une gravite sur un type gradue", () => {
    expect(graviteValide(null, 4)).toEqual({ permis: false, motif: "GRAVITE_REQUISE" });
    expect(graviteValide(undefined, 4)).toEqual({ permis: false, motif: "GRAVITE_REQUISE" });
  });

  it("accepte l'absence de gravite sur un type non gradue", () => {
    expect(graviteValide(null, null)).toEqual({ permis: true });
  });
});

describe("L'etendue est un axe distinct de la gravite", () => {
  it("offre quatre crans, du ponctuel au generalise", () => {
    expect(ETENDUES).toEqual(["PONCTUEL", "LOCALISE", "ETENDU", "GENERALISE"]);
  });

  it("ne calcule aucun taux sans la largeur du troncon", () => {
    // LE constat qui impose l'echelle qualitative : `Troncon` ne porte que longueurKm,
    // aucune largeur. La surface d'un troncon est inconnue sur tout le reseau, et un
    // taux calcule dessus serait une invention.
    expect(tauxOccupation(2850, 1940, null)).toBeNull();
    expect(tauxOccupation(2850, 1940, undefined)).toBeNull();
    expect(tauxOccupation(2850, 1940, 0)).toBeNull();
  });

  it("calcule le taux le jour ou la largeur existera", () => {
    // 2 850 m2 sur un troncon de 1 000 m par 7 m, soit 7 000 m2 : 40,7 %.
    expect(tauxOccupation(2850, 1000, 7)).toBe(0.407);
  });

  it("laisse voir un taux superieur a 1 au lieu de le borner", () => {
    // Une chaussee degradee a 180 % n'existe pas : c'est une erreur de releve, et la
    // masquer a 100 % la rendrait indetectable.
    expect(tauxOccupation(9000, 1000, 7)).toBeGreaterThan(1);
  });

  it("ne calcule rien sans surface de defaut", () => {
    expect(tauxOccupation(null, 1000, 7)).toBeNull();
  });
});

describe("L'etat physique vit a part de la validation", () => {
  it("mene un defaut actif au traitement", () => {
    expect(transitionEtatPermise("ACTIF", "TRAITE")).toBe(true);
  });

  it("laisse un defaut traite redevenir actif", () => {
    // Une reparation qui ne tient pas est le cas courant. L'interdire obligerait a creer
    // un second defaut au meme endroit, et le patrimoine compterait double.
    expect(transitionEtatPermise("TRAITE", "ACTIF")).toBe(true);
  });

  it("distingue DISPARU de TRAITE", () => {
    // Un ravinement comble par une crue a disparu sans qu'on ait depense un franc. Les
    // confondre fausserait le suivi des travaux realises.
    expect(transitionEtatPermise("ACTIF", "DISPARU")).toBe(true);
    expect(transitionEtatPermise("DISPARU", "TRAITE")).toBe(false);
    expect(transitionEtatPermise("TRAITE", "DISPARU")).toBe(false);
  });

  it("refuse tout retour sur soi-meme et tout etat inconnu", () => {
    for (const e of Object.keys(TRANSITIONS_ETAT)) {
      expect(transitionEtatPermise(e, e), `${e} vers lui-meme`).toBe(false);
    }
    expect(transitionEtatPermise("ARCHIVE", "ACTIF")).toBe(false);
  });

  it("ne comporte aucun etat terminal", () => {
    // Aucun defaut ne se ferme definitivement : une route se redegrade toujours.
    for (const [e, suites] of Object.entries(TRANSITIONS_ETAT)) {
      expect(suites.length, e).toBeGreaterThan(0);
    }
  });
});

describe("Les refus s'expliquent a un agent, pas a un developpeur", () => {
  it("donne un message pour chaque motif", () => {
    const motifs = [
      "MESURES_INSUFFISANTES", "MESURE_ABERRANTE", "DEPASSE_LE_TRONCON", "RELEVE_INCOMPLET",
      "HORS_ECHELLE", "TYPE_SANS_GRAVITE", "GRAVITE_REQUISE",
    ] as const;
    for (const x of motifs) {
      expect(EXPLICATIONS[x].length, x).toBeGreaterThan(20);
      // Ni code, ni jargon : ces phrases s'affichent sur un telephone, en mission.
      expect(EXPLICATIONS[x], x).not.toMatch(/_|\bundefined\b|\bnull\b|[A-Z]{4,}/);
    }
  });
});
