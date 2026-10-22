import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ErreurCanonique, canonique, estCanonique, sha256Hex } from "./canonique";

/**
 * Ce que ces tests defendent : une meme valeur donne toujours les memes octets, et rien n'est
 * converti ou perdu en silence (un undefined qui disparait ferait d'objets differents un meme texte).
 */
describe("canonique", () => {
  it("n'importe que node:crypto (aucun acces base)", () => {
    const src = readFileSync(join(__dirname, "canonique.ts"), "utf8");
    const imports = [...src.matchAll(/^import .*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports).toEqual(["node:crypto"]);
  });

  it("trie les cles, quel que soit l'ordre de construction, et n'ecrit aucun espace", () => {
    const a = { b: 1, a: { d: [1, 2], c: "x" } };
    const b = { a: { c: "x", d: [1, 2] }, b: 1 };
    expect(canonique(a)).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');
    expect(canonique(a)).toBe(canonique(b));
  });

  it("trie par unite de code, pas par locale : majuscules avant minuscules, e accent apres z", () => {
    expect(canonique({ z: 1, "é": 2, A: 3, a: 4 })).toBe('{"A":3,"a":4,"z":1,"é":2}');
  });

  it("garde l'ordre des tableaux (un tableau est une suite, pas un ensemble)", () => {
    expect(canonique([3, 1, 2])).toBe("[3,1,2]");
  });

  it("ecrit -0 comme 0 et refuse NaN et l'infini", () => {
    expect(canonique(-0)).toBe("0");
    expect(() => canonique(NaN)).toThrow(ErreurCanonique);
    expect(() => canonique({ x: Infinity })).toThrow(/x/);
  });

  it("refuse bigint, undefined et Date au lieu de les convertir, en citant le chemin", () => {
    expect(() => canonique({ a: [1, { m: 10n }] })).toThrow(/a\[1\]\.m/);
    expect(() => canonique({ a: undefined })).toThrow(/undefined/);
    expect(() => canonique([undefined])).toThrow(ErreurCanonique);
    expect(() => canonique({ d: new Date() })).toThrow(/Date/);
  });

  it("refuse une chaine contenant un substitut UTF-16 isole (octets UTF-8 non definis)", () => {
    expect(() => canonique("\uD800")).toThrow(/substitut/);
    expect(canonique("😀")).toBe('"😀"');
  });

  it("estCanonique reconnait sa propre sortie et rejette tout le reste", () => {
    expect(estCanonique(canonique({ b: 1, a: 2 }))).toBe(true);
    expect(estCanonique('{"b":1,"a":2}')).toBe(false);
    expect(estCanonique('{"a": 2}')).toBe(false);
    expect(estCanonique("pas du json")).toBe(false);
  });

  it("sha256Hex : vecteur connu, et octets UTF-8 (comme convert_to(x,'UTF8') en base)", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("é")).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("é")).not.toBe(sha256Hex("e"));
  });
});
