// @vitest-environment node
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { AxiosError } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { creerCoffre, stockageEnMemoire, sha256WebCrypto, type CoffreSession } from "../session/coffreSession";
import { empreinteCompte } from "../session/compteLocal";
import { decisionSuppressionLocale } from "../session/politiqueDeconnexion";

/**
 * Chantier D6 : le CLIENT de synchronisation respecte le contrat serveur (docs/securite/SESSION-HORS-LIGNE-SERVEUR.md, 2.1 a 2.3).
 *
 * Le vrai `offlineSync.ts`, la vraie file chiffree (vrai coffre, IndexedDB de fake-indexeddb); seul le reseau est simule par un
 * `api` programmable. Le serveur simule ne fait que repondre ce que le contrat dit : il n'implemente aucune regle metier, donc ces
 * tests prouvent la CONDUITE DU CLIENT face aux codes, pas le serveur (banc : backend/tests-integration/session-appareil).
 */

interface Appel { url: string; corps: unknown }
interface OperationPush { operationId: string; entityType: string; entityId: string; payload: Record<string, unknown> }
interface DemandePush { appareilId: string; op: OperationPush; n: number }

const appels: Appel[] = [];
const photosRecues: { url: string; nom: string; octets: Uint8Array }[] = [];
const serveur = {
  nPush: 0,
  nDevices: 0,
  push: (_d: DemandePush): unknown => ({ statut: "SYNCHRONISE" }),
  devices: (_n: number): unknown => ({ id: "device-neuf" }),
  inspection: (): unknown => ({ id: "srv-insp" }),
};

vi.mock("./api", () => ({
  api: {
    post: vi.fn(async (url: string, corps: unknown) => {
      appels.push({ url, corps });
      if (url === "/v2/devices") {
        serveur.nDevices += 1;
        return { data: await serveur.devices(serveur.nDevices) };
      }
      if (url === "/v2/sync/push") {
        serveur.nPush += 1;
        const c = corps as { appareilId: string; operations: OperationPush[] };
        const op = c.operations[0];
        const r = (await serveur.push({ appareilId: c.appareilId, op, n: serveur.nPush })) as Record<string, unknown>;
        return { data: { resultats: [{ operationId: op.operationId, entityId: op.entityId, ...r }] } };
      }
      if (url === "/inspections") return { data: await serveur.inspection() };
      const f = (corps as FormData).get("photo") as File;
      photosRecues.push({ url, nom: f.name, octets: new Uint8Array(await f.arrayBuffer()) });
      return { data: {} };
    }),
  },
}));

import { fermerCompte, lireStockageLocal, NOM_CLE_APPAREIL_SYNC, ouvrirCompte, ecrireStockageLocal } from "./compteCourant";
import {
  addPendingDefaut, addPendingInspection, addPendingObservation, addPendingPortion, compterFile, getAllPending, getAllPendingDefauts,
  getAllPendingObservations, getAllPendingPortions, getPendingObservation,
} from "./offlineDb";
import {
  configurerUtilisateurSync, decompteFileLocale, etatSynchronisation, getSyncState, leverArretSynchronisation, MESSAGE_APPAREIL_REVOQUE,
  MESSAGE_COMPTE_INACTIF, MESSAGES_REFUS_DROITS, refreshPendingCount, relancerRefusDroits, surEtatSynchronisation, syncPendingOfflineData,
  type EtatSynchronisation,
} from "./offlineSync";

// ---- aides -----------------------------------------------------------------------------------------------------------------

function erreurHttp(statut: number, donnees: Record<string, unknown>): AxiosError {
  return new AxiosError("Request failed", "ERR_BAD_REQUEST", undefined, undefined, {
    status: statut, statusText: "", data: donnees, headers: {}, config: {} as never,
  });
}
const erreurReseau = () => new AxiosError("Network Error", "ERR_NETWORK");
const revoque = () => erreurHttp(403, { error: "Appareil révoqué : il ne peut plus synchroniser. Contactez un administrateur.", code: "APPAREIL_REVOQUE" });
const inconnu = () => erreurHttp(403, { error: "Appareil inconnu, révoqué ou non autorisé", code: "APPAREIL_INCONNU" });
const compteInactif = () => erreurHttp(401, { error: "Compte désactivé", code: "COMPTE_INACTIF" });
const refusDroits = (cause: string) => ({ statut: "REJETE", motif: "DROITS_MODIFIES", cause, definitif: true });

