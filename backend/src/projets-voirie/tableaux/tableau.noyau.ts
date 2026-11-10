/**
 * TABLEAUX DE BORD : ASSEMBLAGE DES AGREGATS (noyau pur, lot X1 ; contrat CONTRAT-EXPORTS.md, section 6). Sans base : le service rend les lignes de
 * requetes `GROUP BY GROUPING SETS` (une ligne par cle de regroupement, et une ligne de total, `g = 1`) ; ce noyau les range, met les zeros et applique
 * la lisibilite : pour un compte qui ne decide pas, `piecesEnAttente` et `referentsActifs` valent `null` (le service ne les calcule meme pas).
 *
 * AUCUN nom d'objet, de fichier, de concessionnaire ni de document : seulement des nombres, par statut.
 */

export interface Agregat {
  projets: number;
  jeux: Record<string, number>;
  conflits: Record<string, number>;
  documentsManquants: {
    typesObligatoiresNonFournis: number; projetsIncomplets: number;
    piecesEnAttente: number | null; piecesEnAttenteParStatut: Record<string, number> | null;
  };
  referentsActifs: { comptes: number; rattachements: number } | null;
}

/** Ligne brute : `cle` (texte, nul pour la ligne de total), `g` (1 = ligne de total du GROUPING SETS). */
export interface LigneCle { cle: string | null; g: number }
export interface LignesTableau {
  projets: (LigneCle & { n: number })[];
  jeux: (LigneCle & { s: string; n: number })[];
  conflits: (LigneCle & { s: string; n: number })[];
  types: (LigneCle & { n: number; projets: number })[];
  pieces: (LigneCle & { s: string; n: number })[] | null;
  referents: (LigneCle & { rattachements: number; comptes: number })[] | null;
}

/** Cle de la ligne de total : ne peut pas etre une cle reelle (identifiant de territoire en UUID, identifiant de region entier, vide, `~`). */
export const CLE_TOTAL = "#TOTAL";
/** Cle des projets places sous un enfant que le compte ne voit pas (ou au-dela du plafond des enfants listes). */
export const CLE_NON_VENTILES = "~";

export function agregatVide(decideur: boolean): Agregat {
  return {
    projets: 0, jeux: {}, conflits: {},
    documentsManquants: { typesObligatoiresNonFournis: 0, projetsIncomplets: 0, piecesEnAttente: decideur ? 0 : null, piecesEnAttenteParStatut: decideur ? {} : null },
    referentsActifs: decideur ? { comptes: 0, rattachements: 0 } : null,
  };
}

const cleDe = (l: LigneCle): string => (Number(l.g) === 1 ? CLE_TOTAL : l.cle ?? "");

/** Range les lignes par cle ; la cle `CLE_TOTAL` porte le total (exact : les comptes distincts ne sont pas des sommes). */
export function ranger(l: LignesTableau, decideur: boolean): Map<string, Agregat> {
  const m = new Map<string, Agregat>();
  const de = (cle: string) => { let a = m.get(cle); if (!a) { a = agregatVide(decideur); m.set(cle, a); } return a; };
  de(CLE_TOTAL);
  for (const x of l.projets) de(cleDe(x)).projets = Number(x.n);
  for (const x of l.jeux) de(cleDe(x)).jeux[x.s] = Number(x.n);
  for (const x of l.conflits) de(cleDe(x)).conflits[x.s] = Number(x.n);
  for (const x of l.types) { const a = de(cleDe(x)); a.documentsManquants.typesObligatoiresNonFournis = Number(x.n); a.documentsManquants.projetsIncomplets = Number(x.projets); }
  if (decideur && l.pieces) {
    for (const x of l.pieces) {
      const a = de(cleDe(x));
      a.documentsManquants.piecesEnAttenteParStatut![x.s] = Number(x.n);
      a.documentsManquants.piecesEnAttente = (a.documentsManquants.piecesEnAttente ?? 0) + Number(x.n);
    }
  }
  if (decideur && l.referents) for (const x of l.referents) de(cleDe(x)).referentsActifs = { comptes: Number(x.comptes), rattachements: Number(x.rattachements) };
  return m;
}
