/**
 * BLOC « PRIORITE TECHNIQUE » DES PARAMETRES DU MOTEUR (cahier d'aide a la decision, paragraphe 6). AUCUN IMPORT.
 *
 * Ce bloc ne cree PAS un second jeu de parametres : il s'ajoute, en cle optionnelle `priorite`, aux `valeurs` d'une
 * version de `parametres_programmation` (voir parametres.noyau.ts). Il herite donc, sans une ligne de code de plus, de
 * tout le mecanisme existant : version immuable, auteur (`creeParId`), approbation (`approuveeLe`), audit, copie dans
 * les entrees d'un scenario rejoue. La table n'a pas ete modifiee : sa contrainte `pp_valeurs_completes` n'exige que les
 * dix cles du risque et accepte une cle de plus.
 *
 * CE FICHIER NE CONTIENT AUCUN COEFFICIENT OFFICIEL. Les poids, seuils et plafonds ci-dessous sont des VALEURS D'AMORCAGE
 * DE SIMULATION, comme celles de `parametres.noyau.ts` : sans source, jamais arretees par AGEROUTE, l'ONR ou un bailleur
 * (decision D-01 ouverte). Ils sont rendus avec l'etiquette « PROVISOIRE, non approuve » tant que la version qui les porte
 * n'est pas approuvee, et le cahier le dit : « La formule finale doit etre confirmee par le metier avant exploitation
 * reelle. »
 *
 * LES SIX CRITERES DE LA PRIORITE TECHNIQUE sont ceux du cahier (6.2), moins le cout. Le cout et l'efficacite sont la
 * dimension de l'ORDRE D'ARBITRAGE (le ratio du simulateur), jamais un poids de la priorite : melanger les deux faisait
 * classer un troncon critique dernier parce qu'il est cher.
 */

export const CRITERES_TECHNIQUES = [
  "ETAT_GRAVITE",
  "IMPORTANCE_AXE",
  "SECURITE_CRITICITE",
  "ACCESSIBILITE_SERVICE",
  "URGENCE_TEMPORELLE",
  "MATURITE_FAISABILITE",
] as const;
export type CritereTechnique = (typeof CRITERES_TECHNIQUES)[number];

/** Identifiant du modele de calcul que ce bloc parametre. Un bloc d'un autre modele est refuse, pas reinterprete. */
export const MODELE_PRIORITE = "priorite-technique-1";

export interface BlocPriorite {
  modele: string;
  /** Poids de chaque critere. Leur somme n'a pas a valoir 100 : le calcul renormalise. Un poids nul EXCLUT le critere, explicitement. */
  poids: Record<CritereTechnique, number>;
  /** Debut de validite (AAAA-MM-JJ), `null` = sans borne. Hors validite, le resultat est rendu PROVISOIRE et le dit. */
  validiteDe: string | null;
  /** Fin de validite (AAAA-MM-JJ), `null` = sans borne. */
  validiteA: string | null;
  /** Part minimale du poids total qui doit etre couverte pour rendre un score (]0 ; 1]). En dessous : exclusion COUVERTURE_INSUFFISANTE. */
  couvertureMinimale: number;
  /**
   * Nombre de points noirs CONFIRMES que le registre d'une region doit contenir pour que « zero point noir sur ce
   * troncon » soit une donnee et non une absence. En dessous, le critere securite est ABSENT pour les troncons de la
   * region qui n'en ont aucun (voir resoudreSecurite dans priorite.noyau.ts).
   */
  registrePointsNoirsMinimum: number;
  /** Anciennete (jours) d'une degradation connue a partir de laquelle le critere d'urgence vaut 100. */
  urgenceAnciennetePlafondJours: number;
}

/**
 * Valeurs d'amorcage. Chacune est PROVISOIRE et SANS SOURCE. Poids a zero pour les deux criteres qui n'ont AUCUNE donnee
 * structuree (accessibilite, maturite) : ils sont exclus explicitement et listes comme non disponibles, au lieu de rendre
 * tous les scores « incomplets » pour une raison que chaque ligne repeterait. Un administrateur qui leur donne un poids
 * les rend manquants sur toutes les lignes, avec leur raison, jusqu'a ce qu'une source existe.
 */
