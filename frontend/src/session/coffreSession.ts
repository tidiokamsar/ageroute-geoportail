/**
 * Coffre de session locale : WebCrypto, port de stockage injectable
 * (conception : docs/securite/SESSION-HORS-LIGNE.md, sections 1, 2, 3 et 10).
 *
 * PRINCIPE
 *   Une cle de donnees (DEK) AES-GCM 256, aleatoire, creee avec la session locale. Elle n'est JAMAIS ecrite
 *   en clair : on ne persiste que sa forme enveloppee (AES-GCM, `wrapKey`) par une cle derivee du PIN de
 *   l'agent (PBKDF2-SHA256, sel aleatoire, iterations versionnees dans l'enveloppe). Le profil de session
 *   (userId, nom, role, modules, regions, emisLe, valideLe, expireLe) est chiffre par la DEK. AUCUN jeton
 *   reseau n'est accepte ni stocke : le type `IdentiteProfil` n'a pas de champ de jeton et la fonction
 *   de construction du profil ne copie que les champs connus.
 *   En memoire, la DEK est une `CryptoKey` NON extractible : le code de l'application ne peut pas la relire,
 *   seulement s'en servir (limite assumee : une XSS sur l'origine s'en servirait aussi).
 *
 * CONTRAT POUR LES INTEGRATEURS
 *
 *   const stockage = stockageIndexedDb();                  // reel ; en test : stockageEnMemoire()
 *   const coffre = await creerCoffre({ stockage, compteId, appareilId, pin, profil, maintenantMs });
 *       // apres une connexion EN LIGNE complete. Jette ErreurCoffre COFFRE_EXISTANT / PIN_INVALIDE.
 *       // Deux creations simultanees (deux onglets) : une seule reussit, l'autre jette COFFRE_EXISTANT.
 *       // Valider le PIN avant avec `validerPin(pin)` pour montrer le motif a l'agent.
 *   const coffre = ouvrirCoffre({ stockage, compteId, appareilId });   // coffre existant, VERROUILLE
 *
 *   await coffre.deverrouiller(pin, maintenantMs)
 *       -> { ok: true, profil } | { ok: false, erreur, reessayerDansMs?, motif? }
 *       erreur : PIN_INCORRECT | COFFRE_ABSENT | EXPIRE | AUTRE_COMPTE | AUTRE_APPAREIL | DELAI_EN_COURS
 *                | COFFRE_ILLISIBLE | VERROUILLE (verrouiller() est survenu pendant l'operation : rien n'est ouvert)
 *       Ordre des controles : coffre present, bon compte et bon appareil, delai en cours, PIN, puis seulement
 *       alors expiration (EXPIRE ne se revele qu'a qui connait le PIN). EXPIRE a un `motif` : DUREE ou HORLOGE.
 *   coffre.verrouiller()               // abandonne les references a la DEK et au profil (voir MEMOIRE)
 *   coffre.estDeverrouille(), coffre.profilCourant()
 *   await coffre.chiffrer(octetsOuObjet, aad) -> Uint8Array   // paquet [version|IV|chiffre+etiquette]
 *   await coffre.dechiffrer(paquet, aad) -> Uint8Array ; coffre.dechiffrerJson<T>(paquet, aad)
 *       AAD des enregistrements d'une file : `aadFile(nomFile, compteId, id, rev)`, qui separe les domaines
 *       (`bdri-coffre|1|file|<nom>|<compteId>|<id>|<rev>`) de l'AAD de la cle enveloppee et de celle du profil.
 *   await coffre.chiffrerBlob(blob, identifiantLocal, version?) / dechiffrerBlob(...)  -> un bloc par photo
 *       AAD = `aadFile("blob", compteId, identifiantLocal, version)`, IV aleatoire de 96 bits a CHAQUE ecriture,
 *       8 Mio au plus (TAILLE_MAX_BLOB_OCTETS), type MIME conserve. Un paquet lu avec un autre identifiant,
 *       une autre version, un autre compte ou une etiquette alteree est REJETE (ErreurCoffre DONNEES_ALTEREES).
 *       Transitoire : `dechiffrerBlob` relit aussi l'ancienne AAD `aadBlob` (`compteId|id|version`), que
 *       `chiffrerBlob` n'ecrit plus ; a retirer des qu'aucun bloc ancien n'existe plus.
 *   await coffre.changerPin(ancien, nouveau, maintenantMs) -> { ok: true } | { ok: false, erreur }
 *       La DEK ne change pas : les donnees deja chiffrees restent lisibles.
 *   await coffre.revalider({ pin, identite, maintenantMs })    // connexion en ligne apres expiration ou
 *       droits modifies : reecrit le profil (droits du serveur) avec une validite neuve.
 *   await coffre.prolonger({ maintenantMs, identite? })        // coffre ouvert : repousse la validite sans PIN.
 *       A appeler apres chaque rafraichissement reussi si la DEK est en memoire. Si elle ne l'est pas, rien
 *       n'est repousse : la validite persistee reste l'ancienne (cote prudent).
 *   await coffre.reinitialiser()       // PIN oublie : detruit l'enveloppe ; les saisies chiffrees deviennent
 *                                      // illisibles. A confirmer et journaliser par l'appelant.
 *   await coffre.lireMeta()            // existence, compteur d'echecs, pasAvantMs, marque d'horloge : de quoi
 *                                      // construire `contexteInitial` du noyau, sans le PIN.
 *   await coffre.noterInstant(ms)      // persiste la marque haute d'horloge (detection d'un recul)
 *
 * SIMULTANEITE (deux onglets, deux appels en vol)
 *   Toute operation qui lit puis ecrit l'enveloppe (creer, deverrouiller, changerPin, revalider, prolonger,
 *   noterInstant, reinitialiser) s'execute sous un verrou exclusif par compte : Web Locks
 *   (`navigator.locks.request("bdri-coffre:" + compteId, ...)`, inter-onglets) ou, quand `navigator.locks`
 *   est absent (tests Node anciens, vieille WebView), un verrou en memoire par compte. LE REPLI EN MEMOIRE NE
 *   PROTEGE QUE DANS UN MEME CONTEXTE JS : deux onglets sans Web Locks peuvent encore s'entrecroiser.
 *   Trois garde-fous complementaires, utiles meme sans verrou inter-contextes :
 *   - la creation passe par `StockageCoffre.add` (echoue si la cle existe : `add` d'IndexedDB) ; deux
 *     creations simultanees ne peuvent pas toutes deux reussir ;
 *   - chaque ecriture RELIT l'enveloppe courante juste avant le `put` et ne modifie que les champs voulus
 *     (jamais un instantane lu avant une derivation d'une seconde), et incremente `rev` ;
 *   - apres la derivation, l'enveloppe est relue : si la cle enveloppee ou les parametres de derivation ont
 *     change entre-temps (changement de PIN ailleurs), l'ancien PIN est refuse (PIN_INCORRECT).
 *   `verrouiller()` incremente un jeton de generation controle apres chaque attente : une operation lancee
 *   avant le verrou ne peut plus restaurer la DEK ni le profil.
 *
 * COMPTEUR D'ECHECS PERSISTANT
 *   Incremente et ECRIT avant la derivation du PIN (un processus tue pendant l'essai compte quand meme),
 *   remis a zero apres un succes. Delai selon `delaiApresEchecs` du noyau, controle sous verrou : N essais
 *   simultanes comptent N, et le delai s'applique aux essais paralleles. Aucune destruction automatique.
 *   LIMITE : le compteur, le delai et la marque d'horloge sont en clair dans l'enveloppe. Ils protegent
 *   l'interface, PAS contre une copie de la base : l'attaquant essaie des PIN sur son materiel et peut
 *   modifier compteur, delai et marque d'horloge. Seules la longueur et l'imprevisibilite du PIN,
 *   multipliees par le cout de derivation, y resistent.
 *
 * PIN ET COUT DE DERIVATION
 *   6 chiffres = 10^6 possibilites (environ 19,9 bits). Sur un coeur du poste de mesure ci-dessous
 *   (600 000 iterations, mediane 1,2 s) : espace complet environ 14 jours, moyenne environ 7 jours. Ordre de
 *   grandeur sur UN SEUL coeur, non representatif d'un GPU ni d'un telephone : aucun chiffre n'est donne pour
 *   ceux-ci. Recommandation : phrase de passe (le code accepte deja 128 caracteres), liste de PIN triviaux
 *   refusee, iterations calibrees sur un telephone d'entree de gamme. L'OWASP Password Storage Cheat Sheet
 *   indique 600 000 pour PBKDF2-HMAC-SHA256 : valeur retenue = minimum actuel, pas une marge.
 *   Plancher a la creation, au changement de PIN et a la revalidation : ITERATIONS_PBKDF2_MIN (100 000), sauf
 *   `iterationsDeTest: true` ; borne haute de lecture ITERATIONS_PBKDF2_MAX (10 000 000), au-dela de quoi
 *   l'enveloppe est illisible (une valeur trafiquee ne doit pas figer l'appareil). Un deverrouillage reussi
 *   d'une enveloppe qui porte MOINS d'iterations que le reglage courant la reecrit avec le reglage courant.
 *
 * RETOUR EN ARRIERE
 *   Un enregistrement chiffre ancien, ou une copie ancienne de toute la base, se relit sans erreur : le
 *   chiffrement protege la confidentialite et l'integrite de chaque enregistrement, pas sa fraicheur ni sa
 *   presence. Un enregistrement peut etre supprime ou remplace par une version plus ancienne valide sans
 *   que le coffre le detecte.
 *
 * EXPIRATION
 *   Controle applicatif de 7 jours. Il n'efface pas le coffre et ne le rend pas cryptographiquement
 *   inutilisable (la DEK reste enveloppee sous le meme PIN) ; il repose sur l'horloge du poste.
 *
 * IV
 *   96 bits aleatoires par ecriture, sous une DEK jamais renouvelee. Probabilite de collision d'IV apres n
 *   ecritures : environ n^2 / 2^97 (6e-22 pour 10^4 ecritures, 6e-18 pour 10^6). La limite de NIST SP 800-38D
 *   est de 2^32 invocations par cle avec des IV aleatoires de 96 bits. La rotation de la DEK, a prevoir bien
 *   avant cette limite, n'est PAS implementee : limite documentee.
 *
 * MEMOIRE
 *   Au verrou, l'application abandonne ses references a la cle de donnees (CryptoKey non extractible) et au
 *   profil. JavaScript ne permet ni de remettre a zero la memoire d'une CryptoKey, ni celle des chaines (PIN
 *   saisi et sa forme normalisee), des copies d'octets, des objets dechiffres ou des photos relues : leur
 *   disparition depend du ramasse-miettes, sans delai garanti. Une cle extractible existe brievement a la
 *   creation et au changement de PIN (le temps d'envelopper la DEK, puis elle sort de portee). Une operation
 *   asynchrone lancee avant le verrou ne peut plus restaurer l'etat (jeton de generation). Le verrou limite
 *   l'usage de la cle par l'application ; il ne protege pas d'un attaquant qui lit la memoire du processus ou
 *   execute du code dans la page.
 *
 * METADONNEES EN CLAIR (enveloppe)
 *   v, compteId, appareilId, creeLe, kdf (algorithme, iterations, sel), iv de la cle, DEK enveloppee, profil
 *   chiffre (dont la LONGUEUR est visible), echecs, pasAvantMs, dernierInstantMs, rev. Elles revelent qu'un
 *   compte donne a un coffre sur cet appareil, depuis quand, le parametrage de derivation, le nombre d'essais
 *   rates recents et l'horloge du poste. La liaison a l'appareil par AAD n'est pas une protection
 *   cryptographique (compte et appareil sont en clair) : c'est une coherence applicative. Si l'identifiant
 *   local d'appareil est perdu alors qu'IndexedDB survit, le coffre devient inutilisable (AUTRE_APPAREIL).
 *   Le `compteId` sert de cle IndexedDB : l'empreinte de compteLocal.ts ne peut pas le remplacer sans casser
 *   `listerComptesAvecCoffre` (qui rend les identifiants a presenter a l'agent) et sans effet utile, puisque
 *   l'enveloppe porte aussi `compteId` en clair.
 *
 * NORMALISATION DU PIN
 *   NFKC : le resultat depend de la version d'Unicode du moteur JavaScript. Risque faible (caracteres rares ou
 *   nouvellement affectes), a noter : un PIN compose de tels caracteres pourrait ne plus s'ouvrir apres une
 *   mise a jour du moteur.
 *
 * AUCUN JOURNAL
 *   Ce fichier n'appelle jamais la console ni ne place le PIN, la DEK ou un contenu dans un message
 *   d'erreur : les messages ne portent que des codes.
 *
 * ---------------------------------------------------------------------------------------------------
 * COUT DE LA DERIVATION (mesure sur CE poste, pas sur un telephone)
 *   600 000 iterations PBKDF2-SHA256, WebCrypto de Node 24.18.1, Intel Core i7-8650U 1,9 GHz (8 threads),
 *   Windows 11, poste en usage : 28 mesures en 4 series, de 574 ms a 2290 ms, mediane 1199 ms. La dispersion
 *   est forte (cause non investiguee) : retenir « de l'ordre d'une a deux secondes par derivation sur ce
 *   poste ». Ce n'est PAS un telephone : un appareil d'entree de gamme sera different (probablement plus
 *   lent), a mesurer avec `mesurerDerivationMs` (etape 9) avant de figer 600 000. Chaque deverrouillage,
 *   chaque changement de PIN et chaque essai rate paie ce cout une fois ; la creation et la revalidation
 *   aussi.
 * ---------------------------------------------------------------------------------------------------
 */

