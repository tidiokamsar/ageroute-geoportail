/**
 * Noyau de la correspondance d'identifiants (A23, BDR_ID_CROSSWALK_SPEC.md) : regles pures, sans base.
 *
 * LES CINQ ETAPES DU § B.4 sont les cinq methodes, du plus sur au moins sur. Ce module n'en INFERE aucune :
 * il verifie qu'une correspondance proposee est coherente avec la methode qu'elle declare. Il ne cherche, ne
 * devine ni ne suggere jamais une correspondance, et n'en connait aucune : aucun code de l'ONR, de L2R ni
 * d'ANASUR n'est connu du depot, donc aucune valeur n'est semee.
 *
 * JAMAIS un rapprochement sur le seul nom ou la seule proximite : aucune methode ne le porte.
 *
 * Les memes regles sont tenues en base par des contraintes (migration 20261026410000) : celles-ci donnent un
 * message clair avant l'ecriture, celles-la empechent un acces direct de les contourner.
 */
import { createHash } from "node:crypto";

export const TYPES_OBJET = ["TRONCON", "PORTION", "OUVRAGE", "DEFAUT"] as const;
export type TypeObjet = (typeof TYPES_OBJET)[number];

export const METHODES = ["IDENTIFIANT_OFFICIEL", "CODE_ROUTE_NOMENCLATURE", "GEOMETRIE_CALCULEE", "CORROBORATION", "REVUE_HUMAINE"] as const;
export type Methode = (typeof METHODES)[number];

export type StatutCorrespondance = "A_CONFIRMER" | "CONFIRMEE";

export interface Proposition {
  systemeSource: string;
  typeObjet: string;
  identifiantSource: string;
  identifiantCible: string;
  methode: string;
  score: number;
  tolerancesM?: unknown;
  attributsCorroborants?: unknown;
  /** Obligatoire pour la methode REVUE_HUMAINE : la revue est elle-meme la decision. */
  decisionMotif?: string | null;
  valideDu: string;
  valideAu?: string | null;
}

export type Verdict = { ok: true } | { ok: false; code: string; motif: string; http: 400 | 403 | 404 | 409 };

const refus = (code: string, motif: string, http: 400 | 403 | 404 | 409 = 400): Verdict => ({ ok: false, code, motif, http });
const objetNonVide = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length > 0;
const dateIso = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

export function verifierProposition(p: Proposition): Verdict {
  if (!/^[A-Z0-9_]{2,40}$/.test(p.systemeSource)) {
    return refus("SYSTEME_INVALIDE", "Le systeme source s'ecrit en majuscules, chiffres et tiret bas (2 a 40 caracteres), par exemple le nom du systeme tel que l'AGEROUTE le designe.");
  }
  if (!(TYPES_OBJET as readonly string[]).includes(p.typeObjet)) {
    return refus("TYPE_INCONNU", `Type d'objet inconnu. Types pris en charge : ${TYPES_OBJET.join(", ")} (le type « route » n'a pas de cible : decision D-06).`);
  }
  if (typeof p.identifiantSource !== "string" || p.identifiantSource.trim() === "") return refus("SOURCE_VIDE", "L'identifiant source est vide : il se saisit tel qu'il a ete recu, sans retouche.");
  if (typeof p.identifiantCible !== "string" || p.identifiantCible.trim() === "") return refus("CIBLE_VIDE", "L'identifiant cible est vide.");
  if (!(METHODES as readonly string[]).includes(p.methode)) return refus("METHODE_INCONNUE", `Methode inconnue. Methodes : ${METHODES.join(", ")}.`);
  if (typeof p.score !== "number" || !Number.isFinite(p.score) || p.score < 0 || p.score > 1) return refus("SCORE_HORS_BORNES", "Le score est compris entre 0 et 1.");
  if (Math.abs(p.score * 1000 - Math.round(p.score * 1000)) > 1e-9) return refus("SCORE_PRECISION", "Le score s'exprime avec trois decimales au plus : arrondir serait choisir a la place de la personne qui l'a calcule.");
  const officiel = p.methode === "IDENTIFIANT_OFFICIEL";
  if (officiel && p.score !== 1) return refus("SCORE_OFFICIEL_ATTENDU", "Une correspondance par identifiant institutionnel officiel vaut 1.");
  if (!officiel && p.score === 1) return refus("SCORE_UN_RESERVE", "Le score 1 est reserve a l'identifiant institutionnel officiel : les autres methodes produisent un candidat, jamais une certitude.");
  if (p.methode === "GEOMETRIE_CALCULEE" && !objetNonVide(p.tolerancesM)) return refus("TOLERANCES_REQUISES", "Une correspondance geometrique porte les tolerances appliquees, pour etre reproductible.");
  if (p.methode === "CORROBORATION" && !objetNonVide(p.attributsCorroborants)) return refus("ATTRIBUTS_REQUIS", "Une correspondance par corroboration porte les valeurs comparees.");
  if (p.methode === "REVUE_HUMAINE" && (typeof p.decisionMotif !== "string" || p.decisionMotif.trim() === "")) return refus("MOTIF_REQUIS", "Une revue humaine est une decision : elle porte son motif.");
  if (!dateIso(p.valideDu)) return refus("DATE_INVALIDE", "valideDu est une date AAAA-MM-JJ.");
  if (p.valideAu != null && (!dateIso(p.valideAu) || p.valideAu <= p.valideDu)) return refus("PERIODE_VIDE", "valideAu est une date AAAA-MM-JJ strictement posterieure a valideDu (periode semi-ouverte).");
  return { ok: true };
}

