/**
 * Politique de deconnexion et de suppression locale (conception : docs/securite/SESSION-HORS-LIGNE.md,
 * section 6). Fonctions PURES : aucun acces au stockage, a la file ni au reseau. L'integrateur compte
 * ce que la file contient (offlineDb) et passe le DECOMPTE ; ces fonctions disent quoi faire et quoi
 * afficher.
 *
 * CONTRAT POUR LES INTEGRATEURS
 *
 *   decisionSuppressionLocale(comptesFile)
 *     -> { refusee, raisons, nbSaisies, nbPhotos, nbReleves, texte, actions }
 *     Avant tout bouton « supprimer les donnees de ce compte » : si `refusee`, ne rien supprimer, afficher
 *     `texte` tel quel et proposer `actions` (synchroniser maintenant, exporter, laisser telles quelles).
 *     Un decompte invalide (NaN, negatif, non entier) REFUSE : dans le doute, on ne supprime pas.
 *
 *   decisionDeconnexion({ serveurJoint, comptesFile? })
 *     -> { fermeSession, verrouLocal, deconnexionEnAttente, efface: false, texte }
 *     `serveurJoint` : POST /auth/logout a repondu (meme 401). Se deconnecter n'EFFACE JAMAIS rien
 *     (`efface` vaut toujours false, par le type). Hors ligne : verrou local immediat et drapeau
 *     `deconnexionEnAttente` a persister, a rejouer au retour du reseau.
 *
 * Les durees, les seuils et les nombres n'ont rien de provisoire ici : la regle (« on ne supprime pas ce
 * qui n'est pas parti ») est ferme. Les textes sont ceux montres a l'agent : les modifier se fait ici,
 * et le test les fige.
 */

/** Decompte de la file locale du compte courant (une base par compte : voir compteLocal.ts). */
export interface ComptesFile {
  /** Saisies (inspections, defauts, portions, observations) qui attendent leur envoi. */
  readonly enAttente: number;
  /** Saisies dont le dernier envoi a echoue et qui seront retentees. */
  readonly enErreur: number;
  /** Saisies abandonnees apres trop d'echecs, conservees pour examen. */
  readonly abandonnees: number;
  /** Saisies en conflit avec le serveur (mecanisme `conflitsSync`), non resolues. */
  readonly enConflit: number;
  /** Photos encore en file (un bloc chiffre par photo). */
  readonly photosEnFile: number;
  /** Releves de roulage dont l'envoi n'est pas confirme par le serveur. */
  readonly relevesNonConfirmes: number;
  /**
   * Saisies refusees par le serveur parce que les DROITS du compte ont change (statut `refus_droits`, quarantaine) : conservees
   * sur le telephone, jamais rejouees seules, elles ne partent que sur une decision de l'agent (« Renvoyer »). Rubrique PROPRE :
   * elle n'est PAS comprise dans `abandonnees` (aucun double compte). Facultative pour ne rien casser chez les appelants qui ne la
   * connaissent pas : absente, elle vaut 0 ; presente, elle doit etre un entier positif ou nul comme les autres.
   */
  readonly refusDroits?: number;
}

export type RaisonRefus =
  | "SAISIES_EN_ATTENTE"
  | "SAISIES_EN_ERREUR"
  | "SAISIES_ABANDONNEES"
  | "SAISIES_EN_CONFLIT"
  | "SAISIES_REFUS_DROITS"
  | "PHOTOS_EN_FILE"
  | "RELEVE_NON_CONFIRME"
  | "DECOMPTE_INVALIDE";

export type ActionProposee = "SYNCHRONISER_MAINTENANT" | "EXPORTER" | "LAISSER_TELLES_QUELLES";

export interface DecisionSuppression {
  readonly refusee: boolean;
  readonly raisons: readonly RaisonRefus[];
  /** Saisies concernees : en attente + en erreur + abandonnees + en conflit + refusees pour droits. */
  readonly nbSaisies: number;
  readonly nbPhotos: number;
  readonly nbReleves: number;
  /** Texte d'information a afficher tel quel. */
  readonly texte: string;
  /** Ce que l'agent peut faire a la place, dans l'ordre d'affichage. Vide si la suppression est permise. */
  readonly actions: readonly ActionProposee[];
}

export interface DecisionDeconnexion {
  /** La session est fermee (le serveur a repondu). */
  readonly fermeSession: boolean;
  /** Verrou local immediat : la cle est oubliee, le PIN sera redemande. */
  readonly verrouLocal: boolean;
  /** Reste a prevenir le serveur au retour du reseau (a persister). */
  readonly deconnexionEnAttente: boolean;
  /** Se deconnecter n'efface rien, jamais. */
  readonly efface: false;
  readonly texte: string;
}

