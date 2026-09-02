/**
 * Dedoublonnage de noms insensible aux accents, a la casse et aux espaces.
 *
 * POURQUOI CE MODULE EXISTE
 *
 * Dix postes de peage et de pesage ont ete supprimes le 01/07/2026. Ils ne
 * correspondaient qu'a six sites : « Peage de Kilissi » et « Péage de Kilissi »
 * cohabitaient, de meme que « Poste de pesage de Linsan » en double.
 *
 * La suppression retirait donc de vrais doublons. Mais rien n'empechait qu'ils
 * reviennent au prochain import, et le module est reste vide depuis.
 */

/** Forme comparable d'un nom : minuscules, sans accents, espaces normalises. */
export function normaliserNom(nom: string): string {
  return nom
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Vrai si deux noms designent le meme objet a l'accentuation et a la casse pres. */
export function memeNom(a: string, b: string): boolean {
  return normaliserNom(a) === normaliserNom(b);
}

/**
 * Regroupe des elements par nom normalise et retient un representant par groupe.
 *
 * `prefere` departage : a defaut, le premier rencontre l'emporte. Pour les postes, on
 * prefere l'orthographe accentuee, plus proche de la forme correcte.
 */
export function dedoublonnerParNom<T>(
  elements: T[],
  nomDe: (e: T) => string,
  prefere?: (candidat: T, retenu: T) => boolean
): T[] {
  const parCle = new Map<string, T>();
  for (const e of elements) {
    const cle = normaliserNom(nomDe(e));
    const retenu = parCle.get(cle);
    if (!retenu || (prefere && prefere(e, retenu))) parCle.set(cle, e);
  }
  return [...parCle.values()];
}

/** Vrai si le nom porte au moins un caractere accentue. */
export function porteDesAccents(nom: string): boolean {
  return nom !== nom.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}
