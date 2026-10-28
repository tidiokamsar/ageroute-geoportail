// @vitest-environment node
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { creerCoffre, stockageEnMemoire, sha256WebCrypto, type CoffreSession } from "../session/coffreSession";
import { empreinteCompte, nomBaseOffline } from "../session/compteLocal";

/**
 * Synchronisation CONTRE LA VRAIE FILE CHIFFREE (vrai coffre, vrai moteur IndexedDB), seul le reseau est simule.
 * Les autres fichiers offlineSync*.test.ts simulent offlineDb : ils prouvent la logique de reprise, pas le chiffrement.
 * Ici : le serveur ne recoit jamais de chiffre ; les statuts sont ecrits et relus chiffres ; coffre verrouille ou compte
 * absent = rien n'est envoye, rien n'est perdu, aucune erreur ; un enregistrement altere n'arrete pas la file ; les photos
 * ne sont pas toutes dechiffrees d'un coup.
 */

interface Appel { url: string; corps: unknown }
const appels: Appel[] = [];
const photosRecues: { url: string; nom: string; octets: Uint8Array; type: string }[] = [];
const etat = { echouerPush: 0, echouerPhotoNo: 0, photosPostees: 0, dechiffreesAvantPremierePhoto: -1 };
let compteurDechiffrement = { n: 0 };

vi.mock("./api", () => ({
  api: {
    post: vi.fn(async (url: string, corps: unknown) => {
      appels.push({ url, corps });
      if (url === "/v2/devices") return { data: { id: "device-1" } };
      if (url === "/v2/sync/push") {
        if (etat.echouerPush > 0) { etat.echouerPush -= 1; throw new Error("reseau indisponible"); }
        const op = (corps as { operations: { entityId: string }[] }).operations[0];
        return { data: { resultats: [{ statut: "SYNCHRONISE", entityId: op.entityId }] } };
      }
      if (url === "/inspections") return { data: { id: `srv-${appels.filter((a) => a.url === "/inspections").length}` } };
      // Une photo (FormData).
      etat.photosPostees += 1;
      if (etat.dechiffreesAvantPremierePhoto < 0) etat.dechiffreesAvantPremierePhoto = compteurDechiffrement.n;
      if (etat.echouerPhotoNo > 0 && etat.photosPostees === etat.echouerPhotoNo) throw new Error("coupure pendant la photo");
      const f = (corps as FormData).get("photo") as File;
      photosRecues.push({ url, nom: f.name, octets: new Uint8Array(await f.arrayBuffer()), type: f.type });
      return { data: {} };
    }),
  },
}));

import { fermerCompte, ouvrirCompte } from "./compteCourant";
import {
  addPendingDefaut, addPendingInspection, addPendingObservation, addPendingPortion, compterFile, getAllPending, getAllPendingDefauts,
  getAllPendingObservations, getAllPendingPortions,
} from "./offlineDb";
import { configurerUtilisateurSync, decompteFileLocale, getSyncState, refreshPendingCount, syncPendingOfflineData } from "./offlineSync";

