/**
 * Choix du CRS source : regles pures (liste blanche, norme du format, declaration du fichier). Sans E/S, sans base.
 * Contrat : docs/projets-voirie/CONTRAT-IMPORT.md, section 5.
 *
 * AUCUNE TRANSFORMATION SILENCIEUSE ET AUCUN CRS DEVINE :
 *   - KML, KMZ, GPX : WGS 84 par la norme du format ; un autre CRS demande est INCOMPATIBLE avec le format ;
 *   - GeoJSON : WGS 84 par la RFC 7946, sauf membre `crs` projete, qui exige que l'utilisateur CONFIRME le meme code (`epsgSource`) ;
 *     sans membre `crs`, l'utilisateur peut choisir un CRS projete (GeoJSON non conforme, courant a la sortie d'un outil de DAO) ;
 *   - CSV : le CRS est OBLIGATOIRE (CRS_REQUIS), jamais deduit ;
 *   - un CRS choisi par l'utilisateur doit etre dans la liste blanche (CRS_NON_AUTORISE sinon : non valide par le DSI).
 * Le calcul lui-meme (ST_Transform, PROJ) est fait par la base : voir crs.service.ts.
 */

import { ErreurLecture } from "../lecture.types";
import type { Bbox, FormatFichier } from "../lecture.types";

export const EPSG_CIBLE = 4326;
/** `declare_dans_le_fichier` : le fichier declare lui-meme un CRS projete (membre `crs` d'un GeoJSON) et l'utilisateur l'a confirme (defaut D5 du pilote :
 * ce cas etait annonce comme un choix de l'utilisateur, inverifiable, alors que le fichier le porte). */
export type OrigineCrs = "norme_du_format" | "choisi_par_utilisateur" | "declare_dans_le_fichier";

export interface MetaCrs {
  epsg: number;
  nom: string;
  unite: string;
  geographique: boolean;
}

export const META_WGS84: MetaCrs = { epsg: 4326, nom: "WGS 84", unite: "degre", geographique: true };

export const libelleCrs = (m: MetaCrs): string => `EPSG:${m.epsg} (${m.nom})`;

export interface ChoixCrs {
  epsg: number;
  origine: OrigineCrs;
  /** Vrai si les coordonnees doivent passer par ST_Transform. */
  transformer: boolean;
}

const FORMATS_WGS84_PAR_NORME: ReadonlySet<FormatFichier> = new Set(["KML", "KMZ", "GPX"]);

/**
 * Decide du CRS source d'un fichier.
 * @param declare CRS declare par le fichier lui-meme (membre `crs` d'un GeoJSON) : `null` si absent.
 */
