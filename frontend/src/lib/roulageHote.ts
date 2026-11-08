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
import { nomBaseRoulage } from "../session/compteLocal";
import {
  aadEnregistrement, abonnerCompte, ErreurStockageLocal, estErreurStockageLocal, exigerCompte, exigerDeverrouille, majCompteurs,
  traduireErreurChiffrement, type ContexteCompte,
} from "./compteCourant";

/** Ce que les AUTRES comptes de ce telephone ont en attente, sans contenu (voir compteCourant.ts). */
export { resumeAutresComptes, type ResumeAutresComptes } from "./compteCourant";

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
  /** Lots du journal chiffre qui n'ont pas pu etre relus (altere, autre cle) : ecartes, jamais supprimes. */
  lotsIllisibles?(): number;
  /** Entrees retenues en memoire faute de cle (verrou) ou de compte : ecrites des que possible, jamais en clair. */
  enAttente?(): number;
  /**
   * Fermeture : retire les ecouteurs poses a la creation (abonnement au compte, visibilite de la page) et arrete le delai
   * d'ecriture en attente. Sans elle, chaque instance creee (changement de compte, migration) laissait ses ecouteurs vivants
   * pour toujours. Les entrees encore en tampon NE sont PAS ecrites par la fermeture : ecrire avant (`toutes()` ou un arret).
   * Une instance fermee ne reagit plus au compte ni a la page ; ses autres methodes restent utilisables.
   */
  fermer?(): void;
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

/**
 * JOURNAL CHIFFRE, PAR COMPTE (docs/securite/SESSION-HORS-LIGNE.md, sections 3 et 4).
 *
 * Base `bdri-roulage-<empreinte>` (nomBaseRoulage) : le releve d'un agent n'est plus lu ni efface par un autre, et un
 * second compte n'est plus bloque par le releve du premier. Chaque enregistrement est un LOT d'entrees, chiffre d'un
 * bloc (AES-GCM, AAD `compteId|journal.<seq du lot>|1`) ; en clair, seulement la cle (numero de la premiere entree), le
 * numero de la derniere et le nombre d'entrees.
 *
 * DEBIT D'ECRITURE. Le GNSS produit une entree par fix (de l'ordre de 1 Hz). Chiffrer et ecrire chaque entree seule
 * est le comportement par defaut (`tailleLot` = 1) ; `tailleLot` > 1 regroupe les ECHANTILLONS (les autres entrees :
 * demarrage, arret, marqueurs, qualifications... declenchent toujours l'ecriture immediate du tampon). Le cout des deux
 * regimes a ete mesure : voir `roulageHote.debit.test.ts` et la section « debit » du rapport.
 *
 * VERROU. Chiffreur verrouille ou compte absent : les entrees sont RETENUES EN MEMOIRE (jamais ecrites en clair, jamais
 * perdues tant que la page vit) et ecrites au deverrouillage (`ouvrirCompte` rappele) ou a l'entree suivante. Un plafond
 * (`maxEnAttente`) borne la memoire : au-dela, la plus ancienne entree est abandonnee ET comptee dans `echecs()`.
 * Une page tuee pendant un verrou perd ce tampon : c'est la limite de la journalisation, comme avant pour toute entree
 * non encore ecrite.
 *
 * LA LIAISON AU COMPTE se fait au premier usage : une instance creee sous un compte ne sert jamais un autre.
 */
export interface OptionsJournal {
  /** Echantillons regroupes dans un meme bloc chiffre. 1 : un bloc par entree. */
  tailleLot?: number;
  /** Delai maximal avant l'ecriture d'un lot incomplet. */
  delaiLotMs?: number;
  /** Entrees retenues en memoire au plus pendant un verrou. */
  maxEnAttente?: number;
}

export const OPTIONS_JOURNAL_DEFAUT: Required<OptionsJournal> = { tailleLot: 1, delaiLotMs: 1000, maxEnAttente: 50_000 };