import {
  PARAMETRES_SESSION, aReculeHorloge, delaiApresEchecs, estExpire, expirationApres,
  type ParametresSession, type ProfilSession,
} from "./noyauSession";
import type { PortSha256 } from "./compteLocal";

// ---------------------------------------------------------------------------------------------------
// Constantes et types
// ---------------------------------------------------------------------------------------------------

/** Iterations PBKDF2 par defaut (PROVISOIRE, voir la mesure ci-dessus). Stockees dans chaque enveloppe. */
export const ITERATIONS_PBKDF2_DEFAUT = 600_000;
/** Plancher des NOUVELLES derivations (creation, changement de PIN, revalidation), hors `iterationsDeTest`. */
export const ITERATIONS_PBKDF2_MIN = 100_000;
/** Borne haute realiste, a la creation comme a la lecture de l'enveloppe. */
export const ITERATIONS_PBKDF2_MAX = 10_000_000;
/** Taille maximale d'un bloc chiffre (une photo), contenu en clair. */
export const TAILLE_MAX_BLOB_OCTETS = 8 * 1024 * 1024;
export const LONGUEUR_PIN_MIN = 6;
export const LONGUEUR_PIN_MAX = 128;

const VERSION_ENVELOPPE = 1;
const VERSION_PAQUET = 1;
const VERSION_AAD = 1;
const LONGUEUR_IV = 12;
const LONGUEUR_SEL = 16;
const LONGUEUR_ETIQUETTE = 16;
/** Une DEK de 32 octets enveloppee en AES-GCM : 32 + etiquette de 16. */
const LONGUEUR_CLE_ENVELOPPEE = 32 + LONGUEUR_ETIQUETTE;
const TYPE_MIME_MAX = 255;
/** Plus petit paquet possible : version, IV, etiquette (clair vide). */
const LONGUEUR_PAQUET_MIN = 1 + LONGUEUR_IV + LONGUEUR_ETIQUETTE;
/** Plus gros paquet de bloc possible : version, IV, longueur du type, type, octets, etiquette. */
const LONGUEUR_PAQUET_BLOB_MAX = 1 + LONGUEUR_IV + 1 + TYPE_MIME_MAX + TAILLE_MAX_BLOB_OCTETS + LONGUEUR_ETIQUETTE;
const NOM_FILE_BLOB = "blob";
const PREFIXE_VERROU = "bdri-coffre:";

