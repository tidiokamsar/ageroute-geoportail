/**
 * Normalisation d'un item STAC (CDSE ou Earth Search) en ProduitNormalise. Noyau pur : ni reseau,
 * ni horloge, ni base.
 *
 * REGLES TENUES ICI
 *   - une donnee absente reste null : la couverture nuageuse d'un radar est null, celle d'un optique
 *     sans `eo:cloud_cover` est null avec un avertissement, jamais 0 ;
 *   - une emprise invalide, une date illisible, une collection inconnue ou une resolution
 *     indeterminable ECARTENT le produit avec une cause : on ne fabrique ni rectangle de remplacement
 *     ni resolution plausible ;
 *   - la resolution native vient des metadonnees du fournisseur quand elles couvrent les bandes
 *     principales, sinon de la table documentee du capteur (et l'origine est dite) ;
 *   - aucun lien ne garde de parametre de requete ni d'identifiant (signature, jeton).
 */
import { nettoyerLien } from "./http";
import { validerPolygone } from "./geometrie";
import type {
  AccesLien, Capteur, CodeSource, LicenceProduit, LienActif, NatureObservation, NiveauTraitement,
  OrbiteProduit, ProduitNormalise,
} from "./contrat";

export interface ContexteNormalisation {
  source: CodeSource;
  fournisseur: "CDSE" | "EARTH_SEARCH";
  /** Collection de la requete, utilisee si l'item ne la porte pas. */
  collection: string;
}

export interface Avertissement { code: string; message: string }

export type ResultatNormalisation =
  | { ok: true; produit: ProduitNormalise; avertissements: Avertissement[] }
  | { ok: false; code: string; message: string; identifiant: string | null };

interface DescriptionCollection { capteur: Capteur; nature: NatureObservation; niveau: NiveauTraitement }

export const COLLECTIONS_CONNUES: Record<string, DescriptionCollection> = {
  "sentinel-2-l2a": { capteur: "SENTINEL-2", nature: "OPTIQUE", niveau: "L2A" },
  "sentinel-2-l1c": { capteur: "SENTINEL-2", nature: "OPTIQUE", niveau: "L1C" },
  "sentinel-1-grd": { capteur: "SENTINEL-1", nature: "RADAR", niveau: "L1_GRD" },
  "landsat-c2-l2": { capteur: "LANDSAT", nature: "OPTIQUE", niveau: "L2" },
};

/**
 * Resolutions natives de Sentinel-2 par bande (m). Source : « four bands at 10 m, six bands at 20 m
 * and three bands at 60 m » (documentation CDSE, page Sentinel-2) ; l'affectation des bandes aux trois
 * resolutions suit les actifs publies par le CDSE (B02, B03, B04, B08 a 10 m ; B05, B06, B07, B8A, B11,
 * B12 a 20 m ; B01, B09, B10 a 60 m). B10 (cirrus) n'existe pas en L2A.
 */
export const RESOLUTION_S2_PAR_BANDE_M: Record<string, number> = {
  B01: 60, B02: 10, B03: 10, B04: 10, B05: 20, B06: 20, B07: 20, B08: 10, B8A: 20, B09: 60, B10: 60, B11: 20, B12: 20,
};
const BANDES_PRINCIPALES_S2 = ["B02", "B03", "B04", "B08"];

/**
 * Sentinel-1 IW GRDH : resolution spatiale 20 m (portee) x 22 m (azimut), pixel de 10 m. Valeurs
 * lues dans les metadonnees reelles d'Earth Search (sar:resolution_range = 20, sar:resolution_azimuth
 * = 22, sar:pixel_spacing_range = 10, capture du 25/10/2026) ; le STAC du CDSE ne les publie pas, d'ou
 * la table. Les autres modes (EW, SM, WV) ne sont pas renseignes : le produit est ecarte.
 */
export const RESOLUTION_S1_IW_GRDH = { portee: 20, azimut: 22, pixel: 10 } as const;

const MGRS = /^(0[1-9]|[1-5]\d|60)[C-HJ-NP-X][A-HJ-NP-Z][A-HJ-NP-V]$/;

