/**
 * Point d'entree de la lecture des fichiers du module Projets de voirie et reseaux : detection du format PAR LE CONTENU
 * (jamais par l'extension seule), decodage, puis lecteur KML ou GeoJSON. Sans E/S : le fichier arrive en memoire.
 *
 * SECURITE DE LECTURE (contrat, section 4.1)
 *   - HTML, PDF, executable, image, binaire, octets NUL : CONTENU_NON_RECONNU ;
 *   - archives (KMZ, ZIP), Shapefile, DXF, DWG : FORMAT_NON_SUPPORTE, « prevu au lot suivant ». AUCUNE decompression n'est
 *     faite dans ce lot, donc aucune bombe de decompression n'est possible ;
 *   - XML sans DTD ni entite, imbrication XML et JSON bornees ;
 *   - le texte d'un attribut n'est jamais interprete (ni HTML, ni script) : il est conserve tel quel.
 *
 * Formats admis : KML et GeoJSON seulement.
 */

import { lireGeoJson } from "./lecture.geojson.noyau";
import { lireKml } from "./lecture.kml.noyau";
import { ErreurLecture, TAILLE_MAX_OCTETS, type InfoCrs, type ResultatLecture } from "./lecture.types";

export { ErreurLecture, TAILLE_MAX_OCTETS, OBJETS_MAX, BBOX_GUINEE } from "./lecture.types";
export type { ResultatLecture } from "./lecture.types";

/** Imbrication maximale d'un document JSON (tableaux et objets). */
export const PROFONDEUR_JSON_MAX = 64;

const PROCHAIN_LOT = "prevu au lot suivant ; dans ce lot seuls les formats KML et GeoJSON (WGS 84) sont pris en charge";

function extensionDe(nom: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(nom.trim());
  return m ? m[1].toLowerCase() : "";
}

const debutEgal = (b: Buffer, octets: number[]) => b.length >= octets.length && octets.every((o, i) => b[i] === o);

/** Reconnait par la SIGNATURE (et non l'extension) les contenus binaires et les archives. */
function contenuRefuse(b: Buffer, ext: string): ErreurLecture | null {
  // Archives : aucune decompression dans ce lot.
  if (debutEgal(b, [0x50, 0x4b, 0x03, 0x04]) || debutEgal(b, [0x50, 0x4b, 0x05, 0x06]) || debutEgal(b, [0x50, 0x4b, 0x07, 0x08])) {
    return new ErreurLecture("FORMAT_NON_SUPPORTE", `archive (KMZ ou ZIP) : la lecture des archives est ${PROCHAIN_LOT}. Decompressez le fichier .kml et deposez-le directement.`);
  }
  if (b.length >= 4 && b.readInt32BE(0) === 9994) return new ErreurLecture("FORMAT_NON_SUPPORTE", `Shapefile : ${PROCHAIN_LOT}.`);
  if (/^AC10\d\d/.test(b.subarray(0, 6).toString("latin1"))) return new ErreurLecture("FORMAT_NON_SUPPORTE", `fichier DWG : ${PROCHAIN_LOT}.`);
  if (["kmz", "zip", "shp", "shx", "dbf", "dxf", "dwg", "gpkg"].includes(ext)) {
    return new ErreurLecture("FORMAT_NON_SUPPORTE", `format .${ext} : ${PROCHAIN_LOT}.`);
  }
  // Contenus qui ne sont pas des donnees geographiques.
  const signatures: [number[], string][] = [
    [[0x25, 0x50, 0x44, 0x46, 0x2d], "document PDF"],
    [[0x7f, 0x45, 0x4c, 0x46], "executable"],
    [[0x4d, 0x5a], "executable"],
    [[0x23, 0x21], "script"],
    [[0x1f, 0x8b], "archive compressee"],
    [[0x89, 0x50, 0x4e, 0x47], "image"],
    [[0xff, 0xd8, 0xff], "image"],
    [[0x47, 0x49, 0x46, 0x38], "image"],
    [[0xd0, 0xcf, 0x11, 0xe0], "document binaire"],
    [[0x53, 0x51, 0x4c, 0x69], "base de donnees"],
  ];
  for (const [sig, nom] of signatures) {
    if (debutEgal(b, sig)) return new ErreurLecture("CONTENU_NON_RECONNU", `contenu non reconnu (${nom}) : deposez un fichier KML ou GeoJSON`);
  }
  // Octets NUL : jamais dans du texte KML ou GeoJSON en UTF-8 ou ISO-8859-1 (l'UTF-16 est reconnu a son BOM et traite a part).
  const utf16 = debutEgal(b, [0xff, 0xfe]) || debutEgal(b, [0xfe, 0xff]);
  if (!utf16 && b.indexOf(0) >= 0) return new ErreurLecture("CONTENU_NON_RECONNU", "contenu non reconnu : le fichier contient des octets NUL (binaire)");
  return null;
}

