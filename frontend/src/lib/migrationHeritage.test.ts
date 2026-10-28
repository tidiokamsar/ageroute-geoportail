// @vitest-environment node
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntreeJournal } from "../roulage/journal";
import { creerCoffre, stockageEnMemoire, sha256WebCrypto, type CoffreSession } from "../session/coffreSession";
import { BASE_OFFLINE_HISTORIQUE, BASE_ROULAGE_HISTORIQUE, empreinteCompte } from "../session/compteLocal";
import { fermerCompte, lireStockageLocal, ouvrirCompte } from "./compteCourant";
import { compterHeritage, compterQuarantaine, migrerHeritage, type EtapeMigration } from "./migrationHeritage";
import {
  addPendingObservation, getAllPending, getAllPendingDefauts, getAllPendingObservations, getAllPendingPortions, getPendingInspection,
  PHOTO_TAILLE_MAX_OCTETS, updatePendingInspection, type PendingInspection,
} from "./offlineDb";
import { stockageIndexedDb } from "./roulageHote";

/**
 * Migration de l'HERITAGE (bases d'avant le cloisonnement par compte) vers la base chiffree du compte.
 * Ce qui est defendu : aucun rattachement automatique ; la copie est relue avant tout retrait ; les saisies sans proprietaire
 * ou d'un autre compte restent intactes et invisibles ; une interruption n'importe ou ne perd rien et ne duplique rien ;
 * rejouer ne change rien.
 */

const SECRET = "DESCRIPTION-CONFIDENTIELLE-QK42";

function octets(n: number, graine: number): Uint8Array<ArrayBuffer> {
  const o = new Uint8Array(new ArrayBuffer(n));
  o.set([0xff, 0xd8, 0xff, 0xe0]);
  let x = graine;
  for (let i = 4; i < n; i += 1) { x = (x * 1103515245 + 12345) & 0x7fffffff; o[i] = x & 0xff; }
  return o;
}
const photo = (nom: string, n = 3000, graine = 1) => ({ name: nom, blob: new Blob([octets(n, graine)], { type: "image/jpeg" }) });

const MAGASINS = ["pending_inspections", "pending_defauts", "pending_portions", "pending_observations"];

