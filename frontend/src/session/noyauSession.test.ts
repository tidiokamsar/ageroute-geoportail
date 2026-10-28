import { describe, expect, it } from "vitest";
import {
  ETATS_SESSION, PARAMETRES_SESSION as P, aReculeHorloge, contexteInitial, delaiApresEchecs, differencesDeDroits,
  estExpire, expirationApres, tentativePinPossible, transition,
  type ContexteSession, type EffetSession, type EtatSession, type EvenementSession,
} from "./noyauSession";

const T0 = 1_790_000_000_000;
const MIN = 60_000;
const JOUR = 24 * 60 * MIN;

/** Contexte d'une session validee en ligne a `T0`, coffre present. */
function ctx(partiel: Partial<ContexteSession> = {}): ContexteSession {
  return contexteInitial({
    coffrePresent: true,
    valideLeMs: T0,
    expireLeMs: T0 + P.dureeMaxMs,
    dernierInstantMs: T0,
    ...partiel,
  });
}

/** Contexte « deverrouille hors ligne a T0 ». */
const ouvert = (partiel: Partial<ContexteSession> = {}) =>
  ctx({ cleEnMemoire: true, derniereActiviteMs: T0, ...partiel });

const motifs = (effets: readonly EffetSession[]) =>
  effets.filter((x): x is Extract<EffetSession, { type: "JOURNALISER" }> => x.type === "JOURNALISER").map((x) => x.motif);
const types = (effets: readonly EffetSession[]) => effets.map((x) => x.type);

describe("parametres provisoires", () => {
  it("portent les valeurs de la conception", () => {
    expect(P.dureeMaxMs).toBe(7 * JOUR);
    expect(P.inactiviteMs).toBe(5 * MIN);
    expect(P.arrierePlanMs).toBe(2 * MIN);
    expect(P.toleranceReculHorlogeMs).toBe(5 * MIN);
    expect(P.echecsLibres).toBe(5);
    expect(P.delaiInitialMs).toBe(30_000);
    expect(P.delaiMaxMs).toBe(15 * MIN);
    expect(P.plafondActiviteExterneMs).toBe(30 * MIN);
  });

  it("sont gelees : un integrateur ne peut pas les modifier par accident", () => {
    expect(Object.isFrozen(P)).toBe(true);
  });
});