function jpeg(n: number, graine: number): Uint8Array<ArrayBuffer> {
  const o = new Uint8Array(new ArrayBuffer(n));
  o.set([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  let x = graine;
  for (let i = 10; i < n; i += 1) { x = (x * 1103515245 + 12345) & 0x7fffffff; o[i] = x & 0xff; }
  return o;
}
const photo = (nom: string, n: number, graine: number) => ({
  name: nom, blob: new Blob([jpeg(n, graine)], { type: "image/jpeg" }), capturedA: "2026-10-25T08:00:30.000Z",
});
async function octets(b: Blob): Promise<Uint8Array> { return new Uint8Array(await b.arrayBuffer()); }

function fauxLocalStorage() {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, key: (i: number) => [...m.keys()][i] ?? null, getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(),
  };
}

let coffre: CoffreSession;
async function ouvrirA(avecAppareil: string | null = "device-0"): Promise<void> {
  coffre = await creerCoffre({
    stockage: stockageEnMemoire(), compteId: "agent-A", appareilId: "tel-1", pin: "246810", maintenantMs: Date.now(), iterations: 1000, iterationsDeTest: true,
    profil: { userId: "agent-A", nom: "A", role: "INSPECTEUR", modules: [], regions: [] },
  });
  ouvrirCompte({ compteId: "agent-A", empreinte: await empreinteCompte("agent-A", sha256WebCrypto), chiffreur: coffre });
  configurerUtilisateurSync("agent-A");
  if (avecAppareil !== null) ecrireStockageLocal(NOM_CLE_APPAREIL_SYNC, avecAppareil, "agent-A");
}

const base = { ownerUserId: "agent-A", status: "pending" as const };
const obs = (localId: string, createdAt = "2026-10-25T08:00:00.000Z", nbPhotos = 0) => ({
  ...base, localId, createdAt,
  payload: { type: "DEGRADATION" as const, description: `DESC-${localId}`, observeA: createdAt },
  photos: Array.from({ length: nbPhotos }, (_, i) => photo(`${localId}-${i}.jpg`, 1800 + i * 200, i + 3)),
});
const def = (localId: string) => ({
  ...base, localId, createdAt: "2026-10-25T08:01:00.000Z",
  payload: { catalogueCode: "NID_POULE", constateA: "2026-10-25T08:01:00.000Z", gravite: 3 },
  photos: [photo(`${localId}.jpg`, 1500, 9)],
});
const por = (localId: string) => ({
  ...base, localId, createdAt: "2026-10-25T08:02:00.000Z", payload: { tronconId: "t-1", debutM: 0, finM: 40 },
});
const insp = (localId: string) => ({
  ...base, localId, createdAt: "2026-10-25T08:00:00.000Z",
  payload: { tronconId: "t-1", dateInspection: "2026-10-25", etatObserve: "MAUVAIS" }, photos: [],
});

const urls = () => appels.map((a) => a.url);
const pushs = () => appels.filter((a) => a.url === "/v2/sync/push");
const enregistrements = () => appels.filter((a) => a.url === "/v2/devices");

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("localStorage", fauxLocalStorage());
  vi.stubGlobal("navigator", { onLine: true, userAgent: "essai" });
  appels.length = 0; photosRecues.length = 0;
  serveur.nPush = 0; serveur.nDevices = 0;
  serveur.push = () => ({ statut: "SYNCHRONISE" });
  serveur.devices = () => ({ id: "device-neuf" });
  serveur.inspection = () => ({ id: "srv-insp" });
  fermerCompte();
  configurerUtilisateurSync(null);
  leverArretSynchronisation();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); fermerCompte(); });

// ---- 1. appareil revoque ---------------------------------------------------------------------------------------------------

