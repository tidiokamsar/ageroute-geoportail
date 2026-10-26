// Stockage local des inspections, defauts, portions et observations saisis hors-ligne
// (IndexedDB natif, sans dependance), CHIFFRE et CLOISONNE PAR COMPTE.
//
// Conception : docs/securite/SESSION-HORS-LIGNE.md (sections 3 et 4). Contrat d'integration : en-tete de
// compteCourant.ts.
//
// UNE BASE PAR COMPTE. `bdri-offline-<empreinte du compte>` (nomBaseOffline). Aucune fonction d'ici ne prend un
// compte en argument : elles resolvent le compte COURANT (compteCourant.ts) a chaque appel. Un second agent du
// meme telephone n'atteint donc jamais les saisies du premier, par aucune API, et plus aucun filtre
// `ownerUserId` n'est necessaire pour l'isolation (il reste ecrit sur chaque saisie, pour le serveur).
//
// FORMAT D'UN ENREGISTREMENT (version de format 1)
//   - une ENVELOPPE en clair, minimale : localId, compteId, status, createdAt, fmt, nbPhotos. C'est ce qu'il
//     faut pour compter et trier sans cle (le badge marche pendant le verrou) ; elle ne porte aucune donnee de
//     terrain. Le nombre de photos est le seul indice de contenu laisse en clair.
//   - une CHARGE chiffree (AES-GCM, AAD `compteId|localId|fmt`) : toute la saisie sauf les photos, plus la
//     description de chaque photo (nom, position, date de prise de vue). Statut, date et identifiant y sont
//     RECOPIES et recoupes a la lecture : une enveloppe retouchee a la main est rejetee.
//   - les PHOTOS, un bloc chiffre chacune, dans un magasin a part (`pending_photos`). Pourquoi a part : lister
//     la file, la compter ou marquer une photo comme envoyee ne doit ni relire ni reecrire les megaoctets des
//     autres photos. Une photo deja stockee n'est ni rechiffree ni reecrite quand la saisie est mise a jour
//     (la synchronisation reecrit la saisie apres CHAQUE photo envoyee).
//
// ORDRE DES OPERATIONS. Le chiffrement est asynchrone : il se fait AVANT d'ouvrir la transaction IndexedDB (une
// transaction qui attend autre chose qu'IndexedDB se ferme toute seule). Les operations d'un meme compte sont
// SERIALISEES (`enchainer`), de sorte qu'une lecture lancee apres une ecriture la voit, comme avant.
//
// RIEN EN CLAIR PAR REPLI. Sans compte ouvert : ErreurStockageLocal AUCUN_COMPTE. Chiffreur verrouille :
// COFFRE_VERROUILLE. Aucune des deux ne bascule sur un stockage non chiffre. Une saisie NON enregistree
// (quota, abandon de transaction) rejette (STOCKAGE_PLEIN, ECRITURE_ANNULEE) : l'appelant ne doit jamais
// annoncer « enregistree » sans avoir attendu cette promesse.
//
// ENREGISTREMENT ILLISIBLE (altere, autre cle, format inconnu) : les listes l'ecartent SANS planter la file ;
// `lireIllisibles()` le montre ; il n'est jamais supprime. Une lecture directe (`getPending*`) leve
// DONNEES_ALTEREES.
//
// POURQUOI LA MIGRATION DE SCHEMA EST ADDITIVE, Y COMPRIS ICI
//
// Un agent peut avoir des observations non synchronisees sur son telephone au moment ou l'application se met a
// jour. Recreer la base effacerait sa collecte, et une saisie de terrain perdue ne se refait pas.
// `onupgradeneeded` ne cree donc que les magasins et index absents, a partir de n'importe quelle version
// anterieure (1 a 4), et ne supprime jamais un magasin. Version 5 : index `compteId` sur chaque file et magasin
// des photos.
import { BASE_OFFLINE_HISTORIQUE, nomBaseOffline } from "../session/compteLocal";
import {
  aadEnregistrement, ErreurStockageLocal, estErreurStockageLocal, exigerCompte, exigerDeverrouille, majCompteurs,
  traduireErreurChiffrement, type Chiffreur, type ContexteCompte,
} from "./compteCourant";

/** Nom de la base d'AVANT le cloisonnement par compte. Lue une fois par `migrationHeritage`, plus ouverte ensuite. */
export const DB_NAME = BASE_OFFLINE_HISTORIQUE;
export const DB_VERSION = 5;
/** Version du format des enregistrements chiffres (entre dans l'AAD). */
export const VERSION_FORMAT = 1;
/** Plafond d'une photo (identique a celui du coffre) et nombre de photos par saisie. */
export const PHOTO_TAILLE_MAX_OCTETS = 8 * 1024 * 1024;
export const PHOTOS_MAX_PAR_SAISIE = 5;

const INSPECTIONS_STORE = "pending_inspections";
const DEFAUTS_STORE = "pending_defauts";
const PORTIONS_STORE = "pending_portions";
const OBSERVATIONS_STORE = "pending_observations";
export const MAGASIN_PHOTOS = "pending_photos";
const INDEX_PHOTOS_PAR_SAISIE = "parSaisie";

/** Les quatre files, avec le libelle employe dans les messages a l'agent. */
export const FILES = {
  inspections: { magasin: INSPECTIONS_STORE, libelle: "inspection" },
  defauts: { magasin: DEFAUTS_STORE, libelle: "défaut" },
  portions: { magasin: PORTIONS_STORE, libelle: "portion" },
  observations: { magasin: OBSERVATIONS_STORE, libelle: "observation" },
} as const;
export type NomFile = keyof typeof FILES;
export const NOMS_FILES = Object.keys(FILES) as NomFile[];

