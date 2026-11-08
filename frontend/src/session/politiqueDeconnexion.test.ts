import { describe, expect, it } from "vitest";
import {
  decisionDeconnexion, decisionSuppressionLocale, totalSaisies, type ComptesFile,
} from "./politiqueDeconnexion";

const VIDE: ComptesFile = { enAttente: 0, enErreur: 0, abandonnees: 0, enConflit: 0, photosEnFile: 0, relevesNonConfirmes: 0 };
const avec = (p: Partial<ComptesFile>): ComptesFile => ({ ...VIDE, ...p });

describe("decisionSuppressionLocale : quand refuser", () => {
  it("file vide : suppression permise, aucune action proposee", () => {
    const d = decisionSuppressionLocale(VIDE);
    expect(d.refusee).toBe(false);
    expect(d.raisons).toEqual([]);
    expect(d.actions).toEqual([]);
    expect(d.texte).toBe("Aucune saisie en attente : les données locales de ce compte peuvent être supprimées.");
  });

  it.each([
    ["enAttente", "SAISIES_EN_ATTENTE"],
    ["enErreur", "SAISIES_EN_ERREUR"],
    ["abandonnees", "SAISIES_ABANDONNEES"],
    ["enConflit", "SAISIES_EN_CONFLIT"],
    ["photosEnFile", "PHOTOS_EN_FILE"],
    ["relevesNonConfirmes", "RELEVE_NON_CONFIRME"],
  ] as const)("un seul element dans %s suffit a refuser (%s)", (champ, raison) => {
    const d = decisionSuppressionLocale(avec({ [champ]: 1 }));
    expect(d.refusee).toBe(true);
    expect(d.raisons).toEqual([raison]);
    expect(d.actions).toEqual(["SYNCHRONISER_MAINTENANT", "EXPORTER", "LAISSER_TELLES_QUELLES"]);
  });

  it("cumule toutes les raisons, dans un ordre stable", () => {
    const d = decisionSuppressionLocale({ enAttente: 2, enErreur: 1, abandonnees: 1, enConflit: 1, photosEnFile: 4, relevesNonConfirmes: 1 });
    expect(d.raisons).toEqual([
      "SAISIES_EN_ATTENTE", "SAISIES_EN_ERREUR", "SAISIES_ABANDONNEES", "SAISIES_EN_CONFLIT", "PHOTOS_EN_FILE", "RELEVE_NON_CONFIRME",
    ]);
    expect(d.nbSaisies).toBe(5);
    expect(d.nbPhotos).toBe(4);
    expect(d.nbReleves).toBe(1);
  });

  it("totalSaisies additionne attente, erreur, abandon et conflit", () => {
    expect(totalSaisies({ enAttente: 1, enErreur: 2, abandonnees: 3, enConflit: 4 })).toBe(10);
  });
});

