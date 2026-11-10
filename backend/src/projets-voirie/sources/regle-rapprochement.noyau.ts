/**
 * REGLES DE RAPPROCHEMENT ENTRE SOURCES (noyau pur, lot S1 ; contrat CONTRAT-SOURCES.md, sections 3.2 et 4).
 *
 * Le corridor d un couple d objets est `max(precision A, precision B) + marge`, et seulement si les DEUX precisions sont connues, exprimees en
 * metres horizontaux (cahier 21.1 : « ne pas additionner les precisions arbitrairement sans methode documentee » ; decision 2 : marge de 1 m par
 * defaut). Une precision inconnue n est jamais inventee : le couple est RAPPROCHEMENT_INCERTAIN, sans mesure.
 *
 * La precision d un objet vient, dans l ordre : du descripteur B1 (precision horizontale declaree pour l objet), du jeu (precision horizontale
 * declaree), sinon elle est inconnue. UNE CLASSE DE PRECISION (A a E) N EST PAS UNE PRECISION EN METRES (correctifs T1+S1, M6, decision de
 * l architecte) : la regle systeme ne porte aucun bareme ; une classe n est convertie en metres que par le BAREME APPROUVE d une regle creee par une
 * personne et approuvee par un ADMIN AUTRE que l auteur (`baremeApprouve`). La resolution et l approbation des regles suivent le meme mecanisme que
 * les regles de conflit (RC-3), sans derogation possible pour une regle qui porte un bareme.
 */

import { JUSTIFICATION_MIN, type StatutRegle } from "../conflits/types.noyau";
import { CODE_REGLE_RAPPROCHEMENT_DEFAUT, type OriginePrecision } from "./types.noyau";

export const CLASSES_PRECISION_METRIQUES = ["A", "B", "C", "D"] as const;
export type ClasseMetrique = (typeof CLASSES_PRECISION_METRIQUES)[number];
export type TablePrecisionParClasse = Readonly<Record<ClasseMetrique, number>>;

export const MARGE_DEFAUT_M = 1;
export const RAYON_APPARIEMENT_DEFAUT_M = 10;
export const PART_HORS_CORRIDOR_MAX_DEFAUT = 0;

export interface RegleRapprochementLue {
  /** Nul : regle de repli du code (la table n en porte aucune), jamais attendu sur une base migree. */
  regleId: string | null;
  projetId: string | null;
  famille: string | null;
  code: string;
  version: number;
  margeM: number;
  rayonAppariementM: number;
  partHorsCorridorMax: number;
  /** Bareme classe vers metres de la regle ; nul : aucun bareme (une classe seule reste une precision inconnue). */
  precisionParClasseM: TablePrecisionParClasse | null;
  statut: StatutRegle;
  approuveLe: Date | null;
  /** Auteur (nul : regle systeme) et approbateur : un bareme ne s applique que si les deux sont des personnes distinctes. */
  creeParId?: string | null;
  approuveParId?: string | null;
}

export const REGLE_RAPPROCHEMENT_DEFAUT: RegleRapprochementLue = {
  regleId: null, projetId: null, famille: null, code: CODE_REGLE_RAPPROCHEMENT_DEFAUT, version: 0,
  margeM: MARGE_DEFAUT_M, rayonAppariementM: RAYON_APPARIEMENT_DEFAUT_M, partHorsCorridorMax: PART_HORS_CORRIDOR_MAX_DEFAUT,
  precisionParClasseM: null, statut: "APPROUVEE", approuveLe: null, creeParId: null, approuveParId: null,
};

/**
 * Bareme applicable d une regle : sa table classe vers metres SEULEMENT si la regle est APPROUVEE, creee par une personne et approuvee par une autre
 * personne (separation des taches, sans derogation). Une regle systeme, auto-approuvee ou sans table n a aucun bareme : `null`.
 */
export function baremeApprouve(r: RegleRapprochementLue): TablePrecisionParClasse | null {
  if (r.precisionParClasseM === null || r.statut !== "APPROUVEE") return null;
  if (!r.creeParId || !r.approuveParId || r.creeParId === r.approuveParId) return null;
  return r.precisionParClasseM;
}

export type PorteeRegle = "PROJET_FAMILLE" | "PROJET" | "GENERALE_FAMILLE" | "GENERALE" | "DEFAUT";
export interface RegleRapprochementResolue { regle: RegleRapprochementLue; portee: PorteeRegle }

const estDefaut = (r: RegleRapprochementLue) => r.projetId === null && r.famille === null && r.code === CODE_REGLE_RAPPROCHEMENT_DEFAUT && r.version === 0;

function plusRecente(a: RegleRapprochementLue, b: RegleRapprochementLue): number {
  const ta = a.approuveLe ? a.approuveLe.getTime() : 0;
  const tb = b.approuveLe ? b.approuveLe.getTime() : 0;
  return tb - ta || b.version - a.version || a.code.localeCompare(b.code);
}

/**
 * Regle applicable a une famille : la plus recente version APPROUVEE 1. du projet pour la famille, 2. du projet, 3. generale pour la famille,
 * 4. generale, 5. la regle par defaut. Une regle BROUILLON ou RETIREE n est jamais appliquee. Meme ordre que RC-3 (regle.noyau.ts).
 */