const SECRET = "DESCRIPTION-CONFIDENTIELLE-RT55";
function jpeg(n: number, graine: number): Uint8Array<ArrayBuffer> {
  const o = new Uint8Array(new ArrayBuffer(n));
  o.set([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  let x = graine;
  for (let i = 10; i < n; i += 1) { x = (x * 1103515245 + 12345) & 0x7fffffff; o[i] = x & 0xff; }
  return o;
}
const photo = (nom: string, n: number, graine: number) => ({ name: nom, blob: new Blob([jpeg(n, graine)], { type: "image/jpeg" }) });

function fauxLocalStorage() {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, key: (i: number) => [...m.keys()][i] ?? null, getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(),
  };
}

let coffre: CoffreSession;
let empreinte = "";
async function ouvrirA(): Promise<void> {
  coffre = await creerCoffre({
    stockage: stockageEnMemoire(), compteId: "agent-A", appareilId: "tel-1", pin: "246810", maintenantMs: Date.now(), iterations: 1000, iterationsDeTest: true,
    profil: { userId: "agent-A", nom: "A", role: "INSPECTEUR", modules: [], regions: [] },
  });
  empreinte = await empreinteCompte("agent-A", sha256WebCrypto);
  ouvrirCompte({ compteId: "agent-A", empreinte, chiffreur: coffre });
  configurerUtilisateurSync("agent-A");
  const vrai = coffre.dechiffrerBlob.bind(coffre);
  compteurDechiffrement = { n: 0 };
  vi.spyOn(coffre, "dechiffrerBlob").mockImplementation(async (p, id, v) => { compteurDechiffrement.n += 1; return vrai(p, id, v); });
}

const insp = (localId: string, photos = 2) => ({
  localId, ownerUserId: "agent-A", createdAt: "2026-10-25T08:00:00.000Z", status: "pending" as const,
  payload: { tronconId: "t-1", dateInspection: "2026-10-25", etatObserve: "MAUVAIS", defautsConstates: SECRET, lat: 9.6, lon: -13.5, precisionM: 5 },
  photos: Array.from({ length: photos }, (_, i) => photo(`${localId}-${i}.jpg`, 2000 + i * 100, i + 1)),
});
const def = (localId: string) => ({
  localId, ownerUserId: "agent-A", createdAt: "2026-10-25T08:01:00.000Z", status: "pending" as const,
  payload: { catalogueCode: "NID_POULE", constateA: "2026-10-25T08:01:00.000Z", gravite: 3 },
  photos: [{ ...photo(`${localId}.jpg`, 1500, 9), capturedA: "2026-10-25T08:01:30.000Z" }],
});
const obs = (localId: string, createdAt = "2026-10-25T08:03:00.000Z") => ({
  localId, ownerUserId: "agent-A", createdAt, status: "pending" as const,
  payload: { type: "DEGRADATION" as const, description: SECRET, observeA: createdAt },
});
const portion = (localId: string) => ({
  localId, ownerUserId: "agent-A", createdAt: "2026-10-25T08:02:00.000Z", status: "pending" as const, payload: { tronconId: "t-1", debutM: 0, finM: 40 },
});

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("localStorage", fauxLocalStorage());
  vi.stubGlobal("navigator", { onLine: true, userAgent: "essai" });
  appels.length = 0; photosRecues.length = 0;
  Object.assign(etat, { echouerPush: 0, echouerPhotoNo: 0, photosPostees: 0, dechiffreesAvantPremierePhoto: -1 });
  fermerCompte();
  configurerUtilisateurSync(null);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); fermerCompte(); });

