import { createHash, randomBytes } from "node:crypto";
import zlib from "node:zlib";

/**
 * PNG valide et UNIQUE a chaque appel (pixels aleatoires).
 *
 * L'unicite est necessaire : le serveur refuse qu'une meme empreinte SHA-256 soit rattachee a deux
 * observations (`MediaObservation.sha256` est unique), donc deux tests qui enverraient le meme fichier
 * se heurteraient au lieu de se prouver chacun.
 */
export interface FichierImage { name: string; mimeType: string; buffer: Buffer; sha256: string }

function chunk(type: string, data: Buffer): Buffer {
  const longueur = Buffer.alloc(4);
  longueur.writeUInt32BE(data.length);
  const corps = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(corps) >>> 0);
  return Buffer.concat([longueur, corps, crc]);
}

export function pngUnique(nom = "photo-e2e.png", cote = 16): FichierImage {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cote, 0);
  ihdr.writeUInt32BE(cote, 4);
  ihdr[8] = 8; // profondeur 8 bits
  ihdr[9] = 2; // RGB
  const lignes: Buffer[] = [];
  for (let y = 0; y < cote; y++) lignes.push(Buffer.concat([Buffer.from([0]), randomBytes(cote * 3)]));
  const buffer = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(lignes))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return { name: nom, mimeType: "image/png", buffer, sha256: createHash("sha256").update(buffer).digest("hex") };
}