/** Decode le fichier en texte : UTF-8 (avec ou sans BOM), UTF-16 (BOM), ISO-8859-1 si le prologue XML le declare. */
export function decoderTexte(b: Buffer): string {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    const swap = Buffer.from(b.subarray(2));
    swap.swap16();
    return new TextDecoder("utf-16le").decode(swap);
  }
  const debut = b.subarray(0, 200).toString("latin1");
  const declaration = /^\s*<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(debut);
  if (declaration) {
    const enc = declaration[1].trim().toLowerCase();
    if (enc === "iso-8859-1" || enc === "latin1" || enc === "windows-1252" || enc === "iso-8859-15") return new TextDecoder("windows-1252").decode(b);
    if (!["utf-8", "utf8", "us-ascii", "ascii"].includes(enc)) {
      throw new ErreurLecture("ENCODAGE_NON_SUPPORTE", `encodage « ${declaration[1]} » non pris en charge : enregistrez le fichier en UTF-8`);
    }
  }
  const debutUtf = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(debutUtf));
  } catch {
    throw new ErreurLecture("ENCODAGE_NON_SUPPORTE", "le fichier n'est pas de l'UTF-8 valide : enregistrez-le en UTF-8");
  }
}

/** Imbrication maximale d'un document JSON, mesuree sans recursion (JSON.parse n'est appele qu'apres). */
export function profondeurJson(texte: string): number {
  let profondeur = 0, max = 0, dansChaine = false;
  for (let i = 0; i < texte.length; i++) {
    const c = texte.charCodeAt(i);
    if (dansChaine) {
      if (c === 0x5c) i++; // barre oblique inverse : saute le caractere echappe
      else if (c === 0x22) dansChaine = false;
    } else if (c === 0x22) dansChaine = true;
    else if (c === 0x5b || c === 0x7b) { profondeur++; if (profondeur > max) max = profondeur; }
    else if (c === 0x5d || c === 0x7d) profondeur--;
  }
  return max;
}

const CRS_KML: InfoCrs = {
  source: "WGS84 (EPSG:4326)",
  cible: "EPSG:4326",
  methode: "aucune transformation",
  justification: "La norme KML 2.2 (OGC 07-147r2) impose WGS 84 en longitude, latitude : les coordonnees sont lues telles quelles, sans reprojection.",
};
const CRS_GEOJSON: InfoCrs = {
  source: "WGS84 (EPSG:4326)",
  cible: "EPSG:4326",
  methode: "aucune transformation",
  justification: "La RFC 7946 impose WGS 84 en longitude, latitude : les coordonnees sont lues telles quelles, sans reprojection. Un membre « crs » autre que WGS 84 est refuse.",
};

const REGEX_HTML = /^(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<script[\s>]|<iframe[\s>]|<svg[\s>]|<\?php)/i;

export function lireFichier(contenu: Buffer, nomFichier: string): ResultatLecture {
  if (contenu.length === 0) throw new ErreurLecture("FICHIER_VIDE", "le fichier est vide");
  if (contenu.length > TAILLE_MAX_OCTETS) {
    throw new ErreurLecture("FICHIER_TROP_GROS", `fichier de plus de ${TAILLE_MAX_OCTETS} octets`);
  }
  const refus = contenuRefuse(contenu, extensionDe(nomFichier));
  if (refus) throw refus;

  const texte = decoderTexte(contenu).replace(/^﻿/, "");
  const nettoye = texte.trimStart();
  if (nettoye === "") throw new ErreurLecture("FICHIER_VIDE", "le fichier ne contient que des blancs");
  if (REGEX_HTML.test(nettoye)) throw new ErreurLecture("CONTENU_NON_RECONNU", "contenu non reconnu (page HTML ou script) : deposez un fichier KML ou GeoJSON");
  if (nettoye[0] === "<") return { format: "KML", crs: CRS_KML, ...lireKml(texte) };
  if (nettoye[0] === "{") {
    if (profondeurJson(texte) > PROFONDEUR_JSON_MAX) {
      throw new ErreurLecture("JSON_TROP_PROFOND", `imbrication JSON de plus de ${PROFONDEUR_JSON_MAX} niveaux`);
    }
    return { format: "GEOJSON", crs: CRS_GEOJSON, ...lireGeoJson(texte) };
  }
  const ext = extensionDe(nomFichier);
  throw new ErreurLecture("FORMAT_NON_SUPPORTE", `contenu non reconnu${ext ? ` (extension .${ext})` : ""} : seuls les formats KML et GeoJSON sont pris en charge dans ce lot`);
}
