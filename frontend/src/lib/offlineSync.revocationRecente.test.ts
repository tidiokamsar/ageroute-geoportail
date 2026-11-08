// @vitest-environment node
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { AxiosError } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { creerCoffre, stockageEnMemoire, sha256WebCrypto, type CoffreSession } from "../session/coffreSession";
import { empreinteCompte } from "../session/compteLocal";

/**
 * Chantier D8c : le CLIENT de synchronisation tient la meme conduite que l'ecran de roulage face au 403
 * `APPAREIL_REVOCATION_RECENTE` de `POST /v2/devices` (docs/securite/SESSION-HORS-LIGNE-SERVEUR.md 10.2) :
 *
 *   - AUCUN nouvel appareil n'est enregistre automatiquement avant le delai `reessayerDansMs` ; pas de boucle (une requete par delai) ;
 *   - les saisies sont CONSERVEES telles quelles (ni statut `error`, ni tentative comptee, donc jamais `abandonnee` par ce motif) ;
 *   - ce N'EST PAS un appareil revoque : l'etat `appareilRevoque` n'est jamais pose, la synchronisation n'est pas « arretee » ;
 *   - reessai automatique a l'echeance seulement (borne), ou immediat sur geste de l'agent (`synchroniserManuellement`).
 *
 * Le vrai `offlineSync.ts`, la vraie file chiffree (vrai coffre, fake-indexeddb) ; seul le reseau est simule, comme dans
 * `offlineSync.droits.test.ts`. Le temps (`Date`, `setTimeout`) est simule : l'attente n'est jamais reelle.
 */

interface Appel { url: string; corps: unknown }
const appels: Appel[] = [];
const serveur = {
  nDevices: 0,
  devices: (_n: number): unknown => ({ id: "device-neuf" }),
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
        const c = corps as { operations: { operationId: string; entityId: string }[] };
        const op = c.operations[0];
        return { data: { resultats: [{ operationId: op.operationId, entityId: op.entityId, statut: "SYNCHRONISE" }] } };
      }
      if (url === "/inspections") return { data: { id: "srv-insp" } };
      return { data: {} };
    }),
  },
}));

import { fermerCompte, lireStockageLocal, NOM_CLE_APPAREIL_SYNC, ouvrirCompte, ecrireStockageLocal } from "./compteCourant";
import {
  addPendingDefaut, addPendingInspection, addPendingObservation, addPendingPortion, compterFile, getAllPendingDefauts,
  getAllPendingObservations, getAllPendingPortions, getPendingDefaut, updatePendingDefaut,
} from "./offlineDb";
import {
  configurerUtilisateurSync, etatEnregistrementAppareil, etatSynchronisation, getSyncState, leverArretSynchronisation,
  MESSAGE_REVOCATION_RECENTE, relancerRefusDroits, surEtatSynchronisation, synchroniserManuellement, syncPendingOfflineData,
  type EtatSynchronisation,
} from "./offlineSync";

// ---- aides -----------------------------------------------------------------------------------------------------------------

function erreurHttp(statut: number, donnees: Record<string, unknown>): AxiosError {
  return new AxiosError("Request failed", "ERR_BAD_REQUEST", undefined, undefined, {
    status: statut, statusText: "", data: donnees, headers: {}, config: {} as never,
  });
}
const revocationRecente = (reessayerDansMs?: unknown) => erreurHttp(403, {
  code: "APPAREIL_REVOCATION_RECENTE",
  message: "Un appareil de ce compte vient d'être révoqué : l'enregistrement d'un nouvel appareil est suspendu quelques minutes.",
  ...(reessayerDansMs === undefined ? {} : { reessayerDansMs }),
});

function fauxLocalStorage() {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, key: (i: number) => [...m.keys()][i] ?? null, getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(),
  };
}