export function resoudreRegleRapprochement(regles: readonly RegleRapprochementLue[], projetId: string, famille: string | null): RegleRapprochementResolue {
  const approuvees = regles.filter((r) => r.statut === "APPROUVEE");
  const niveaux: { portee: PorteeRegle; filtre: (r: RegleRapprochementLue) => boolean }[] = [
    { portee: "PROJET_FAMILLE", filtre: (r) => r.projetId === projetId && famille !== null && r.famille === famille },
    { portee: "PROJET", filtre: (r) => r.projetId === projetId && r.famille === null },
    { portee: "GENERALE_FAMILLE", filtre: (r) => r.projetId === null && famille !== null && r.famille === famille },
    { portee: "GENERALE", filtre: (r) => r.projetId === null && r.famille === null && !estDefaut(r) },
  ];
  for (const n of niveaux) {
    const candidates = approuvees.filter(n.filtre).sort(plusRecente);
    if (candidates.length > 0) return { regle: candidates[0], portee: n.portee };
  }
  return { regle: approuvees.find(estDefaut) ?? REGLE_RAPPROCHEMENT_DEFAUT, portee: "DEFAUT" };
}

/**
 * Lecture de la table de precision par classe d une regle (JSON de la base ou corps d une requete) : chaque classe A a D doit porter un nombre
 * strictement positif et au plus 100 000 m ; une table vide (`{}` : aucun bareme), incomplete ou mal formee rend `null` (la route refuse une
 * table mal formee ; la lecture d une regle n en retient alors AUCUNE, jamais une valeur par defaut).
 */
export function lirePrecisionParClasse(v: unknown): TablePrecisionParClasse | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const sortie: Partial<Record<ClasseMetrique, number>> = {};
  for (const c of CLASSES_PRECISION_METRIQUES) {
    const x = o[c];
    if (typeof x !== "number" || !Number.isFinite(x) || x <= 0 || x > 100_000) return null;
    sortie[c] = Math.round(x * 100) / 100;
  }
  if (Object.keys(o).some((k) => !(CLASSES_PRECISION_METRIQUES as readonly string[]).includes(k))) return null;
  return sortie as TablePrecisionParClasse;
}

export interface EntreePrecision {
  /** Precision horizontale declaree par le descripteur de l objet (B1), en metres ; nulle = non declaree. */
  precisionObjetM: number | null | undefined;
  /** Precision horizontale declaree du jeu, en metres ; nulle = non declaree. */
  precisionJeuM: number | null | undefined;
  /** Classe declaree par le descripteur, sinon celle du jeu (A a E) ; nulle = inconnue. */
  classeObjet: string | null | undefined;
  classeJeu: string | null | undefined;
}

export interface PrecisionRetenue { precisionM: number | null; origine: OriginePrecision }

const metrique = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;

/**
 * Precision retenue pour un objet : objet, jeu, sinon classe convertie par le BAREME APPROUVE (`baremeApprouve`), sinon inconnue. Sans bareme
 * (`table` nulle, cas de la regle systeme), une classe seule reste une precision INCONNUE. La classe E (sans geometrie) reste toujours inconnue.
 */
export function precisionRetenue(e: EntreePrecision, table: TablePrecisionParClasse | null): PrecisionRetenue {
  if (metrique(e.precisionObjetM)) return { precisionM: arrondi2(e.precisionObjetM), origine: "OBJET" };
  if (metrique(e.precisionJeuM)) return { precisionM: arrondi2(e.precisionJeuM), origine: "JEU" };
  const classe = e.classeObjet ?? e.classeJeu ?? null;
  if (table && classe && (CLASSES_PRECISION_METRIQUES as readonly string[]).includes(classe)) return { precisionM: table[classe as ClasseMetrique], origine: "CLASSE" };
  return { precisionM: null, origine: "INCONNUE" };
}

const arrondi2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Corridor d un couple : `max(pA, pB) + marge`, en metres, arrondi au centimetre ; `null` des qu une precision manque (aucune valeur inventee,
 * le couple sera RAPPROCHEMENT_INCERTAIN). Une marge negative ou non finie compte pour zero (la base refuse de toute facon une marge negative).
 */
export function corridorM(precisionAM: number | null, precisionBM: number | null, margeM: number): number | null {
  if (!metrique(precisionAM) || !metrique(precisionBM)) return null;
  const marge = Number.isFinite(margeM) && margeM > 0 ? margeM : 0;
  return arrondi2(Math.max(precisionAM, precisionBM) + marge);
}

/** Prochain numero de version pour (projet, famille, code). */
export function prochaineVersionRegleRapprochement(versionsExistantes: readonly number[]): number {
  return versionsExistantes.length === 0 ? 1 : Math.max(...versionsExistantes) + 1;
}

export type VerdictCreationRegle = { ok: true } | { ok: false; status: number; code: string; message: string };

/** Coherence d une regle a creer : justification, bornes des parametres (la base les refuse aussi : defense en profondeur). */
export function verifierCreationRegleRapprochement(d: { margeM: number; rayonAppariementM: number; partHorsCorridorMax: number; justification: string }): VerdictCreationRegle {
  if (d.justification.trim().length < JUSTIFICATION_MIN) {
    return { ok: false, status: 422, code: "JUSTIFICATION_REQUISE", message: `Une justification de ${JUSTIFICATION_MIN} caractères au moins est requise.` };
  }
  if (!(d.margeM >= 0 && d.margeM <= 100)) return { ok: false, status: 400, code: "CHAMPS_INVALIDES", message: "margeM doit être comprise entre 0 et 100 m." };
  if (!(d.rayonAppariementM >= 0.01 && d.rayonAppariementM <= 1000)) return { ok: false, status: 400, code: "CHAMPS_INVALIDES", message: "rayonAppariementM doit être compris entre 0,01 et 1 000 m." };
  if (!(d.partHorsCorridorMax >= 0 && d.partHorsCorridorMax <= 1)) return { ok: false, status: 400, code: "CHAMPS_INVALIDES", message: "partHorsCorridorMax doit être comprise entre 0 et 1." };
  return { ok: true };
}