export const BLOC_PRIORITE_AMORCAGE: BlocPriorite = {
  modele: MODELE_PRIORITE,
  poids: {
    ETAT_GRAVITE: 40,
    IMPORTANCE_AXE: 25,
    SECURITE_CRITICITE: 20,
    ACCESSIBILITE_SERVICE: 0,
    URGENCE_TEMPORELLE: 15,
    MATURITE_FAISABILITE: 0,
  },
  validiteDe: null,
  validiteA: null,
  couvertureMinimale: 0.3,
  registrePointsNoirsMinimum: 5,
  urgenceAnciennetePlafondJours: 730,
};

const estNombre = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const REGEX_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Date AAAA-MM-JJ qui existe au calendrier (le 31 fevrier est refuse). */
export function dateCalendaireValide(t: unknown): t is string {
  if (typeof t !== "string") return false;
  const m = REGEX_DATE.exec(t);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

const CLES = ["modele", "poids", "validiteDe", "validiteA", "couvertureMinimale", "registrePointsNoirsMinimum", "urgenceAnciennetePlafondJours"] as const;

/** Valide le bloc et rend TOUTES les erreurs (aucune correction silencieuse), comme `validerValeurs`. */
export function validerBlocPriorite(b: unknown): { ok: true; bloc: BlocPriorite } | { ok: false; erreurs: string[] } {
  const e: string[] = [];
  if (typeof b !== "object" || b === null || Array.isArray(b)) return { ok: false, erreurs: ["priorite : objet attendu"] };
  const o = b as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(CLES as readonly string[]).includes(k)) e.push(`priorite : cle inconnue ${k}`);
  for (const k of CLES) if (!(k in o)) e.push(`priorite : cle manquante ${k}`);

  if ("modele" in o && o.modele !== MODELE_PRIORITE) e.push(`priorite.modele : ${MODELE_PRIORITE} attendu (un autre modele ne se reinterprete pas)`);

  const poids = o.poids as Record<string, unknown> | undefined;
  if (poids && typeof poids === "object" && !Array.isArray(poids)) {
    for (const k of Object.keys(poids)) if (!(CRITERES_TECHNIQUES as readonly string[]).includes(k)) e.push(`priorite.poids : critere inconnu ${k}`);
    let somme = 0;
    for (const c of CRITERES_TECHNIQUES) {
      const w = poids[c];
      if (!estNombre(w) || w < 0) e.push(`priorite.poids.${c} : nombre >= 0 attendu`);
      else somme += w;
    }
    if (somme <= 0 && CRITERES_TECHNIQUES.every((c) => estNombre(poids[c]))) e.push("priorite.poids : la somme des poids doit etre > 0");
  } else if ("poids" in o) e.push("priorite.poids : objet attendu");

  for (const k of ["validiteDe", "validiteA"] as const) {
    if (k in o && o[k] !== null && !dateCalendaireValide(o[k])) e.push(`priorite.${k} : null ou date AAAA-MM-JJ existante attendue`);
  }
  if (dateCalendaireValide(o.validiteDe) && dateCalendaireValide(o.validiteA) && o.validiteDe > o.validiteA) e.push("priorite : validiteDe doit preceder validiteA");

  if ("couvertureMinimale" in o && (!estNombre(o.couvertureMinimale) || o.couvertureMinimale <= 0 || o.couvertureMinimale > 1)) {
    e.push("priorite.couvertureMinimale : nombre dans ]0 ; 1] attendu");
  }
  if ("registrePointsNoirsMinimum" in o && (!Number.isInteger(o.registrePointsNoirsMinimum) || (o.registrePointsNoirsMinimum as number) < 1 || (o.registrePointsNoirsMinimum as number) > 100000)) {
    e.push("priorite.registrePointsNoirsMinimum : entier entre 1 et 100000 attendu");
  }
  if ("urgenceAnciennetePlafondJours" in o && (!Number.isInteger(o.urgenceAnciennetePlafondJours) || (o.urgenceAnciennetePlafondJours as number) < 1 || (o.urgenceAnciennetePlafondJours as number) > 36500)) {
    e.push("priorite.urgenceAnciennetePlafondJours : entier entre 1 et 36500 attendu");
  }

  if (e.length > 0) return { ok: false, erreurs: e };
  return { ok: true, bloc: structuredClone(o) as unknown as BlocPriorite };
}