/** Version de format des lots (entre dans l'AAD). */
const VERSION_LOT_JOURNAL = 1;
const MAGASIN = "journal";
const VERSION_BASE_JOURNAL = 1;

interface LotJournal { seq: number; dernier: number; n: number; compteId: string; fmt: number; paquet: Uint8Array }

const aadLot = (compteId: string, seq: number) => aadEnregistrement(compteId, `journal.${seq}`, VERSION_LOT_JOURNAL);

function ouvrirBaseJournal(empreinte: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(nomBaseRoulage(empreinte), VERSION_BASE_JOURNAL);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(MAGASIN)) r.result.createObjectStore(MAGASIN, { keyPath: "seq" }); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Une transaction sur le journal, qui se termine (ou est annulee : quota) avant de rendre la main. */
function transactionJournal<T>(db: IDBDatabase, mode: IDBTransactionMode, travail: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(MAGASIN, mode);
    const req = travail(t.objectStore(MAGASIN));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new ErreurStockageLocal("ECRITURE_ANNULEE"));
  });
}

/** IndexedDB natif (sans dependance), chiffre. Rend `null` si le navigateur n'en a pas (navigation privee, vieux navigateur). */
export function stockageIndexedDb(options: OptionsJournal = {}): StockageJournal | null {
  if (typeof indexedDB === "undefined") return null;
  const { tailleLot, delaiLotMs, maxEnAttente } = { ...OPTIONS_JOURNAL_DEFAUT, ...options };
  let echecs = 0;
  let lotsIllisibles = 0;
  let lie: string | null = null;
  let base: { empreinte: string; db: Promise<IDBDatabase> } | null = null;
  let tampon: EntreeJournal[] = [];
  let minuteur: ReturnType<typeof setTimeout> | null = null;
  let chaine: Promise<void> = Promise.resolve();

  /** Le compte courant, a condition que ce soit celui auquel cette instance est liee. */
  const compte = (): ContexteCompte => {
    const c = exigerCompte();
    if (lie !== null && lie !== c.compteId) throw new ErreurStockageLocal("COMPTE_INCOHERENT", "Le journal de roulage est celui d'un autre compte.");
    lie = c.compteId;
    return c;
  };
  const connexion = (c: ContexteCompte): Promise<IDBDatabase> => {
    if (base === null || base.empreinte !== c.empreinte) {
      const db = ouvrirBaseJournal(c.empreinte);
      const courante = { empreinte: c.empreinte, db };
      base = courante;
      db.then((d) => { d.onversionchange = () => { d.close(); if (base === courante) base = null; }; }, () => { if (base === courante) base = null; });
    }
    return base.db;
  };

  async function ecrireLot(c: ContexteCompte, lot: EntreeJournal[]): Promise<void> {
    const seq = lot[0].seq;
    const paquet = await c.chiffreur.chiffrer(lot, aadLot(c.compteId, seq));
    const enregistrement: LotJournal = { seq, dernier: lot[lot.length - 1].seq, n: lot.length, compteId: c.compteId, fmt: VERSION_LOT_JOURNAL, paquet };
    const db = await connexion(c);
    await transactionJournal(db, "readwrite", (s) => s.put(enregistrement));
    // Le compteur d'information (lu SANS cle, coffre verrouille) dit « un releve non confirme existe » des les premiers points, pas
    // seulement a l'ARRET : une page tuee en plein releve ne l'arrete jamais, et ses points n'existent que sur ce telephone.
    if (lot.some((e) => e.type === "ARRET" || e.type === "ECHANTILLON")) majCompteurs(c.empreinte, { releves: 1 });
  }

  /**
   * Ecrit le tampon par blocs d'au plus `tailleLot` entrees. `tout` : jusqu'a la derniere entree, meme si le dernier bloc
   * est incomplet (arret, lecture, delai ecoule, page cachee) ; sinon seulement les blocs COMPLETS, le reste attend
   * d'autres echantillons.
   */
  async function viderTampon(tout: boolean): Promise<void> {
    while (tampon.length >= (tout ? 1 : tailleLot)) {
      let c: ContexteCompte;
      try { c = compte(); exigerDeverrouille(c); } catch { return; } // retenu en memoire : rien n'est ecrit sans cle
      const lot = tampon.splice(0, tailleLot);
      try {
        await ecrireLot(c, lot);
      } catch (e) {
        const t = traduireErreurChiffrement(e);
        if (estErreurStockageLocal(t, "COFFRE_VERROUILLE")) { tampon = [...lot, ...tampon]; return; } // verrouille entre-temps : on garde
        echecs += lot.length;
      }
    }
  }

  function declencher(tout = true): Promise<void> {
    if (minuteur !== null) { clearTimeout(minuteur); minuteur = null; }
    chaine = chaine.then(() => viderTampon(tout));
    return chaine;
  }

  // Au deverrouillage (ouvrirCompte rappele) et quand la page se cache : ecrire ce qui attend. Les deux ecouteurs sont
  // retires par `fermer()`.
  const desabonnerCompte = abonnerCompte(() => { if (tampon.length > 0) void declencher(); });
  const surVisibilite = () => { if (document.visibilityState === "hidden" && tampon.length > 0) void declencher(); };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", surVisibilite);

  return {
    nature: "indexeddb",
    ajouter: (e) => {
      tampon.push(JSON.parse(JSON.stringify(e)) as EntreeJournal);
      if (tampon.length > maxEnAttente) { tampon.shift(); echecs += 1; }
      if (e.type !== "ECHANTILLON") void declencher(true);
      else if (tampon.length >= tailleLot) void declencher(false);
      else if (minuteur === null) minuteur = setTimeout(() => { minuteur = null; void declencher(); }, delaiLotMs);
    },
    toutes: async () => {
      const c = compte();
      exigerDeverrouille(c);
      await declencher();
      const db = await connexion(c);
      const lots = await transactionJournal(db, "readonly", (s) => s.getAll() as IDBRequest<unknown[]>);
      const parSeq = new Map<number, EntreeJournal>();
      for (const brut of lots) {
        const l = brut as Partial<LotJournal> | null;
        try {
          if (!l || typeof l.seq !== "number" || l.compteId !== c.compteId || l.fmt !== VERSION_LOT_JOURNAL || !(l.paquet instanceof Uint8Array)) throw new ErreurStockageLocal("DONNEES_ALTEREES");
          const entrees = await c.chiffreur.dechiffrerJson<EntreeJournal[]>(l.paquet, aadLot(c.compteId, l.seq));
          if (!Array.isArray(entrees)) throw new ErreurStockageLocal("DONNEES_ALTEREES");
          for (const e of entrees) parSeq.set(e.seq, e);
        } catch (err) {
          const t = traduireErreurChiffrement(err);
          if (estErreurStockageLocal(t, "DONNEES_ALTEREES")) { lotsIllisibles += 1; continue; } // le noyau signalera le trou au rejeu
          throw t;
        }
      }
      return [...parSeq.values()].sort((a, b) => a.seq - b.seq);
    },
    vider: async () => {
      const c = compte();
      exigerDeverrouille(c);
      tampon = [];
      if (minuteur !== null) { clearTimeout(minuteur); minuteur = null; }
      const effacement = chaine.then(async () => {
        const db = await connexion(c);
        await transactionJournal(db, "readwrite", (s) => s.clear());
        majCompteurs(c.empreinte, { releves: 0 });
      });
      chaine = effacement.catch(() => undefined);
      await effacement;
    },
    echecs: () => echecs,
    lotsIllisibles: () => lotsIllisibles,
    enAttente: () => tampon.length,
    fermer: () => {
      desabonnerCompte();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", surVisibilite);
      if (minuteur !== null) { clearTimeout(minuteur); minuteur = null; }
    },
  };
}

/** IndexedDB si possible, sinon la memoire (et l'ecran le dit). */
export function ouvrirStockage(options?: OptionsJournal): StockageJournal {
  return stockageIndexedDb(options) ?? stockageMemoire();
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