describe("le serveur recoit le CLAIR, jamais le chiffre", () => {
  it("quatre files, avec photos : charges utiles, noms et octets des photos identiques a la saisie ; la file se vide", async () => {
    await ouvrirA();
    const i = insp("insp-1");
    await addPendingInspection(i);
    await addPendingDefaut(def("def-1"));
    await addPendingPortion(portion("por-1"));
    await addPendingObservation(obs("obs-1"));

    await syncPendingOfflineData();

    const corps = appels.filter((a) => a.url !== "/v2/devices" && !(a.corps instanceof FormData));
    const creation = corps.find((a) => a.url === "/inspections")!.corps as Record<string, unknown>;
    expect(creation).toMatchObject({ clientInspectionId: "insp-1", tronconId: "t-1", dateInspection: "2026-10-25", etatObserve: "MAUVAIS", defautsConstates: SECRET, lat: 9.6 });
    const pushes = corps.filter((a) => a.url === "/v2/sync/push").map((a) => (a.corps as { operations: { entityType: string; entityId: string; payload: Record<string, unknown> }[] }).operations[0]);
    expect(pushes.map((p) => `${p.entityType}:${p.entityId}`).sort()).toEqual(["Defaut:def-1", "Observation:obs-1", "Portion:por-1"]);
    expect(pushes.find((p) => p.entityType === "Observation")!.payload).toEqual(obs("obs-1").payload);
    expect(pushes.find((p) => p.entityType === "Defaut")!.payload).toEqual(def("def-1").payload);

    // Rien de ce que le chiffrement ajoute ne part vers le serveur.
    const texte = JSON.stringify(corps);
    for (const interdit of ["charge", "paquet", "\"fmt\"", "compteId", "nbPhotos", "idPhoto"]) expect(texte, interdit).not.toContain(interdit);

    // Les photos arrivent en clair, octet pour octet.
    expect(photosRecues.map((p) => p.nom).sort()).toEqual(["def-1.jpg", "insp-1-0.jpg", "insp-1-1.jpg"]);
    for (const recue of photosRecues) {
      const origine = recue.nom === "def-1.jpg" ? def("def-1").photos[0].blob : i.photos[recue.nom.endsWith("-0.jpg") ? 0 : 1].blob;
      expect(recue.type).toBe("image/jpeg");
      expect(recue.octets.length).toBe(origine.size);
      expect(recue.octets[0]).toBe(0xff);
      expect(recue.octets[1]).toBe(0xd8);
    }
    const ref0 = jpeg(2000, 1);
    expect(photosRecues.find((p) => p.nom === "insp-1-0.jpg")!.octets).toEqual(ref0);

    expect(await compterFile()).toMatchObject({ total: 0, photosEnFile: 0 });
    expect(getSyncState().pendingCount).toBe(0);
  });

  it("une photo qui echoue : l'inspection reste en file CHIFFREE avec son identifiant serveur et la photo restante ; la reprise n'envoie que le reste", async () => {
    await ouvrirA();
    await addPendingInspection(insp("insp-1", 3));
    etat.echouerPhotoNo = 2;
    await syncPendingOfflineData();

    const [restante] = await getAllPending();
    expect(restante).toMatchObject({ localId: "insp-1", serverId: "srv-1", status: "error", errorMessage: "coupure pendant la photo" });
    expect(restante.photos.map((p) => p.name)).toEqual(["insp-1-1.jpg", "insp-1-2.jpg"]);   // la premiere est partie et retiree
    expect(appels.filter((a) => a.url === "/inspections")).toHaveLength(1);

    etat.echouerPhotoNo = 0;
    await syncPendingOfflineData();
    expect(appels.filter((a) => a.url === "/inspections")).toHaveLength(1);                 // jamais recree
    expect(photosRecues.map((p) => p.nom)).toEqual(["insp-1-0.jpg", "insp-1-1.jpg", "insp-1-2.jpg"]);
    expect(await getAllPending()).toEqual([]);
  });

  it("un echec du serveur marque la saisie « error » dans la file chiffree, avec le motif, puis la reprise la retire", async () => {
    await ouvrirA();
    await addPendingObservation(obs("obs-1"));
    etat.echouerPush = 1;
    await syncPendingOfflineData();
    const [o] = await getAllPendingObservations();
    expect(o).toMatchObject({ localId: "obs-1", status: "error", errorMessage: "reseau indisponible" });
    expect(o.payload.description).toBe(SECRET);
    await syncPendingOfflineData();
    expect(await getAllPendingObservations()).toEqual([]);
    expect(await getAllPendingDefauts()).toEqual([]);
    expect(await getAllPendingPortions()).toEqual([]);
  });
});

describe("pas de compte ou coffre verrouille : rien n'est envoye, rien n'est perdu, aucune erreur", () => {
  it("coffre verrouille : la synchronisation rend la main sans erreur ni requete ; le badge compte par les enveloppes ; deverrouille, tout part", async () => {
    await ouvrirA();
    await addPendingInspection(insp("insp-1"));
    await addPendingObservation(obs("obs-1"));
    coffre.verrouiller();
    appels.length = 0;

    await expect(syncPendingOfflineData()).resolves.toBeUndefined();
    expect(appels).toEqual([]);
    await refreshPendingCount();
    expect(getSyncState().pendingCount).toBe(2);                                    // lu sans cle
    expect(await decompteFileLocale()).toMatchObject({ enAttente: 2, photosEnFile: 2, relevesNonConfirmes: 0 });

    await coffre.deverrouiller("246810", Date.now());
    await syncPendingOfflineData();
    expect(await compterFile()).toMatchObject({ total: 0 });
    expect(getSyncState().pendingCount).toBe(0);
  });

  it("aucun compte ouvert : idem, sans erreur", async () => {
    await ouvrirA();
    await addPendingObservation(obs("obs-1"));
    fermerCompte();
    appels.length = 0;
    await expect(syncPendingOfflineData()).resolves.toBeUndefined();
    await expect(refreshPendingCount()).resolves.toBeUndefined();
    expect(appels).toEqual([]);
    expect(getSyncState().pendingCount).toBe(0);
  });

  it("verrouille PENDANT l'envoi : la synchronisation s'arrete proprement, la saisie reste en file et repart au deverrouillage sans doublon", async () => {
    await ouvrirA();
    await addPendingObservation(obs("obs-1", "2026-10-25T08:00:01.000Z"));
    await addPendingObservation(obs("obs-2", "2026-10-25T08:00:02.000Z"));
    const { api } = await import("./api");
    let pushes = 0;
    vi.mocked(api.post).mockImplementation((async (url: string, corps: unknown) => {
      appels.push({ url, corps });
      if (url === "/v2/devices") return { data: { id: "device-1" } };
      pushes += 1;
      if (pushes === 1) coffre.verrouiller();     // le coffre se verrouille apres la reponse de la premiere
      const op = (corps as { operations: { entityId: string }[] }).operations[0];
      return { data: { resultats: [{ statut: "SYNCHRONISE", entityId: op.entityId }] } };
    }) as never);

    await expect(syncPendingOfflineData()).resolves.toBeUndefined();
    await coffre.deverrouiller("246810", Date.now());
    const restantes = (await getAllPendingObservations()).map((o) => o.localId);
    expect(restantes.length).toBeGreaterThanOrEqual(1);
    await syncPendingOfflineData();
    expect(await getAllPendingObservations()).toEqual([]);
    const envoyes = appels.filter((a) => a.url === "/v2/sync/push").map((a) => (a.corps as { operations: { entityId: string }[] }).operations[0].entityId);
    expect(new Set(envoyes)).toEqual(new Set(["obs-1", "obs-2"]));   // chacune au moins une fois ; la cle d'idempotence serveur rejoue
  });
});