async function ouvrirBrut(nom: string, version?: number, magasins: string[] = MAGASINS): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = version === undefined ? indexedDB.open(nom) : indexedDB.open(nom, version);
    r.onupgradeneeded = () => { for (const m of magasins) if (!r.result.objectStoreNames.contains(m)) r.result.createObjectStore(m, { keyPath: "localId" }); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Une base historique `bdri-offline` v4 (ou moins), EN CLAIR, telle que l'application d'avant la laissait. */
async function creerHeritage(contenu: Record<string, Record<string, unknown>[]>, version = 4, magasins = MAGASINS): Promise<void> {
  const db = await ouvrirBrut(BASE_OFFLINE_HISTORIQUE, version, magasins);
  await new Promise<void>((resolve) => {
    const tx = db.transaction(magasins, "readwrite");
    for (const [m, items] of Object.entries(contenu)) for (const it of items) tx.objectStore(m).put(it);
    tx.oncomplete = () => resolve();
  });
  db.close();
}

async function cles(nomBase: string, magasin: string): Promise<string[]> {
  const db = await ouvrirBrut(nomBase);
  const r = db.objectStoreNames.contains(magasin)
    ? await new Promise<string[]>((resolve) => { const q = db.transaction(magasin, "readonly").objectStore(magasin).getAllKeys(); q.onsuccess = () => resolve((q.result as string[]).sort()); })
    : [];
  db.close();
  return r;
}

async function valeurHeritage(magasin: string, cle: string): Promise<Record<string, unknown>> {
  const db = await ouvrirBrut(BASE_OFFLINE_HISTORIQUE);
  const v = await new Promise<Record<string, unknown>>((resolve) => { const q = db.transaction(magasin, "readonly").objectStore(magasin).get(cle); q.onsuccess = () => resolve(q.result); });
  db.close();
  return v;
}

const inspectionClair = (localId: string, owner: string | undefined, over: Record<string, unknown> = {}) => ({
  localId, ...(owner === undefined ? {} : { ownerUserId: owner }), status: "pending", createdAt: "2026-10-20T08:00:00.000Z",
  payload: { tronconId: "t-1", dateInspection: "2026-10-20", etatObserve: "MAUVAIS", defautsConstates: SECRET },
  photos: [photo("a.jpg", 3000, 1), photo("b.jpg", 2000, 2)], ...over,
});
const defautClair = (localId: string, owner: string | undefined) => ({
  localId, ...(owner === undefined ? {} : { ownerUserId: owner }), status: "error", errorMessage: "reseau", tentatives: 2, createdAt: "2026-10-20T08:01:00.000Z",
  payload: { catalogueCode: "NID_POULE", constateA: "2026-10-20T08:01:00.000Z", gravite: 2 },
  photos: [{ ...photo("d.jpg", 1500, 3), capturedA: "2026-10-20T08:01:30.000Z", lat: 9.5, lon: -13.7, precisionM: 4 }],
});
const portionClair = (localId: string, owner: string | undefined) => ({
  localId, ...(owner === undefined ? {} : { ownerUserId: owner }), status: "abandonnee", refusDefinitif: true, createdAt: "2026-10-20T08:02:00.000Z",
  payload: { tronconId: "t-1", debutM: 0, finM: 50 },
});
const observationClair = (localId: string, owner: string | undefined) => ({
  localId, ...(owner === undefined ? {} : { ownerUserId: owner }), status: "pending", createdAt: "2026-10-20T08:03:00.000Z",
  payload: { type: "DEGRADATION", description: SECRET, observeA: "2026-10-20T08:03:00.000Z" },
  photos: [{ ...photo("o.jpg", 1200, 4), capturedA: "2026-10-20T08:03:10.000Z" }],
});

/** Un heritage mixte : deux saisies de A, une de B, deux sans proprietaire. */
async function heritageMixte(): Promise<void> {
  await creerHeritage({
    pending_inspections: [inspectionClair("A-insp", "agent-A"), inspectionClair("B-insp", "agent-B"), inspectionClair("orpheline-insp", undefined)],
    pending_defauts: [defautClair("A-def", "agent-A"), defautClair("B-def", "agent-B")],
    pending_portions: [portionClair("A-por", "agent-A")],
    pending_observations: [observationClair("A-obs", "agent-A"), observationClair("orpheline-obs", ""), observationClair("B-obs", "agent-B")],
  });
}

function entreeJ(seq: number, type: "DEMARRAGE" | "ECHANTILLON" | "ARRET", agent: string | null = "agent-A", sessionId = "sess-A"): EntreeJournal {
  if (type === "DEMARRAGE") return { seq, type, tMs: 1000, sessionId, parametres: {}, agentRef: agent, versionJournal: 1 } as unknown as EntreeJournal;
  if (type === "ARRET") return { seq, type, tMs: 90_000 } as unknown as EntreeJournal;
  return { seq, type, segment: 0, trou: null, alertes: [], ecartHorlogeMs: 0, sautsConsecutifs: 0, identiquesConsecutifs: 0, echantillon: { tMs: 1000 + seq, lat: 9.6 + seq * 1e-5, lon: -13.5, precisionM: 5 } } as unknown as EntreeJournal;
}
async function creerJournalHeritage(entrees: EntreeJournal[]): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(BASE_ROULAGE_HISTORIQUE, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("journal", { keyPath: "seq" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  await new Promise<void>((resolve) => {
    const tx = db.transaction("journal", "readwrite");
    for (const e of entrees) tx.objectStore("journal").put(e);
    tx.oncomplete = () => resolve();
  });
  db.close();
}

function fauxLocalStorage() {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, key: (i: number) => [...m.keys()][i] ?? null, getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(),
  };
}

const coffres = new Map<string, CoffreSession>();
async function ouvrir(compteId: string): Promise<{ coffre: CoffreSession; empreinte: string }> {
  let coffre = coffres.get(compteId);
  if (!coffre) {
    coffre = await creerCoffre({
      stockage: stockageEnMemoire(), compteId, appareilId: "tel-1", pin: "246810", maintenantMs: Date.now(), iterations: 1000, iterationsDeTest: true,
      profil: { userId: compteId, nom: compteId, role: "INSPECTEUR", modules: [], regions: [] },
    });
    coffres.set(compteId, coffre);
  }
  const empreinte = await empreinteCompte(compteId, sha256WebCrypto);
  ouvrirCompte({ compteId, empreinte, chiffreur: coffre });
  return { coffre, empreinte };
}

async function octetsDe(b: Blob): Promise<Uint8Array> { return new Uint8Array(await b.arrayBuffer()); }

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("localStorage", fauxLocalStorage());
  coffres.clear();
  fermerCompte();
});
afterEach(() => { vi.restoreAllMocks(); fermerCompte(); });

