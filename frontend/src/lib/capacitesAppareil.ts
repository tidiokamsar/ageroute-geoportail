import { estimerStockage, etatPermissionGps, type EtatPermissionGps } from "./roulageHote";

/**
 * Ce que CET appareil sait réellement faire, lu sur lui, pas supposé d'après sa marque (SMART FIELD, phases 3 et 4).
 *
 * Chaque ligne dit « oui », « non » ou « non communiqué par le navigateur » : une valeur qu'un navigateur ne donne pas n'est
 * JAMAIS devinée (la mémoire de l'appareil, par exemple, est arrondie ou masquée selon le navigateur). Le rapport sert à
 * décider quels modules optionnels proposer (accéléromètre, caméra, calcul embarqué) et à remplir la fiche de chaque
 * téléphone du pilote. Il ne mesure aucune vitesse de calcul : l'essai d'un modèle sur l'appareil est une mesure à part.
 */

export type Capacite<T> = { etat: "oui" | "non" | "non_communique"; valeur?: T };

export interface RapportCapacites {
  mesureLe: string;
  agentUtilisateur: string;
  gps: { api: boolean; permission: EtatPermissionGps };
  mouvement: {
    /** Évènement `devicemotion` disponible (accéléromètre, parfois gyroscope). */
    deviceMotion: boolean;
    /** Interface Capteurs génériques (`Accelerometer`, `Gyroscope`) présente : plus précise, pas partout. */
    capteurAccelerometre: boolean;
    capteurGyroscope: boolean;
    /** Une autorisation explicite est demandée (cas d'iOS) : l'accéléromètre ne démarre qu'après un geste de l'agent. */
    autorisationExplicite: boolean;
  };
  camera: { mediaDevices: boolean };
  stockage: { indexedDB: boolean; usageMo: number | null; quotaMo: number | null };
  calcul: {
    coeursLogiques: Capacite<number>;
    memoireNavigateurGo: Capacite<number>;
    webAssembly: boolean;
    webgl2: boolean;
    webgpu: boolean;
  };
  energie: { api: boolean; niveauPourcent: number | null; enCharge: boolean | null };
  reseau: { enLigne: boolean; typeEffectif: string | null; debitDescendantMbps: number | null };
  ecran: { largeur: number; hauteur: number; ratioPixels: number; wakeLock: boolean };
}

/** Ce que la fonction lit de l'environnement : injectable pour les tests, jamais lu ailleurs. */
export interface EnvironnementAppareil {
  navigator: Record<string, unknown> & { userAgent?: string; onLine?: boolean; hardwareConcurrency?: number };
  window: { devicemotion?: boolean; Accelerometer?: unknown; Gyroscope?: unknown; DeviceMotionEvent?: unknown; indexedDB?: unknown; devicePixelRatio?: number; innerWidth?: number; innerHeight?: number };
  webAssembly: boolean;
  webgl2: () => boolean;
}

function environnementReel(): EnvironnementAppareil {
  const w = window as unknown as EnvironnementAppareil["window"] & Record<string, unknown>;
  return {
    navigator: navigator as unknown as EnvironnementAppareil["navigator"],
    window: w,
    webAssembly: typeof (globalThis as { WebAssembly?: unknown }).WebAssembly === "object",
    webgl2: () => {
      try { return Boolean(document.createElement("canvas").getContext("webgl2")); } catch { return false; }
    },
  };
}