const ACTIONS_REFUS: readonly ActionProposee[] = ["SYNCHRONISER_MAINTENANT", "EXPORTER", "LAISSER_TELLES_QUELLES"];
/**
 * Quand il ne reste QUE des saisies refusees pour droits : « synchroniser maintenant » n'enverrait rien (la quarantaine n'est
 * jamais rejouee seule) et rien ne prouve qu'un export les couvre. Seul « laisser telles quelles » est vrai ; le renvoi explicite
 * se fait depuis le panneau des refus de droits, pas depuis ce dialogue.
 */
const ACTIONS_REFUS_DROITS_SEULS: readonly ActionProposee[] = ["LAISSER_TELLES_QUELLES"];

const compteValide = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

/** « 1 saisie », « 3 saisies » : le pluriel francais commence a 2. */
const accorde = (n: number, singulier: string, pluriel: string) => `${n} ${n >= 2 ? pluriel : singulier}`;

function liste(elements: readonly string[]): string {
  if (elements.length <= 1) return elements.join("");
  return `${elements.slice(0, -1).join(", ")} et ${elements[elements.length - 1]}`;
}

/** Nombre de saisies non synchronisees, toutes categories confondues (hors photos et releves). */
export function totalSaisies(c: Pick<ComptesFile, "enAttente" | "enErreur" | "abandonnees" | "enConflit" | "refusDroits">): number {
  return c.enAttente + c.enErreur + c.abandonnees + c.enConflit + (c.refusDroits ?? 0);
}

/**
 * Texte montre quand des saisies sont en quarantaine pour droits modifies. Il ne promet PAS un envoi automatique : elles ne
 * partiront pas sans decision, et tant qu'elles sont la, rien ne s'efface.
 */
export function texteRefusDroits(n: number): string {
  return n >= 2
    ? `${n} saisies refusées car vos droits ont changé sont conservées sur ce téléphone : elles ne partiront pas sans votre décision (« Renvoyer ») et empêchent l'effacement local.`
    : `${n} saisie refusée car vos droits ont changé est conservée sur ce téléphone : elle ne partira pas sans votre décision (« Renvoyer ») et empêche l'effacement local.`;
}

/**
 * La suppression locale des donnees du compte est-elle permise ?
 * Refusee des qu'il reste une saisie en attente, en erreur, abandonnee ou en conflit, une photo en file,
 * ou un releve de roulage non confirme : ces donnees n'existent nulle part ailleurs que sur le telephone.
 */
