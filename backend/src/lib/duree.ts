/**
 * Duree d'une variable d'environnement de type « 15m », « 7d » (la forme de `JWT_ACCESS_EXPIRES_IN`), en
 * millisecondes. Noyau pur, sans horloge ni environnement.
 *
 * Seules les formes que le depot emet sont lues : un entier suivi de `s`, `m`, `h` ou `d`. Toute autre forme
 * (vide, decimal, unite inconnue) rend `repli`, jamais zero : une fenetre de refus calculee a partir d'une
 * valeur illisible garde la duree du repli au lieu de tomber a zero en silence.
 */
export function dureeEnMs(texte: string | undefined, repli: number): number {
  const m = /^\s*(\d+)\s*([smhd])\s*$/.exec(texte ?? "");
  if (!m) return repli;
  const facteur = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  const valeur = Number(m[1]) * facteur;
  return valeur > 0 ? valeur : repli;
}

/** Duree de vie par defaut d'un jeton d'acces (la valeur par defaut de `JWT_ACCESS_EXPIRES_IN`). */
export const JETON_ACCES_REPLI_MS = 15 * 60_000;