/**
 * Statut local de QUARANTAINE pour un refus de DROITS (chantier D6, contrat serveur : docs/securite/SESSION-HORS-LIGNE-SERVEUR.md
 * section 2.3). Ce n'est pas une erreur (`error`, retentee) ni un abandon (`abandonnee`, refus de donnee ou trop d'echecs) : le
 * serveur a dit que le COMPTE n'a plus le droit d'envoyer cette saisie. Elle n'est plus rejouee seule, garde ses donnees et ses
 * photos chiffrees, et ne repart que sur un renvoi EXPLICITE de l'agent (`relancerRefusDroits`, offlineSync.ts).
 *
 * POURQUOI UNE VALEUR DE CHAMP ET PAS UNE MIGRATION. Le statut est une chaine de l'enveloppe en clair et de la charge chiffree
 * (recoupees a la lecture) : une valeur de plus ne change ni le schema IndexedDB (version 5 conservee) ni le format
 * d'enregistrement. Une saisie ecrite par une version anterieure garde ses statuts, aucun n'est reinterprete.
 */
export const STATUT_REFUS_DROITS = "refus_droits";
/** Causes rendues par le serveur (`DROITS_MODIFIES.cause`), plus `MISSION_NON_AUTORISEE` (motif historique de la meme famille). */
export const CAUSES_REFUS_DROITS = ["HORS_PERIMETRE", "REGION_INCONNUE", "MODULE_RETIRE", "MISSION_NON_AUTORISEE", "NON_PRECISEE"] as const;
export type CauseRefusDroits = (typeof CAUSES_REFUS_DROITS)[number];

export interface PendingInspection {
  localId: string;
  /** Compte qui a saisi ce brouillon; evite une attribution au compte suivant sur un appareil partage. */
  ownerUserId?: string;
  payload: {
    tronconId?: string;
    tronconLabel?: string;
    ouvrageId?: string;
    ouvrageLabel?: string;
    dateInspection: string;
    etatObserve: string;
    defautsConstates?: string;
    recommandations?: string;
    lat?: number;
    lon?: number;
    // Incertitude annoncee par l'appareil, en metres.
    precisionM?: number;
  };
  photos: { name: string; blob: Blob }[];
  createdAt: string;
  status: "pending" | "syncing" | "error" | "abandonnee";
  errorMessage?: string;

  // Identifiant renvoye par le serveur une fois l'inspection creee.
  //
  // Sans lui, une inspection creee avec succes mais dont une photo echoue restait en
  // file d'attente ENTIERE : la synchronisation suivante la recreait, produisant un
  // doublon a chaque tentative. On retient donc l'identifiant des que la creation
  // aboutit, et les reprises n'envoient plus que les photos restantes.
  serverId?: string;

  // Nombre de tentatives de synchronisation. Une erreur permanente — un troncon
  // supprime, une validation refusee — se reproduirait sinon a chaque retour de
  // reseau, indefiniment et sans que personne ne le voie.
  tentatives?: number;
}

export interface PendingPortion {
  localId: string;
  /** Compte qui a saisi ce brouillon ; les files restent cloisonnées par utilisateur. */
  ownerUserId?: string;
  /** Identifiant serveur obtenu après création idempotente. */
  serverId?: string;
  payload: {
    tronconId: string;
    /** Abscisses en mètres depuis le début de la géométrie de référence, pas des PK. */
    debutM: number;
    finM: number;
    revetement?: string | null;
    etat?: string | null;
    praticabilite?: string | null;
    largeurM?: number | null;
    source?: string | null;
    /**
     * Date du CONSTAT, pas de l'envoi.
     *
     * Une portion relevée lundi et remontée vendredi décrit lundi. Prendre la date d'envoi
     * ferait vieillir toute la collecte hors ligne d'un coup, et un indicateur de fraîcheur
     * mentirait sur l'âge réel des données.
     */
    observeeLe?: string | null;
    confiance?: "HIGH" | "MEDIUM" | "LOW" | null;
  };
  createdAt: string;
  /** `refus_droits` : quarantaine d'un refus de DROITS (voir `STATUT_REFUS_DROITS`); la saisie reste en file, non rejouée seule. */
  status: "pending" | "error" | "abandonnee" | "refus_droits";
  errorMessage?: string;
  tentatives?: number;
  /**
   * `true` quand le serveur a refusé DÉFINITIVEMENT.
   *
   * Sans ce drapeau, un refus que rien ne changera — des bornes hors du tronçon, une
   * portion validée déjà en place — reviendrait à chaque retour de réseau et la file ne se
   * viderait jamais. L'agent doit le voir et agir, pas attendre.
   */
  refusDefinitif?: boolean;
  /** Pourquoi le serveur a refusé pour DROITS (statut `refus_droits`). Efface quand la saisie est relancee. */
  causeRefusDroits?: CauseRefusDroits;
}

export interface PendingDefaut {
  localId: string;
  /** Compte qui a saisi ce brouillon; les synchronisations restent cloisonnées par utilisateur. */
  ownerUserId?: string;
  /** Identifiant serveur obtenu après création idempotente. */
  serverId?: string;
  payload: {
    catalogueCode: string;
    lat?: number;
    lon?: number;
    precisionM?: number;
    tronconId?: string;
    abscisseM?: number;
    pk?: number;
    confianceAppariement?: number;
    constateA: string;
    gravite?: number;
    etendue?: "PONCTUEL" | "LOCALISE" | "ETENDU" | "GENERALISE";
    mesures?: {
      nombre?: number;
      longueurM?: number;
      largeurM?: number;
      profondeurM?: number;
      quantiteSaisie?: number;
    };
    /**
     * Contour GPS du defaut (GeoJSON, longitude puis latitude en degres, SRID 4326). Le serveur le mesure en
     * UTM (scenario A5) et en tire la quantite. Produit par le releve a pied de `DefautTerrainPage` (contour ferme,
     * `lib/contourDefaut.ts`) ; la file le transporte sans le modifier. Releve jamais essaye sur un telephone reel.
     */
    emprise?: { type: "LineString" | "MultiLineString" | "Polygon" | "MultiPolygon"; coordinates: unknown[] };
  };
  /** Photos conservées comme Blob; chaque envoi réussi est retiré avant la reprise suivante. */
  photos?: {
    name: string;
    blob: Blob;
    lat?: number;
    lon?: number;
    precisionM?: number;
    capturedA: string;
  }[];
  createdAt: string;
  /**
   * `conflit` : le serveur a rendu CONFLIT, un responsable doit trancher; la saisie reste en file.
   * `refus_droits` : quarantaine d'un refus de DROITS (voir `STATUT_REFUS_DROITS`); la saisie reste en file, non rejouée seule.
   */
  status: "pending" | "error" | "abandonnee" | "conflit" | "refus_droits";
  errorMessage?: string;
  tentatives?: number;
  /** Conflit ouvert côté serveur (rendu par `/v2/sync/push`), pour que l'agent puisse le citer. */
  conflitId?: string;
  motifConflit?: string;
  /** Pourquoi le serveur a refusé pour DROITS (statut `refus_droits`). Efface quand la saisie est relancee. */
  causeRefusDroits?: CauseRefusDroits;
}