let coffre: CoffreSession;
async function ouvrirA(): Promise<void> {
  coffre = await creerCoffre({
    stockage: stockageEnMemoire(), compteId: "agent-A", appareilId: "tel-1", pin: "246810", maintenantMs: Date.now(), iterations: 1000, iterationsDeTest: true,
    profil: { userId: "agent-A", nom: "A", role: "INSPECTEUR", modules: [], regions: [] },
  });
  ouvrirCompte({ compteId: "agent-A", empreinte: await empreinteCompte("agent-A", sha256WebCrypto), chiffreur: coffre });
  configurerUtilisateurSync("agent-A");
}

const base = { ownerUserId: "agent-A", status: "pending" as const };
const photo = (nom: string) => ({ name: nom, blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], { type: "image/jpeg" }), capturedA: "2026-10-25T08:00:30.000Z" });
const obs = (localId: string, createdAt = "2026-10-25T08:00:00.000Z") => ({
  ...base, localId, createdAt, payload: { type: "DEGRADATION" as const, description: `DESC-${localId}`, observeA: createdAt }, photos: [photo(`${localId}.jpg`)],
});
const def = (localId: string) => ({
  ...base, localId, createdAt: "2026-10-25T08:01:00.000Z",
  payload: { catalogueCode: "NID_POULE", constateA: "2026-10-25T08:01:00.000Z", gravite: 3 }, photos: [photo(`${localId}.jpg`)],
});
const por = (localId: string) => ({ ...base, localId, createdAt: "2026-10-25T08:02:00.000Z", payload: { tronconId: "t-1", debutM: 0, finM: 40 } });
const insp = (localId: string) => ({
  ...base, localId, createdAt: "2026-10-25T08:00:00.000Z", payload: { tronconId: "t-1", dateInspection: "2026-10-25", etatObserve: "MAUVAIS" }, photos: [],
});

const urls = () => appels.map((a) => a.url);
const enregistrements = () => appels.filter((a) => a.url === "/v2/devices");
const pushs = () => appels.filter((a) => a.url === "/v2/sync/push");
const T0 = Date.parse("2026-10-25T09:00:00.000Z");
const MIN = 60_000;

/** Laisse la file d'evenements se vider (IndexedDB simule, chaines de promesses) sans faire avancer le temps simule. */
async function laisserPasser(tours = 60): Promise<void> {
  for (let i = 0; i < tours; i += 1) await new Promise<void>((r) => setImmediate(r));
}
/** Attend (en temps REEL, pas simule) qu'une condition devienne vraie. */
async function attendre(condition: () => boolean, tours = 400): Promise<void> {
  for (let i = 0; i < tours && !condition(); i += 1) await new Promise<void>((r) => setImmediate(r));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(T0);
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("localStorage", fauxLocalStorage());
  vi.stubGlobal("navigator", { onLine: true, userAgent: "essai" });
  appels.length = 0;
  serveur.nDevices = 0;
  serveur.devices = () => { throw revocationRecente(10 * MIN); };
  fermerCompte();
  configurerUtilisateurSync(null);
  leverArretSynchronisation();
});
afterEach(() => {
  configurerUtilisateurSync(null); // annule le minuteur de reessai eventuel
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fermerCompte();
});

// ---- 1. la conduite ---------------------------------------------------------------------------------------------------------