describe("delaiApresEchecs", () => {
  it("les 5 premiers echecs n'imposent aucune attente", () => {
    for (const n of [0, 1, 2, 3, 4, 5]) expect(delaiApresEchecs(n)).toBe(0);
  });

  it("le 6e echec impose 30 s, puis le delai double a chaque echec", () => {
    expect([6, 7, 8, 9, 10].map((n) => delaiApresEchecs(n))).toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
  });

  it("est plafonne a 15 minutes (960 s sans plafond au 11e echec)", () => {
    expect(delaiApresEchecs(11)).toBe(15 * MIN);
    expect(delaiApresEchecs(12)).toBe(15 * MIN);
    expect(delaiApresEchecs(200)).toBe(15 * MIN);
    expect(delaiApresEchecs(1e9)).toBe(15 * MIN);
  });

  it("une valeur absurde donne zero plutot qu'une attente aleatoire", () => {
    expect(delaiApresEchecs(-3)).toBe(0);
    expect(delaiApresEchecs(Number.NaN)).toBe(0);
    expect(delaiApresEchecs(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("obeit aux parametres injectes", () => {
    const p = { ...P, echecsLibres: 2, delaiInitialMs: 1000, delaiMaxMs: 3000 };
    expect([2, 3, 4, 5, 6].map((n) => delaiApresEchecs(n, p))).toEqual([0, 1000, 2000, 3000, 3000]);
  });
});

describe("aReculeHorloge", () => {
  const derniere = T0;
  it("n'accuse rien sans observation precedente", () => {
    expect(aReculeHorloge(null, 0)).toBe(false);
  });
  it("une horloge qui avance, ou qui n'a pas bouge, est normale", () => {
    expect(aReculeHorloge(derniere, derniere)).toBe(false);
    expect(aReculeHorloge(derniere, derniere + 1)).toBe(false);
  });
  it("un recul de exactement 5 minutes est toleree", () => {
    expect(aReculeHorloge(derniere, derniere - 5 * MIN)).toBe(false);
  });
  it("un recul de 5 minutes et 1 ms est une falsification", () => {
    expect(aReculeHorloge(derniere, derniere - 5 * MIN - 1)).toBe(true);
  });
});

describe("estExpire", () => {
  it("1 ms avant l'expiration : valide ; a l'instant exact : expire", () => {
    expect(estExpire(T0 + 100, T0 + 99)).toBe(false);
    expect(estExpire(T0 + 100, T0 + 100)).toBe(true);
    expect(estExpire(T0 + 100, T0 + 101)).toBe(true);
  });
  it("une expiration inconnue (null) n'est pas une expiration", () => {
    expect(estExpire(null, T0 * 10)).toBe(false);
  });
  it("expirationApres ajoute la duree maximale", () => {
    expect(expirationApres(T0)).toBe(T0 + 7 * JOUR);
    expect(expirationApres(T0, { ...P, dureeMaxMs: 1000 })).toBe(T0 + 1000);
  });
});

describe("tentativePinPossible", () => {
  it("libre sans delai", () => {
    expect(tentativePinPossible({ pasAvantMs: null }, T0)).toEqual({ possible: true });
  });
  it("refusee avant l'echeance, avec le reste a attendre ; permise a l'echeance exacte", () => {
    expect(tentativePinPossible({ pasAvantMs: T0 + 30_000 }, T0 + 1)).toEqual({ possible: false, resteMs: 29_999 });
    expect(tentativePinPossible({ pasAvantMs: T0 + 30_000 }, T0 + 30_000)).toEqual({ possible: true });
  });
});

describe("differencesDeDroits", () => {
  const base = { userId: "u1", role: "AGENT", modules: ["terrain", "carte"], regions: ["R1", "R2"] };
  it("identique, quel que soit l'ordre des modules et regions : liste vide", () => {
    expect(differencesDeDroits(base, { ...base, modules: ["carte", "terrain"], regions: ["R2", "R1"] })).toEqual([]);
  });
  it("nomme chaque champ qui change", () => {
    expect(differencesDeDroits(base, { ...base, role: "GESTIONNAIRE" })).toEqual(["role"]);
    expect(differencesDeDroits(base, { ...base, modules: ["carte"] })).toEqual(["modules"]);
    expect(differencesDeDroits(base, { ...base, regions: ["R1", "R2", "R3"] })).toEqual(["regions"]);
    expect(differencesDeDroits(base, { ...base, userId: "u2" })).toEqual(["userId"]);
    expect(differencesDeDroits(base, { userId: "u1", role: "ADMIN", modules: [], regions: [] })).toEqual(["role", "modules", "regions"]);
  });
  it("un doublon dans la liste ne cree pas de difference", () => {
    expect(differencesDeDroits(base, { ...base, modules: ["terrain", "carte", "carte"] })).toEqual([]);
  });
});

describe("contexteInitial", () => {
  it("part sans coffre, sans validite connue, sans delai", () => {
    expect(contexteInitial()).toEqual({
      coffrePresent: false, cleEnMemoire: false, valideLeMs: null, expireLeMs: null, dernierInstantMs: null,
      derniereActiviteMs: null, arrierePlanDepuisMs: null, echecsPin: 0, pasAvantMs: null, deconnexionEnAttente: false,
    });
  });
});

describe("transition : connexion et rafraichissement", () => {
  it("CONNEXION_REUSSIE depuis chaque etat : EN_LIGNE, validite fixee a maintenant + 7 jours", () => {
    for (const depuis of ETATS_SESSION) {
      const r = transition(depuis, { type: "CONNEXION_REUSSIE", maintenantMs: T0 + 10 * JOUR }, ctx());
      expect(r.etat).toBe("EN_LIGNE");
      expect(r.contexte.valideLeMs).toBe(T0 + 10 * JOUR);
      expect(r.contexte.expireLeMs).toBe(T0 + 17 * JOUR);
    }
  });

  it("CONNEXION_REUSSIE efface le drapeau de deconnexion en attente (le cookie a change)", () => {
    const r = transition("FERME", { type: "CONNEXION_REUSSIE", maintenantMs: T0 }, ctx({ deconnexionEnAttente: true }));
    expect(r.contexte.deconnexionEnAttente).toBe(false);
  });

  it("CONNEXION_REUSSIE remet la marque d'horloge a maintenant, meme si elle etait dans le futur", () => {
    const r = transition("EXPIRE", { type: "CONNEXION_REUSSIE", maintenantMs: T0 }, ctx({ dernierInstantMs: T0 + 400 * JOUR }));
    expect(r.contexte.dernierInstantMs).toBe(T0);
  });

  it("REFRAICHISSEMENT OK repousse la validite depuis chaque etat sans deconnexion en attente", () => {
    for (const depuis of ETATS_SESSION) {
      const r = transition(depuis, { type: "REFRAICHISSEMENT", issue: "OK", maintenantMs: T0 + 2 * JOUR }, ctx());
      expect(r.etat).toBe("EN_LIGNE");
      expect(r.contexte.expireLeMs).toBe(T0 + 9 * JOUR);
      expect(r.contexte.valideLeMs).toBe(T0 + 2 * JOUR);
    }
  });

  it("REFRAICHISSEMENT OK pendant une deconnexion en attente : on rejoue la deconnexion, on ne rouvre pas", () => {
    const r = transition("HORS_LIGNE_VERROUILLE", { type: "REFRAICHISSEMENT", issue: "OK", maintenantMs: T0 + MIN }, ctx({ deconnexionEnAttente: true }));
    expect(r.etat).toBe("FERME");
    expect(types(r.effets)).toContain("REJOUER_DECONNEXION");
    expect(r.contexte.deconnexionEnAttente).toBe(true); // reste vrai jusqu'a DECONNEXION_REJOUEE
    expect(r.contexte.expireLeMs).toBe(T0 + P.dureeMaxMs); // validite NON repoussee
  });

  it("RESEAU_COUPE au demarrage avec un coffre : ecran PIN (HORS_LIGNE_VERROUILLE) et journal d'ouverture hors ligne", () => {
    const r = transition("DECONNECTE", { type: "REFRAICHISSEMENT", issue: "RESEAU_COUPE", maintenantMs: T0 + MIN }, ctx());
    expect(r.etat).toBe("HORS_LIGNE_VERROUILLE");
    expect(motifs(r.effets)).toEqual(["OUVERTURE_HORS_LIGNE"]);
  });

  it("INDISPONIBLE (5xx) se traite comme RESEAU_COUPE", () => {
    const a = transition("DECONNECTE", { type: "REFRAICHISSEMENT", issue: "INDISPONIBLE", maintenantMs: T0 + MIN }, ctx());
    const b = transition("DECONNECTE", { type: "REFRAICHISSEMENT", issue: "RESEAU_COUPE", maintenantMs: T0 + MIN }, ctx());
    expect(a).toEqual(b);
  });

  it("RESEAU_COUPE au demarrage SANS coffre : on reste DECONNECTE, aucun mode hors ligne", () => {
    const r = transition("DECONNECTE", { type: "REFRAICHISSEMENT", issue: "RESEAU_COUPE", maintenantMs: T0 }, contexteInitial());
    expect(r.etat).toBe("DECONNECTE");
    expect(r.applique).toBe(false);
  });

  it("RESEAU_COUPE depuis EN_LIGNE avec cle en memoire : HORS_LIGNE_OUVERT ; sans cle : HORS_LIGNE_VERROUILLE", () => {
    const avec = transition("EN_LIGNE", { type: "REFRAICHISSEMENT", issue: "RESEAU_COUPE", maintenantMs: T0 + MIN }, ctx({ cleEnMemoire: true, derniereActiviteMs: T0 }));
    expect(avec.etat).toBe("HORS_LIGNE_OUVERT");
    const sans = transition("EN_LIGNE", { type: "REFRAICHISSEMENT", issue: "RESEAU_COUPE", maintenantMs: T0 + MIN }, ctx());
    expect(sans.etat).toBe("HORS_LIGNE_VERROUILLE");
  });

  it("RESEAU_COUPE depuis EN_LIGNE sans coffre : rien ne change", () => {
    const r = transition("EN_LIGNE", { type: "REFRAICHISSEMENT", issue: "RESEAU_COUPE", maintenantMs: T0 }, ctx({ coffrePresent: false }));
    expect(r.etat).toBe("EN_LIGNE");
    expect(r.applique).toBe(false);
  });

  it("RESEAU_COUPE depuis un etat hors ligne, EXPIRE ou FERME : l'etat ne change pas", () => {
    for (const depuis of ["HORS_LIGNE_OUVERT", "HORS_LIGNE_VERROUILLE", "EXPIRE", "FERME"] as EtatSession[]) {
      const r = transition(depuis, { type: "REFRAICHISSEMENT", issue: "RESEAU_COUPE", maintenantMs: T0 + MIN }, ouvert());
      expect(r.etat).toBe(depuis);
    }
  });

  it("un demarrage hors ligne apres expiration connue va directement a EXPIRE", () => {
    const r = transition("DECONNECTE", { type: "REFRAICHISSEMENT", issue: "RESEAU_COUPE", maintenantMs: T0 + P.dureeMaxMs }, ctx());
    expect(r.etat).toBe("EXPIRE");
  });

  it("REFUSE ferme la session si un coffre existe, depuis chaque etat, et oublie la cle", () => {
    for (const depuis of ETATS_SESSION) {
      const r = transition(depuis, { type: "REFRAICHISSEMENT", issue: "REFUSE", maintenantMs: T0 + MIN }, ouvert());
      expect(r.etat).toBe("FERME");
      expect(r.contexte.cleEnMemoire).toBe(false);
      expect(r.contexte.coffrePresent).toBe(true); // rien n'est efface
    }
  });

  it("REFUSE sans coffre : DECONNECTE (il n'y a rien a fermer)", () => {
    const r = transition("EN_LIGNE", { type: "REFRAICHISSEMENT", issue: "REFUSE", maintenantMs: T0 }, contexteInitial());
    expect(r.etat).toBe("DECONNECTE");
  });

  it("REFUSE annule la deconnexion en attente (plus de cookie a revoquer)", () => {
    const r = transition("HORS_LIGNE_VERROUILLE", { type: "REFRAICHISSEMENT", issue: "REFUSE", maintenantMs: T0 + MIN }, ctx({ deconnexionEnAttente: true }));
    expect(r.contexte.deconnexionEnAttente).toBe(false);
    expect(types(r.effets)).not.toContain("REJOUER_DECONNEXION");
  });
});

describe("transition : coffre, deverrouillage, PIN", () => {
  it("COFFRE_CREE n'a de sens qu'en ligne", () => {
    const ok = transition("EN_LIGNE", { type: "COFFRE_CREE", maintenantMs: T0 }, contexteInitial({ valideLeMs: T0, expireLeMs: T0 + P.dureeMaxMs }));
    expect(ok.contexte).toMatchObject({ coffrePresent: true, cleEnMemoire: true, derniereActiviteMs: T0 });
    for (const depuis of ETATS_SESSION.filter((s) => s !== "EN_LIGNE")) {
      expect(transition(depuis, { type: "COFFRE_CREE", maintenantMs: T0 }, contexteInitial()).applique).toBe(false);
    }
  });

  it("DEVERROUILLAGE_REUSSI : VERROUILLE -> OUVERT, cle en memoire, compteur remis a zero, journal", () => {
    const r = transition(
      "HORS_LIGNE_VERROUILLE",
      { type: "DEVERROUILLAGE_REUSSI", maintenantMs: T0 + MIN, valideLeMs: T0, expireLeMs: T0 + P.dureeMaxMs },
      ctx({ echecsPin: 4, pasAvantMs: T0 + 5 }),
    );
    expect(r.etat).toBe("HORS_LIGNE_OUVERT");
    expect(r.contexte).toMatchObject({ cleEnMemoire: true, echecsPin: 0, pasAvantMs: null, derniereActiviteMs: T0 + MIN });
    expect(motifs(r.effets)).toEqual(["DEVERROUILLAGE"]);
  });

  it("DEVERROUILLAGE_REUSSI apprend l'expiration lue dans le profil (inconnue jusque-la)", () => {
    const r = transition(
      "HORS_LIGNE_VERROUILLE",
      { type: "DEVERROUILLAGE_REUSSI", maintenantMs: T0 + MIN, valideLeMs: T0, expireLeMs: T0 + 3 * JOUR },
      ctx({ valideLeMs: null, expireLeMs: null }),
    );
    expect(r.contexte.expireLeMs).toBe(T0 + 3 * JOUR);
  });

  it("DEVERROUILLAGE_REUSSI sur un profil deja expire : EXPIRE, cle non gardee", () => {
    const r = transition(
      "HORS_LIGNE_VERROUILLE",
      { type: "DEVERROUILLAGE_REUSSI", maintenantMs: T0 + 8 * JOUR, valideLeMs: T0, expireLeMs: T0 + 7 * JOUR },
      ctx({ valideLeMs: null, expireLeMs: null, dernierInstantMs: T0 + 8 * JOUR }),
    );
    expect(r.etat).toBe("EXPIRE");
    expect(r.contexte.cleEnMemoire).toBe(false);
  });

  it("DEVERROUILLAGE_REUSSI en ligne garde EN_LIGNE et ne touche pas la validite du contexte", () => {
    const r = transition(
      "EN_LIGNE",
      { type: "DEVERROUILLAGE_REUSSI", maintenantMs: T0 + MIN, valideLeMs: T0 - JOUR, expireLeMs: T0 + 6 * JOUR },
      ctx(),
    );
    expect(r.etat).toBe("EN_LIGNE");
    expect(r.contexte.cleEnMemoire).toBe(true);
    expect(r.contexte.expireLeMs).toBe(T0 + P.dureeMaxMs);
  });

  it("DEVERROUILLAGE_REUSSI est ignore en EXPIRE, FERME, DECONNECTE et HORS_LIGNE_OUVERT, et sans coffre", () => {
    for (const depuis of ["EXPIRE", "FERME", "DECONNECTE", "HORS_LIGNE_OUVERT"] as EtatSession[]) {
      const r = transition(depuis, { type: "DEVERROUILLAGE_REUSSI", maintenantMs: T0 + MIN, valideLeMs: T0, expireLeMs: T0 + P.dureeMaxMs }, ouvert());
      expect(r.applique).toBe(false);
      expect(r.etat).toBe(depuis);
    }
    expect(transition("HORS_LIGNE_VERROUILLE", { type: "DEVERROUILLAGE_REUSSI", maintenantMs: T0, valideLeMs: T0, expireLeMs: T0 + 1 }, contexteInitial()).applique).toBe(false);
  });

  it("ECHEC_PIN : les 5 premiers sans attente, le 6e impose 30 s, le 7e 60 s", () => {
    let c = ctx();
    for (let i = 1; i <= 5; i++) {
      const r = transition("HORS_LIGNE_VERROUILLE", { type: "ECHEC_PIN", maintenantMs: T0 + i }, c);
      expect(r.contexte.echecsPin).toBe(i);
      expect(r.contexte.pasAvantMs).toBeNull();
      c = r.contexte;
    }
    const sixieme = transition("HORS_LIGNE_VERROUILLE", { type: "ECHEC_PIN", maintenantMs: T0 + 100 }, c);
    expect(sixieme.contexte).toMatchObject({ echecsPin: 6, pasAvantMs: T0 + 100 + 30_000 });
    expect(tentativePinPossible(sixieme.contexte, T0 + 101)).toMatchObject({ possible: false });
    const septieme = transition("HORS_LIGNE_VERROUILLE", { type: "ECHEC_PIN", maintenantMs: T0 + 40_000 }, sixieme.contexte);
    expect(septieme.contexte.pasAvantMs).toBe(T0 + 40_000 + 60_000);
    expect(motifs(septieme.effets)).toEqual(["ECHEC_DEVERROUILLAGE"]);
  });

  it("ECHEC_PIN ne detruit rien et ne change pas l'etat (aucune destruction automatique)", () => {
    const r = transition("HORS_LIGNE_VERROUILLE", { type: "ECHEC_PIN", maintenantMs: T0 + 1 }, ctx({ echecsPin: 40 }));
    expect(r.etat).toBe("HORS_LIGNE_VERROUILLE");
    expect(r.contexte.coffrePresent).toBe(true);
    expect(r.contexte.echecsPin).toBe(41);
    expect(r.contexte.pasAvantMs).toBe(T0 + 1 + 15 * MIN);
  });

  it("ECHEC_PIN accepte le compteur persistant du coffre comme reference", () => {
    const r = transition("HORS_LIGNE_VERROUILLE", { type: "ECHEC_PIN", maintenantMs: T0 + 1, echecsPersistes: 8 }, ctx({ echecsPin: 2 }));
    expect(r.contexte.echecsPin).toBe(8);
    expect(r.contexte.pasAvantMs).toBe(T0 + 1 + 120_000);
  });

  it("COFFRE_EXPIRE : VERROUILLE -> EXPIRE ; ignore en ligne", () => {
    expect(transition("HORS_LIGNE_VERROUILLE", { type: "COFFRE_EXPIRE", maintenantMs: T0 + MIN }, ctx()).etat).toBe("EXPIRE");
    const enLigne = transition("EN_LIGNE", { type: "COFFRE_EXPIRE", maintenantMs: T0 + MIN }, ctx());
    expect(enLigne.etat).toBe("EN_LIGNE");
    expect(enLigne.applique).toBe(false);
  });
});

describe("transition : verrou d'inactivite et d'arriere-plan", () => {
  it("1 ms avant 5 minutes sans interaction : toujours ouvert ; a 5 minutes exactes : verrouille, cle oubliee", () => {
    const avant = transition("HORS_LIGNE_OUVERT", { type: "TICK", maintenantMs: T0 + 5 * MIN - 1 }, ouvert());
    expect(avant.etat).toBe("HORS_LIGNE_OUVERT");
    const pile = transition("HORS_LIGNE_OUVERT", { type: "TICK", maintenantMs: T0 + 5 * MIN }, ouvert());
    expect(pile.etat).toBe("HORS_LIGNE_VERROUILLE");
    expect(types(pile.effets)).toEqual(["OUBLIER_DEK", "JOURNALISER"]);
    expect(motifs(pile.effets)).toEqual(["VERROU_INACTIVITE"]);
    expect(pile.contexte.cleEnMemoire).toBe(false);
  });

  it("une interaction repart de zero : le compte des 5 minutes recommence", () => {
    let r = transition("HORS_LIGNE_OUVERT", { type: "ACTIVITE", maintenantMs: T0 + 4 * MIN }, ouvert());
    r = transition(r.etat, { type: "TICK", maintenantMs: T0 + 8 * MIN }, r.contexte);
    expect(r.etat).toBe("HORS_LIGNE_OUVERT");
    r = transition(r.etat, { type: "TICK", maintenantMs: T0 + 9 * MIN }, r.contexte);
    expect(r.etat).toBe("HORS_LIGNE_VERROUILLE");
  });

  it("une interaction qui arrive APRES l'echeance ne ressuscite pas la session", () => {
    const r = transition("HORS_LIGNE_OUVERT", { type: "ACTIVITE", maintenantMs: T0 + 6 * MIN }, ouvert());
    expect(r.etat).toBe("HORS_LIGNE_VERROUILLE");
    expect(r.contexte.cleEnMemoire).toBe(false);
  });

  it("arriere-plan : 1 ms avant 2 minutes, ouvert ; a 2 minutes exactes (sur un TICK), verrouille", () => {
    let r = transition("HORS_LIGNE_OUVERT", { type: "ARRIERE_PLAN", maintenantMs: T0 + MIN }, ouvert({ derniereActiviteMs: T0 + MIN }));
    expect(r.contexte.arrierePlanDepuisMs).toBe(T0 + MIN);
    const avant = transition(r.etat, { type: "TICK", maintenantMs: T0 + 3 * MIN - 1 }, r.contexte);
    expect(avant.etat).toBe("HORS_LIGNE_OUVERT");
    r = transition(r.etat, { type: "TICK", maintenantMs: T0 + 3 * MIN }, r.contexte);
    expect(r.etat).toBe("HORS_LIGNE_VERROUILLE");
    expect(motifs(r.effets)).toEqual(["VERROU_ARRIERE_PLAN"]);
  });

  it("retour au premier plan apres plus de 2 minutes : deja verrouille ; avant : reste ouvert et le minuteur est efface", () => {
    const base = ouvert({ derniereActiviteMs: T0 + MIN });
    const bg = transition("HORS_LIGNE_OUVERT", { type: "ARRIERE_PLAN", maintenantMs: T0 + MIN }, base);
    const tard = transition(bg.etat, { type: "PREMIER_PLAN", maintenantMs: T0 + 3 * MIN + 1 }, bg.contexte);
    expect(tard.etat).toBe("HORS_LIGNE_VERROUILLE");
    const tot = transition(bg.etat, { type: "PREMIER_PLAN", maintenantMs: T0 + 2 * MIN }, bg.contexte);
    expect(tot.etat).toBe("HORS_LIGNE_OUVERT");
    expect(tot.contexte.arrierePlanDepuisMs).toBeNull();
  });

  it("ARRIERE_PLAN repete ne repousse pas le depart du minuteur", () => {
    let r = transition("HORS_LIGNE_OUVERT", { type: "ARRIERE_PLAN", maintenantMs: T0 + 10_000 }, ouvert());
    r = transition(r.etat, { type: "ARRIERE_PLAN", maintenantMs: T0 + 60_000 }, r.contexte);
    expect(r.contexte.arrierePlanDepuisMs).toBe(T0 + 10_000);
  });

  it("une interaction prouve le premier plan et efface le minuteur d'arriere-plan", () => {
    const bg = transition("HORS_LIGNE_OUVERT", { type: "ARRIERE_PLAN", maintenantMs: T0 + 1000 }, ouvert());
    const r = transition(bg.etat, { type: "ACTIVITE", maintenantMs: T0 + 2000 }, bg.contexte);
    expect(r.contexte.arrierePlanDepuisMs).toBeNull();
  });

  it("en EN_LIGNE, l'inactivite n'efface QUE la cle : l'etat de session ne change pas", () => {
    const r = transition("EN_LIGNE", { type: "TICK", maintenantMs: T0 + 5 * MIN }, ouvert());
    expect(r.etat).toBe("EN_LIGNE");
    expect(r.contexte.cleEnMemoire).toBe(false);
    expect(types(r.effets)).toContain("OUBLIER_DEK");
    // et un second TICK n'emet pas un second effacement
    const encore = transition("EN_LIGNE", { type: "TICK", maintenantMs: T0 + 6 * MIN }, r.contexte);
    expect(types(encore.effets)).toEqual([]);
  });

  it("VERROU_MANUEL : OUVERT -> VERROUILLE ; en ligne avec cle : cle oubliee ; ailleurs : ignore", () => {
    const o = transition("HORS_LIGNE_OUVERT", { type: "VERROU_MANUEL", maintenantMs: T0 + 1 }, ouvert());
    expect(o.etat).toBe("HORS_LIGNE_VERROUILLE");
    expect(o.contexte.cleEnMemoire).toBe(false);
    const l = transition("EN_LIGNE", { type: "VERROU_MANUEL", maintenantMs: T0 + 1 }, ouvert());
    expect(l.etat).toBe("EN_LIGNE");
    expect(l.contexte.cleEnMemoire).toBe(false);
    expect(transition("EN_LIGNE", { type: "VERROU_MANUEL", maintenantMs: T0 + 1 }, ctx()).applique).toBe(false);
    expect(transition("FERME", { type: "VERROU_MANUEL", maintenantMs: T0 + 1 }, ctx()).applique).toBe(false);
  });

  it("un contexte incoherent (OUVERT sans cle) est ramene a VERROUILLE", () => {
    const r = transition("HORS_LIGNE_OUVERT", { type: "TICK", maintenantMs: T0 + 1 }, ctx({ cleEnMemoire: false }));
    expect(r.etat).toBe("HORS_LIGNE_VERROUILLE");
  });
});

describe("transition : expiration absolue", () => {
  it("1 ms avant 7 jours : valide ; a 7 jours exacts : EXPIRE, cle oubliee, journal", () => {
    const avant = transition("HORS_LIGNE_VERROUILLE", { type: "TICK", maintenantMs: T0 + P.dureeMaxMs - 1 }, ctx());
    expect(avant.etat).toBe("HORS_LIGNE_VERROUILLE");
    const pile = transition("HORS_LIGNE_OUVERT", { type: "TICK", maintenantMs: T0 + P.dureeMaxMs }, ouvert({ derniereActiviteMs: T0 + P.dureeMaxMs - 1 }));
    expect(pile.etat).toBe("EXPIRE");
    expect(types(pile.effets)).toEqual(["OUBLIER_DEK", "JOURNALISER"]);
    expect(motifs(pile.effets)).toEqual(["EXPIRATION"]);
  });

  it("AUCUN evenement hors ligne ne repousse l'expiration (activite, deverrouillage, echecs, premier plan)", () => {
    let e: EtatSession = "HORS_LIGNE_VERROUILLE";
    let c = ctx();
    const suite: EvenementSession[] = [
      { type: "ECHEC_PIN", maintenantMs: T0 + 1 * JOUR },
      { type: "DEVERROUILLAGE_REUSSI", maintenantMs: T0 + 2 * JOUR, valideLeMs: T0, expireLeMs: T0 + P.dureeMaxMs },
      { type: "ACTIVITE", maintenantMs: T0 + 2 * JOUR + 1000 },
      { type: "ARRIERE_PLAN", maintenantMs: T0 + 2 * JOUR + 2000 },
      { type: "PREMIER_PLAN", maintenantMs: T0 + 2 * JOUR + 3000 },
      { type: "VERROU_MANUEL", maintenantMs: T0 + 3 * JOUR },
      { type: "REFRAICHISSEMENT", issue: "RESEAU_COUPE", maintenantMs: T0 + 4 * JOUR },
      { type: "REFRAICHISSEMENT", issue: "INDISPONIBLE", maintenantMs: T0 + 5 * JOUR },
      { type: "TICK", maintenantMs: T0 + 6 * JOUR },
    ];
    for (const ev of suite) {
      const r = transition(e, ev, c);
      e = r.etat;
      c = r.contexte;
      expect(c.expireLeMs).toBe(T0 + P.dureeMaxMs);
      expect(c.valideLeMs).toBe(T0);
    }
    expect(transition(e, { type: "TICK", maintenantMs: T0 + 7 * JOUR }, c).etat).toBe("EXPIRE");
  });

  it("la duree est celle du contexte, fixee a la validation, meme si les parametres changent ensuite", () => {
    const c = ctx({ expireLeMs: T0 + 1000 });
    expect(transition("HORS_LIGNE_VERROUILLE", { type: "TICK", maintenantMs: T0 + 1000 }, c, { ...P, dureeMaxMs: 99 * JOUR }).etat).toBe("EXPIRE");
  });

  it("EXPIRE est stable : ni TICK, ni ACTIVITE, ni echec ne le quittent", () => {
    for (const ev of [
      { type: "TICK", maintenantMs: T0 + 8 * JOUR },
      { type: "ACTIVITE", maintenantMs: T0 + 8 * JOUR },
      { type: "ECHEC_PIN", maintenantMs: T0 + 8 * JOUR },
      { type: "REFRAICHISSEMENT", issue: "RESEAU_COUPE", maintenantMs: T0 + 8 * JOUR },
    ] as EvenementSession[]) {
      expect(transition("EXPIRE", ev, ctx({ dernierInstantMs: T0 + 8 * JOUR })).etat).toBe("EXPIRE");
    }
  });

  it("la sortie d'EXPIRE est une connexion ou un rafraichissement reussi EN LIGNE, avec une nouvelle echeance", () => {
    const r = transition("EXPIRE", { type: "REFRAICHISSEMENT", issue: "OK", maintenantMs: T0 + 9 * JOUR }, ctx({ dernierInstantMs: T0 + 8 * JOUR }));
    expect(r.etat).toBe("EN_LIGNE");
    expect(r.contexte.expireLeMs).toBe(T0 + 16 * JOUR);
  });

  it("en ligne, l'expiration locale ne s'applique pas (le serveur fait foi)", () => {
    const r = transition("EN_LIGNE", { type: "TICK", maintenantMs: T0 + 30 * JOUR }, ctx());
    expect(r.etat).toBe("EN_LIGNE");
  });

  it("DROITS_MODIFIES invalide la validite locale : la perte du reseau mene a EXPIRE tant que le profil n'est pas revalide", () => {
    const invalide = transition("EN_LIGNE", { type: "DROITS_MODIFIES", maintenantMs: T0 + 1000 }, ctx());
    expect(invalide.etat).toBe("EN_LIGNE");
    expect(motifs(invalide.effets)).toEqual(["DROITS_MODIFIES"]);
    const hors = transition("EN_LIGNE", { type: "REFRAICHISSEMENT", issue: "RESEAU_COUPE", maintenantMs: T0 + 2000 }, invalide.contexte);
    expect(hors.etat).toBe("EXPIRE");

    const revalide = transition("EN_LIGNE", { type: "PROFIL_REVALIDE", maintenantMs: T0 + 1500 }, invalide.contexte);
    expect(revalide.contexte.expireLeMs).toBe(T0 + 1500 + P.dureeMaxMs);
    const hors2 = transition("EN_LIGNE", { type: "REFRAICHISSEMENT", issue: "RESEAU_COUPE", maintenantMs: T0 + 2000 }, revalide.contexte);
    expect(hors2.etat).toBe("HORS_LIGNE_VERROUILLE");
  });

  it("DROITS_MODIFIES et PROFIL_REVALIDE sont ignores hors EN_LIGNE", () => {
    for (const depuis of ETATS_SESSION.filter((s) => s !== "EN_LIGNE")) {
      expect(transition(depuis, { type: "DROITS_MODIFIES", maintenantMs: T0 }, ctx()).applique).toBe(false);
      expect(transition(depuis, { type: "PROFIL_REVALIDE", maintenantMs: T0 }, ctx()).applique).toBe(false);
    }
  });
});

describe("transition : recul d'horloge", () => {
  it("recul de 5 min exactement : toleree", () => {
    const r = transition("HORS_LIGNE_VERROUILLE", { type: "TICK", maintenantMs: T0 - 5 * MIN }, ctx());
    expect(r.etat).toBe("HORS_LIGNE_VERROUILLE");
  });

  it("recul de 5 min + 1 ms : EXPIRE, cle oubliee, journal HORLOGE_RECULEE", () => {
    const r = transition("HORS_LIGNE_OUVERT", { type: "TICK", maintenantMs: T0 - 5 * MIN - 1 }, ouvert());
    expect(r.etat).toBe("EXPIRE");
    expect(r.contexte.cleEnMemoire).toBe(false);
    expect(motifs(r.effets)).toEqual(["HORLOGE_RECULEE"]);
  });

  it("la marque haute ne descend jamais : un recul toleree n'abaisse pas la reference", () => {
    // T0 + 10 min observe, puis recul de 4 min (tolere), puis recul de 6 min sous la marque (falsification).
    let r = transition("HORS_LIGNE_VERROUILLE", { type: "TICK", maintenantMs: T0 + 10 * MIN }, ctx());
    expect(r.contexte.dernierInstantMs).toBe(T0 + 10 * MIN);
    r = transition(r.etat, { type: "TICK", maintenantMs: T0 + 6 * MIN }, r.contexte);
    expect(r.etat).toBe("HORS_LIGNE_VERROUILLE");
    expect(r.contexte.dernierInstantMs).toBe(T0 + 10 * MIN);
    r = transition(r.etat, { type: "TICK", maintenantMs: T0 + 4 * MIN }, r.contexte);
    expect(r.etat).toBe("EXPIRE");
  });

  it("une falsification n'est pas rattrapee en remettant l'heure : EXPIRE est stable", () => {
    let r = transition("HORS_LIGNE_VERROUILLE", { type: "TICK", maintenantMs: T0 - 6 * MIN }, ctx());
    expect(r.etat).toBe("EXPIRE");
    r = transition(r.etat, { type: "TICK", maintenantMs: T0 + MIN }, r.contexte);
    expect(r.etat).toBe("EXPIRE");
  });

  it("vaut aussi a l'entree hors ligne depuis EN_LIGNE", () => {
    const r = transition("EN_LIGNE", { type: "REFRAICHISSEMENT", issue: "RESEAU_COUPE", maintenantMs: T0 - 10 * MIN }, ctx());
    // EN_LIGNE ne juge pas l'horloge ; le passage hors ligne le fait aussitot.
    expect(r.etat).toBe("EXPIRE");
  });

  it("une validation reussie par le serveur remet la marque a maintenant (poste dont la date a ete corrigee)", () => {
    const r = transition("EXPIRE", { type: "REFRAICHISSEMENT", issue: "OK", maintenantMs: T0 }, ctx({ dernierInstantMs: T0 + 3 * JOUR }));
    expect(r.contexte.dernierInstantMs).toBe(T0);
  });

  it("en ligne, la marque monte seulement (un recul en ligne n'efface pas la preuve)", () => {
    const r = transition("EN_LIGNE", { type: "TICK", maintenantMs: T0 - JOUR }, ctx());
    expect(r.etat).toBe("EN_LIGNE");
    expect(r.contexte.dernierInstantMs).toBe(T0);
  });
});

describe("transition : deconnexion", () => {
  it("en ligne (serveur joint) : FERME, cle oubliee, rien n'est efface, pas de drapeau", () => {
    for (const depuis of ["EN_LIGNE", "HORS_LIGNE_OUVERT", "HORS_LIGNE_VERROUILLE", "EXPIRE"] as EtatSession[]) {
      const r = transition(depuis, { type: "DECONNEXION_DEMANDEE", serveurJoint: true, maintenantMs: T0 + MIN }, ouvert());
      expect(r.etat).toBe("FERME");
      expect(r.contexte.cleEnMemoire).toBe(false);
      expect(r.contexte.coffrePresent).toBe(true);
      expect(r.contexte.deconnexionEnAttente).toBe(false);
    }
  });

  it("hors ligne (serveur injoignable) : verrou local immediat + drapeau, pas FERME", () => {
    for (const depuis of ["EN_LIGNE", "HORS_LIGNE_OUVERT"] as EtatSession[]) {
      const r = transition(depuis, { type: "DECONNEXION_DEMANDEE", serveurJoint: false, maintenantMs: T0 + MIN }, ouvert());
      expect(r.etat).toBe("HORS_LIGNE_VERROUILLE");
      expect(r.contexte.cleEnMemoire).toBe(false);
      expect(r.contexte.deconnexionEnAttente).toBe(true);
      expect(types(r.effets)).toContain("OUBLIER_DEK");
      expect(motifs(r.effets)).toEqual(["DECONNEXION_HORS_LIGNE"]);
    }
  });

  it("hors ligne depuis VERROUILLE : l'etat reste, le drapeau est pose", () => {
    const r = transition("HORS_LIGNE_VERROUILLE", { type: "DECONNEXION_DEMANDEE", serveurJoint: false, maintenantMs: T0 + MIN }, ctx());
    expect(r.etat).toBe("HORS_LIGNE_VERROUILLE");
    expect(r.contexte.deconnexionEnAttente).toBe(true);
  });

  it("en ligne sans coffre, serveur injoignable : FERME avec drapeau (rien a verrouiller localement)", () => {
    const r = transition("EN_LIGNE", { type: "DECONNEXION_DEMANDEE", serveurJoint: false, maintenantMs: T0 }, contexteInitial());
    expect(r.etat).toBe("FERME");
    expect(r.contexte.deconnexionEnAttente).toBe(true);
  });

  it("rien a deconnecter depuis DECONNECTE ou FERME", () => {
    for (const depuis of ["DECONNECTE", "FERME"] as EtatSession[]) {
      expect(transition(depuis, { type: "DECONNEXION_DEMANDEE", serveurJoint: true, maintenantMs: T0 }, ctx()).applique).toBe(false);
    }
  });

  it("DECONNEXION_REJOUEE : drapeau efface, session FERMEE ; sans drapeau : ignore", () => {
    const r = transition("HORS_LIGNE_VERROUILLE", { type: "DECONNEXION_REJOUEE", maintenantMs: T0 + MIN }, ctx({ deconnexionEnAttente: true }));
    expect(r.etat).toBe("FERME");
    expect(r.contexte.deconnexionEnAttente).toBe(false);
    expect(transition("HORS_LIGNE_VERROUILLE", { type: "DECONNEXION_REJOUEE", maintenantMs: T0 }, ctx()).applique).toBe(false);
  });

  it("parcours complet : deconnexion hors ligne, retour du reseau, refresh OK, rejeu, FERME", () => {
    let r = transition("HORS_LIGNE_OUVERT", { type: "DECONNEXION_DEMANDEE", serveurJoint: false, maintenantMs: T0 + MIN }, ouvert());
    r = transition(r.etat, { type: "REFRAICHISSEMENT", issue: "OK", maintenantMs: T0 + 2 * MIN }, r.contexte);
    expect(r.etat).toBe("FERME");
    expect(types(r.effets)).toContain("REJOUER_DECONNEXION");
    r = transition(r.etat, { type: "DECONNEXION_REJOUEE", maintenantMs: T0 + 3 * MIN }, r.contexte);
    expect(r.etat).toBe("FERME");
    expect(r.contexte.deconnexionEnAttente).toBe(false);
    expect(r.contexte.coffrePresent).toBe(true);
  });
});

describe("transition : reinitialisation du PIN et effacement local", () => {
  it("REINITIALISATION_PIN hors ligne : le coffre disparait, DECONNECTE, validite oubliee, journal", () => {
    for (const depuis of ["HORS_LIGNE_VERROUILLE", "HORS_LIGNE_OUVERT", "EXPIRE", "FERME"] as EtatSession[]) {
      const r = transition(depuis, { type: "REINITIALISATION_PIN", maintenantMs: T0 + MIN }, ouvert({ echecsPin: 12, pasAvantMs: T0 + 2 * MIN }));
      expect(r.etat).toBe("DECONNECTE");
      expect(r.contexte).toMatchObject({ coffrePresent: false, cleEnMemoire: false, valideLeMs: null, expireLeMs: null, echecsPin: 0, pasAvantMs: null });
      expect(motifs(r.effets)).toEqual(["REINITIALISATION_PIN"]);
    }
  });

  it("REINITIALISATION_PIN en ligne : l'agent reste connecte, il peut recreer un coffre", () => {
    const r = transition("EN_LIGNE", { type: "REINITIALISATION_PIN", maintenantMs: T0 }, ouvert());
    expect(r.etat).toBe("EN_LIGNE");
    expect(r.contexte.coffrePresent).toBe(false);
    const recree = transition(r.etat, { type: "COFFRE_CREE", maintenantMs: T0 + 1 }, r.contexte);
    expect(recree.contexte.coffrePresent).toBe(true);
  });

  it("EFFACEMENT_LOCAL a son propre motif de journal", () => {
    const r = transition("HORS_LIGNE_VERROUILLE", { type: "EFFACEMENT_LOCAL", maintenantMs: T0 }, ctx());
    expect(motifs(r.effets)).toEqual(["EFFACEMENT_LOCAL"]);
    expect(r.etat).toBe("DECONNECTE");
  });
});

describe("transition : proprietes generales", () => {
  const evenements: EvenementSession[] = [
    { type: "CONNEXION_REUSSIE", maintenantMs: T0 + MIN },
    { type: "REFRAICHISSEMENT", issue: "OK", maintenantMs: T0 + MIN },
    { type: "REFRAICHISSEMENT", issue: "RESEAU_COUPE", maintenantMs: T0 + MIN },
    { type: "REFRAICHISSEMENT", issue: "INDISPONIBLE", maintenantMs: T0 + MIN },
    { type: "REFRAICHISSEMENT", issue: "REFUSE", maintenantMs: T0 + MIN },
    { type: "COFFRE_CREE", maintenantMs: T0 + MIN },
    { type: "DEVERROUILLAGE_REUSSI", maintenantMs: T0 + MIN, valideLeMs: T0, expireLeMs: T0 + P.dureeMaxMs },
    { type: "ECHEC_PIN", maintenantMs: T0 + MIN },
    { type: "COFFRE_EXPIRE", maintenantMs: T0 + MIN },
    { type: "ACTIVITE", maintenantMs: T0 + MIN },
    { type: "ARRIERE_PLAN", maintenantMs: T0 + MIN },
    { type: "PREMIER_PLAN", maintenantMs: T0 + MIN },
    { type: "TICK", maintenantMs: T0 + MIN },
    { type: "VERROU_MANUEL", maintenantMs: T0 + MIN },
    { type: "DECONNEXION_DEMANDEE", serveurJoint: true, maintenantMs: T0 + MIN },
    { type: "DECONNEXION_DEMANDEE", serveurJoint: false, maintenantMs: T0 + MIN },
    { type: "DECONNEXION_REJOUEE", maintenantMs: T0 + MIN },
    { type: "DROITS_MODIFIES", maintenantMs: T0 + MIN },
    { type: "PROFIL_REVALIDE", maintenantMs: T0 + MIN },
    { type: "REINITIALISATION_PIN", maintenantMs: T0 + MIN },
    { type: "EFFACEMENT_LOCAL", maintenantMs: T0 + MIN },
  ];
  const contextes: ContexteSession[] = [
    contexteInitial(),
    ctx(),
    ouvert(),
    ouvert({ deconnexionEnAttente: true }),
    ctx({ echecsPin: 9, pasAvantMs: T0 + 5 * MIN }),
    ctx({ expireLeMs: null, valideLeMs: null }),
  ];

  it("chaque couple (etat, evenement, contexte) rend un etat connu et respecte les invariants", () => {
    let n = 0;
    for (const etat of ETATS_SESSION) {
      for (const ev of evenements) {
        for (const c of contextes) {
          const r = transition(etat, ev, c);
          n++;
          expect(ETATS_SESSION).toContain(r.etat);
          // OUVERT implique la cle ; la cle en memoire implique un coffre.
          if (r.etat === "HORS_LIGNE_OUVERT") expect(r.contexte.cleEnMemoire).toBe(true);
          if (r.contexte.cleEnMemoire) expect(r.contexte.coffrePresent).toBe(true);
          // Quitter l'etat avec une cle en memoire pour un etat « ferme a clef » sans OUBLIER_DEK est interdit.
          if (["EXPIRE", "FERME", "HORS_LIGNE_VERROUILLE", "DECONNECTE"].includes(r.etat)) expect(r.contexte.cleEnMemoire).toBe(false);
          // Hors ligne, rien ne repousse jamais l'expiration deja connue.
          if (estHorsLigneOuExpire(etat, r.etat) && c.expireLeMs !== null && ev.type !== "DEVERROUILLAGE_REUSSI") {
            expect(r.contexte.expireLeMs ?? Infinity).toBeLessThanOrEqual(c.expireLeMs);
          }
          // Le noyau ne detruit jamais le coffre de lui-meme.
          if (ev.type !== "REINITIALISATION_PIN" && ev.type !== "EFFACEMENT_LOCAL") {
            expect(r.contexte.coffrePresent).toBe(c.coffrePresent || (ev.type === "COFFRE_CREE" && etat === "EN_LIGNE"));
          }
        }
      }
    }
    expect(n).toBe(ETATS_SESSION.length * evenements.length * contextes.length);
  });

  function estHorsLigneOuExpire(avant: EtatSession, apres: EtatSession) {
    const hl = (s: EtatSession) => s === "HORS_LIGNE_OUVERT" || s === "HORS_LIGNE_VERROUILLE" || s === "EXPIRE";
    return hl(avant) && hl(apres);
  }

  it("ne modifie ni le contexte recu ni la liste d'effets precedente (pur)", () => {
    const c = Object.freeze(ouvert()) as ContexteSession;
    const avant = JSON.stringify(c);
    for (const ev of evenements) transition("HORS_LIGNE_OUVERT", ev, c);
    expect(JSON.stringify(c)).toBe(avant);
  });

  it("est deterministe : memes entrees, memes sorties", () => {
    for (const ev of evenements) {
      expect(transition("HORS_LIGNE_OUVERT", ev, ouvert())).toEqual(transition("HORS_LIGNE_OUVERT", ev, ouvert()));
    }
  });

  it("aucun evenement ne produit un effet de cle sans cle en memoire au depart", () => {
    for (const ev of evenements) {
      const r = transition("HORS_LIGNE_VERROUILLE", ev, ctx());
      expect(types(r.effets)).not.toContain("OUBLIER_DEK");
    }
  });
});

describe("parcours de bout en bout", () => {
  it("demarrage hors ligne, PIN juste apres 2 echecs, inactivite, retour du reseau", () => {
    let c = contexteInitial({ coffrePresent: true, dernierInstantMs: T0 });
    let r = transition("DECONNECTE", { type: "REFRAICHISSEMENT", issue: "RESEAU_COUPE", maintenantMs: T0 + 1 * JOUR }, c);
    expect(r.etat).toBe("HORS_LIGNE_VERROUILLE");

    r = transition(r.etat, { type: "ECHEC_PIN", maintenantMs: T0 + 1 * JOUR + 1000 }, r.contexte);
    r = transition(r.etat, { type: "ECHEC_PIN", maintenantMs: T0 + 1 * JOUR + 2000 }, r.contexte);
    expect(r.contexte.echecsPin).toBe(2);

    r = transition(r.etat, { type: "DEVERROUILLAGE_REUSSI", maintenantMs: T0 + 1 * JOUR + 3000, valideLeMs: T0, expireLeMs: T0 + 7 * JOUR }, r.contexte);
    expect(r.etat).toBe("HORS_LIGNE_OUVERT");
    expect(r.contexte.echecsPin).toBe(0);

    r = transition(r.etat, { type: "TICK", maintenantMs: T0 + 1 * JOUR + 3000 + 5 * MIN }, r.contexte);
    expect(r.etat).toBe("HORS_LIGNE_VERROUILLE");

    r = transition(r.etat, { type: "REFRAICHISSEMENT", issue: "OK", maintenantMs: T0 + 2 * JOUR }, r.contexte);
    expect(r.etat).toBe("EN_LIGNE");
    expect(r.contexte.expireLeMs).toBe(T0 + 9 * JOUR);
    c = r.contexte;
    expect(c.coffrePresent).toBe(true);
  });

  it("une semaine sans connexion : EXPIRE, puis une connexion en ligne rouvre", () => {
    let r = transition("HORS_LIGNE_VERROUILLE", { type: "TICK", maintenantMs: T0 + 6 * JOUR }, ctx());
    expect(r.etat).toBe("HORS_LIGNE_VERROUILLE");
    r = transition(r.etat, { type: "TICK", maintenantMs: T0 + 7 * JOUR + 1 }, r.contexte);
    expect(r.etat).toBe("EXPIRE");
    r = transition(r.etat, { type: "CONNEXION_REUSSIE", maintenantMs: T0 + 8 * JOUR }, r.contexte);
    expect(r.etat).toBe("EN_LIGNE");
    expect(r.contexte.coffrePresent).toBe(true);
  });

  it("refus du serveur au retour du reseau : FERME, le coffre et la file restent", () => {
    let r = transition("HORS_LIGNE_OUVERT", { type: "REFRAICHISSEMENT", issue: "REFUSE", maintenantMs: T0 + MIN }, ouvert());
    expect(r.etat).toBe("FERME");
    expect(r.contexte.coffrePresent).toBe(true);
    r = transition(r.etat, { type: "CONNEXION_REUSSIE", maintenantMs: T0 + 2 * MIN }, r.contexte);
    expect(r.etat).toBe("EN_LIGNE");
  });
});
