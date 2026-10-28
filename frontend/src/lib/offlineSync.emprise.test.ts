import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Le contour GPS d'un defaut (champ `emprise`, scenario A5) traverse la file hors ligne SANS ETRE ALTERE :
 * ce que le telephone a mis dans la file est, a l'octet pres, ce que `POST /v2/sync/push` recoit. La file ne calcule,
 * n'ajoute et ne retire rien (surtout pas une surface). Un refus du serveur (contour invalide) laisse le defaut dans la
 * file, avec son motif, pour que l'agent le corrige : il n'est ni perdu ni retente sans fin.
 * Meme montage que `offlineSync.test.ts` (api et base locale simulees) ; IndexedDB reel n'est pas exerce ici.
 */

let reponsePush: Record<string, unknown> = { statut: "SYNCHRONISE", entityId: "defaut-serveur-1" };

vi.mock("./api", () => ({
  api: {
    post: vi.fn(async (url: string) => {
      if (url === "/v2/devices") return { data: { id: "device-u1" } };
      if (url === "/v2/sync/push") return { data: { resultats: [reponsePush] } };
      return { data: {} };
    }),
  },
}));

const defautsLocaux = new Map<string, Record<string, unknown>>();
vi.mock("./offlineDb", () => ({
  getAllPending: vi.fn(async () => []),
  getAllPendingDefauts: vi.fn(async () => [...defautsLocaux.values()]),
  getAllPendingPortions: vi.fn(async () => []),
  updatePendingInspection: vi.fn(async () => undefined),
  updatePendingDefaut: vi.fn(async (item: { localId: string }) => { defautsLocaux.set(item.localId, item as Record<string, unknown>); }),
  removePendingInspection: vi.fn(async () => undefined),
  removePendingDefaut: vi.fn(async (localId: string) => { defautsLocaux.delete(localId); }),
  updatePendingPortion: vi.fn(async () => undefined),
  removePendingPortion: vi.fn(async () => undefined),
  getAllPendingObservations: vi.fn(async () => []),
  updatePendingObservation: vi.fn(async () => undefined),
  removePendingObservation: vi.fn(async () => undefined),
}));

import { api } from "./api";
import { configurerUtilisateurSync, syncPendingOfflineData } from "./offlineSync";

const EMPRISE = {
  type: "Polygon" as const,
  coordinates: [[[-13.6, 9.64], [-13.59991, 9.64], [-13.59991, 9.64009], [-13.6, 9.64009], [-13.6, 9.64]]],
};
const ID = "33333333-3333-4333-8333-333333333333";

function deposer() {
  defautsLocaux.set(ID, {
    localId: ID,
    ownerUserId: "u1",
    payload: { catalogueCode: "FAIENCAGE", lat: 9.64, lon: -13.6, precisionM: 5, constateA: "2026-10-23T09:00:00.000Z", gravite: 2, emprise: EMPRISE },
    createdAt: "2026-10-23T09:00:00.000Z",
    status: "pending",
  });
}

beforeEach(() => {
  defautsLocaux.clear();
  reponsePush = { statut: "SYNCHRONISE", entityId: "defaut-serveur-1" };
  vi.mocked(api.post).mockClear();
  localStorage.clear();
  configurerUtilisateurSync("u1");
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

describe("emprise d'un defaut dans la file hors ligne", () => {
  it("part dans la charge de synchronisation exactement comme saisie, sans surface ni champ ajoute", async () => {
    deposer();
    await syncPendingOfflineData();
    const pushes = vi.mocked(api.post).mock.calls.filter((c) => c[0] === "/v2/sync/push");
    expect(pushes).toHaveLength(1);
    const operation = (pushes[0][1] as { operations: { entityType: string; payload: Record<string, unknown> }[] }).operations[0];
    expect(operation.entityType).toBe("Defaut");
    expect(operation.payload.emprise).toEqual(EMPRISE);
    expect(Object.keys(operation.payload).sort()).toEqual(["catalogueCode", "constateA", "emprise", "gravite", "lat", "lon", "precisionM"]);
    expect(defautsLocaux.size).toBe(0);
  });

  it("un contour refuse par le serveur reste dans la file avec son motif, emprise intacte, pour etre corrige", async () => {
    reponsePush = { statut: "REJETE", motif: "EMPRISE_INVALIDE" };
    deposer();
    await syncPendingOfflineData();
    const reste = defautsLocaux.get(ID) as { status: string; errorMessage: string; payload: { emprise: unknown } };
    expect(reste.status).toBe("error");
    expect(reste.errorMessage).toContain("EMPRISE_INVALIDE");
    expect(reste.payload.emprise).toEqual(EMPRISE);
  });
});
