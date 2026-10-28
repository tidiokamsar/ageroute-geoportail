import { api } from "./api";
import { ecrireStockageLocal, lireStockageLocal } from "./compteCourant";

export type MesureDefaut = "NOMBRE" | "LONGUEUR" | "LARGEUR" | "PROFONDEUR" | "QUANTITE";

export interface TypeCatalogueDefaut {
  code: string;
  libelle: string;
  famille: string;
  unite: "UNITE" | "METRE" | "METRE_CARRE" | "METRE_CUBE";
  mesuresRequises: MesureDefaut[];
  graviteMax: number | null;
}

export interface TronconTerrain {
  id: string;
  code: string;
  nom: string;
}

export interface ReferentielsDefautsTerrain {
  troncons: TronconTerrain[];
  catalogue: TypeCatalogueDefaut[];
  tronconsEnCache: boolean;
  catalogueEnCache: boolean;
  /** Total annonce par le serveur, ou `null` s'il ne l'a pas donne. */
  tronconsTotal?: number | null;
  /** Vrai si le pack n'a pas tout : plafond de pages atteint, ou copie locale refusee par le navigateur. Jamais passe sous silence. */
  tronconsIncomplets?: boolean;
}

/** Plafond de securite du nombre de pages (200 par page : 20 000 troncons). Au-dela, le pack se dit INCOMPLET. */
const PAGES_MAX = 100;

/**
 * Noms des copies locales. Elles vivent sous le prefixe du COMPTE COURANT (compteCourant.ts : `bdri:<empreinte>:<nom>`),
 * en clair mais cloisonnees : un autre agent du meme telephone ne les lit pas par l'application. Sans compte ouvert, rien
 * n'est lu ni ecrit.
 */
export const CACHE_TERRAIN = "terrain.referentiels";
const CACHE_CATALOGUE = "terrain.catalogue_defauts";

function lireCache<T>(key: string, fallback: T): T {
  try {
    const value = lireStockageLocal(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

/** Vrai si la copie a ete ecrite. Faux (quota, mode prive, aucun compte ouvert) : le formulaire reste utilisable en ligne, mais le pack n'est PAS sur l'appareil. */
function ecrireCache(key: string, value: unknown): boolean {
  try {
    return ecrireStockageLocal(key, JSON.stringify(value));
  } catch {
    return false;
  }
}

/** Charge les listes de choix en ligne et conserve une copie lisible hors connexion. */
export async function chargerReferentielsDefautsTerrain(): Promise<ReferentielsDefautsTerrain> {
  const cachedTerrain = lireCache<{ troncons?: TronconTerrain[]; ouvrages?: unknown[]; cachedAt?: string }>(
    CACHE_TERRAIN,
    {},
  );
  let troncons = Array.isArray(cachedTerrain.troncons) ? cachedTerrain.troncons : [];
  let catalogue = lireCache<TypeCatalogueDefaut[]>(CACHE_CATALOGUE, []);
  let tronconsEnCache = troncons.length > 0;
  let catalogueEnCache = catalogue.length > 0;
  let tronconsTotal: number | null = (cachedTerrain as { tronconsTotal?: number | null }).tronconsTotal ?? null;
  let tronconsIncomplets = tronconsTotal !== null && troncons.length < tronconsTotal;

  if (!navigator.onLine) return { troncons, catalogue, tronconsEnCache, catalogueEnCache, tronconsTotal, tronconsIncomplets };

  const [tronconsResult, catalogueResult] = await Promise.allSettled([
    api.get("/troncons", { params: { pageSize: 200, sortBy: "code", sortDir: "asc" } }),
    api.get("/v2/defauts/catalogue"),
  ]);

  if (tronconsResult.status === "fulfilled") {
    // Pack de mission COMPLET (phase 2 SMART FIELD) : toutes les pages, jusqu'au total annonce par le serveur. Un plafond
    // de securite existe (PAGES_MAX) ; s'il est atteint, ou si le navigateur refuse la copie, le pack est dit INCOMPLET.
    const premiere = tronconsResult.value.data as { data?: Array<{ id: string; code: string; nom: string }>; total?: number };
    let rows: Array<{ id: string; code: string; nom: string }> = premiere.data ?? [];
    const total = typeof premiere.total === "number" ? premiere.total : null;
    let page = 1;
    let derniereComplete = rows.length >= 200;
    while (page < PAGES_MAX && (total !== null ? rows.length < total : derniereComplete)) {
      page += 1;
      const suivante = await api.get<{ data: Array<{ id: string; code: string; nom: string }> }>("/troncons", { params: { pageSize: 200, page, sortBy: "code", sortDir: "asc" } });
      const lot: Array<{ id: string; code: string; nom: string }> = suivante.data.data ?? [];
      rows = rows.concat(lot);
      derniereComplete = lot.length >= 200;
      if (lot.length === 0) break;
    }
    troncons = rows.map((t) => ({ id: t.id, code: t.code, nom: t.nom }));
    const copie = ecrireCache(CACHE_TERRAIN, { ...cachedTerrain, troncons, tronconsTotal: total, cachedAt: new Date().toISOString() });
    tronconsEnCache = copie && troncons.length > 0;
    tronconsTotal = total;
    tronconsIncomplets = !copie || (total !== null ? troncons.length < total : derniereComplete);
  }

  if (catalogueResult.status === "fulfilled") {
    const rows = catalogueResult.value.data.catalogue;
    if (Array.isArray(rows)) {
      catalogue = rows as TypeCatalogueDefaut[];
      ecrireCache(CACHE_CATALOGUE, catalogue);
      ecrireCache(CACHE_CATALOGUE + "_at", { cachedAt: new Date().toISOString() });
      catalogueEnCache = catalogue.length > 0;
    }
  }

  return { troncons, catalogue, tronconsEnCache, catalogueEnCache, tronconsTotal, tronconsIncomplets };
}

/** 
 * Etat du PACK DE MISSION sans rien telecharger : ce qui est deja sur le telephone, avec
 * sa fraicheur. C'est ce que la checklist « Preparer la mission » affiche avant le depart.
 */
export interface EtatPack { troncons: number; catalogue: number; tronconsLe: string | null; catalogueLe: string | null; tronconsTotal: number | null; tronconsIncomplets: boolean }

export function etatPackMission(): EtatPack {
  const terrain = lireCache<{ troncons?: TronconTerrain[]; cachedAt?: string; tronconsTotal?: number | null }>(CACHE_TERRAIN, {});
  const catalogue = lireCache<TypeCatalogueDefaut[]>(CACHE_CATALOGUE, []);
  const catalogueLe = lireCache<{ cachedAt?: string }>(CACHE_CATALOGUE + "_at", {}).cachedAt ?? null;
  return {
    troncons: Array.isArray(terrain.troncons) ? terrain.troncons.length : 0,
    catalogue: Array.isArray(catalogue) ? catalogue.length : 0,
    tronconsLe: terrain.cachedAt ?? null,
    catalogueLe,
    tronconsTotal: terrain.tronconsTotal ?? null,
    // Incomplet : le serveur annoncait plus de troncons que la copie n'en porte.
    tronconsIncomplets: typeof terrain.tronconsTotal === "number" && Array.isArray(terrain.troncons) && terrain.troncons.length < terrain.tronconsTotal,
  };
}
