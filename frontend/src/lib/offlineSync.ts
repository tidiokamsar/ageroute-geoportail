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

// Au-dela, on cesse de reessayer. Une erreur permanente — troncon supprime,
// validation refusee — se reproduirait sinon a chaque retour de reseau, sans fin et
// sans que personne ne s'en apercoive. L'element est conserve pour que l'agent puisse
// le corriger ou le supprimer, jamais efface en silence.
const MAX_TENTATIVES = 5;

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
  const tentatives = (item.tentatives ?? 0) + 1;
  let etat = { ...item, tentatives };

  try {
    if (!etat.serverId) {
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
    const message = err instanceof Error ? err.message : "Erreur de synchronisation";
    const abandonnee = tentatives >= MAX_TENTATIVES;
    await updatePendingInspection({
      ...etat,
      status: abandonnee ? "abandonnee" : "error",
      errorMessage: abandonnee ? `${message} (abandon apres ${tentatives} tentatives)` : message,
    });
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
      // Une inspection abandonnee n'est plus retentee : elle attend une intervention
      // humaine. La retenter en boucle masquerait le probleme sous du bruit.
      if (item.status === "abandonnee") continue;
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
