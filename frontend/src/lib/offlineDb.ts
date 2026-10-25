// Stockage local des inspections, défauts, portions et observations saisis hors-ligne
// (IndexedDB natif, sans dépendance). La version 2 ajoute le magasin des défauts, la
// version 3 celui des portions, la version 4 celui des observations, en conservant à chaque
// fois les magasins déjà remplis.
//
// POURQUOI LA MIGRATION EST ADDITIVE, Y COMPRIS ICI
//
// Un agent peut avoir des observations non synchronisées sur son téléphone au moment où
// l'application se met à jour. Recréer la base effacerait sa collecte, et une saisie de
// terrain perdue ne se refait pas : il faudrait y retourner. `onupgradeneeded` ne crée
// donc que les magasins absents.

export const DB_NAME = "bdri-offline";
const DB_VERSION = 4;
const INSPECTIONS_STORE = "pending_inspections";
const DEFAUTS_STORE = "pending_defauts";
const PORTIONS_STORE = "pending_portions";
const OBSERVATIONS_STORE = "pending_observations";

export interface PendingInspection {
  localId: string;
  /** Compte qui a saisi ce brouillon; évite une attribution au compte suivant sur un appareil partagé. */
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
    // Lot F : constat des defauts, methode, conditions, mission, section (metres le long du trace).
    constatDefauts?: string;
    methodeObservation?: string;
    conditionsObservation?: string;
    missionId?: string;
    debutM?: number;
    finM?: number;
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
  status: "pending" | "error" | "abandonnee";
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
  /** `conflit` : le serveur a rendu CONFLIT, un responsable doit trancher; la saisie reste en file. */
  status: "pending" | "error" | "abandonnee" | "conflit";
  errorMessage?: string;
  tentatives?: number;
  /** Conflit ouvert côté serveur (rendu par `/v2/sync/push`), pour que l'agent puisse le citer. */
  conflitId?: string;
  motifConflit?: string;
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
  createdAt: string;
  /**
   * `pending`    jamais envoyée, ou envoyée sans réponse
   * `error`      le serveur a répondu par une erreur qui peut passer; on réessaie
   * `abandonnee` plus retentée : refus définitif, ou trop d'échecs consécutifs. VISIBLE, jamais effacée.
   * `conflit`    le serveur a rendu CONFLIT : un responsable doit trancher. VISIBLE, jamais effacée.
   */
  status: "pending" | "error" | "abandonnee" | "conflit";
  errorMessage?: string;
  tentatives?: number;
  /**
   * `true` quand le serveur a refusé DÉFINITIVEMENT (pas de `reessayerDansMs`). Sans ce drapeau, un refus
   * que rien ne changera reviendrait à chaque retour de réseau et la file ne se viderait jamais.
   */
  refusDefinitif?: boolean;
  conflitId?: string;
  motifConflit?: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(INSPECTIONS_STORE)) {
        db.createObjectStore(INSPECTIONS_STORE, { keyPath: "localId" });
      }
      if (!db.objectStoreNames.contains(DEFAUTS_STORE)) {
        db.createObjectStore(DEFAUTS_STORE, { keyPath: "localId" });
      }
      if (!db.objectStoreNames.contains(PORTIONS_STORE)) {
        db.createObjectStore(PORTIONS_STORE, { keyPath: "localId" });
      }
      // Version 4 : observations. ADDITIF, comme les précédentes : aucun magasin existant n'est
      // supprimé ni recréé, une observation de terrain non remontée ne se refait pas.
      if (!db.objectStoreNames.contains(OBSERVATIONS_STORE)) {
        db.createObjectStore(OBSERVATIONS_STORE, { keyPath: "localId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function addPendingInspection(item: PendingInspection): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(INSPECTIONS_STORE, "readwrite");
    tx.objectStore(INSPECTIONS_STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllPending(): Promise<PendingInspection[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(INSPECTIONS_STORE, "readonly");
    const req = tx.objectStore(INSPECTIONS_STORE).getAll();
    req.onsuccess = () => resolve(req.result as PendingInspection[]);
    req.onerror = () => reject(req.error);
  });
}

export async function updatePendingInspection(item: PendingInspection): Promise<void> {
  return addPendingInspection(item);
}

export async function removePendingInspection(localId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(INSPECTIONS_STORE, "readwrite");
    tx.objectStore(INSPECTIONS_STORE).delete(localId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function countPending(): Promise<number> {
  const [inspections, defauts] = await Promise.all([getAllPending(), getAllPendingDefauts()]);
  return inspections.length + defauts.length;
}

export async function addPendingDefaut(item: PendingDefaut): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DEFAUTS_STORE, "readwrite");
    tx.objectStore(DEFAUTS_STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllPendingDefauts(): Promise<PendingDefaut[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DEFAUTS_STORE, "readonly");
    const req = tx.objectStore(DEFAUTS_STORE).getAll();
    req.onsuccess = () => resolve(req.result as PendingDefaut[]);
    req.onerror = () => reject(req.error);
  });
}

export async function updatePendingDefaut(item: PendingDefaut): Promise<void> {
  return addPendingDefaut(item);
}

export async function addPendingPortion(item: PendingPortion): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PORTIONS_STORE, "readwrite");
    tx.objectStore(PORTIONS_STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getAllPendingPortions(): Promise<PendingPortion[]> {
  const db = await openDb();
  const items = await new Promise<PendingPortion[]>((resolve, reject) => {
    const tx = db.transaction(PORTIONS_STORE, "readonly");
    const req = tx.objectStore(PORTIONS_STORE).getAll();
    req.onsuccess = () => resolve(req.result as PendingPortion[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return items;
}

export async function updatePendingPortion(item: PendingPortion): Promise<void> {
  return addPendingPortion(item);
}

export async function removePendingPortion(localId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PORTIONS_STORE, "readwrite");
    tx.objectStore(PORTIONS_STORE).delete(localId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function addPendingObservation(item: PendingObservation): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(OBSERVATIONS_STORE, "readwrite");
    tx.objectStore(OBSERVATIONS_STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}

export async function getAllPendingObservations(): Promise<PendingObservation[]> {
  const db = await openDb();
  const items = await new Promise<PendingObservation[]>((resolve, reject) => {
    const tx = db.transaction(OBSERVATIONS_STORE, "readonly");
    const req = tx.objectStore(OBSERVATIONS_STORE).getAll();
    req.onsuccess = () => resolve(req.result as PendingObservation[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return items;
}

export async function updatePendingObservation(item: PendingObservation): Promise<void> {
  return addPendingObservation(item);
}

/**
 * Retire une observation de la file. Ne s'appelle que sur la confirmation du serveur (SYNCHRONISE ou
 * REJOUEE) : un refus, un conflit ou une erreur ne retirent JAMAIS l'observation.
 */
export async function removePendingObservation(localId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(OBSERVATIONS_STORE, "readwrite");
    tx.objectStore(OBSERVATIONS_STORE).delete(localId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function removePendingDefaut(localId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DEFAUTS_STORE, "readwrite");
    tx.objectStore(DEFAUTS_STORE).delete(localId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