export type CodeErreurCoffre =
  | "PIN_INCORRECT"
  | "COFFRE_ABSENT"
  | "EXPIRE"
  | "AUTRE_COMPTE"
  | "AUTRE_APPAREIL"
  | "DELAI_EN_COURS"
  | "COFFRE_ILLISIBLE"
  | "VERROUILLE"
  | "COFFRE_EXISTANT"
  | "PIN_INVALIDE"
  | "BLOB_TROP_GROS"
  | "DONNEES_ALTEREES"
  | "WEBCRYPTO_INDISPONIBLE"
  | "ARGUMENT_INVALIDE";

/** Erreur typee. Le message ne porte que le code : jamais de PIN, de cle ni de contenu. */
export class ErreurCoffre extends Error {
  readonly code: CodeErreurCoffre;
  constructor(code: CodeErreurCoffre) {
    super(code);
    this.name = "ErreurCoffre";
    this.code = code;
  }
}

/** Ce que l'appelant fournit du profil : l'identite et les droits vus par le serveur. PAS de jeton. */
export interface IdentiteProfil {
  readonly userId: string;
  readonly nom: string;
  readonly role: string;
  readonly modules: readonly string[];
  readonly regions: readonly string[];
}

export type MotifExpiration = "DUREE" | "HORLOGE";

export type EchecCoffre = {
  readonly ok: false;
  readonly erreur: Exclude<CodeErreurCoffre, "VERROUILLE" | "COFFRE_EXISTANT" | "BLOB_TROP_GROS" | "DONNEES_ALTEREES" | "WEBCRYPTO_INDISPONIBLE" | "ARGUMENT_INVALIDE">;
  /** Seulement pour DELAI_EN_COURS. */
  readonly reessayerDansMs?: number;
  /** Seulement pour EXPIRE. */
  readonly motif?: MotifExpiration;
};
/** `VERROUILLE` : `verrouiller()` est survenu pendant l'operation ; rien n'a ete restaure en memoire. */
export type ResultatDeverrouillage =
  | { readonly ok: true; readonly profil: ProfilSession }
  | EchecCoffre
  | { readonly ok: false; readonly erreur: "VERROUILLE" };
export type ResultatSimple = { readonly ok: true } | EchecCoffre | { readonly ok: false; readonly erreur: "VERROUILLE" };

/** Enveloppe persistee. Serialisable en JSON ; aucun champ ne contient le PIN, la DEK ni un jeton. */
export interface EnveloppeCoffre {
  readonly v: 1;
  readonly compteId: string;
  readonly appareilId: string;
  readonly creeLe: number;
  /** Parametres de derivation, versionnes avec l'enveloppe. */
  readonly kdf: { readonly alg: "PBKDF2-SHA256"; readonly iterations: number; readonly sel: string };
  /** DEK enveloppee par la cle derivee du PIN (AES-GCM, AAD liee au compte et a l'appareil). */
  readonly cle: { readonly alg: "AES-GCM-256"; readonly iv: string; readonly enveloppee: string };
  /** Profil de session chiffre par la DEK : paquet [version|IV|chiffre+etiquette] en base64. */
  readonly profil: string;
  /** Echecs de PIN consecutifs (persistant). */
  readonly echecs: number;
  readonly pasAvantMs: number | null;
  /** Plus haute valeur d'horloge observee (clair : lisible avant le PIN, non authentifiee). */
  readonly dernierInstantMs: number | null;
  /**
   * Numero d'ecriture, incremente a chaque `put` du coffre (clair, non authentifie : detection de
   * l'entrecroisement, pas protection contre un attaquant). Absent des enveloppes ecrites avant son ajout,
   * lu comme 0 ; meme version `v` de format.
   */
  readonly rev?: number;
}

export interface StockageCoffre {
  get(cle: string): Promise<EnveloppeCoffre | null>;
  put(cle: string, enveloppe: EnveloppeCoffre): Promise<void>;
  /**
   * Ecrit SEULEMENT si la cle n'existe pas ; sinon rejette avec `ErreurCoffre("COFFRE_EXISTANT")`.
   * Facultatif pour ne pas casser les ports existants : sans lui, la creation fait `get` puis `put` sous le
   * verrou (sur par construction dans un meme contexte, pas entre onglets sans Web Locks).
   */
  add?(cle: string, enveloppe: EnveloppeCoffre): Promise<void>;
  delete(cle: string): Promise<void>;
  /** Cles presentes : les comptes ayant un coffre sur cet appareil. */
  cles(): Promise<string[]>;
}

export interface MetaCoffre {
  readonly existe: boolean;
  readonly compteId: string;
  readonly appareilId: string | null;
  readonly echecs: number;
  readonly pasAvantMs: number | null;
  readonly dernierInstantMs: number | null;
  readonly iterations: number | null;
}

type CryptoLike = Pick<Crypto, "subtle" | "getRandomValues">;

export interface OptionsCoffre {
  readonly stockage: StockageCoffre;
  readonly compteId: string;
  /** Identifiant LOCAL et STABLE de l'installation (genere une fois, conserve). Pas l'identifiant d'appareil serveur s'il peut etre renouvele : un identifiant qui change rendrait le coffre illisible. */
  readonly appareilId: string;
  /** Iterations des NOUVELLES derivations (creation, changement de PIN, revalidation, rehash). Au moins ITERATIONS_PBKDF2_MIN hors `iterationsDeTest`. */
  readonly iterations?: number;
  /** Mode test explicite : autorise un nombre d'iterations sous le plancher. Ne jamais l'activer hors test. */
  readonly iterationsDeTest?: boolean;
  readonly parametres?: ParametresSession;
  /** Injecte pour les tests ; par defaut `globalThis.crypto`. */
  readonly crypto?: CryptoLike;
}

export interface OptionsCreation extends OptionsCoffre {
  readonly pin: string;
  readonly profil: IdentiteProfil;
  readonly maintenantMs: number;
}

// ---------------------------------------------------------------------------------------------------
// Utilitaires binaires
// ---------------------------------------------------------------------------------------------------

const encodeur = new TextEncoder();
const decodeur = new TextDecoder("utf-8", { fatal: true });

/** Les API WebCrypto exigent un BufferSource ; sur TypeScript recent `Uint8Array` generique ne l'est plus sans cette conversion. */
const tampon = (u: Uint8Array): BufferSource => u as BufferSource;

function versB64(octets: Uint8Array): string {
  let s = "";
  for (let i = 0; i < octets.length; i += 0x8000) s += String.fromCharCode(...octets.subarray(i, i + 0x8000));
  return btoa(s);
}

function depuisB64(texte: string): Uint8Array {
  const bin = atob(texte);
  const o = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
  return o;
}

/** Longueur decodee d'un texte base64, ou `null` s'il n'est pas du base64. */
function longueurB64(texte: unknown): number | null {
  if (typeof texte !== "string") return null;
  try {
    return depuisB64(texte).length;
  } catch {
    return null;
  }
}

function concat(...parties: Uint8Array[]): Uint8Array {
  const sortie = new Uint8Array(parties.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parties) { sortie.set(p, pos); pos += p.length; }
  return sortie;
}