describe("403 APPAREIL_REVOCATION_RECENTE : l'enregistrement est suspendu, la file reste intacte", () => {
  it("une seule demande d'appareil, aucun push, saisies et photos intactes, pas d'appareil revoque, etat et message exposes", async () => {
    await ouvrirA();
    await addPendingDefaut(def("def-1"));
    await addPendingPortion(por("por-1"));
    await addPendingObservation(obs("obs-1"));
    const vus: EtatSynchronisation[] = [];
    surEtatSynchronisation((e) => vus.push(e));

    await syncPendingOfflineData();

    expect(urls()).toEqual(["/v2/devices"]);                          // une demande, refusee ; aucun push, rien d'autre
    expect(lireStockageLocal(NOM_CLE_APPAREIL_SYNC, "agent-A")).toBeNull();
    // Ce n'est PAS un appareil retire : l'etat d'arret n'est pas pose et personne n'en est prevenu.
    expect(etatSynchronisation()).toEqual({ appareilRevoque: false, compteInactif: false, message: null });
    expect(vus).toEqual([]);
    expect(getSyncState()).toMatchObject({ appareilRevoque: false, compteInactif: false, enregistrementSuspendu: true, syncing: false, pendingCount: 3 });
    expect(etatEnregistrementAppareil()).toEqual({ suspendu: true, reessayerLeMs: T0 + 10 * MIN, message: MESSAGE_REVOCATION_RECENTE });
    expect(MESSAGE_REVOCATION_RECENTE).toBe("Un de vos appareils vient d'être retiré. Patientez quelques minutes avant d'enregistrer ce téléphone, ou contactez votre responsable.");

    // Ni statut `error`, ni tentative comptee, ni message : les saisies sont telles qu'elles etaient, photos comprises.
    for (const s of [...await getAllPendingDefauts(), ...await getAllPendingPortions(), ...await getAllPendingObservations()]) {
      expect(s.status).toBe("pending");
      expect(s.tentatives).toBeUndefined();
      expect(s.errorMessage).toBeUndefined();
    }
    expect((await getAllPendingDefauts())[0].photos).toHaveLength(1);
    expect((await getAllPendingObservations())[0].photos).toHaveLength(1);
    expect(await compterFile()).toMatchObject({ enAttente: 3, enErreur: 0, abandonnees: 0, photosEnFile: 2 });
  });

  it("une inspection (sans appareil) part normalement ; seules les files qui exigent un appareil neuf attendent", async () => {
    await ouvrirA();
    await addPendingInspection(insp("insp-1"));
    await addPendingObservation(obs("obs-1"));

    await syncPendingOfflineData();

    expect(urls()).toEqual(["/inspections", "/v2/devices"]);
    expect((await compterFile()).total).toBe(1);                      // l'inspection est partie, l'observation attend
    expect((await getAllPendingObservations())[0]).toMatchObject({ status: "pending" });
  });

  it("des cycles AUTOMATIQUES pendant le delai ne font aucune requete ; a l'echeance, UN seul reessai, jamais avant", async () => {
    await ouvrirA();
    await addPendingObservation(obs("obs-1"));
    await syncPendingOfflineData();
    expect(enregistrements()).toHaveLength(1);
    appels.length = 0;

    // Retours du reseau, onglet visible, saisie enregistree... : autant de cycles automatiques, aucune requete.
    for (let i = 0; i < 5; i += 1) await syncPendingOfflineData();
    await vi.advanceTimersByTimeAsync(10 * MIN - 1);
    await laisserPasser();
    await syncPendingOfflineData();
    expect(appels).toEqual([]);                                       // 599 999 ms apres : rien

    // L'echeance : le minuteur relance UN cycle, qui redemande UN appareil (le serveur refuse encore : nouveau delai).
    await vi.advanceTimersByTimeAsync(1);
    await attendre(() => enregistrements().length >= 1);
    await laisserPasser();
    expect(enregistrements()).toHaveLength(1);
    expect(etatEnregistrementAppareil()).toMatchObject({ suspendu: true, reessayerLeMs: T0 + 20 * MIN });

    // Pas de boucle serree : le temps ne passe pas, plus rien ne part ; le delai suivant, une requete de plus et pas davantage.
    for (let i = 0; i < 3; i += 1) await syncPendingOfflineData();
    expect(enregistrements()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    await attendre(() => enregistrements().length >= 2);
    await laisserPasser();
    expect(enregistrements()).toHaveLength(2);
    expect(pushs()).toHaveLength(0);
    expect(urls().every((u) => u === "/v2/devices")).toBe(true);
  });

  it("a l'echeance, si le serveur accepte : l'appareil est enregistre, la file part, la suspension tombe", async () => {
    await ouvrirA();
    await addPendingDefaut(def("def-1"));
    await addPendingObservation(obs("obs-1"));
    await syncPendingOfflineData();
    expect(getSyncState().enregistrementSuspendu).toBe(true);
    serveur.devices = () => ({ id: "device-neuf" });
    appels.length = 0;

    await vi.advanceTimersByTimeAsync(10 * MIN);
    await attendre(() => pushs().length >= 2);
    await laisserPasser();

    expect(enregistrements()).toHaveLength(1);
    expect(pushs()).toHaveLength(2);
    expect(lireStockageLocal(NOM_CLE_APPAREIL_SYNC, "agent-A")).toBe("device-neuf");
    expect(etatEnregistrementAppareil()).toEqual({ suspendu: false, reessayerLeMs: null, message: null });
    expect(getSyncState().enregistrementSuspendu).toBe(false);
    expect((await compterFile()).total).toBe(0);
  });

  it("une echeance depassee sans que le minuteur ait tourne (onglet en veille) est constatee au cycle suivant", async () => {
    await ouvrirA();
    await addPendingObservation(obs("obs-1"));
    await syncPendingOfflineData();
    appels.length = 0;
    serveur.devices = () => ({ id: "device-neuf" });

    vi.setSystemTime(T0 + 10 * MIN + 1);                              // l'horloge a passe l'echeance, le minuteur n'a pas encore tire
    await syncPendingOfflineData();

    expect(enregistrements()).toHaveLength(1);
    expect(pushs()).toHaveLength(1);
    expect(etatEnregistrementAppareil().suspendu).toBe(false);
  });
});

// ---- 2. le geste de l'agent ---------------------------------------------------------------------------------------------------

describe("geste de l'agent : reessai immediat, delai ou non", () => {
  it("synchroniserManuellement reessaie tout de suite ; accepte, la file part, la suspension et son minuteur tombent", async () => {
    await ouvrirA();
    await addPendingObservation(obs("obs-1"));
    await syncPendingOfflineData();
    appels.length = 0;
    serveur.devices = () => ({ id: "device-neuf" });

    await synchroniserManuellement();                                  // 0 ms apres le refus : bien avant les 10 minutes

    expect(urls()).toEqual(["/v2/devices", "/v2/sync/push", "/v2/observations/obs-1/photos"]);   // appareil, saisie, puis sa photo
    expect(etatEnregistrementAppareil().suspendu).toBe(false);
    expect((await compterFile()).total).toBe(0);
    appels.length = 0;
    await vi.advanceTimersByTimeAsync(60 * MIN);                       // le minuteur de l'ancienne suspension ne relance plus rien
    await laisserPasser();
    expect(appels).toEqual([]);
  });

  it("refuse de nouveau : UNE requete, un nouveau delai, saisies intactes, jamais abandonnees meme apres de nombreux gestes", async () => {
    await ouvrirA();
    await addPendingObservation(obs("obs-1"));
    await syncPendingOfflineData();
    appels.length = 0;
    serveur.devices = () => { throw revocationRecente(5 * MIN); };

    for (let i = 0; i < 8; i += 1) await synchroniserManuellement();   // plus que le plafond de tentatives (5)

    expect(urls()).toEqual(Array(8).fill("/v2/devices"));              // un geste = une requete, jamais deux
    expect(etatEnregistrementAppareil()).toMatchObject({ suspendu: true, reessayerLeMs: T0 + 5 * MIN });
    expect((await getAllPendingObservations())[0]).toMatchObject({ status: "pending" });
    expect((await getAllPendingObservations())[0].tentatives).toBeUndefined();
  });

  it("un geste est un cycle, pas un etat : le cycle automatique suivant redevient retenu par le delai", async () => {
    await ouvrirA();
    await addPendingObservation(obs("obs-1"));
    await syncPendingOfflineData();
    await synchroniserManuellement();
    appels.length = 0;

    await syncPendingOfflineData();

    expect(appels).toEqual([]);
  });

  it("le renvoi explicite d'une saisie en quarantaine est un geste : une demande, refusee, la saisie retourne en quarantaine (ARRET)", async () => {
    await ouvrirA();
    await addPendingDefaut(def("def-1"));
    const d = (await getAllPendingDefauts())[0];
    await updatePendingDefaut({ ...d, status: "refus_droits", causeRefusDroits: "HORS_PERIMETRE", errorMessage: "hors perimetre" });
    appels.length = 0;

    const issue = await relancerRefusDroits("def-1", "defauts");

    expect(issue).toBe("ARRET");
    expect(urls()).toEqual(["/v2/devices"]);
    expect(await getPendingDefaut("def-1")).toMatchObject({ status: "refus_droits", causeRefusDroits: "HORS_PERIMETRE", errorMessage: "hors perimetre" });
    expect(etatSynchronisation().appareilRevoque).toBe(false);
  });
});

// ---- 3. le delai : borne ------------------------------------------------------------------------------------------------------

describe("le delai de reessai est lu dans la reponse, puis borne", () => {
  it.each([
    ["delai court (1 s) : pas avant 5 s", 1_000, 5_000],
    ["delai de 12 minutes : exactement ce delai", 12 * MIN, 12 * MIN],
    ["delai absurde (10 h) : plafonne a 30 minutes", 10 * 60 * MIN, 30 * MIN],
    ["delai absent : 5 minutes", undefined, 5 * MIN],
    ["delai nul : 5 minutes", 0, 5 * MIN],
    ["delai negatif : 5 minutes", -3_000, 5 * MIN],
    ["delai texte : 5 minutes", "bientot", 5 * MIN],
  ])("%s", async (_nom, dit, attendu) => {
    await ouvrirA();
    await addPendingObservation(obs("obs-1"));
    serveur.devices = () => { throw revocationRecente(dit); };

    await syncPendingOfflineData();

    expect(etatEnregistrementAppareil()).toMatchObject({ suspendu: true, reessayerLeMs: T0 + (attendu as number) });
    appels.length = 0;
    await vi.advanceTimersByTimeAsync((attendu as number) - 1);
    await laisserPasser();
    expect(appels).toEqual([]);                                        // jamais avant
    await vi.advanceTimersByTimeAsync(1);
    await attendre(() => enregistrements().length >= 1);
    expect(enregistrements()).toHaveLength(1);                         // et a l'echeance
  });
});

// ---- 4. portee de la suspension ----------------------------------------------------------------------------------------------

describe("portee de la suspension", () => {
  it("un changement de compte la leve, avec son minuteur : elle est celle d'un compte", async () => {
    await ouvrirA();
    await addPendingObservation(obs("obs-1"));
    await syncPendingOfflineData();
    expect(etatEnregistrementAppareil().suspendu).toBe(true);
    appels.length = 0;

    configurerUtilisateurSync("agent-B");

    expect(etatEnregistrementAppareil()).toEqual({ suspendu: false, reessayerLeMs: null, message: null });
    expect(getSyncState().enregistrementSuspendu).toBe(false);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    await laisserPasser();
    expect(appels).toEqual([]);
  });

  it("un appareil deja enregistre n'est pas concerne : aucune demande d'appareil, la file part", async () => {
    await ouvrirA();
    ecrireStockageLocal(NOM_CLE_APPAREIL_SYNC, "device-0", "agent-A");
    await addPendingObservation(obs("obs-1"));

    await syncPendingOfflineData();

    expect(enregistrements()).toHaveLength(0);
    expect(pushs()).toHaveLength(1);
    expect(etatEnregistrementAppareil().suspendu).toBe(false);
  });

  it("un autre 403 de /devices (sans ce code) n'est PAS une suspension : il suit le traitement des autres erreurs", async () => {
    await ouvrirA();
    await addPendingObservation(obs("obs-1"));
    serveur.devices = () => { throw erreurHttp(403, { error: "Plafond d'appareils atteint" }); };

    await syncPendingOfflineData();

    expect(etatEnregistrementAppareil().suspendu).toBe(false);
    expect((await getAllPendingObservations())[0]).toMatchObject({ status: "error", tentatives: 1 });
  });
});