describe("403 APPAREIL_REVOQUE : la synchronisation s'arrete, rien n'est reenregistre, la file est intacte", () => {
  it("sync/push : une seule requete, aucun POST /devices, aucun rejeu, statuts et photos intacts, etat expose et notifie", async () => {
    await ouvrirA();
    await addPendingDefaut(def("def-1"));
    await addPendingPortion(por("por-1"));
    await addPendingObservation(obs("obs-1", "2026-10-25T08:00:01.000Z", 2));
    await addPendingObservation(obs("obs-2", "2026-10-25T08:00:02.000Z"));
    serveur.push = () => { throw revoque(); };
    const vus: EtatSynchronisation[] = [];
    const desabonner = surEtatSynchronisation((e) => vus.push(e));

    await syncPendingOfflineData();

    expect(urls()).toEqual(["/v2/sync/push"]);                      // pas de rejeu, pas d'enregistrement, les 3 autres saisies ne partent pas
    expect(enregistrements()).toHaveLength(0);
    expect(etatSynchronisation()).toEqual({ appareilRevoque: true, compteInactif: false, message: MESSAGE_APPAREIL_REVOQUE });
    expect(MESSAGE_APPAREIL_REVOQUE).toBe("Cet appareil a été retiré par l'administration. Vos saisies sont conservées ; contactez votre responsable.");
    expect(vus).toHaveLength(1);
    expect(getSyncState()).toMatchObject({ appareilRevoque: true, compteInactif: false, pendingCount: 4, syncing: false });

    // La file est intacte : ni statut, ni compteur d'echec, ni message, ni photo perdue.
    const defauts = await getAllPendingDefauts();
    const portions = await getAllPendingPortions();
    const observations = await getAllPendingObservations();
    for (const s of [...defauts, ...portions, ...observations]) {
      expect(s.status).toBe("pending");
      expect(s.tentatives).toBeUndefined();
      expect(s.errorMessage).toBeUndefined();
    }
    expect(observations.map((o) => o.localId)).toEqual(["obs-1", "obs-2"]);
    expect(await octets(observations[0].photos![0].blob)).toEqual(jpeg(1800, 3));
    expect(await octets(observations[0].photos![1].blob)).toEqual(jpeg(2000, 4));
    expect(await octets(defauts[0].photos![0].blob)).toEqual(jpeg(1500, 9));
    // L'identifiant de l'appareil n'est PAS retire : rien ne doit permettre un nouvel appareil sans decision humaine.
    expect(lireStockageLocal(NOM_CLE_APPAREIL_SYNC, "agent-A")).toBe("device-0");
    expect(await decompteFileLocale()).toMatchObject({ enAttente: 4, enErreur: 0, abandonnees: 0, photosEnFile: 3 });

    // Cycles suivants, y compris avec une inspection (REST, sans appareil) : aucune requete.
    await addPendingInspection(insp("insp-1"));
    appels.length = 0;
    await syncPendingOfflineData();
    await syncPendingOfflineData();
    expect(appels).toEqual([]);
    expect(vus).toHaveLength(1);                                     // l'etat n'a pas change : pas de nouvelle notification

    // Une decision humaine (levee de l'arret) fait repartir la file avec les memes cles d'idempotence.
    serveur.push = () => ({ statut: "SYNCHRONISE" });
    leverArretSynchronisation();
    expect(vus).toHaveLength(2);
    expect(vus[1]).toEqual({ appareilRevoque: false, compteInactif: false, message: null });
    await syncPendingOfflineData();
    expect((await compterFile()).total).toBe(0);
    desabonner();
  });

  it("POST /devices : un 403 APPAREIL_REVOQUE (sans identifiant stocke) arrete aussi, sans push", async () => {
    await ouvrirA(null);
    await addPendingObservation(obs("obs-1"));
    serveur.devices = () => { throw revoque(); };
    await syncPendingOfflineData();
    expect(urls()).toEqual(["/v2/devices"]);
    expect(etatSynchronisation().appareilRevoque).toBe(true);
    expect((await getAllPendingObservations())[0]).toMatchObject({ status: "pending" });
    appels.length = 0;
    await syncPendingOfflineData();
    expect(appels).toEqual([]);
  });

  it("le code est lu, pas le texte : un 403 au texte historique mais SANS code n'est ni un appareil inconnu ni un arret", async () => {
    await ouvrirA();
    await addPendingObservation(obs("obs-1"));
    serveur.push = () => { throw erreurHttp(403, { error: "Appareil inconnu, révoqué ou non autorisé", message: "Appareil inconnu, révoqué ou non autorisé" }); };
    await syncPendingOfflineData();
    expect(urls()).toEqual(["/v2/sync/push"]);                       // aucun re-enregistrement
    expect(etatSynchronisation().message).toBeNull();
    expect((await getAllPendingObservations())[0]).toMatchObject({ status: "error", tentatives: 1 });
  });

  it("un changement de compte leve l'arret : il est celui d'un compte sur un appareil", async () => {
    await ouvrirA();
    await addPendingObservation(obs("obs-1"));
    serveur.push = () => { throw revoque(); };
    await syncPendingOfflineData();
    expect(etatSynchronisation().appareilRevoque).toBe(true);
    configurerUtilisateurSync("agent-B");
    expect(etatSynchronisation()).toEqual({ appareilRevoque: false, compteInactif: false, message: null });
  });
});

