/**
 * PRODUCTEUR D'ARCHIVE ZIP MINIMAL ET DETERMINISTE (lot X1, export du dossier technique ; contrat CONTRAT-EXPORTS.md, section 4.2). Sans E/S, sans
 * dependance : node:zlib seulement (aucune bibliotheque ZIP n'est dans backend/package.json, et aucune n'est ajoutee).
 *
 * FORMAT (APPNOTE de PKWARE, sous-ensemble) : pour chaque entree un entete local (signature 0x04034b50) suivi des donnees, puis le repertoire central
 * (0x02014b50) et l'enregistrement de fin (0x06054b50). Choix volontaires, pour qu'un lecteur strict (celui du module, `formats/zip.noyau.ts`) l'accepte :
 *   - jamais de ZIP64 : une archive qui depasserait 65 535 entrees ou 4 Gio est refusee AVANT d'etre produite (le plafond de l'export est bien plus bas) ;
 *   - methode 8 (deflate brut) si elle reduit la taille, sinon 0 (stocke) ; aucune autre methode, aucun chiffrement, aucun descripteur de donnees ;
 *   - noms ASCII sans `..`, sans antislash, sans chemin absolu, sans segment vide, sans doublon (casse ignoree) ; drapeau UTF-8 (bit 11) pose ;
 *   - systeme hote MS-DOS (0) et attributs externes nuls : aucun mode Unix, donc ni lien symbolique ni fichier special possible ;
 *   - date et heure DOS de l'export (UTC), identiques pour toutes les entrees.
 * DETERMINISME : memes entrees (noms, contenus, date) => memes octets (ordre des entrees conserve, niveau de compression fixe).
 */

import { deflateRawSync } from "node:zlib";
import { crc32 } from "../formats/zip.noyau";

export interface FichierZip { nom: string; contenu: Buffer }

export class ErreurZip extends Error {
  constructor(public readonly code: "ZIP_NOM_INVALIDE" | "ZIP_DOUBLON" | "ZIP_TROP_GRAND" | "ZIP_VIDE", message: string) {
    super(message);
    this.name = "ErreurZip";
  }
}

const ENTREES_MAX = 0xffff - 1;
const OCTETS_MAX = 0xffffffff - 1;
const NIVEAU = 6;

/** Verifie qu'un nom d'entree est sur et portable (le producteur refuse ce qu'un lecteur strict refuserait). */
export function verifierNomEntree(nom: string): void {
  if (nom.length === 0 || nom.length > 255) throw new ErreurZip("ZIP_NOM_INVALIDE", "nom d'entree vide ou de plus de 255 caracteres");
  if (!/^[A-Za-z0-9._\-/]+$/.test(nom)) throw new ErreurZip("ZIP_NOM_INVALIDE", `nom d'entree hors de l'alphabet sur (lettres, chiffres, point, tiret, souligne, barre) : ${nom}`);
  if (nom.startsWith("/") || nom.endsWith("/")) throw new ErreurZip("ZIP_NOM_INVALIDE", "chemin absolu ou dossier : seuls des fichiers sont produits");
  const segments = nom.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) throw new ErreurZip("ZIP_NOM_INVALIDE", "segment vide, « . » ou « .. » dans un nom d'entree");
}

/** Date et heure au format DOS (secondes paires), en UTC ; bornee a 1980..2107. */
export function dateDos(d: Date): { date: number; heure: number } {
  const annee = Math.min(2107, Math.max(1980, d.getUTCFullYear()));
  const date = ((annee - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const heure = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  return { date, heure };
}

/** Produit l'archive. `fichiers` dans l'ordre voulu (l'ordre est conserve). */
export function produireZip(fichiers: readonly FichierZip[], horodatage: Date): Buffer {
  if (fichiers.length === 0) throw new ErreurZip("ZIP_VIDE", "une archive vide n'est pas produite");
  if (fichiers.length > ENTREES_MAX) throw new ErreurZip("ZIP_TROP_GRAND", `plus de ${ENTREES_MAX} entrees (ZIP64 non produit)`);
  const vus = new Set<string>();
  for (const f of fichiers) {
    verifierNomEntree(f.nom);
    const cle = f.nom.toLowerCase();
    if (vus.has(cle)) throw new ErreurZip("ZIP_DOUBLON", `deux entrees portent le meme nom (casse ignoree) : ${f.nom}`);
    vus.add(cle);
  }
  const { date, heure } = dateDos(horodatage);
  const locaux: Buffer[] = [];
  const centraux: Buffer[] = [];
  let decalage = 0;
  for (const f of fichiers) {
    const nom = Buffer.from(f.nom, "utf8");
    const crc = crc32(f.contenu);
    const deflate = f.contenu.length > 0 ? deflateRawSync(f.contenu, { level: NIVEAU }) : Buffer.alloc(0);
    const methode = f.contenu.length > 0 && deflate.length < f.contenu.length ? 8 : 0;
    const donnees = methode === 8 ? deflate : f.contenu;
    if (f.contenu.length > OCTETS_MAX || decalage + 30 + nom.length + donnees.length > OCTETS_MAX) throw new ErreurZip("ZIP_TROP_GRAND", "archive de plus de 4 Gio (ZIP64 non produit)");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version necessaire : 2.0
    local.writeUInt16LE(0x0800, 6); // noms en UTF-8
    local.writeUInt16LE(methode, 8);
    local.writeUInt16LE(heure, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(donnees.length, 18);
    local.writeUInt32LE(f.contenu.length, 22);
    local.writeUInt16LE(nom.length, 26);
    local.writeUInt16LE(0, 28);
    locaux.push(local, nom, donnees);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // fait par : MS-DOS (0), version 2.0 : aucun mode Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(methode, 10);
    central.writeUInt16LE(heure, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(donnees.length, 20);
    central.writeUInt32LE(f.contenu.length, 24);
    central.writeUInt16LE(nom.length, 28);
    // extra, commentaire, disque, attributs internes et externes : nuls
    central.writeUInt32LE(decalage, 42);
    centraux.push(central, nom);
    decalage += 30 + nom.length + donnees.length;
  }
  const repertoire = Buffer.concat(centraux);
  if (decalage + repertoire.length > OCTETS_MAX) throw new ErreurZip("ZIP_TROP_GRAND", "archive de plus de 4 Gio (ZIP64 non produit)");
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(fichiers.length, 8);
  fin.writeUInt16LE(fichiers.length, 10);
  fin.writeUInt32LE(repertoire.length, 12);
  fin.writeUInt32LE(decalage, 16);
  return Buffer.concat([...locaux, repertoire, fin]);
}