describe("migration propre : seules les saisies du compte passent, chiffrees, verifiees, puis retirees", () => {
  it("A reprend SES saisies (photos octet pour octet) ; B, les saisies sans proprietaire et le reste de l'heritage restent intacts", async () => {
    await heritageMixte();
    const refInsp = await valeurHeritage("pending_inspections", "A-insp");
    const refPhotoA = await octetsDe((refInsp.photos as { blob: Blob }[])[0].blob);
    await ouvrir("agent-A");

    const r = await migrerHeritage();
    expect(r).toMatchObject({ migrees: 4, dejaMigrees: 0, nonMigrables: [], sansProprietaire: 2, autresComptes: 3, journal: "AUCUN", quarantaine: 5 });

    // Chez A : tout y est, lisible, photos identiques.
    const insp = await getAllPending();
    expect(insp.map((i) => i.localId)).toEqual(["A-insp"]);
    expect(insp[0]).toMatchObject({ ownerUserId: "agent-A", status: "pending" });
    expect(insp[0].payload.defautsConstates).toBe(SECRET);
    expect(insp[0].photos.map((p) => p.name)).toEqual(["a.jpg", "b.jpg"]);
    expect(await octetsDe(insp[0].photos[0].blob)).toEqual(refPhotoA);
    expect(insp[0].photos[0].blob.type).toBe("image/jpeg");
    const def = await getAllPendingDefauts();
    expect(def[0]).toMatchObject({ localId: "A-def", status: "error", errorMessage: "reseau", tentatives: 2 });
    expect(def[0].photos?.[0]).toMatchObject({ name: "d.jpg", capturedA: "2026-10-20T08:01:30.000Z", lat: 9.5, precisionM: 4 });
    expect((await getAllPendingPortions())[0]).toMatchObject({ localId: "A-por", status: "abandonnee", refusDefinitif: true });
    expect((await getAllPendingObservations()).map((o) => o.localId)).toEqual(["A-obs"]);

    // Dans l'ancienne base : les saisies de A sont parties, les autres sont la, intactes.
    expect(await cles(BASE_OFFLINE_HISTORIQUE, "pending_inspections")).toEqual(["B-insp", "orpheline-insp"]);
    expect(await cles(BASE_OFFLINE_HISTORIQUE, "pending_defauts")).toEqual(["B-def"]);
    expect(await cles(BASE_OFFLINE_HISTORIQUE, "pending_portions")).toEqual([]);
    expect(await cles(BASE_OFFLINE_HISTORIQUE, "pending_observations")).toEqual(["B-obs", "orpheline-obs"]);
    const b = await valeurHeritage("pending_inspections", "B-insp");
    expect(b.ownerUserId).toBe("agent-B");
    expect(((b.photos as { blob: Blob }[])[0]).blob.size).toBe(3000);
    expect((await valeurHeritage("pending_observations", "orpheline-obs")).ownerUserId).toBe("");
  });

  it("les saisies sans proprietaire et d'un autre compte ne sont atteintes par AUCUNE API du compte, meme apres la migration", async () => {
    await heritageMixte();
    await ouvrir("agent-A");
    await migrerHeritage();
    const tous = [
      ...(await getAllPending()), ...(await getAllPendingDefauts()), ...(await getAllPendingPortions()), ...(await getAllPendingObservations()),
    ].map((s) => s.localId);
    for (const interdit of ["B-insp", "B-def", "B-obs", "orpheline-insp", "orpheline-obs"]) expect(tous).not.toContain(interdit);
    expect(await getPendingInspection("orpheline-insp")).toBeNull();
    expect(await getPendingInspection("B-insp")).toBeNull();
  });

  it("aucun rattachement automatique : un compte sans saisie ne reprend pas les saisies sans proprietaire", async () => {
    await heritageMixte();
    await ouvrir("agent-C");
    const r = await migrerHeritage();
    expect(r).toMatchObject({ migrees: 0, sansProprietaire: 2, autresComptes: 7, quarantaine: 9 });
    expect(await getAllPending()).toEqual([]);
    expect(await cles(BASE_OFFLINE_HISTORIQUE, "pending_inspections")).toEqual(["A-insp", "B-insp", "orpheline-insp"]);
  });

  it("B, ouvrant son compte a son tour, reprend les siennes seulement ; chacun ne voit que les siennes", async () => {
    await heritageMixte();
    await ouvrir("agent-A");
    await migrerHeritage();
    fermerCompte();
    await ouvrir("agent-B");
    const r = await migrerHeritage();
    expect(r).toMatchObject({ migrees: 3, sansProprietaire: 2, autresComptes: 0 });
    expect((await getAllPending()).map((i) => i.localId)).toEqual(["B-insp"]);
    expect((await getAllPendingObservations()).map((i) => i.localId)).toEqual(["B-obs"]);
    expect(await cles(BASE_OFFLINE_HISTORIQUE, "pending_inspections")).toEqual(["orpheline-insp"]);
    fermerCompte();
    await ouvrir("agent-A");
    expect((await getAllPending()).map((i) => i.localId)).toEqual(["A-insp"]);
  });

  it("compterQuarantaine et compterHeritage ne rendent que des nombres, sans cle, sans rien modifier", async () => {
    await heritageMixte();
    await creerJournalHeritage([entreeJ(1, "DEMARRAGE", "agent-B", "sess-B"), entreeJ(2, "ECHANTILLON"), entreeJ(3, "ARRET")]);
    await ouvrir("agent-A");
    expect(await compterHeritage()).toEqual({ aMigrer: 4, sansProprietaire: 2, autresComptes: 3, journal: "AUTRE_COMPTE" });
    expect(await compterQuarantaine()).toBe(2 + 3 + 1);
    expect(await compterQuarantaine("agent-B")).toBe(2 + 4 + 0);
    await migrerHeritage();
    expect(await compterQuarantaine()).toBe(2 + 3 + 1);
    expect(await compterHeritage()).toEqual({ aMigrer: 0, sansProprietaire: 2, autresComptes: 3, journal: "AUTRE_COMPTE" });
  });

  it("sans ancienne base : rien a faire, et la lecture n'en cree pas", async () => {
    await ouvrir("agent-A");
    expect(await migrerHeritage()).toMatchObject({ migrees: 0, nonMigrables: [], journal: "AUCUN", quarantaine: 0 });
    expect(await compterQuarantaine()).toBe(0);
    const noms = (await indexedDB.databases()).map((d) => d.name);
    expect(noms).not.toContain(BASE_OFFLINE_HISTORIQUE);
    expect(noms).not.toContain(BASE_ROULAGE_HISTORIQUE);
  });

  it("une ancienne base de version 1 (une seule file) est lue sans erreur et sans mise a niveau", async () => {
    await creerHeritage({ pending_inspections: [inspectionClair("A-insp", "agent-A")] }, 1, ["pending_inspections"]);
    await ouvrir("agent-A");
    expect(await migrerHeritage()).toMatchObject({ migrees: 1 });
    const db = await ouvrirBrut(BASE_OFFLINE_HISTORIQUE);
    expect(db.version).toBe(1);
    expect(Array.from(db.objectStoreNames)).toEqual(["pending_inspections"]);
    db.close();
  });
});

