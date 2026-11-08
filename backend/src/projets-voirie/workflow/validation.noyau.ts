/**
 * VALIDATIONS PURES DU WORKFLOW (noyau, sans base ; contrat docs/projets-voirie/CONTRAT-WORKFLOW.md, sections 4 et 5).
 *
 * Chaque refus est une erreur TYPEE (statut HTTP et code stable) : le service la rend telle quelle.
 */

import { JUSTIFICATION_MIN } from "../conflits/types.noyau";

export interface Refus { ok: false; status: number; code: string; message: string }
export const refus = (status: number, code: string, message: string): Refus => ({ ok: false, status, code, message });
export type Verdict<T extends object = Record<string, never>> = ({ ok: true } & T) | Refus;

/** Caracteres de controle refuses dans un texte (les sauts de ligne et tabulations sont admis) : NUL compris. */
const CONTROLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
export const sansCaractereDeControle = (s: string): boolean => !CONTROLE.test(s);

/**
 * Une REFERENCE de piece est un TEXTE (numero de courrier, nom de plan, chemin d'archive externe) : l'application ne l'ouvre ni ne la suit
 * jamais. On refuse neanmoins les schemas executables ou locaux (`javascript:`, `data:`, `vbscript:`, `file:`), y compris camoufles par des
 * espaces ou des caracteres de controle (« java	script: »), pour qu'aucune interface ne puisse en faire un lien dangereux par megarde.
 */
const SCHEMAS_REFUSES = /^(?:javascript|data|vbscript|file):/i;
export function referenceAcceptable(ref: string): boolean {
  if (!sansCaractereDeControle(ref)) return false;
  const nu = ref.replace(/[\s\u0000-\u001f\u007f ​-‍﻿]/g, "");
  return !SCHEMAS_REFUSES.test(nu);
}

/** Empreinte SHA-256 en hexadecimal (64 caracteres), normalisee en minuscules ; `null` si ce n'en est pas une. */
export function normaliserSha256(s: string): string | null {
  const t = s.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(t) ? t : null;
}

const JOUR = /^(\d{4})-(\d{2})-(\d{2})$/;
/** `AAAA-MM-JJ` existant, entre 1900 et 2100. */
export function jourValide(s: string): boolean {
  const m = JOUR.exec(s);
  if (!m) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && d.getUTCFullYear() >= 1900 && d.getUTCFullYear() <= 2100;
}

/** Jour (AAAA-MM-JJ, UTC) d'un instant. */
export const jourDe = (d: Date): string => d.toISOString().slice(0, 10);

export const justificationSuffisante = (s: string | undefined | null): boolean => (s ?? "").trim().length >= JUSTIFICATION_MIN;

export function exigerJustification(s: string | undefined | null, libelle = "Une justification"): Refus | null {
  return justificationSuffisante(s) ? null : refus(422, "JUSTIFICATION_REQUISE", `${libelle} de ${JUSTIFICATION_MIN} caractères au moins est requise.`);
}

/** Date d'un evenement deja survenu (envoi, reception, recolement) : valide et pas dans le futur. */
export function exigerDatePassee(champ: string, jour: string, aujourdhui: string): Refus | null {
  if (!jourValide(jour)) return refus(422, "DATE_INVALIDE", `${champ} : date AAAA-MM-JJ valide attendue.`);
  if (jour > aujourdhui) return refus(422, "DATE_INVALIDE", `${champ} ne peut pas être dans le futur.`);
  return null;
}

/** Cadre d'un champ texte libre : sans caractere de controle, longueur bornee apres retrait des espaces de bord. */
export function texteBorne(champ: string, valeur: string, max: number, min = 1): Refus | null {
  const t = valeur.trim();
  if (!sansCaractereDeControle(valeur)) return refus(400, "CHAMPS_INVALIDES", `${champ} : caractères de contrôle interdits.`);
  if (t.length < min || t.length > max) return refus(400, "CHAMPS_INVALIDES", `${champ} : ${min} à ${max} caractères attendus.`);
  return null;
}

/** Champs modifies entre deux etats : `{ avant, apres }` ne portent que les cles qui changent. `null` s'il n'y en a aucune. */
export function diffChamps<T extends Record<string, unknown>>(avant: T, apres: Partial<T>): { avant: Record<string, unknown>; apres: Record<string, unknown> } | null {
  const a: Record<string, unknown> = {};
  const p: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(apres)) {
    if (v === undefined) continue;
    if ((avant[k] ?? null) === (v ?? null)) continue;
    a[k] = avant[k] ?? null;
    p[k] = v ?? null;
  }
  return Object.keys(p).length > 0 ? { avant: a, apres: p } : null;
}