const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nombre = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const texte = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/** ISO 8601 UTC, ou null. Une date sans fuseau est lue comme UTC (les catalogues ne datent qu'en UTC). */
export function isoUtc(v: unknown): string | null {
  const s = texte(v);
  if (s === null) return null;
  const avecFuseau = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? s : /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : `${s}Z`;
  const t = Date.parse(avecFuseau);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function tuileMgrsValide(t: string): boolean {
  return MGRS.test(t);
}

function lireTuileMgrs(props: Record<string, unknown>, id: string): string | null {
  const grille = texte(props["grid:code"]);
  const m = grille?.match(/^MGRS-(\w{5})$/);
  if (m && MGRS.test(m[1])) return m[1];
  const z = nombre(props["mgrs:utm_zone"]);
  const b = texte(props["mgrs:latitude_band"]);
  const c = texte(props["mgrs:grid_square"]);
  if (z !== null && b && c) {
    const t = `${String(z).padStart(2, "0")}${b}${c}`;
    if (MGRS.test(t)) return t;
  }
  const dansId = id.match(/_T(\d{2}[A-Z]{3})_/);
  return dansId && MGRS.test(dansId[1]) ? dansId[1] : null;
}

function lireOrbite(props: Record<string, unknown>, nomProduit: string | null): OrbiteProduit {
  const sens = props["sat:orbit_state"];
  const entier = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);
  // Earth Search ne donne pas l'orbite relative de Sentinel-2, mais le nom ESA du produit la porte (« _R037_ »)
  const dansNom = nomProduit?.match(/_R(\d{3})_/);
  return {
    numeroRelatif: entier(props["sat:relative_orbit"]) ?? (dansNom ? Number(dansNom[1]) : null),
    numeroAbsolu: entier(props["sat:absolute_orbit"]),
    sens: sens === "ascending" || sens === "descending" ? sens : null,
  };
}

export function licencePour(capteur: Capteur, annee: number): LicenceProduit {
  if (capteur === "LANDSAT") {
    return {
      code: "USGS-LANDSAT-DOMAINE-PUBLIC",
      attribution: "Landsat Collection 2 Level-2, U.S. Geological Survey (domaine public ; citation recommandee)",
      url: "https://www.usgs.gov/core-science-systems/hdds/data-policy",
    };
  }
  return {
    code: "COPERNICUS-SENTINEL",
    attribution: `Contains modified Copernicus Sentinel data ${annee}`,
    url: "https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice",
  };
}

