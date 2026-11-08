/**
 * JSON CANONIQUE ET EMPREINTE. Aucun acces a la base de donnees.
 *
 * POURQUOI CE MODULE EXISTE
 *
 * Une fiche d'intervention est figee par une empreinte SHA-256 de son contenu, et un scenario est
 * rejouable « octet pour octet ». Les deux exigent qu'un meme objet donne TOUJOURS la meme suite
 * d'octets, quel que soit l'ordre dans lequel ses cles ont ete construites. `JSON.stringify`
 * ne le garantit pas : il suit l'ordre d'insertion. Ce module impose donc une forme unique :
 *
 *   - cles d'objet triees par unite de code UTF-16 (ordre par defaut de `Array.prototype.sort`,
 *     independant de la locale) ;
 *   - aucun espace ;
 *   - nombres finis seulement, ecrits par l'algorithme de la specification ECMAScript
 *     (stable d'un moteur a l'autre) ; `-0` s'ecrit `0` ;
 *   - AUCUNE conversion silencieuse : un bigint, une date, un `undefined`, un nombre non fini ou
 *     une chaine contenant un substitut isole sont REFUSES, avec le chemin fautif. Convertir un
 *     montant en chaine, ou une date en ISO, est la decision de l'appelant, pas la mienne ;
 *     un `undefined` qui disparaitrait en silence ferait deux objets differents d'un meme texte.
 */

import { createHash } from "node:crypto";

export class ErreurCanonique extends Error {
  constructor(public readonly chemin: string, message: string) { super(`${message} (a ${chemin || "la racine"})`); }
}

const SUBSTITUT_ISOLE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function ecrire(v: unknown, chemin: string): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean": return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new ErreurCanonique(chemin, "nombre non fini");
      return JSON.stringify(v === 0 ? 0 : v);
    case "string":
      if (SUBSTITUT_ISOLE.test(v)) throw new ErreurCanonique(chemin, "chaine avec substitut UTF-16 isole");
      return JSON.stringify(v);
    case "bigint": throw new ErreurCanonique(chemin, "bigint non serialise : le convertir en chaine explicitement");
    case "undefined": throw new ErreurCanonique(chemin, "valeur undefined : utiliser null explicitement");
    case "object": {
      if (v instanceof Date) throw new ErreurCanonique(chemin, "Date non serialisee : la convertir en chaine ISO explicitement");
      if (Array.isArray(v)) return `[${v.map((x, i) => ecrire(x, `${chemin}[${i}]`)).join(",")}]`;
      const o = v as Record<string, unknown>;
      return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${ecrire(o[k], chemin ? `${chemin}.${k}` : k)}`).join(",")}}`;
    }
    default: throw new ErreurCanonique(chemin, `type ${typeof v} non serialisable`);
  }
}

/** Forme canonique d'une valeur JSON. Leve `ErreurCanonique` si la valeur n'en a pas. */
export function canonique(valeur: unknown): string {
  return ecrire(valeur, "");
}

/** Vrai si `texte` est du JSON valide ET deja sous sa forme canonique (octet pour octet). */
export function estCanonique(texte: string): boolean {
  try { return canonique(JSON.parse(texte)) === texte; } catch { return false; }
}

/** SHA-256 en hexadecimal minuscule de la suite d'octets UTF-8 du texte (comme `sha256(convert_to(x,'UTF8'))`). */
export function sha256Hex(texte: string): string {
  return createHash("sha256").update(texte, "utf8").digest("hex");
}