export function choisirCrs(format: FormatFichier, epsgSource: number | undefined, declare: { nom: string; epsg: number | null } | null, autorises: readonly number[]): ChoixCrs {
  if (FORMATS_WGS84_PAR_NORME.has(format)) {
    if (epsgSource !== undefined && epsgSource !== EPSG_CIBLE) {
      throw new ErreurLecture("CRS_INCOMPATIBLE_FORMAT", `un fichier ${format} est en WGS 84 par la norme : le CRS EPSG:${epsgSource} ne peut pas lui etre applique (utilisez un GeoJSON ou un CSV pour des coordonnees projetees)`);
    }
    return { epsg: EPSG_CIBLE, origine: "norme_du_format", transformer: false };
  }

  if (format === "GEOJSON") {
    if (declare && declare.epsg === null) {
      throw new ErreurLecture("CRS_NON_SUPPORTE", `systeme de coordonnees « ${declare.nom} » non pris en charge : seuls les codes EPSG de la liste blanche sont admis`);
    }
    if (declare && declare.epsg !== EPSG_CIBLE) {
      // Le fichier declare un CRS projete : l'utilisateur doit le CONFIRMER, et il doit etre autorise.
      if (epsgSource === undefined) {
        throw new ErreurLecture("CRS_REQUIS", `le fichier declare EPSG:${declare.epsg} : confirmez-le en envoyant epsgSource=${declare.epsg} (liste blanche : ${autorises.join(", ")})`);
      }
      if (epsgSource !== declare.epsg) {
        throw new ErreurLecture("CRS_CONFLIT", `le fichier declare EPSG:${declare.epsg} mais EPSG:${epsgSource} est demande : un CRS declare ne se surcharge pas`);
      }
    } else if (declare && epsgSource !== undefined && epsgSource !== EPSG_CIBLE) {
      throw new ErreurLecture("CRS_CONFLIT", `le fichier declare WGS 84 (EPSG:4326) mais EPSG:${epsgSource} est demande`);
    }
    const choisi = epsgSource ?? (declare?.epsg ?? EPSG_CIBLE);
    if (epsgSource === undefined) return { epsg: EPSG_CIBLE, origine: "norme_du_format", transformer: false };
    verifierListeBlanche(choisi, autorises);
    const origine: OrigineCrs = declare && declare.epsg === choisi ? "declare_dans_le_fichier" : "choisi_par_utilisateur";
    return { epsg: choisi, origine, transformer: choisi !== EPSG_CIBLE };
  }

  // CSV : jamais devine.
  if (epsgSource === undefined) {
    throw new ErreurLecture("CRS_REQUIS", `le CRS des coordonnees d'un CSV doit etre choisi (epsgSource) : il n'est jamais devine. Liste blanche : ${autorises.map((e) => `EPSG:${e}`).join(", ")}`);
  }
  verifierListeBlanche(epsgSource, autorises);
  return { epsg: epsgSource, origine: "choisi_par_utilisateur", transformer: epsgSource !== EPSG_CIBLE };
}

function verifierListeBlanche(epsg: number, autorises: readonly number[]): void {
  if (!autorises.includes(epsg)) {
    throw new ErreurLecture("CRS_NON_AUTORISE", `EPSG:${epsg} n'est pas dans la liste des CRS source autorises (non valide par le DSI) : ${autorises.map((e) => `EPSG:${e}`).join(", ")}`);
  }
}

/** Methode lisible pour `resume.crs.methode`. */
export function libelleMethode(transformer: boolean, versionProj: string | null): string {
  return transformer ? `ST_Transform (PostGIS${versionProj ? `, PROJ ${versionProj}` : ", PROJ"})` : "aucune transformation";
}

export interface Plausibilite {
  zoneAttendue: { nom: string; bbox: Bbox };
  empriseResultat: Bbox | null;
  nbElementsHorsZone: number;
  nbObjets: number;
  statut: "CONFORME" | "PARTIELLEMENT_HORS_ZONE";
  confirmationRequise: boolean;
  confirmee: boolean;
}