/**
 * Valeurs du champ `type` d'une observation, telles que le serveur les accepte
 * (`backend/src/field/observation-sync-payload.ts`). Une valeur inventée ici serait refusée, définitivement.
 */
export const TYPES_OBSERVATION = [
  "DEGRADATION", "CHAUSSEE", "ASSAINISSEMENT", "SIGNALISATION", "OUVRAGE",
  "SECURITE", "TRAFIC", "ENVIRONNEMENT", "CHANTIER", "INCIDENT", "AUTRE",
] as const;
export type TypeObservation = (typeof TYPES_OBSERVATION)[number];
export const GRAVITES_OBSERVATION = ["FAIBLE", "MOYENNE", "FORTE"] as const;
export type GraviteObservation = (typeof GRAVITES_OBSERVATION)[number];

/**
 * Observation saisie hors ligne, en attente de remontée par `POST /v2/sync/push` (CREATE).
 *
 * Le contenu de `payload` est EXACTEMENT celui que le serveur accepte, et rien d'autre : son schéma est
 * strict, une clé de plus ferait refuser l'opération en entier. Auteur, statut, version et validation sont
 * posés par le serveur, jamais par le téléphone.
 */
export interface PendingObservation {
  /**
   * UUID généré une seule fois, à la saisie. Il sert d'`operationId` (clé d'idempotence serveur) ET
   * d'`entityId` : il ne change jamais d'une tentative à l'autre, c'est ce qui rend les rejeux inoffensifs.
   */
  localId: string;
  /** Compte qui a saisi ce brouillon; les files restent cloisonnées par utilisateur. */
  ownerUserId?: string;
  /** Identifiant serveur obtenu après création idempotente. */
  serverId?: string;
  payload: {
    type: TypeObservation;
    gravite?: GraviteObservation | null;
    description?: string | null;
    missionId?: string | null;
    tronconId?: string | null;
    ouvrageId?: string | null;
    chantierId?: string | null;
    pk?: number | null;
    lat?: number | null;
    lon?: number | null;
    precisionM?: number | null;
    /** Date du CONSTAT (ISO 8601), pas de l'envoi. */
    observeA: string;
  };
  /**
   * Photos de l'observation, conservées comme Blob et envoyées APRÈS son acceptation par `POST /v2/observations/:id/photos`
   * (le fichier ne passe pas dans le lot JSON de `/sync/push`, dont le schéma est strict). Chaque photo est retirée de la liste
   * dès que le serveur l'a confirmée ; l'observation ne quitte la file qu'une fois la liste vide.
   */
  photos?: {
    name: string;
    blob: Blob;
    lat?: number;
    lon?: number;
    precisionM?: number;
    capturedA: string;
  }[];
  createdAt: string;
  /**
   * `pending`    jamais envoyée, ou envoyée sans réponse
   * `error`      le serveur a répondu par une erreur qui peut passer; on réessaie
   * `abandonnee` plus retentée : refus définitif, ou trop d'échecs consécutifs. VISIBLE, jamais effacée.
   * `conflit`    le serveur a rendu CONFLIT : un responsable doit trancher. VISIBLE, jamais effacée.
   * `refus_droits` le serveur a refusé pour DROITS (périmètre, module, mission) : QUARANTAINE, visible, jamais effacée, non
   *              rejouée seule; seul un renvoi explicite de l'agent la repart (`relancerRefusDroits`).
   */
  status: "pending" | "error" | "abandonnee" | "conflit" | "refus_droits";
  errorMessage?: string;
  tentatives?: number;
  /**
   * `true` quand le serveur a refusé DÉFINITIVEMENT (pas de `reessayerDansMs`). Sans ce drapeau, un refus
   * que rien ne changera reviendrait à chaque retour de réseau et la file ne se viderait jamais.
   */
  refusDefinitif?: boolean;
  conflitId?: string;
  motifConflit?: string;
  /** Pourquoi le serveur a refusé pour DROITS (statut `refus_droits`). Efface quand la saisie est relancee. */
  causeRefusDroits?: CauseRefusDroits;
}

/**
 * Une saisie lue SANS ses photos (liste, comptage) : le nombre de photos est connu, les octets ne sont pas
 * dechiffres. Le type interdit de la reecrire telle quelle (`photos` y est absent), ce qui evite de perdre des
 * photos par une mise a jour faite sur une lecture legere.
 */
export type SansPhotos<T> = Omit<T, "photos"> & { photos?: undefined; nbPhotos: number };

// ---------------------------------------------------------------------------------------------------
// Enregistrements
// ---------------------------------------------------------------------------------------------------

/** Ce qui est ecrit EN CLAIR pour une saisie. Aucune donnee de terrain. */
export interface EnveloppeSaisie {
  localId: string;
  compteId: string;
  status: string;
  createdAt: string;
  fmt: number;
  nbPhotos: number;
  charge: Uint8Array;
}