export async function lireCapacites(env: EnvironnementAppareil = environnementReel(), maintenant: Date = new Date()): Promise<RapportCapacites> {
  const nav = env.navigator;
  const win = env.window;
  const coeurs = typeof nav.hardwareConcurrency === "number" && nav.hardwareConcurrency > 0 ? nav.hardwareConcurrency : null;
  const memoire = typeof nav.deviceMemory === "number" && Number.isFinite(nav.deviceMemory) ? (nav.deviceMemory as number) : null;

  let batterie: { level?: number; charging?: boolean } | null = null;
  const getBattery = nav.getBattery as undefined | (() => Promise<{ level?: number; charging?: boolean }>);
  if (typeof getBattery === "function") {
    try { batterie = await getBattery.call(nav); } catch { batterie = null; }
  }
  const connexion = (nav.connection ?? null) as null | { effectiveType?: string; downlink?: number };
  const stockage = await estimerStockage(nav as never);
  const motion = Boolean(win.DeviceMotionEvent);

  return {
    mesureLe: maintenant.toISOString(),
    agentUtilisateur: String(nav.userAgent ?? ""),
    gps: { api: "geolocation" in nav, permission: await etatPermissionGps(nav as never) },
    mouvement: {
      deviceMotion: motion,
      capteurAccelerometre: Boolean(win.Accelerometer),
      capteurGyroscope: Boolean(win.Gyroscope),
      autorisationExplicite: motion && typeof (win.DeviceMotionEvent as { requestPermission?: unknown }).requestPermission === "function",
    },
    camera: { mediaDevices: Boolean((nav.mediaDevices as { getUserMedia?: unknown } | undefined)?.getUserMedia) },
    stockage: { indexedDB: Boolean(win.indexedDB), usageMo: stockage?.usageMo ?? null, quotaMo: stockage?.quotaMo ?? null },
    calcul: {
      coeursLogiques: coeurs === null ? { etat: "non_communique" } : { etat: "oui", valeur: coeurs },
      memoireNavigateurGo: memoire === null ? { etat: "non_communique" } : { etat: "oui", valeur: memoire },
      webAssembly: env.webAssembly,
      webgl2: env.webgl2(),
      webgpu: "gpu" in nav,
    },
    energie: {
      api: batterie !== null,
      niveauPourcent: typeof batterie?.level === "number" ? Math.round(batterie.level * 100) : null,
      enCharge: typeof batterie?.charging === "boolean" ? batterie.charging : null,
    },
    reseau: {
      enLigne: nav.onLine !== false,
      typeEffectif: connexion?.effectiveType ?? null,
      debitDescendantMbps: typeof connexion?.downlink === "number" ? connexion.downlink : null,
    },
    ecran: { largeur: win.innerWidth ?? 0, hauteur: win.innerHeight ?? 0, ratioPixels: win.devicePixelRatio ?? 1, wakeLock: "wakeLock" in nav },
  };
}

/**
 * Modules optionnels que l'appareil peut proposer, d'après le rapport. « Possible » ne veut pas dire « utile » : seul le
 * pilote dira si l'indice d'accélération ou un modèle embarqué apporte quelque chose.
 */
export function modulesPossibles(r: RapportCapacites): { module: string; possible: boolean; raison: string }[] {
  return [
    { module: "Position GPS", possible: r.gps.api && r.gps.permission !== "refusee", raison: !r.gps.api ? "Le navigateur ne donne pas la position." : r.gps.permission === "refusee" ? "Autorisation refusée." : "Disponible." },
    { module: "Indice d'irrégularité (accéléromètre)", possible: r.mouvement.deviceMotion, raison: !r.mouvement.deviceMotion ? "Aucun capteur de mouvement exposé." : r.mouvement.autorisationExplicite ? "Disponible après autorisation explicite de l'agent." : "Disponible." },
    { module: "Photos", possible: r.camera.mediaDevices, raison: r.camera.mediaDevices ? "Caméra accessible par le navigateur." : "Caméra non exposée (la prise de photo par fichier reste possible sur la plupart des téléphones, non vérifiée ici)." },
    { module: "Conservation hors ligne", possible: r.stockage.indexedDB, raison: r.stockage.indexedDB ? "Stockage local disponible." : "Pas de stockage local durable : la session serait perdue à la fermeture." },
    { module: "Calcul embarqué (modèle de vision)", possible: r.calcul.webAssembly, raison: !r.calcul.webAssembly ? "WebAssembly absent." : "WebAssembly présent ; vitesse, mémoire réelle et consommation NON mesurées ici (essai à part)." },
  ];
}
