/**
 * STATUTS ET TRANSITIONS DES DOCUMENTS D'UN PROJET (noyau pur, lot D1 ; contrat : docs/projets-voirie/CONTRAT-DOCUMENTS.md, section 4).
 *
 * La MEME matrice est ecrite dans la base (fonction `documents_projet_voirie_transition_admise` de la migration 20261104100000) : un test compare les deux.
 * Le service decide avec ce noyau (refus types, messages), la base refuse ce qui lui parviendrait autrement (SQL direct, defaut du service).
 *
 * Ordre des controles d'un changement demande (stable, teste) :
 *   1. statut demande hors de ceux qu'une personne peut demander (ATTENDU, RECU, REMPLACE sont poses par le serveur) : 409 TRANSITION_INTERDITE ;
 *   2. transition hors matrice : 409 TRANSITION_INTERDITE (avec les transitions possibles) ;
 *   3. justification absente ou de moins de 10 caracteres pour INCOMPLET, A_CORRIGER, VALIDE, REJETE : 400 JUSTIFICATION_INVALIDE ;
 *   4. EXPLOITABLE ou VALIDE d'un DWG : 409 DOCUMENT_NON_EXPLOITABLE (aucun convertisseur) ;
 *   5. EXPLOITABLE ou VALIDE d'une piece liee a un jeu qui n'est pas AUTORISE : 409 JEU_NON_AUTORISE ;
 *   6. VALIDE par la personne qui a depose la piece : 409 SEPARATION_DES_TACHES (sans derogation dans ce lot).
 */

import { JUSTIFICATION_MIN } from "../conflits/types.noyau";

export const STATUTS_DOCUMENT = ["ATTENDU", "RECU", "EN_ANALYSE", "EXPLOITABLE", "INCOMPLET", "A_CORRIGER", "REMPLACE", "VALIDE", "REJETE"] as const;
export type StatutDocument = (typeof STATUTS_DOCUMENT)[number];
export const estStatutDocument = (v: unknown): v is StatutDocument => typeof v === "string" && (STATUTS_DOCUMENT as readonly string[]).includes(v);

/** Statuts d'une version EN COURS (une seule par lignee : index unique partiel de la base). */
export const STATUTS_EN_COURS: readonly StatutDocument[] = ["ATTENDU", "RECU", "EN_ANALYSE", "INCOMPLET", "A_CORRIGER", "EXPLOITABLE"];
/** Statuts qu'une personne peut demander par la route `statut`. */
export const STATUTS_DEMANDABLES = ["EN_ANALYSE", "EXPLOITABLE", "INCOMPLET", "A_CORRIGER", "VALIDE", "REJETE"] as const;
export type StatutDemandable = (typeof STATUTS_DEMANDABLES)[number];
/** Statuts qui exigent une justification (10 caracteres au moins ; contrainte de la base). */
export const JUSTIFICATION_EXIGEE: readonly StatutDocument[] = ["INCOMPLET", "A_CORRIGER", "VALIDE", "REJETE"];

/** Matrice des transitions (de, vers). Identique a la fonction SQL `documents_projet_voirie_transition_admise`. */
export const TRANSITIONS: readonly (readonly [StatutDocument, StatutDocument])[] = [
  ["ATTENDU", "RECU"],
  ["RECU", "EN_ANALYSE"], ["RECU", "REJETE"], ["RECU", "REMPLACE"],
  ["EN_ANALYSE", "EXPLOITABLE"], ["EN_ANALYSE", "INCOMPLET"], ["EN_ANALYSE", "A_CORRIGER"], ["EN_ANALYSE", "REJETE"], ["EN_ANALYSE", "REMPLACE"],
  ["INCOMPLET", "EN_ANALYSE"], ["INCOMPLET", "REJETE"], ["INCOMPLET", "REMPLACE"],
  ["A_CORRIGER", "EN_ANALYSE"], ["A_CORRIGER", "REJETE"], ["A_CORRIGER", "REMPLACE"],
  ["EXPLOITABLE", "VALIDE"], ["EXPLOITABLE", "A_CORRIGER"], ["EXPLOITABLE", "REJETE"], ["EXPLOITABLE", "REMPLACE"],
  ["VALIDE", "REMPLACE"],
];

export const transitionAdmise = (de: StatutDocument, vers: StatutDocument): boolean => TRANSITIONS.some(([a, b]) => a === de && b === vers);

/** Transitions qu'une personne peut demander depuis `de` (sans REMPLACE ni RECU, poses par le serveur). */
export function transitionsDemandables(de: StatutDocument): StatutDemandable[] {
  return STATUTS_DEMANDABLES.filter((v) => transitionAdmise(de, v));
}

export interface Refus { ok: false; status: number; code: string; message: string; extra?: Record<string, unknown> }
export type Verdict = { ok: true } | Refus;
const refus = (status: number, code: string, message: string, extra?: Record<string, unknown>): Refus => ({ ok: false, status, code, message, ...(extra ? { extra } : {}) });