describe("enregistrement altere, autre compte, memoire", () => {
  it("une saisie illisible n'arrete pas la file : les autres partent, elle reste intacte et signalee", async () => {
    await ouvrirA();
    await addPendingObservation(obs("bonne", "2026-10-25T08:00:01.000Z"));
    await addPendingObservation(obs("abimee", "2026-10-25T08:00:02.000Z"));
    await addPendingObservation(obs("bonne-2", "2026-10-25T08:00:03.000Z"));
    const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open(nomBaseOffline(empreinte)); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("pending_observations", "readwrite");
      const os = tx.objectStore("pending_observations");
      const g = os.get("abimee");
      g.onsuccess = () => { const r = g.result as { charge: Uint8Array }; const c = new Uint8Array(r.charge); c[c.length - 1] ^= 1; os.put({ ...r, charge: c }); };
      tx.oncomplete = () => resolve();
    });
    db.close();

    await expect(syncPendingOfflineData()).resolves.toBeUndefined();
    const envoyes = appels.filter((a) => a.url === "/v2/sync/push").map((a) => (a.corps as { operations: { entityId: string }[] }).operations[0].entityId);
    expect(envoyes).toEqual(["bonne", "bonne-2"]);
    expect((await compterFile()).total).toBe(1);        // l'enveloppe de l'illisible est toujours la, jamais supprimee
  });

  it("les saisies d'un autre compte (meme IndexedDB) ne partent pas et ne sont pas comptees", async () => {
    await ouvrirA();
    await addPendingObservation(obs("obs-A"));
    fermerCompte();
    const coffreB = await creerCoffre({
      stockage: stockageEnMemoire(), compteId: "agent-B", appareilId: "tel-1", pin: "246810", maintenantMs: Date.now(), iterations: 1000, iterationsDeTest: true,
      profil: { userId: "agent-B", nom: "B", role: "INSPECTEUR", modules: [], regions: [] },
    });
    ouvrirCompte({ compteId: "agent-B", empreinte: await empreinteCompte("agent-B", sha256WebCrypto), chiffreur: coffreB });
    configurerUtilisateurSync("agent-B");
    appels.length = 0;
    await syncPendingOfflineData();
    await refreshPendingCount();
    expect(appels).toEqual([]);
    expect(getSyncState().pendingCount).toBe(0);
  });

  it("les photos ne sont pas toutes dechiffrees d'un coup : une saisie a la fois (au plus ses propres photos avant son premier envoi)", async () => {
    await ouvrirA();
    for (let i = 1; i <= 4; i += 1) await addPendingInspection(insp(`insp-${i}`, 3));
    compteurDechiffrement.n = 0;
    await syncPendingOfflineData();
    expect(photosRecues).toHaveLength(12);
    // Avant d'envoyer la premiere photo de la file, seules les 3 photos de la premiere saisie ont ete dechiffrees (pas 12).
    expect(etat.dechiffreesAvantPremierePhoto).toBe(3);
  });
});