describe("l'aller-retour est verifie AVANT tout retrait", () => {
  it("une relecture qui ne rend pas les memes octets de photo : la saisie RESTE dans l'ancienne base et est signalee", async () => {
    await heritageMixte();
    const { coffre } = await ouvrir("agent-A");
    const vrai = coffre.dechiffrerBlob.bind(coffre);
    vi.spyOn(coffre, "dechiffrerBlob").mockImplementation(async (p, id, v) => {
      const b = await vrai(p, id, v);
      const o = new Uint8Array(await b.arrayBuffer());
      o[10] ^= 1;                                        // un seul octet different
      return new Blob([o], { type: b.type });
    });
    const r = await migrerHeritage();
    expect(r.nonMigrables.map((n) => `${n.file}:${n.localId}:${n.raison}`).sort()).toEqual([
      "defauts:A-def:VERIFICATION_ECHOUEE", "inspections:A-insp:VERIFICATION_ECHOUEE", "observations:A-obs:VERIFICATION_ECHOUEE",
    ]);
    expect(r.migrees).toBe(1);                           // la portion n'a pas de photo
    expect(await cles(BASE_OFFLINE_HISTORIQUE, "pending_inspections")).toContain("A-insp");
    expect(await cles(BASE_OFFLINE_HISTORIQUE, "pending_defauts")).toContain("A-def");
    expect(await cles(BASE_OFFLINE_HISTORIQUE, "pending_observations")).toContain("A-obs");
    expect(await cles(BASE_OFFLINE_HISTORIQUE, "pending_portions")).toEqual([]);
  });

  it("une photo de plus de 8 Mio ne peut pas etre chiffree par le coffre : la saisie reste intacte dans l'ancienne base, signalee", async () => {
    const grosse = { name: "gros.jpg", blob: new Blob([octets(PHOTO_TAILLE_MAX_OCTETS + 1, 9)], { type: "image/jpeg" }) };
    await creerHeritage({ pending_inspections: [inspectionClair("A-gros", "agent-A", { photos: [grosse] }), inspectionClair("A-ok", "agent-A")] });
    await ouvrir("agent-A");
    const r = await migrerHeritage();
    expect(r.migrees).toBe(1);
    expect(r.nonMigrables).toEqual([{ file: "inspections", localId: "A-gros", raison: "PHOTO_TROP_GROSSE" }]);
    expect(await cles(BASE_OFFLINE_HISTORIQUE, "pending_inspections")).toEqual(["A-gros"]);
    expect((await getAllPending()).map((i) => i.localId)).toEqual(["A-ok"]);
  });

  it("une saisie d'avant le plafond de cinq photos est migree telle quelle (rien n'est rejete a la migration)", async () => {
    await creerHeritage({ pending_inspections: [inspectionClair("A-sept", "agent-A", { photos: Array.from({ length: 7 }, (_, i) => photo(`p${i}.jpg`, 400, i + 1)) })] });
    await ouvrir("agent-A");
    expect((await migrerHeritage()).migrees).toBe(1);
    expect((await getAllPending())[0].photos).toHaveLength(7);
  });
});

