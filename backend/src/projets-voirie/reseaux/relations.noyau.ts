/**
 * RELATIONS ENTRE OBJETS ET PROPOSITIONS D'ASSOCIATION (noyau pur, lot B1 ; cahier v2, 20.1 et 22.2 point 5).
 *
 * Une relation dit qu'un objet est PORTE PAR une infrastructure (circuit logique -> infrastructure physique) ou CONTENU DANS une
 * infrastructure (equipement -> chambre, regard...). Une simple proximite geometrique ne prouve rien (cahier, 20.3) : l'association
 * AUTOMATIQUE par superposition n'est jamais qu'une PROPOSITION (statut PROPOSEE) ; elle n'a d'effet que validee par une personne
 * identifiee, avec justification, et l'acte est audite. Une proposition refusee n'est jamais reproposee.
 *
 * La CONNECTIVITE du reseau (noeuds, continuite, traces amont et aval) n'est pas geree ici : le cahier la reporte (lot 7).
 */

import {
  JUSTIFICATION_MIN, type ClassePrecision, type NatureObjet, type StatutRelation, type TypeGeom, type TypeRelation,
} from "./types.noyau";

// ------------------------------------------------------------------------------------------------
// Types de relation : natures et geometries admises
// ------------------------------------------------------------------------------------------------

export interface RegleRelation {
  /** Natures admises a chaque bout (lot S1 : CONNECTE_A en admet deux, infrastructure ou equipement). */
  source: readonly NatureObjet[];
  cible: readonly NatureObjet[];
  geomSource: readonly TypeGeom[];
  geomCible: readonly TypeGeom[];
  libelle: string;
}

const TOUTES_GEOM: readonly TypeGeom[] = ["LIGNE", "POINT", "POLYGONE"];
const PHYSIQUES: readonly NatureObjet[] = ["ACTIF_PHYSIQUE", "EQUIPEMENT"];

export const REGLES_RELATION: Readonly<Record<TypeRelation, RegleRelation>> = {
  PORTE_PAR: { source: ["CIRCUIT_LOGIQUE"], cible: ["ACTIF_PHYSIQUE"], geomSource: ["LIGNE"], geomCible: ["LIGNE"], libelle: "un circuit logique est porté par une infrastructure physique linéaire" },
  CONTENU_DANS: { source: ["EQUIPEMENT"], cible: ["ACTIF_PHYSIQUE"], geomSource: ["POINT"], geomCible: ["POINT", "POLYGONE"], libelle: "un équipement est contenu dans une infrastructure physique ponctuelle ou surfacique (chambre, regard...)" },
  // Lot S1 : connexion DECLAREE entre deux objets physiques ; un circuit logique ne se connecte pas, il est porte. Aucune geometrie n est imposee ni examinee.
  CONNECTE_A: { source: PHYSIQUES, cible: PHYSIQUES, geomSource: TOUTES_GEOM, geomCible: TOUTES_GEOM, libelle: "un objet physique (infrastructure ou équipement) est déclaré connecté à un autre objet physique" },
};

export type VerdictRelation = { ok: true } | { ok: false; code: "RELATION_SUR_SOI" | "NATURE_RELATION_INCOMPATIBLE" | "GEOMETRIE_RELATION_INCOMPATIBLE"; message: string };

export interface ExtremiteRelation { nature: NatureObjet; typeGeom: TypeGeom }

