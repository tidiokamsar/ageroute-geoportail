import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Synchronisation hors-ligne des inspections terrain.
 *
 * Non-regression du defaut de DOUBLON : la version precedente creait l'inspection,
 * envoyait les photos, et ne retirait l'element de la file qu'apres le succes de
 * TOUTES les photos. Une coupure pendant l'envoi d'une photo laissait donc l'element
 * complet en attente — et la synchronisation suivante RECREAIT l'inspection. Un
 * doublon par tentative, sur le module qui produit la donnee du reseau.
 *
 * Ces tests portent sur la file d'attente et les reprises, pas sur IndexedDB ni sur le
 * service worker : ceux-la ne s'eprouvent que sur un appareil reel.
 */

const appels = { creations: 0, photos: 0, defauts: 0, appareils: 0 };
let echouerPhotoNo = 0; // 0 = aucune ; n = echouer a la n-ieme photo
let echouerCreation = false;
let echouerDefaut = false;
let changerCompteApresPhoto = false;
let basculerCompte: () => void = () => undefined;

vi.mock("./api", () => ({
  api: {
    post: vi.fn(async (url: string) => {
      if (url === "/v2/devices") {
        appels.appareils++;
        return { data: { id: "device-u1" } };
      }
      if (url === "/v2/sync/push") {
        if (echouerDefaut) throw new Error("catalogue indisponible");
        appels.defauts++;
        return { data: { resultats: [{ statut: "SYNCHRONISE", entityId: `defaut-${appels.defauts}` }] } };
      }
      if (url === "/inspections") {
        if (echouerCreation) throw new Error("reseau indisponible");
        appels.creations++;
        return { data: { id: `srv-${appels.creations}` } };
      }
      appels.photos++;
      if (changerCompteApresPhoto && appels.photos === 1) basculerCompte();
      if (echouerPhotoNo > 0 && appels.photos === echouerPhotoNo) {
        throw new Error("coupure pendant l'envoi de la photo");
      }
      return { data: {} };
    }),
  },
}));

// Base locale simulee : un Map suffit, et evite de dependre d'IndexedDB sous jsdom.
const base = new Map<string, Record<string, unknown>>();
const defautsLocaux = new Map<string, Record<string, unknown>>();

vi.mock("./offlineDb", () => ({
  getAllPending: vi.fn(async () => [...base.values()]),
  getAllPendingDefauts: vi.fn(async () => [...defautsLocaux.values()]),
  updatePendingInspection: vi.fn(async (item: { localId: string }) => {
    base.set(item.localId, item as Record<string, unknown>);
  }),
  updatePendingDefaut: vi.fn(async (item: { localId: string }) => {
    defautsLocaux.set(item.localId, item as Record<string, unknown>);
  }),
  removePendingInspection: vi.fn(async (localId: string) => {
    base.delete(localId);
  }),
  removePendingDefaut: vi.fn(async (localId: string) => {
    defautsLocaux.delete(localId);
  }),
}));

import { api } from "./api";
import { configurerUtilisateurSync, syncPendingOfflineData } from "./offlineSync";
basculerCompte = () => configurerUtilisateurSync("u2");

function deposer(localId: string, nbPhotos: number) {
  base.set(localId, {
    localId,
    ownerUserId: "u1",
    payload: { tronconId: "t1", dateInspection: "2026-09-01", etatObserve: "MAUVAIS", lat: 9.5, lon: -13.7, precisionM: 8 },
    photos: Array.from({ length: nbPhotos }, (_, i) => ({ name: `p${i}.jpg`, blob: new Blob(["x"]) })),
    createdAt: "2026-09-01T00:00:00Z",
    status: "pending",
  });
}

