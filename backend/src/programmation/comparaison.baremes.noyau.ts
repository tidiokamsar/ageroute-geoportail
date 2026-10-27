/**
 * VERSION DES BAREMES D'UNE SIMULATION : un identifiant STABLE, la liste de ce qui a servi, et la peremption.
 * Aucun acces base.
 *
 * POURQUOI UNE « VERSION DES BAREMES »
 *
 * `baremes_intervention` n'a pas de version globale : chaque ligne a la sienne, et une ligne peut etre
 * remplacee, approuvee, periodisee. Deux scenarios calcules « avec les baremes » peuvent donc avoir utilise des
 * jeux differents sans que rien ne le dise. Ce module fige, DANS LES ENTREES du scenario, la liste exacte des
 * lignes disponibles (id, code, version, cout, approbation, fenetre de validite) et une EMPREINTE SHA-256 de
 * cette liste canonique : deux scenarios ont les memes baremes si et seulement si leurs empreintes sont egales.
 * L'empreinte est recalculee a chaque validation des entrees : une liste retouchee, ou une empreinte qui ne
 * correspond plus aux lignes de calcul, est un refus.
 *
 * PEREMPTION. Un cout n'est fiable que si la fenetre de validite de sa ligne de bareme COUVRE TOUTE LA PERIODE
 * simulee : un bareme qui expire en cours de periode, ou qui n'est pas encore en vigueur a son debut, donne un
 * cout PERIME. Une ligne sans fenetre (validDe et validA nuls) ne perime jamais : on ne devine pas de date.
 * Les dates sont des chaines AAAA-MM-JJ comparables telles quelles.
 */

import { canonique, sha256Hex } from "./canonique";
import type { LigneBareme } from "../engines/cout.noyau";

export interface BaremeRef {
  id: number | string;
  code: string | null;
  /** Numero de version de la ligne (`baremes_intervention.version`) ; `null` si inconnu. */
  version: number | null;
  familleRevetement: string;
  etatDepart: string;
  typeIntervention: string;
  /** Cout au kilometre en GNF, chaine de chiffres. */
  coutKmGnf: string;
  uniteCout: string;
  devise: string;
  anneeReference: number | null;
  /** Date ISO d'approbation, `null` = non approuvee (PROVISOIRE). */
  approuveLe: string | null;
  /** Debut de validite AAAA-MM-JJ, `null` = sans borne. */
  validDe: string | null;
  /** Fin de validite AAAA-MM-JJ, `null` = sans borne. */
  validA: string | null;
}

export interface VersionBaremes {
  /** SHA-256 hexadecimal de la liste canonique ci-dessous. */
  empreinte: string;
  liste: BaremeRef[];
}

export interface PeriodeSimulation { debut: string; fin: string }

const cleId = (b: { id: number | string }) => String(b.id);

/** Liste normalisee : triee par identifiant (comparaison de chaines), de sorte que l'ordre de lecture n'ait pas d'effet. */
export function normaliserListe(liste: readonly BaremeRef[]): BaremeRef[] {
  return [...liste].sort((a, b) => (cleId(a) < cleId(b) ? -1 : cleId(a) > cleId(b) ? 1 : 0));
}

export function versionBaremes(liste: readonly BaremeRef[]): VersionBaremes {
  const l = normaliserListe(liste);
  return { empreinte: sha256Hex(canonique(l)), liste: l };
}

const dateIso = (d: Date | string | null | undefined): string | null => (d === null || d === undefined ? null : d instanceof Date ? d.toISOString() : d);

/** Reference d'une ligne de calcul, completee de ce que `LigneBareme` ne porte pas (version, fenetre). */
export function refDe(b: LigneBareme, meta: { version: number | null; validDe: string | null; validA: string | null }): BaremeRef {
  return {
    id: b.id, code: b.code ?? null, version: meta.version, familleRevetement: b.familleRevetement, etatDepart: b.etatDepart,
    typeIntervention: b.typeIntervention, coutKmGnf: b.coutKmGnf.toString(), uniteCout: b.uniteCout, devise: b.devise,
    anneeReference: b.anneeReference ?? null, approuveLe: dateIso(b.approuveLe), validDe: meta.validDe, validA: meta.validA,
  };
}

/**
 * Controle de coherence entre les lignes de calcul et la version enregistree : meme ensemble d'identifiants,
 * memes couts, meme type, et empreinte egale a celle de la liste. Rend les erreurs (vide = coherent).
 */
export function verifierVersionBaremes(baremes: readonly LigneBareme[], v: VersionBaremes): string[] {
  const err: string[] = [];
  if (!v || !Array.isArray(v.liste) || typeof v.empreinte !== "string") return ["baremes : version des barèmes absente ou illisible"];
  const parId = new Map(v.liste.map((r) => [cleId(r), r] as const));
  if (parId.size !== v.liste.length) err.push("baremes : identifiant de barème en double dans la version");
  for (const b of baremes) {
    const r = parId.get(cleId(b));
    if (!r) { err.push(`baremes : la ligne ${cleId(b)} sert au calcul mais n'est pas dans la version enregistrée`); continue; }
    if (r.coutKmGnf !== b.coutKmGnf.toString() || r.typeIntervention !== b.typeIntervention || r.familleRevetement !== b.familleRevetement || r.etatDepart !== b.etatDepart) {
      err.push(`baremes : la ligne ${cleId(b)} ne correspond pas à sa version enregistrée`);
    }
  }
  let recalculee: string;
  try { recalculee = sha256Hex(canonique(normaliserListe(v.liste))); } catch { return [...err, "baremes : version des barèmes non canonique"]; }
  if (recalculee !== v.empreinte) err.push("baremes : l'empreinte de la version ne correspond pas à la liste enregistrée");
  return err;
}

const VALIDE_JOUR = /^\d{4}-\d{2}-\d{2}$/;

/** Vrai pour une date calendaire reelle AAAA-MM-JJ (le 31 fevrier est refuse). */
export function jourValide(s: unknown): s is string {
  if (typeof s !== "string" || !VALIDE_JOUR.test(s)) return false;
  const [a, m, j] = s.split("-").map(Number);
  const d = new Date(Date.UTC(a, m - 1, j));
  return d.getUTCFullYear() === a && d.getUTCMonth() === m - 1 && d.getUTCDate() === j;
}

/**
 * Cout perime ? `null` si la fenetre couvre toute la periode (ou n'existe pas), sinon la phrase qui le dit.
 * Une borne absente ne perime pas : on ne devine pas de date.
 */
export function motifPeremption(ref: Pick<BaremeRef, "id" | "validDe" | "validA">, periode: PeriodeSimulation): string | null {
  const avant = ref.validDe !== null && ref.validDe > periode.debut;
  const apres = ref.validA !== null && ref.validA < periode.fin;
  if (!avant && !apres) return null;
  return `la fenêtre de validité du barème ${String(ref.id)} [${ref.validDe ?? "sans début"} ; ${ref.validA ?? "sans fin"}] ne couvre pas la période ${periode.debut} à ${periode.fin}`;
}