/** Metadonnees d'un CRS depuis une ligne de `spatial_ref_sys` (le nom est celui du WKT, l'unite se lit dans la definition PROJ). */
export function metaDepuisSpatialRef(l: { srid: number; srtext: string | null; proj4text: string | null }): MetaCrs {
  const proj = l.proj4text ?? "";
  const wkt = l.srtext ?? "";
  const geographique = /\+proj=longlat/.test(proj) || (/^\s*GEOG(CS|CRS)\[/.test(wkt) && !/PROJCS\[|PROJCRS\[/.test(wkt));
  const m = /^\s*(?:PROJCS|PROJCRS|GEOGCS|GEOGCRS)\["([^"]{1,120})"/.exec(wkt);
  let unite = "degre";
  if (!geographique) {
    const u = /\+units=([A-Za-z-]+)/.exec(proj)?.[1];
    unite = u === undefined || u === "m" ? "metre" : u === "us-ft" ? "pied US" : u === "ft" ? "pied" : u;
  }
  return { epsg: l.srid, nom: m ? m[1] : `EPSG:${l.srid}`, unite, geographique };
}

/**
 * CRS d'un fichier CONVERTI par la chaine GDAL (lot B2) : le conteneur a deja transforme les coordonnees vers WGS 84 a partir du CRS qu'il a lu (GeoPackage,
 * .prj) ou que l'utilisateur a confirme (`epsg_source`) ; ici on decide si CE CRS peut etre ADMIS, avec les memes regles que les autres formats :
 *   - jamais devine : sans CRS connu (coordonnees brutes), `CRS_REQUIS` ; un CRS sans code EPSG est refuse (`CRS_NON_SUPPORTE`) ;
 *   - Shapefile : la confirmation de l'utilisateur est TOUJOURS exigee (le .prj est lu, il ne vaut pas confirmation) ;
 *   - GeoPackage : un CRS declare EPSG:4326 est admis tel quel ; un CRS declare projete exige la confirmation du MEME code (comme un GeoJSON) ;
 *   - DXF : le CRS vient toujours de la demande (un DXF n'a pas de georeferencement) ;
 *   - un CRS confirme different du CRS declare est refuse (`CRS_CONFLIT`) : un CRS declare ne se surcharge pas ; un CRS projete doit etre dans la liste blanche.
 * `confirme` = l'option de la requete, a defaut le choix fait a la creation du job ; deux valeurs differentes sont un conflit.
 */
export function choisirCrsConverti(
  format: "GPKG" | "SHAPEFILE" | "DXF",
  source: { origine: "fichier" | "demande"; epsg: number | null; nom: string | null } | null,
  coordonnees: "wgs84" | "brutes",
  dejaConfirme: number | undefined,
  optionRequete: number | undefined,
  autorises: readonly number[],
): ChoixCrs {
  if (dejaConfirme !== undefined && optionRequete !== undefined && dejaConfirme !== optionRequete) {
    throw new ErreurLecture("CRS_CONFLIT", `EPSG:${optionRequete} est demande mais la conversion a ete faite avec EPSG:${dejaConfirme} : relancez une conversion avec le bon epsgSource`);
  }
  const confirme = optionRequete ?? dejaConfirme;
  if (coordonnees === "brutes" || source === null) {
    throw new ErreurLecture("CRS_REQUIS", "le fichier n'a pas de systeme de coordonnees : il n'est jamais devine. Creez un nouveau job de conversion avec epsgSource");
  }
  if (source.epsg === null) {
    throw new ErreurLecture("CRS_NON_SUPPORTE", "le systeme de coordonnees du fichier n'a pas de code EPSG identifiable : seuls les codes EPSG de la liste blanche sont admis");
  }
  if (source.origine === "demande") {
    if (confirme !== undefined && confirme !== source.epsg) throw new ErreurLecture("CRS_CONFLIT", `EPSG:${confirme} est demande mais la conversion a ete faite avec EPSG:${source.epsg}`);
    if (source.epsg !== EPSG_CIBLE) verifierListeBlanche(source.epsg, autorises);
    return { epsg: source.epsg, origine: "choisi_par_utilisateur", transformer: false };
  }
  // CRS declare par le fichier
  const declare = source.epsg;
  if (format === "SHAPEFILE" && confirme === undefined) {
    throw new ErreurLecture("CRS_REQUIS", `le .prj du Shapefile declare EPSG:${declare} : confirmez-le (epsgSource=${declare}), un .prj ne vaut pas confirmation`);
  }
  if (confirme !== undefined && confirme !== declare) {
    throw new ErreurLecture("CRS_CONFLIT", `le fichier declare EPSG:${declare} mais EPSG:${confirme} est confirme : un CRS declare ne se surcharge pas`);
  }
  if (declare === EPSG_CIBLE && confirme === undefined) return { epsg: EPSG_CIBLE, origine: "declare_dans_le_fichier", transformer: false };
  if (confirme === undefined) {
    throw new ErreurLecture("CRS_REQUIS", `le fichier declare EPSG:${declare} : confirmez-le en envoyant epsgSource=${declare} (liste blanche : ${autorises.join(", ")})`);
  }
  if (declare !== EPSG_CIBLE) verifierListeBlanche(declare, autorises);
  // Defaut D5 : le CRS vient du fichier (confirme par l'utilisateur), ce n'est pas un choix inverifiable.
  return { epsg: declare, origine: "declare_dans_le_fichier", transformer: false };
}