function octetsDe(donnees: Uint8Array | ArrayBuffer | object): Uint8Array {
  if (ArrayBuffer.isView(donnees)) return new Uint8Array(donnees.buffer, donnees.byteOffset, donnees.byteLength);
  if (donnees instanceof ArrayBuffer || Object.prototype.toString.call(donnees) === "[object ArrayBuffer]") {
    return new Uint8Array(donnees as ArrayBuffer);
  }
  const json = JSON.stringify(donnees);
  if (json === undefined) throw new ErreurCoffre("ARGUMENT_INVALIDE");
  return encodeur.encode(json);
}

const aadOctets = (aad: string | Uint8Array): Uint8Array => (typeof aad === "string" ? encodeur.encode(aad) : aad);

/**
 * AAD ANCIENNE des blocs : `compteId|identifiantLocal|version`, sans separation de domaine. Conservee pour
 * relire les blocs deja ecrits ; les nouveaux blocs utilisent `aadFile`. L'identifiant ne doit pas contenir le
 * separateur.
 */
export function aadBlob(compteId: string, identifiantLocal: string, version: number): string {
  if (!identifiantLocal || identifiantLocal.includes("|") || !Number.isInteger(version) || version < 0) {
    throw new ErreurCoffre("ARGUMENT_INVALIDE");
  }
  return `${compteId}|${identifiantLocal}|${version}`;
}

/**
 * Constructeur UNIQUE de l'AAD d'un enregistrement de file : `bdri-coffre|1|file|<nom>|<compteId>|<id>|<rev>`.
 * Le prefixe `file` separe ce domaine de ceux de la cle enveloppee (`cle`) et du profil (`profil`) ; le nom de
 * file, le compte, l'identifiant local et la revision sont lies au chiffre : un enregistrement ne se relit ni
 * dans une autre file, ni sous un autre compte, ni sous une autre revision. Aucun composant ne peut contenir
 * le separateur `|` (l'encodage reste donc non ambigu).
 */
export function aadFile(nomFile: string, compteId: string, id: string, rev: number): string {
  for (const composant of [nomFile, compteId, id]) {
    if (typeof composant !== "string" || composant.length === 0 || composant.includes("|")) {
      throw new ErreurCoffre("ARGUMENT_INVALIDE");
    }
  }
  if (!Number.isInteger(rev) || rev < 0) throw new ErreurCoffre("ARGUMENT_INVALIDE");
  return `bdri-coffre|${VERSION_AAD}|file|${nomFile}|${compteId}|${id}|${rev}`;
}

const aadCle = (e: { compteId: string; appareilId: string }) => encodeur.encode(`bdri-coffre|${VERSION_ENVELOPPE}|cle|${e.compteId}|${e.appareilId}`);
const aadProfil = (e: { compteId: string; appareilId: string }) => encodeur.encode(`bdri-coffre|${VERSION_ENVELOPPE}|profil|${e.compteId}|${e.appareilId}`);

/** Adaptateur reel du port SHA-256 de compteLocal.ts. */
export const sha256WebCrypto: PortSha256 = async (octets) => {
  const c = cryptoDisponible(undefined);
  return new Uint8Array(await c.subtle.digest("SHA-256", tampon(octets)));
};

function cryptoDisponible(c: CryptoLike | undefined): CryptoLike {
  const r = c ?? (globalThis as { crypto?: CryptoLike }).crypto;
  if (!r || !r.subtle || typeof r.getRandomValues !== "function") throw new ErreurCoffre("WEBCRYPTO_INDISPONIBLE");
  return r;
}

// ---------------------------------------------------------------------------------------------------
// Verrou exclusif par compte
// ---------------------------------------------------------------------------------------------------

type GestionnaireVerrous = { request<T>(nom: string, callback: () => Promise<T>): Promise<T> };

/** Files d'attente du repli en memoire, par nom de verrou. */
const filesMemoire = new Map<string, Promise<void>>();

function sousVerrouMemoire<T>(nom: string, tache: () => Promise<T>): Promise<T> {
  const precedent = filesMemoire.get(nom) ?? Promise.resolve();
  let liberer!: () => void;
  const courant = new Promise<void>((r) => { liberer = r; });
  const suite = precedent.then(() => courant);
  filesMemoire.set(nom, suite);
  return precedent.then(tache).finally(() => {
    liberer();
    if (filesMemoire.get(nom) === suite) filesMemoire.delete(nom);
  });
}

/**
 * Execute `tache` en exclusion mutuelle pour ce compte : Web Locks (inter-onglets) quand `navigator.locks`
 * existe, sinon verrou en memoire (un seul contexte JS). La tache ne doit PAS rappeler une operation verrouillee
 * du meme compte (interblocage). Lu a chaque appel, pas au chargement du module.
 */
export async function avecVerrouCoffre<T>(compteId: string, tache: () => Promise<T>): Promise<T> {
  const nom = PREFIXE_VERROU + compteId;
  const locks = (globalThis as { navigator?: { locks?: GestionnaireVerrous } }).navigator?.locks;
  if (locks && typeof locks.request === "function") {
    let demarree = false;
    try {
      return await locks.request(nom, async () => { demarree = true; return tache(); });
    } catch (e) {
      if (demarree) throw e; // l'erreur est celle de la tache
      // Verrou indisponible (contexte non securise, document inactif) : repli en memoire.
    }
  }
  return sousVerrouMemoire(nom, tache);
}

// ---------------------------------------------------------------------------------------------------
// Politique de PIN
// ---------------------------------------------------------------------------------------------------

export type ResultatPin = { readonly valide: true } | { readonly valide: false; readonly motif: "VIDE" | "TROP_COURT" | "TROP_LONG" };

/** Un PIN de 6 caracteres au moins (chiffres ou texte) : un mot de passe court est accepte. */
export function validerPin(pin: string): ResultatPin {
  if (typeof pin !== "string" || pin.length === 0) return { valide: false, motif: "VIDE" };
  const n = [...normaliserPin(pin)].length;
  if (n < LONGUEUR_PIN_MIN) return { valide: false, motif: "TROP_COURT" };
  if (n > LONGUEUR_PIN_MAX) return { valide: false, motif: "TROP_LONG" };
  return { valide: true };
}

/** NFKC : le meme PIN saisi sur deux claviers donne les memes octets (dependant de la version d'Unicode du moteur). */
const normaliserPin = (pin: string) => pin.normalize("NFKC");

// ---------------------------------------------------------------------------------------------------
// Stockage : memoire (tests, repli) et IndexedDB (reel)
// ---------------------------------------------------------------------------------------------------

/** Stockage en memoire. Copie profonde par JSON : prouve aussi que l'enveloppe est serialisable. */
export function stockageEnMemoire(): StockageCoffre & { add(cle: string, enveloppe: EnveloppeCoffre): Promise<void>; lireBrut(cle: string): string | undefined } {
  const m = new Map<string, string>();
  return {
    async get(cle) {
      const brut = m.get(cle);
      return brut === undefined ? null : (JSON.parse(brut) as EnveloppeCoffre);
    },
    async put(cle, enveloppe) { m.set(cle, JSON.stringify(enveloppe)); },
    async add(cle, enveloppe) {
      if (m.has(cle)) throw new ErreurCoffre("COFFRE_EXISTANT");
      m.set(cle, JSON.stringify(enveloppe));
    },
    async delete(cle) { m.delete(cle); },
    async cles() { return [...m.keys()]; },
    lireBrut: (cle) => m.get(cle),
  };
}

/**
 * Stockage IndexedDB : une base `bdri-coffre` a un magasin `enveloppes`, cle = identifiant du compte.
 * Distincte des bases par compte (compteLocal.ts) : on doit pouvoir lister les comptes d'un telephone avant de
 * savoir lequel s'ouvre. Ne contient que des enveloppes chiffrees. `add` utilise `IDBObjectStore.add`, qui
 * echoue (ConstraintError) si la cle existe : c'est ce qui rend la creation exclusive entre onglets.
 * Ecrit contre l'API IndexedDB standard ; essaye ici contre une implementation factice (voir le test), pas
 * contre un navigateur ni une WebView reels.
 */
