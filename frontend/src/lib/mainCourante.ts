/**
 * Règles de la main courante telles que l'écran les montre (paragraphe 7.17, EX-01).
 *
 * Le serveur reste juge (`backend/src/exploitation/main-courante.noyau.ts`) : ces règles servent à ne
 * PROPOSER que les gestes permis. Un geste refusé par le serveur est affiché avec son message, jamais
 * masqué. `mainCourante.test.ts` confronte cette table à celle du serveur, fichier à fichier.
 */

export type StatutEvenement = "OUVERT" | "PRIS_EN_COMPTE" | "EN_COURS" | "CLOS";
export type NatureEntree = "DECLARATION" | "STATUT" | "COMPLEMENT" | "RECTIFICATION";

export const STATUTS: readonly StatutEvenement[] = ["OUVERT", "PRIS_EN_COMPTE", "EN_COURS", "CLOS"];

/** Mêmes transitions que le serveur : rien ne recule, CLOS est terminal. */
export const TRANSITIONS: Record<StatutEvenement, readonly StatutEvenement[]> = {
  OUVERT: ["PRIS_EN_COMPTE", "CLOS"],
  PRIS_EN_COMPTE: ["EN_COURS", "CLOS"],
  EN_COURS: ["CLOS"],
  CLOS: [],
};

export const LIBELLE_STATUT: Record<StatutEvenement, string> = {
  OUVERT: "Ouvert",
  PRIS_EN_COMPTE: "Pris en compte",
  EN_COURS: "En cours de traitement",
  CLOS: "Clos",
};

/** Le geste qui fait passer à ce statut, tel qu'un exploitant le dit. */
export const GESTE_VERS: Record<StatutEvenement, string> = {
  OUVERT: "Rouvrir",
  PRIS_EN_COMPTE: "Prendre en compte",
  EN_COURS: "Passer en traitement",
  CLOS: "Clore",
};

export const LIBELLE_NATURE: Record<NatureEntree, string> = {
  DECLARATION: "Déclaration",
  STATUT: "Changement de statut",
  COMPLEMENT: "Complément",
  RECTIFICATION: "Rectification",
};

export function transitionsDepuis(statut: StatutEvenement | null | undefined): readonly StatutEvenement[] {
  return statut ? TRANSITIONS[statut] : [];
}

/** « 2 h 05 », « 3 j 4 h », « 45 s » ; « — » pour une durée inconnue. Jamais d'arrondi à zéro trompeur. */
export function duree(secondes: number | null | undefined): string {
  if (secondes === null || secondes === undefined || !Number.isFinite(secondes)) return "—";
  const s = Math.max(0, Math.round(secondes));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${String(min % 60).padStart(2, "0")}`;
  return `${Math.floor(h / 24)} j ${h % 24} h`;
}

/** Une clé d'idempotence par envoi : un double clic ou une reprise ne crée pas deux entrées. */
export function cleOperation(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