/** Marche a suivre pour un DWG (aucun convertisseur proprietaire) : repris par la vue, l'avertissement de depot et le refus. */
export const AIDE_DWG = "Un DWG est un format proprietaire : aucun convertisseur n'est embarque et il n'est jamais exploitable. Exportez le dessin en DXF ASCII (Enregistrer sous, type DXF ; commande DXFOUT d'AutoCAD), en metres et dans un systeme de coordonnees connu, importez le DXF comme jeu de donnees du projet, puis deposez une nouvelle version de ce document liee au jeu importe.";
export const AIDE_PDF = "Un PDF est une piece de reference : il est conserve par sa reference et son empreinte, jamais importe comme geometrie. Pour l'exploiter sur la carte, numerisez le trace et importez-le comme jeu de donnees.";

/** Une piece peut-elle devenir EXPLOITABLE (puis VALIDE) ? */
export function exploitabilite(p: { format: string | null; jeuId: string | null; jeuStatut: string | null }): { possible: boolean; raison: string | null } {
  if (p.format === "DWG") return { possible: false, raison: "DWG_NON_EXPLOITABLE" };
  if (p.jeuId !== null && p.jeuStatut !== "AUTORISE") return { possible: false, raison: "JEU_NON_AUTORISE" };
  return { possible: true, raison: null };
}

export interface EntreeChangement {
  de: StatutDocument;
  vers: string;
  acteurId: string;
  deposeParId: string | null;
  justification: string | undefined;
  format: string | null;
  jeuId: string | null;
  /** Statut COURANT du jeu lie (nul sans jeu, ou jeu introuvable). */
  jeuStatut: string | null;
}

export function verifierChangement(e: EntreeChangement): Verdict {
  if (!(STATUTS_DEMANDABLES as readonly string[]).includes(e.vers)) {
    return refus(409, "TRANSITION_INTERDITE", `Le statut ${e.vers} n'est jamais demande : ATTENDU et RECU viennent de la creation et du depot, REMPLACE d'une nouvelle version.`, { de: e.de, vers: e.vers, possibles: transitionsDemandables(e.de) });
  }
  const vers = e.vers as StatutDemandable;
  if (!transitionAdmise(e.de, vers)) {
    return refus(409, "TRANSITION_INTERDITE", `Transition ${e.de} vers ${vers} interdite.`, { de: e.de, vers, possibles: transitionsDemandables(e.de) });
  }
  if (JUSTIFICATION_EXIGEE.includes(vers) && (e.justification ?? "").trim().length < JUSTIFICATION_MIN) {
    return refus(400, "JUSTIFICATION_INVALIDE", `Le statut ${vers} exige une justification de ${JUSTIFICATION_MIN} caracteres au moins.`);
  }
  if (vers === "EXPLOITABLE" || vers === "VALIDE") {
    const x = exploitabilite({ format: e.format, jeuId: e.jeuId, jeuStatut: e.jeuStatut });
    if (x.raison === "DWG_NON_EXPLOITABLE") return refus(409, "DOCUMENT_NON_EXPLOITABLE", AIDE_DWG, { aide: AIDE_DWG });
    if (x.raison === "JEU_NON_AUTORISE") return refus(409, "JEU_NON_AUTORISE", `Le jeu lie a cette piece n'est pas autorise (statut : ${e.jeuStatut ?? "introuvable"}) : autorisez-le d'abord.`, { jeuStatut: e.jeuStatut });
  }
  if (vers === "VALIDE" && e.deposeParId !== null && e.deposeParId === e.acteurId) {
    return refus(409, "SEPARATION_DES_TACHES", "La personne qui a depose la piece ne la valide pas : une autre personne habilitee doit le faire.");
  }
  return { ok: true };
}

/**
 * Effet d'une nouvelle version sur la DERNIERE version de la lignee :
 *   - en cours (RECU, EN_ANALYSE, INCOMPLET, A_CORRIGER, EXPLOITABLE) : REMPLACE tout de suite ;
 *   - VALIDE : reste VALIDE jusqu'a la validation de la nouvelle (le dossier garde une piece valide pendant l'examen) ;
 *   - REJETE : reste REJETE ;
 *   - ATTENDU : refus, la piece se depose (route `depot`) ; REMPLACE ne peut pas etre la derniere version.
 */
export function effetNouvelleVersion(derniere: StatutDocument): { ok: true; precedente: "REMPLACE" | "CONSERVE" } | Refus {
  if (derniere === "ATTENDU") return refus(409, "DOCUMENT_ATTENDU", "Ce document est encore attendu : deposez sa piece (POST .../depot) au lieu d'une nouvelle version.");
  if (derniere === "REMPLACE") return refus(409, "VERSION_NON_COURANTE", "Cette version est remplacee : deposez la nouvelle version sur la derniere version du document.");
  if (derniere === "VALIDE" || derniere === "REJETE") return { ok: true, precedente: "CONSERVE" };
  return { ok: true, precedente: "REMPLACE" };
}
