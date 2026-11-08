/**
 * Qualification d'un segment de releve (revetement, etat de chaussee, praticabilite) et lien a une mission :
 * la mise en forme PURE, sans DOM ni reseau, pour que la regle se teste sans ecran.
 *
 * REGLES QUE CE MODULE TIENT
 *
 *   - Un code n'entre dans la qualification que s'il est une valeur ACTIVE du referentiel que le serveur a rendu
 *     (`GET /v2/referentiels`). Aucune valeur par defaut, aucune valeur inventee : un champ non choisi reste ABSENT.
 *   - La praticabilite n'est acceptee que si le serveur a defini ce vocabulaire (`praticabiliteNonDefinie` faux),
 *     comme `TerrainPortionsPage` le fait.
 *   - Sans referentiel charge, rien n'est retenu : on ne qualifie pas avec des codes que personne n'a verifies.
 *
 * Le serveur reste l'arbitre : il reverifie les codes (actifs) a la reception et refuse les portions d'un evenement
 * dont un code est inconnu (`CODE_REFERENTIEL_INCONNU`).
 */
import type { Qualification } from "../roulage/types";

export interface ValeurReferentiel { code: string; libelle: string; actif: boolean }

export interface ReferentielsQualification {
  revetements: ValeurReferentiel[];
  etats: ValeurReferentiel[];
  praticabilites: ValeurReferentiel[];
  praticabiliteNonDefinie: boolean;
}

/** Ce que l'agent a choisi dans les trois listes ; chaine vide = « non releve ». */
export interface SaisieQualification { revetement: string; etat: string; praticabilite: string }

export const SAISIE_VIDE: SaisieQualification = { revetement: "", etat: "", praticabilite: "" };

/** Les valeurs proposees a l'agent : les actives seulement, dans l'ordre rendu par le serveur. */
export const valeursActives = (valeurs: readonly ValeurReferentiel[] | undefined): ValeurReferentiel[] => (valeurs ?? []).filter((v) => v.actif);

const connu = (valeurs: readonly ValeurReferentiel[] | undefined, code: string): boolean => valeursActives(valeurs).some((v) => v.code === code);

/** Valide la forme d'une reponse `GET /v2/referentiels` : une reponse mal formee n'est pas un referentiel. */
export function lireReferentiels(brut: unknown): ReferentielsQualification | null {
  if (typeof brut !== "object" || brut === null) return null;
  const o = brut as Record<string, unknown>;
  const liste = (v: unknown): ValeurReferentiel[] | null => {
    if (!Array.isArray(v)) return null;
    const sortie: ValeurReferentiel[] = [];
    for (const e of v) {
      if (typeof e !== "object" || e === null) return null;
      const x = e as Record<string, unknown>;
      if (typeof x.code !== "string" || x.code.length === 0 || typeof x.libelle !== "string" || typeof x.actif !== "boolean") return null;
      sortie.push({ code: x.code, libelle: x.libelle, actif: x.actif });
    }
    return sortie;
  };
  const revetements = liste(o.revetements);
  const etats = liste(o.etats);
  const praticabilites = liste(o.praticabilites);
  if (!revetements || !etats || !praticabilites || typeof o.praticabiliteNonDefinie !== "boolean") return null;
  return { revetements, etats, praticabilites, praticabiliteNonDefinie: o.praticabiliteNonDefinie };
}

/**
 * La qualification a confier au noyau, ou `null` si l'agent n'a rien choisi (ou rien de verifiable).
 * Seuls les champs choisis ET connus du referentiel figurent dans le resultat.
 */
export function construireQualification(saisie: SaisieQualification, refs: ReferentielsQualification | null): Qualification | null {
  if (!refs) return null;
  const q: Qualification = {};
  if (saisie.revetement && connu(refs.revetements, saisie.revetement)) q.revetement = saisie.revetement;
  if (saisie.etat && connu(refs.etats, saisie.etat)) q.etat = saisie.etat;
  if (saisie.praticabilite && !refs.praticabiliteNonDefinie && connu(refs.praticabilites, saisie.praticabilite)) q.praticabilite = saisie.praticabilite;
  return Object.keys(q).length > 0 ? q : null;
}

/** Les listes de l'ecran a partir d'une qualification deja posee (reprise d'une session interrompue). */
export function saisieDepuisQualification(q: Qualification | null | undefined): SaisieQualification {
  return { revetement: q?.revetement ?? "", etat: q?.etat ?? "", praticabilite: q?.praticabilite ?? "" };
}

/** Deux qualifications disent-elles la meme chose ? (champ absent et `null` valent la meme absence) */
export function memeQualification(a: Qualification | null | undefined, b: Qualification | null | undefined): boolean {
  return (["revetement", "etat", "praticabilite"] as const).every((c) => (a?.[c] ?? null) === (b?.[c] ?? null));
}

/** « Bitume, mauvais etat » : les libelles du referentiel, jamais les codes bruts quand le libelle est connu. */
export function libelleQualification(q: Qualification | null | undefined, refs: ReferentielsQualification | null): string {
  if (!q) return "non qualifié";
  const lib = (valeurs: readonly ValeurReferentiel[] | undefined, code: string | null | undefined) =>
    code ? (valeurs ?? []).find((v) => v.code === code)?.libelle ?? code : null;
  const parts = [lib(refs?.revetements, q.revetement), lib(refs?.etats, q.etat), lib(refs?.praticabilites, q.praticabilite)].filter((x): x is string => x !== null);
  return parts.length > 0 ? parts.join(", ") : "non qualifié";
}

// ------------------------------------------------------------------ missions

export interface MissionListee {
  id: string;
  code: string;
  intitule: string;
  statut: string;
  assigneId: string | null;
  createurId: string;
}

/**
 * Les missions auxquelles une session peut etre rattachee.
 *
 * Le serveur refuse TOUTE la session (`MISSION_NON_AUTORISEE`, refus definitif) quand la mission n'est ni assignee a
 * l'agent ni creee par lui. Or `GET /v2/missions` rend TOUTES les missions a un ADMIN ou un GESTIONNAIRE : sans ce
 * filtre, ces comptes verraient dans la liste des missions qui feraient rejeter leur releve entier. Une mission
 * annulee n'est pas proposee non plus.
 */
export function missionsRattachables(brut: unknown, userId: string): MissionListee[] {
  if (!Array.isArray(brut)) return [];
  const sortie: MissionListee[] = [];
  for (const e of brut) {
    if (typeof e !== "object" || e === null) continue;
    const m = e as Record<string, unknown>;
    if (typeof m.id !== "string" || typeof m.code !== "string" || typeof m.intitule !== "string" || typeof m.statut !== "string" || typeof m.createurId !== "string") continue;
    const assigneId = typeof m.assigneId === "string" ? m.assigneId : null;
    if (m.statut === "ANNULEE") continue;
    if (assigneId !== userId && m.createurId !== userId) continue;
    sortie.push({ id: m.id, code: m.code, intitule: m.intitule, statut: m.statut, assigneId, createurId: m.createurId });
  }
  return sortie;
}

export const libelleMission = (m: MissionListee): string => `${m.code} : ${m.intitule} (${m.statut.toLowerCase().replaceAll("_", " ")})`;
