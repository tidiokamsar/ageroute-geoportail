/**
 * Fabrique d'archives ZIP SYNTHETIQUES pour les tests (jamais importee par le code de production). Permet de fabriquer des archives
 * normales et des archives hostiles (zip-slip, bombe, lien symbolique, chiffree, recouvrement...) sans fichier d'un tiers.
 */
import { deflateRawSync } from "node:zlib";
import { crc32 } from "./zip.noyau";

export interface SpecEntree {
  nom: string;
  contenu?: Buffer | string;
  /** 0 = stocke, 8 = deflate (defaut 8 pour un contenu non vide). */
  methode?: 0 | 8;
  flags?: number;
  /** Octet haut = systeme hote (3 = Unix), octet bas = version. */
  faitPar?: number;
  attrExterne?: number;
  /** Donnees compressees brutes (remplacent `contenu`), avec la taille decompressee et le CRC annonces. */
  brut?: { compresse: Buffer; tailleDecompressee: number; crc?: number };
  /** Nom ecrit dans l'entete local si different du nom central. */
  nomLocal?: string;
  /** Corrompt le CRC annonce. */
  crcFaux?: boolean;
  /** Taille decompressee annoncee differente de la taille reelle. */
  tailleAnnoncee?: number;
}

export interface Fabrique {
  buffer: Buffer;
  /** Position de l'entete local de chaque entree, dans l'ordre. */
  debutsLocaux: number[];
  debutRepertoire: number;
  /** Position de l'enregistrement de fin. */
  debutFin: number;
}

export function construireZip(specs: SpecEntree[], options: { commentaire?: string } = {}): Fabrique {
  const parties: Buffer[] = [];
  const centraux: Buffer[] = [];
  const debutsLocaux: number[] = [];
  let pos = 0;
  for (const s of specs) {
    const nom = Buffer.from(s.nom, "utf8");
    const nomLocal = Buffer.from(s.nomLocal ?? s.nom, "utf8");
    const contenu = typeof s.contenu === "string" ? Buffer.from(s.contenu, "utf8") : s.contenu ?? Buffer.alloc(0);
    let donnees: Buffer, tailleDecomp: number, crc: number;
    let methode = s.methode ?? (contenu.length > 0 ? 8 : 0);
    if (s.brut) {
      donnees = s.brut.compresse; tailleDecomp = s.brut.tailleDecompressee; crc = s.brut.crc ?? 0; methode = 8;
    } else {
      donnees = methode === 8 ? deflateRawSync(contenu) : contenu;
      tailleDecomp = contenu.length;
      crc = crc32(contenu);
    }
    if (s.crcFaux) crc = (crc ^ 0xdeadbeef) >>> 0;
    const annoncee = s.tailleAnnoncee ?? tailleDecomp;
    const flags = s.flags ?? 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(methode, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(donnees.length, 18); local.writeUInt32LE(annoncee, 22);
    local.writeUInt16LE(nomLocal.length, 26); local.writeUInt16LE(0, 28);
    debutsLocaux.push(pos);
    parties.push(local, nomLocal, donnees);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(s.faitPar ?? 20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(methode, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(donnees.length, 20); central.writeUInt32LE(annoncee, 24);
    central.writeUInt16LE(nom.length, 28); central.writeUInt32LE(s.attrExterne ?? 0, 38); central.writeUInt32LE(pos, 42);
    centraux.push(central, nom);
    pos += 30 + nomLocal.length + donnees.length;
  }
  const debutRepertoire = pos;
  const repertoire = Buffer.concat(centraux);
  const commentaire = Buffer.from(options.commentaire ?? "", "utf8");
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(specs.length, 8); fin.writeUInt16LE(specs.length, 10);
  fin.writeUInt32LE(repertoire.length, 12); fin.writeUInt32LE(debutRepertoire, 16); fin.writeUInt16LE(commentaire.length, 20);
  const buffer = Buffer.concat([...parties, repertoire, fin, commentaire]);
  return { buffer, debutsLocaux, debutRepertoire, debutFin: debutRepertoire + repertoire.length };
}

/** Raccourci : KMZ normal avec un `doc.kml`. */
export const kmzSimple = (kml: string, extras: SpecEntree[] = []): Buffer =>
  construireZip([{ nom: "doc.kml", contenu: kml }, ...extras]).buffer;
