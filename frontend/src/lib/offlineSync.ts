// Synchronise les saisies terrain (inspections et défauts) conservées dans IndexedDB
// dès que le réseau est disponible et que l'utilisateur est authentifié. Expose un store
// module-level (pattern identique a toast.ts) pour que le badge de header et la page
// terrain restent en phase sans prop drilling.
import axios from "axios";
import { api } from "./api";
import {
  compterFile,
  getAllPending,
  getAllPendingDefauts,
  removePendingDefaut,
  removePendingInspection,
  updatePendingDefaut,
  updatePendingInspection,
  type PendingDefaut,
  type PendingInspection,
  type PendingPortion,
  type PendingObservation,
  getAllPendingPortions,
  updatePendingPortion,
  removePendingPortion,
  getAllPendingObservations,
  updatePendingObservation,
  removePendingObservation,
  getPendingInspection,
  getPendingDefaut,
  getPendingObservation,
  getPendingPortion,
  type CauseRefusDroits,
  type SansPhotos,
} from "./offlineDb";
import { ouvrirStockage, type StockageJournal } from "./roulageHote";
import { lireEnvoiConfirme } from "./releveVue";
import {
  compteCourant, ecrireStockageLocal, estErreurAccesFile, estErreurStockageLocal, lireCompteurs, lireStockageLocal, NOM_CLE_APPAREIL_SYNC,
  retirerStockageLocal,
} from "./compteCourant";
import type { ComptesFile } from "../session/politiqueDeconnexion";

type Listener = () => void;

/**
 * Valeurs de la quarantaine, ecrites ICI plutot qu'importees d'offlineDb (qui exporte les memes : STATUT_REFUS_DROITS,
 * CAUSES_REFUS_DROITS) : les tests de la file qui simulent offlineDb par une fabrique n'ont pas a connaitre ces constantes.
 * Le type les relie : une valeur qui divergerait de celle d'offlineDb ne compilerait pas.
 */
const STATUT_REFUS_DROITS = "refus_droits" as const;
const CAUSES_CONNUES: readonly CauseRefusDroits[] = ["HORS_PERIMETRE", "REGION_INCONNUE", "MODULE_RETIRE", "MISSION_NON_AUTORISEE", "NON_PRECISEE"];
/**
 * `pendingCount` : tout ce que la file locale porte encore pour ce compte, quel que soit son statut.
 * `conflitCount` : dont les saisies en CONFLIT (un responsable doit trancher; elles restent en file).
 * `abandonCount` : dont les saisies ABANDONNEES (refus définitif ou trop d'échecs; elles restent visibles).
 * `refusDroitsCount` : dont les saisies en QUARANTAINE pour refus de DROITS (`refus_droits`; conservées, non rejouées seules).
 * `appareilRevoque` / `compteInactif` : la synchronisation est ARRETEE (voir `etatSynchronisation`); la file est intacte.
 */
type SyncState = {
  pendingCount: number; syncing: boolean; conflitCount: number; abandonCount: number;
  refusDroitsCount: number; appareilRevoque: boolean; compteInactif: boolean;
  /** L'enregistrement d'un appareil neuf est suspendu (403 APPAREIL_REVOCATION_RECENTE) : voir `etatEnregistrementAppareil`. */
  enregistrementSuspendu: boolean;
};
const listeners = new Set<Listener>();
let pendingCount = 0;
let conflitCount = 0;
let abandonCount = 0;
let refusDroitsCount = 0;
let syncing = false;
let utilisateurSyncId: string | null = null;
let appareilVolatile: { userId: string; id: string } | null = null;

// ---------------------------------------------------------------------------------------------------
// Arret de la synchronisation (chantier D6 : contrat serveur docs/securite/SESSION-HORS-LIGNE-SERVEUR.md, sections 2.1 et 2.2)
// ---------------------------------------------------------------------------------------------------

/**
 * Pourquoi la synchronisation est arretee, lu dans le CODE de la reponse du serveur (champ `code`), jamais dans son texte.
 *
 *   appareilRevoque   403 APPAREIL_REVOQUE : l'administration a retire CET appareil. Seule une decision humaine y met fin.
 *   compteInactif     401 COMPTE_INACTIF : le compte est desactive, verrouille ou supprime.
 *
 * Dans les deux cas : plus aucune requete de synchronisation, plus aucun enregistrement d'appareil, plus aucun rejeu, et la file
 * est INTACTE (aucun statut, aucun compteur de tentatives, aucune photo ne change). Ce n'est pas une panne passagere : reessayer
 * ne changerait rien, et se ré-enregistrer annulerait la decision de l'administrateur.
 *
 * L'arret vit en memoire de la page. Il n'est pas persiste : apres un rechargement, UNE requete le constate de nouveau
 * (le serveur reste l'autorite, un appareil rendu par une decision humaine reprend sans geste local). Il tombe quand le compte
 * change (`configurerUtilisateurSync`) ou sur `leverArretSynchronisation`.
 */
export interface EtatSynchronisation {
  readonly appareilRevoque: boolean;
  readonly compteInactif: boolean;
  /** Message pret a afficher a l'agent (francais, sans contenu de saisie), ou `null` quand rien n'est arrete. */
  readonly message: string | null;
}

export const MESSAGE_APPAREIL_REVOQUE =
  "Cet appareil a été retiré par l'administration. Vos saisies sont conservées ; contactez votre responsable.";
export const MESSAGE_COMPTE_INACTIF =
  "Votre compte est désactivé ou verrouillé. Vos saisies sont conservées sur ce téléphone ; contactez un administrateur.";

let arretAppareilRevoque = false;
let arretCompteInactif = false;
/** Arret LIMITE au cycle en cours (un appareil encore inconnu juste apres un enregistrement) : le cycle suivant repart. */
let arretCycle = false;
/** Un seul re-enregistrement automatique par cycle de synchronisation (appareil inconnu). Remis a faux au debut de chaque cycle. */
let reenregistrementFait = false;

function composerEtatArret(): EtatSynchronisation {
  return {
    appareilRevoque: arretAppareilRevoque,
    compteInactif: arretCompteInactif,
    message: arretAppareilRevoque ? MESSAGE_APPAREIL_REVOQUE : arretCompteInactif ? MESSAGE_COMPTE_INACTIF : null,
  };
}
let etatArret: EtatSynchronisation = composerEtatArret();
const ecouteursEtat = new Set<(etat: EtatSynchronisation) => void>();

/** Etat d'arret courant. La meme reference est rendue tant que rien ne change (compatible `useSyncExternalStore`). */
export function etatSynchronisation(): EtatSynchronisation {
  return etatArret;
}

/**
 * S'abonne aux CHANGEMENTS de l'etat d'arret (l'interface l'affiche, la session le journalise). L'ecouteur est appele a chaque
 * passage, dans un sens ou dans l'autre, avec le nouvel etat; jamais pour un etat inchange. Une erreur d'ecouteur est ignoree.
 * Rend la fonction de desabonnement.
 */
export function surEtatSynchronisation(cb: (etat: EtatSynchronisation) => void): () => void {
  ecouteursEtat.add(cb);
  return () => { ecouteursEtat.delete(cb); };
}

function majArret(appareilRevoque: boolean, compteInactif: boolean): void {
  if (appareilRevoque === arretAppareilRevoque && compteInactif === arretCompteInactif) return;
  arretAppareilRevoque = appareilRevoque;
  arretCompteInactif = compteInactif;
  etatArret = composerEtatArret();
  for (const e of [...ecouteursEtat]) {
    try { e(etatArret); } catch { /* un ecouteur defaillant ne doit pas alterer la synchronisation */ }
  }
  emit();
}

/**
 * Leve l'arret et laisse la synchronisation repartir (sans la lancer). A appeler quand une decision humaine l'autorise : nouvelle
 * connexion apres reactivation du compte, appareil rendu. Un changement de compte la leve deja tout seul.
 */
export function leverArretSynchronisation(): void {
  majArret(false, false);
}

/** Vrai quand AUCUNE requete de synchronisation ne doit partir (arret de session, ou arret du cycle en cours). */
function arretActif(): boolean {
  return arretAppareilRevoque || arretCompteInactif || arretCycle;
}

/** Levee pour sortir d'un envoi quand le cycle doit s'arreter SANS toucher la saisie (voir `signalerArret`). */
class ArretSynchronisation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArretSynchronisation";
  }
}

// ---------------------------------------------------------------------------------------------------
// Enregistrement d'appareil suspendu : 403 APPAREIL_REVOCATION_RECENTE (SESSION-HORS-LIGNE-SERVEUR.md 10.2)
// ---------------------------------------------------------------------------------------------------

/**
 * Le serveur refuse d'enregistrer un appareil NEUF pendant la duree du jeton d'acces qui suit la retraite d'un AUTRE appareil du
 * meme compte : 403 `APPAREIL_REVOCATION_RECENTE`, avec `reessayerDansMs`. Texte unique, aussi montre par l'ecran de roulage
 * (EnregistrementRoulagePage le reexporte).
 */