describe("403 APPAREIL_INCONNU : un seul re-enregistrement par cycle, jamais de boucle", () => {
  it("inconnu : UN enregistrement (sans identifiant), meme operationId rejoue, puis succes", async () => {
    await ouvrirA();
    await addPendingObservation(obs("obs-1"));
    await addPendingObservation(obs("obs-2", "2026-10-25T08:00:02.000Z"));
    serveur.push = ({ n }) => { if (n === 1) throw inconnu(); return { statut: "SYNCHRONISE" }; };

    await syncPendingOfflineData();

    expect(urls()).toEqual(["/v2/sync/push", "/v2/devices", "/v2/sync/push", "/v2/sync/push"]);
    const corps = pushs().map((p) => p.corps as { appareilId: string; operations: { operationId: string }[] });
    expect(corps.map((c) => c.appareilId)).toEqual(["device-0", "device-neuf", "device-neuf"]);
    expect(corps[0].operations[0].operationId).toBe("obs-1");
    expect(corps[1].operations[0].operationId).toBe("obs-1");        // la meme cle d'idempotence
    expect(JSON.stringify(enregistrements()[0].corps)).not.toContain("appareilId");
    expect(lireStockageLocal(NOM_CLE_APPAREIL_SYNC, "agent-A")).toBe("device-neuf");
    expect(etatSynchronisation().message).toBeNull();
    expect((await compterFile()).total).toBe(0);
  });

  it("inconnu puis REVOQUE : pas de boucle, un seul enregistrement, arret pose, file intacte", async () => {
    await ouvrirA();
    await addPendingObservation(obs("obs-1"));
    await addPendingObservation(obs("obs-2", "2026-10-25T08:00:02.000Z"));
    serveur.push = ({ n }) => { throw n === 1 ? inconnu() : revoque(); };

    await syncPendingOfflineData();

    expect(urls()).toEqual(["/v2/sync/push", "/v2/devices", "/v2/sync/push"]);
    expect(etatSynchronisation().appareilRevoque).toBe(true);
    const o = await getAllPendingObservations();
    expect(o.map((x) => [x.localId, x.status, x.tentatives])).toEqual([["obs-1", "pending", undefined], ["obs-2", "pending", undefined]]);
    appels.length = 0;
    await syncPendingOfflineData();
    expect(appels).toEqual([]);
  });

  it("inconnu puis inconnu dans le meme cycle : le cycle s'arrete sans toucher aucune saisie ; le cycle suivant peut s'enregistrer de nouveau", async () => {
    await ouvrirA();
    await addPendingObservation(obs("obs-1"));
    await addPendingObservation(obs("obs-2", "2026-10-25T08:00:02.000Z"));
    serveur.push = ({ appareilId }) => { if (appareilId !== "device-bon") throw inconnu(); return { statut: "SYNCHRONISE" }; };

    await syncPendingOfflineData();
    expect(urls()).toEqual(["/v2/sync/push", "/v2/devices", "/v2/sync/push"]);   // pas de 3e push, pas de 2e enregistrement
    expect(etatSynchronisation().message).toBeNull();                              // ce n'est pas une revocation
    expect((await getAllPendingObservations()).map((x) => [x.status, x.tentatives])).toEqual([["pending", undefined], ["pending", undefined]]);

    appels.length = 0;
    serveur.devices = () => ({ id: "device-bon" });
    await syncPendingOfflineData();
    expect(urls()).toEqual(["/v2/sync/push", "/v2/devices", "/v2/sync/push", "/v2/sync/push"]);
    expect((await compterFile()).total).toBe(0);
  });
});

// ---- 2. compte inactif, service indisponible -------------------------------------------------------------------------------

