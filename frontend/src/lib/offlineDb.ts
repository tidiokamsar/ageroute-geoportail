// Stockage local des inspections et défauts saisis hors-ligne (IndexedDB natif,
// sans dépendance). La version 2 ajoute le magasin des défauts en conservant les
// inspections déjà enregistrées dans le magasin historique.

const DB_NAME = "bdri-offline";
const DB_VERSION = 2;
const INSPECTIONS_STORE = "pending_inspections";
const DEFAUTS_STORE = "pending_defauts";

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
  status: "pending" | "error" | "abandonnee";
  errorMessage?: string;
  tentatives?: number;
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

export async function removePendingDefaut(localId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DEFAUTS_STORE, "readwrite");
    tx.objectStore(DEFAUTS_STORE).delete(localId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
