/**
 * Lecteur d'ARCHIVE ZIP BORNE pour les KMZ du module Projets de voirie et reseaux. Sans E/S, sans dependance (node:zlib seulement).
 *
 * PRINCIPE : le repertoire central est lu et controle ENTIEREMENT avant la moindre decompression ; AUCUN fichier n'est jamais ecrit sur
 * le disque (une entree se decompresse en memoire, sous plafond, et seule l'entree KML principale est decompressee). Zip-slip n'a donc
 * pas de cible, mais les noms dangereux sont refuses quand meme : une archive qui en porte un est hostile ou corrompue.
 *
 * REFUS DE L'ARCHIVE ENTIERE (codes ARCHIVE_*, CONTRAT-IMPORT.md section 6) :
 *   - structure : fin de repertoire introuvable ou incoherente, ZIP64, multi-disques, donnees avant l'archive, signature locale absente,
 *     nom local different du nom central, taille ou CRC menteurs ;
 *   - nombre d'entrees (lu dans l'enregistrement de fin AVANT de lire le repertoire) ;
 *   - noms : `..`, chemin absolu, lettre de lecteur, antislash, caractere de controle, profondeur, doublons (casse ignoree) ;
 *   - liens symboliques et entrees speciales (mode Unix de l'attribut externe, attribut de point d'analyse NTFS) ;
 *   - entrees chiffrees, methodes autres que stocke (0) et deflate (8) ;
 *   - archives imbriquees (extension), tailles decompressees declarees (par entree et au total), taux de compression, recouvrement des
 *     donnees de deux entrees (bombe par recouvrement).
 *
 * Decompression : `inflateRawSync` avec `maxOutputLength` = taille declaree + 1 ; toute difference entre la taille reelle et la taille
 * declaree, ou un CRC-32 different, refuse l'archive.
 */

import { inflateRawSync } from "node:zlib";
import { ErreurLecture } from "../lecture.types";

export interface LimitesZip {
  entreesMax: number;
  /** Taille decompressee maximale d'une entree, en octets. */
  tailleEntreeMax: number;
  /** Total des tailles decompressees DECLAREES. */
  tailleTotaleMax: number;
  /** Rapport taille decompressee / taille compressee maximal, pour une entree de plus de 1 Mo. */
  tauxMax: number;
  profondeurMax: number;
}

export interface EntreeZip {
  nom: string;
  /** Taille decompressee declaree. */
  tailleOctets: number;
  tailleCompressee: number;
  methode: number;
  crc32: number;
  dossier: boolean;
  /** Debut des donnees compressees dans l'archive. */
  debutDonnees: number;
}

