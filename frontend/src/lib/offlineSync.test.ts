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

const appels = { creations: 0, photos: 0 };
let echouerPhotoNo = 0; // 0 = aucune ; n = echouer a la n-ieme photo
let echouerCreation = false;

vi.mock("./api", () => ({
  api: {
    post: vi.fn(async (url: string) => {
      if (url === "/inspections") {
        if (echouerCreation) throw new Error("reseau indisponible");
        appels.creations++;
        return { data: { id: `srv-${appels.creations}` } };
      }
      appels.photos++;
      if (echouerPhotoNo > 0 && appels.photos === echouerPhotoNo) {
        throw new Error("coupure pendant l'envoi de la photo");
      }
      return { data: {} };
    }),
  },
}));

// Base locale simulee : un Map suffit, et evite de dependre d'IndexedDB sous jsdom.
const base = new Map<string, Record<string, unknown>>();

vi.mock("./offlineDb", () => ({
  getAllPending: vi.fn(async () => [...base.values()]),
  updatePendingInspection: vi.fn(async (item: { localId: string }) => {
    base.set(item.localId, item as Record<string, unknown>);
  }),
  removePendingInspection: vi.fn(async (localId: string) => {
    base.delete(localId);
  }),
}));

import { syncPendingInspections } from "./offlineSync";

function deposer(localId: string, nbPhotos: number) {
  base.set(localId, {
    localId,
    payload: { tronconId: "t1", dateInspection: "2026-09-01", etatObserve: "MAUVAIS", lat: 9.5, lon: -13.7, precisionM: 8 },
    photos: Array.from({ length: nbPhotos }, (_, i) => ({ name: `p${i}.jpg`, blob: new Blob(["x"]) })),
    createdAt: "2026-09-01T00:00:00Z",
    status: "pending",
  });
}

beforeEach(() => {
  base.clear();
  appels.creations = 0;
  appels.photos = 0;
  echouerPhotoNo = 0;
  echouerCreation = false;
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

describe("Synchronisation hors-ligne", () => {
  it("envoie l'inspection et ses photos, puis vide la file", async () => {
    deposer("a", 2);
    await syncPendingInspections();

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
    await syncPendingInspections();

    const corps = vi.mocked(api.post).mock.calls[0][1] as Record<string, unknown>;
    expect(corps.clientInspectionId).toBe("a");
  });

  it("renvoie le même identifiant client à chaque reprise", async () => {
    deposer("a", 2);
    echouerPhotoNo = 1;
    await syncPendingInspections();

    echouerPhotoNo = 0;
    await syncPendingInspections();

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
    await syncPendingInspections();

    const corps = vi.mocked(api.post).mock.calls[0][1] as Record<string, unknown>;
    expect(corps.lat).toBe(9.5);
    expect(corps.lon).toBe(-13.7);
    expect(corps.precisionM).toBe(8);
  });

  it("ne recrée PAS l'inspection quand une photo échoue — le défaut du doublon", async () => {
    deposer("a", 3);
    echouerPhotoNo = 2; // la deuxieme photo casse
    await syncPendingInspections();
    expect(appels.creations).toBe(1);

    // Reprise : l'inspection ne doit pas etre recreee.
    echouerPhotoNo = 0;
    await syncPendingInspections();

    expect(appels.creations).toBe(1); // et non 2
    expect(base.size).toBe(0);
  });

  it("ne renvoie pas les photos déjà passées", async () => {
    deposer("a", 3);
    echouerPhotoNo = 3;
    await syncPendingInspections();
    const apresEchec = appels.photos;

    echouerPhotoNo = 0;
    await syncPendingInspections();

    // Deux photos etaient passees : la reprise n'en renvoie qu'une seule.
    expect(appels.photos).toBe(apresEchec + 1);
  });

  it("retient l'identifiant serveur dès la création réussie", async () => {
    deposer("a", 2);
    echouerPhotoNo = 1;
    await syncPendingInspections();

    expect(base.get("a")?.serverId).toBe("srv-1");
  });

  it("abandonne après cinq tentatives plutôt que de réessayer sans fin", async () => {
    deposer("a", 0);
    echouerCreation = true;

    for (let i = 0; i < 6; i++) await syncPendingInspections();

    expect(base.get("a")?.status).toBe("abandonnee");
    // La sixieme passe ne doit plus rien tenter.
    expect(base.get("a")?.tentatives).toBe(5);
  });

  it("conserve l'inspection abandonnée plutôt que de l'effacer en silence", async () => {
    deposer("a", 0);
    echouerCreation = true;
    for (let i = 0; i < 6; i++) await syncPendingInspections();

    expect(base.has("a")).toBe(true);
    expect(String(base.get("a")?.errorMessage)).toContain("abandon");
  });

  it("ne tente rien hors connexion", async () => {
    deposer("a", 1);
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    await syncPendingInspections();

    expect(appels.creations).toBe(0);
    expect(base.size).toBe(1);
  });

  it("traite plusieurs inspections en attente", async () => {
    deposer("a", 1);
    deposer("b", 1);
    await syncPendingInspections();

    expect(appels.creations).toBe(2);
    expect(base.size).toBe(0);
  });
});
