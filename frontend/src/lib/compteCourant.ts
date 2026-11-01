/**
 * Compte courant du stockage local (conception : docs/securite/SESSION-HORS-LIGNE.md, sections 3 et 4).
 *
 * Ce module porte UN seul etat : quel compte est ouvert sur ce telephone, et avec quel chiffreur. Tout le
 * stockage local (offlineDb, roulageHote, cles localStorage) en depend ; aucun d'eux ne connait WebCrypto ni
 * la session. Il ne chiffre rien lui-meme : le chiffreur est une INTERFACE que `CoffreSession`
 * (src/session/coffreSession.ts) satisfait telle quelle.
 *
 * ---------------------------------------------------------------------------------------------------
 * CONTRAT POUR L'INTEGRATEUR (auth.tsx, route protegee, ecran de deverrouillage)
 * ---------------------------------------------------------------------------------------------------
 *
 *   const empreinte = await empreinteCompte(user.id, sha256WebCrypto);          // src/session/compteLocal.ts
 *   ouvrirCompte({ compteId: user.id, empreinte, chiffreur: coffre });          // coffre : CoffreSession
 *
 * 1. QUAND OUVRIR. Des qu'un compte est connu de l'appareil : apres une connexion en ligne (coffre cree, donc
 *    deverrouille) ou des que l'ecran PIN a la main sur un coffre existant (coffre encore VERROUILLE : c'est
 *    permis). Ouvrir un compte dont le coffre est verrouille donne un stockage visible mais ILLISIBLE :
 *    les compteurs par statut marchent (ils ne demandent aucune cle), tout le reste leve COFFRE_VERROUILLE.
 *
 * 2. APRES CHAQUE DEVERROUILLAGE REUSSI, rappeler `ouvrirCompte` avec les memes arguments. C'est sans cout
 *    (rien ne change si le compte et le chiffreur sont les memes) et cela reveille les ecritures retenues en
 *    memoire pendant le verrou (journal de roulage). Le verrouillage (`coffre.verrouiller()`) n'a pas besoin
 *    d'etre annonce ici : le chiffreur dit lui-meme s'il est deverrouille.
 *
 * 3. CHANGEMENT DE COMPTE, DECONNEXION, REINITIALISATION DU PIN : `fermerCompte()` AVANT. Apres
 *    `coffre.reinitialiser()`, l'ancien chiffreur ne doit plus servir : appeler `fermerCompte()` puis
 *    `ouvrirCompte` avec le nouveau coffre (les copies de photos retenues en memoire sont ecartees).
 *    Se deconnecter n'EFFACE rien : la base du compte reste, chiffree, et repart a la prochaine connexion.
 *
 * 4. ERREURS TYPEES (`ErreurStockageLocal`, champ `code`, test `estErreurStockageLocal(e, code?)`) :
 *      AUCUN_COMPTE        aucun compte ouvert : jamais d'ecriture, jamais de repli sur un autre stockage.
 *      COFFRE_VERROUILLE   le chiffreur est verrouille : afficher l'ecran PIN, ne rien perdre.
 *      STOCKAGE_PLEIN      la saisie n'est PAS enregistree (quota). Ne jamais annoncer « enregistree ».
 *      ECRITURE_ANNULEE    autre abandon de transaction : meme conduite, la saisie n'est pas enregistree.
 *      PHOTO_TROP_GROSSE   une photo depasse 8 Mio (message en francais, pret a afficher).
 *      TROP_DE_PHOTOS      plus de 5 photos pour une saisie (idem).
 *      DONNEES_ALTEREES    un enregistrement chiffre ne se relit pas (altere, autre cle, format inconnu).
 *      COMPTE_INCOHERENT   une saisie porte un autre `ownerUserId`, ou le chiffreur est celui d'un autre compte.
 *      ARGUMENT_INVALIDE, INDEXEDDB_INDISPONIBLE, LECTURE_ECHOUEE.
 *    Le `message` est destine a l'agent (francais, sans contenu de saisie).
 *
 * 5. CE QUE LE STOCKAGE FAIT POUR VOUS : lire la file (`getAllPending*`), l'ecrire (`addPending*`), compter
 *    (`compterFile`), synchroniser (`offlineSync`), journaliser le roulage (`ouvrirStockage`) resolvent le
 *    compte COURANT a chaque appel. Aucune fonction ne prend de compte en argument : un autre compte n'est
 *    atteignable par aucune API (sa base porte un autre nom, sa cle un autre AAD).
 *
 * 6. localStorage : `lireStockageLocal(nom)`, `ecrireStockageLocal(nom, valeur)`, `retirerStockageLocal(nom)`
 *    posent la cle `bdri:<empreinte>:<nom>` du compte courant. Sans compte ouvert : rien n'est lu, rien n'est
 *    ecrit (retour `null` / `false`), JAMAIS de cle sans prefixe.
 *
 * 7. COMPTEURS D'INFORMATION (cle `compteurs`, EN CLAIR par conception) : `{ saisies, releves, maj }` par
 *    empreinte. Ils permettent de dire « des saisies d'un autre compte sont en attente sur ce telephone »
 *    sans en montrer le contenu : `resumeAutresComptes()`. Mis a jour par `compterFile()` et par le journal
 *    de roulage ; jamais de contenu, d'identifiant de compte ni de date de saisie.
 *
 * 8. MIGRATION DE L'HERITAGE (`migrationHeritage.ts`) : a appeler une fois le coffre deverrouille, a la
 *    premiere ouverture du compte (voir l'en-tete de ce module). Rejouable sans risque.
 */