/** Une photo chiffree, dans son magasin. `cle` = `<file>/<localId>/<idPhoto>`. */
export interface EnveloppePhoto {
  cle: string;
  saisie: string;
  localId: string;
  file: NomFile;
  compteId: string;
  fmt: number;
  paquet: Uint8Array;
}

export interface PhotoLocale { name: string; blob: Blob }
type MetaPhoto = Record<string, unknown> & { idPhoto: string };
/** Ce que toute saisie des quatre files porte en commun. */
export interface SaisieBase { localId: string; ownerUserId?: string; status: string; createdAt: string; photos?: PhotoLocale[] }
export type SaisieQuelconque = SaisieBase & Record<string, unknown>;

interface CorpsSaisie {
  v: 1;
  file: NomFile;
  item: Record<string, unknown>;
  /** Description des photos, dans l'ordre. `undefined` : la saisie n'a pas de champ `photos`. */
  photos?: MetaPhoto[];
}

const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function enOctets(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new ErreurStockageLocal("DONNEES_ALTEREES");
}

// ---------------------------------------------------------------------------------------------------
// Base, schema et transactions
// ---------------------------------------------------------------------------------------------------

/**
 * Cree ce qui manque, a partir de n'importe quelle version anterieure. Jamais de `deleteObjectStore`.
 * Les enregistrements deja presents (versions 1 a 4, en clair) restent physiquement en place.
 */
function migrerSchema(db: IDBDatabase, tx: IDBTransaction): void {
  for (const { magasin } of Object.values(FILES)) {
    const os = db.objectStoreNames.contains(magasin) ? tx.objectStore(magasin) : db.createObjectStore(magasin, { keyPath: "localId" });
    if (!os.indexNames.contains("compteId")) os.createIndex("compteId", "compteId", { unique: false });
  }
  const photos = db.objectStoreNames.contains(MAGASIN_PHOTOS) ? tx.objectStore(MAGASIN_PHOTOS) : db.createObjectStore(MAGASIN_PHOTOS, { keyPath: "cle" });
  if (!photos.indexNames.contains(INDEX_PHOTOS_PAR_SAISIE)) photos.createIndex(INDEX_PHOTOS_PAR_SAISIE, "saisie", { unique: false });
}

function ouvrirBase(nom: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new ErreurStockageLocal("INDEXEDDB_INDISPONIBLE")); return; }
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open(nom, DB_VERSION); } catch (e) { reject(e instanceof Error ? e : new ErreurStockageLocal("INDEXEDDB_INDISPONIBLE")); return; }
    req.onupgradeneeded = () => {
      if (req.transaction) migrerSchema(req.result, req.transaction);
    };
    req.onsuccess = () => {
      const db = req.result;
      // Une mise a jour de schema dans un autre onglet ne doit pas rester bloquee par cette connexion.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new ErreurStockageLocal("INDEXEDDB_INDISPONIBLE"));
  });
}

/** Erreur typee pour une transaction annulee ou en erreur (le message de l'abandon par quota est conserve tel quel). */
function erreurTransaction(tx: IDBTransaction, libelle: string, ecriture: boolean): Error {
  const cause = tx.error;
  if (!ecriture) return new ErreurStockageLocal("LECTURE_ECHOUEE", `Lecture du stockage local impossible (${libelle})${cause?.message ? ` : ${cause.message}` : ""}.`);
  if (cause?.name === "QuotaExceededError") {
    return new ErreurStockageLocal("STOCKAGE_PLEIN", `Stockage de l'appareil plein : la saisie (${libelle}) n'est PAS enregistrée. Libérez de la place ou synchronisez avant de continuer.`);
  }
  return new ErreurStockageLocal("ECRITURE_ANNULEE", `Écriture locale annulée (${libelle}) : la saisie n'est PAS enregistrée${cause?.message ? ` (${cause.message})` : ""}.`);
}

function traduireErreurIdb(e: unknown, libelle: string): unknown {
  const nom = typeof e === "object" && e !== null ? (e as { name?: unknown }).name : undefined;
  if (nom === "QuotaExceededError") {
    return new ErreurStockageLocal("STOCKAGE_PLEIN", `Stockage de l'appareil plein : la saisie (${libelle}) n'est PAS enregistrée. Libérez de la place ou synchronisez avant de continuer.`);
  }
  if (nom === "DataCloneError" || nom === "TransactionInactiveError") {
    return new ErreurStockageLocal("ECRITURE_ANNULEE", `Écriture locale annulée (${libelle}) : la saisie n'est PAS enregistrée.`);
  }
  return e;
}

/**
 * Execute `travail` dans UNE transaction et attend sa FIN (pas seulement celle des requetes). `travail` declare les
 * requetes et rend une fonction qui lit leur resultat une fois la transaction terminee. Chaque ecriture ecoute
 * `onabort` : un abandon par quota ne declenche ni `oncomplete` ni `onerror`, et sans cet ecouteur la promesse
 * resterait pendante pour toujours, l'ecran attendrait sans fin et l'agent croirait sa saisie enregistree.
 */
function executer<T>(
  db: IDBDatabase, magasins: string[], mode: IDBTransactionMode, libelle: string, travail: (tx: IDBTransaction) => () => T,
): Promise<T> {
  const ecriture = mode === "readwrite";
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try { tx = db.transaction(magasins, mode); } catch (e) { reject(traduireErreurIdb(e, libelle)); return; }
    let lire: (() => T) | null = null;
    tx.oncomplete = () => {
      try { resolve((lire as () => T)()); } catch (e) { reject(e); }
    };
    tx.onerror = () => reject(erreurTransaction(tx, libelle, ecriture));
    tx.onabort = () => reject(erreurTransaction(tx, libelle, ecriture));
    try {
      lire = travail(tx);
    } catch (e) {
      reject(traduireErreurIdb(e, libelle));
      try { tx.abort(); } catch { /* deja terminee */ }
    }
  });
}

