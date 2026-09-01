// Synchronise les inspections saisies hors-ligne (IndexedDB) vers l'API des que le
// reseau est disponible et que l'utilisateur est authentifie. Expose un petit store
// module-level (pattern identique a toast.ts) pour que le badge de header et la page
// terrain restent en phase sans prop drilling.
import { api } from "./api";
import { getAllPending, removePendingInspection, updatePendingInspection, type PendingInspection } from "./offlineDb";

type Listener = () => void;
type SyncState = { pendingCount: number; syncing: boolean };
const listeners = new Set<Listener>();
let pendingCount = 0;
let syncing = false;

// useSyncExternalStore exige que getSnapshot renvoie une reference stable tant que l'etat
// n'a pas change (sinon React redemande un rendu a l'infini -> "Maximum update depth
// exceeded", erreur #185). On memorise donc l'objet et on n'en recree un que si une des
// deux valeurs a reellement change.
let cachedState: SyncState = { pendingCount, syncing };

function emit() {
  listeners.forEach((l) => l());
}

export function subscribeSync(cb: Listener) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getSyncState(): SyncState {
  if (cachedState.pendingCount !== pendingCount || cachedState.syncing !== syncing) {
    cachedState = { pendingCount, syncing };
  }
  return cachedState;
}

export async function refreshPendingCount() {
  const all = await getAllPending();
  pendingCount = all.length;
  emit();
}

async function syncOne(item: PendingInspection): Promise<boolean> {
  try {
    const { data: created } = await api.post("/inspections", {
      tronconId: item.payload.tronconId || undefined,
      ouvrageId: item.payload.ouvrageId || undefined,
      dateInspection: item.payload.dateInspection,
      etatObserve: item.payload.etatObserve,
      defautsConstates: item.payload.defautsConstates || undefined,
      recommandations: item.payload.recommandations || undefined,
    });

    for (const photo of item.photos) {
      const formData = new FormData();
      formData.append("photo", photo.blob, photo.name);
      await api.post(`/inspections/${created.id}/photos`, formData);
    }

    await removePendingInspection(item.localId);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur de synchronisation";
    await updatePendingInspection({ ...item, status: "error", errorMessage: message });
    return false;
  }
}

export async function syncPendingInspections(): Promise<void> {
  if (syncing) return;
  if (!navigator.onLine) return;

  syncing = true;
  emit();
  try {
    const all = await getAllPending();
    for (const item of all) {
      await syncOne(item);
    }
  } finally {
    syncing = false;
    await refreshPendingCount();
  }
}

let started = false;
export function startOfflineSync() {
  if (started) return;
  started = true;
  refreshPendingCount();
  window.addEventListener("online", () => syncPendingInspections());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && navigator.onLine) syncPendingInspections();
  });
  if (navigator.onLine) syncPendingInspections();
}