export const MESSAGE_REVOCATION_RECENTE =
  "Un de vos appareils vient d'être retiré. Patientez quelques minutes avant d'enregistrer ce téléphone, ou contactez votre responsable.";
const CODE_REVOCATION_RECENTE = "APPAREIL_REVOCATION_RECENTE";
/**
 * Bornes du delai de reessai, en ms. Le serveur garantit au moins 1 000 : en dessous de 5 000 on attend 5 000 (jamais AVANT le delai
 * dit, seulement un peu apres). Au-dela de 30 minutes on reessaie quand meme : un delai absurde ne doit pas figer l'envoi, et un
 * essai de trop coute UNE requete (le serveur redit son delai). Sans delai lisible dans la reponse : 5 minutes.
 */
const DELAI_REESSAI_MIN_MS = 5_000;
const DELAI_REESSAI_MAX_MS = 30 * 60_000;
const DELAI_REESSAI_DEFAUT_MS = 5 * 60_000;

/**
 * Ce n'est PAS un appareil revoque (`appareilRevoque` n'est jamais pose) : l'appareil COURANT n'est pas en cause, la file n'est ni
 * arretee ni en quarantaine, aucune saisie ne change de statut ni ne compte de tentative. Seul le POST d'un appareil neuf est
 * suspendu :
 *   - un cycle AUTOMATIQUE (retour du reseau, onglet visible, saisie enregistree...) qui aurait besoin de s'enregistrer s'arrete
 *     SANS requete tant que le delai court (les inspections, qui n'ont pas d'appareil, partent normalement) ;
 *   - un seul reessai automatique a l'echeance (`minuteurSuspension`), puis, si le serveur redit non, un nouveau delai : jamais
 *     de boucle serree, une requete par delai ;
 *   - un GESTE de l'agent (`synchroniserManuellement`) reessaie tout de suite, delai ou non.
 * La suspension vit en memoire de la page (pas persistee) : apres un rechargement, UNE requete la constate de nouveau.
 */
export interface EtatEnregistrementAppareil {
  readonly suspendu: boolean;
  /** Instant (ms epoch) du prochain reessai automatique, ou `null`. */
  readonly reessayerLeMs: number | null;
  readonly message: string | null;
}
let suspensionEnregistrement: { userId: string; jusquaMs: number } | null = null;
let minuteurSuspension: ReturnType<typeof setTimeout> | null = null;
/** Vrai pendant un cycle lance par un geste de l'agent : la suspension de l'enregistrement ne le retient pas. */
let gesteManuel = false;
const ENREGISTREMENT_LIBRE: EtatEnregistrementAppareil = { suspendu: false, reessayerLeMs: null, message: null };
let etatEnregistrement: EtatEnregistrementAppareil = ENREGISTREMENT_LIBRE;

/** Etat de la suspension. Meme reference tant que rien ne change. */
export function etatEnregistrementAppareil(): EtatEnregistrementAppareil {
  return etatEnregistrement;
}

function majSuspension(suspension: { userId: string; jusquaMs: number } | null): void {
  if (minuteurSuspension !== null) { clearTimeout(minuteurSuspension); minuteurSuspension = null; }
  if (suspension === null && suspensionEnregistrement === null) return;
  suspensionEnregistrement = suspension;
  etatEnregistrement = suspension === null
    ? ENREGISTREMENT_LIBRE
    : { suspendu: true, reessayerLeMs: suspension.jusquaMs, message: MESSAGE_REVOCATION_RECENTE };
  if (suspension !== null) {
    minuteurSuspension = setTimeout(() => {
      minuteurSuspension = null;
      // Le compte a change ou la suspension a ete remplacee entre-temps : ce minuteur n'est plus le bon.
      if (suspensionEnregistrement !== suspension) return;
      majSuspension(null);
      if (utilisateurSyncId === suspension.userId && navigator.onLine) syncPendingOfflineData().catch(() => undefined);
    }, Math.max(0, suspension.jusquaMs - Date.now()));
  }
  emit();
}

/** Delai dit par le serveur (`reessayerDansMs`), borne ; a defaut de delai lisible, le delai par defaut. */
function delaiReessaiDe(err: unknown): number {
  const donnees = (err as { response?: { data?: { reessayerDansMs?: unknown } | null } } | null)?.response?.data;
  const dit = donnees?.reessayerDansMs;
  if (typeof dit !== "number" || !Number.isFinite(dit) || dit <= 0) return DELAI_REESSAI_DEFAUT_MS;
  return Math.min(DELAI_REESSAI_MAX_MS, Math.max(DELAI_REESSAI_MIN_MS, dit));
}

/** Le delai court-il encore pour ce compte ? Une suspension echue (minuteur retarde, onglet en veille) est levee ici. */
function enregistrementSuspendu(userId: string): boolean {
  if (suspensionEnregistrement === null) return false;
  if (suspensionEnregistrement.userId !== userId || Date.now() >= suspensionEnregistrement.jusquaMs) {
    majSuspension(null);
    return false;
  }
  return true;
}

/**
 * Le compte dont la file part. Les données locales sont une base PAR COMPTE (compteCourant.ts) : ce réglage ne
 * choisit plus une base, il garde l'envoi contre un changement de compte pendant une requête.
 */
export function configurerUtilisateurSync(userId: string | null) {
  if (utilisateurSyncId !== userId) {
    appareilVolatile = null;
    // L'arret est celui d'un compte sur un appareil : un autre compte ne le herite pas.
    arretCycle = false;
    utilisateurSyncId = userId;
    // La suspension de l'enregistrement est celle d'un compte : un autre compte ne l'herite pas (et son minuteur tombe).
    majSuspension(null);
    majArret(false, false);
    return;
  }
  utilisateurSyncId = userId;
}

// useSyncExternalStore exige que getSnapshot renvoie une reference stable tant que l'etat
// n'a pas change (sinon React redemande un rendu a l'infini -> "Maximum update depth
// exceeded", erreur #185). On memorise donc l'objet et on n'en recree un que si une des
// valeurs a reellement change.
let cachedState: SyncState = {
  pendingCount, syncing, conflitCount, abandonCount, refusDroitsCount, appareilRevoque: arretAppareilRevoque, compteInactif: arretCompteInactif,
  enregistrementSuspendu: suspensionEnregistrement !== null,
};

function emit() {
  listeners.forEach((l) => l());
}

export function subscribeSync(cb: Listener) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getSyncState(): SyncState {
  if (
    cachedState.pendingCount !== pendingCount || cachedState.syncing !== syncing
    || cachedState.conflitCount !== conflitCount || cachedState.abandonCount !== abandonCount
    || cachedState.refusDroitsCount !== refusDroitsCount
    || cachedState.appareilRevoque !== arretAppareilRevoque || cachedState.compteInactif !== arretCompteInactif
    || cachedState.enregistrementSuspendu !== (suspensionEnregistrement !== null)
  ) {
    cachedState = {
      pendingCount, syncing, conflitCount, abandonCount, refusDroitsCount,
      appareilRevoque: arretAppareilRevoque, compteInactif: arretCompteInactif,
      enregistrementSuspendu: suspensionEnregistrement !== null,
    };
  }
  return cachedState;
}

// Un seul acces au journal de roulage par compte : en ouvrir un par rafraichissement laisserait une connexion IndexedDB
// ouverte a chaque fois. Le journal est PAR COMPTE : un changement de compte en demande un nouveau.
let stockageRoulage: { compteId: string | undefined; stockage: StockageJournal } | null = null;
const journalRoulage = (): StockageJournal => {
  const compteId = compteCourant()?.compteId;
  if (stockageRoulage === null || stockageRoulage.compteId !== compteId) {
    const ancien = stockageRoulage;
    stockageRoulage = { compteId, stockage: ouvrirStockage() };
    // Le cache est REMPLACE (changement de compte) : l'ancien journal n'est plus joignable, mais ses ecouteurs (abonnement au compte,
    // visibilite de la page) le sont encore. Sans `fermer()`, chaque changement de compte en laissait un de plus, pour toujours. Cet
    // acces ne fait que LIRE le journal (compter, jamais `ajouter`) : il n'a aucun tampon d'ecriture a perdre en le fermant.
    try { ancien?.stockage.fermer?.(); } catch { /* une fermeture qui echoue ne doit pas empecher de compter les saisies */ }
  }
  return stockageRoulage.stockage;
};