describe("decisionSuppressionLocale : texte exact", () => {
  it("une saisie au singulier", () => {
    expect(decisionSuppressionLocale(avec({ enAttente: 1 })).texte).toBe(
      "Suppression impossible : ce téléphone contient encore 1 saisie non synchronisée. " +
      "Ces données n'existent pas ailleurs. Synchronisez maintenant, exportez-les, ou laissez-les telles quelles : " +
      "elles seront envoyées à votre prochaine connexion en ligne.",
    );
  });

  it("des saisies et des photos au pluriel, jointes par « et »", () => {
    expect(decisionSuppressionLocale(avec({ enAttente: 2, enErreur: 1, photosEnFile: 3 })).texte).toBe(
      "Suppression impossible : ce téléphone contient encore 3 saisies non synchronisées et 3 photos en attente d'envoi. " +
      "Ces données n'existent pas ailleurs. Synchronisez maintenant, exportez-les, ou laissez-les telles quelles : " +
      "elles seront envoyées à votre prochaine connexion en ligne.",
    );
  });

  it("saisies, photos et releve : virgule puis « et »", () => {
    expect(decisionSuppressionLocale({ enAttente: 1, enErreur: 0, abandonnees: 0, enConflit: 1, photosEnFile: 1, relevesNonConfirmes: 2 }).texte).toContain(
      "contient encore 2 saisies non synchronisées, 1 photo en attente d'envoi et 2 relevés de roulage non confirmés. ",
    );
  });

  it("une photo seule (sans saisie) est nommee, pas cachee derriere un « 0 saisie »", () => {
    const t = decisionSuppressionLocale(avec({ photosEnFile: 1 })).texte;
    expect(t).toContain("contient encore 1 photo en attente d'envoi.");
    expect(t).not.toContain("saisie");
  });

  it("un releve seul au singulier", () => {
    expect(decisionSuppressionLocale(avec({ relevesNonConfirmes: 1 })).texte).toContain("contient encore 1 relevé de roulage non confirmé.");
  });

  it("le texte ne contient ni tiret cadratin ni emoji", () => {
    const t = decisionSuppressionLocale(avec({ enAttente: 5, photosEnFile: 2, relevesNonConfirmes: 1 })).texte;
    expect(t).not.toMatch(/[–—]/);
    expect(t).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("decisionSuppressionLocale : decompte invalide", () => {
  it.each([
    ["NaN", { enAttente: Number.NaN }],
    ["negatif", { enErreur: -1 }],
    ["non entier", { photosEnFile: 1.5 }],
    ["infini", { abandonnees: Number.POSITIVE_INFINITY }],
  ])("%s : refuse (dans le doute on ne supprime pas)", (_nom, p) => {
    const d = decisionSuppressionLocale(avec(p));
    expect(d.refusee).toBe(true);
    expect(d.raisons).toEqual(["DECOMPTE_INVALIDE"]);
    expect(d.texte).toBe("Suppression impossible : l'état de la file locale n'a pas pu être vérifié. Aucune donnée n'a été supprimée.");
    expect(d.actions).not.toContain("EXPORTER");
  });

  it("un champ manquant (objet incomplet venu du JS) refuse aussi", () => {
    const incomplet = { enAttente: 0 } as unknown as ComptesFile;
    expect(decisionSuppressionLocale(incomplet).refusee).toBe(true);
    expect(decisionSuppressionLocale(undefined as unknown as ComptesFile).refusee).toBe(true);
  });
});

describe("decisionSuppressionLocale : saisies refusees pour droits modifies (quarantaine)", () => {
  it("rien d'autre que des refus de droits : la suppression est REFUSEE, avec sa raison propre et le seul geste vrai", () => {
    const d = decisionSuppressionLocale(avec({ refusDroits: 2 }));
    expect(d.refusee).toBe(true);
    expect(d.raisons).toEqual(["SAISIES_REFUS_DROITS"]);
    expect(d.nbSaisies).toBe(2);
    // « Synchroniser maintenant » n'enverrait rien : la quarantaine n'est jamais rejouee seule.
    expect(d.actions).toEqual(["LAISSER_TELLES_QUELLES"]);
  });

  it("texte exact, au pluriel", () => {
    expect(decisionSuppressionLocale(avec({ refusDroits: 2 })).texte).toBe(
      "Suppression impossible : ce téléphone contient encore 2 saisies non synchronisées. Ces données n'existent pas ailleurs. " +
      "2 saisies refusées car vos droits ont changé sont conservées sur ce téléphone : elles ne partiront pas sans votre décision (« Renvoyer ») et empêchent l'effacement local.",
    );
  });

  it("texte exact, au singulier", () => {
    expect(decisionSuppressionLocale(avec({ refusDroits: 1 })).texte).toBe(
      "Suppression impossible : ce téléphone contient encore 1 saisie non synchronisée. Ces données n'existent pas ailleurs. " +
      "1 saisie refusée car vos droits ont changé est conservée sur ce téléphone : elle ne partira pas sans votre décision (« Renvoyer ») et empêche l'effacement local.",
    );
  });

  it("avec d'autres saisies en attente : la phrase ordinaire ne vise qu'elles, et les trois gestes restent proposes", () => {
    const d = decisionSuppressionLocale(avec({ enAttente: 1, refusDroits: 1, photosEnFile: 2 }));
    expect(d.raisons).toEqual(["SAISIES_EN_ATTENTE", "SAISIES_REFUS_DROITS", "PHOTOS_EN_FILE"]);
    expect(d.nbSaisies).toBe(2);
    expect(d.texte).toBe(
      "Suppression impossible : ce téléphone contient encore 2 saisies non synchronisées et 2 photos en attente d'envoi. Ces données n'existent pas ailleurs. " +
      "1 saisie refusée car vos droits ont changé est conservée sur ce téléphone : elle ne partira pas sans votre décision (« Renvoyer ») et empêche l'effacement local. " +
      "Pour les autres : synchronisez maintenant, exportez-les, ou laissez-les telles quelles : elles seront envoyées à votre prochaine connexion en ligne.",
    );
    expect(d.actions).toEqual(["SYNCHRONISER_MAINTENANT", "EXPORTER", "LAISSER_TELLES_QUELLES"]);
  });

  it("pas de double compte : une saisie refusee pour droits n'est comptee ni dans « abandonnees » ni deux fois dans le total", () => {
    const d = decisionSuppressionLocale(avec({ abandonnees: 1, refusDroits: 1 }));
    expect(d.raisons).toEqual(["SAISIES_ABANDONNEES", "SAISIES_REFUS_DROITS"]);
    expect(d.nbSaisies).toBe(2);
    expect(totalSaisies({ enAttente: 0, enErreur: 0, abandonnees: 1, enConflit: 0, refusDroits: 1 })).toBe(2);
    expect(totalSaisies({ enAttente: 1, enErreur: 2, abandonnees: 3, enConflit: 4 })).toBe(10);
  });

  it("sans la rubrique (appelant ancien) : comportement inchange", () => {
    const sans: ComptesFile = { enAttente: 0, enErreur: 0, abandonnees: 0, enConflit: 0, photosEnFile: 0, relevesNonConfirmes: 0 };
    expect(decisionSuppressionLocale(sans).refusee).toBe(false);
    expect(decisionSuppressionLocale({ ...sans, abandonnees: 1 }).raisons).toEqual(["SAISIES_ABANDONNEES"]);
  });

  it.each([["NaN", Number.NaN], ["negatif", -1], ["non entier", 0.5]])("un refusDroits %s rend le decompte invalide (dans le doute on ne supprime pas)", (_n, v) => {
    const d = decisionSuppressionLocale(avec({ refusDroits: v }));
    expect(d.refusee).toBe(true);
    expect(d.raisons).toEqual(["DECOMPTE_INVALIDE"]);
  });

  it("la deconnexion ne laisse pas croire que les saisies refusees partiront toutes seules", () => {
    const d = decisionDeconnexion({ serveurJoint: true, comptesFile: avec({ refusDroits: 2 }) });
    expect(d.texte).toBe(
      "Session fermée. Aucune donnée locale n'a été supprimée. Restent chiffrés sur ce téléphone : 2 saisies. " +
      "2 saisies refusées car vos droits ont changé sont conservées sur ce téléphone : elles ne partiront pas sans votre décision (« Renvoyer ») et empêchent l'effacement local.",
    );
    expect(d.efface).toBe(false);
  });

  it("la deconnexion : refus de droits ET autres saisies, seules les autres partent seules", () => {
    const d = decisionDeconnexion({ serveurJoint: false, comptesFile: avec({ enAttente: 1, refusDroits: 1 }) });
    expect(d.texte).toContain("Restent chiffrés sur ce téléphone : 2 saisies. 1 saisie refusée car vos droits ont changé");
    expect(d.texte.endsWith(" Les autres seront envoyées à votre prochaine connexion en ligne.")).toBe(true);
  });

  it("le texte ne contient ni tiret cadratin ni emoji", () => {
    const t = decisionSuppressionLocale(avec({ enAttente: 1, refusDroits: 3 })).texte;
    expect(t).not.toMatch(/[–—]/);
    expect(t).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("decisionDeconnexion", () => {
  it("serveur joint : ferme la session, ne verrouille pas, ne laisse aucun drapeau, n'efface rien", () => {
    const d = decisionDeconnexion({ serveurJoint: true });
    expect(d).toMatchObject({ fermeSession: true, verrouLocal: false, deconnexionEnAttente: false, efface: false });
    expect(d.texte).toBe("Session fermée. Aucune donnée locale n'a été supprimée.");
  });

  it("hors ligne : verrou local immediat + drapeau, session non fermee cote serveur, n'efface rien", () => {
    const d = decisionDeconnexion({ serveurJoint: false });
    expect(d).toMatchObject({ fermeSession: false, verrouLocal: true, deconnexionEnAttente: true, efface: false });
    expect(d.texte).toBe(
      "Vous êtes hors ligne : l'application est verrouillée, mais la déconnexion ne sera effective sur le serveur " +
      "qu'au retour du réseau. Aucune donnée locale n'a été supprimée.",
    );
  });

  it("avec un decompte, dit ce qui reste sur le telephone", () => {
    const d = decisionDeconnexion({ serveurJoint: true, comptesFile: avec({ enAttente: 2, photosEnFile: 1 }) });
    expect(d.texte).toBe(
      "Session fermée. Aucune donnée locale n'a été supprimée. " +
      "Restent chiffrés sur ce téléphone, à envoyer à votre prochaine connexion en ligne : 2 saisies et 1 photo.",
    );
  });

  it("file vide ou decompte invalide : aucun chiffre ajoute", () => {
    expect(decisionDeconnexion({ serveurJoint: true, comptesFile: VIDE }).texte).toBe("Session fermée. Aucune donnée locale n'a été supprimée.");
    expect(decisionDeconnexion({ serveurJoint: true, comptesFile: avec({ enAttente: -1 }) }).texte).toBe("Session fermée. Aucune donnée locale n'a été supprimée.");
  });

  it("la deconnexion n'efface jamais, quel que soit le decompte (type litteral false)", () => {
    for (const serveurJoint of [true, false]) {
      for (const comptesFile of [VIDE, avec({ enAttente: 9 }), undefined]) {
        expect(decisionDeconnexion({ serveurJoint, comptesFile }).efface).toBe(false);
      }
    }
  });
});