import { cleLocalStorage, LONGUEUR_EMPREINTE, empreinteValide } from "../session/compteLocal";

// ---------------------------------------------------------------------------------------------------
// Erreurs typees
// ---------------------------------------------------------------------------------------------------

export type CodeErreurStockage =
  | "AUCUN_COMPTE"
  | "COFFRE_VERROUILLE"
  | "STOCKAGE_PLEIN"
  | "ECRITURE_ANNULEE"
  | "DONNEES_ALTEREES"
  | "PHOTO_TROP_GROSSE"
  | "TROP_DE_PHOTOS"
  | "COMPTE_INCOHERENT"
  | "ARGUMENT_INVALIDE"
  | "INDEXEDDB_INDISPONIBLE"
  | "LECTURE_ECHOUEE";

const MESSAGES_PAR_DEFAUT: Record<CodeErreurStockage, string> = {
  AUCUN_COMPTE: "Aucun compte n'est ouvert sur cet appareil : les saisies locales sont inaccessibles.",
  COFFRE_VERROUILLE: "La session locale est verrouillée : saisissez votre code PIN pour accéder aux saisies de ce téléphone.",
  STOCKAGE_PLEIN: "Stockage de l'appareil plein : la saisie n'est PAS enregistrée. Libérez de la place ou synchronisez avant de continuer.",
  ECRITURE_ANNULEE: "Écriture locale annulée : la saisie n'est PAS enregistrée.",
  DONNEES_ALTEREES: "Une saisie locale est illisible (altérée ou chiffrée avec une autre clé). Elle est conservée telle quelle.",
  PHOTO_TROP_GROSSE: "Une photo dépasse la taille maximale de 8 Mio : la saisie n'est PAS enregistrée.",
  TROP_DE_PHOTOS: "Cinq photos au maximum par saisie : la saisie n'est PAS enregistrée.",
  COMPTE_INCOHERENT: "Cette saisie n'appartient pas au compte ouvert sur cet appareil : elle n'est PAS enregistrée.",
  ARGUMENT_INVALIDE: "Saisie locale invalide : elle n'est PAS enregistrée.",
  INDEXEDDB_INDISPONIBLE: "Le stockage local du navigateur est indisponible : rien ne peut être conservé hors ligne.",
  LECTURE_ECHOUEE: "Lecture du stockage local impossible.",
};

/** Erreur typee du stockage local. Le message ne porte jamais de contenu de saisie. */
export class ErreurStockageLocal extends Error {
  readonly code: CodeErreurStockage;
  constructor(code: CodeErreurStockage, message?: string) {
    super(message ?? MESSAGES_PAR_DEFAUT[code]);
    this.name = "ErreurStockageLocal";
    this.code = code;
  }
}

export function estErreurStockageLocal(erreur: unknown, code?: CodeErreurStockage): erreur is ErreurStockageLocal {
  return erreur instanceof ErreurStockageLocal && (code === undefined || erreur.code === code);
}

/** Vrai pour les deux erreurs qui disent « pas de file lisible maintenant » (a traiter en silence par la synchronisation). */
export function estErreurAccesFile(erreur: unknown): boolean {
  return estErreurStockageLocal(erreur, "AUCUN_COMPTE") || estErreurStockageLocal(erreur, "COFFRE_VERROUILLE");
}

