/**
 * Adaptateur Earth Search (Element 84, sur AWS) : Sentinel-2 L2A, Sentinel-1 GRD, Landsat C2 L2
 * (RECHERCHE SEULEMENT pour Landsat). Sert de repli interchangeable au CDSE : meme contrat, memes
 * produits normalises, le catalogue differe.
 *
 * Constats du 25/10/2026 (requetes anonymes) : la recherche est anonyme ; les COG Sentinel-2 L2A et
 * leur vignette sont lisibles en HTTPS sans compte ; en revanche les actifs Sentinel-1 et Landsat sont
 * des objets s3:// (identifiants du cloud requis) et le champ `fields` n'allege pas les actifs : une
 * page pese donc de l'ordre de 15 Ko par item, d'ou une page par defaut plus courte.
 *
 * Particularite d'identification : l'identifiant Earth Search d'une scene Sentinel-2 (« S2C_28PES_
 * 20261025_0_L2A ») n'est pas celui du CDSE (nom du produit ESA). Le rapprochement entre catalogues se
 * fait par `cleScene`, jamais par l'identifiant.
 */
import { AdaptateurStac, urlBaseValide, type OptionsAdaptateurStac } from "./commun";
import { LIMITES_EARTH_SEARCH } from "../quotas";
import { RESOLUTION_S1_IW_GRDH, RESOLUTION_S2_PAR_BANDE_M } from "../normalisation";
import type { DescriptifSource } from "../contrat";
import type { ConfigStac } from "../stac";

export const URL_STAC_EARTH_SEARCH = "https://earth-search.aws.element84.com/v1";

export const DESCRIPTIF_EARTH_SEARCH: DescriptifSource = {
  code: "earth-search",
  nom: "Earth Search (Element 84), catalogue STAC sur AWS",
  fournisseur: "Element 84 (hebergement AWS ; donnees ESA, NASA et USGS)",
  interface: "INTERFACE_ACTIVE",
  urlService: URL_STAC_EARTH_SEARCH,
  capteurs: ["Sentinel-2 (MSI)", "Sentinel-1 (SAR bande C)", "Landsat 8 et 9 (OLI, TIRS)"],
  collections: [
    { id: "sentinel-2-l2a", capteur: "SENTINEL-2", nature: "OPTIQUE", niveau: "L2A", parDefaut: true },
    { id: "sentinel-1-grd", capteur: "SENTINEL-1", nature: "RADAR", niveau: "L1_GRD", parDefaut: false },
    { id: "landsat-c2-l2", capteur: "LANDSAT", nature: "OPTIQUE", niveau: "L2", parDefaut: false },
  ],
  resolutionsNatives: {
    "SENTINEL-2": Object.fromEntries(Object.entries(RESOLUTION_S2_PAR_BANDE_M).filter(([b]) => b !== "B10")),
    "SENTINEL-1": { VV: RESOLUTION_S1_IW_GRDH.portee, VH: RESOLUTION_S1_IW_GRDH.portee },
    "LANDSAT": { MULTISPECTRAL: 30, lwir11: 100 },
  },
  licence: {
    libelle: "Sentinel : Sentinel Data Legal Notice (acces gratuit, source a citer). Landsat : domaine public USGS (politique de donnees HDDS)",
    url: "https://sentinel.esa.int/documents/247904/690755/Sentinel_Data_Legal_Notice",
    attribution: "Contains modified Copernicus Sentinel data [annee] ; Landsat Collection 2 Level-2, U.S. Geological Survey",
  },
  exigencesAcces: {
    recherche: "ANONYME",
    // COG Sentinel-2 anonymes ; Sentinel-1 et Landsat en s3:// (identifiants AWS)
    telechargement: "VARIABLE",
    traitement: "NON_DISPONIBLE",
    variablesEnvironnement: [],
  },
};

export class AdaptateurEarthSearch extends AdaptateurStac {
  constructor(options: OptionsAdaptateurStac = {}) {
    const { urlBase, ...client } = options;
    const cfg: ConfigStac = {
      source: "earth-search", fournisseur: "EARTH_SEARCH", urlBase: urlBaseValide(urlBase ?? URL_STAC_EARTH_SEARCH),
      collectionsParDefaut: ["sentinel-2-l2a"], limiteParDefaut: 20,
    };
    super("earth-search", DESCRIPTIF_EARTH_SEARCH, cfg, LIMITES_EARTH_SEARCH, client);
  }
}

export function creerAdaptateurEarthSearch(options?: OptionsAdaptateurStac): AdaptateurEarthSearch {
  return new AdaptateurEarthSearch(options);
}
