/**
 * DETECTION DES FORMATS GDAL PAR LE CONTENU (lot B2). Sans E/S, sans base. L'extension ne sert a rien : un fichier nomme `.gpkg` qui est du HTML est refuse
 * par le format detecte, jamais par son nom.
 *
 *   - GeoPackage : base SQLite dont l'identifiant d'application (octets 68 a 71) est `GPKG`, `GP10` ou `GP11` ;
 *   - Shapefile  : archive ZIP dont le repertoire central est controle PAR LE NOYAU ZIP DU MODULE (zip-slip, bombe, lien symbolique, chiffrement,
 *                  recouvrement, imbrication : `inspecterZip`) et qui porte un jeu COMPLET `.shp` + `.shx` + `.dbf` (le `.prj` est lu par le conteneur, il ne
 *                  vaut jamais confirmation de CRS) ;
 *   - DXF        : texte (paires code de groupe / valeur) dont la premiere entite est `SECTION`. Le DXF binaire est reconnu pour etre refuse proprement.
 *
 * `strict` : a la creation d'un job, une archive hostile est refusee avec son code (`ARCHIVE_*`). Sur les routes synchrones (qui ne font que
 * rediriger), une archive illisible retombe dans la voie KMZ habituelle, inchangee.
 */

import { ErreurLecture } from "../lecture.types";
import { estZip, extensionDe, inspecterZip, type LimitesZip } from "../formats/zip.noyau";
import type { FormatGdal } from "./contrat.noyau";

export type DetectionGdal =
  | { format: FormatGdal; shapefiles?: { nom: string; prj: boolean }[] }
  | { format: "DXF_BINAIRE" };

const APP_ID_GPKG = new Set([0x47504b47, 0x47503130, 0x47503131]);
const EN_TETE_SQLITE = Buffer.from("SQLite format 3\u0000", "latin1");
const DXF_BINAIRE = Buffer.from("AutoCAD Binary DXF\r\n\u001a\u0000", "latin1");

function estDxfTexte(b: Buffer): boolean {
  const debut = b.subarray(0, 4096);
  if (debut.includes(0)) return false;
  const lignes = debut.toString("latin1").replace(/^ï»¿/, "").split(/\r?\n/);
  const paires: [string, string][] = [];
  for (let i = 0; i + 1 < lignes.length && paires.length < 12; i += 2) paires.push([lignes[i].trim(), lignes[i + 1].trim()]);
  const utiles = paires.filter((p) => p[0] !== "999");
  return utiles.length >= 2 && utiles[0][0] === "0" && utiles[0][1] === "SECTION" && utiles[1][0] === "2" && /^[A-Z]+$/.test(utiles[1][1]);
}

/** Jeu `.shp` + `.shx` + `.dbf` par nom de base (sans casse), sur toute l'arborescence de l'archive. */
export function jeuxShapefile(noms: readonly string[]): { complets: { nom: string; prj: boolean }[]; incomplets: { nom: string; manque: string[] }[] } {
  const par = new Map<string, Set<string>>();
  for (const n of noms) {
    const ext = extensionDe(n);
    if (!["shp", "shx", "dbf", "prj"].includes(ext)) continue;
    const base = n.slice(0, n.length - ext.length - 1).toLowerCase();
    if (!par.has(base)) par.set(base, new Set());
    par.get(base)!.add(ext);
  }
  const complets: { nom: string; prj: boolean }[] = [];
  const incomplets: { nom: string; manque: string[] }[] = [];
  for (const [base, exts] of par) {
    if (!exts.has("shp")) continue;
    const manque = ["shx", "dbf"].filter((e) => !exts.has(e));
    if (manque.length === 0) complets.push({ nom: base.slice(0, 120), prj: exts.has("prj") });
    else incomplets.push({ nom: base.slice(0, 120), manque });
  }
  return { complets, incomplets };
}

/**
 * Detecte un format de la chaine GDAL, ou `null` si ce n'est aucun d'eux (les voies synchrones traitent alors le fichier comme avant).
 * Leve `ErreurLecture` (archive dangereuse, Shapefile incomplet) seulement en mode `strict`.
 */
export function detecterFormatGdal(b: Buffer, lim: LimitesZip, strict: boolean): DetectionGdal | null {
  if (b.length >= 100 && b.subarray(0, 16).equals(EN_TETE_SQLITE)) {
    return APP_ID_GPKG.has(b.readUInt32BE(68)) ? { format: "GPKG" } : null;
  }
  if (b.subarray(0, DXF_BINAIRE.length).equals(DXF_BINAIRE)) return { format: "DXF_BINAIRE" };
  if (estZip(b)) {
    let noms: string[];
    try {
      noms = inspecterZip(b, lim).entrees.filter((e) => !e.dossier).map((e) => e.nom);
    } catch (e) {
      if (strict) throw e;
      return null;
    }
    if (noms.some((n) => extensionDe(n) === "kml")) return null; // KMZ : voie synchrone existante
    const { complets, incomplets } = jeuxShapefile(noms);
    if (incomplets.length > 0) {
      if (strict) throw new ErreurLecture("SHAPEFILE_INCOMPLET", `Shapefile incomplet : ${incomplets.slice(0, 5).map((i) => `« ${i.nom.slice(0, 60)} » sans .${i.manque.join(" ni .")}`).join(" ; ")} (.shp, .shx et .dbf sont obligatoires)`);
      return { format: "SHAPEFILE", shapefiles: [] };
    }
    if (complets.length > 0) return { format: "SHAPEFILE", shapefiles: complets };
    if (noms.some((n) => ["shp", "shx", "dbf", "prj"].includes(extensionDe(n)))) {
      if (strict) throw new ErreurLecture("SHAPEFILE_INCOMPLET", "Shapefile incomplet : aucun fichier .shp (.shp, .shx et .dbf sont obligatoires)");
      return { format: "SHAPEFILE", shapefiles: [] };
    }
    return null;
  }
  if (estDxfTexte(b)) return { format: "DXF" };
  return null;
}

/** Extension de fichier a donner au depot du spool (le conteneur detecte le format par le contenu, l'extension n'est qu'indicative). */
export const EXTENSION_DE_FORMAT: Readonly<Record<FormatGdal, string>> = { GPKG: "gpkg", SHAPEFILE: "zip", DXF: "dxf" };