/**
 * Traduit une erreur du chiffreur (`ErreurCoffre` du coffre, reconnue par son nom et son code pour ne pas
 * importer WebCrypto ici) en erreur typee du stockage. Une erreur inconnue est rendue telle quelle.
 */
export function traduireErreurChiffrement(erreur: unknown): unknown {
  if (erreur instanceof ErreurStockageLocal) return erreur;
  if (typeof erreur === "object" && erreur !== null && (erreur as { name?: unknown }).name === "ErreurCoffre") {
    switch ((erreur as { code?: unknown }).code) {
      case "VERROUILLE": return new ErreurStockageLocal("COFFRE_VERROUILLE");
      case "DONNEES_ALTEREES": return new ErreurStockageLocal("DONNEES_ALTEREES");
      case "BLOB_TROP_GROS": return new ErreurStockageLocal("PHOTO_TROP_GROSSE");
      case "ARGUMENT_INVALIDE": return new ErreurStockageLocal("ARGUMENT_INVALIDE");
      default: return erreur;
    }
  }
  return erreur;
}

// ---------------------------------------------------------------------------------------------------
// Chiffreur et compte
// ---------------------------------------------------------------------------------------------------

/**
 * Ce que le stockage attend d'un chiffreur. `CoffreSession` le satisfait sans adaptateur (test de typage dans
 * compteCourant.test.ts). Les photos passent par `chiffrerBlob` (un bloc par photo, type MIME conserve,
 * 8 Mio au plus) et les charges utiles par `chiffrer` avec une AAD `compteId|identifiantLocal|version`.
 */
export interface Chiffreur {
  /** Identifiant du compte du chiffreur, quand il le connait : controle de coherence a l'ouverture. */
  readonly compteId?: string;
  estDeverrouille(): boolean;
  chiffrer(donnees: Uint8Array | ArrayBuffer | object, aad: string | Uint8Array): Promise<Uint8Array>;
  dechiffrer(paquet: Uint8Array, aad: string | Uint8Array): Promise<Uint8Array>;
  dechiffrerJson<T>(paquet: Uint8Array, aad: string | Uint8Array): Promise<T>;
  chiffrerBlob(blob: Blob, identifiantLocal: string, version?: number): Promise<Uint8Array>;
  dechiffrerBlob(paquet: Uint8Array, identifiantLocal: string, version?: number): Promise<Blob>;
}

export interface ContexteCompte {
  readonly compteId: string;
  /** Empreinte du compte (16 hexa) : nom des bases et prefixe des cles localStorage. */
  readonly empreinte: string;
  readonly chiffreur: Chiffreur;
  /** Change a chaque changement de compte ou de chiffreur (ecarte les copies retenues en memoire). */
  readonly generation: number;
}

let courant: ContexteCompte | null = null;
let generation = 0;
const abonnes = new Set<() => void>();

function notifier(): void {
  for (const a of [...abonnes]) {
    try { a(); } catch { /* un abonne defaillant ne bloque pas les autres */ }
  }
}

/** Ouvre le compte courant (voir l'en-tete pour le moment de l'appel). Rappel identique : sans effet, mais abonnes reveilles. */
export function ouvrirCompte(options: { compteId: string; empreinte: string; chiffreur: Chiffreur }): ContexteCompte {
  const { compteId, empreinte, chiffreur } = options;
  if (typeof compteId !== "string" || compteId.length === 0) throw new ErreurStockageLocal("ARGUMENT_INVALIDE", "Identifiant de compte vide.");
  if (!empreinteValide(empreinte)) throw new ErreurStockageLocal("ARGUMENT_INVALIDE", "Empreinte de compte invalide.");
  if (!chiffreur || typeof chiffreur.estDeverrouille !== "function") throw new ErreurStockageLocal("ARGUMENT_INVALIDE", "Chiffreur absent.");
  if (chiffreur.compteId !== undefined && chiffreur.compteId !== compteId) throw new ErreurStockageLocal("COMPTE_INCOHERENT");
  const identique = courant !== null && courant.compteId === compteId && courant.empreinte === empreinte && courant.chiffreur === chiffreur;
  if (!identique) {
    generation += 1;
    courant = { compteId, empreinte, chiffreur, generation };
  }
  notifier();
  return courant as ContexteCompte;
}