/** Une relation de ce type peut-elle relier ces deux objets ? (Les memes regles sont portees par un declencheur de la base.) */
export function verifierRelation(type: TypeRelation, source: ExtremiteRelation, cible: ExtremiteRelation, memeObjet: boolean): VerdictRelation {
  if (memeObjet) return { ok: false, code: "RELATION_SUR_SOI", message: "Un objet ne peut pas être relié à lui-même." };
  const r = REGLES_RELATION[type];
  if (!r.source.includes(source.nature) || !r.cible.includes(cible.nature)) {
    return {
      ok: false, code: "NATURE_RELATION_INCOMPATIBLE",
      message: `Relation ${type} : ${r.libelle} (source ${r.source.join("/")}, cible ${r.cible.join("/")} ; reçu : source ${source.nature}, cible ${cible.nature}). Déclarez d'abord la nature des objets.`,
    };
  }
  if (!r.geomSource.includes(source.typeGeom) || !r.geomCible.includes(cible.typeGeom)) {
    return { ok: false, code: "GEOMETRIE_RELATION_INCOMPATIBLE", message: `Relation ${type} : géométrie source ${r.geomSource.join("/")} et cible ${r.geomCible.join("/")} attendues (reçu : ${source.typeGeom} et ${cible.typeGeom}).` };
  }
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------
// Machine a etats d'une relation
// ------------------------------------------------------------------------------------------------

export type ActionRelation = "valider" | "refuser" | "revoquer";

/**
 * - valider  : PROPOSEE, REFUSEE ou REVOQUEE -> VALIDEE (une personne reconsidere ; l'ancien acte reste dans l'audit) ;
 * - refuser  : PROPOSEE -> REFUSEE (une proposition refusee n'est plus jamais reproposee) ;
 * - revoquer : VALIDEE -> REVOQUEE.
 */
export const TRANSITIONS_RELATION: Readonly<Record<ActionRelation, { de: readonly StatutRelation[]; vers: StatutRelation }>> = {
  valider: { de: ["PROPOSEE", "REFUSEE", "REVOQUEE"], vers: "VALIDEE" },
  refuser: { de: ["PROPOSEE"], vers: "REFUSEE" },
  revoquer: { de: ["VALIDEE"], vers: "REVOQUEE" },
};

export type VerdictTransition = { ok: true; vers: StatutRelation } | { ok: false; code: "TRANSITION_INTERDITE" | "JUSTIFICATION_REQUISE"; message: string };

export function verifierTransitionRelation(action: ActionRelation, statut: StatutRelation, justification: string): VerdictTransition {
  const t = TRANSITIONS_RELATION[action];
  if (!t.de.includes(statut)) {
    return { ok: false, code: "TRANSITION_INTERDITE", message: `Une relation ${statut} ne peut pas être ${action === "valider" ? "validée" : action === "refuser" ? "refusée" : "révoquée"} (états de départ : ${t.de.join(", ")}).` };
  }
  if (justification.trim().length < JUSTIFICATION_MIN) {
    return { ok: false, code: "JUSTIFICATION_REQUISE", message: `Une justification de ${JUSTIFICATION_MIN} caractères au moins est requise.` };
  }
  return { ok: true, vers: t.vers };
}

/** Transitions offertes pour un statut (aide a l'interface). */
export function actionsPossibles(statut: StatutRelation): ActionRelation[] {
  return (Object.keys(TRANSITIONS_RELATION) as ActionRelation[]).filter((a) => TRANSITIONS_RELATION[a].de.includes(statut));
}

// ------------------------------------------------------------------------------------------------
// Tolerance de superposition, liee a la classe de precision
// ------------------------------------------------------------------------------------------------

/** Cle de la table de tolerances : une classe A a D, ou INCONNUE. La classe E n'a pas de tolerance : voir `classeExclue`. */
export type CleTolerance = Exclude<ClassePrecision, "E"> | "INCONNUE";
export type TableTolerances = Readonly<Record<CleTolerance, number>>;

/**
 * VALEURS PAR DEFAUT, PROVISOIRES, A VALIDER PAR LA DSI : le cahier (20.2) dit que les seuils metriques des classes sont a configurer par la
 * DSI et les metiers, et de ne pas attribuer une precision standard. Ces valeurs ne sont PAS des precisions attribuees aux donnees : ce sont
 * des tolerances de rapprochement pour PROPOSER une association a une personne. Reglables (`config.ts`), enregistrees dans chaque proposition.
 */
export const TOLERANCES_DEFAUT_M: TableTolerances = { A: 0.5, B: 1, C: 2, D: 5, INCONNUE: 2 };
/** Part minimale de la longueur du circuit situee dans la tolerance de l'infrastructure : defaut PROVISOIRE, a valider. */
export const COUVERTURE_MIN_DEFAUT = 0.9;

/** La classe E (« inconnue / sans geometrie », cahier 20.2) ne donne jamais lieu a une proposition automatique : pas de faux trace. */
export const classeExclue = (c: ClassePrecision | null): boolean => c === "E";

export interface EntreeTolerance {
  classeCircuit: ClassePrecision | null;
  classeInfra: ClassePrecision | null;
  precisionCircuitM: number | null;
  precisionInfraM: number | null;
  table: TableTolerances;
}

export interface Tolerance {
  toleranceM: number;
  composantes: { classeCircuitM: number; classeInfraM: number; precisionCircuitM: number | null; precisionInfraM: number | null };
  /** Methode documentee : le MAXIMUM des composantes (pas leur somme : cahier 21.1, « ne pas additionner les precisions arbitrairement »). */
  methode: "maximum";
}

const cle = (c: ClassePrecision | null): CleTolerance => (c === null || c === "E" ? "INCONNUE" : c);

/** Tolerance de rapprochement de deux objets : le maximum de la tolerance de la classe de chacun et de leurs precisions horizontales declarees. */
export function toleranceAssociation(e: EntreeTolerance): Tolerance {
  if (classeExclue(e.classeCircuit) || classeExclue(e.classeInfra)) throw new Error("classe E : aucune tolerance (association automatique exclue)");
  const classeCircuitM = e.table[cle(e.classeCircuit)];
  const classeInfraM = e.table[cle(e.classeInfra)];
  const toleranceM = Math.max(classeCircuitM, classeInfraM, e.precisionCircuitM ?? 0, e.precisionInfraM ?? 0);
  return { toleranceM, composantes: { classeCircuitM, classeInfraM, precisionCircuitM: e.precisionCircuitM, precisionInfraM: e.precisionInfraM }, methode: "maximum" };
}

// ------------------------------------------------------------------------------------------------
// Decision de proposition
// ------------------------------------------------------------------------------------------------

export interface MesureSuperposition { longueurCircuitM: number; longueurDansToleranceM: number }

/** Part de la longueur du circuit situee dans la tolerance de l'infrastructure (0 a 1). Un circuit de longueur nulle n'a aucune couverture. */
export function couverture(m: MesureSuperposition): number {
  if (!(m.longueurCircuitM > 0)) return 0;
  return Math.min(1, Math.max(0, m.longueurDansToleranceM / m.longueurCircuitM));
}

/** Proposer ou non : la couverture atteint le seuil. Le resultat est une PROPOSITION a valider, jamais une association appliquee. */
export function proposer(m: MesureSuperposition, couvertureMin: number): { propose: boolean; couverture: number } {
  const c = couverture(m);
  return { propose: c >= couvertureMin && c > 0, couverture: c };
}

export interface CandidatProposition { circuitId: string; infraId: string; couverture: number }

/** Ordre des identifiants numeriques en texte (bigint) : la longueur d'abord, puis l'ordre lexicographique. */
const comparerIds = (a: string, b: string): number => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

/** Retient au plus `max` propositions par circuit (les mieux couvertes, a egalite l'identifiant de l'infrastructure), dans un ordre deterministe. */
export function retenirPropositions(candidats: readonly CandidatProposition[], max: number): CandidatProposition[] {
  const parCircuit = new Map<string, CandidatProposition[]>();
  for (const c of candidats) parCircuit.set(c.circuitId, [...(parCircuit.get(c.circuitId) ?? []), c]);
  const sortie: CandidatProposition[] = [];
  for (const [, l] of [...parCircuit.entries()].sort(([a], [b]) => comparerIds(a, b))) {
    l.sort((p, q) => q.couverture - p.couverture || comparerIds(p.infraId, q.infraId));
    sortie.push(...l.slice(0, Math.max(0, max)));
  }
  return sortie;
}
