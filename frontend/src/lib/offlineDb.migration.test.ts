import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * La migration de la base locale (version 3 -> 4) ne doit RIEN perdre.
 *
 * POURQUOI CE TEST EXISTE
 *
 * Un agent peut avoir des saisies non remontees sur son telephone au moment ou l'application se met a jour.
 * Recreer la base les effacerait, et une saisie de terrain perdue ne se refait pas. La version 4 ajoute le
 * magasin des observations ; elle ne doit ni supprimer ni recreer les trois autres.
 *
 * CE QUI EST EPROUVE, ET CE QUI NE L'EST PAS
 *
 * jsdom n'a pas IndexedDB et `fake-indexeddb` n'est pas installe : le test fournit une implementation minimale
 * en memoire, qui reproduit la SEMANTIQUE DE VERSION d'IndexedDB (ouverture a une version superieure ->
 * `upgradeneeded` avec `oldVersion`, les magasins existants restent, `deleteObjectStore` est une migration
 * destructive que le test interdit). Il prouve que NOTRE code de migration est additif contre ce modele ; il ne
 * prouve pas le comportement d'un vrai navigateur (Safari, Chrome Android), qui reste a eprouver sur appareil.
 */

type Magasin = Map<string, unknown>;
interface BaseFausse { version: number; magasins: Map<string, { cle: string; donnees: Magasin }> }
const bases = new Map<string, BaseFausse>();
const destructions: string[] = [];
/** Si renseigne, la PROCHAINE transaction d'ecriture est annulee (`abort`) avec cette erreur, comme sur un quota atteint. */
let abandon: { name: string; message: string } | null = null;

function requete<T>(resultat: T) {
  const r: { result: T; error: null; onsuccess: (() => void) | null; onerror: (() => void) | null } =
    { result: resultat, error: null, onsuccess: null, onerror: null };
  setTimeout(() => r.onsuccess?.(), 0);
  return r;
}

