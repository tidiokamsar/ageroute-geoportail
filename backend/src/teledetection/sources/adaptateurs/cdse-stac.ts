/**
 * Adaptateur du catalogue STAC du Copernicus Data Space Ecosystem (CDSE) : Sentinel-2 L2A et L1C,
 * Sentinel-1 GRD. RECHERCHE ANONYME seulement (constate le 25/10/2026) : le telechargement et le
 * traitement exigent un jeton OIDC ou des cles S3, que ce lot ne detient pas.
 *
 * Le catalogue OData du CDSE n'est PAS utilise : sur la meme requete il a repondu en 44 s contre 0,5 a
 * 3,9 s pour le STAC (mesures de l'agent « sources reelles », 25/10/2026).
 *
 * `fields` : sans cette extension, un item L2A pese une septantaine de Ko (47 actifs). On ne demande
 * que ce que la normalisation lit : l'emprise, quelques proprietes, la resolution des bandes natives,
 * et les actifs retenus pour les liens.
 */
import { AdaptateurStac, urlBaseValide, type OptionsAdaptateurStac } from "./commun";
import { LIMITES_CDSE } from "../quotas";
import { RESOLUTION_S1_IW_GRDH, RESOLUTION_S2_PAR_BANDE_M } from "../normalisation";
import type { DescriptifSource } from "../contrat";
import type { ConfigStac } from "../stac";

export const URL_STAC_CDSE = "https://stac.dataspace.copernicus.eu/v1";

const PROPRIETES_COMMUNES = [
  "datetime", "start_datetime", "end_datetime", "platform", "constellation", "gsd", "product:type",
  "processing:level", "processing:version", "sat:orbit_state", "sat:relative_orbit", "sat:absolute_orbit",
  "published", "_private.product_size",
];
const PROPRIETES_S2 = ["eo:cloud_cover", "grid:code", "statistics.nodata"];
const PROPRIETES_S1 = ["sar:instrument_mode", "sar:polarizations", "sar:pixel_spacing_range", "sar:pixel_spacing_azimuth"];

const DETAIL_ACTIF = ["href", "type", "roles", "file:size", "gsd"];

function actifComplet(cle: string): string[] { return DETAIL_ACTIF.map((d) => `assets.${cle}.${d}`); }
function actifGsd(cle: string): string[] { return [`assets.${cle}.gsd`]; }

const L2A_LIENS = ["B02_10m", "B03_10m", "B04_10m", "B08_10m", "B8A_20m", "B11_20m", "B12_20m", "SCL_20m", "TCI_10m", "Product"];
const L2A_GSD = ["B01_60m", "B05_20m", "B06_20m", "B07_20m", "B09_60m"];
const L1C_LIENS = ["B02", "B03", "B04", "B08", "B8A", "B11", "B12", "TCI", "Product"];
const L1C_GSD = ["B01", "B05", "B06", "B07", "B09", "B10"];
const S1_LIENS = ["vv", "vh", "Product"];

export function champsCdse(collection: string): { include: string[] } | undefined {
  const base = ["id", "bbox", "geometry", "collection"];
  const vignette = ["thumbnail"].flatMap(actifComplet);
  switch (collection) {
    case "sentinel-2-l2a":
      return { include: [...base, ...[...PROPRIETES_COMMUNES, ...PROPRIETES_S2].map((p) => `properties.${p}`), ...vignette, ...L2A_LIENS.flatMap(actifComplet), ...L2A_GSD.flatMap(actifGsd)] };
    case "sentinel-2-l1c":
      return { include: [...base, ...[...PROPRIETES_COMMUNES, ...PROPRIETES_S2].map((p) => `properties.${p}`), ...vignette, ...L1C_LIENS.flatMap(actifComplet), ...L1C_GSD.flatMap(actifGsd)] };
    case "sentinel-1-grd":
      return { include: [...base, ...[...PROPRIETES_COMMUNES, ...PROPRIETES_S1].map((p) => `properties.${p}`), ...vignette, ...S1_LIENS.flatMap(actifComplet)] };
    default:
      return undefined;
  }
}

export const DESCRIPTIF_CDSE: DescriptifSource = {
  code: "cdse-stac",
  nom: "Copernicus Data Space Ecosystem, catalogue STAC",
  fournisseur: "Copernicus Data Space Ecosystem (ESA ; Commission europeenne ; hebergement CloudFerro)",
  interface: "INTERFACE_ACTIVE",
  urlService: URL_STAC_CDSE,
  capteurs: ["Sentinel-2 (MSI)", "Sentinel-1 (SAR bande C)"],
  collections: [
    { id: "sentinel-2-l2a", capteur: "SENTINEL-2", nature: "OPTIQUE", niveau: "L2A", parDefaut: true },
    { id: "sentinel-2-l1c", capteur: "SENTINEL-2", nature: "OPTIQUE", niveau: "L1C", parDefaut: false },
    { id: "sentinel-1-grd", capteur: "SENTINEL-1", nature: "RADAR", niveau: "L1_GRD", parDefaut: false },
  ],
  resolutionsNatives: {
    "SENTINEL-2": { ...RESOLUTION_S2_PAR_BANDE_M },
    "SENTINEL-1": { VV: RESOLUTION_S1_IW_GRDH.portee, VH: RESOLUTION_S1_IW_GRDH.portee },
  },
  licence: {
    libelle: "Conditions d'utilisation des donnees Copernicus Sentinel : acces gratuit, source a citer (Sentinel Data Legal Notice)",
    url: "https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice",
    attribution: "Contains modified Copernicus Sentinel data [annee]",
  },
  exigencesAcces: {
    recherche: "ANONYME",
    telechargement: "COMPTE",
    traitement: "COMPTE",
    // noms PREVUS pour le Lot suivant ; aucun n'est lu par ce lot
    variablesEnvironnement: ["CDSE_OIDC_CLIENT_ID", "CDSE_OIDC_CLIENT_SECRET", "CDSE_S3_ACCESS_KEY", "CDSE_S3_SECRET_KEY"],
  },
};

export class AdaptateurCdseStac extends AdaptateurStac {
  constructor(options: OptionsAdaptateurStac = {}) {
    const { urlBase, ...client } = options;
    const cfg: ConfigStac = {
      source: "cdse-stac", fournisseur: "CDSE", urlBase: urlBaseValide(urlBase ?? URL_STAC_CDSE),
      collectionsParDefaut: ["sentinel-2-l2a"], champs: champsCdse,
    };
    super("cdse-stac", DESCRIPTIF_CDSE, cfg, LIMITES_CDSE, client);
  }
}

export function creerAdaptateurCdseStac(options?: OptionsAdaptateurStac): AdaptateurCdseStac {
  return new AdaptateurCdseStac(options);
}