describe("401 COMPTE_INACTIF : arret, aucun retry, file conservee", () => {
  it("sync/push : une requete, etat compteInactif, saisies intactes, aucun cycle suivant, reprise apres levee", async () => {
    await ouvrirA();
    await addPendingDefaut(def("def-1"));
    await addPendingObservation(obs("obs-1", "2026-10-25T08:00:01.000Z", 1));
    serveur.push = () => { throw compteInactif(); };
    const vus: EtatSynchronisation[] = [];
    surEtatSynchronisation((e) => vus.push(e));

    await syncPendingOfflineData();

    expect(urls()).toEqual(["/v2/sync/push"]);
    expect(etatSynchronisation()).toEqual({ appareilRevoque: false, compteInactif: true, message: MESSAGE_COMPTE_INACTIF });
    expect(getSyncState()).toMatchObject({ compteInactif: true, appareilRevoque: false, pendingCount: 2 });
    expect(vus).toHaveLength(1);
    for (const s of [...(await getAllPendingDefauts()), ...(await getAllPendingObservations())]) {
      expect(s).toMatchObject({ status: "pending" });
      expect(s.tentatives).toBeUndefined();
    }
    expect(lireStockageLocal(NOM_CLE_APPAREIL_SYNC, "agent-A")).toBe("device-0");
    appels.length = 0;
    await syncPendingOfflineData();
    expect(appels).toEqual([]);

    serveur.push = () => ({ statut: "SYNCHRONISE" });
    leverArretSynchronisation();
    await syncPendingOfflineData();
    expect((await compterFile()).total).toBe(0);
  });

  it("sur une route REST (POST /inspections) : meme arret, l'inspection reste intacte et les autres files ne partent pas", async () => {
    await ouvrirA();
    await addPendingInspection(insp("insp-1"));
    await addPendingObservation(obs("obs-1"));
    serveur.inspection = () => { throw compteInactif(); };
    await syncPendingOfflineData();
    expect(urls()).toEqual(["/inspections"]);
    expect(etatSynchronisation().compteInactif).toBe(true);
    expect((await getAllPending())[0]).toMatchObject({ localId: "insp-1", status: "pending" });
    expect((await getAllPending())[0].tentatives).toBeUndefined();
  });

  it("un 401 SANS code (jeton expire) reste transitoire : pas d'arret, tentative non comptee", async () => {
    await ouvrirA();
    await addPendingObservation(obs("obs-1"));
    serveur.push = () => { throw erreurHttp(401, { error: "Jeton invalide ou expiré", code: "JETON_INVALIDE" }); };
    await syncPendingOfflineData();
    expect(etatSynchronisation().message).toBeNull();
    expect((await getAllPendingObservations())[0]).toMatchObject({ status: "error" });
    expect((await getAllPendingObservations())[0].tentatives ?? 0).toBe(0);
  });
});

describe("503 SERVICE_INDISPONIBLE et reseau coupe : reessai plus tard, rien de perdu, aucun arret", () => {
  it.each([
    ["503 SERVICE_INDISPONIBLE", () => erreurHttp(503, { error: "Service indisponible", code: "SERVICE_INDISPONIBLE" })],
    ["reseau coupe", erreurReseau],
  ])("%s : plus de cinq cycles sans abandon ni tentative comptee ni arret, puis la saisie passe", async (_nom, fabrique) => {
    await ouvrirA();
    await addPendingObservation(obs("obs-1", "2026-10-25T08:00:01.000Z", 1));
    await addPendingPortion(por("por-1"));
    serveur.push = () => { throw fabrique(); };
    for (let i = 0; i < 7; i += 1) await syncPendingOfflineData();
    expect(etatSynchronisation().message).toBeNull();
    for (const s of [...(await getAllPendingObservations()), ...(await getAllPendingPortions())]) {
      expect(s.status).toBe("error");                                 // retentable, jamais abandonnee
      expect(s.tentatives ?? 0).toBe(0);
    }
    expect((await getAllPendingObservations())[0].photos).toHaveLength(1);
    expect(getSyncState()).toMatchObject({ abandonCount: 0, refusDroitsCount: 0, pendingCount: 2 });

    serveur.push = () => ({ statut: "SYNCHRONISE" });
    await syncPendingOfflineData();
    expect((await compterFile()).total).toBe(0);
  });
});

// ---- 3. droits modifies : quarantaine --------------------------------------------------------------------------------------

