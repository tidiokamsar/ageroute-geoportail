/**
 * Couche HOTE du noyau de roulage (frontend/src/roulage/) pour le NAVIGATEUR (PWA) : tout ce que le noyau ne connait pas
 * volontairement (position du navigateur, stockage, veille de l'ecran, export de fichier).
 *
 * CE QUE CETTE COUCHE PERMET, ET SES LIMITES DE NAVIGATEUR
 *
 * Elle permet d'enregistrer une trace SANS application Android native, page ouverte au PREMIER PLAN et
 * ecran ALLUME. Elle ne peut pas faire ce qu'un navigateur ne sait pas faire : continuer a lire la
 * position quand l'ecran s'eteint ou que l'onglet passe en arriere-plan, lire l'accelerometre de facon
 * fiable, prendre des photos cadencees. Quand le navigateur interrompt la position, la session l'enregistre
 * comme une interruption (VEILLE) plutot que de relier les deux cotes. Aucune de ces limites n'a ete
 * mesuree sur un telephone : voir docs/roulage/COLLECTE-ROULAGE.md.
 *
 * Ce fichier vit dans `lib/` et NON dans `roulage/` : il est le seul a toucher `navigator`, `indexedDB` et `document`
 * (le noyau, lui, reste sans DOM : voir `noyau.garde.test.ts`).
 */
import type { EntreeJournal } from "../roulage/journal";
import type { EchantillonGnss } from "../roulage/types";
import type { EtatSession } from "../roulage/etat";

// ------------------------------------------------------------------ position -> echantillon

/** Forme minimale de `GeolocationPosition`, pour tester sans navigateur. */
export interface PositionNavigateur {
  timestamp: number;
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number | null;
    speed: number | null;
    heading: number | null;
    altitude: number | null;
  };
}

const fini = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Une position du navigateur devient un echantillon du noyau. Une valeur absente ou aberrante reste
 * `null` : la precision n'est JAMAIS inventee (le noyau compte les echantillons sans precision).
 */
export function positionVersEchantillon(p: PositionNavigateur): EchantillonGnss {
  const c = p.coords;
  return {
    tMs: p.timestamp,
    lat: c.latitude,
    lon: c.longitude,
    precisionM: fini(c.accuracy) && c.accuracy >= 0 ? c.accuracy : null,
    vitesseMs: fini(c.speed) && c.speed >= 0 ? c.speed : null,
    capDeg: fini(c.heading) && c.heading >= 0 && c.heading <= 360 ? c.heading : null,
    altitudeM: fini(c.altitude) ? c.altitude : null,
  };
}

// ------------------------------------------------------------------ export GPX

const echapper = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Trace de la session en GPX 1.1 : un segment `<trkseg>` par segment du noyau (deux segments ne sont
 * jamais relies : un trou de signal n'est pas une ligne droite). Chaque point porte son heure ; la
 * precision n'est pas ecrite (le format GPX 1.1 de base n'a pas de champ pour elle).
 */
export function versGpx(etat: Pick<EtatSession, "echantillons" | "sessionId">, nom = "Releve en vehicule"): string {
  const segments = new Map<number, string[]>();
  for (const s of etat.echantillons) {
    const lignes = segments.get(s.segment) ?? [];
    lignes.push(`      <trkpt lat="${s.lat.toFixed(7)}" lon="${s.lon.toFixed(7)}"><time>${new Date(s.tMs).toISOString()}</time></trkpt>`);
    segments.set(s.segment, lignes);
  }
  const corps = [...segments.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, l]) => `    <trkseg>\n${l.join("\n")}\n    </trkseg>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="BDRI AGEROUTE" xmlns="http://www.topografix.com/GPX/1/1">\n  <trk>\n    <name>${echapper(nom)}</name>\n${corps}\n  </trk>\n</gpx>\n`;
}

/** Nom de fichier sans caractere gênant, date locale du debut de la session. */
export function nomFichierGpx(debutMs: number): string {
  return `releve-${new Date(debutMs).toISOString().slice(0, 16).replace(/[:T]/g, "-")}.gpx`;
}

// ------------------------------------------------------------------ stockage du journal

/**
 * Stockage du journal d'une session. `ajouter` est appele par le noyau a chaque changement (rappel
 * synchrone) : l'ecriture est lancee sans attendre, et ses echecs sont COMPTES (`echecs`) pour que
 * l'ecran puisse dire que la reprise apres un redemarrage n'est plus garantie.
 */
export interface StockageJournal {
  ajouter(entree: EntreeJournal): void;
  toutes(): Promise<EntreeJournal[]>;
  vider(): Promise<void>;
  /** Nombre d'ecritures qui ont echoue depuis l'ouverture. */
  echecs(): number;
  /** `memoire` : rien ne survivra a un redemarrage de la page. */
  nature: "indexeddb" | "memoire";
}