/**
 * Vaut 1 si le journal de ce telephone porte une session de roulage ARRETEE, de CE compte, avec de quoi etre envoyee (au
 * moins deux positions), et que le serveur n'a PAS confirmee. 0 sinon, et 0 si le journal ne peut pas etre lu.
 *
 * POURQUOI ELLE COMPTE ICI. Une session de roulage n'a pas de file : elle vit dans son propre journal, et l'ecran
 * « Enregistrer un releve » est le seul a la connaitre. Page fermee, plus rien n'indiquait qu'un releve attendait sur le
 * telephone. Le badge la compte donc avec le reste, SANS creer de nouvelle file et sans l'envoyer : l'envoi reste un geste
 * de l'agent sur cet ecran (la synchronisation ne la pousse pas), et seule une confirmation du serveur la retire du compte.
 *
 * Le journal est relu tel quel (premiere entree DEMARRAGE, presence d'une entree ARRET), sans rejouer le noyau : le compte
 * n'a pas besoin de l'etat complet, et un journal inrejouable est tout de meme un releve non confirme.
 */
async function sessionRoulageNonConfirmee(userId: string | null, options: { inclureEnCours?: boolean } = {}): Promise<number> {
  if (!userId) return 0;
  try {
    const stockage = journalRoulage();
    // Sans IndexedDB, le journal ne vit qu'en memoire de la page : rien ne survit a sa fermeture, rien a compter.
    if (stockage.nature === "memoire") return 0;
    const entrees = await stockage.toutes();
    const debut = entrees.find((e) => e.type === "DEMARRAGE");
    if (!debut || debut.type !== "DEMARRAGE" || debut.agentRef !== userId) return 0;
    // Pour le BADGE, seule une session arretee compte (l'envoi est un geste de l'agent sur l'ecran de releve). Pour le DECOMPTE
    // qui protege une suppression ou une reinitialisation, une session DEMARREE et jamais arretee compte aussi : une page tuee
    // en plein releve reste « en cours » dans le journal, et ses points n'existent nulle part ailleurs (`inclureEnCours`).
    if (options.inclureEnCours !== true && !entrees.some((e) => e.type === "ARRET")) return 0;
    if (entrees.filter((e) => e.type === "ECHANTILLON").length < 2) return 0;
    return lireEnvoiConfirme(debut.sessionId) ? 0 : 1;
  } catch (e) {
    // Coffre verrouille : le journal est illisible sans cle, mais le compteur d'information du compte dit s'il y a un releve arrete.
    const c = compteCourant();
    if (c !== null && estErreurStockageLocal(e, "COFFRE_VERROUILLE")) return Math.min(1, lireCompteurs(c.empreinte)?.releves ?? 0);
    return 0;
  }
}

/**
 * Statuts de la file du compte courant. Lecture LEGERE : les photos (dechiffrees une a une, de plusieurs Mio) ne servent
 * pas a compter et ne sont pas lues. Coffre verrouille : les statuts en clair des enveloppes suffisent (aucune cle).
 */
async function statutsDesFiles(): Promise<{ status?: string }[]> {
  if (!utilisateurSyncId) return [];
  const miens = <T extends { ownerUserId?: string }>(items: T[]) => items.filter((item) => item.ownerUserId === utilisateurSyncId);
  try {
    const [inspections, defauts, portions, observations] = await Promise.all([
      getAllPending({ sansPhotos: true }), getAllPendingDefauts({ sansPhotos: true }),
      getAllPendingPortions({ sansPhotos: true }), getAllPendingObservations({ sansPhotos: true }),
    ]);
    // Les quatre files comptent ensemble : l'agent veut savoir COMBIEN il lui reste a
    // remonter, pas de quel type. Un compteur par type l'obligerait a additionner.
    return [...miens(inspections), ...miens(defauts), ...miens(portions), ...miens(observations)];
  } catch (e) {
    if (!estErreurAccesFile(e)) throw e;
    if (estErreurStockageLocal(e, "AUCUN_COMPTE") || compteCourant()?.compteId !== utilisateurSyncId) return [];
    const d = await compterFile();
    const n = (status: string, nombre: number) => Array.from({ length: nombre }, () => ({ status }));
    return [
      ...n("pending", d.enAttente), ...n("error", d.enErreur), ...n("abandonnee", d.abandonnees), ...n("conflit", d.enConflit),
      ...n(STATUT_REFUS_DROITS, d.refusDroits),
    ];
  }
}

/**
 * Decompte de la file locale au format que `decisionSuppressionLocale` (session/politiqueDeconnexion.ts) attend : de quoi
 * refuser un effacement qui perdrait des saisies. Lecture sans cle (ne demande pas le deverrouillage) pour les saisies et
 * les photos ; le releve de roulage n'est compte que si le journal est lisible ou si le compteur d'information le dit.
 */
export async function decompteFileLocale(): Promise<ComptesFile & { readonly refusDroits: number }> {
  const d = await compterFile();
  return {
    enAttente: d.enAttente, enErreur: d.enErreur,
    // Une saisie en quarantaine pour refus de DROITS n'existe nulle part ailleurs que sur ce telephone : elle empeche la suppression
    // locale. Elle a sa RUBRIQUE PROPRE dans `ComptesFile` (`refusDroits`) et n'est plus ajoutee a `abandonnees` (double compte).
    abandonnees: d.abandonnees, enConflit: d.enConflit, refusDroits: d.refusDroits,
    // `inclureEnCours` : un releve en cours (jamais arrete) est un releve non confirme pour la suppression locale.
    photosEnFile: d.photosEnFile, relevesNonConfirmes: await sessionRoulageNonConfirmee(utilisateurSyncId, { inclureEnCours: true }),
  };
}

export async function refreshPendingCount() {
  const [fichiers, roulage] = await Promise.all([statutsDesFiles(), sessionRoulageNonConfirmee(utilisateurSyncId)]);
  const tous: { status?: string }[] = [
    ...fichiers,
    // Une session de roulage arretee et non confirmee : jamais « en conflit » ni « abandonnee », elle attend son envoi.
    ...Array.from({ length: roulage }, () => ({ status: "pending" })),
  ];
  pendingCount = tous.length;
  // Les conflits et les abandons sont comptes A PART, et restent dans le total : une saisie en conflit
  // n'est pas partie, elle attend. Les sortir du compteur la ferait disparaitre de l'ecran de l'agent.
  conflitCount = tous.filter((item) => item.status === "conflit").length;
  abandonCount = tous.filter((item) => item.status === "abandonnee").length;
  // La quarantaine pour refus de droits a sa propre rubrique, elle aussi dans le total.
  refusDroitsCount = tous.filter((item) => item.status === STATUT_REFUS_DROITS).length;
  emit();
}

// Au-dela, on cesse de reessayer. Une erreur permanente — troncon supprime,
// validation refusee — se reproduirait sinon a chaque retour de reseau, sans fin et
// sans que personne ne s'en apercoive. L'element est conserve pour que l'agent puisse
// le corriger ou le supprimer, jamais efface en silence.
//
// Le compteur mesure des echecs CONSECUTIFS, pas des tentatives. Il comptait les
// tentatives, et abandonnait donc une synchronisation qui avancait : une inspection
// a six photos sur un reseau qui coupe en passe une par tentative, atteint cinq au
// moment ou il n'en reste qu'une, et se retrouve marquee « abandonnee » — donc
// ignoree pour toujours par la boucle. La derniere photo ne partait jamais, alors
// que chaque tentative avait reussi en partie.
const MAX_TENTATIVES = 5;

/**
 * Vrai si la requete n'a obtenu AUCUNE reponse : reseau coupe, delai depasse, DNS, serveur
 * injoignable. L'erreur ne dit rien de la saisie elle-meme.
 *
 * POURQUOI ELLE NE COMPTE PAS DANS LE PLAFOND DE TENTATIVES
 *
 * `MAX_TENTATIVES` vise l'erreur PERMANENTE d'une saisie (troncon supprime, validation refusee).
 * Un reseau qui ne repond pas n'est pas une propriete de la saisie : sur un telephone qui capte
 * mal, l'evenement « online » revient plusieurs fois sans connexion utilisable, et chaque retour
 * comptait un echec pour CHAQUE element de la file. Cinq retours suffisaient a marquer les 50
 * saisies d'une mission « abandonnees », donc ignorees par la boucle jusqu'a ce que l'agent les
 * releve une a une. Les saisies n'etaient pas perdues, mais la synchronisation s'arretait sans
 * que le reseau en soit la cause (test `offlineSync.cinquante.test.ts`).
 *
 * LES REPONSES TRANSITOIRES COMPTENT COMME UN RESEAU MUET
 *
 * Certaines reponses ne parlent pas de la saisie non plus (`STATUTS_TRANSITOIRES`) : 502, 503 et 504
 * viennent du proxy pendant un deploiement ou un redemarrage (la saisie n'a jamais ete lue), 408 et 429
 * disent « reessayez plus tard », et 401 dit que le JETON a expire (l'intercepteur de `api.ts` le
 * rafraichit et rejoue; si cela echoue, il faut se reconnecter, pas abandonner la saisie). Les compter
 * faisait passer toute la file en « abandonnee » en cinq passages, soit le temps d'un deploiement.
 *
 * Une erreur du SERVEUR qui a lu la saisie (400, 403, 404, 409, 422, 500...) compte toujours : lui a repondu.
 */