function fauxIndexedDB() {
  return {
    open(nom: string, version: number) {
      const req: { result: unknown; error: null; onsuccess: (() => void) | null; onerror: (() => void) | null; onupgradeneeded: (() => void) | null } =
        { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      setTimeout(() => {
        let base = bases.get(nom);
        const ancienne = base?.version ?? 0;
        if (!base) { base = { version: 0, magasins: new Map() }; bases.set(nom, base); }
        const db = {
          get objectStoreNames() { return { contains: (n: string) => base!.magasins.has(n) }; },
          createObjectStore(n: string, opts: { keyPath: string }) {
            if (base!.magasins.has(n)) throw new Error(`magasin deja present : ${n}`);
            base!.magasins.set(n, { cle: opts.keyPath, donnees: new Map() });
          },
          deleteObjectStore(n: string) { destructions.push(n); base!.magasins.delete(n); },
          close() { /* rien */ },
          transaction(n: string) {
            const m = base!.magasins.get(n);
            if (!m) throw new Error(`magasin inconnu : ${n}`);
            const tx: { oncomplete: (() => void) | null; onerror: (() => void) | null; onabort: (() => void) | null; error: { name: string; message: string } | null; objectStore: () => unknown } = {
              oncomplete: null, onerror: null, onabort: null, error: null,
              objectStore: () => ({
                put: (item: Record<string, unknown>) => { m.donnees.set(String(item[m.cle]), item); return requete(undefined); },
                delete: (k: string) => { m.donnees.delete(k); return requete(undefined); },
                getAll: () => requete([...m.donnees.values()]),
              }),
            };
            const annulee = abandon;
            abandon = null;
            if (annulee) {
              // Un abandon par quota : ni `oncomplete` ni `onerror`, seulement `onabort`, et rien n'est ecrit.
              const ecrit = m.donnees;
              const copie = new Map(ecrit);
              setTimeout(() => { ecrit.clear(); copie.forEach((v, k) => ecrit.set(k, v)); tx.error = annulee; tx.onabort?.(); }, 0);
            } else {
              setTimeout(() => tx.oncomplete?.(), 0);
            }
            return tx;
          },
        };
        req.result = db;
        if (ancienne < version) {
          base.version = version;
          req.onupgradeneeded?.();
        }
        req.onsuccess?.();
      }, 0);
      return req;
    },
  };
}

/** Une base telle que la version 3 de l'application l'a laissee, avec des saisies non remontees. */
function baseVersion3() {
  const m = (cle: string, items: Record<string, unknown>[]) => ({ cle, donnees: new Map(items.map((i) => [String(i[cle]), i])) as Magasin });
  bases.set("bdri-offline", {
    version: 3,
    magasins: new Map([
      ["pending_inspections", m("localId", [{ localId: "insp-1", ownerUserId: "u1", status: "pending", payload: { etatObserve: "MAUVAIS" }, photos: [] }])],
      ["pending_defauts", m("localId", [{ localId: "def-1", ownerUserId: "u1", status: "error" }, { localId: "def-2", ownerUserId: "u1", status: "pending" }])],
      ["pending_portions", m("localId", [{ localId: "por-1", ownerUserId: "u1", status: "abandonnee", refusDefinitif: true }])],
    ]),
  });
}

beforeEach(() => {
  bases.clear();
  destructions.length = 0;
  abandon = null;
  vi.stubGlobal("indexedDB", fauxIndexedDB());
});
afterEach(() => vi.unstubAllGlobals());

import {
  addPendingDefaut, addPendingInspection, addPendingPortion, removePendingDefaut, removePendingInspection, removePendingPortion,
  addPendingObservation, getAllPending, getAllPendingDefauts, getAllPendingObservations, getAllPendingPortions,
  removePendingObservation, updatePendingObservation, type PendingObservation,
} from "./offlineDb";

const obs = (localId: string, over: Partial<PendingObservation> = {}): PendingObservation => ({
  localId, ownerUserId: "u1", createdAt: "2026-10-23T08:00:00.000Z", status: "pending",
  payload: { type: "DEGRADATION", description: "x", observeA: "2026-10-23T08:00:00.000Z" }, ...over,
});

describe("migration additive de la base locale (v3 -> v4)", () => {
  it("conserve TOUTES les saisies non remontees des trois magasins existants et cree celui des observations", async () => {
    baseVersion3();
    expect(await getAllPendingObservations()).toEqual([]);   // ouvre a la version 4 : declenche la migration

    const base = bases.get("bdri-offline")!;
    expect(base.version).toBe(4);
    expect([...base.magasins.keys()].sort()).toEqual(["pending_defauts", "pending_inspections", "pending_observations", "pending_portions"]);
    expect(destructions).toEqual([]);   // aucune suppression de magasin : migration non destructive

    expect((await getAllPending()).map((i) => i.localId)).toEqual(["insp-1"]);
    expect((await getAllPendingDefauts()).map((i) => i.localId).sort()).toEqual(["def-1", "def-2"]);
    const portions = await getAllPendingPortions();
    expect(portions).toHaveLength(1);
    expect(portions[0]).toMatchObject({ localId: "por-1", status: "abandonnee", refusDefinitif: true });
  });

  it("une installation neuve cree les quatre magasins", async () => {
    expect(await getAllPendingObservations()).toEqual([]);
    expect([...bases.get("bdri-offline")!.magasins.keys()].sort()).toEqual(
      ["pending_defauts", "pending_inspections", "pending_observations", "pending_portions"]);
  });

  it("rouvrir une base deja en version 4 ne touche a rien (pas de nouvelle migration, donnees intactes)", async () => {
    baseVersion3();
    await addPendingObservation(obs("o-1"));
    await getAllPendingObservations();   // v4 deja la
    expect(await getAllPendingObservations()).toHaveLength(1);
    expect(destructions).toEqual([]);
  });
});

describe("file d'observations : ecriture, relecture, mise a jour, retrait", () => {
  it("ajoute, relit, met a jour (meme cle : une seule ligne) et retire", async () => {
    await addPendingObservation(obs("o-1"));
    await addPendingObservation(obs("o-2"));
    expect((await getAllPendingObservations()).map((o) => o.localId).sort()).toEqual(["o-1", "o-2"]);

    await updatePendingObservation(obs("o-1", { status: "conflit", conflitId: "c-1", motifConflit: "DEJA_EXISTANTE" }));
    const toutes = await getAllPendingObservations();
    expect(toutes).toHaveLength(2);   // mise a jour, pas doublon
    expect(toutes.find((o) => o.localId === "o-1")).toMatchObject({ status: "conflit", conflitId: "c-1" });

    await removePendingObservation("o-2");
    expect((await getAllPendingObservations()).map((o) => o.localId)).toEqual(["o-1"]);
  });
});

/**
 * Une transaction d'ecriture annulee (quota du stockage) doit REJETER, pas rester pendante.
 *
 * Constate par audit : seules les observations ecoutaient `onabort`. Pour les inspections, les defauts et les
 * portions, un abandon par quota ne declenchait ni `oncomplete` ni `onerror` : la promesse ne se resolvait
 * jamais, l'ecran de saisie attendait sans fin et l'agent croyait sa saisie enregistree. Le faux IndexedDB
 * ci-dessus simule cet abandon (`abandon`) ; le comportement d'un vrai navigateur reste a eprouver sur appareil.
 */
describe("ecriture annulee par le navigateur (quota) : la promesse rejette avec un message clair", () => {
  const quota = { name: "QuotaExceededError", message: "quota" };
  const insp = { localId: "i-1", ownerUserId: "u1", status: "pending", payload: { etatObserve: "MAUVAIS", dateInspection: "2026-10-23" }, photos: [], createdAt: "x" } as never;
  const def = { localId: "d-1", ownerUserId: "u1", status: "pending", payload: { catalogueCode: "NID_POULE", constateA: "x" }, createdAt: "x" } as never;
  const por = { localId: "p-1", ownerUserId: "u1", status: "pending", payload: { tronconId: "t", debutM: 0, finM: 10 }, createdAt: "x" } as never;

  const cas: [string, () => Promise<void>][] = [
    ["inspection", () => addPendingInspection(insp)],
    ["defaut", () => addPendingDefaut(def)],
    ["portion", () => addPendingPortion(por)],
    ["observation", () => addPendingObservation(obs("o-1"))],
  ];
  for (const [nom, ecrire] of cas) {
    it(`${nom} : un abandon par quota REJETTE avec le message « Stockage de l'appareil plein »`, async () => {
      baseVersion3();
      await getAllPendingObservations();   // migration faite avant d'armer l'abandon
      abandon = quota;
      await expect(ecrire()).rejects.toThrow(/Stockage de l'appareil plein.*n'est PAS enregistrée/);
    });
  }

  it("un abandon d'une autre nature rejette aussi, avec sa cause", async () => {
    await getAllPendingObservations();
    abandon = { name: "AbortError", message: "transaction interrompue" };
    await expect(addPendingDefaut(def)).rejects.toThrow(/Écriture locale annulée.*transaction interrompue/);
  });

  it("les retraits rejettent eux aussi au lieu de rester pendants", async () => {
    baseVersion3();
    await getAllPendingObservations();
    abandon = quota; await expect(removePendingInspection("insp-1")).rejects.toThrow(/Stockage/);
    abandon = quota; await expect(removePendingDefaut("def-1")).rejects.toThrow(/Stockage/);
    abandon = quota; await expect(removePendingPortion("por-1")).rejects.toThrow(/Stockage/);
  });

  it("une ecriture normale reste possible apres un abandon (l'etat d'avant est intact)", async () => {
    baseVersion3();
    await getAllPendingObservations();
    abandon = quota;
    await expect(addPendingDefaut(def)).rejects.toBeDefined();
    expect((await getAllPendingDefauts()).map((d) => d.localId).sort()).toEqual(["def-1", "def-2"]);
    await addPendingDefaut(def);
    expect((await getAllPendingDefauts()).map((d) => d.localId).sort()).toEqual(["d-1", "def-1", "def-2"]);
  });
});