export function stockageIndexedDb(nomBase = "bdri-coffre"): StockageCoffre & { add(cle: string, enveloppe: EnveloppeCoffre): Promise<void> } {
  const MAGASIN = "enveloppes";
  let ouverture: Promise<IDBDatabase> | null = null;

  const ouvrir = (): Promise<IDBDatabase> => {
    ouverture ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(nomBase, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(MAGASIN)) req.result.createObjectStore(MAGASIN);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { ouverture = null; reject(req.error ?? new Error("ouverture IndexedDB")); };
    });
    return ouverture;
  };

  /** Execute une requete dans une transaction et attend la FIN de la transaction pour les ecritures. */
  const executer = async <T>(mode: IDBTransactionMode, requete: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await ouvrir();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(MAGASIN, mode);
      const req = requete(tx.objectStore(MAGASIN));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? req.error ?? new Error("transaction IndexedDB"));
      tx.onabort = () => reject(tx.error ?? new Error("transaction IndexedDB annulee"));
    });
  };

  return {
    async get(cle) {
      const v = await executer<EnveloppeCoffre | undefined>("readonly", (s) => s.get(cle));
      return v ?? null;
    },
    async put(cle, enveloppe) { await executer("readwrite", (s) => s.put(enveloppe, cle)); },
    async add(cle, enveloppe) {
      try {
        await executer("readwrite", (s) => s.add(enveloppe, cle));
      } catch (e) {
        if ((e as { name?: unknown } | null)?.name === "ConstraintError") throw new ErreurCoffre("COFFRE_EXISTANT");
        throw e;
      }
    },
    async delete(cle) { await executer("readwrite", (s) => s.delete(cle)); },
    async cles() { return (await executer<IDBValidKey[]>("readonly", (s) => s.getAllKeys())).map(String); },
  };
}

// ---------------------------------------------------------------------------------------------------
// Coffre
// ---------------------------------------------------------------------------------------------------

function exigerIdentifiant(valeur: unknown): string {
  if (typeof valeur !== "string" || valeur.length === 0 || valeur.includes("|")) throw new ErreurCoffre("ARGUMENT_INVALIDE");
  return valeur;
}

/** Ne garde QUE les champs connus : un jeton glisse dans l'objet ne parvient jamais au coffre. */
function assainirIdentite(i: IdentiteProfil): IdentiteProfil {
  const liste = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  if (!i || typeof i.userId !== "string" || i.userId.length === 0) throw new ErreurCoffre("ARGUMENT_INVALIDE");
  return {
    userId: i.userId,
    nom: typeof i.nom === "string" ? i.nom : "",
    role: typeof i.role === "string" ? i.role : "",
    modules: liste(i.modules),
    regions: liste(i.regions),
  };
}

function profilValide(p: unknown): p is ProfilSession {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  const chaines = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
  return typeof o.userId === "string" && typeof o.nom === "string" && typeof o.role === "string"
    && chaines(o.modules) && chaines(o.regions)
    && Number.isFinite(o.emisLe) && Number.isFinite(o.valideLe) && Number.isFinite(o.expireLe);
}