const STATUTS_TRANSITOIRES: ReadonlySet<number> = new Set([401, 408, 429, 502, 503, 504]);

/** Vrai si l'erreur ne dit rien de la saisie elle-meme (voir ci-dessus). */
function estErreurReseau(err: unknown): boolean {
  return axios.isAxiosError(err) && (!err.response || STATUTS_TRANSITOIRES.has(err.response.status));
}

function messageErreur(err: unknown): string {
  if (typeof err === "object" && err !== null && "response" in err) {
    const response = (err as { response?: { data?: unknown } }).response;
    if (typeof response?.data === "object" && response.data !== null && "message" in response.data) {
      const message = (response.data as { message?: unknown }).message;
      if (typeof message === "string" && message.length > 0) return message;
    }
  }
  return err instanceof Error ? err.message : "Erreur de synchronisation";
}

/** Statut HTTP et `code` du corps d'une erreur de requete. Le `code` est LU, jamais deduit du texte du message. */
function detailReponse(err: unknown): { statut?: number; code?: string } {
  if (typeof err !== "object" || err === null || !("response" in err)) return {};
  const response = (err as { response?: { status?: unknown; data?: unknown } }).response;
  const donnees = response?.data;
  const code = typeof donnees === "object" && donnees !== null ? (donnees as { code?: unknown }).code : undefined;
  return {
    statut: typeof response?.status === "number" ? response.status : undefined,
    code: typeof code === "string" ? code : undefined,
  };
}

/** Vrai si le serveur a repondu `statut` avec ce `code` precis (contrat : SESSION-HORS-LIGNE-SERVEUR.md, sections 2.1 et 2.2). */
function repondu(err: unknown, statut: number, code: string): boolean {
  const d = detailReponse(err);
  return d.statut === statut && d.code === code;
}

/**
 * Cette erreur arrete-t-elle la synchronisation SANS que la saisie en soit la cause ? Si oui, l'etat d'arret est pose (ou deja
 * pose) et l'appelant rend la main SANS ecrire la saisie : ni statut `error`, ni tentative comptee, ni message.
 *
 *   403 APPAREIL_REVOQUE  l'administration a retire cet appareil : arret de session. Aucun re-enregistrement, aucun rejeu.
 *   401 COMPTE_INACTIF    compte desactive ou verrouille : arret de session (un rafraichissement serait refuse lui aussi).
 *   ArretSynchronisation  arret du cycle en cours, deja pose (appareil encore inconnu apres un enregistrement).
 *
 * Doit etre appelee EN PREMIER dans chaque `catch` d'envoi : 401 figure parmi les statuts « transitoires » ci-dessus (jeton expire),
 * et un COMPTE_INACTIF pris pour un jeton expire serait retente et compte comme un reseau muet, indefiniment.
 */
function signalerArret(err: unknown, userId: string): boolean {
  if (err instanceof ArretSynchronisation) return true;
  const revoque = repondu(err, 403, "APPAREIL_REVOQUE");
  const inactif = repondu(err, 401, "COMPTE_INACTIF");
  if (!revoque && !inactif) return false;
  // Le compte a change pendant la requete : la reponse parle de l'ancien compte, elle ne doit pas arreter le nouveau.
  if (utilisateurSyncId !== userId) return true;
  if (revoque) majArret(true, arretCompteInactif);
  else majArret(arretAppareilRevoque, true);
  return true;
}

/** Vrai si la tentative a fait avancer quoi que ce soit de durable. */
function aProgresse(avant: PendingInspection, apres: PendingInspection): boolean {
  return (!avant.serverId && !!apres.serverId) || apres.photos.length < avant.photos.length;
}

/**
 * Synchronise une inspection en attente.
 *
 * REPRISE PAS A PAS. La version precedente creait l'inspection puis envoyait les
 * photos, et ne retirait l'element de la file qu'apres le succes de TOUTES les
 * photos. Une coupure pendant l'envoi d'une photo laissait donc l'element complet en
 * attente — et la synchronisation suivante RECREAIT l'inspection. Un doublon par
 * tentative, sur le module qui produit la donnee du reseau.
 *
 * Chaque etape reussie est desormais persistee : l'identifiant serveur d'abord, puis
 * chaque photo retiree de la liste des qu'elle est passee. Une reprise ne refait que
 * ce qui reste.
 */
async function syncOne(item: PendingInspection): Promise<boolean> {
  if (utilisateurSyncId !== item.ownerUserId || arretActif()) return false;
  const tentatives = (item.tentatives ?? 0) + 1;
  let etat = { ...item, tentatives };

  try {
    if (!etat.serverId) {
      if (utilisateurSyncId !== item.ownerUserId) return false;
      const { data: created } = await api.post("/inspections", {
        // Cle d'idempotence SERVEUR (T7). `localId` est genere une seule fois a la
        // saisie, persiste dans IndexedDB, et ne change jamais d'une tentative a
        // l'autre : c'est exactement l'identifiant stable que le serveur attend pour
        // refuser une seconde creation.
        //
        // La persistance pas a pas ci-dessous supprime la cause la plus frequente du
        // doublon, mais pas toutes : si la reponse se perd en chemin, ce client
        // conclut a un echec alors que le serveur a bien enregistre. Il retentera, et
        // seule la garantie serveur ferme ce cas.
        clientInspectionId: etat.localId,
        tronconId: etat.payload.tronconId || undefined,
        ouvrageId: etat.payload.ouvrageId || undefined,
        dateInspection: etat.payload.dateInspection,
        etatObserve: etat.payload.etatObserve,
        constatDefauts: etat.payload.constatDefauts,
        methodeObservation: etat.payload.methodeObservation,
        conditionsObservation: etat.payload.conditionsObservation,
        missionId: etat.payload.missionId,
        debutM: etat.payload.debutM,
        finM: etat.payload.finM,
        defautsConstates: etat.payload.defautsConstates || undefined,
        recommandations: etat.payload.recommandations || undefined,
        lat: etat.payload.lat,
        lon: etat.payload.lon,
        precisionM: etat.payload.precisionM,
      });
      // Persister AVANT d'envoyer la moindre photo : c'est cette ecriture qui empeche
      // la recreation en cas de coupure a la ligne suivante.
      etat = { ...etat, serverId: created.id as string };
      await updatePendingInspection(etat);
    }

    while (etat.photos.length > 0) {
      // Un changement de compte pendant l'envoi d'une photo arrête la file avant
      // l'envoi de la preuve suivante avec les nouvelles informations de session.
      if (utilisateurSyncId !== item.ownerUserId) return false;
      const photo = etat.photos[0];
      const formData = new FormData();
      formData.append("photo", photo.blob, photo.name);
      await api.post(`/inspections/${etat.serverId}/photos`, formData);
      etat = { ...etat, photos: etat.photos.slice(1) };
      await updatePendingInspection(etat);
    }

    await removePendingInspection(etat.localId);
    return true;
  } catch (err) {
    // Appareil retire, compte inactif : la saisie n'y est pour rien. Rien n'est ecrit (les etapes deja passees sont deja persistees).
    if (signalerArret(err, item.ownerUserId ?? "")) return false;
    const message = messageErreur(err);
    // Une tentative qui a fait avancer l'envoi repart de zero : ce n'est pas
    // l'erreur permanente que le plafond vise, c'est un reseau qui coupe.
    const echecsConsecutifs = aProgresse(item, etat) ? 0 : estErreurReseau(err) ? (item.tentatives ?? 0) : tentatives;
    const abandonnee = echecsConsecutifs >= MAX_TENTATIVES;
    await updatePendingInspection({
      ...etat,
      tentatives: echecsConsecutifs,
      status: abandonnee ? "abandonnee" : "error",
      errorMessage: abandonnee ? `${message} (abandon apres ${echecsConsecutifs} echecs consecutifs)` : message,
    });
    return false;
  }
}

/** Un resultat de `/v2/sync/push` pour une operation, tel que le protocole le rend (rien d'invente). */
interface ResultatPush {
  statut?: string;
  entityId?: string;
  motif?: string;
  conflitId?: string;
  reessayerDansMs?: number;
  /** `DROITS_MODIFIES` : pourquoi (voir `CauseRefusDroits`). */
  cause?: string;
  definitif?: boolean;
}

export const MOTIF_CONFLIT_TRANCHE_SERVEUR = "CONFLIT_RESOLU_VERSION_SERVEUR";