/** Ferme le compte courant. N'efface rien et ne verrouille pas le coffre (c'est a l'appelant de le faire). */
export function fermerCompte(): void {
  if (courant === null) return;
  courant = null;
  generation += 1;
  notifier();
}

export function compteCourant(): ContexteCompte | null {
  return courant;
}

export type EtatCompte = "AUCUN" | "VERROUILLE" | "OUVERT";

export function etatCompte(): EtatCompte {
  if (courant === null) return "AUCUN";
  return courant.chiffreur.estDeverrouille() ? "OUVERT" : "VERROUILLE";
}

export function abonnerCompte(rappel: () => void): () => void {
  abonnes.add(rappel);
  return () => { abonnes.delete(rappel); };
}

export function exigerCompte(): ContexteCompte {
  if (courant === null) throw new ErreurStockageLocal("AUCUN_COMPTE");
  return courant;
}

/** Le chiffreur du contexte, ou COFFRE_VERROUILLE. Jamais de repli : sans cle, pas d'ecriture. */
export function exigerDeverrouille(contexte: ContexteCompte): Chiffreur {
  if (!contexte.chiffreur.estDeverrouille()) throw new ErreurStockageLocal("COFFRE_VERROUILLE");
  return contexte.chiffreur;
}

// ---------------------------------------------------------------------------------------------------
// AAD des enregistrements
// ---------------------------------------------------------------------------------------------------

/**
 * AAD d'un enregistrement ou d'un bloc : `compteId|identifiantLocal|version`. Meme forme que `aadBlob` du coffre
 * (qui s'en sert pour les photos). Un paquet relu sous un autre compte, une autre saisie ou une autre version
 * de format est rejete par l'authentification AES-GCM.
 */
export function aadEnregistrement(compteId: string, identifiantLocal: string, version: number): string {
  if (!identifiantLocal || identifiantLocal.includes("|") || !Number.isInteger(version) || version < 0) {
    throw new ErreurStockageLocal("ARGUMENT_INVALIDE", "Identifiant de saisie invalide.");
  }
  return `${compteId}|${identifiantLocal}|${version}`;
}

// ---------------------------------------------------------------------------------------------------
// localStorage du compte
// ---------------------------------------------------------------------------------------------------

