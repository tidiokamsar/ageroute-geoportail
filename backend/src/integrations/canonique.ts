/**
 * JSON CANONIQUE, EMPREINTE ET CLE D'IDEMPOTENCE. AUCUN ACCES BASE, AUCUN RESEAU.
 *
 * POURQUOI UN JSON CANONIQUE
 *
 * L'empreinte d'une charge doit etre la meme quel que soit l'ordre dans lequel les champs ont ete
 * poses, sinon deux evenements identiques auraient deux cles et l'idempotence ne tiendrait pas.
 * Les cles sont donc triees (ordre des unites de code, comme `Array.prototype.sort`), les espaces
 * absents, et tout ce qui n'a pas de forme JSON exacte est REFUSE plutot que converti en silence :
 * un BigInt devient une chaine AVANT d'arriver ici (les montants en GNF depassent 2^53), un NaN
 * n'existe pas en JSON, une Date doit avoir ete formatee par l'appelant.
 *
 * LA CLE EST CALCULEE DE LA MEME MANIERE QUE LA BASE LA VERIFIE : SHA-256 de
 * `destination|type|sourceType|sourceId|empreinteCharge`. La contrainte `outbox_cle_deterministe`
 * refuse toute autre valeur ; ce fichier et cette contrainte doivent rester identiques.
 */
import { createHash } from "node:crypto";

export class ChargeNonCanonique extends Error {
  constructor(message: string) { super(message); this.name = "ChargeNonCanonique"; }
}

function canoniser(v: unknown, chemin: string): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string": return JSON.stringify(v);
    case "boolean": return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new ChargeNonCanonique(`${chemin} : nombre non fini`);
      return JSON.stringify(v);
    case "bigint": throw new ChargeNonCanonique(`${chemin} : BigInt interdit, convertir en chaine avant`);
    case "undefined": throw new ChargeNonCanonique(`${chemin} : undefined interdit`);
    case "object": break;
    default: throw new ChargeNonCanonique(`${chemin} : type ${typeof v} interdit`);
  }
  if (Array.isArray(v)) return `[${v.map((x, i) => canoniser(x, `${chemin}[${i}]`)).join(",")}]`;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) {
    throw new ChargeNonCanonique(`${chemin} : objet non litteral (${(v as object).constructor?.name ?? "?"}) interdit`);
  }
  const o = v as Record<string, unknown>;
  const cles = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${cles.map((k) => `${JSON.stringify(k)}:${canoniser(o[k], `${chemin}.${k}`)}`).join(",")}}`;
}

/** JSON canonique : cles triees, sans espace. Leve `ChargeNonCanonique` si la valeur n'a pas de forme exacte. */
export function canonique(valeur: unknown): string {
  return canoniser(valeur, "$");
}

export function sha256Hex(texte: string): string {
  return createHash("sha256").update(texte, "utf8").digest("hex");
}

/** Empreinte d'une charge : SHA-256 de son JSON canonique. */
export function empreinteDeCharge(chargeCanonique: string): string {
  return sha256Hex(chargeCanonique);
}

/** Cle d'idempotence deterministe : ce que `outbox_cle_deterministe` impose en base. */
export function cleIdempotence(p: {
  destination: string; typeEvenement: string; sourceType: string; sourceId: string; empreinteCharge: string;
}): string {
  return sha256Hex(`${p.destination}|${p.typeEvenement}|${p.sourceType}|${p.sourceId}|${p.empreinteCharge}`);
}
