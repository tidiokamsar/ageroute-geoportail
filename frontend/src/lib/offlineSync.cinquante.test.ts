import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * A7 : « hors ligne, 50 observations, 0 doublon, 0 perte », cote file locale.
 *
 * CE QUE CES TESTS FONT ET NE FONT PAS
 *
 * Une file de 50 saisies est rejouee contre un SERVEUR SIMULE qui respecte le protocole
 * d'idempotence (meme cle = meme resultat, jamais deux creations), au travers d'un RESEAU SIMULE
 * qui coupe, perd des reponses, puis revient. Le serveur reel est eprouve a part, en base, par
 * `backend/tests-integration/sync.integration.mts`.
 *
 * Ce n'est PAS une preuve sur appareil : IndexedDB, le service worker, l'evenement `online` d'un
 * vrai telephone et la perte de reseau reelle ne s'eprouvent que sur un appareil. Le magasin
 * local est ici un Map, comme dans `offlineSync.test.ts`.
 *
 * Ce fichier porte les 50 saisies en DEFAUTS et en PORTIONS. La file locale d'OBSERVATIONS (livree
 * ensuite) est eprouvee dans `offlineSync.observations.test.ts`, avec un serveur simule qui applique les
 * regles du vrai protocole.
 */

type Panne = "aucune" | "coupure" | "reponse_perdue" | "erreur_serveur";

const serveur = {
  /** operationId -> entityId : ce que le serveur a deja traite (jamais deux fois). */
  traitees: new Map<string, string>(),
  /** Une entree par creation REELLE. Un doublon y apparaitrait deux fois. */
  creations: [] as string[],
  appels: 0,
};
let panne: (appel: number) => Panne = () => "aucune";

function erreurReseau(): Error {
  // Forme d'une erreur axios sans reponse : le serveur n'a rien repondu.
  return Object.assign(new Error("Network Error"), { isAxiosError: true, code: "ERR_NETWORK", response: undefined });
}

vi.mock("./api", () => ({
  api: {
    post: vi.fn(async (url: string, corps: { operations?: { operationId: string; entityType: string }[] }) => {
      if (url === "/v2/devices") return { data: { id: "device-u1" } };
      if (url !== "/v2/sync/push") throw new Error(`appel inattendu ${url}`);
      serveur.appels += 1;
      const p = panne(serveur.appels);
      if (p === "coupure") throw erreurReseau();           // la requete n'arrive jamais
      if (p === "erreur_serveur") {
        throw Object.assign(new Error("Request failed with status code 500"), { isAxiosError: true, response: { status: 500, data: { message: "erreur interne" } } });
      }
      const op = corps.operations![0];
      let resultat: Record<string, unknown>;
      if (serveur.traitees.has(op.operationId)) {
        resultat = { operationId: op.operationId, statut: "REJOUEE", entityId: serveur.traitees.get(op.operationId) };
      } else {
        serveur.traitees.set(op.operationId, op.operationId);
        serveur.creations.push(op.operationId);
        resultat = { operationId: op.operationId, statut: "SYNCHRONISE", entityId: op.operationId };
      }
      if (p === "reponse_perdue") throw erreurReseau();    // le serveur a ecrit, la reponse ne revient pas
      return { data: { resultats: [resultat] } };
    }),
  },
}));

const defautsLocaux = new Map<string, Record<string, unknown>>();
const portionsLocales = new Map<string, Record<string, unknown>>();
vi.mock("./offlineDb", () => ({
  getAllPending: vi.fn(async () => []),
  getAllPendingDefauts: vi.fn(async () => [...defautsLocaux.values()]),
  getAllPendingPortions: vi.fn(async () => [...portionsLocales.values()]),
  getAllPendingObservations: vi.fn(async () => []),
  updatePendingObservation: vi.fn(async () => undefined),
  removePendingObservation: vi.fn(async () => undefined),
  updatePendingInspection: vi.fn(async () => undefined),
  removePendingInspection: vi.fn(async () => undefined),
  updatePendingDefaut: vi.fn(async (i: { localId: string }) => { defautsLocaux.set(i.localId, i as Record<string, unknown>); }),
  removePendingDefaut: vi.fn(async (id: string) => { defautsLocaux.delete(id); }),
  updatePendingPortion: vi.fn(async (i: { localId: string }) => { portionsLocales.set(i.localId, i as Record<string, unknown>); }),
  removePendingPortion: vi.fn(async (id: string) => { portionsLocales.delete(id); }),
}));

import { api } from "./api";
import { configurerUtilisateurSync, syncPendingOfflineData } from "./offlineSync";

const uuid = (prefixe: string, n: number) => `${prefixe}${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`;

function deposerDefaut(localId: string) {
  defautsLocaux.set(localId, {
    localId, ownerUserId: "u1", status: "pending", createdAt: "2026-10-20T08:00:00.000Z",
    payload: { catalogueCode: "NID_POULE", lat: 9.5, lon: -13.7, constateA: "2026-10-20T08:00:00.000Z", mesures: { nombre: 2 } },
  });
}
function deposerPortion(localId: string) {
  portionsLocales.set(localId, {
    localId, ownerUserId: "u1", status: "pending", createdAt: "2026-10-20T08:00:00.000Z",
    payload: { tronconId: "33333333-3333-4333-8333-333333333333", debutM: 0, finM: 100, observeeLe: "2026-10-20T08:00:00.000Z" },
  });
}

/** Tout ce que la file porte encore, quel que soit son statut. */
const enFile = () => [...defautsLocaux.values(), ...portionsLocales.values()];