describe("idempotente et rejouable apres interruption", () => {
  it("rejouer ne change rien : aucun doublon, aucune perte, zero migration la seconde fois", async () => {
    await heritageMixte();
    await ouvrir("agent-A");
    const premiere = await migrerHeritage();
    const seconde = await migrerHeritage();
    expect(premiere.migrees).toBe(4);
    expect(seconde).toMatchObject({ migrees: 0, dejaMigrees: 0, nonMigrables: [], sansProprietaire: 2, autresComptes: 3 });
    expect((await getAllPending()).map((i) => i.localId)).toEqual(["A-insp"]);
    expect(await getAllPendingObservations()).toHaveLength(1);
  });

  it("deux appels simultanes partagent la meme execution", async () => {
    await heritageMixte();
    await ouvrir("agent-A");
    const [a, b] = await Promise.all([migrerHeritage(), migrerHeritage()]);
    expect(a).toBe(b);
    expect(a.migrees).toBe(4);
  });

  for (const etape of ["COPIE", "VERIFIE", "RETIRE"] as EtapeMigration[]) {
    for (const rang of [1, 2, 4]) {
      it(`interrompue apres l'etape ${etape} de la saisie n°${rang} : la reprise termine, sans perte ni doublon`, async () => {
        await heritageMixte();
        await ouvrir("agent-A");
        let vu = 0;
        await expect(migrerHeritage({
          observer: (e) => { if (e.etape === etape && e.file !== "journal") { vu += 1; if (vu === rang) throw new Error("coupure simulee"); } },
        })).rejects.toThrow("coupure simulee");

        // Apres la coupure : rien n'est perdu (chaque saisie est dans l'ancienne base, dans celle du compte, ou les deux).
        const dansHeritage = new Set([
          ...(await cles(BASE_OFFLINE_HISTORIQUE, "pending_inspections")), ...(await cles(BASE_OFFLINE_HISTORIQUE, "pending_defauts")),
          ...(await cles(BASE_OFFLINE_HISTORIQUE, "pending_portions")), ...(await cles(BASE_OFFLINE_HISTORIQUE, "pending_observations")),
        ]);
        const chezA = new Set([
          ...(await getAllPending()), ...(await getAllPendingDefauts()), ...(await getAllPendingPortions()), ...(await getAllPendingObservations()),
        ].map((s) => s.localId));
        for (const id of ["A-insp", "A-def", "A-por", "A-obs"]) expect(dansHeritage.has(id) || chezA.has(id), `${id} perdue`).toBe(true);

        // Reprise : tout est chez A, une fois, et l'ancienne base ne garde que les autres.
        const reprise = await migrerHeritage();
        expect(reprise.nonMigrables).toEqual([]);
        expect(reprise.migrees + reprise.dejaMigrees).toBeLessThanOrEqual(4);   // la coupure au dernier retrait ne laisse rien a reprendre
        expect((await getAllPending()).map((i) => i.localId)).toEqual(["A-insp"]);
        expect((await getAllPendingDefauts()).map((i) => i.localId)).toEqual(["A-def"]);
        expect((await getAllPendingPortions()).map((i) => i.localId)).toEqual(["A-por"]);
        expect((await getAllPendingObservations()).map((i) => i.localId)).toEqual(["A-obs"]);
        expect(await cles(BASE_OFFLINE_HISTORIQUE, "pending_inspections")).toEqual(["B-insp", "orpheline-insp"]);
        expect(await cles(BASE_OFFLINE_HISTORIQUE, "pending_defauts")).toEqual(["B-def"]);
        expect(await cles(BASE_OFFLINE_HISTORIQUE, "pending_observations")).toEqual(["B-obs", "orpheline-obs"]);
        // Les photos de la saisie reprise sont intactes.
        const insp = (await getAllPending())[0];
        expect(insp.photos.map((p) => p.blob.size)).toEqual([3000, 2000]);
      });
    }
  }

  it("copie deja la mais ancienne saisie encore presente (coupure avant le retrait) : la copie du compte, plus avancee, n'est PAS ecrasee", async () => {
    await creerHeritage({ pending_inspections: [inspectionClair("A-insp", "agent-A")] });
    await ouvrir("agent-A");
    await expect(migrerHeritage({ observer: (e) => { if (e.etape === "VERIFIE") throw new Error("coupure"); } })).rejects.toThrow("coupure");
    // La synchronisation avance la copie avant que la migration ne reprenne.
    const [copie] = await getAllPending();
    await updatePendingInspection({ ...copie, status: "error", errorMessage: "reseau", serverId: "srv-1", photos: copie.photos.slice(1) });

    const r = await migrerHeritage();
    expect(r).toMatchObject({ migrees: 0, dejaMigrees: 1, nonMigrables: [] });
    const [apres] = await getAllPending();
    expect(apres).toMatchObject({ status: "error", serverId: "srv-1" });
    expect(apres.photos).toHaveLength(1);
    expect(await cles(BASE_OFFLINE_HISTORIQUE, "pending_inspections")).toEqual([]);
  });

  it("une copie qui n'est pas la meme saisie (contenu different sous le meme identifiant) n'est jamais ecrasee ni suivie du retrait", async () => {
    await creerHeritage({ pending_inspections: [inspectionClair("A-insp", "agent-A")] });
    await ouvrir("agent-A");
    const autre: PendingInspection = {
      localId: "A-insp", createdAt: "2026-10-25T00:00:00.000Z", status: "pending", photos: [],
      payload: { dateInspection: "2026-10-25", etatObserve: "BON" },
    };
    await updatePendingInspection(autre);
    const r = await migrerHeritage();
    expect(r.nonMigrables).toEqual([{ file: "inspections", localId: "A-insp", raison: "COPIE_DIVERGENTE" }]);
    expect(await cles(BASE_OFFLINE_HISTORIQUE, "pending_inspections")).toEqual(["A-insp"]);
    expect((await getAllPending())[0].payload.etatObserve).toBe("BON");
  });

  it("coffre verrouille ou aucun compte : la migration refuse (erreur typee) et ne touche a rien", async () => {
    await heritageMixte();
    await expect(migrerHeritage()).rejects.toMatchObject({ code: "AUCUN_COMPTE" });
    const { coffre } = await ouvrir("agent-A");
    coffre.verrouiller();
    await expect(migrerHeritage()).rejects.toMatchObject({ code: "COFFRE_VERROUILLE" });
    expect(await cles(BASE_OFFLINE_HISTORIQUE, "pending_inspections")).toEqual(["A-insp", "B-insp", "orpheline-insp"]);
  });

  it("verrouille en cours de route : la migration s'arrete sur l'erreur typee, rien n'est retire sans copie verifiee", async () => {
    await heritageMixte();
    const { coffre } = await ouvrir("agent-A");
    let n = 0;
    const vrai = coffre.chiffrer.bind(coffre);
    vi.spyOn(coffre, "chiffrer").mockImplementation(async (d, aad) => { n += 1; if (n === 2) coffre.verrouiller(); return vrai(d, aad); });
    await expect(migrerHeritage()).rejects.toMatchObject({ code: "COFFRE_VERROUILLE" });
    vi.restoreAllMocks();
    await coffre.deverrouiller("246810", Date.now());
    const r = await migrerHeritage();
    expect(r.nonMigrables).toEqual([]);
    expect((await getAllPendingObservations()).map((o) => o.localId)).toEqual(["A-obs"]);
    expect((await getAllPending()).map((o) => o.localId)).toEqual(["A-insp"]);
  });
});