/**
 * Ce que l'appareil retient d'une operation que le serveur a mise en CONFLIT, ou tranchee depuis.
 *
 * CONFLIT : la saisie RESTE EN FILE, marquee `conflit`, avec l'identifiant du conflit. Elle n'est ni
 * retiree (la retirer ferait croire a l'agent que sa version a ete retenue, alors qu'un responsable doit
 * encore trancher) ni comptee comme un echec (reessayer ne changera rien tant que personne n'a tranche).
 * Elle est quand meme RENVOYEE a chaque synchronisation : c'est ainsi que l'appareil apprend la decision.
 *
 * REJETE / CONFLIT_RESOLU_VERSION_SERVEUR : un responsable a retenu la version du serveur. La saisie est
 * marquee `abandonnee` et reste visible, avec ce motif. Elle n'est pas effacee pour autant : la version du
 * telephone reste conservee cote serveur, dans le conflit.
 */
function marquageConflit(r: ResultatPush | undefined): {
  status: "conflit" | "abandonnee"; errorMessage: string; conflitId?: string; motifConflit?: string;
} | null {
  if (r?.statut === "CONFLIT") {
    return {
      status: "conflit",
      conflitId: r.conflitId,
      motifConflit: r.motif,
      errorMessage: `Conflit de synchronisation${r.motif ? ` (${r.motif})` : ""} : le serveur porte déjà une version différente. Un responsable doit trancher. Cette saisie est conservée sur ce téléphone.`,
    };
  }
  if (r?.statut === "REJETE" && r.motif === MOTIF_CONFLIT_TRANCHE_SERVEUR) {
    return {
      status: "abandonnee",
      errorMessage: "Un responsable a retenu la version du serveur : cette saisie n'a pas été retenue. Elle reste ici, et sa version est conservée côté serveur.",
    };
  }
  return null;
}

/** Texte a l'agent par cause. Ce n'est pas une erreur de saisie : le compte n'a plus le droit d'envoyer CETTE saisie. */
export const MESSAGES_REFUS_DROITS: Readonly<Record<CauseRefusDroits, string>> = {
  HORS_PERIMETRE:
    "Cette saisie est hors de votre périmètre territorial actuel. Elle est conservée sur ce téléphone et n'est plus renvoyée seule. Contactez votre responsable ; une fois vos droits rendus, relancez l'envoi.",
  REGION_INCONNUE:
    "La région de cette saisie n'a pas pu être rattachée à votre périmètre. Elle est conservée sur ce téléphone et n'est plus renvoyée seule. Contactez votre responsable ; une fois vos droits rendus, relancez l'envoi.",
  MODULE_RETIRE:
    "Le module de cette saisie a été retiré de votre compte. Elle est conservée sur ce téléphone et n'est plus renvoyée seule. Contactez votre responsable ; une fois l'accès rendu, relancez l'envoi.",
  MISSION_NON_AUTORISEE:
    "La mission de cette saisie ne vous est plus assignée. Elle est conservée sur ce téléphone et n'est plus renvoyée seule. Contactez votre responsable ; une fois la mission réaffectée, relancez l'envoi.",
  NON_PRECISEE:
    "Le serveur a refusé cette saisie parce que vos droits ont changé. Elle est conservée sur ce téléphone et n'est plus renvoyée seule. Contactez votre responsable ; une fois vos droits rendus, relancez l'envoi.",
};

/**
 * La cause de droits d'un refus, ou `null` si le refus n'est pas de la famille droits.
 *
 * `DROITS_MODIFIES` porte sa `cause` (SESSION-HORS-LIGNE-SERVEUR.md 2.3). `MISSION_NON_AUTORISEE` est le motif historique de la
 * meme famille (contrat de la collecte de roulage), sans cause. Une cause inconnue d'un serveur plus recent reste un refus de
 * droits (`NON_PRECISEE`) : le motif suffit, on ne la rejoue pas. Un refus de DONNEE (PAYLOAD_INVALIDE, REFERENCE_INCONNUE...)
 * n'est PAS de cette famille et garde son traitement.
 */
function causeRefusDroits(r: ResultatPush | undefined): CauseRefusDroits | null {
  if (r?.statut !== "REJETE") return null;
  if (r.motif === "MISSION_NON_AUTORISEE") return "MISSION_NON_AUTORISEE";
  if (r.motif !== "DROITS_MODIFIES") return null;
  const connue = (CAUSES_CONNUES as readonly string[]).includes(r.cause ?? "") ? (r.cause as CauseRefusDroits) : "NON_PRECISEE";
  return connue;
}

/**
 * Ce que l'appareil ecrit sur une saisie refusee pour DROITS : QUARANTAINE. Elle n'est ni retiree (une saisie de terrain
 * perdue ne se refait pas), ni comptee comme un echec (reessayer ne changerait rien), ni rejouee seule : `refus_droits` est
 * ignore par la synchronisation. Ses donnees et ses photos chiffrees sont ecrites telles quelles par l'appelant (`...item`).
 */
function marquageRefusDroits(cause: CauseRefusDroits): { status: "refus_droits"; causeRefusDroits: CauseRefusDroits; errorMessage: string } {
  return { status: STATUT_REFUS_DROITS, causeRefusDroits: cause, errorMessage: MESSAGES_REFUS_DROITS[cause] };
}

async function appareilSync(userId: string): Promise<string | null> {
  if (utilisateurSyncId !== userId) return null;
  const cached = lireStockageLocal(NOM_CLE_APPAREIL_SYNC, userId);
  if (cached) return cached;
  if (appareilVolatile?.userId === userId) return appareilVolatile.id;

  // Enregistrement suspendu (403 APPAREIL_REVOCATION_RECENTE deja recu, delai en cours) : un cycle automatique ne redemande RIEN,
  // il s'arrete ici sans toucher aucune saisie. Seul un geste de l'agent reessaie avant l'echeance.
  if (!gesteManuel && enregistrementSuspendu(userId)) {
    arretCycle = true;
    throw new ArretSynchronisation(MESSAGE_REVOCATION_RECENTE);
  }
  let data: { id?: unknown } | undefined;
  try {
    ({ data } = await api.post("/v2/devices", {
      nom: "BDRI — navigateur terrain",
      plateforme: "web",
      modele: navigator.userAgent.slice(0, 120),
    }));
  } catch (err) {
    if (!repondu(err, 403, CODE_REVOCATION_RECENTE)) throw err;
    // Refus TEMPORAIRE, pas un appareil revoque : on pose la suspension (une requete par delai), le cycle s'arrete, la saisie reste
    // telle quelle (ni statut `error`, ni tentative comptee : `signalerArret` reconnait `ArretSynchronisation`).
    if (utilisateurSyncId !== userId) return null;
    majSuspension({ userId, jusquaMs: Date.now() + delaiReessaiDe(err) });
    arretCycle = true;
    throw new ArretSynchronisation(MESSAGE_REVOCATION_RECENTE);
  }
  // Enregistre : le delai est derriere nous (un geste de l'agent a pu reussir avant l'echeance).
  if (utilisateurSyncId === userId) majSuspension(null);
  // L'utilisateur peut changer pendant la création réseau de l'appareil. Ne jamais
  // ranger l'appareil du nouveau compte sous la clé de l'ancien ni lui envoyer le
  // brouillon de l'ancien compte.
  if (utilisateurSyncId !== userId) return null;
  const id = data?.id;
  if (typeof id !== "string" || id.length === 0) throw new Error("L'appareil de synchronisation n'a pas été enregistré.");
  appareilVolatile = { userId, id };
  ecrireStockageLocal(NOM_CLE_APPAREIL_SYNC, id, userId); // sans compte ouvert ou stockage refuse : l'ID reste disponible pour cette session
  return id;
}

/**
 * Pousse UNE operation de creation, quel que soit son type.
 *
 * GENERALISE PLUTOT QUE DUPLIQUE. La reprise apres un appareil inconnu ci-dessous est la
 * partie delicate de cette fonction : la copier pour les portions aurait cree un second
 * endroit ou la corriger, et c'est ainsi qu'un chemin finit par ne plus reprendre.
 *
 * CE QUE LE CLIENT FAIT DU 403 DE `sync/push` (chantier D6 ; SESSION-HORS-LIGNE-SERVEUR.md 2.2). Le serveur distingue par le
 * CHAMP `code`, et le client ne lit que lui (le texte historique « Appareil inconnu, révoqué ou non autorisé » est conserve pour
 * les clients deja deployes, il ne dit pas lequel des deux cas) :
 *
 *   APPAREIL_INCONNU   l'identifiant n'existe pas (appareil jamais enregistre, base reinitialisee) : s'enregistrer de NOUVEAU
 *                      (`POST /v2/devices` sans identifiant) est legitime, UNE SEULE FOIS par cycle de synchronisation, puis
 *                      l'operation repart avec la meme cle d'idempotence (`operationId`). Un second « inconnu » dans le meme
 *                      cycle arrete le cycle sans toucher aucune saisie : pas de boucle, pas d'appareil enregistre en serie.
 *   APPAREIL_REVOQUE   l'administration a retire CET appareil. Ni re-enregistrement, ni rejeu : l'erreur remonte au `catch` de
 *                      l'appelant qui pose l'arret (`signalerArret`). Se ré-enregistrer sous une autre identite annulerait la
 *                      revocation, qui est precisement ce que le serveur refuse de faire a notre place.
 *
 * Tout autre 403 (sans ces codes) n'est PAS interprete comme un appareil inconnu : il suit le traitement des autres erreurs.
 */
