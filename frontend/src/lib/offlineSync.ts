// Synchronise les saisies terrain (inspections et défauts) conservées dans IndexedDB
// dès que le réseau est disponible et que l'utilisateur est authentifié. Expose un store
// module-level (pattern identique a toast.ts) pour que le badge de header et la page
// terrain restent en phase sans prop drilling.
import axios from "axios";
import { api } from "./api";
import {
  getAllPending,
  getAllPendingDefauts,
  removePendingDefaut,
  removePendingInspection,
  updatePendingDefaut,
  updatePendingInspection,
  type PendingDefaut,
  type PendingInspection,
  type PendingPortion,
  getAllPendingPortions,
  updatePendingPortion,
  removePendingPortion,
} from "./offlineDb";

type Listener = () => void;
type SyncState = { pendingCount: number; syncing: boolean };
const listeners = new Set<Listener>();
let pendingCount = 0;
let syncing = false;
let utilisateurSyncId: string | null = null;
let appareilVolatile: { userId: string; id: string } | null = null;

/** Le magasin hors-ligne est partagé par le navigateur; le compte courant en fixe le périmètre d'envoi. */
export function configurerUtilisateurSync(userId: string | null) {
  if (utilisateurSyncId !== userId) appareilVolatile = null;
  utilisateurSyncId = userId;
}

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
  const [inspections, defauts, portions] = await Promise.all([
    getAllPending(), getAllPendingDefauts(), getAllPendingPortions(),
  ]);
  // Les trois files comptent ensemble : l'agent veut savoir COMBIEN il lui reste a
  // remonter, pas de quel type. Un compteur par type l'obligerait a additionner.
  pendingCount = utilisateurSyncId
    ? inspections.filter((item) => item.ownerUserId === utilisateurSyncId).length
      + defauts.filter((item) => item.ownerUserId === utilisateurSyncId).length
      + portions.filter((item) => item.ownerUserId === utilisateurSyncId).length
    : 0;
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
 * Une erreur du SERVEUR (reponse 4xx, 5xx) compte toujours : lui a repondu.
 */
function estErreurReseau(err: unknown): boolean {
  return axios.isAxiosError(err) && !err.response;
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
  if (utilisateurSyncId !== item.ownerUserId) return false;
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

function deviceStorageKey(userId: string) {
  return `bdri.sync.device.${userId}`;
}

async function appareilSync(userId: string): Promise<string | null> {
  if (utilisateurSyncId !== userId) return null;
  try {
    const cached = localStorage.getItem(deviceStorageKey(userId));
    if (cached) return cached;
  } catch {
    if (appareilVolatile?.userId === userId) return appareilVolatile.id;
  }

  const { data } = await api.post("/v2/devices", {
    nom: "BDRI — navigateur terrain",
    plateforme: "web",
    modele: navigator.userAgent.slice(0, 120),
  });
  // L'utilisateur peut changer pendant la création réseau de l'appareil. Ne jamais
  // ranger l'appareil du nouveau compte sous la clé de l'ancien ni lui envoyer le
  // brouillon de l'ancien compte.
  if (utilisateurSyncId !== userId) return null;
  const id = data?.id;
  if (typeof id !== "string" || id.length === 0) throw new Error("L'appareil de synchronisation n'a pas été enregistré.");
  appareilVolatile = { userId, id };
  try { localStorage.setItem(deviceStorageKey(userId), id); } catch { /* l'ID reste disponible pour cette session */ }
  return id;
}

function appareilRevoque(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("response" in err)) return false;
  const response = (err as { response?: { status?: number; data?: { message?: unknown } } }).response;
  return response?.status === 403
    && typeof response.data?.message === "string"
    && response.data.message.startsWith("Appareil inconnu, révoqué");
}

/**
 * Pousse UNE operation de creation, quel que soit son type.
 *
 * GENERALISE PLUTOT QUE DUPLIQUE. La reprise apres revocation d'appareil ci-dessous est la
 * partie delicate de cette fonction : la copier pour les portions aurait cree un second
 * endroit ou la corriger, et c'est ainsi qu'un chemin finit par ne plus reprendre.
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
  let deviceId = await appareilSync(userId);
  if (!deviceId || utilisateurSyncId !== userId) return null;
  try {
    const response = await api.post("/v2/sync/push", { appareilId: deviceId, operations: [operation] });
    return utilisateurSyncId === userId ? response : null;
  } catch (err) {
    if (!appareilRevoque(err)) throw err;
    if (utilisateurSyncId !== userId) return null;
    // Un appareil révoqué ne reprend jamais son autorisation. Enregistrer un nouvel
    // appareil permet de reprendre la file avec la même clé d'idempotence.
    try { localStorage.removeItem(deviceStorageKey(userId)); } catch { /* stockage indisponible */ }
    appareilVolatile = null;
    deviceId = await appareilSync(userId);
    if (!deviceId || utilisateurSyncId !== userId) return null;
    const response = await api.post("/v2/sync/push", { appareilId: deviceId, operations: [operation] });
    return utilisateurSyncId === userId ? response : null;
  }
}

async function syncOneDefaut(item: PendingDefaut, userId: string): Promise<boolean> {
  if (item.status === "abandonnee") return false;
  const tentatives = (item.tentatives ?? 0) + 1;
  let etat: PendingDefaut = { ...item, tentatives };
  try {
    if (!etat.serverId) {
      const reponse = await pousserCreation(userId, "Defaut", etat.localId, etat.payload);
      if (!reponse) return false;
      const { data } = reponse;
      const resultat = data?.resultats?.[0] as { statut?: string; entityId?: string; motif?: string } | undefined;
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
  if (item.status === "abandonnee") return false;
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

export async function syncPendingOfflineData(): Promise<void> {
  if (syncing) return;
  if (!navigator.onLine || !utilisateurSyncId) return;
  const userId = utilisateurSyncId;

  syncing = true;
  emit();
  try {
    const all = await getAllPending();
    for (const item of all) {
      if (item.ownerUserId !== userId) continue;
      if (utilisateurSyncId !== userId) break;
      // Une inspection abandonnee n'est plus retentee : elle attend une intervention
      // humaine. La retenter en boucle masquerait le probleme sous du bruit.
      if (item.status === "abandonnee") continue;
      await syncOne(item);
    }

    const defauts = await getAllPendingDefauts();
    for (const item of defauts) {
      if (utilisateurSyncId !== userId) break;
      if (item.ownerUserId !== userId) continue;
      await syncOneDefaut(item, userId);
    }

    const portions = await getAllPendingPortions();
    for (const item of portions) {
      if (utilisateurSyncId !== userId) break;
      if (item.ownerUserId !== userId) continue;
      await syncOnePortion(item, userId);
    }
  } finally {
    syncing = false;
    await refreshPendingCount();
  }
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