function enveloppeValide(e: unknown): e is EnveloppeCoffre {
  if (!e || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  const kdf = o.kdf as Record<string, unknown> | undefined;
  const cle = o.cle as Record<string, unknown> | undefined;
  const longueurProfil = longueurB64(o.profil);
  return o.v === VERSION_ENVELOPPE
    && typeof o.compteId === "string" && typeof o.appareilId === "string"
    && !!kdf && kdf.alg === "PBKDF2-SHA256" && Number.isInteger(kdf.iterations) && (kdf.iterations as number) >= 1
    && (kdf.iterations as number) <= ITERATIONS_PBKDF2_MAX && longueurB64(kdf.sel) === LONGUEUR_SEL
    && !!cle && cle.alg === "AES-GCM-256" && longueurB64(cle.iv) === LONGUEUR_IV
    && longueurB64(cle.enveloppee) === LONGUEUR_CLE_ENVELOPPEE
    && longueurProfil !== null && longueurProfil >= LONGUEUR_PAQUET_MIN
    && Number.isInteger(o.echecs) && (o.echecs as number) >= 0
    && (o.pasAvantMs === null || Number.isFinite(o.pasAvantMs))
    && (o.dernierInstantMs === null || Number.isFinite(o.dernierInstantMs))
    && (o.rev === undefined || (Number.isInteger(o.rev) && (o.rev as number) >= 0));
}

/** Meme cle enveloppee, meme sel, memes parametres : le PIN n'a pas ete change entre deux lectures. */
function memeEnveloppeDeCle(a: EnveloppeCoffre, b: EnveloppeCoffre): boolean {
  return a.kdf.sel === b.kdf.sel && a.kdf.iterations === b.kdf.iterations
    && a.cle.iv === b.cle.iv && a.cle.enveloppee === b.cle.enveloppee;
}

type VerificationPin =
  | { ok: true; envelope: EnveloppeCoffre; dek: CryptoKey; profil: ProfilSession; marqueAvant: number | null }
  | EchecCoffre;

export class CoffreSession {
  readonly compteId: string;
  readonly appareilId: string;

  private readonly stockage: StockageCoffre;
  private readonly iterations: number;
  private readonly parametres: ParametresSession;
  private readonly c: CryptoLike;

  private dek: CryptoKey | null = null;
  private profil: ProfilSession | null = null;
  /** Incremente par `verrouiller()` : une operation en vol compare sa generation de depart a celle-ci. */
  private generation = 0;

  constructor(options: OptionsCoffre) {
    this.stockage = options.stockage;
    this.compteId = exigerIdentifiant(options.compteId);
    this.appareilId = exigerIdentifiant(options.appareilId);
    this.iterations = options.iterations ?? ITERATIONS_PBKDF2_DEFAUT;
    const plancher = options.iterationsDeTest === true ? 1 : ITERATIONS_PBKDF2_MIN;
    if (!Number.isInteger(this.iterations) || this.iterations < plancher || this.iterations > ITERATIONS_PBKDF2_MAX) {
      throw new ErreurCoffre("ARGUMENT_INVALIDE");
    }
    this.parametres = options.parametres ?? PARAMETRES_SESSION;
    this.c = cryptoDisponible(options.crypto);
  }

  // ---- etat en memoire ----------------------------------------------------------------------------

  estDeverrouille(): boolean { return this.dek !== null; }
  profilCourant(): ProfilSession | null { return this.profil; }

  /**
   * Abandonne les references a la DEK et au profil. Une `CryptoKey` ne s'efface pas (voir MEMOIRE). Le jeton de
   * generation empeche une operation lancee avant le verrou de restaurer l'etat.
   */
  verrouiller(): void {
    this.generation++;
    this.dek = null;
    this.profil = null;
  }

  private avecVerrou<T>(tache: () => Promise<T>): Promise<T> {
    return avecVerrouCoffre(this.compteId, tache);
  }

  // ---- creation et destruction --------------------------------------------------------------------

  /** Cree le coffre. Voir `creerCoffre`. */
  async creer(pin: string, identite: IdentiteProfil, maintenantMs: number): Promise<void> {
    if (!validerPin(pin).valide) throw new ErreurCoffre("PIN_INVALIDE");
    const id = assainirIdentite(identite);
    if (id.userId !== this.compteId) throw new ErreurCoffre("AUTRE_COMPTE");
    const generation = this.generation;

    await this.avecVerrou(async () => {
      // Controle rapide avant le cout de la derivation ; l'exclusivite reelle est celle de `add`.
      if ((await this.stockage.get(this.compteId)) !== null) throw new ErreurCoffre("COFFRE_EXISTANT");

      // La DEK n'est extractible que le temps de l'envelopper.
      const dekExtractible = await this.c.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
      const { kdf, cle, kek } = await this.envelopperDek(pin, dekExtractible);
      // On relit la DEK enveloppee en NON extractible : la copie extractible sort de portee, et l'aller-retour est verifie.
      const dek = await this.deballerDek(cle, kek, false);

      const profil: ProfilSession = {
        ...id,
        emisLe: maintenantMs,
        valideLe: maintenantMs,
        expireLe: expirationApres(maintenantMs, this.parametres),
      };
      const enveloppe: EnveloppeCoffre = {
        v: VERSION_ENVELOPPE,
        compteId: this.compteId,
        appareilId: this.appareilId,
        creeLe: maintenantMs,
        kdf,
        cle,
        profil: versB64(await this.chiffrerAvec(dek, encodeur.encode(JSON.stringify(profil)), aadProfil(this))),
        echecs: 0,
        pasAvantMs: null,
        dernierInstantMs: maintenantMs,
        rev: 1,
      };
      await this.ajouter(enveloppe);
      if (generation !== this.generation) return; // verrouiller() est survenu : le coffre existe mais reste verrouille
      this.dek = dek;
      this.profil = profil;
    });
  }

  /** Detruit l'enveloppe : PIN oublie. Les donnees chiffrees par cette DEK deviennent illisibles. */
  async reinitialiser(): Promise<void> {
    this.verrouiller();
    await this.avecVerrou(() => this.stockage.delete(this.compteId));
  }

  async lireMeta(): Promise<MetaCoffre> {
    const brute = await this.stockage.get(this.compteId);
    if (!enveloppeValide(brute)) {
      return { existe: false, compteId: this.compteId, appareilId: null, echecs: 0, pasAvantMs: null, dernierInstantMs: null, iterations: null };
    }
    return {
      existe: true,
      compteId: brute.compteId,
      appareilId: brute.appareilId,
      echecs: brute.echecs,
      pasAvantMs: brute.pasAvantMs,
      dernierInstantMs: brute.dernierInstantMs,
      iterations: brute.kdf.iterations,
    };
  }

  /** Monte la marque d'horloge persistee (jamais ne la descend). */
  async noterInstant(maintenantMs: number): Promise<void> {
    await this.avecVerrou(() => this.modifier((e) => {
      if (e.dernierInstantMs !== null && e.dernierInstantMs >= maintenantMs) return null;
      return { ...e, dernierInstantMs: maintenantMs };
    }));
  }

  // ---- deverrouillage -----------------------------------------------------------------------------

  async deverrouiller(pin: string, maintenantMs: number): Promise<ResultatDeverrouillage> {
    const generation = this.generation;
    return this.avecVerrou(async () => {
      const r = await this.verifierPin(pin, maintenantMs, false);
      if (!r.ok) return r;
      const { profil, dek, marqueAvant } = r;

      if (estExpire(profil.expireLe, maintenantMs)) return { ok: false, erreur: "EXPIRE", motif: "DUREE" } as const;
      if (aReculeHorloge(marqueAvant, maintenantMs, this.parametres)) return { ok: false, erreur: "EXPIRE", motif: "HORLOGE" } as const;
      if (generation !== this.generation) return { ok: false, erreur: "VERROUILLE" } as const;

      this.dek = dek;
      this.profil = profil;
      return { ok: true, profil } as const;
    });
  }

  async changerPin(ancien: string, nouveau: string, maintenantMs: number): Promise<ResultatSimple> {
    if (!validerPin(nouveau).valide) return { ok: false, erreur: "PIN_INVALIDE" };
    return this.avecVerrou(async (): Promise<ResultatSimple> => {
      const r = await this.verifierPin(ancien, maintenantMs, true);
      if (!r.ok) return r;
      const { kdf, cle } = await this.envelopperDek(nouveau, r.dek);
      // Relecture juste avant l'ecriture : on ne change que kdf, cle et le compteur, et seulement si la cle
      // enveloppee est toujours celle que l'ancien PIN vient d'ouvrir.
      const ecrite = await this.modifier((e) => (memeEnveloppeDeCle(e, r.envelope)
        ? { ...e, kdf, cle, echecs: 0, pasAvantMs: null }
        : null));
      return ecrite ? { ok: true } : { ok: false, erreur: "PIN_INCORRECT" };
    });
  }

  /**
   * Connexion en ligne apres expiration ou changement de droits : le PIN prouve que c'est bien l'agent, le
   * serveur fournit l'identite a jour. Rend le coffre DEVERROUILLE avec une validite neuve.
   */
  async revalider(entree: { pin: string; identite: IdentiteProfil; maintenantMs: number }): Promise<ResultatDeverrouillage> {
    const identite = assainirIdentite(entree.identite);
    if (identite.userId !== this.compteId) return { ok: false, erreur: "AUTRE_COMPTE" };
    const generation = this.generation;
    return this.avecVerrou(async (): Promise<ResultatDeverrouillage> => {
      const r = await this.verifierPin(entree.pin, entree.maintenantMs, false);
      if (!r.ok) return r;
      const profil: ProfilSession = {
        ...identite,
        emisLe: r.profil.emisLe,
        valideLe: entree.maintenantMs,
        expireLe: expirationApres(entree.maintenantMs, this.parametres),
      };
      // Validation par le serveur : la marque d'horloge repart de maintenant (un poste remis a l'heure redevient utilisable).
      await this.ecrireProfil(r.dek, profil, entree.maintenantMs, true);
      if (generation !== this.generation) return { ok: false, erreur: "VERROUILLE" };
      this.dek = r.dek;
      this.profil = profil;
      return { ok: true, profil };
    });
  }

  /** Coffre ouvert : repousse la validite (et, si fourni, remplace l'identite) sans redemander le PIN. */
  async prolonger(entree: { maintenantMs: number; identite?: IdentiteProfil }): Promise<ResultatSimple> {
    if (!this.dek || !this.profil) return { ok: false, erreur: "VERROUILLE" };
    const identite = entree.identite ? assainirIdentite(entree.identite) : null;
    if (identite && identite.userId !== this.compteId) return { ok: false, erreur: "AUTRE_COMPTE" };
    const generation = this.generation;
    return this.avecVerrou(async (): Promise<ResultatSimple> => {
      // Verrouille pendant l'attente du verrou : on n'ecrit rien et on ne restaure rien.
      const dek = this.dek;
      const base = this.profil;
      if (generation !== this.generation || !dek || !base) return { ok: false, erreur: "VERROUILLE" };
      const profil: ProfilSession = {
        ...(identite ?? base),
        emisLe: base.emisLe,
        valideLe: entree.maintenantMs,
        expireLe: expirationApres(entree.maintenantMs, this.parametres),
      };
      await this.ecrireProfil(dek, profil, entree.maintenantMs, false);
      // Si verrouiller() est survenu pendant l'ecriture, la prolongation est persistee (le serveur l'avait
      // validee) mais la memoire reste vide : le coffre n'est pas rouvert.
      if (generation === this.generation) this.profil = profil;
      return { ok: true };
    });
  }

  // ---- chiffrement des donnees --------------------------------------------------------------------

  async chiffrer(donnees: Uint8Array | ArrayBuffer | object, aad: string | Uint8Array): Promise<Uint8Array> {
    if (!this.dek) throw new ErreurCoffre("VERROUILLE");
    return this.chiffrerAvec(this.dek, octetsDe(donnees), aadOctets(aad));
  }

  async dechiffrer(paquet: Uint8Array, aad: string | Uint8Array): Promise<Uint8Array> {
    if (!this.dek) throw new ErreurCoffre("VERROUILLE");
    return this.dechiffrerAvec(this.dek, paquet, aadOctets(aad));
  }

  async dechiffrerJson<T>(paquet: Uint8Array, aad: string | Uint8Array): Promise<T> {
    const octets = await this.dechiffrer(paquet, aad);
    try {
      return JSON.parse(decodeur.decode(octets)) as T;
    } catch {
      throw new ErreurCoffre("DONNEES_ALTEREES");
    }
  }

  /** Un bloc par photo : [type MIME | octets], chiffre avec un IV neuf et l'AAD `aadFile("blob", compteId, identifiantLocal, version)`. */
  async chiffrerBlob(blob: Blob, identifiantLocal: string, version = 1): Promise<Uint8Array> {
    if (!this.dek) throw new ErreurCoffre("VERROUILLE");
    if (blob.size > TAILLE_MAX_BLOB_OCTETS) throw new ErreurCoffre("BLOB_TROP_GROS");
    const aad = encodeur.encode(aadFile(NOM_FILE_BLOB, this.compteId, identifiantLocal, version));
    const type = encodeur.encode(blob.type ?? "");
    if (type.length > TYPE_MIME_MAX) throw new ErreurCoffre("ARGUMENT_INVALIDE");
    const octets = new Uint8Array(await blob.arrayBuffer());
    if (octets.length > TAILLE_MAX_BLOB_OCTETS) throw new ErreurCoffre("BLOB_TROP_GROS");
    return this.chiffrerAvec(this.dek, concat(new Uint8Array([type.length]), type, octets), aad);
  }

  async dechiffrerBlob(paquet: Uint8Array, identifiantLocal: string, version = 1): Promise<Blob> {
    if (!this.dek) throw new ErreurCoffre("VERROUILLE");
    const aad = encodeur.encode(aadFile(NOM_FILE_BLOB, this.compteId, identifiantLocal, version));
    // Borne avant de dechiffrer : un paquet demesure n'est pas un de nos blocs.
    if (paquet.length > LONGUEUR_PAQUET_BLOB_MAX) throw new ErreurCoffre("DONNEES_ALTEREES");
    let clair: Uint8Array;
    try {
      clair = await this.dechiffrerAvec(this.dek, paquet, aad);
    } catch (e) {
      // Transitoire : un bloc ecrit avant la separation des domaines porte l'ancienne AAD.
      if (!(e instanceof ErreurCoffre) || e.code !== "DONNEES_ALTEREES") throw e;
      clair = await this.dechiffrerAvec(this.dek, paquet, encodeur.encode(aadBlob(this.compteId, identifiantLocal, version)));
    }
    if (clair.length < 1 || clair.length < 1 + clair[0]) throw new ErreurCoffre("DONNEES_ALTEREES");
    const longueurType = clair[0];
    let type: string;
    try {
      type = decodeur.decode(clair.subarray(1, 1 + longueurType));
    } catch {
      throw new ErreurCoffre("DONNEES_ALTEREES");
    }
    return new Blob([tampon(clair.subarray(1 + longueurType))], { type });
  }

  // ---- interne : primitives -----------------------------------------------------------------------

  private aleatoire(n: number): Uint8Array {
    return this.c.getRandomValues(new Uint8Array(n));
  }

  private async chiffrerAvec(cle: CryptoKey, clair: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
    const iv = this.aleatoire(LONGUEUR_IV);
    const chiffre = new Uint8Array(await this.c.subtle.encrypt(
      { name: "AES-GCM", iv: tampon(iv), additionalData: tampon(aad), tagLength: 128 }, cle, tampon(clair),
    ));
    return concat(new Uint8Array([VERSION_PAQUET]), iv, chiffre);
  }

  private async dechiffrerAvec(cle: CryptoKey, paquet: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
    if (!(paquet instanceof Uint8Array) && !ArrayBuffer.isView(paquet)) throw new ErreurCoffre("DONNEES_ALTEREES");
    const p = octetsDe(paquet);
    if (p.length < LONGUEUR_PAQUET_MIN || p[0] !== VERSION_PAQUET) throw new ErreurCoffre("DONNEES_ALTEREES");
    try {
      return new Uint8Array(await this.c.subtle.decrypt(
        { name: "AES-GCM", iv: tampon(p.subarray(1, 1 + LONGUEUR_IV)), additionalData: tampon(aad), tagLength: 128 },
        cle, tampon(p.subarray(1 + LONGUEUR_IV)),
      ));
    } catch {
      // Mauvais AAD, mauvaise cle ou etiquette alteree : on ne distingue pas, on ne dit pas pourquoi.
      throw new ErreurCoffre("DONNEES_ALTEREES");
    }
  }

  /** Cle derivee du PIN : NON extractible, usage limite a l'enveloppement de la DEK. */
  private async deriver(pin: string, sel: Uint8Array, iterations: number): Promise<CryptoKey> {
    const base = await this.c.subtle.importKey("raw", tampon(encodeur.encode(normaliserPin(pin))), "PBKDF2", false, ["deriveKey"]);
    return this.c.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt: tampon(sel), iterations },
      base, { name: "AES-GCM", length: 256 }, false, ["wrapKey", "unwrapKey"],
    );
  }

  /** Enveloppe la DEK sous une cle derivee du PIN, avec un sel et un IV neufs. */
  private async envelopperDek(pin: string, dek: CryptoKey): Promise<Pick<EnveloppeCoffre, "kdf" | "cle"> & { kek: CryptoKey }> {
    const sel = this.aleatoire(LONGUEUR_SEL);
    const iv = this.aleatoire(LONGUEUR_IV);
    const kek = await this.deriver(pin, sel, this.iterations);
    const enveloppee = new Uint8Array(await this.c.subtle.wrapKey("raw", dek, kek, {
      name: "AES-GCM", iv: tampon(iv), additionalData: tampon(aadCle(this)), tagLength: 128,
    }));
    return {
      kdf: { alg: "PBKDF2-SHA256", iterations: this.iterations, sel: versB64(sel) },
      cle: { alg: "AES-GCM-256", iv: versB64(iv), enveloppee: versB64(enveloppee) },
      kek,
    };
  }

  private deballerDek(cle: EnveloppeCoffre["cle"], kek: CryptoKey, extractible: boolean): Promise<CryptoKey> {
    return this.c.subtle.unwrapKey(
      "raw", tampon(depuisB64(cle.enveloppee)), kek,
      { name: "AES-GCM", iv: tampon(depuisB64(cle.iv)), additionalData: tampon(aadCle(this)), tagLength: 128 },
      { name: "AES-GCM", length: 256 }, extractible, ["encrypt", "decrypt"],
    );
  }

  // ---- interne : ecritures (a appeler sous verrou) -------------------------------------------------

  /** Creation exclusive : `add` si le port le fournit, sinon `get` puis `put` (sous le verrou). */
  private async ajouter(enveloppe: EnveloppeCoffre): Promise<void> {
    if (typeof this.stockage.add === "function") {
      await this.stockage.add(this.compteId, enveloppe);
      return;
    }
    if ((await this.stockage.get(this.compteId)) !== null) throw new ErreurCoffre("COFFRE_EXISTANT");
    await this.stockage.put(this.compteId, enveloppe);
  }

  /**
   * Relit l'enveloppe COURANTE juste avant d'ecrire, applique `changement` (qui ne rend que les champs voulus,
   * ou `null` pour ne rien ecrire) et incremente `rev`. Rend l'enveloppe ecrite, ou `null` si rien n'a ete
   * ecrit (absente, illisible, d'un autre compte ou appareil, ou changement refuse). Jamais d'instantane
   * lu avant une attente.
   */
  private async modifier(changement: (courante: EnveloppeCoffre) => EnveloppeCoffre | null): Promise<EnveloppeCoffre | null> {
    const courante = await this.stockage.get(this.compteId);
    if (!enveloppeValide(courante) || courante.compteId !== this.compteId || courante.appareilId !== this.appareilId) return null;
    const voulue = changement(courante);
    if (voulue === null) return null;
    const ecrite: EnveloppeCoffre = { ...voulue, rev: (courante.rev ?? 0) + 1 };
    await this.stockage.put(this.compteId, ecrite);
    return ecrite;
  }

  private async ecrireProfil(dek: CryptoKey, profil: ProfilSession, maintenantMs: number, reinitialiserHorloge: boolean): Promise<void> {
    const chiffre = versB64(await this.chiffrerAvec(dek, encodeur.encode(JSON.stringify(profil)), aadProfil(this)));
    const ecrite = await this.modifier((e) => ({
      ...e,
      profil: chiffre,
      // Revalidation par le serveur : la marque repart de maintenant. Sinon elle ne descend jamais.
      dernierInstantMs: reinitialiserHorloge ? maintenantMs : Math.max(e.dernierInstantMs ?? maintenantMs, maintenantMs),
    }));
    if (!ecrite) throw new ErreurCoffre("COFFRE_ILLISIBLE");
  }

  /**
   * Controles communs avant d'utiliser le PIN, puis verification du PIN lui-meme. A appeler SOUS VERROU.
   * Persiste le compteur d'echecs AVANT la derivation, et le controle de delai se fait sur la lecture meme qui
   * sert a l'incrementer : des essais simultanes se comptent un a un. Apres la derivation, l'enveloppe est
   * RELUE : seuls le compteur, le delai et la marque d'horloge sont reecrits (et, si besoin, la derivation
   * remise au niveau courant).
   */
  private async verifierPin(pin: string, maintenantMs: number, extractible: boolean): Promise<VerificationPin> {
    if (typeof pin !== "string" || pin.length === 0) return { ok: false, erreur: "PIN_INCORRECT" };

    const brute = await this.stockage.get(this.compteId);
    if (brute === null || brute === undefined) return { ok: false, erreur: "COFFRE_ABSENT" };
    if (!enveloppeValide(brute)) return { ok: false, erreur: "COFFRE_ILLISIBLE" };
    if (brute.compteId !== this.compteId) return { ok: false, erreur: "AUTRE_COMPTE" };
    if (brute.appareilId !== this.appareilId) return { ok: false, erreur: "AUTRE_APPAREIL" };

    if (brute.pasAvantMs !== null && maintenantMs < brute.pasAvantMs) {
      return { ok: false, erreur: "DELAI_EN_COURS", reessayerDansMs: brute.pasAvantMs - maintenantMs };
    }

    const echecs = brute.echecs + 1;
    const delai = delaiApresEchecs(echecs, this.parametres);
    const marqueAvant = brute.dernierInstantMs;
    await this.stockage.put(this.compteId, {
      ...brute,
      echecs,
      pasAvantMs: delai > 0 ? maintenantMs + delai : null,
      dernierInstantMs: Math.max(marqueAvant ?? maintenantMs, maintenantMs),
      rev: (brute.rev ?? 0) + 1,
    });

    let kek: CryptoKey;
    let dek: CryptoKey;
    try {
      kek = await this.deriver(pin, depuisB64(brute.kdf.sel), brute.kdf.iterations);
      dek = await this.deballerDek(brute.cle, kek, extractible);
    } catch {
      return { ok: false, erreur: "PIN_INCORRECT" }; // le compteur reste a sa valeur incrementee
    }

    // Derivation plus faible que le reglage courant : on prepare la reecriture au niveau courant (une
    // seconde derivation). Le changement de PIN reecrit deja l'enveloppe, il n'en a pas besoin.
    let rehash: Pick<EnveloppeCoffre, "kdf" | "cle"> | null = null;
    if (!extractible && brute.kdf.iterations < this.iterations) {
      try {
        const dekExtractible = await this.deballerDek(brute.cle, kek, true);
        const neuve = await this.envelopperDek(pin, dekExtractible);
        rehash = { kdf: neuve.kdf, cle: neuve.cle };
      } catch {
        rehash = null; // un echec de rehash ne doit pas empecher l'agent d'ouvrir
      }
    }

    // PIN juste : on RELIT l'enveloppe (la derivation a dure ; elle a pu changer ailleurs) et on ne modifie que
    // le compteur, le delai et la marque d'horloge.
    const courante = await this.stockage.get(this.compteId);
    if (courante === null || courante === undefined) return { ok: false, erreur: "COFFRE_ABSENT" };
    if (!enveloppeValide(courante) || courante.compteId !== this.compteId || courante.appareilId !== this.appareilId) {
      return { ok: false, erreur: "COFFRE_ILLISIBLE" };
    }
    // La cle enveloppee a change pendant la derivation (autre onglet sans verrou) : le PIN essaye n'est plus le PIN.
    if (!memeEnveloppeDeCle(courante, brute)) return { ok: false, erreur: "PIN_INCORRECT" };

    const apresSucces: EnveloppeCoffre = {
      ...courante,
      ...(rehash ?? {}),
      echecs: 0,
      pasAvantMs: null,
      dernierInstantMs: Math.max(courante.dernierInstantMs ?? maintenantMs, maintenantMs),
      rev: (courante.rev ?? 0) + 1,
    };
    await this.stockage.put(this.compteId, apresSucces);

    let profil: ProfilSession;
    try {
      const clair = await this.dechiffrerAvec(dek, depuisB64(apresSucces.profil), aadProfil(this));
      const lu: unknown = JSON.parse(decodeur.decode(clair));
      if (!profilValide(lu)) return { ok: false, erreur: "COFFRE_ILLISIBLE" };
      profil = lu;
    } catch {
      return { ok: false, erreur: "COFFRE_ILLISIBLE" };
    }
    if (profil.userId !== this.compteId) return { ok: false, erreur: "AUTRE_COMPTE" };

    return { ok: true, envelope: apresSucces, dek, profil, marqueAvant };
  }
}