export function decisionSuppressionLocale(comptes: ComptesFile): DecisionSuppression {
  const champs = [
    comptes?.enAttente, comptes?.enErreur, comptes?.abandonnees, comptes?.enConflit,
    comptes?.photosEnFile, comptes?.relevesNonConfirmes,
  ];
  // `refusDroits` est facultatif : absent, il vaut 0 ; present mais invalide, le decompte entier est invalide.
  const refusDroits = comptes?.refusDroits ?? 0;
  if (!champs.every(compteValide) || !compteValide(refusDroits)) {
    return {
      refusee: true,
      raisons: ["DECOMPTE_INVALIDE"],
      nbSaisies: 0,
      nbPhotos: 0,
      nbReleves: 0,
      texte: "Suppression impossible : l'état de la file locale n'a pas pu être vérifié. Aucune donnée n'a été supprimée.",
      actions: ["SYNCHRONISER_MAINTENANT", "LAISSER_TELLES_QUELLES"],
    };
  }

  const raisons: RaisonRefus[] = [];
  if (comptes.enAttente > 0) raisons.push("SAISIES_EN_ATTENTE");
  if (comptes.enErreur > 0) raisons.push("SAISIES_EN_ERREUR");
  if (comptes.abandonnees > 0) raisons.push("SAISIES_ABANDONNEES");
  if (comptes.enConflit > 0) raisons.push("SAISIES_EN_CONFLIT");
  if (refusDroits > 0) raisons.push("SAISIES_REFUS_DROITS");
  if (comptes.photosEnFile > 0) raisons.push("PHOTOS_EN_FILE");
  if (comptes.relevesNonConfirmes > 0) raisons.push("RELEVE_NON_CONFIRME");

  const nbSaisies = totalSaisies({ ...comptes, refusDroits });
  const nbPhotos = comptes.photosEnFile;
  const nbReleves = comptes.relevesNonConfirmes;

  if (raisons.length === 0) {
    return {
      refusee: false,
      raisons,
      nbSaisies,
      nbPhotos,
      nbReleves,
      texte: "Aucune saisie en attente : les données locales de ce compte peuvent être supprimées.",
      actions: [],
    };
  }

  const elements: string[] = [];
  if (nbSaisies > 0) elements.push(`${accorde(nbSaisies, "saisie non synchronisée", "saisies non synchronisées")}`);
  if (nbPhotos > 0) elements.push(`${accorde(nbPhotos, "photo en attente d'envoi", "photos en attente d'envoi")}`);
  if (nbReleves > 0) elements.push(`${accorde(nbReleves, "relevé de roulage non confirmé", "relevés de roulage non confirmés")}`);

  const debut = `Suppression impossible : ce téléphone contient encore ${liste(elements)}. Ces données n'existent pas ailleurs. `;
  const suiteOrdinaire =
    "Synchronisez maintenant, exportez-les, ou laissez-les telles quelles : elles seront envoyées à votre prochaine connexion en ligne.";

  if (refusDroits === 0) {
    return { refusee: true, raisons, nbSaisies, nbPhotos, nbReleves, texte: debut + suiteOrdinaire, actions: ACTIONS_REFUS };
  }
  // Des saisies en quarantaine : elles ne seront PAS envoyees sans decision, le texte le dit sans l'enrober de la phrase ordinaire.
  // Si d'autres saisies (ou un releve) attendent aussi, la phrase ordinaire ne vise qu'elles.
  const autres = nbSaisies - refusDroits > 0 || nbReleves > 0;
  return {
    refusee: true,
    raisons,
    nbSaisies,
    nbPhotos,
    nbReleves,
    texte: debut + texteRefusDroits(refusDroits) + (autres ? ` Pour les autres : ${suiteOrdinaire.charAt(0).toLowerCase()}${suiteOrdinaire.slice(1)}` : ""),
    actions: autres ? ACTIONS_REFUS : ACTIONS_REFUS_DROITS_SEULS,
  };
}

/**
 * Que fait « Se deconnecter » ? Il ferme la session et n'efface rien. Hors ligne (le serveur n'a pas repondu),
 * il verrouille l'application tout de suite et memorise de prevenir le serveur au retour du reseau.
 */
export function decisionDeconnexion(entree: { serveurJoint: boolean; comptesFile?: ComptesFile }): DecisionDeconnexion {
  const comptes = entree.comptesFile;
  const restant = comptes !== undefined ? decisionSuppressionLocale(comptes) : null;
  // Un decompte invalide n'est pas un decompte : on ne montre aucun chiffre qu'on ne peut pas garantir.
  const refus = comptes?.refusDroits ?? 0;
  let reste = "";
  if (restant !== null && restant.refusee && !restant.raisons.includes("DECOMPTE_INVALIDE")) {
    if (refus === 0) {
      reste = ` Restent chiffrés sur ce téléphone, à envoyer à votre prochaine connexion en ligne : ${liste(listeElements(restant))}.`;
    } else {
      // Les saisies refusees pour droits ne partent PAS toutes seules a la prochaine connexion : ne pas le laisser croire.
      const autres = restant.nbSaisies - refus > 0 || restant.nbReleves > 0;
      reste = ` Restent chiffrés sur ce téléphone : ${liste(listeElements(restant))}. ${texteRefusDroits(refus)}` +
        (autres ? " Les autres seront envoyées à votre prochaine connexion en ligne." : "");
    }
  }

  if (entree.serveurJoint) {
    return {
      fermeSession: true,
      verrouLocal: false,
      deconnexionEnAttente: false,
      efface: false,
      texte: `Session fermée. Aucune donnée locale n'a été supprimée.${reste}`,
    };
  }
  return {
    fermeSession: false,
    verrouLocal: true,
    deconnexionEnAttente: true,
    efface: false,
    texte:
      "Vous êtes hors ligne : l'application est verrouillée, mais la déconnexion ne sera effective sur le serveur " +
      `qu'au retour du réseau. Aucune donnée locale n'a été supprimée.${reste}`,
  };
}

function listeElements(d: DecisionSuppression): string[] {
  const el: string[] = [];
  if (d.nbSaisies > 0) el.push(accorde(d.nbSaisies, "saisie", "saisies"));
  if (d.nbPhotos > 0) el.push(accorde(d.nbPhotos, "photo", "photos"));
  if (d.nbReleves > 0) el.push(accorde(d.nbReleves, "relevé de roulage", "relevés de roulage"));
  return el;
}
