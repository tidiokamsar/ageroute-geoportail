// Stockage local des inspections saisies hors-ligne (IndexedDB natif, sans dépendance).
// Chaque entrée contient les champs du formulaire + les photos en Blob, en attente de
// synchronisation vers l'API des que le reseau redevient disponible.

const DB_NAME = "bdri-offline";
const DB_VERSION = 1;
const STORE = "pending_inspections";

export interface PendingInspection {
  localId: string;
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
  };
  photos: { name: string; blob: Blob }[];
  createdAt: string;
  status: "pending" | "syncing" | "error";
  errorMessage?: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "localId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function addPendingInspection(item: PendingInspection): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllPending(): Promise<PendingInspection[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
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
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(localId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function countPending(): Promise<number> {
  const all = await getAllPending();
  return all.length;
}