// ---------------------------------------------------------------------------------------------------
// Fabriques
// ---------------------------------------------------------------------------------------------------

/** Coffre existant (ou a creer), VERROUILLE. N'ecrit rien. */
export function ouvrirCoffre(options: OptionsCoffre): CoffreSession {
  return new CoffreSession(options);
}

/**
 * Cree le coffre apres une connexion en ligne complete et le rend DEVERROUILLE.
 * Jette `ErreurCoffre` : PIN_INVALIDE, COFFRE_EXISTANT (utiliser `reinitialiser` d'abord ; aussi la perdante de
 * deux creations simultanees), AUTRE_COMPTE (le profil n'est pas celui du compte), ARGUMENT_INVALIDE (dont
 * des iterations hors bornes), WEBCRYPTO_INDISPONIBLE.
 */
export async function creerCoffre(options: OptionsCreation): Promise<CoffreSession> {
  const coffre = new CoffreSession(options);
  await coffre.creer(options.pin, options.profil, options.maintenantMs);
  return coffre;
}

/** Liste les comptes ayant un coffre sur cet appareil (pour l'ecran de deverrouillage hors ligne). */
export function listerComptesAvecCoffre(stockage: StockageCoffre): Promise<string[]> {
  return stockage.cles();
}

/**
 * Mesure le cout reel d'UNE derivation de `iterations` tours sur l'appareil courant (millisecondes).
 * Sert a l'etape 9 : a lancer sur un telephone d'entree de gamme avant de figer 600 000.
 */
export async function mesurerDerivationMs(iterations: number = ITERATIONS_PBKDF2_DEFAUT, crypto?: CryptoLike): Promise<number> {
  const c = cryptoDisponible(crypto);
  const base = await c.subtle.importKey("raw", tampon(encodeur.encode("000000")), "PBKDF2", false, ["deriveKey"]);
  const debut = performance.now();
  await c.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: tampon(c.getRandomValues(new Uint8Array(LONGUEUR_SEL))), iterations },
    base, { name: "AES-GCM", length: 256 }, false, ["wrapKey", "unwrapKey"],
  );
  return performance.now() - debut;
}