describe("DROITS_MODIFIES : quarantaine `refus_droits`, non rejouee, comptee, relancable", () => {
  const CAUSES = ["HORS_PERIMETRE", "REGION_INCONNUE", "MODULE_RETIRE"] as const;

  async function deposerEtRefuser(cause: string): Promise<void> {
    await ouvrirA();
    await addPendingDefaut(def("def-1"));
    await addPendingPortion(por("por-1"));
    await addPendingObservation(obs("obs-1", "2026-10-25T08:00:01.000Z", 2));
    await addPendingObservation(obs("obs-2", "2026-10-25T08:00:02.000Z"));
    serveur.push = ({ op }) => (op.entityId === "obs-2" ? { statut: "SYNCHRONISE" } : refusDroits(cause));
    await syncPendingOfflineData();
  }

  it.each(CAUSES)("cause %s : statut, cause et message memorises, donnees et photos octet pour octet, aucune erreur comptee ; les autres saisies du lot partent", async (cause) => {
    await deposerEtRefuser(cause);

    const [d] = await getAllPendingDefauts();
    const [p] = await getAllPendingPortions();
    const o = await getAllPendingObservations();
    expect(o.map((x) => x.localId)).toEqual(["obs-1"]);               // obs-2 est partie : un refus ne perturbe pas les autres
    for (const s of [d, p, o[0]]) {
      expect(s).toMatchObject({ status: "refus_droits", causeRefusDroits: cause, errorMessage: MESSAGES_REFUS_DROITS[cause] });
      expect(s.tentatives).toBeUndefined();
    }
    expect(o[0].payload.description).toBe("DESC-obs-1");
    expect(await octets(o[0].photos![0].blob)).toEqual(jpeg(1800, 3));
    expect(await octets(o[0].photos![1].blob)).toEqual(jpeg(2000, 4));
    expect(await octets(d.photos![0].blob)).toEqual(jpeg(1500, 9));
    expect(photosRecues).toEqual([]);                                  // rien n'est envoye pour une saisie refusee

    // Compte a part, dans le total, et dans le decompte qui refuse la suppression locale.
    expect(await compterFile()).toMatchObject({ total: 3, refusDroits: 3, abandonnees: 0, enErreur: 0, photosEnFile: 3 });
    expect(getSyncState()).toMatchObject({ pendingCount: 3, refusDroitsCount: 3, abandonCount: 0, conflitCount: 0 });
    const decompte = await decompteFileLocale();
    // Rubrique propre : plus de double compte dans `abandonnees`.
    expect(decompte).toMatchObject({ refusDroits: 3, abandonnees: 0, photosEnFile: 3 });
    const decision = decisionSuppressionLocale(decompte);
    expect(decision.refusee).toBe(true);
    expect(decision.raisons).toContain("SAISIES_REFUS_DROITS");
    expect(decision.raisons).not.toContain("SAISIES_ABANDONNEES");
    expect(decision.nbSaisies).toBe(3);

    // Pas rejouee au cycle suivant, ni a aucun autre.
    appels.length = 0;
    await syncPendingOfflineData();
    await syncPendingOfflineData();
    expect(appels).toEqual([]);
    expect(etatSynchronisation().message).toBeNull();
  });

  it("le badge garde la quarantaine meme coffre verrouille (comptee sans cle)", async () => {
    await deposerEtRefuser("HORS_PERIMETRE");
    coffre.verrouiller();
    await refreshPendingCount();
    expect(getSyncState()).toMatchObject({ pendingCount: 3, refusDroitsCount: 3 });
    expect(await decompteFileLocale()).toMatchObject({ abandonnees: 0, refusDroits: 3 });
  });

  it("MISSION_NON_AUTORISEE (motif historique, sans cause) est de la meme famille", async () => {
    await ouvrirA();
    await addPendingObservation(obs("obs-1"));
    serveur.push = () => ({ statut: "REJETE", motif: "MISSION_NON_AUTORISEE" });
    await syncPendingOfflineData();
    expect((await getAllPendingObservations())[0]).toMatchObject({
      status: "refus_droits", causeRefusDroits: "MISSION_NON_AUTORISEE", errorMessage: MESSAGES_REFUS_DROITS.MISSION_NON_AUTORISEE,
    });
    appels.length = 0;
    await syncPendingOfflineData();
    expect(appels).toEqual([]);
  });

  it("une cause inconnue d'un serveur plus recent reste un refus de droits", async () => {
    await ouvrirA();
    await addPendingPortion(por("por-1"));
    serveur.push = () => refusDroits("CAUSE_FUTURE");
    await syncPendingOfflineData();
    expect((await getAllPendingPortions())[0]).toMatchObject({ status: "refus_droits", causeRefusDroits: "NON_PRECISEE" });
  });

  it("un refus de DONNEE garde le comportement existant : abandonnee, pas de quarantaine", async () => {
    await ouvrirA();
    await addPendingObservation(obs("obs-1"));
    await addPendingPortion(por("por-1"));
    serveur.push = () => ({ statut: "REJETE", motif: "PAYLOAD_INVALIDE:Observation" });
    await syncPendingOfflineData();
    expect((await getAllPendingObservations())[0]).toMatchObject({ status: "abandonnee", refusDefinitif: true });
    expect((await getAllPendingPortions())[0]).toMatchObject({ status: "abandonnee", refusDefinitif: true });
    expect((await compterFile())).toMatchObject({ abandonnees: 2, refusDroits: 0 });
  });

  describe("renvoi explicite", () => {
    it("droits rendus : le serveur applique, avec la meme cle operationId ; les photos partent octet pour octet ; les autres restent en quarantaine", async () => {
      await deposerEtRefuser("HORS_PERIMETRE");
      appels.length = 0;
      serveur.push = ({ op }) => ({ statut: "SYNCHRONISE", entityId: op.entityId });

      expect(await relancerRefusDroits("obs-1", "observations")).toBe("ENVOYEE");

      expect(pushs()).toHaveLength(1);
      expect((pushs()[0].corps as { operations: { operationId: string }[] }).operations[0].operationId).toBe("obs-1");
      expect(photosRecues.map((x) => x.nom)).toEqual(["obs-1-0.jpg", "obs-1-1.jpg"]);
      expect(photosRecues[0].octets).toEqual(jpeg(1800, 3));
      expect(photosRecues[1].octets).toEqual(jpeg(2000, 4));
      expect(await getAllPendingObservations()).toEqual([]);
      expect(await compterFile()).toMatchObject({ total: 2, refusDroits: 2 });   // def-1 et por-1 : on ne relance QUE ce que l'agent demande
      expect(getSyncState()).toMatchObject({ pendingCount: 2, refusDroitsCount: 2, syncing: false });

      expect(await relancerRefusDroits("def-1", "defauts")).toBe("ENVOYEE");
      expect(await relancerRefusDroits("por-1", "portions")).toBe("ENVOYEE");
      expect((await compterFile()).total).toBe(0);
    });

    it("qui re-echoue : la saisie reste en quarantaine (cause et message a jour), donnees et photos intactes, toujours pas rejouee seule", async () => {
      await deposerEtRefuser("HORS_PERIMETRE");
      appels.length = 0;
      serveur.push = () => refusDroits("MODULE_RETIRE");

      expect(await relancerRefusDroits("obs-1", "observations")).toBe("TOUJOURS_REFUSEE");
      expect(await relancerRefusDroits("def-1", "defauts")).toBe("TOUJOURS_REFUSEE");
      expect(await relancerRefusDroits("por-1", "portions")).toBe("TOUJOURS_REFUSEE");

      const o = (await getPendingObservation("obs-1"))!;
      expect(o).toMatchObject({ status: "refus_droits", causeRefusDroits: "MODULE_RETIRE", errorMessage: MESSAGES_REFUS_DROITS.MODULE_RETIRE });
      expect(o.tentatives ?? 0).toBe(0);
      expect(await octets(o.photos![0].blob)).toEqual(jpeg(1800, 3));
      expect(await octets(o.photos![1].blob)).toEqual(jpeg(2000, 4));
      expect(await compterFile()).toMatchObject({ total: 3, refusDroits: 3 });
      appels.length = 0;
      await syncPendingOfflineData();
      expect(appels).toEqual([]);
    });

    it("hors ligne : rien ne part, la saisie reste en quarantaine", async () => {
      await deposerEtRefuser("HORS_PERIMETRE");
      appels.length = 0;
      vi.stubGlobal("navigator", { onLine: false, userAgent: "essai" });
      expect(await relancerRefusDroits("obs-1", "observations")).toBe("HORS_LIGNE");
      expect(appels).toEqual([]);
      expect((await getPendingObservation("obs-1"))!.status).toBe("refus_droits");
    });

    it("une saisie qui n'est pas en quarantaine, ou inconnue : rien n'est envoye", async () => {
      await ouvrirA();
      await addPendingObservation(obs("obs-1"));
      expect(await relancerRefusDroits("obs-1", "observations")).toBe("NON_EN_QUARANTAINE");
      expect(await relancerRefusDroits("absente", "observations")).toBe("NON_EN_QUARANTAINE");
      expect(appels).toEqual([]);
      expect((await getPendingObservation("obs-1"))!.status).toBe("pending");
    });

    it("erreur passagere pendant le renvoi : la saisie redevient ordinaire (EN_FILE) et la synchronisation normale la reprend", async () => {
      await deposerEtRefuser("HORS_PERIMETRE");
      serveur.push = () => { throw erreurHttp(503, { error: "Service indisponible", code: "SERVICE_INDISPONIBLE" }); };
      expect(await relancerRefusDroits("obs-1", "observations")).toBe("EN_FILE");
      expect(await getPendingObservation("obs-1")).toMatchObject({ status: "error" });
      serveur.push = () => ({ statut: "SYNCHRONISE" });
      await syncPendingOfflineData();
      expect(await getPendingObservation("obs-1")).toBeNull();
    });

    it("appareil retire pendant le renvoi : ARRET, la saisie retourne en quarantaine, et plus rien ne part", async () => {
      await deposerEtRefuser("HORS_PERIMETRE");
      appels.length = 0;
      serveur.push = () => { throw revoque(); };
      expect(await relancerRefusDroits("obs-1", "observations")).toBe("ARRET");
      expect(await getPendingObservation("obs-1")).toMatchObject({ status: "refus_droits", causeRefusDroits: "HORS_PERIMETRE" });
      expect(etatSynchronisation().appareilRevoque).toBe(true);
      appels.length = 0;
      expect(await relancerRefusDroits("def-1", "defauts")).toBe("ARRET");
      expect(appels).toEqual([]);
    });
  });
});

