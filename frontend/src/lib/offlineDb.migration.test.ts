// @vitest-environment node
import "fake-indexeddb/auto";
import { IDBDatabase as FauxIDBDatabase, IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { creerCoffre, stockageEnMemoire, sha256WebCrypto } from "../session/coffreSession";
import { empreinteCompte, nomBaseOffline } from "../session/compteLocal";
import { fermerCompte, ouvrirCompte } from "./compteCourant";
import {
  addPendingObservation, compterFile, getAllPending, getAllPendingDefauts, getAllPendingObservations, getAllPendingPortions, lireIllisibles,
  type PendingObservation,
} from "./offlineDb";

/**
 * La migration du SCHEMA de la base locale (versions 1 a 4 -> 5) ne doit RIEN perdre.
 *
 * POURQUOI CE TEST EXISTE
 *
 * Un agent peut avoir des saisies non remontees sur son telephone au moment ou l'application se met a jour. Recreer
 * la base les effacerait, et une saisie de terrain perdue ne se refait pas. Chaque version a ajoute des magasins
 * (2 : defauts, 3 : portions, 4 : observations) ; la version 5 ajoute l'index `compteId` et le magasin des photos.
 * Aucune ne doit supprimer ni recreer un magasin existant.
 *
 * CE QUI EST EPROUVE, ET CE QUI NE L'EST PAS
 *
 * Un vrai moteur IndexedDB (fake-indexeddb) et des bases construites a la main dans la forme exacte de chaque version
 * (magasins, cle `localId`, enregistrements EN CLAIR comme les ecrivait l'application d'alors). Il prouve que NOTRE
 * code de migration est additif ; il ne prouve pas le comportement d'un vrai navigateur (Safari, Chrome Android).
 *
 * LES ENREGISTREMENTS EN CLAIR D'UNE ANCIENNE VERSION restent PHYSIQUEMENT en place dans une base de compte (c'est le sens de
 * « sans perte »), mais l'application ne les rend jamais : ils sont signales par `lireIllisibles` (« format inconnu »).
 * Leur reprise, chiffree, est le travail de `migrationHeritage.ts` sur l'ancienne base `bdri-offline`.
 */

const MAGASINS_PAR_VERSION: Record<number, string[]> = {
  1: ["pending_inspections"],
  2: ["pending_inspections", "pending_defauts"],
  3: ["pending_inspections", "pending_defauts", "pending_portions"],
  4: ["pending_inspections", "pending_defauts", "pending_portions", "pending_observations"],
};

const CLAIR: Record<string, Record<string, unknown>[]> = {
  pending_inspections: [{ localId: "insp-1", ownerUserId: "agent-A", status: "pending", payload: { etatObserve: "MAUVAIS", dateInspection: "2026-10-20" }, photos: [], createdAt: "2026-10-20T08:00:00.000Z" }],
  pending_defauts: [
    { localId: "def-1", ownerUserId: "agent-A", status: "error", createdAt: "2026-10-20T08:01:00.000Z" },
    { localId: "def-2", ownerUserId: "agent-A", status: "pending", createdAt: "2026-10-20T08:02:00.000Z" },
  ],
  pending_portions: [{ localId: "por-1", ownerUserId: "agent-A", status: "abandonnee", refusDefinitif: true, createdAt: "2026-10-20T08:03:00.000Z" }],
  pending_observations: [{ localId: "obs-1", ownerUserId: "agent-A", status: "pending", createdAt: "2026-10-20T08:04:00.000Z" }],
};

/** Une base telle que la version `version` de l'application l'a laissee, avec des saisies non remontees. */
async function baseDeVersion(nom: string, version: number): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(nom, version);
    r.onupgradeneeded = () => { for (const m of MAGASINS_PAR_VERSION[version]) r.result.createObjectStore(m, { keyPath: "localId" }); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  await new Promise<void>((resolve) => {
    const tx = db.transaction(MAGASINS_PAR_VERSION[version], "readwrite");
    for (const m of MAGASINS_PAR_VERSION[version]) for (const e of CLAIR[m]) tx.objectStore(m).put(e);
    tx.oncomplete = () => resolve();
  });
  db.close();
}

async function contenuBrut(nom: string): Promise<{ version: number; magasins: Record<string, string[]>; indexes: Record<string, string[]> }> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(nom); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const magasins: Record<string, string[]> = {};
  const indexes: Record<string, string[]> = {};
  const tx = db.transaction(Array.from(db.objectStoreNames), "readonly");
  for (const m of Array.from(db.objectStoreNames)) {
    indexes[m] = Array.from(tx.objectStore(m).indexNames);
    magasins[m] = await new Promise<string[]>((resolve) => {
      const r = tx.objectStore(m).getAllKeys();
      r.onsuccess = () => resolve((r.result as string[]).sort());
    });
  }
  const version = db.version;
  db.close();
  return { version, magasins, indexes };
}