describe("journal de roulage historique", () => {
  it("le journal du compte est copie chiffre, relu, puis retire ; ses cles localStorage d'avant suivent, l'envoi confirme est retenu", async () => {
    const entrees = [entreeJ(1, "DEMARRAGE"), ...Array.from({ length: 30 }, (_, i) => entreeJ(i + 2, "ECHANTILLON")), entreeJ(32, "ARRET")];
    await creerJournalHeritage(entrees);
    localStorage.setItem("bdri.roulage.envoi.sess-A", "2026-10-20T12:00:00.000Z");
    localStorage.setItem("bdri.roulage.mission.sess-A", "mission-9");
    localStorage.setItem("bdri.roulage.intitule.sess-A", "Axe nord");
    localStorage.setItem("bdri.sync.device.agent-A", "device-A");
    await ouvrir("agent-A");

    const r = await migrerHeritage();
    expect(r.journal).toBe("MIGRE");
    expect(await stockageIndexedDb()!.toutes()).toEqual(entrees);
    expect(await cles(BASE_ROULAGE_HISTORIQUE, "journal")).toEqual([]);
    expect(lireStockageLocal("roulage.envoi.sess-A")).toBe("2026-10-20T12:00:00.000Z");
    expect(lireStockageLocal("roulage.mission.sess-A")).toBe("mission-9");
    expect(lireStockageLocal("roulage.intitule.sess-A")).toBe("Axe nord");
    expect(lireStockageLocal("sync.device", "agent-A")).toBe("device-A");
    for (const ancienne of ["bdri.roulage.envoi.sess-A", "bdri.roulage.mission.sess-A", "bdri.roulage.intitule.sess-A", "bdri.sync.device.agent-A"]) {
      expect(localStorage.getItem(ancienne), ancienne).toBeNull();
    }
    expect((await migrerHeritage()).journal).toBe("AUCUN");
  });

  it("le journal d'un AUTRE compte ou sans agent n'est ni attribue, ni lu, ni supprime", async () => {
    for (const agent of ["agent-B", null]) {
      vi.stubGlobal("indexedDB", new IDBFactory());
      const entrees = [entreeJ(1, "DEMARRAGE", agent, "sess-X"), entreeJ(2, "ECHANTILLON"), entreeJ(3, "ARRET")];
      await creerJournalHeritage(entrees);
      await ouvrir("agent-A");
      const r = await migrerHeritage();
      expect(r.journal).toBe(agent === null ? "SANS_PROPRIETAIRE" : "AUTRE_COMPTE");
      expect(r.quarantaine).toBe(1);
      expect(await cles(BASE_ROULAGE_HISTORIQUE, "journal").then((k) => k.length)).toBe(3);
      expect(await stockageIndexedDb()!.toutes()).toEqual([]);
      fermerCompte();
    }
  });

  it("le compte a deja SA propre session dans son journal : l'ancien journal reste intact (CONFLIT), rien n'est ecrase", async () => {
    await creerJournalHeritage([entreeJ(1, "DEMARRAGE", "agent-A", "sess-ancienne"), entreeJ(2, "ECHANTILLON"), entreeJ(3, "ARRET")]);
    await ouvrir("agent-A");
    const mien = stockageIndexedDb()!;
    mien.ajouter(entreeJ(1, "DEMARRAGE", "agent-A", "sess-actuelle"));
    mien.ajouter(entreeJ(2, "ECHANTILLON"));
    await mien.toutes();
    const r = await migrerHeritage();
    expect(r.journal).toBe("CONFLIT");
    expect((await stockageIndexedDb()!.toutes()).map((e) => e.seq)).toEqual([1, 2]);
    expect(await cles(BASE_ROULAGE_HISTORIQUE, "journal").then((k) => k.length)).toBe(3);
  });

  it("interrompue entre la copie et le retrait du journal : la reprise ne duplique rien", async () => {
    const entrees = [entreeJ(1, "DEMARRAGE"), ...Array.from({ length: 12 }, (_, i) => entreeJ(i + 2, "ECHANTILLON")), entreeJ(14, "ARRET")];
    await creerJournalHeritage(entrees);
    await ouvrir("agent-A");
    await expect(migrerHeritage({ observer: (e) => { if (e.file === "journal" && e.etape === "VERIFIE") throw new Error("coupure"); } })).rejects.toThrow("coupure");
    expect(await cles(BASE_ROULAGE_HISTORIQUE, "journal").then((k) => k.length)).toBe(14);   // pas encore retire
    expect(await stockageIndexedDb()!.toutes()).toEqual(entrees);                             // deja copie
    const r = await migrerHeritage();
    expect(r.journal).toBe("MIGRE");
    expect(await stockageIndexedDb()!.toutes()).toEqual(entrees);                             // une seule fois
    expect(await cles(BASE_ROULAGE_HISTORIQUE, "journal")).toEqual([]);
  });

  it("une copie du journal qui ne se relit pas a l'identique laisse l'ancien journal en place", async () => {
    await creerJournalHeritage([entreeJ(1, "DEMARRAGE"), entreeJ(2, "ECHANTILLON"), entreeJ(3, "ARRET")]);
    const { coffre } = await ouvrir("agent-A");
    const vrai = coffre.dechiffrerJson.bind(coffre);
    vi.spyOn(coffre, "dechiffrerJson").mockImplementation(async (p, aad) => {
      const v = await vrai<EntreeJournal[]>(p, aad);
      return Array.isArray(v) ? v.map((e) => (e.type === "ECHANTILLON" ? ({ ...e, segment: 7 } as EntreeJournal) : e)) : v;
    });
    const r = await migrerHeritage();
    expect(r.journal).toBe("NON_MIGRABLE");
    expect(r.nonMigrables).toEqual([{ file: "journal", localId: null, raison: "VERIFICATION_ECHOUEE" }]);
    expect(await cles(BASE_ROULAGE_HISTORIQUE, "journal").then((k) => k.length)).toBe(3);
  });
});