// ---- 4. non-regression : idempotence et conflits ---------------------------------------------------------------------------

describe("idempotence et conflits inchanges", () => {
  it("REJOUEE : la saisie quitte la file, comme SYNCHRONISE ; l'operationId est le localId", async () => {
    await ouvrirA();
    await addPendingObservation(obs("obs-1"));
    await addPendingPortion(por("por-1"));
    serveur.push = () => ({ statut: "REJOUEE" });
    await syncPendingOfflineData();
    expect((await compterFile()).total).toBe(0);
    expect(pushs().map((p) => (p.corps as { operations: { operationId: string }[] }).operations[0].operationId).sort()).toEqual(["obs-1", "por-1"]);
  });

  it("CONFLIT : la saisie reste en file, statut conflit avec son identifiant, comptee a part et pas en quarantaine", async () => {
    await ouvrirA();
    await addPendingObservation(obs("obs-1"));
    serveur.push = () => ({ statut: "CONFLIT", motif: "DEJA_EXISTANTE", conflitId: "c-1" });
    await syncPendingOfflineData();
    expect((await getAllPendingObservations())[0]).toMatchObject({ status: "conflit", conflitId: "c-1" });
    expect(getSyncState()).toMatchObject({ conflitCount: 1, refusDroitsCount: 0, abandonCount: 0 });
    expect(await compterFile()).toMatchObject({ enConflit: 1, refusDroits: 0 });
  });

  it("une reponse perdue puis un rejeu : une seule saisie sur le serveur (meme operationId), file videe", async () => {
    await ouvrirA();
    await addPendingObservation(obs("obs-1"));
    const vues = new Set<string>();
    serveur.push = ({ op, n }) => {
      const deja = vues.has(op.operationId);
      vues.add(op.operationId);
      if (n === 1) throw erreurReseau();                              // le serveur a ecrit, la reponse est perdue
      return { statut: deja ? "REJOUEE" : "SYNCHRONISE" };
    };
    await syncPendingOfflineData();
    expect((await getAllPendingObservations())[0].status).toBe("error");
    await syncPendingOfflineData();
    expect([...vues]).toEqual(["obs-1"]);
    expect((await compterFile()).total).toBe(0);
  });
});