/** Qui peut lire ce lien. Les « ANONYME » ont ete constates par requete sans compte (voir SOURCES.md). */
export function classerAcces(href: string): AccesLien {
  if (/^s3:\/\/eodata\//i.test(href)) return "CLES_S3";
  if (/^s3:\/\//i.test(href)) return "IDENTIFIANTS_CLOUD";
  try {
    const u = new URL(href);
    if (u.hostname === "download.dataspace.copernicus.eu") return "JETON_OIDC";
    if (u.protocol === "https:" && u.hostname === "sentinel-cogs.s3.us-west-2.amazonaws.com") return "ANONYME";
  } catch {
    return "INCONNU";
  }
  return "INCONNU";
}

// --------------------------------------------------------------------------------------------
// Resolution
// --------------------------------------------------------------------------------------------

interface ResolutionLue {
  nativeM: number;
  parBande: Record<string, number>;
  origine: "FOURNISSEUR" | "TABLE_CAPTEUR";
  echantillonnageM: number | null;
}

function nomBandeS2(cle: string, actif: Record<string, unknown>): string | null {
  const direct = cle.match(/^(B\d{2}|B8A)(?:_\d+m)?$/);
  if (direct) return direct[1];
  const eo = Array.isArray(actif["eo:bands"]) ? (actif["eo:bands"] as unknown[])[0] : null;
  const nom = estObjet(eo) ? texte(eo.name) : null;
  return nom && /^(B\d{2}|B8A)$/.test(nom) ? nom : null;
}

function resolutionActif(actif: Record<string, unknown>): number | null {
  const g = nombre(actif.gsd);
  if (g !== null) return g;
  const rb = Array.isArray(actif["raster:bands"]) ? (actif["raster:bands"] as unknown[])[0] : null;
  return estObjet(rb) ? nombre(rb.spatial_resolution) : null;
}

function rolesDe(actif: Record<string, unknown>): string[] {
  return Array.isArray(actif.roles) ? (actif.roles as unknown[]).filter((r): r is string => typeof r === "string") : [];
}

function resolutionSentinel2(niveau: NiveauTraitement, assets: Record<string, unknown>): ResolutionLue {
  const lues: Record<string, number> = {};
  for (const [cle, brut] of Object.entries(assets)) {
    if (!estObjet(brut)) continue;
    const roles = rolesDe(brut);
    // un actif reechantillonne (B02_20m, B02_60m...) ne dit rien de la resolution native de la bande
    if (roles.some((r) => r.startsWith("sampling:") && r !== "sampling:original")) continue;
    // sans roles (item reduit par `fields`), seuls les actifs demandes figurent : natifs par construction
    if (roles.length > 0 && !roles.includes("reflectance")) continue;
    const bande = nomBandeS2(cle, brut);
    const r = resolutionActif(brut);
    if (!bande || r === null) continue;
    lues[bande] = lues[bande] === undefined ? r : Math.min(lues[bande], r);
  }
  const couvre = BANDES_PRINCIPALES_S2.every((b) => lues[b] !== undefined);
  if (couvre) {
    return { nativeM: Math.min(...BANDES_PRINCIPALES_S2.map((b) => lues[b])), parBande: lues, origine: "FOURNISSEUR", echantillonnageM: null };
  }
  const table: Record<string, number> = { ...RESOLUTION_S2_PAR_BANDE_M };
  if (niveau === "L2A") delete table.B10;
  return { nativeM: Math.min(...BANDES_PRINCIPALES_S2.map((b) => table[b])), parBande: table, origine: "TABLE_CAPTEUR", echantillonnageM: null };
}

function polarisations(props: Record<string, unknown>, id: string): string[] {
  const p = props["sar:polarizations"];
  if (Array.isArray(p) && p.length > 0 && p.every((x) => typeof x === "string")) return p as string[];
  const code = id.split("_")[3]?.slice(2) ?? "";
  return ({ DV: ["VV", "VH"], DH: ["HH", "HV"], SV: ["VV"], SH: ["HH"] } as Record<string, string[]>)[code] ?? [];
}

function resolutionSentinel1(props: Record<string, unknown>, id: string): ResolutionLue | null {
  const mode = texte(props["sar:instrument_mode"]) ?? id.split("_")[1] ?? null;
  const type = texte(props["product:type"]) ?? texte(props["sar:product_type"]) ?? "";
  const portee = nombre(props["sar:resolution_range"]);
  const azimut = nombre(props["sar:resolution_azimuth"]);
  const pixel = nombre(props["sar:pixel_spacing_range"]);
  const pols = polarisations(props, id);
  const cles = pols.length > 0 ? pols : ["GRD"];
  let nativeM: number;
  let origine: ResolutionLue["origine"];
  if (portee !== null && azimut !== null) {
    nativeM = Math.min(portee, azimut);
    origine = "FOURNISSEUR";
  } else if (mode === "IW" && (/GRDH/.test(type) || /_GRDH_/.test(id))) {
    nativeM = Math.min(RESOLUTION_S1_IW_GRDH.portee, RESOLUTION_S1_IW_GRDH.azimut);
    origine = "TABLE_CAPTEUR";
  } else {
    return null;
  }
  return {
    nativeM, origine,
    parBande: Object.fromEntries(cles.map((c) => [c, nativeM])),
    echantillonnageM: pixel ?? (origine === "TABLE_CAPTEUR" ? RESOLUTION_S1_IW_GRDH.pixel : null),
  };
}

function resolutionLandsat(props: Record<string, unknown>, assets: Record<string, unknown>): ResolutionLue | null {
  const parBande: Record<string, number> = {};
  const reflectance: number[] = [];
  const gsdProduit = nombre(props.gsd);
  for (const brut of Object.values(assets)) {
    if (!estObjet(brut)) continue;
    const roles = rolesDe(brut);
    const eo = Array.isArray(brut["eo:bands"]) ? (brut["eo:bands"] as unknown[])[0] : null;
    const nom = estObjet(eo) ? texte(eo.common_name) ?? texte(eo.name) : null;
    if (!nom) continue;
    const r = nombre(brut.gsd) ?? resolutionActif(brut) ?? gsdProduit;
    if (r === null) continue;
    if (roles.includes("reflectance")) { parBande[nom] = r; reflectance.push(r); }
    else if (roles.includes("temperature")) parBande[nom] = r;
  }
  if (reflectance.length > 0) return { nativeM: Math.min(...reflectance), parBande, origine: "FOURNISSEUR", echantillonnageM: null };
  if (gsdProduit !== null) return { nativeM: gsdProduit, parBande: { MULTISPECTRAL: gsdProduit }, origine: "FOURNISSEUR", echantillonnageM: null };
  return null;
}

// --------------------------------------------------------------------------------------------
// Liens
// --------------------------------------------------------------------------------------------

const CLES_ACTIFS: Record<string, string[]> = {
  "CDSE|sentinel-2-l2a": ["B02_10m", "B03_10m", "B04_10m", "B08_10m", "B8A_20m", "B11_20m", "B12_20m", "SCL_20m", "TCI_10m", "Product"],
  "CDSE|sentinel-2-l1c": ["B02", "B03", "B04", "B08", "B8A", "B11", "B12", "TCI", "Product"],
  "CDSE|sentinel-1-grd": ["vv", "vh", "Product"],
  "EARTH_SEARCH|sentinel-2-l2a": ["blue", "green", "red", "nir", "nir08", "swir16", "swir22", "scl", "visual"],
  "EARTH_SEARCH|sentinel-1-grd": ["vv", "vh"],
  "EARTH_SEARCH|landsat-c2-l2": ["blue", "green", "red", "nir08", "swir16", "swir22", "qa_pixel"],
};

function lienDe(cle: string, brut: unknown): LienActif | null {
  if (!estObjet(brut)) return null;
  const href = texte(brut.href);
  if (!href) return null;
  const propre = nettoyerLien(href);
  if (propre === "") return null;
  const taille = nombre(brut["file:size"]);
  return {
    cle, href: propre, type: texte(brut.type), roles: rolesDe(brut), resolutionM: resolutionActif(brut),
    tailleOctets: taille !== null && taille >= 0 ? taille : null, acces: classerAcces(propre),
  };
}

// --------------------------------------------------------------------------------------------
// Brut (provenance)
// --------------------------------------------------------------------------------------------

const CLES_BRUT = [
  "datetime", "start_datetime", "end_datetime", "platform", "constellation", "instruments", "gsd",
  "product:type", "processing:level", "processing:version", "processing:datetime", "grid:code",
  "eo:cloud_cover", "eo:snow_cover", "sat:orbit_state", "sat:relative_orbit", "sat:absolute_orbit",
  "sar:instrument_mode", "sar:polarizations", "sar:product_type", "sar:resolution_range", "sar:resolution_azimuth",
  "sar:pixel_spacing_range", "sar:pixel_spacing_azimuth", "s2:product_uri", "s2:product_type",
  "s2:processing_baseline", "s2:nodata_pixel_percentage", "s2:degraded_msi_data_percentage", "s1:product_identifier",
  "landsat:scene_id", "landsat:wrs_path", "landsat:wrs_row", "landsat:cloud_cover_land", "landsat:collection_category",
  "landsat:correction", "proj:epsg", "created", "updated", "published",
];

function reduireBrut(item: Record<string, unknown>, props: Record<string, unknown>): Record<string, unknown> {
  const proprietes: Record<string, unknown> = {};
  for (const k of CLES_BRUT) if (props[k] !== undefined) proprietes[k] = props[k];
  const stats = estObjet(props.statistics) ? nombre(props.statistics.nodata) : null;
  if (stats !== null) proprietes["statistics.nodata"] = stats;
  const prive = estObjet(props._private) ? nombre(props._private.product_size) : null;
  if (prive !== null) proprietes["_private.product_size"] = prive;
  return { id: item.id, collection: item.collection ?? null, bbox: Array.isArray(item.bbox) ? item.bbox : null, proprietes };
}

// --------------------------------------------------------------------------------------------
// Item -> produit
// --------------------------------------------------------------------------------------------

function sceneS1(id: string): string {
  // CDSE ajoute un code de controle et « _COG » a l'identifiant d'Earth Search : les huit premiers segments sont communs
  return id.split("_").slice(0, 8).join("_");
}

export function normaliserItemStac(item: unknown, ctx: ContexteNormalisation): ResultatNormalisation {
  if (!estObjet(item)) return { ok: false, code: "ITEM_ILLISIBLE", message: "item STAC illisible", identifiant: null };
  const id = texte(item.id);
  if (!id) return { ok: false, code: "ITEM_ILLISIBLE", message: "item STAC sans identifiant", identifiant: null };
  const props = estObjet(item.properties) ? item.properties : null;
  if (!props) return { ok: false, code: "ITEM_ILLISIBLE", message: "item STAC sans proprietes", identifiant: id };

  const collection = texte(item.collection) ?? ctx.collection;
  const desc = COLLECTIONS_CONNUES[collection];
  if (!desc) return { ok: false, code: "COLLECTION_INCONNUE", message: `collection non prise en charge (${collection})`, identifiant: id };

  const dateAcquisition = isoUtc(props.datetime) ?? isoUtc(props.start_datetime);
  if (!dateAcquisition) return { ok: false, code: "DATE_INVALIDE", message: "date d'acquisition absente ou illisible", identifiant: id };

  const geo = validerPolygone(item.geometry);
  if (!geo.ok) return { ok: false, code: "EMPRISE_INVALIDE", message: geo.raison, identifiant: id };

  const assets = estObjet(item.assets) ? item.assets : {};
  const avertissements: Avertissement[] = [];

  let resolution: ResolutionLue | null;
  if (desc.capteur === "SENTINEL-2") resolution = resolutionSentinel2(desc.niveau, assets);
  else if (desc.capteur === "SENTINEL-1") resolution = resolutionSentinel1(props, id);
  else resolution = resolutionLandsat(props, assets);
  if (!resolution) return { ok: false, code: "RESOLUTION_INCONNUE", message: "resolution native indeterminable pour ce mode d'acquisition", identifiant: id };

  // Couverture nuageuse : absente reste absente.
  let nuages: number | null = null;
  let portee: "TUILE" | "SCENE" | null = null;
  if (desc.nature === "OPTIQUE") {
    const v = props["eo:cloud_cover"];
    if (v === undefined || v === null) avertissements.push({ code: "NUAGES_ABSENTS", message: "couverture nuageuse non annoncee par le fournisseur" });
    else if (nombre(v) === null || (v as number) < 0 || (v as number) > 100) avertissements.push({ code: "NUAGES_INVALIDES", message: `couverture nuageuse hors 0-100 ignoree (${String(v)})` });
    else { nuages = v as number; portee = desc.capteur === "SENTINEL-2" ? "TUILE" : "SCENE"; }
  }

  const plateforme = texte(props.platform);
  const tuileMgrs = desc.capteur === "SENTINEL-2" ? lireTuileMgrs(props, id) : null;
  if (desc.capteur === "SENTINEL-2" && tuileMgrs === null) avertissements.push({ code: "TUILE_MGRS_ABSENTE", message: "tuile MGRS non lisible" });
  const grille = texte(props["grid:code"]);
  const jour = dateAcquisition.slice(0, 10);

  let scene: string;
  let cleScene: string;
  if (desc.capteur === "SENTINEL-2") {
    scene = (texte(props["s2:product_uri"])?.replace(/\.SAFE$/, "")) ?? id;
    cleScene = `S2|${plateforme ?? "?"}|${desc.niveau}|${tuileMgrs ?? scene}|${jour}`;
  } else if (desc.capteur === "SENTINEL-1") {
    scene = sceneS1(id);
    cleScene = `S1|${scene}`;
  } else {
    scene = texte(props["landsat:scene_id"]) ?? id;
    cleScene = `LANDSAT|${plateforme ?? "?"}|${grille ?? id}|${jour}`;
  }

  const typeProduit = texte(props["product:type"]) ?? texte(props["s2:product_type"]) ??
    (desc.capteur === "SENTINEL-1" ? (() => { const p = id.split("_"); return p.length > 3 ? `${p[1]}_${p[2]}_${p[3].slice(0, 2)}` : null; })() : null) ??
    texte(props["landsat:correction"]);

  // Taille annoncee : l'archive telechargeable d'abord (actif Product), puis la taille du produit.
  const actifProduit = estObjet(assets.Product) ? nombre(assets.Product["file:size"]) : null;
  const tailleProduit = estObjet(props._private) ? nombre(props._private.product_size) : null;
  const tailleBrute = actifProduit ?? tailleProduit;
  const tailleOctetsAnnoncee = tailleBrute !== null && tailleBrute >= 0 ? tailleBrute : null;

  const cles = CLES_ACTIFS[`${ctx.fournisseur}|${collection}`] ?? [];
  const actifs = cles.map((c) => lienDe(c, assets[c])).filter((l): l is LienActif => l !== null);
  const vignette = lienDe("thumbnail", assets.thumbnail);

  const produit: ProduitNormalise = {
    identifiantFournisseur: id,
    fournisseur: ctx.fournisseur,
    source: ctx.source,
    collection,
    capteur: desc.capteur,
    nature: desc.nature,
    plateforme,
    typeProduit,
    niveauTraitement: desc.niveau,
    dateAcquisition,
    dateFinAcquisition: isoUtc(props.end_datetime),
    emprise: geo.polygone,
    orbite: lireOrbite(props, desc.capteur === "SENTINEL-2" ? scene : null),
    tuileMgrs,
    grille,
    scene,
    cleScene,
    resolutionNativeM: resolution.nativeM,
    resolutionParBande: resolution.parBande,
    resolutionOrigine: resolution.origine,
    echantillonnageM: resolution.echantillonnageM,
    couvertureNuagesPct: nuages,
    nuagesPortee: portee,
    licence: licencePour(desc.capteur, Number(jour.slice(0, 4))),
    tailleOctetsAnnoncee,
    liens: { vignette, actifs },
    empreinteSha256: null,
    brut: reduireBrut(item, props),
  };
  return { ok: true, produit, avertissements };
}
