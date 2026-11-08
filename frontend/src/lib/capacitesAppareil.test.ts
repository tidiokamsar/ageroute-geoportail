import { describe, expect, it } from "vitest";
import { lireCapacites, modulesPossibles, type EnvironnementAppareil } from "./capacitesAppareil";

/**
 * Capacités d'un appareil : ce que ces tests défendent.
 *   - ce que le navigateur ne communique pas reste « non communiqué » : jamais une valeur par défaut qui ressemblerait à une mesure ;
 *   - un téléphone complet, un téléphone sans capteurs et un navigateur d'ordinateur donnent trois rapports différents et honnêtes ;
 *   - « possible » est dit avec sa raison, et ne promet rien sur la vitesse ou la consommation.
 */

const MAINTENANT = new Date("2026-10-25T09:00:00.000Z");
const MO = 1_048_576;

function env(surcharge: { navigator?: Record<string, unknown>; window?: Record<string, unknown>; webAssembly?: boolean; webgl2?: boolean } = {}): EnvironnementAppareil {
  return {
    navigator: { userAgent: "Essai/1.0", onLine: true, ...surcharge.navigator } as EnvironnementAppareil["navigator"],
    window: { innerWidth: 360, innerHeight: 740, devicePixelRatio: 3, ...surcharge.window } as EnvironnementAppareil["window"],
    webAssembly: surcharge.webAssembly ?? false,
    webgl2: () => surcharge.webgl2 ?? false,
  };
}

describe("lireCapacites", () => {
  it("un téléphone complet : tout ce qu'il expose est lu, rien d'autre", async () => {
    const r = await lireCapacites(env({
      navigator: {
        geolocation: {}, hardwareConcurrency: 8, deviceMemory: 4, mediaDevices: { getUserMedia: () => undefined }, wakeLock: {}, gpu: {},
        permissions: { query: async () => ({ state: "granted" }) },
        storage: { estimate: async () => ({ usage: 50 * MO, quota: 500 * MO }) },
        getBattery: async () => ({ level: 0.82, charging: false }),
        connection: { effectiveType: "3g", downlink: 1.4 },
      },
      window: { DeviceMotionEvent: class {}, Accelerometer: class {}, Gyroscope: class {}, indexedDB: {} },
      webAssembly: true, webgl2: true,
    }), MAINTENANT);
    expect(r.mesureLe).toBe("2026-10-25T09:00:00.000Z");
    expect(r.gps).toEqual({ api: true, permission: "accordee" });
    expect(r.mouvement).toEqual({ deviceMotion: true, capteurAccelerometre: true, capteurGyroscope: true, autorisationExplicite: false });
    expect(r.camera.mediaDevices).toBe(true);
    expect(r.stockage).toEqual({ indexedDB: true, usageMo: 50, quotaMo: 500 });
    expect(r.calcul).toEqual({ coeursLogiques: { etat: "oui", valeur: 8 }, memoireNavigateurGo: { etat: "oui", valeur: 4 }, webAssembly: true, webgl2: true, webgpu: true });
    expect(r.energie).toEqual({ api: true, niveauPourcent: 82, enCharge: false });
    expect(r.reseau).toEqual({ enLigne: true, typeEffectif: "3g", debitDescendantMbps: 1.4 });
    expect(r.ecran).toEqual({ largeur: 360, hauteur: 740, ratioPixels: 3, wakeLock: true });
  });

  it("un appareil qui ne dit presque rien : « non communiqué », jamais une valeur inventée", async () => {
    const r = await lireCapacites(env(), MAINTENANT);
    expect(r.gps).toEqual({ api: false, permission: "inconnue" });
    expect(r.calcul.coeursLogiques).toEqual({ etat: "non_communique" });
    expect(r.calcul.memoireNavigateurGo).toEqual({ etat: "non_communique" });
    expect(r.stockage).toEqual({ indexedDB: false, usageMo: null, quotaMo: null });
    expect(r.energie).toEqual({ api: false, niveauPourcent: null, enCharge: null });
    expect(r.reseau).toEqual({ enLigne: true, typeEffectif: null, debitDescendantMbps: null });
    expect(r.mouvement.deviceMotion).toBe(false);
  });

  it("une autorisation explicite pour les capteurs de mouvement est repérée (cas d'iOS)", async () => {
    const r = await lireCapacites(env({ window: { DeviceMotionEvent: { requestPermission: () => Promise.resolve("granted") } } }), MAINTENANT);
    expect(r.mouvement).toMatchObject({ deviceMotion: true, autorisationExplicite: true });
    expect(modulesPossibles(r).find((m) => m.module.startsWith("Indice"))?.raison).toMatch(/autorisation explicite/);
  });

  it("une batterie qui refuse la lecture ou un stockage qui lève : le rapport se fait quand même", async () => {
    const r = await lireCapacites(env({
      navigator: { getBattery: async () => { throw new Error("SecurityError"); }, storage: { estimate: async () => { throw new Error("x"); } } },
    }), MAINTENANT);
    expect(r.energie.api).toBe(false);
    expect(r.stockage.usageMo).toBeNull();
  });

  it("hors ligne : dit hors ligne", async () => {
    expect((await lireCapacites(env({ navigator: { onLine: false } }), MAINTENANT)).reseau.enLigne).toBe(false);
  });
});

describe("modulesPossibles", () => {
  it("dit pour chaque module s'il est possible et pourquoi ; le calcul embarqué ne promet ni vitesse ni consommation", async () => {
    const r = await lireCapacites(env({ navigator: { geolocation: {} }, window: { indexedDB: {} }, webAssembly: true }), MAINTENANT);
    const m = Object.fromEntries(modulesPossibles(r).map((x) => [x.module, x]));
    expect(m["Position GPS"].possible).toBe(true);
    expect(m["Indice d'irrégularité (accéléromètre)"].possible).toBe(false);
    expect(m["Photos"].possible).toBe(false);
    expect(m["Conservation hors ligne"].possible).toBe(true);
    expect(m["Calcul embarqué (modèle de vision)"].possible).toBe(true);
    expect(m["Calcul embarqué (modèle de vision)"].raison).toMatch(/NON mesurées/);
  });

  it("un GPS refusé n'est pas « possible »", async () => {
    const r = await lireCapacites(env({ navigator: { geolocation: {}, permissions: { query: async () => ({ state: "denied" }) } } }), MAINTENANT);
    const gps = modulesPossibles(r)[0];
    expect(gps.possible).toBe(false);
    expect(gps.raison).toMatch(/refusée/);
  });
});
