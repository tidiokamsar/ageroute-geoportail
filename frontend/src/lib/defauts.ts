/**
 * Règles des défauts côté écran : cycle de vie physique et préparation d'une resoumission.
 *
 * La table des transitions est la copie de `TRANSITIONS_ETAT` (backend/src/field/defauts.regles.ts) ;
 * un test la relit dans son fichier pour qu'elles ne divergent pas. Le serveur reste juge : l'écran
 * ne propose que ce que le serveur accepterait.
 */

export type EtatDefaut = "ACTIF" | "TRAITE" | "DISPARU";
export type StatutDefaut = "A_VALIDER" | "VALIDE" | "REJETE" | "A_CORRIGER";

export const TRANSITIONS_ETAT: Record<EtatDefaut, readonly EtatDefaut[]> = {
  ACTIF: ["TRAITE", "DISPARU"],
  TRAITE: ["ACTIF"],
  DISPARU: ["ACTIF"],
};

export const LIBELLE_ETAT: Record<EtatDefaut, string> = { ACTIF: "Actif", TRAITE: "Traité", DISPARU: "Disparu" };
export const LIBELLE_STATUT_DEFAUT: Record<StatutDefaut, string> = {
  A_VALIDER: "À valider", VALIDE: "Validé", REJETE: "Rejeté", A_CORRIGER: "À corriger",
};
/** Libellé du geste, pas de l'état d'arrivée : « Remettre actif » dit ce qui se passe. */
export const GESTE_ETAT: Record<EtatDefaut, string> = { ACTIF: "Remettre actif", TRAITE: "Marquer traité", DISPARU: "Marquer disparu" };

export function transitionsEtat(etat: string | null | undefined): readonly EtatDefaut[] {
  return (etat && TRANSITIONS_ETAT[etat as EtatDefaut]) || [];
}

export const MESURES = [
  { cle: "nombre", code: "NOMBRE", libelle: "Nombre", entier: true },
  { cle: "longueurM", code: "LONGUEUR", libelle: "Longueur (m)", entier: false },
  { cle: "largeurM", code: "LARGEUR", libelle: "Largeur (m)", entier: false },
  { cle: "profondeurM", code: "PROFONDEUR", libelle: "Profondeur (m)", entier: false },
  { cle: "quantiteSaisie", code: "QUANTITE", libelle: "Quantité", entier: false },
] as const;
export type CleMesure = (typeof MESURES)[number]["cle"];

export interface SaisieResoumission {
  mesures: Record<CleMesure, string>;
  gravite: string;
  etendue: string;
  commentaire: string;
}

/**
 * Corps d'une resoumission, ou la liste des fautes. Une mesure vide n'est pas envoyée (le serveur
 * garde la valeur relevée) ; une mesure requise par le type ne peut pas rester vide. Aucun zéro
 * implicite : « 0 » est refusé comme le serveur le refuse (mesures strictement positives).
 */
export function corpsResoumission(s: SaisieResoumission, requises: readonly string[], graviteMax: number | null):
  { corps: Record<string, unknown>; erreurs: string[] } {
  const erreurs: string[] = [];
  const mesures: Record<string, number> = {};
  for (const m of MESURES) {
    const brut = s.mesures[m.cle].trim().replace(",", ".");
    if (brut === "") {
      if (requises.includes(m.code)) erreurs.push(`${m.libelle} : requise pour ce type.`);
      continue;
    }
    const v = Number(brut);
    if (!Number.isFinite(v) || v <= 0 || (m.entier && !Number.isInteger(v))) {
      erreurs.push(`${m.libelle} : ${m.entier ? "entier " : ""}strictement positif attendu.`);
      continue;
    }
    mesures[m.cle] = v;
  }
  const corps: Record<string, unknown> = { mesures };
  if (s.gravite.trim() !== "") {
    const g = Number(s.gravite);
    if (!Number.isInteger(g) || g < 1 || (graviteMax !== null && g > graviteMax)) erreurs.push(`Gravité : entier de 1 à ${graviteMax ?? "…"}.`);
    else corps.gravite = g;
  }
  if (s.etendue) corps.etendue = s.etendue;
  if (s.commentaire.trim()) corps.commentaire = s.commentaire.trim();
  return { corps, erreurs };
}