export interface LigneEtat {
  statut: StatutCorrespondance;
  versionFermeture: number | null;
  proposeParId: string;
  methode: string;
}

export function verifierConfirmation(l: LigneEtat, reviseurId: string, motif: string | null | undefined): Verdict {
  if (l.versionFermeture !== null) return refus("CORRESPONDANCE_FERMEE", "Cette correspondance est fermee : elle ne se confirme plus (corrigez ou proposez-en une nouvelle).", 409);
  if (l.statut === "CONFIRMEE") return refus("DEJA_CONFIRMEE", "Cette correspondance est deja confirmee.", 409);
  if (l.proposeParId === reviseurId) return refus("AUTO_CONFIRMATION", "On ne confirme pas sa propre proposition : la confirmation est la decision d'une seconde personne.", 403);
  if (typeof motif !== "string" || motif.trim() === "") return refus("MOTIF_REQUIS", "La confirmation porte son motif.");
  return { ok: true };
}

export interface LigneExport {
  systemeSource: string;
  typeObjet: string;
  identifiantSource: string;
  identifiantCible: string;
  methode: string;
  /** Texte tel que la base le rend (trois decimales) : aucune conversion numerique, donc aucun arrondi. */
  score: string;
  statut: string;
  valideDu: string;
  valideAu: string | null;
  versionOuverture: number;
}

const COLONNES = ["systeme_source", "type_objet", "identifiant_source", "identifiant_cible", "methode", "score", "statut", "valide_du", "valide_au", "version_ouverture"] as const;

const champ = (v: string | number | null): string => {
  const t = v === null ? "" : String(v);
  return /[;"\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/**
 * Export CSV de la table EN VIGUEUR a la version `version`. Deterministe : meme version, memes octets.
 * Ce n'est PAS un format de l'ONR (aucun n'est connu) : c'est la table de correspondance elle-meme, dans une forme
 * neutre, pour que l'on puisse prouver qu'elle se regenere a l'identique (critere B12).
 */
export function versCsv(lignes: readonly LigneExport[], version: number): { texte: string; empreinteSha256: string } {
  const tri = [...lignes].sort((a, b) =>
    a.systemeSource.localeCompare(b.systemeSource, "en") || a.typeObjet.localeCompare(b.typeObjet, "en")
    || (a.identifiantSource < b.identifiantSource ? -1 : a.identifiantSource > b.identifiantSource ? 1 : 0)
    || (a.valideDu < b.valideDu ? -1 : a.valideDu > b.valideDu ? 1 : 0));
  const corps = tri.map((l) =>
    [l.systemeSource, l.typeObjet, l.identifiantSource, l.identifiantCible, l.methode, l.score, l.statut, l.valideDu, l.valideAu, l.versionOuverture].map(champ).join(";"));
  const texte = [`# versionTable=${version}`, COLONNES.join(";"), ...corps].join("\n") + "\n";
  return { texte, empreinteSha256: createHash("sha256").update(texte, "utf8").digest("hex") };
}