describe("la migration n'invente pas de saisie et reste lisible par les autres API", () => {
  it("apres migration, une saisie migree se met a jour et se retire comme n'importe quelle autre", async () => {
    await heritageMixte();
    await ouvrir("agent-A");
    await migrerHeritage();
    await addPendingObservation({ localId: "neuve", createdAt: "2026-10-25T08:00:00.000Z", status: "pending", payload: { type: "AUTRE", observeA: "2026-10-25T08:00:00.000Z" } });
    expect((await getAllPendingObservations()).map((o) => o.localId).sort()).toEqual(["A-obs", "neuve"]);
  });
});

describe("D8 : la migration du journal verifie que le compte courant est encore celui qu'elle migre", () => {
  it("l'agent change de compte AVANT le retrait de l'ancien journal : rien n'est retire, l'etat est NON_MIGRABLE (COMPTE_CHANGE)", async () => {
    const entrees = [entreeJ(1, "DEMARRAGE"), ...Array.from({ length: 5 }, (_, i) => entreeJ(i + 2, "ECHANTILLON")), entreeJ(7, "ARRET")];
    await creerJournalHeritage(entrees);
    await ouvrir("agent-A");
    const r = await migrerHeritage({
      observer: async (e) => {
        // Entre la copie verifiee et le retrait irreversible : un autre compte s'ouvre (autre onglet, choix de compte).
        if (e.etape === "VERIFIE" && e.file === "journal") { fermerCompte(); await ouvrir("agent-B"); }
      },
    });
    expect(r.journal).toBe("NON_MIGRABLE");
    expect(r.nonMigrables).toEqual([{ file: "journal", localId: null, raison: "COMPTE_CHANGE" }]);
    expect(await cles(BASE_ROULAGE_HISTORIQUE, "journal").then((k) => k.length)).toBe(7); // l'ancien journal est INTACT
  });

  it("temoin : sans changement de compte, la migration va au bout comme avant", async () => {
    await creerJournalHeritage([entreeJ(1, "DEMARRAGE"), entreeJ(2, "ECHANTILLON"), entreeJ(3, "ECHANTILLON"), entreeJ(4, "ARRET")]);
    await ouvrir("agent-A");
    expect((await migrerHeritage()).journal).toBe("MIGRE");
  });
});