export function stockageMemoire(): StockageJournal {
  const entrees: EntreeJournal[] = [];
  return {
    nature: "memoire",
    ajouter: (e) => { entrees.push(JSON.parse(JSON.stringify(e)) as EntreeJournal); },
    toutes: async () => [...entrees],
    vider: async () => { entrees.length = 0; },
    echecs: () => 0,
  };
}

const NOM_BASE = "bdri-roulage";
const MAGASIN = "journal";

function ouvrir(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(NOM_BASE, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(MAGASIN)) r.result.createObjectStore(MAGASIN, { keyPath: "seq" }); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** IndexedDB natif (sans dependance). Rend `null` si le navigateur n'en a pas ou le refuse (navigation privee). */
export function stockageIndexedDb(): StockageJournal | null {
  if (typeof indexedDB === "undefined") return null;
  let echecs = 0;
  let base: Promise<IDBDatabase> | null = null;
  const db = () => (base ??= ouvrir());
  const demander = <T,>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    db().then((d) => new Promise<T>((resolve, reject) => {
      const t = d.transaction(MAGASIN, mode);
      const req = f(t.objectStore(MAGASIN));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  return {
    nature: "indexeddb",
    ajouter: (e) => { void demander("readwrite", (s) => s.put(JSON.parse(JSON.stringify(e)))).catch(() => { echecs += 1; }); },
    toutes: () => demander("readonly", (s) => s.getAll() as IDBRequest<EntreeJournal[]>),
    vider: () => demander("readwrite", (s) => s.clear()).then(() => undefined),
    echecs: () => echecs,
  };
}

/** IndexedDB si possible, sinon la memoire (et l'ecran le dit). */
export function ouvrirStockage(): StockageJournal {
  return stockageIndexedDb() ?? stockageMemoire();
}

// ------------------------------------------------------------------ veille de l'ecran

export interface VerrouEcran {
  /** `false` : le navigateur ne sait pas garder l'ecran allume, l'agent doit le faire lui-meme. */
  actif: boolean;
  liberer(): Promise<void>;
}

interface WakeLockSentinelLike { release(): Promise<void>; }
interface WakeLockLike { request(type: "screen"): Promise<WakeLockSentinelLike>; }

/** Demande au navigateur de ne pas eteindre l'ecran (API Screen Wake Lock). Ne leve jamais. */
export async function garderEcranAllume(nav: { wakeLock?: WakeLockLike } = navigator as unknown as { wakeLock?: WakeLockLike }): Promise<VerrouEcran> {
  if (!nav.wakeLock) return { actif: false, liberer: async () => undefined };
  try {
    const s = await nav.wakeLock.request("screen");
    return { actif: true, liberer: () => s.release().catch(() => undefined) };
  } catch {
    return { actif: false, liberer: async () => undefined };
  }
}

// ------------------------------------------------------------------ permission GPS, stockage

export type EtatPermissionGps = "accordee" | "refusee" | "a_demander" | "inconnue";

/**
 * Etat de l'autorisation de position, SANS declencher la demande. `inconnue` quand le navigateur ne sait pas le
 * dire (l'API Permissions n'existe pas partout) : l'ecran ne bloque alors rien, la demande se fera au demarrage.
 */
export async function etatPermissionGps(
  nav: { permissions?: { query(d: { name: "geolocation" }): Promise<{ state: string }> } } = navigator as never,
): Promise<EtatPermissionGps> {
  try {
    const r = await nav.permissions?.query({ name: "geolocation" });
    if (!r) return "inconnue";
    return r.state === "granted" ? "accordee" : r.state === "denied" ? "refusee" : r.state === "prompt" ? "a_demander" : "inconnue";
  } catch {
    return "inconnue";
  }
}

/** Place occupee par le site sur l'appareil, ou `null` quand le navigateur ne la donne pas (jamais devinee). */
export async function estimerStockage(
  nav: { storage?: { estimate?: () => Promise<{ usage?: number; quota?: number }> } } = navigator as never,
): Promise<{ usageMo: number; quotaMo: number; part: number } | null> {
  try {
    const e = await nav.storage?.estimate?.();
    if (!e || typeof e.usage !== "number" || typeof e.quota !== "number" || e.quota <= 0) return null;
    return { usageMo: e.usage / 1_048_576, quotaMo: e.quota / 1_048_576, part: e.usage / e.quota };
  } catch {
    return null;
  }
}

/**
 * Demande au navigateur de ne pas purger le stockage du site quand l'appareil manque de place. Reponse `false` ou
 * absente : le stockage reste « au mieux », et l'ecran ne promet rien de plus.
 */
export async function demanderStockagePersistant(
  nav: { storage?: { persist?: () => Promise<boolean> } } = navigator as never,
): Promise<boolean> {
  try { return (await nav.storage?.persist?.()) === true; } catch { return false; }
}
