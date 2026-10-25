import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Les photos d'une observation traversent la file hors ligne SANS RIEN PERDRE. Ce que ces tests défendent :
 *   - la création de l'observation part d'abord (`/v2/sync/push`), puis chaque photo, une à une, vers
 *     `/v2/observations/:id/photos`, avec sa position et sa date de prise ;
 *   - l'observation ne quitte la file qu'avec sa DERNIÈRE photo confirmée ;
 *   - une coupure au milieu reprend à la photo suivante : les photos déjà confirmées ne repartent pas, l'observation n'est
 *     pas recréée, et la saisie reste en file avec les photos restantes (une photo de terrain perdue ne se refait pas) ;
 *   - un refus de la création laisse l'observation ET ses photos en file : aucune photo n'est envoyée sans observation.
 * Montage de `offlineSync.emprise.test.ts` : api et base locale simulées ; IndexedDB réel n'est pas exercé ici.
 */

const h = vi.hoisted(() => ({
  reponsePush: { statut: "SYNCHRONISE", entityId: "obs-1" } as Record<string, unknown>,
  /** Nombre d'envois de photo à laisser passer avant de couper le réseau (`null` : jamais). */
  coupureApres: null as number | null,
  photosRecues: 0,
}));

vi.mock("./api", () => ({
  api: {
    post: vi.fn(async (url: string, corps?: unknown) => {
      if (url === "/v2/devices") return { data: { id: "device-u1" } };
      if (url === "/v2/sync/push") return { data: { resultats: [h.reponsePush] } };
      if (/^\/v2\/observations\/[^/]+\/photos$/.test(url)) {
        if (h.coupureApres !== null && h.photosRecues >= h.coupureApres) throw Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" });
        h.photosRecues += 1;
        void corps;
        return { data: { id: `m${h.photosRecues}` } };
      }
      return { data: {} };
    }),
  },
}));

const observations = new Map<string, Record<string, unknown>>();
vi.mock("./offlineDb", () => ({
  getAllPending: vi.fn(async () => []),
  getAllPendingDefauts: vi.fn(async () => []),
  getAllPendingPortions: vi.fn(async () => []),
  getAllPendingObservations: vi.fn(async () => [...observations.values()].map((o) => ({ ...o }))),
  updatePendingInspection: vi.fn(async () => undefined),
  updatePendingDefaut: vi.fn(async () => undefined),
  updatePendingPortion: vi.fn(async () => undefined),
  updatePendingObservation: vi.fn(async (item: { localId: string }) => { observations.set(item.localId, item as Record<string, unknown>); }),
  removePendingInspection: vi.fn(async () => undefined),
  removePendingDefaut: vi.fn(async () => undefined),
  removePendingPortion: vi.fn(async () => undefined),
  removePendingObservation: vi.fn(async (localId: string) => { observations.delete(localId); }),
}));

import { api } from "./api";
import { configurerUtilisateurSync, syncPendingOfflineData } from "./offlineSync";

const ID = "44444444-4444-4444-8444-444444444444";

function photo(n: number) {
  return { name: `p${n}.jpg`, blob: new Blob([`octets-${n}`], { type: "image/jpeg" }), lat: 9.64 + n / 1000, lon: -13.6, precisionM: 6, capturedA: `2026-10-25T09:0${n}:00.000Z` };
}

function deposer(nbPhotos: number) {
  observations.set(ID, {
    localId: ID, ownerUserId: "u1", status: "pending", createdAt: "2026-10-25T09:00:00.000Z",
    payload: { type: "DEGRADATION", gravite: "FORTE", lat: 9.64, lon: -13.6, precisionM: 6, observeA: "2026-10-25T09:00:00.000Z" },
    photos: Array.from({ length: nbPhotos }, (_, i) => photo(i + 1)),
  });
}

const appels = (prefixe: string) => vi.mocked(api.post).mock.calls.filter((c) => String(c[0]).startsWith(prefixe));

beforeEach(() => {
  observations.clear();
  h.reponsePush = { statut: "SYNCHRONISE", entityId: "obs-1" };
  h.coupureApres = null;
  h.photosRecues = 0;
  vi.mocked(api.post).mockClear();
  localStorage.clear();
  configurerUtilisateurSync("u1");
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

describe("photos d'une observation dans la file hors ligne", () => {
  it("la création part d'abord, puis chaque photo avec position et date ; la file se vide avec la dernière", async () => {
    deposer(3);
    await syncPendingOfflineData();
    const urls = vi.mocked(api.post).mock.calls.map((c) => String(c[0])).filter((u) => u !== "/v2/devices");
    expect(urls).toEqual(["/v2/sync/push", "/v2/observations/obs-1/photos", "/v2/observations/obs-1/photos", "/v2/observations/obs-1/photos"]);
    const form = appels("/v2/observations/")[0][1] as FormData;
    expect(form.get("lat")).toBe("9.641");
    expect(form.get("lon")).toBe("-13.6");
    expect(form.get("precisionM")).toBe("6");
    expect(form.get("capturedA")).toBe("2026-10-25T09:01:00.000Z");
    expect(form.get("photo")).toBeInstanceOf(Blob);
    expect(observations.size).toBe(0);
  });

  it("une observation sans photo part comme avant : aucun envoi de fichier", async () => {
    deposer(0);
    await syncPendingOfflineData();
    expect(appels("/v2/observations/")).toHaveLength(0);
    expect(appels("/v2/sync/push")).toHaveLength(1);
    expect(observations.size).toBe(0);
  });

  it("une coupure après la première photo : la saisie reste, avec les deux photos restantes et son identifiant serveur", async () => {
    deposer(3);
    h.coupureApres = 1;
    await syncPendingOfflineData();
    const reste = observations.get(ID) as { photos: unknown[]; serverId: string; status: string };
    expect(reste.photos).toHaveLength(2);
    expect(reste.serverId).toBe("obs-1");
    expect(reste.status).toBe("error");
  });

  it("la reprise n'envoie que les photos restantes et ne recrée pas l'observation en double, sans perte", async () => {
    deposer(3);
    h.coupureApres = 1;
    await syncPendingOfflineData();
    vi.mocked(api.post).mockClear();
    h.coupureApres = null;
    h.reponsePush = { statut: "REJOUEE", entityId: "obs-1" };
    await syncPendingOfflineData();
    expect(appels("/v2/observations/")).toHaveLength(2);
    expect(h.photosRecues).toBe(3);
    expect(observations.size).toBe(0);
  });

  it("une création refusée garde l'observation ET ses photos en file : aucune photo n'est envoyée sans observation", async () => {
    deposer(2);
    h.reponsePush = { statut: "REJETE", motif: "PAYLOAD_INVALIDE:Observation" };
    await syncPendingOfflineData();
    expect(appels("/v2/observations/")).toHaveLength(0);
    const reste = observations.get(ID) as { photos: unknown[]; status: string };
    expect(reste.photos).toHaveLength(2);
    expect(reste.status).toBe("abandonnee");
  });
});