beforeEach(() => {
  defautsLocaux.clear();
  portionsLocales.clear();
  serveur.traitees.clear();
  serveur.creations.length = 0;
  serveur.appels = 0;
  panne = () => "aucune";
  vi.mocked(api.post).mockClear();
  localStorage.clear();
  configurerUtilisateurSync("u1");
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

/** Rejoue les passes de synchronisation jusqu'a file vide, au plus `max` fois. */
async function jusquaVide(max: number): Promise<number> {
  for (let passe = 1; passe <= max; passe++) {
    await syncPendingOfflineData();
    if (enFile().length === 0) return passe;
  }
  return max;
}

describe("A7, file locale de 50 saisies rejouee dans de mauvaises conditions", () => {
  it("50 defauts sur un reseau sain : 50 creations, file vide", async () => {
    for (let i = 0; i < 50; i++) deposerDefaut(uuid("a", i));
    await syncPendingOfflineData();
    expect(serveur.creations).toHaveLength(50);
    expect(new Set(serveur.creations).size).toBe(50);
    expect(enFile()).toHaveLength(0);
  });

  it("une coupure au milieu de la file : la reprise ne refait que le reste, sans doublon", async () => {
    for (let i = 0; i < 50; i++) deposerDefaut(uuid("b", i));
    panne = (appel) => (appel > 20 && appel <= 25 ? "coupure" : "aucune");   // le reseau tombe apres 20 envois
    await syncPendingOfflineData();
    expect(serveur.creations).toHaveLength(45);   // 20 avant la coupure + 25 apres : les 5 envois coupes manquent
    expect(enFile()).toHaveLength(5);             // ... et restent en file
    await syncPendingOfflineData();
    expect(serveur.creations).toHaveLength(50);
    expect(new Set(serveur.creations).size).toBe(50);
    expect(enFile()).toHaveLength(0);
  });

  it("des reponses perdues : le serveur a ecrit, le telephone renvoie, aucun doublon ne nait", async () => {
    for (let i = 0; i < 50; i++) deposerDefaut(uuid("c", i));
    panne = (appel) => (appel % 3 === 0 ? "reponse_perdue" : "aucune");
    const passes = await jusquaVide(10);
    expect(passes).toBeLessThanOrEqual(10);
    expect(enFile()).toHaveLength(0);
    expect(serveur.creations).toHaveLength(50);
    expect(new Set(serveur.creations).size).toBe(50);
  });

  it("DEFAUT CORRIGE : six coupures d'affilee n'abandonnent PAS les saisies, elles passent au retour du reseau", async () => {
    for (let i = 0; i < 50; i++) deposerDefaut(uuid("d", i));
    panne = () => "coupure";
    for (let i = 0; i < 6; i++) await syncPendingOfflineData();           // six retours d'« online » sans reseau reel
    expect(serveur.creations).toHaveLength(0);
    expect(enFile()).toHaveLength(50);
    expect(enFile().some((i) => i.status === "abandonnee")).toBe(false);   // c'etait le defaut : 50 saisies abandonnees
    panne = () => "aucune";
    await syncPendingOfflineData();
    expect(serveur.creations).toHaveLength(50);
    expect(new Set(serveur.creations).size).toBe(50);
    expect(enFile()).toHaveLength(0);
  });

  it("30 defauts et 20 portions, reseau intermittent avec reponses perdues : 50 creations exactement", async () => {
    for (let i = 0; i < 30; i++) deposerDefaut(uuid("e", i));
    for (let i = 0; i < 20; i++) deposerPortion(uuid("f", i));
    panne = (appel) => (appel <= 10 ? "coupure" : appel % 4 === 0 ? "reponse_perdue" : appel % 7 === 0 ? "coupure" : "aucune");
    const passes = await jusquaVide(20);
    expect(passes).toBeLessThan(20);
    expect(enFile()).toHaveLength(0);
    expect(serveur.creations).toHaveLength(50);
    expect(new Set(serveur.creations).size).toBe(50);
    // 0 perte : chaque saisie deposee a bien ete creee, sous sa propre cle.
    const attendues = [...Array.from({ length: 30 }, (_, i) => uuid("e", i)), ...Array.from({ length: 20 }, (_, i) => uuid("f", i))].sort();
    expect([...serveur.creations].sort()).toEqual(attendues);
  });

  it("le renvoi repart toujours de la meme cle : aucune cle nouvelle n'apparait pendant les reprises", async () => {
    for (let i = 0; i < 10; i++) deposerDefaut(uuid("g", i));
    const cles = new Set<string>();
    panne = (appel) => (appel % 2 === 0 ? "reponse_perdue" : "aucune");
    await jusquaVide(10);
    for (const [url, corps] of vi.mocked(api.post).mock.calls as [string, { operations?: { operationId: string }[] }][]) {
      if (url === "/v2/sync/push") cles.add(corps.operations![0].operationId);
    }
    expect([...cles].sort()).toEqual(Array.from({ length: 10 }, (_, i) => uuid("g", i)).sort());
  });

  it("une erreur du SERVEUR (pas du reseau) compte toujours : elle finit par abandonner, en conservant la saisie", async () => {
    deposerDefaut(uuid("h", 1));
    panne = () => "erreur_serveur";
    for (let i = 0; i < 6; i++) await syncPendingOfflineData();
    const item = defautsLocaux.get(uuid("h", 1));
    expect(item?.status).toBe("abandonnee");
    expect(defautsLocaux.has(uuid("h", 1))).toBe(true);
  });
});