beforeEach(() => {
  base.clear();
  defautsLocaux.clear();
  appels.creations = 0;
  appels.photos = 0;
  appels.defauts = 0;
  appels.appareils = 0;
  echouerPhotoNo = 0;
  echouerCreation = false;
  echouerDefaut = false;
  changerCompteApresPhoto = false;
  vi.mocked(api.post).mockClear();
  localStorage.clear();
  configurerUtilisateurSync("u1");
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

describe("Synchronisation hors-ligne", () => {
  it("envoie l'inspection et ses photos, puis vide la file", async () => {
    deposer("a", 2);
    await syncPendingOfflineData();

    expect(appels.creations).toBe(1);
    expect(appels.photos).toBe(2);
    expect(base.size).toBe(0);
  });

  it("transmet l'identifiant client, clé d'idempotence du serveur", async () => {
    // `localId` est genere une fois a la saisie et ne change jamais d'une tentative a
    // l'autre. C'est lui qui permet au serveur de refuser une seconde creation quand
    // une reponse s'est perdue en chemin — le cas que la persistance pas a pas
    // ci-dessous ne couvre pas.
    deposer("a", 0);
    const { api } = await import("./api");
    await syncPendingOfflineData();

    const corps = vi.mocked(api.post).mock.calls[0][1] as Record<string, unknown>;
    expect(corps.clientInspectionId).toBe("a");
  });

  it("renvoie le même identifiant client à chaque reprise", async () => {
    deposer("a", 2);
    echouerPhotoNo = 1;
    await syncPendingOfflineData();

    echouerPhotoNo = 0;
    await syncPendingOfflineData();

    const { api } = await import("./api");
    const creations = vi
      .mocked(api.post)
      .mock.calls.filter((c) => c[0] === "/inspections")
      .map((c) => (c[1] as Record<string, unknown>).clientInspectionId);
    // Une seule creation ici, mais l'identifiant doit rester stable si une seconde
    // tentative avait lieu.
    for (const id of creations) expect(id).toBe("a");
  });

  it("transmet la position et sa précision", async () => {
    deposer("a", 0);
    const { api } = await import("./api");
    await syncPendingOfflineData();

    const corps = vi.mocked(api.post).mock.calls[0][1] as Record<string, unknown>;
    expect(corps.lat).toBe(9.5);
    expect(corps.lon).toBe(-13.7);
    expect(corps.precisionM).toBe(8);
  });

  it("ne recrée PAS l'inspection quand une photo échoue — le défaut du doublon", async () => {
    deposer("a", 3);
    echouerPhotoNo = 2; // la deuxieme photo casse
    await syncPendingOfflineData();
    expect(appels.creations).toBe(1);

    // Reprise : l'inspection ne doit pas etre recreee.
    echouerPhotoNo = 0;
    await syncPendingOfflineData();

    expect(appels.creations).toBe(1); // et non 2
    expect(base.size).toBe(0);
  });

  it("ne renvoie pas les photos déjà passées", async () => {
    deposer("a", 3);
    echouerPhotoNo = 3;
    await syncPendingOfflineData();
    const apresEchec = appels.photos;

    echouerPhotoNo = 0;
    await syncPendingOfflineData();

    // Deux photos etaient passees : la reprise n'en renvoie qu'une seule.
    expect(appels.photos).toBe(apresEchec + 1);
  });

  it("arrête l'envoi des photos dès qu'un autre compte prend la session", async () => {
    deposer("a", 3);
    changerCompteApresPhoto = true;

    await syncPendingOfflineData();

    expect(appels.photos).toBe(1);
    expect(base.get("a")?.ownerUserId).toBe("u1");
    expect((base.get("a")?.photos as unknown[])).toHaveLength(2);
  });

  it("retient l'identifiant serveur dès la création réussie", async () => {
    deposer("a", 2);
    echouerPhotoNo = 1;
    await syncPendingOfflineData();

    expect(base.get("a")?.serverId).toBe("srv-1");
  });

  it("abandonne après cinq tentatives plutôt que de réessayer sans fin", async () => {
    deposer("a", 0);
    echouerCreation = true;

    for (let i = 0; i < 6; i++) await syncPendingOfflineData();

    expect(base.get("a")?.status).toBe("abandonnee");
    // La sixieme passe ne doit plus rien tenter.
    expect(base.get("a")?.tentatives).toBe(5);
  });

  it("conserve l'inspection abandonnée plutôt que de l'effacer en silence", async () => {
    deposer("a", 0);
    echouerCreation = true;
    for (let i = 0; i < 6; i++) await syncPendingOfflineData();

    expect(base.has("a")).toBe(true);
    expect(String(base.get("a")?.errorMessage)).toContain("abandon");
  });

  it("ne tente rien hors connexion", async () => {
    deposer("a", 1);
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    await syncPendingOfflineData();

    expect(appels.creations).toBe(0);
    expect(base.size).toBe(1);
  });

  it("traite plusieurs inspections en attente", async () => {
    deposer("a", 1);
    deposer("b", 1);
    await syncPendingOfflineData();

    expect(appels.creations).toBe(2);
    expect(base.size).toBe(0);
  });
});

describe("Synchronisation hors-ligne des défauts structurés", () => {
  function deposerDefaut(localId: string) {
    defautsLocaux.set(localId, {
      localId,
      ownerUserId: "u1",
      payload: {
        catalogueCode: "NID_POULE",
        lat: 9.5,
        lon: -13.7,
        constateA: "2026-10-08T10:00:00.000Z",
        gravite: 2,
        mesures: { longueurM: 2, largeurM: 1, profondeurM: 0.1 },
      },
      createdAt: "2026-10-08T10:00:00.000Z",
      status: "pending",
    });
  }

  it("transmet une clé stable puis retire le défaut après succès", async () => {
    deposerDefaut("11111111-1111-4111-8111-111111111111");
    const { api } = await import("./api");

    await syncPendingOfflineData();

    const appelsDefaut = vi.mocked(api.post).mock.calls.filter((c) => c[0] === "/v2/sync/push");
    expect(appelsDefaut).toHaveLength(1);
    const push = appelsDefaut[0][1] as { appareilId: string; operations: Record<string, unknown>[] };
    expect(push.appareilId).toBe("device-u1");
    expect(push.operations[0]).toMatchObject({
      operationId: "11111111-1111-4111-8111-111111111111",
      entityId: "11111111-1111-4111-8111-111111111111",
      entityType: "Defaut",
      operation: "CREATE",
      baseVersion: null,
    });
    expect(defautsLocaux.size).toBe(0);
  });

  it("rejoue après une erreur réseau sans changer la clé d'idempotence", async () => {
    deposerDefaut("22222222-2222-4222-8222-222222222222");
    echouerDefaut = true;
    await syncPendingOfflineData();
    expect(defautsLocaux.get("22222222-2222-4222-8222-222222222222")?.status).toBe("error");

    echouerDefaut = false;
    await syncPendingOfflineData();

    const { api } = await import("./api");
    const ids = vi.mocked(api.post).mock.calls
      .filter((c) => c[0] === "/v2/sync/push")
      .map((c) => ((c[1] as { operations: Record<string, unknown>[] }).operations[0]).operationId);
    expect(ids).toEqual([
      "22222222-2222-4222-8222-222222222222",
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(defautsLocaux.size).toBe(0);
  });

  it("ne synchronise ni inspection ni défaut lorsque l'appareil est hors-ligne", async () => {
    deposerDefaut("33333333-3333-4333-8333-333333333333");
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });

    await syncPendingOfflineData();

    expect(appels.defauts).toBe(0);
    expect(defautsLocaux.size).toBe(1);
  });

  it("ne transmet pas les brouillons d'un autre compte sur un navigateur partagé", async () => {
    deposerDefaut("44444444-4444-4444-8444-444444444444");
    configurerUtilisateurSync("u2");

    await syncPendingOfflineData();

    expect(appels.defauts).toBe(0);
    expect(vi.mocked(api.post).mock.calls.some((call) => call[0] === "/v2/sync/push")).toBe(false);
    expect(defautsLocaux.has("44444444-4444-4444-8444-444444444444")).toBe(true);
  });
});
