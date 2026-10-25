import { api } from "./api";

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
}

const CACHE_TERRAIN = "bdri_terrain_referentiels";
const CACHE_CATALOGUE = "bdri_terrain_catalogue_defauts";

function lireCache<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

function ecrireCache(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Le formulaire reste utilisable en ligne si le navigateur refuse le stockage.
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

  if (!navigator.onLine) return { troncons, catalogue, tronconsEnCache, catalogueEnCache };

  const [tronconsResult, catalogueResult] = await Promise.allSettled([
    api.get("/troncons", { params: { pageSize: 200, sortBy: "code", sortDir: "asc" } }),
    api.get("/v2/defauts/catalogue"),
  ]);

  if (tronconsResult.status === "fulfilled") {
    // Pack de mission COMPLET (phase 2 SMART FIELD) : le reseau porte ~1 580 troncons,
    // une seule page de 200 en privait l'agent hors ligne de 87 % du referentiel. On
    // descend toutes les pages (plafond de securite 12 pages = 2 400).
    let rows: Array<{ id: string; code: string; nom: string }> = tronconsResult.value.data.data ?? [];
    let page = 1;
    while (rows.length >= 200 && page < 12) {
      page += 1;
      const suivante = await api.get<{ data: Array<{ id: string; code: string; nom: string }> }>("/troncons", { params: { pageSize: 200, page, sortBy: "code", sortDir: "asc" } });
      const lot: Array<{ id: string; code: string; nom: string }> = suivante.data.data ?? [];
      rows = rows.concat(lot);
      if (lot.length < 200) break;
    }
    troncons = rows.map((t) => ({ id: t.id, code: t.code, nom: t.nom }));
    ecrireCache(CACHE_TERRAIN, { ...cachedTerrain, troncons, cachedAt: new Date().toISOString() });
    tronconsEnCache = troncons.length > 0;
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

  return { troncons, catalogue, tronconsEnCache, catalogueEnCache };
}

/** 
 * Etat du PACK DE MISSION sans rien telecharger : ce qui est deja sur le telephone, avec
 * sa fraicheur. C'est ce que la checklist « Preparer la mission » affiche avant le depart.
 */
export interface EtatPack { troncons: number; catalogue: number; tronconsLe: string | null; catalogueLe: string | null }

export function etatPackMission(): EtatPack {
  const terrain = lireCache<{ troncons?: TronconTerrain[]; cachedAt?: string }>(CACHE_TERRAIN, {});
  const catalogue = lireCache<TypeCatalogueDefaut[]>(CACHE_CATALOGUE, []);
  const catalogueLe = lireCache<{ cachedAt?: string }>(CACHE_CATALOGUE + "_at", {}).cachedAt ?? null;
  return {
    troncons: Array.isArray(terrain.troncons) ? terrain.troncons.length : 0,
    catalogue: Array.isArray(catalogue) ? catalogue.length : 0,
    tronconsLe: terrain.cachedAt ?? null,
    catalogueLe,
  };
}