export interface InventaireZip {
  entrees: EntreeZip[];
  tailleTotaleOctets: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const UN_MO = 1024 * 1024;

const refus = (code: ErreurLecture["code"], message: string) => new ErreurLecture(code, message);

/** Extensions d'archives (et de formats de paquets) qui ne doivent jamais se trouver dans un KMZ. */
const EXTENSIONS_ARCHIVE = new Set(["zip", "kmz", "gz", "tgz", "tar", "bz2", "xz", "7z", "rar", "jar", "war", "apk", "cab", "iso", "z", "lz", "zst"]);

export function extensionDe(nom: string): string {
  const base = nom.slice(nom.lastIndexOf("/") + 1);
  const i = base.lastIndexOf(".");
  return i < 0 ? "" : base.slice(i + 1).toLowerCase();
}

let tableCrc: Uint32Array | null = null;
export function crc32(octets: Uint8Array): number {
  if (!tableCrc) {
    tableCrc = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      tableCrc[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < octets.length; i++) c = tableCrc[(c ^ octets[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Signature d'un ZIP (entete local ou enregistrement de fin d'une archive vide). */
export function estZip(b: Buffer): boolean {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && ((b[2] === 0x03 && b[3] === 0x04) || (b[2] === 0x05 && b[3] === 0x06));
}

function verifierNom(nom: string, profondeurMax: number): void {
  if (nom.length === 0 || nom.length > 255) throw refus("ARCHIVE_CHEMIN_DANGEREUX", "nom d'entree vide ou de plus de 255 caracteres");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(nom)) throw refus("ARCHIVE_CHEMIN_DANGEREUX", "nom d'entree avec un caractere de controle");
  if (nom.includes("\\")) throw refus("ARCHIVE_CHEMIN_DANGEREUX", "nom d'entree avec un antislash");
  if (nom.startsWith("/") || /^[A-Za-z]:/.test(nom)) throw refus("ARCHIVE_CHEMIN_DANGEREUX", "chemin absolu dans l'archive");
  const segments = (nom.endsWith("/") ? nom.slice(0, -1) : nom).split("/");
  if (segments.some((s) => s === ".." )) throw refus("ARCHIVE_CHEMIN_DANGEREUX", "chemin avec « .. » dans l'archive (zip-slip)");
  if (segments.some((s) => s === "")) throw refus("ARCHIVE_CHEMIN_DANGEREUX", "chemin avec un segment vide dans l'archive");
  if (segments.length > profondeurMax) throw refus("ARCHIVE_TROP_PROFONDE", `plus de ${profondeurMax} niveaux de dossiers dans l'archive`);
}

function decoderNom(octets: Buffer, flags: number): string {
  if (flags & 0x800) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(octets); } catch { throw refus("ARCHIVE_INVALIDE", "nom d'entree qui n'est pas de l'UTF-8 valide"); }
  }
  // Sans l'indicateur UTF-8, l'encodage historique est le CP437 : on ne s'en sert que pour valider et afficher.
  return octets.toString("latin1");
}

/** Lit et controle l'archive SANS rien decompresser. */
export function inspecterZip(b: Buffer, lim: LimitesZip): InventaireZip {
  if (b.length < 22) throw refus("ARCHIVE_INVALIDE", "archive trop courte");
  // Enregistrement de fin : cherche en arriere la signature dont le commentaire va exactement jusqu'a la fin du fichier.
  let eocd = -1;
  const plancher = Math.max(0, b.length - 22 - 0xffff);
  for (let i = b.length - 22; i >= plancher; i--) {
    if (b.readUInt32LE(i) === SIG_EOCD && i + 22 + b.readUInt16LE(i + 20) === b.length) { eocd = i; break; }
  }
  if (eocd < 0) throw refus("ARCHIVE_INVALIDE", "fin d'archive introuvable ou incoherente (archive corrompue ou tronquee)");
  const disque = b.readUInt16LE(eocd + 4), disqueRep = b.readUInt16LE(eocd + 6), nbDisque = b.readUInt16LE(eocd + 8), nb = b.readUInt16LE(eocd + 10);
  const tailleRep = b.readUInt32LE(eocd + 12), debutRep = b.readUInt32LE(eocd + 16);
  if (nb === 0xffff || tailleRep === 0xffffffff || debutRep === 0xffffffff) throw refus("ARCHIVE_INVALIDE", "archive ZIP64 non prise en charge");
  if (disque !== 0 || disqueRep !== 0 || nbDisque !== nb) throw refus("ARCHIVE_INVALIDE", "archive sur plusieurs disques non prise en charge");
  // Le nombre d'entrees est borne AVANT de lire le repertoire central.
  if (nb > lim.entreesMax) throw refus("ARCHIVE_TROP_D_ENTREES", `plus de ${lim.entreesMax} entrees dans l'archive (${nb} annoncees)`);
  if (debutRep + tailleRep !== eocd) throw refus("ARCHIVE_INVALIDE", "repertoire central incoherent (donnees avant, apres ou dans l'archive)");
  if (nb === 0) return { entrees: [], tailleTotaleOctets: 0 };

  const entrees: EntreeZip[] = [];
  const vus = new Set<string>();
  const gabarits: { debutLocal: number; finDonnees: number }[] = [];
  let pos = debutRep;
  let total = 0;
  for (let i = 0; i < nb; i++) {
    if (pos + 46 > eocd || b.readUInt32LE(pos) !== SIG_CENTRAL) throw refus("ARCHIVE_INVALIDE", "entree du repertoire central illisible");
    const faitPar = b.readUInt16LE(pos + 4), flags = b.readUInt16LE(pos + 8), methode = b.readUInt16LE(pos + 10);
    const crc = b.readUInt32LE(pos + 16), comp = b.readUInt32LE(pos + 20), decomp = b.readUInt32LE(pos + 24);
    const lNom = b.readUInt16LE(pos + 28), lExtra = b.readUInt16LE(pos + 30), lCommentaire = b.readUInt16LE(pos + 32);
    const disqueEntree = b.readUInt16LE(pos + 34), attrExterne = b.readUInt32LE(pos + 38), debutLocal = b.readUInt32LE(pos + 42);
    const suivant = pos + 46 + lNom + lExtra + lCommentaire;
    if (suivant > eocd) throw refus("ARCHIVE_INVALIDE", "entree du repertoire central qui deborde");
    const nomOctets = b.subarray(pos + 46, pos + 46 + lNom);
    pos = suivant;

    if (comp === 0xffffffff || decomp === 0xffffffff || debutLocal === 0xffffffff) throw refus("ARCHIVE_INVALIDE", "archive ZIP64 non prise en charge");
    if (disqueEntree !== 0) throw refus("ARCHIVE_INVALIDE", "entree sur un autre disque");
    const nom = decoderNom(nomOctets, flags);
    verifierNom(nom, lim.profondeurMax);
    if (flags & 0x1 || flags & 0x40) throw refus("ARCHIVE_CHIFFREE", "entree chiffree dans l'archive");

    // Liens symboliques et entrees speciales : mode Unix de l'attribut externe (systeme hote 3), point d'analyse NTFS (systeme hote 10).
    const hote = faitPar >> 8;
    if (hote === 3) {
      const type = (attrExterne >>> 16) & 0xf000;
      if (type === 0xa000) throw refus("ARCHIVE_LIEN_SYMBOLIQUE", "lien symbolique dans l'archive");
      if (type === 0x2000 || type === 0x6000 || type === 0x1000 || type === 0xc000) throw refus("ARCHIVE_ENTREE_SPECIALE", "peripherique, tube ou socket dans l'archive");
    }
    if (hote === 10 && (attrExterne & 0x400)) throw refus("ARCHIVE_LIEN_SYMBOLIQUE", "point d'analyse NTFS (lien) dans l'archive");

    const dossier = nom.endsWith("/");
    const cle = (dossier ? nom.slice(0, -1) : nom).toLowerCase();
    if (vus.has(cle)) throw refus("ARCHIVE_NOMS_AMBIGUS", "deux entrees portent le meme nom (casse ignoree)");
    vus.add(cle);

    if (methode !== 0 && methode !== 8) throw refus("ARCHIVE_METHODE_NON_SUPPORTEE", `methode de compression ${methode} non prise en charge (stocke et deflate seulement)`);
    if (!dossier && EXTENSIONS_ARCHIVE.has(extensionDe(nom))) throw refus("ARCHIVE_IMBRIQUEE", "archive imbriquee dans l'archive");
    if (dossier && (decomp !== 0 || comp > 2)) throw refus("ARCHIVE_INVALIDE", "dossier qui porte des donnees");
    if (methode === 0 && comp !== decomp) throw refus("ARCHIVE_INVALIDE", "entree stockee dont les tailles different");
    if (!dossier) {
      if (decomp > lim.tailleEntreeMax) throw refus("ARCHIVE_TROP_GROSSE", `une entree depasse ${lim.tailleEntreeMax} octets decompresses`);
      total += decomp;
      if (total > lim.tailleTotaleMax) throw refus("ARCHIVE_TROP_GROSSE", `l'archive depasse ${lim.tailleTotaleMax} octets decompresses au total`);
      if (decomp > 0 && comp === 0) throw refus("ARCHIVE_INVALIDE", "entree non vide dont la taille compressee est nulle");
      if (decomp > UN_MO && comp > 0 && decomp / comp > lim.tauxMax) throw refus("ARCHIVE_TAUX_COMPRESSION", `taux de compression superieur a ${lim.tauxMax} (bombe de decompression)`);
    }

    // Entete local : meme nom que le repertoire central, donnees au bon endroit, avant le repertoire central.
    if (debutLocal + 30 > debutRep || b.readUInt32LE(debutLocal) !== SIG_LOCAL) throw refus("ARCHIVE_INVALIDE", "entete local introuvable a la position annoncee");
    const lNomLocal = b.readUInt16LE(debutLocal + 26), lExtraLocal = b.readUInt16LE(debutLocal + 28);
    const debutDonnees = debutLocal + 30 + lNomLocal + lExtraLocal;
    if (lNomLocal !== lNom || debutDonnees > debutRep || !b.subarray(debutLocal + 30, debutLocal + 30 + lNomLocal).equals(nomOctets)) {
      throw refus("ARCHIVE_INVALIDE", "nom local different du nom du repertoire central");
    }
    const finDonnees = debutDonnees + comp;
    if (finDonnees > debutRep) throw refus("ARCHIVE_INVALIDE", "donnees d'entree qui debordent sur le repertoire central");
    gabarits.push({ debutLocal, finDonnees });
    entrees.push({ nom, tailleOctets: decomp, tailleCompressee: comp, methode, crc32: crc, dossier, debutDonnees });
  }
  if (pos !== eocd) throw refus("ARCHIVE_INVALIDE", "octets inattendus dans le repertoire central");

  // Recouvrement : les donnees d'une entree ne doivent pas empieter sur l'entete ou les donnees de la suivante.
  gabarits.sort((x, y) => x.debutLocal - y.debutLocal);
  for (let i = 1; i < gabarits.length; i++) {
    if (gabarits[i - 1].finDonnees > gabarits[i].debutLocal) throw refus("ARCHIVE_CHEVAUCHEMENT", "donnees de deux entrees qui se chevauchent (bombe par recouvrement)");
  }
  return { entrees, tailleTotaleOctets: total };
}

/** Decompresse UNE entree en memoire, sous plafond, en verifiant taille et CRC-32. */
export function extraireEntree(b: Buffer, e: EntreeZip): Buffer {
  if (e.dossier) throw refus("ARCHIVE_INVALIDE", "une entree de type dossier n'a pas de contenu");
  if (e.tailleOctets === 0) return Buffer.alloc(0);
  const donnees = b.subarray(e.debutDonnees, e.debutDonnees + e.tailleCompressee);
  let sortie: Buffer;
  if (e.methode === 0) sortie = Buffer.from(donnees);
  else {
    try {
      sortie = inflateRawSync(donnees, { maxOutputLength: e.tailleOctets + 1 });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ERR_BUFFER_TOO_LARGE") throw refus("ARCHIVE_TROP_GROSSE", "une entree se decompresse en plus d'octets que declare l'archive (bombe de decompression)");
      throw refus("ARCHIVE_INVALIDE", "donnees compressees corrompues");
    }
  }
  if (sortie.length !== e.tailleOctets) throw refus("ARCHIVE_INVALIDE", "taille decompressee differente de celle annoncee par l'archive");
  if (crc32(sortie) !== e.crc32) throw refus("ARCHIVE_INVALIDE", "somme de controle (CRC-32) incorrecte : archive corrompue");
  return sortie;
}

const EXTENSIONS_IMAGE = new Set(["png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp", "ico"]);
const EXTENSIONS_GDAL = new Set(["shp", "shx", "dbf", "gpkg", "dxf", "dwg"]);

export type TypeEntree = "kml" | "image" | "autre" | "dossier";
export function typeEntree(e: Pick<EntreeZip, "nom" | "dossier">): TypeEntree {
  if (e.dossier) return "dossier";
  const x = extensionDe(e.nom);
  if (x === "kml") return "kml";
  return EXTENSIONS_IMAGE.has(x) ? "image" : "autre";
}

export interface ChoixKml {
  principal: EntreeZip;
  /** Toutes les entrees `.kml` de l'archive (inventaire). */
  kml: EntreeZip[];
}

/**
 * Choisit l'entree KML principale. `demande` : nom exact choisi par l'utilisateur. Sinon `doc.kml` a la racine (convention Google Earth),
 * sinon l'unique `.kml`. Plusieurs `.kml` sans `doc.kml` : refus (c'est a l'utilisateur de choisir, rien n'est devine).
 */
export function choisirEntreeKml(entrees: readonly EntreeZip[], demande?: string): ChoixKml {
  const kml = entrees.filter((e) => !e.dossier && extensionDe(e.nom) === "kml");
  if (demande !== undefined) {
    const e = kml.find((x) => x.nom === demande);
    if (!e) throw refus("ENTREE_KML_INTROUVABLE", "l'entree demandee n'est pas un fichier .kml de l'archive");
    return { principal: e, kml };
  }
  if (kml.length === 0) {
    if (entrees.some((e) => !e.dossier && EXTENSIONS_GDAL.has(extensionDe(e.nom)))) {
      throw refus("FORMAT_NON_SUPPORTE", "archive de Shapefile, GeoPackage ou DXF : prevue au lot de la chaine GDAL ; ce lot ne lit que les KMZ");
    }
    throw refus("KMZ_SANS_KML", "l'archive ne contient aucun fichier .kml");
  }
  const doc = kml.find((x) => x.nom.toLowerCase() === "doc.kml");
  if (doc) return { principal: doc, kml };
  if (kml.length === 1) return { principal: kml[0], kml };
  throw refus("KMZ_PLUSIEURS_KML", `l'archive contient ${kml.length} fichiers .kml sans doc.kml a la racine : choisissez l'entree a importer (entreeKml)`);
}