async function pousserCreation(userId: string, entityType: string, localId: string, payload: unknown) {
  const operation = {
    operationId: localId,
    entityType,
    entityId: localId,
    operation: "CREATE",
    baseVersion: null,
    payload,
  };
  for (;;) {
    const deviceId = await appareilSync(userId);
    if (!deviceId || utilisateurSyncId !== userId) return null;
    try {
      const response = await api.post("/v2/sync/push", { appareilId: deviceId, operations: [operation] });
      return utilisateurSyncId === userId ? response : null;
    } catch (err) {
      if (!repondu(err, 403, "APPAREIL_INCONNU")) throw err;
      if (utilisateurSyncId !== userId) return null;
      if (reenregistrementFait) {
        // Le serveur ne reconnait pas l'appareil qu'il vient de nous donner : ce n'est pas la saisie, et recommencer n'y changera rien.
        arretCycle = true;
        throw new ArretSynchronisation("Le serveur ne reconnait pas l'appareil qu'il vient d'enregistrer.");
      }
      reenregistrementFait = true;
      retirerStockageLocal(NOM_CLE_APPAREIL_SYNC, userId);
      appareilVolatile = null;
    }
  }
}

async function syncOneDefaut(item: PendingDefaut, userId: string): Promise<boolean> {
  if (item.status === "abandonnee" || item.status === STATUT_REFUS_DROITS || arretActif()) return false;
  const tentatives = (item.tentatives ?? 0) + 1;
  let etat: PendingDefaut = { ...item, tentatives };
  try {
    if (!etat.serverId) {
      const reponse = await pousserCreation(userId, "Defaut", etat.localId, etat.payload);
      if (!reponse) return false;
      const { data } = reponse;
      const resultat = data?.resultats?.[0] as ResultatPush | undefined;
      const conflit = marquageConflit(resultat);
      if (conflit) {
        // CONFLIT : la saisie reste en file, marquee. `item` et non `etat` : un conflit n'est pas un echec.
        await updatePendingDefaut({ ...item, ...conflit });
        return false;
      }
      const droits = causeRefusDroits(resultat);
      if (droits) {
        // QUARANTAINE : refus de DROITS. `item` et non `etat` : ce n'est pas un echec, aucune tentative n'est comptee.
        await updatePendingDefaut({ ...item, ...marquageRefusDroits(droits) });
        return false;
      }
      if (!resultat || !["SYNCHRONISE", "REJOUEE"].includes(resultat.statut ?? "") || !resultat.entityId) {
        throw new Error(resultat?.motif ?? "Le serveur n'a pas confirmé la synchronisation du défaut.");
      }
      etat = { ...etat, serverId: resultat.entityId };
      await updatePendingDefaut(etat);
    }

    while (etat.photos?.length) {
      if (utilisateurSyncId !== userId) return false;
      const photo = etat.photos[0];
      const form = new FormData();
      form.append("photo", photo.blob, photo.name);
      form.append("capturedA", photo.capturedA);
      if (photo.lat !== undefined && photo.lon !== undefined) {
        form.append("lat", String(photo.lat));
        form.append("lon", String(photo.lon));
      }
      if (photo.precisionM !== undefined) form.append("precisionM", String(photo.precisionM));
      await api.post(`/v2/defauts/${etat.serverId}/photos`, form);
      etat = { ...etat, photos: etat.photos.slice(1) };
      await updatePendingDefaut(etat);
    }
    await removePendingDefaut(item.localId);
    return true;
  } catch (err) {
    if (signalerArret(err, userId)) return false;
    // Une saisie en conflit ne redevient pas « erreur » parce qu'un reseau a coupe pendant la verification.
    if (item.status === "conflit" && estErreurReseau(err)) return false;
    const message = messageErreur(err);
    const aProgresse = (!item.serverId && !!etat.serverId) || (etat.photos?.length ?? 0) < (item.photos?.length ?? 0);
    const echecsConsecutifs = aProgresse ? 0 : estErreurReseau(err) ? (item.tentatives ?? 0) : tentatives;
    const abandonnee = echecsConsecutifs >= MAX_TENTATIVES;
    await updatePendingDefaut({
      ...etat,
      tentatives: echecsConsecutifs,
      status: abandonnee ? "abandonnee" : "error",
      errorMessage: abandonnee
        ? `${message} (abandon après ${echecsConsecutifs} échecs consécutifs)`
        : message,
    });
    return false;
  }
}

/**
 * Synchronise une portion qualifiee hors ligne.
 *
 * PLUS SIMPLE QUE LES DEFAUTS, PARCE QU'IL N'Y A PAS DE PHOTOS
 *
 * Pas de boucle d'envoi partiel, donc pas d'etat intermediaire a reprendre : l'operation
 * aboutit ou non. `serverId` reste utile pour ne pas repousser une portion deja acceptee si
 * le retrait de la file echouait.
 *
 * UN REFUS DEFINITIF SORT DE LA FILE SANS ETRE PERDU
 *
 * Il est marque `abandonnee` avec son motif, et reste visible : l'agent doit savoir que sa
 * saisie n'est pas passee et pourquoi. Le retirer silencieusement ferait disparaitre une
 * observation de terrain ; le retenter en boucle ne viderait jamais la file.
 */
async function syncOnePortion(item: PendingPortion, userId: string): Promise<boolean> {
  if (item.status === "abandonnee" || item.status === STATUT_REFUS_DROITS || arretActif()) return false;
  const tentatives = (item.tentatives ?? 0) + 1;
  try {
    const reponse = await pousserCreation(userId, "Portion", item.localId, item.payload);
    if (!reponse) return false;
    const resultat = reponse.data?.resultats?.[0] as
      { statut?: string; entityId?: string; motif?: string } | undefined;

    if (resultat && ["SYNCHRONISE", "REJOUEE"].includes(resultat.statut ?? "")) {
      await removePendingPortion(item.localId);
      return true;
    }

    // Refus de DROITS : quarantaine, pas un echec (voir `marquageRefusDroits`).
    const droits = causeRefusDroits(resultat);
    if (droits) {
      await updatePendingPortion({ ...item, ...marquageRefusDroits(droits) });
      return false;
    }

    // REJETE : le serveur a tranche. `reessayerDansMs` absent signale un refus definitif,
    // et c'est le serveur qui le sait — lui seul connait l'etat du reseau.
    const definitif = resultat?.statut === "REJETE"
      && !(resultat as { reessayerDansMs?: number }).reessayerDansMs;
    if (definitif) {
      await updatePendingPortion({
        ...item,
        tentatives,
        status: "abandonnee",
        refusDefinitif: true,
        errorMessage: `Refusé : ${resultat?.motif ?? "motif non précisé"}. Cette saisie ne passera pas en l'état.`,
      });
      return false;
    }
    throw new Error(resultat?.motif ?? "Le serveur n'a pas confirmé la synchronisation de la portion.");
  } catch (err) {
    if (signalerArret(err, userId)) return false;
    const message = messageErreur(err);
    // Un reseau muet ne compte pas (voir `estErreurReseau`) : la portion reste en file, `error`.
    const comptees = estErreurReseau(err) ? (item.tentatives ?? 0) : tentatives;
    const abandonnee = comptees >= MAX_TENTATIVES;
    await updatePendingPortion({
      ...item,
      tentatives: comptees,
      status: abandonnee ? "abandonnee" : "error",
      errorMessage: abandonnee
        ? `${message} (abandon après ${comptees} échecs consécutifs)`
        : message,
    });
    return false;
  }
}

/**
 * Synchronise une observation saisie hors ligne (`POST /v2/sync/push`, entityType `Observation`, CREATE).
 *
 * MEME DISCIPLINE QUE LES PORTIONS ET LES DEFAUTS, ET QUATRE REGLES QUI NE SE NEGOCIENT PAS
 *
 * 1. La cle d'idempotence est `localId`, genere une fois a la saisie : operationId ET entityId. Une
 *    reponse perdue puis un renvoi donnent `REJOUEE` cote serveur, jamais un doublon.
 * 2. L'observation ne quitte la file QUE sur `SYNCHRONISE` ou `REJOUEE`. Un refus, un conflit, une erreur
 *    HTTP ou un reseau muet la laissent en file : une saisie de terrain perdue ne se refait pas.
 * 3. Refus definitif ou temporaire, c'est LE SERVEUR qui le dit : `reessayerDansMs` absent d'un `REJETE`
 *    signale un refus definitif (l'observation est marquee `abandonnee`, avec le motif, et reste visible).
 *    Le client ne devine pas.
 * 4. Un reseau muet ne compte pas dans le plafond de tentatives (voir `estErreurReseau`), et une saisie en
 *    CONFLIT ne devient jamais « erreur » parce qu'un reseau a coupe.
 */
