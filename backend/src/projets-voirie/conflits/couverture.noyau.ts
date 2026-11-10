/**
 * DOSSIERS DE COUVERTURE INSUFFISANTE REGROUPES PAR AXE (noyau pur ; pilote local du 09/11/2026, defaut D7 ; decision de l'architecte du 10/11/2026).
 *
 * Avant : un dossier `COUVERTURE_INSUFFISANTE` par OBJET du plan d'axes (128 dossiers pour un seul corridor decoupe par feuille de plan).
 * Maintenant : UN dossier par AXE du plan d'axes. L'axe est identifie, dans cet ordre :
 *   1. par la valeur de la colonne `identifiant` du mapping du jeu (`resume.import.mapping.identifiant`) quand le jeu en a une et que l'objet
 *      porte une valeur non vide (`i:` + valeur normalisee) ;
 *   2. sinon par son NOM normalise (`n:` + nom normalise : `normaliserNom`, la meme normalisation que la cle stable) ;
 *   3. un objet SANS nom (ni identifiant) n'est rattache a rien : il garde son propre dossier, avec la cle d'avant (libelle « Axe <ordre> »
 *      et cellule de son milieu), donc le meme dossier qu'avant au rejeu.
 * Seuls les morceaux NON couverts entrent dans le dossier : sa geometrie est leur reunion (calculee par la base), sa mesure porte leur nombre,
 * leur longueur totale et le detail de chacun (objet, ordre, nom, longueur), borne a `DETAIL_MORCEAUX_MAX` lignes ; le nombre reste exact.
 *
 * CLE STABLE (`cleCouvertureAxe`, classification.noyau.ts) : SHA-256 de (projet, identite de l'axe, type), dans un espace distinct de `cleConflit` (prefixe propre) :
 * meme entree, meme cle ; ajouter, retirer ou redecouper un morceau d'un axe garde la cle (la mesure change, le dossier est marque a
 * reexaminer) ; renommer l'axe change la cle (comme pour tout dossier, CONTRAT-CONFLITS.md point 30).
 */

import { normaliserNom } from "./classification.noyau";
import type { MorceauxCouverture } from "./types.noyau";

/** Lignes de detail des morceaux au plus dans la mesure d'un dossier (le nombre et la longueur totale restent exacts au-dela). */
export const DETAIL_MORCEAUX_MAX = 1000;

/** Un objet lineaire du plan d'axes, tel que le lit la requete de couverture. */
export interface MorceauAxe {
  objetId: string;
  jeuAxesId: string;
  ordre: number;
  nom: string | null;
  /** Valeur de la colonne `identifiant` du mapping pour cet objet, ou nul (pas de colonne, ou valeur absente). */
  identifiant: string | null;
  /** Libelle d'axe de l'objet seul : son nom, sinon « Axe <ordre + 1> » (celui d'avant le regroupement). */
  libelle: string;
  longueurM: number;
  /** Nombre de jeux de reseau lineaires autorises dont l'emprise englobante contient l'objet ; 0 = non couvert. */
  nbCouvrants: number;
}

export interface GroupeCouverture {
  /** Identite stable de l'axe (`i:...` ou `n:...`), ou nulle pour un objet sans nom : il garde alors son propre dossier. */
  identite: string | null;
  jeuAxesId: string;
  /** Libelle du dossier (colonne `axe`). */
  axe: string;
  /** Morceaux NON couverts, tries par ordre puis par identifiant d'objet. */
  morceaux: MorceauAxe[];
}

const nonVide = (s: string | null | undefined): s is string => typeof s === "string" && s.trim() !== "";

/** Identite d'un axe : identifiant mappe, sinon nom ; nulle si l'objet n'a ni l'un ni l'autre. */
export function identiteAxe(nom: string | null, identifiant: string | null): string | null {
  if (nonVide(identifiant)) return `i:${normaliserNom(identifiant)}`;
  if (nonVide(nom)) return `n:${normaliserNom(nom)}`;
  return null;
}

const parOrdre = (a: MorceauAxe, b: MorceauAxe) => a.ordre - b.ordre || (BigInt(a.objetId) < BigInt(b.objetId) ? -1 : BigInt(a.objetId) > BigInt(b.objetId) ? 1 : 0);

/**
 * Regroupe les morceaux NON couverts par (plan d'axes, identite). Le resultat ne depend pas de l'ordre de lecture : groupes tries par
 * plan d'axes puis identite (les objets sans nom ensuite, par ordre). Libelle d'un groupe : le nom du premier morceau nomme (par ordre),
 * sinon « Axe <identifiant> » (identifiant sans nom), sinon le libelle de l'objet seul.
 */
export function regrouperCouverture(morceaux: readonly MorceauAxe[]): GroupeCouverture[] {
  const groupes = new Map<string, GroupeCouverture>();
  const seuls: GroupeCouverture[] = [];
  for (const m of morceaux) {
    if (m.nbCouvrants > 0) continue;
    const identite = identiteAxe(m.nom, m.identifiant);
    if (identite === null) { seuls.push({ identite: null, jeuAxesId: m.jeuAxesId, axe: m.libelle, morceaux: [m] }); continue; }
    const k = `${m.jeuAxesId}\u001f${identite}`;
    const g = groupes.get(k) ?? { identite, jeuAxesId: m.jeuAxesId, axe: "", morceaux: [] };
    g.morceaux.push(m);
    groupes.set(k, g);
  }
  for (const g of groupes.values()) {
    g.morceaux.sort(parOrdre);
    const nomme = g.morceaux.find((m) => nonVide(m.nom));
    g.axe = nomme ? nomme.nom! : nonVide(g.morceaux[0].identifiant) ? `Axe ${g.morceaux[0].identifiant!.trim()}` : g.morceaux[0].libelle;
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [
    ...[...groupes.values()].sort((a, b) => cmp(a.jeuAxesId, b.jeuAxesId) || cmp(a.identite!, b.identite!)),
    ...seuls.sort((a, b) => cmp(a.jeuAxesId, b.jeuAxesId) || parOrdre(a.morceaux[0], b.morceaux[0])),
  ];
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Mesure des morceaux d'un groupe : nombre exact, longueur totale (somme), detail borne. */
export function morceauxDe(g: GroupeCouverture): MorceauxCouverture {
  return {
    nb: g.morceaux.length,
    longueurTotaleM: r2(g.morceaux.reduce((s, m) => s + m.longueurM, 0)),
    detail: g.morceaux.slice(0, DETAIL_MORCEAUX_MAX).map((m) => ({ objetId: m.objetId, ordre: m.ordre, nom: m.nom, longueurM: r2(m.longueurM) })),
    detailTronque: g.morceaux.length > DETAIL_MORCEAUX_MAX,
  };
}