let empreinte = "";
async function ouvrirAgentA() {
  const coffre = await creerCoffre({
    stockage: stockageEnMemoire(), compteId: "agent-A", appareilId: "tel-1", pin: "246810", maintenantMs: Date.now(), iterations: 1000, iterationsDeTest: true,
    profil: { userId: "agent-A", nom: "A", role: "INSPECTEUR", modules: [], regions: [] },
  });
  empreinte = await empreinteCompte("agent-A", sha256WebCrypto);
  ouvrirCompte({ compteId: "agent-A", empreinte, chiffreur: coffre });
}

const obs = (localId: string): PendingObservation => ({
  localId, createdAt: "2026-10-25T08:00:00.000Z", status: "pending",
  payload: { type: "DEGRADATION", description: "x", observeA: "2026-10-25T08:00:00.000Z" },
});

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("localStorage", { length: 0, key: () => null, getItem: () => null, setItem: () => undefined, removeItem: () => undefined, clear: () => undefined });
  fermerCompte();
});
afterEach(() => {
  vi.restoreAllMocks();
  fermerCompte();
});

describe("migration additive de la base locale (versions 1 a 4 -> 5)", () => {
  for (const version of [1, 2, 3, 4]) {
    it(`v${version} -> v5 : tous les enregistrements restent en place, les magasins et index manquants sont crees, aucun magasin n'est supprime`, async () => {
      await ouvrirAgentA();
      const nom = nomBaseOffline(empreinte);
      await baseDeVersion(nom, version);
      const suppressions = vi.spyOn(FauxIDBDatabase.prototype, "deleteObjectStore");

      expect(await getAllPending()).toEqual([]); // ouvre a la version 5 : declenche la migration
      expect(suppressions).not.toHaveBeenCalled();

      const apres = await contenuBrut(nom);
      expect(apres.version).toBe(5);
      expect(Object.keys(apres.magasins).sort()).toEqual(["pending_defauts", "pending_inspections", "pending_observations", "pending_photos", "pending_portions"]);
      for (const m of MAGASINS_PAR_VERSION[version]) {
        expect(apres.magasins[m]).toEqual(CLAIR[m].map((e) => e.localId as string).sort());
      }
      for (const m of ["pending_defauts", "pending_inspections", "pending_observations", "pending_portions"]) expect(apres.indexes[m]).toContain("compteId");
      expect(apres.indexes.pending_photos).toContain("parSaisie");
    });
  }

  it("les anciens enregistrements en clair ne sont JAMAIS rendus par l'application : signales « format inconnu », comptes, conserves", async () => {
    await ouvrirAgentA();
    await baseDeVersion(nomBaseOffline(empreinte), 3);
    expect(await getAllPending()).toEqual([]);
    expect(await getAllPendingDefauts()).toEqual([]);
    expect(await getAllPendingPortions()).toEqual([]);
    const illisibles = await lireIllisibles();
    expect(illisibles.map((i) => `${i.file}:${i.localId}:${i.nature}`).sort()).toEqual([
      "defauts:def-1:FORMAT_INCONNU", "defauts:def-2:FORMAT_INCONNU", "inspections:insp-1:FORMAT_INCONNU", "portions:por-1:FORMAT_INCONNU",
    ]);
    expect((await compterFile()).total).toBe(4);
  });

  it("une saisie chiffree et d'anciennes saisies en clair cohabitent dans la meme base sans se gener", async () => {
    await ouvrirAgentA();
    await baseDeVersion(nomBaseOffline(empreinte), 4);
    await addPendingObservation(obs("obs-neuve"));
    expect((await getAllPendingObservations()).map((o) => o.localId)).toEqual(["obs-neuve"]);
    const brut = await contenuBrut(nomBaseOffline(empreinte));
    expect(brut.magasins.pending_observations).toEqual(["obs-1", "obs-neuve"]);
  });

  it("une installation neuve cree les quatre files et le magasin des photos", async () => {
    await ouvrirAgentA();
    expect(await getAllPendingObservations()).toEqual([]);
    expect(Object.keys((await contenuBrut(nomBaseOffline(empreinte))).magasins).sort()).toEqual(
      ["pending_defauts", "pending_inspections", "pending_observations", "pending_photos", "pending_portions"]);
  });

  it("rouvrir une base deja en version 5 ne touche a rien (pas de nouvelle migration, donnees intactes)", async () => {
    await ouvrirAgentA();
    await baseDeVersion(nomBaseOffline(empreinte), 4);
    await addPendingObservation(obs("o-1"));
    const suppressions = vi.spyOn(FauxIDBDatabase.prototype, "deleteObjectStore");
    await getAllPendingObservations();
    await getAllPendingObservations();
    expect(suppressions).not.toHaveBeenCalled();
    expect((await getAllPendingObservations()).map((o) => o.localId)).toEqual(["o-1"]);
    expect((await contenuBrut(nomBaseOffline(empreinte))).version).toBe(5);
  });
});