async function syncOneObservation(item: PendingObservation, userId: string): Promise<boolean> {
  if (item.status === "abandonnee" || item.status === STATUT_REFUS_DROITS || arretActif()) return false;
  const tentatives = (item.tentatives ?? 0) + 1;
  // L'etat qui AVANCE (photos deja confirmees retirees) : c'est lui qu'on conserve apres un echec, pas l'etat de depart.
  let etat: PendingObservation = item;
  try {
    const reponse = await pousserCreation(userId, "Observation", item.localId, item.payload);
    if (!reponse) return false;
    const resultat = reponse.data?.resultats?.[0] as ResultatPush | undefined;

    if (resultat && ["SYNCHRONISE", "REJOUEE"].includes(resultat.statut ?? "")) {
      // Le serveur a l'observation : ses photos partent maintenant, UNE A UNE, chacune retiree de la file locale des que
      // le serveur l'a confirmee. Une coupure en route reprend a la photo suivante ; l'observation ne quitte la file
      // qu'avec sa derniere photo (une photo de terrain perdue ne se refait pas). L'identifiant serveur est celui de la saisie.
      etat = { ...item, serverId: resultat.entityId ?? item.localId };
      if (etat.photos?.length) await updatePendingObservation(etat);
      while (etat.photos?.length) {
        if (utilisateurSyncId !== userId) return false;
        const photo = etat.photos[0];
        const form = new FormData();
        form.append("photo", photo.blob, photo.name);
        form.append("capturedA", photo.capturedA);
        if (photo.lat !== undefined && photo.lon !== undefined) {
          form.append("lat", String(photo.lat));
          form.append("lon", String(photo.lon));
        }
        if (photo.precisionM !== undefined) form.append("precisionM", String(photo.precisionM));
        await api.post(`/v2/observations/${etat.serverId}/photos`, form);
        etat = { ...etat, photos: etat.photos.slice(1) };
        await updatePendingObservation(etat);
      }
      await removePendingObservation(item.localId);
      return true;
    }

    const conflit = marquageConflit(resultat);
    if (conflit) {
      await updatePendingObservation({
        ...item,
        ...conflit,
        // Un conflit n'est pas un echec : le compteur n'avance pas. Une decision `serveur` est definitive.
        refusDefinitif: conflit.status === "abandonnee" ? true : undefined,
      });
      return false;
    }

    // Refus de DROITS : quarantaine (statut propre, donnees et photos intactes), pas un echec ni un abandon.
    const droits = causeRefusDroits(resultat);
    if (droits) {
      await updatePendingObservation({ ...item, ...marquageRefusDroits(droits) });
      return false;
    }

    const definitif = resultat?.statut === "REJETE" && !resultat.reessayerDansMs;
    if (definitif) {
      await updatePendingObservation({
        ...item,
        tentatives,
        status: "abandonnee",
        refusDefinitif: true,
        errorMessage: `Refusé : ${resultat?.motif ?? "motif non précisé"}. Cette saisie ne passera pas en l'état.`,
      });
      return false;
    }
    throw new Error(resultat?.motif ?? "Le serveur n'a pas confirmé la synchronisation de l'observation.");
  } catch (err) {
    if (signalerArret(err, userId)) return false;
    if (item.status === "conflit" && estErreurReseau(err)) return false;
    const message = messageErreur(err);
    const aProgresse = (etat.photos?.length ?? 0) < (item.photos?.length ?? 0);
    const comptees = aProgresse ? 0 : estErreurReseau(err) ? (item.tentatives ?? 0) : tentatives;
    const abandonnee = comptees >= MAX_TENTATIVES;
    await updatePendingObservation({
      ...etat,
      tentatives: comptees,
      status: abandonnee ? "abandonnee" : item.status === "conflit" ? "conflit" : "error",
      errorMessage: abandonnee
        ? `${message} (abandon après ${comptees} échecs consécutifs)`
        : message,
    });
    return false;
  }
}

/**
 * Remet une observation abandonnee en file, apres que l'agent a lu le motif et agi (perimetre elargi,
 * mission reaffectee). Ne touche jamais une saisie en conflit : un responsable doit trancher.
 */
export async function relancerObservation(item: PendingObservation): Promise<void> {
  if (item.status !== "abandonnee") return;
  await updatePendingObservation({
    ...item, status: "pending", tentatives: 0, refusDefinitif: undefined, errorMessage: undefined,
  });
  await refreshPendingCount();
}

/**
 * Remet un defaut ABANDONNE en file (statut `pending`, compteur de tentatives a zero), a l'image de
 * `relancerObservation`.
 *
 * POURQUOI IL EXISTE. Un defaut deja cree cote serveur (`serverId`) dont les photos n'ont pas pu partir,
 * une fois `abandonnee`, n'avait AUCUNE issue : « Reprendre les photos » relancait une synchronisation qui
 * l'ignore (`syncOneDefaut` retourne tot sur `abandonnee`), et « Corriger » est masque des qu'un `serverId`
 * existe. Il ne restait que la suppression, donc la perte des photos. Le `serverId` et les photos restantes
 * sont CONSERVES : la reprise ne refait que ce qui manque, sans recreer le defaut.
 *
 * Ne touche jamais une saisie en conflit (un responsable doit trancher) ni une saisie qui n'est pas
 * abandonnee.
 */
export async function relancerDefaut(item: PendingDefaut): Promise<void> {
  if (item.status !== "abandonnee") return;
  await updatePendingDefaut({ ...item, status: "pending", tentatives: 0, errorMessage: undefined });
  await refreshPendingCount();
}

/**
 * Une saisie lue SANS photos (liste legere) est relue ENTIERE juste avant son envoi : une file de plusieurs dizaines de
 * saisies a photos tiendrait sinon toutes ses photos dechiffrees en memoire a la fois. Une saisie deja complete (lecture
 * pleine) est rendue telle quelle. `null` : la saisie a disparu ou ne se relit pas (alteree), on passe a la suivante.
 */
async function completer<T extends { localId: string }>(
  item: T | SansPhotos<T>, relire: (localId: string) => Promise<T | null>,
): Promise<T | null> {
  if (typeof (item as { nbPhotos?: unknown }).nbPhotos !== "number") return item as T;
  try {
    return await relire(item.localId);
  } catch (e) {
    if (estErreurStockageLocal(e, "DONNEES_ALTEREES")) return null;
    throw e;
  }
}

/**
 * Options d'un cycle. `manuel` : le cycle est lance par un GESTE de l'agent (bouton « Synchroniser »), pas par un evenement
 * (retour du reseau, onglet visible, saisie enregistree). Un geste reessaie l'enregistrement d'un appareil meme pendant le delai
 * d'un 403 APPAREIL_REVOCATION_RECENTE (voir `EtatEnregistrementAppareil`) ; un cycle automatique l'attend. Sans option : automatique
 * (le sens sur : une relance de trop coute une requete refusee, une attente de trop coute quelques minutes).
 */
export interface OptionsSynchronisation { readonly manuel?: boolean }

/** Synchronisation lancee par un geste de l'agent. */
export const synchroniserManuellement = (): Promise<void> => syncPendingOfflineData({ manuel: true });