function stockageNavigateur(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Empreinte a utiliser, ou `null` : pas de compte ouvert, ou compte different de celui demande. */
function empreinteVoulue(compteId?: string): string | null {
  if (courant === null) return null;
  if (compteId !== undefined && courant.compteId !== compteId) return null;
  return courant.empreinte;
}

/**
 * Lit une cle localStorage DU COMPTE COURANT. `compteId` (facultatif) protege un appel asynchrone qui a
 * commence sous un compte et finit sous un autre : la cle n'est alors ni lue ni ecrite.
 */
export function lireStockageLocal(nom: string, compteId?: string): string | null {
  const empreinte = empreinteVoulue(compteId);
  const s = stockageNavigateur();
  if (empreinte === null || s === null) return null;
  try { return s.getItem(cleLocalStorage(empreinte, nom)); } catch { return null; }
}

/** Vrai si la valeur a ete ecrite. Faux : pas de compte, stockage refuse (quota, mode prive). */
export function ecrireStockageLocal(nom: string, valeur: string, compteId?: string): boolean {
  const empreinte = empreinteVoulue(compteId);
  const s = stockageNavigateur();
  if (empreinte === null || s === null) return false;
  try { s.setItem(cleLocalStorage(empreinte, nom), valeur); return true; } catch { return false; }
}

export function retirerStockageLocal(nom: string, compteId?: string): void {
  const empreinte = empreinteVoulue(compteId);
  const s = stockageNavigateur();
  if (empreinte === null || s === null) return;
  try { s.removeItem(cleLocalStorage(empreinte, nom)); } catch { /* rien a faire */ }
}

/** Nom de la cle localStorage de l'identifiant d'appareil de synchronisation (partage par offlineSync et l'ecran de roulage). */
export const NOM_CLE_APPAREIL_SYNC = "sync.device";

// ---------------------------------------------------------------------------------------------------
// Compteurs d'information, en clair
// ---------------------------------------------------------------------------------------------------

const NOM_COMPTEURS = "compteurs";
const MOTIF_CLE_COMPTEURS = new RegExp(`^bdri:([0-9a-f]{${LONGUEUR_EMPREINTE}}):${NOM_COMPTEURS}$`);

/** Rien de plus que des nombres : ni contenu, ni identifiant de compte. */
export interface CompteursInfo {
  /** Saisies en file (inspections, defauts, portions, observations), tous statuts. */
  readonly saisies: number;
  /**
   * Releves de roulage non confirmes AVEC POSITIONS, y compris un releve EN COURS. Le compteur est pose des les premieres
   * positions ecrites (roulageHote.ts, `ecrireLot`), pas a l'arret : une page tuee en plein releve ne l'arrete jamais, et ses
   * points n'existent que sur ce telephone. 0 ou 1 par compte (un seul journal). Il retombe a 0 quand le journal est vide
   * (`vider`) et quand le serveur confirme l'envoi (`noterEnvoiConfirme`, releveVue.ts).
   */
  readonly releves: number;
  readonly maj: string;
}

const entierPositif = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

function analyserCompteurs(brut: string | null): CompteursInfo | null {
  if (!brut) return null;
  try {
    const o = JSON.parse(brut) as { saisies?: unknown; releves?: unknown; maj?: unknown };
    if (!entierPositif(o.saisies) || !entierPositif(o.releves)) return null;
    return { saisies: o.saisies, releves: o.releves, maj: typeof o.maj === "string" ? o.maj : "" };
  } catch {
    return null;
  }
}

export function lireCompteurs(empreinte: string): CompteursInfo | null {
  const s = stockageNavigateur();
  if (s === null) return null;
  try { return analyserCompteurs(s.getItem(cleLocalStorage(empreinte, NOM_COMPTEURS))); } catch { return null; }
}

/** Met a jour les compteurs d'une empreinte. N'ecrit que si un nombre change. Ne leve jamais. */
export function majCompteurs(empreinte: string, patch: Partial<Pick<CompteursInfo, "saisies" | "releves">>): void {
  const s = stockageNavigateur();
  if (s === null) return;
  try {
    const avant = lireCompteurs(empreinte) ?? { saisies: 0, releves: 0, maj: "" };
    const saisies = patch.saisies ?? avant.saisies;
    const releves = patch.releves ?? avant.releves;
    if (!entierPositif(saisies) || !entierPositif(releves)) return;
    if (saisies === avant.saisies && releves === avant.releves && avant.maj !== "") return;
    s.setItem(cleLocalStorage(empreinte, NOM_COMPTEURS), JSON.stringify({ saisies, releves, maj: new Date().toISOString() }));
  } catch { /* information seulement : sa perte ne touche aucune saisie */ }
}

/** Met a jour les compteurs du compte courant. Sans compte ouvert : sans effet. */
export function majCompteursCourant(patch: Partial<Pick<CompteursInfo, "saisies" | "releves">>): void {
  if (courant !== null) majCompteurs(courant.empreinte, patch);
}

export interface ResumeAutresComptes {
  /** Nombre d'AUTRES comptes de ce telephone qui ont des saisies ou un releve en attente. */
  readonly comptes: number;
  readonly saisies: number;
  readonly releves: number;
}

/**
 * Ce que les AUTRES comptes de ce telephone ont en attente, sans contenu : de quoi afficher « des saisies
 * d'un autre compte sont en attente sur ce telephone ». Sans compte ouvert, tous les comptes comptent comme
 * « autres ». Valeurs d'information : un compteur n'est mis a jour que par le compte qui les possede.
 */
export function resumeAutresComptes(): ResumeAutresComptes {
  const vide: ResumeAutresComptes = { comptes: 0, saisies: 0, releves: 0 };
  const s = stockageNavigateur();
  if (s === null) return vide;
  let comptes = 0; let saisies = 0; let releves = 0;
  try {
    for (let i = 0; i < s.length; i += 1) {
      const cle = s.key(i);
      const m = cle === null ? null : MOTIF_CLE_COMPTEURS.exec(cle);
      if (m === null || (courant !== null && m[1] === courant.empreinte)) continue;
      const c = analyserCompteurs(s.getItem(cle as string));
      if (c === null || (c.saisies === 0 && c.releves === 0)) continue;
      comptes += 1; saisies += c.saisies; releves += c.releves;
    }
  } catch {
    return vide;
  }
  return { comptes, saisies, releves };
}