const chaines = new Map<string, Promise<void>>();

/**
 * Serialise les operations d'un meme compte. Sans cela, le chiffrement asynchrone avant la transaction
 * laisserait une lecture depasser une ecriture lancee avant elle, ou deux mises a jour d'une meme saisie
 * s'inverser. Une operation ne doit JAMAIS en appeler une autre depuis l'interieur (interblocage).
 */
function enchainer<T>(empreinte: string, travail: () => Promise<T>): Promise<T> {
  const precedent = chaines.get(empreinte) ?? Promise.resolve();
  const suite = precedent.then(travail);
  chaines.set(empreinte, suite.then(() => undefined, () => undefined));
  return suite;
}

async function avecBase<T>(ctx: ContexteCompte, travail: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await ouvrirBase(nomBaseOffline(ctx.empreinte));
  try {
    return await travail(db);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------------------------------
// Photos : plafonds, identifiants, copies deja stockees
// ---------------------------------------------------------------------------------------------------

const mio = (octets: number) => (octets / (1024 * 1024)).toFixed(1).replace(".", ",");

/**
 * Plafonds d'une saisie : 8 Mio par photo et 5 photos (appliques aussi aux inspections, qui n'en avaient pas).
 * Le nombre ne se controle qu'a la CREATION (`nouveau`) : une mise a jour de la synchronisation ne fait que
 * retirer des photos, et ne doit pas echouer sur une saisie plus ancienne que le plafond.
 */
function verifierPhotos(photos: readonly PhotoLocale[] | undefined, nouveau: boolean): void {
  if (!photos) return;
  if (nouveau && photos.length > PHOTOS_MAX_PAR_SAISIE) {
    throw new ErreurStockageLocal("TROP_DE_PHOTOS",
      `Cinq photos au maximum par saisie (${photos.length} jointes) : la saisie n'est PAS enregistrée. Retirez des photos puis recommencez.`);
  }
  for (const p of photos) {
    const taille = p?.blob?.size;
    if (typeof taille === "number" && taille > PHOTO_TAILLE_MAX_OCTETS) {
      throw new ErreurStockageLocal("PHOTO_TROP_GROSSE",
        `La photo « ${p.name} » pèse ${mio(taille)} Mio, le maximum est de ${mio(PHOTO_TAILLE_MAX_OCTETS)} Mio : la saisie n'est PAS enregistrée. Réduisez la résolution de l'appareil photo puis recommencez.`);
    }
  }
}

let compteurPhotos = 0;
function nouvelIdentifiantPhoto(): string {
  compteurPhotos += 1;
  const hasard = Math.floor(Math.random() * 0xffffff).toString(36);
  return `${Date.now().toString(36)}${compteurPhotos.toString(36)}${hasard}`;
}

interface PhotoMemorisee { generation: number; file: NomFile; localId: string; id: string; enveloppe: EnveloppePhoto }
/**
 * Photos deja stockees, retrouvees par l'objet Blob lui-meme (lu depuis la base, ou ecrit une fois). Une saisie
 * reecrite avec le MEME Blob reutilise son bloc chiffre au lieu de le rechiffrer. La generation du compte
 * invalide tout ce qui precede un changement de compte ou de chiffreur.
 */
const photosConnues = new WeakMap<object, PhotoMemorisee>();

// ---------------------------------------------------------------------------------------------------
// Ecriture
// ---------------------------------------------------------------------------------------------------

interface Preparation {
  enveloppe: EnveloppeSaisie;
  aEcrire: EnveloppePhoto[];
  reutilisees: EnveloppePhoto[];
  gardees: Set<string>;
  saisie: string;
}

async function preparer(
  ctx: ContexteCompte, chiffreur: Chiffreur, file: NomFile, item: SaisieBase,
): Promise<Preparation> {
  const { photos, ...reste } = item;
  const saisie = `${file}/${item.localId}`;
  const metas: MetaPhoto[] = [];
  const aEcrire: EnveloppePhoto[] = [];
  const reutilisees: EnveloppePhoto[] = [];
  const gardees = new Set<string>();

  try {
    if (photos) {
      for (const p of photos) {
        const { blob, ...meta } = p as PhotoLocale & Record<string, unknown>;
        const memo = photosConnues.get(blob);
        if (memo && memo.generation === ctx.generation && memo.file === file && memo.localId === item.localId) {
          metas.push({ ...meta, idPhoto: memo.id });
          reutilisees.push(memo.enveloppe);
          gardees.add(memo.enveloppe.cle);
          continue;
        }
        const id = nouvelIdentifiantPhoto();
        const paquet = await chiffreur.chiffrerBlob(blob, `${item.localId}.${id}`, VERSION_FORMAT);
        const enveloppe: EnveloppePhoto = { cle: `${saisie}/${id}`, saisie, localId: item.localId, file, compteId: ctx.compteId, fmt: VERSION_FORMAT, paquet };
        photosConnues.set(blob, { generation: ctx.generation, file, localId: item.localId, id, enveloppe });
        metas.push({ ...meta, idPhoto: id });
        aEcrire.push(enveloppe);
        gardees.add(enveloppe.cle);
      }
    }
    const corps: CorpsSaisie = { v: 1, file, item: reste, photos: photos === undefined ? undefined : metas };
    const charge = await chiffreur.chiffrer(corps, aadEnregistrement(ctx.compteId, item.localId, VERSION_FORMAT));
    const enveloppe: EnveloppeSaisie = {
      localId: item.localId, compteId: ctx.compteId, status: item.status, createdAt: item.createdAt,
      fmt: VERSION_FORMAT, nbPhotos: metas.length, charge,
    };
    return { enveloppe, aEcrire, reutilisees, gardees, saisie };
  } catch (e) {
    throw traduireErreurChiffrement(e);
  }
}

/** Une seule transaction : la saisie, ses nouvelles photos, et le retrait des photos qu'elle ne porte plus. */
function persister(db: IDBDatabase, file: NomFile, p: Preparation): Promise<void> {
  const { magasin, libelle } = FILES[file];
  return executer<void>(db, [magasin, MAGASIN_PHOTOS], "readwrite", libelle, (tx) => {
    const os = tx.objectStore(magasin);
    const ps = tx.objectStore(MAGASIN_PHOTOS);
    os.put(p.enveloppe);
    for (const photo of p.aEcrire) ps.put(photo);
    // Photo deja stockee et reutilisee : on ne la reecrit que si elle a disparu (saisie retiree puis rajoutee).
    for (const photo of p.reutilisees) {
      const r = ps.getKey(photo.cle);
      r.onsuccess = () => { if (r.result === undefined) ps.put(photo); };
    }
    const cles = ps.index(INDEX_PHOTOS_PAR_SAISIE).getAllKeys(IDBKeyRange.only(p.saisie));
    cles.onsuccess = () => {
      for (const cle of cles.result) if (!p.gardees.has(String(cle))) ps.delete(cle);
    };
    return () => undefined;
  });
}

/**
 * Ecrit (ou remplace) une saisie. `nouveau` applique le plafond du nombre de photos ; `migration` ecrit une
 * saisie d'avant les plafonds telle quelle (jamais pour une saisie du clavier). Rejette si la saisie n'est PAS
 * enregistree.
 */
export async function ecrireSaisie(
  file: NomFile, item: SaisieBase, options: { nouveau?: boolean; migration?: boolean } = {},
): Promise<void> {
  const ctx = exigerCompte();
  const chiffreur = exigerDeverrouille(ctx);
  if (!estObjet(item) || typeof item.localId !== "string" || item.localId.length === 0 || item.localId.includes("|")
    || typeof item.status !== "string" || typeof item.createdAt !== "string") {
    throw new ErreurStockageLocal("ARGUMENT_INVALIDE");
  }
  if (item.ownerUserId !== undefined && item.ownerUserId !== ctx.compteId) throw new ErreurStockageLocal("COMPTE_INCOHERENT");
  if (!options.migration) verifierPhotos(item.photos, options.nouveau === true);
  const complete: SaisieBase = { ...item, ownerUserId: ctx.compteId };

  await enchainer(ctx.empreinte, async () => {
    const preparation = await preparer(ctx, chiffreur, file, complete);
    await avecBase(ctx, (db) => persister(db, file, preparation));
  });
}

async function supprimerSaisie(file: NomFile, localId: string): Promise<void> {
  const ctx = exigerCompte();
  exigerDeverrouille(ctx);
  const { magasin, libelle } = FILES[file];
  const saisie = `${file}/${localId}`;
  await enchainer(ctx.empreinte, () => avecBase(ctx, (db) => executer<void>(db, [magasin, MAGASIN_PHOTOS], "readwrite", libelle, (tx) => {
    tx.objectStore(magasin).delete(localId);
    const ps = tx.objectStore(MAGASIN_PHOTOS);
    const cles = ps.index(INDEX_PHOTOS_PAR_SAISIE).getAllKeys(IDBKeyRange.only(saisie));
    cles.onsuccess = () => { for (const cle of cles.result) ps.delete(cle); };
    return () => undefined;
  })));
}

// ---------------------------------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------------------------------

interface LectureBrute { bruts: unknown[]; photos: Map<string, EnveloppePhoto[]> }

/** Lit les enveloppes d'une file (ou d'une seule saisie) et, si demande, les blocs chiffres de leurs photos. Rien n'est dechiffre ici. */
function lireBruts(ctx: ContexteCompte, file: NomFile, options: { avecPhotos: boolean; localId?: string }): Promise<LectureBrute> {
  const { magasin, libelle } = FILES[file];
  return avecBase(ctx, async (db) => {
    const bruts = await executer<unknown[]>(db, [magasin], "readonly", libelle, (tx) => {
      const os = tx.objectStore(magasin);
      if (options.localId === undefined) {
        const r = os.getAll();
        return () => r.result as unknown[];
      }
      const r = os.get(options.localId);
      return () => (r.result === undefined ? [] : [r.result]);
    });
    const photos = new Map<string, EnveloppePhoto[]>();
    const avecPhotos = bruts.filter((b) => estObjet(b) && typeof b.localId === "string" && typeof b.nbPhotos === "number" && b.nbPhotos > 0) as unknown as EnveloppeSaisie[];
    if (options.avecPhotos && avecPhotos.length > 0) {
      await executer<void>(db, [MAGASIN_PHOTOS], "readonly", libelle, (tx) => {
        const index = tx.objectStore(MAGASIN_PHOTOS).index(INDEX_PHOTOS_PAR_SAISIE);
        const demandes = avecPhotos.map((b) => ({ localId: b.localId, requete: index.getAll(IDBKeyRange.only(`${file}/${b.localId}`)) }));
        return () => { for (const d of demandes) photos.set(d.localId, d.requete.result as EnveloppePhoto[]); };
      });
    }
    return { bruts, photos };
  });
}

function verifierEnveloppe(brut: unknown, ctx: ContexteCompte): EnveloppeSaisie {
  if (!estObjet(brut) || typeof brut.localId !== "string" || typeof brut.status !== "string" || typeof brut.createdAt !== "string"
    || typeof brut.compteId !== "string" || brut.fmt !== VERSION_FORMAT || typeof brut.nbPhotos !== "number" || !brut.charge) {
    // Enregistrement d'avant le chiffrement (versions 1 a 4, en clair) ou format inconnu : jamais lu, jamais rendu.
    throw new ErreurStockageLocal("DONNEES_ALTEREES");
  }
  if (brut.compteId !== ctx.compteId) throw new ErreurStockageLocal("DONNEES_ALTEREES");
  return { ...(brut as unknown as EnveloppeSaisie), charge: enOctets(brut.charge) };
}

async function decoder(
  ctx: ContexteCompte, chiffreur: Chiffreur, file: NomFile, brut: unknown, paquets: readonly EnveloppePhoto[], avecPhotos: boolean,
): Promise<SaisieQuelconque> {
  const env = verifierEnveloppe(brut, ctx);
  let corps: CorpsSaisie;
  try {
    corps = await chiffreur.dechiffrerJson<CorpsSaisie>(env.charge, aadEnregistrement(ctx.compteId, env.localId, VERSION_FORMAT));
  } catch (e) {
    throw traduireErreurChiffrement(e);
  }
  // L'enveloppe est en clair : ce qu'elle annonce doit etre ce que le contenu chiffre dit.
  if (!estObjet(corps) || corps.v !== 1 || corps.file !== file || !estObjet(corps.item)
    || corps.item.localId !== env.localId || corps.item.status !== env.status || corps.item.createdAt !== env.createdAt
    || (corps.photos !== undefined && (!Array.isArray(corps.photos) || corps.photos.length !== env.nbPhotos))
    || (corps.photos === undefined && env.nbPhotos !== 0)) {
    throw new ErreurStockageLocal("DONNEES_ALTEREES");
  }
  const item = corps.item as SaisieQuelconque;
  if (!avecPhotos) return { ...item, nbPhotos: env.nbPhotos };
  if (corps.photos === undefined) return item;

  const parCle = new Map(paquets.map((p) => [p.cle, p]));
  const photos: PhotoLocale[] = [];
  for (const meta of corps.photos) {
    const { idPhoto, ...reste } = meta;
    const enveloppe = typeof idPhoto === "string" ? parCle.get(`${file}/${env.localId}/${idPhoto}`) : undefined;
    if (!enveloppe || enveloppe.compteId !== ctx.compteId) throw new ErreurStockageLocal("DONNEES_ALTEREES");
    let blob: Blob;
    try {
      blob = await chiffreur.dechiffrerBlob(enOctets(enveloppe.paquet), `${env.localId}.${idPhoto}`, VERSION_FORMAT);
    } catch (e) {
      throw traduireErreurChiffrement(e);
    }
    photosConnues.set(blob, { generation: ctx.generation, file, localId: env.localId, id: idPhoto as string, enveloppe });
    photos.push({ ...(reste as { name: string }), blob });
  }
  return { ...item, photos };
}

/** Toutes les saisies lisibles d'une file. Les illisibles sont ecartees (voir `lireIllisibles`), jamais supprimees. */
async function lireFile(file: NomFile, sansPhotos: boolean): Promise<SaisieQuelconque[]> {
  const ctx = exigerCompte();
  const chiffreur = exigerDeverrouille(ctx);
  const { bruts, photos } = await enchainer(ctx.empreinte, () => lireBruts(ctx, file, { avecPhotos: !sansPhotos }));
  const sortie: SaisieQuelconque[] = [];
  for (const brut of bruts) {
    const localId = estObjet(brut) && typeof brut.localId === "string" ? brut.localId : "";
    try {
      sortie.push(await decoder(ctx, chiffreur, file, brut, photos.get(localId) ?? [], !sansPhotos));
    } catch (e) {
      if (estErreurStockageLocal(e, "DONNEES_ALTEREES")) continue;
      throw e;
    }
  }
  return sortie;
}

/** Une saisie, entiere. `null` si elle n'existe pas ; DONNEES_ALTEREES si elle existe mais ne se relit pas. */
export async function lireSaisie(file: NomFile, localId: string, avecPhotos = true): Promise<SaisieQuelconque | null> {
  const ctx = exigerCompte();
  const chiffreur = exigerDeverrouille(ctx);
  const { bruts, photos } = await enchainer(ctx.empreinte, () => lireBruts(ctx, file, { avecPhotos, localId }));
  if (bruts.length === 0) return null;
  return decoder(ctx, chiffreur, file, bruts[0], photos.get(localId) ?? [], avecPhotos);
}

// ---------------------------------------------------------------------------------------------------
// Diagnostic et comptage
// ---------------------------------------------------------------------------------------------------

export interface EnregistrementIllisible {
  file: NomFile;
  localId: string | null;
  status: string | null;
  createdAt: string | null;
  /** `FORMAT_INCONNU` : enregistrement d'avant le chiffrement (clair) ou d'un autre format ; `ILLISIBLE` : ne se dechiffre pas. */
  nature: "FORMAT_INCONNU" | "ILLISIBLE";
}

/**
 * Les enregistrements que la file n'arrive pas a relire (alteres, autre cle, clair d'avant le chiffrement).
 * Ils ne sont ni supprimes ni rendus : l'agent doit pouvoir etre prevenu qu'une saisie existe et qu'elle est perdue
 * pour l'application, plutot que de la voir disparaitre. Demande le chiffreur deverrouille.
 */
export async function lireIllisibles(): Promise<EnregistrementIllisible[]> {
  const ctx = exigerCompte();
  const chiffreur = exigerDeverrouille(ctx);
  const sortie: EnregistrementIllisible[] = [];
  for (const file of NOMS_FILES) {
    const { bruts } = await enchainer(ctx.empreinte, () => lireBruts(ctx, file, { avecPhotos: false }));
    for (const brut of bruts) {
      const b = estObjet(brut) ? brut : {};
      const identite = {
        file,
        localId: typeof b.localId === "string" ? b.localId : null,
        status: typeof b.status === "string" ? b.status : null,
        createdAt: typeof b.createdAt === "string" ? b.createdAt : null,
      };
      try {
        await decoder(ctx, chiffreur, file, brut, [], false);
      } catch (e) {
        if (!estErreurStockageLocal(e, "DONNEES_ALTEREES")) throw e;
        sortie.push({ ...identite, nature: estObjet(brut) && brut.fmt === VERSION_FORMAT && brut.charge ? "ILLISIBLE" : "FORMAT_INCONNU" });
      }
    }
  }
  return sortie;
}

export interface DecompteFile {
  total: number;
  /** `pending` et `syncing`. */
  enAttente: number;
  enErreur: number;
  abandonnees: number;
  enConflit: number;
  /** Saisies en quarantaine pour refus de DROITS (`refus_droits`) : conservees, non rejouees seules. */
  refusDroits: number;
  photosEnFile: number;
  parFile: Record<NomFile, number>;
}

/**
 * Compte la file du compte courant PAR STATUT, sans aucune cle : fonctionne pendant le verrou, ne dechiffre rien,
 * ne lit que les enveloppes. Met a jour le compteur d'information du compte (`compteurs.saisies`). Ne voit pas les
 * enregistrements illisibles comme tels : ils figurent dans le total tant qu'ils ont une enveloppe.
 */
export async function compterFile(): Promise<DecompteFile> {
  const ctx = exigerCompte();
  const d: DecompteFile = { total: 0, enAttente: 0, enErreur: 0, abandonnees: 0, enConflit: 0, refusDroits: 0, photosEnFile: 0, parFile: { inspections: 0, defauts: 0, portions: 0, observations: 0 } };
  for (const file of NOMS_FILES) {
    const { bruts } = await enchainer(ctx.empreinte, () => lireBruts(ctx, file, { avecPhotos: false }));
    for (const brut of bruts) {
      const b = estObjet(brut) ? brut : {};
      d.total += 1;
      d.parFile[file] += 1;
      if (typeof b.nbPhotos === "number" && b.nbPhotos > 0) d.photosEnFile += b.nbPhotos;
      switch (b.status) {
        case "error": d.enErreur += 1; break;
        case "abandonnee": d.abandonnees += 1; break;
        case "conflit": d.enConflit += 1; break;
        case STATUT_REFUS_DROITS: d.refusDroits += 1; break;
        default: d.enAttente += 1;
      }
    }
  }
  majCompteurs(ctx.empreinte, { saisies: d.total });
  return d;
}

export async function countPending(): Promise<number> {
  const d = await compterFile();
  return d.parFile.inspections + d.parFile.defauts;
}

// ---------------------------------------------------------------------------------------------------
// API publique, signatures d'avant conservees
// ---------------------------------------------------------------------------------------------------

export function addPendingInspection(item: PendingInspection): Promise<void> {
  return ecrireSaisie("inspections", item, { nouveau: true });
}

export function getAllPending(): Promise<PendingInspection[]>;
export function getAllPending(options: { sansPhotos: true }): Promise<SansPhotos<PendingInspection>[]>;
export async function getAllPending(options?: { sansPhotos?: boolean }): Promise<unknown[]> {
  return lireFile("inspections", options?.sansPhotos === true);
}

export async function getPendingInspection(localId: string): Promise<PendingInspection | null> {
  return (await lireSaisie("inspections", localId)) as unknown as PendingInspection | null;
}

export function updatePendingInspection(item: PendingInspection): Promise<void> {
  return ecrireSaisie("inspections", item);
}

export function removePendingInspection(localId: string): Promise<void> {
  return supprimerSaisie("inspections", localId);
}

export function addPendingDefaut(item: PendingDefaut): Promise<void> {
  return ecrireSaisie("defauts", item, { nouveau: true });
}

export function getAllPendingDefauts(): Promise<PendingDefaut[]>;
export function getAllPendingDefauts(options: { sansPhotos: true }): Promise<SansPhotos<PendingDefaut>[]>;
export async function getAllPendingDefauts(options?: { sansPhotos?: boolean }): Promise<unknown[]> {
  return lireFile("defauts", options?.sansPhotos === true);
}

export async function getPendingDefaut(localId: string): Promise<PendingDefaut | null> {
  return (await lireSaisie("defauts", localId)) as unknown as PendingDefaut | null;
}

export function updatePendingDefaut(item: PendingDefaut): Promise<void> {
  return ecrireSaisie("defauts", item);
}

export function removePendingDefaut(localId: string): Promise<void> {
  return supprimerSaisie("defauts", localId);
}

export function addPendingPortion(item: PendingPortion): Promise<void> {
  return ecrireSaisie("portions", item, { nouveau: true });
}

export function getAllPendingPortions(): Promise<PendingPortion[]>;
export function getAllPendingPortions(options: { sansPhotos: true }): Promise<SansPhotos<PendingPortion>[]>;
export async function getAllPendingPortions(options?: { sansPhotos?: boolean }): Promise<unknown[]> {
  return lireFile("portions", options?.sansPhotos === true);
}

export async function getPendingPortion(localId: string): Promise<PendingPortion | null> {
  return (await lireSaisie("portions", localId)) as unknown as PendingPortion | null;
}

export function updatePendingPortion(item: PendingPortion): Promise<void> {
  return ecrireSaisie("portions", item);
}

export function removePendingPortion(localId: string): Promise<void> {
  return supprimerSaisie("portions", localId);
}

export function addPendingObservation(item: PendingObservation): Promise<void> {
  return ecrireSaisie("observations", item, { nouveau: true });
}

export function getAllPendingObservations(): Promise<PendingObservation[]>;
export function getAllPendingObservations(options: { sansPhotos: true }): Promise<SansPhotos<PendingObservation>[]>;
export async function getAllPendingObservations(options?: { sansPhotos?: boolean }): Promise<unknown[]> {
  return lireFile("observations", options?.sansPhotos === true);
}

export async function getPendingObservation(localId: string): Promise<PendingObservation | null> {
  return (await lireSaisie("observations", localId)) as unknown as PendingObservation | null;
}

export function updatePendingObservation(item: PendingObservation): Promise<void> {
  return ecrireSaisie("observations", item);
}

/**
 * Retire une observation de la file. Ne s'appelle que sur la confirmation du serveur (SYNCHRONISE ou
 * REJOUEE) : un refus, un conflit ou une erreur ne retirent JAMAIS l'observation.
 */
export function removePendingObservation(localId: string): Promise<void> {
  return supprimerSaisie("observations", localId);
}