export async function syncPendingOfflineData(options?: OptionsSynchronisation): Promise<void> {
  if (syncing) return;
  if (!navigator.onLine || !utilisateurSyncId) return;
  // Appareil retire, compte inactif : AUCUNE requete, file intacte. Voir `EtatSynchronisation`.
  if (arretAppareilRevoque || arretCompteInactif) return;
  const userId = utilisateurSyncId;

  syncing = true;
  arretCycle = false;
  reenregistrementFait = false;
  // `options` peut etre un evenement de clic passe tel quel a un `onClick` : seul `manuel === true` compte.
  gesteManuel = options?.manuel === true;
  emit();
  try {
    const all = await getAllPending({ sansPhotos: true });
    for (const leger of all) {
      if (leger.ownerUserId !== userId) continue;
      if (utilisateurSyncId !== userId || arretActif()) break;
      // Une inspection abandonnee n'est plus retentee : elle attend une intervention
      // humaine. La retenter en boucle masquerait le probleme sous du bruit.
      if (leger.status === "abandonnee") continue;
      const item = await completer(leger, (id) => getPendingInspection(id));
      if (item) await syncOne(item);
    }
    if (arretActif()) return;

    const defauts = await getAllPendingDefauts({ sansPhotos: true });
    for (const leger of defauts) {
      if (utilisateurSyncId !== userId || arretActif()) break;
      if (leger.ownerUserId !== userId) continue;
      // Abandonnee ou en quarantaine (refus de droits) : plus rejouee seule, elle attend l'agent.
      if (leger.status === "abandonnee" || leger.status === STATUT_REFUS_DROITS) continue;
      const item = await completer(leger, (id) => getPendingDefaut(id));
      if (item) await syncOneDefaut(item, userId);
    }
    if (arretActif()) return;

    const portions = await getAllPendingPortions();
    for (const item of portions) {
      if (utilisateurSyncId !== userId || arretActif()) break;
      if (item.ownerUserId !== userId) continue;
      await syncOnePortion(item, userId);
    }
    if (arretActif()) return;

    // Les plus anciennes d'abord : l'ordre de saisie est celui du terrain, pas celui des cles.
    const observations = (await getAllPendingObservations({ sansPhotos: true }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.localId.localeCompare(b.localId));
    for (const leger of observations) {
      if (utilisateurSyncId !== userId || arretActif()) break;
      if (leger.ownerUserId !== userId) continue;
      if (leger.status === "abandonnee" || leger.status === STATUT_REFUS_DROITS) continue;
      const item = await completer(leger, (id) => getPendingObservation(id));
      if (item) await syncOneObservation(item, userId);
    }
  } catch (e) {
    // Aucun compte ouvert, ou coffre verrouille : la file n'est pas lisible MAINTENANT. Ce n'est pas une erreur de
    // synchronisation : rien n'est perdu, rien n'est envoye, l'envoi reprendra au deverrouillage.
    if (!estErreurAccesFile(e)) throw e;
  } finally {
    syncing = false;
    gesteManuel = false;
    await refreshPendingCount();
  }
}

/** Files dont une saisie peut etre en quarantaine pour refus de droits : celles qui passent par `/v2/sync/push`. */
export type FileRelancable = "defauts" | "portions" | "observations";

/**
 * Ce que devient un renvoi explicite (`relancerRefusDroits`).
 *
 *   ENVOYEE                  le serveur a applique la saisie (droits rendus) : elle a quitte la file.
 *   TOUJOURS_REFUSEE         le serveur a refuse de nouveau pour droits : elle reste en quarantaine (cause et message mis a jour).
 *   EN_FILE                  la saisie est redevenue une saisie ordinaire mais l'envoi n'a pas abouti (reseau, erreur
 *                            passagere, refus de donnee...) : la synchronisation normale la reprendra.
 *   ARRET                    la synchronisation est arretee (appareil retire, compte inactif) : rien n'est envoye. Aussi : le serveur
 *                            a refuse d'enregistrer un appareil neuf (403 APPAREIL_REVOCATION_RECENTE) : la saisie reste en quarantaine.
 *   HORS_LIGNE               pas de reseau : rien n'est change, la saisie reste en quarantaine.
 *   SYNCHRONISATION_EN_COURS une synchronisation est deja en route : rien n'est change, reessayer ensuite.
 *   NON_EN_QUARANTAINE       la saisie n'existe pas, n'est pas a ce compte, ou n'est pas en quarantaine : rien n'est change.
 */
export type IssueRelanceDroits =
  | "ENVOYEE" | "TOUJOURS_REFUSEE" | "EN_FILE" | "ARRET" | "HORS_LIGNE" | "SYNCHRONISATION_EN_COURS" | "NON_EN_QUARANTAINE";

/**
 * Renvoi EXPLICITE d'une saisie en quarantaine pour refus de droits, a la demande de l'agent (ou apres que l'administrateur a
 * rendu les droits). Jamais appele par la synchronisation elle-meme : c'est ce qui evite de rejouer un refus en boucle.
 *
 * Le serveur REEVALUE : la meme operation, renvoyee avec la meme cle `operationId` (`localId`), est jugee sur les droits
 * d'aujourd'hui et appliquee s'ils sont rendus (SESSION-HORS-LIGNE-SERVEUR.md 2.3, regle 2). Si elle est refusee de nouveau, elle
 * retourne en quarantaine : rien n'est perdu a essayer. Donnees et photos chiffrees ne sont jamais touchees.
 *
 * Ne lance PAS de synchronisation de la file entiere : une seule saisie part. Ne touche pas aux saisies qui ne sont pas en
 * quarantaine. Les erreurs typees du stockage (COFFRE_VERROUILLE, AUCUN_COMPTE) sont propagees : l'interface sait les presenter.
 */
export async function relancerRefusDroits(localId: string, file: FileRelancable): Promise<IssueRelanceDroits> {
  const userId = utilisateurSyncId;
  if (!userId) return "NON_EN_QUARANTAINE";
  if (arretAppareilRevoque || arretCompteInactif) return "ARRET";
  if (!navigator.onLine) return "HORS_LIGNE";
  // Meme verrou que le cycle : un renvoi explicite et un cycle ne marchent pas ensemble sur la meme file.
  if (syncing) return "SYNCHRONISATION_EN_COURS";

  syncing = true;
  arretCycle = false;
  reenregistrementFait = false;
  // Un renvoi explicite est un geste de l'agent : il reessaie l'enregistrement meme pendant le delai d'une revocation recente.
  gesteManuel = true;
  emit();
  try {
    switch (file) {
      case "defauts": {
        const item = await getPendingDefaut(localId);
        if (!item || item.ownerUserId !== userId || item.status !== STATUT_REFUS_DROITS) return "NON_EN_QUARANTAINE";
        const remise: PendingDefaut = { ...item, status: "pending", tentatives: 0, errorMessage: undefined, causeRefusDroits: undefined };
        await updatePendingDefaut(remise);
        await syncOneDefaut(remise, userId);
        const apres = await getPendingDefaut(localId);
        if (apres && arretActif()) {
          // L'arret est tombe pendant ce renvoi : la saisie n'a pas ete jugee. Elle retourne en quarantaine (sauf si le serveur
          // l'avait deja acceptee : son avancement est alors conserve tel quel et la reprise normale la finira).
          if (!apres.serverId) await updatePendingDefaut({ ...apres, status: STATUT_REFUS_DROITS, causeRefusDroits: item.causeRefusDroits, errorMessage: item.errorMessage, tentatives: item.tentatives });
          return "ARRET";
        }
        return issueRelance(apres);
      }
      case "portions": {
        const item = await getPendingPortion(localId);
        if (!item || item.ownerUserId !== userId || item.status !== STATUT_REFUS_DROITS) return "NON_EN_QUARANTAINE";
        const remise: PendingPortion = { ...item, status: "pending", tentatives: 0, errorMessage: undefined, causeRefusDroits: undefined };
        await updatePendingPortion(remise);
        await syncOnePortion(remise, userId);
        const apres = await getPendingPortion(localId);
        if (apres && arretActif()) {
          // L'arret est tombe pendant ce renvoi : la saisie n'a pas ete jugee. Elle retourne en quarantaine (sauf si le serveur
          // l'avait deja acceptee : son avancement est alors conserve tel quel et la reprise normale la finira).
          if (!apres.serverId) await updatePendingPortion({ ...apres, status: STATUT_REFUS_DROITS, causeRefusDroits: item.causeRefusDroits, errorMessage: item.errorMessage, tentatives: item.tentatives });
          return "ARRET";
        }
        return issueRelance(apres);
      }
      case "observations": {
        const item = await getPendingObservation(localId);
        if (!item || item.ownerUserId !== userId || item.status !== STATUT_REFUS_DROITS) return "NON_EN_QUARANTAINE";
        const remise: PendingObservation = { ...item, status: "pending", tentatives: 0, errorMessage: undefined, causeRefusDroits: undefined };
        await updatePendingObservation(remise);
        await syncOneObservation(remise, userId);
        const apres = await getPendingObservation(localId);
        if (apres && arretActif()) {
          // L'arret est tombe pendant ce renvoi : la saisie n'a pas ete jugee. Elle retourne en quarantaine (sauf si le serveur
          // l'avait deja acceptee : son avancement est alors conserve tel quel et la reprise normale la finira).
          if (!apres.serverId) await updatePendingObservation({ ...apres, status: STATUT_REFUS_DROITS, causeRefusDroits: item.causeRefusDroits, errorMessage: item.errorMessage, tentatives: item.tentatives });
          return "ARRET";
        }
        return issueRelance(apres);
      }
      default:
        return "NON_EN_QUARANTAINE";
    }
  } finally {
    syncing = false;
    gesteManuel = false;
    await refreshPendingCount();
  }
}

function issueRelance(apres: { status: string } | null): IssueRelanceDroits {
  if (apres === null) return "ENVOYEE";
  return apres.status === STATUT_REFUS_DROITS ? "TOUJOURS_REFUSEE" : "EN_FILE";
}

/** Alias conservé pour les pages qui déclenchent la sync depuis le parcours inspection. */
export const syncPendingInspections = syncPendingOfflineData;

let started = false;
export function startOfflineSync() {
  if (started) return;
  started = true;
  refreshPendingCount();
  window.addEventListener("online", () => syncPendingOfflineData());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && navigator.onLine) syncPendingOfflineData();
  });
  if (navigator.onLine) syncPendingOfflineData();
}
