/**
 * PREUVES REFERENCEES : DROIT D'AJOUT, TYPES PERMIS ET VALIDATION DES CHAMPS (noyau pur ; contrat docs/projets-voirie/CONTRAT-WORKFLOW.md, 5.4).
 *
 * Une preuve est une REFERENCE (texte, nom, empreinte SHA-256) : le stockage de pieces jointes n'est pas decide, aucun fichier n'est stocke.
 * Elle s'ajoute, ne se modifie ni ne se supprime. Le droit d'en ajouter depend du profil ET de l'objet.
 */

import { estDecideurProfil, type ProfilEffectif } from "./profils.noyau";
import { normaliserSha256, referenceAcceptable, refus, texteBorne, type Refus } from "./validation.noyau";

export const TYPES_PREUVE_WORKFLOW = ["NOTE", "REFERENCE_DOCUMENT", "COURRIER", "REPONSE_CONCESSIONNAIRE", "PLAN_RECOLEMENT", "RELEVE_TERRAIN"] as const;
export type TypePreuveWorkflow = (typeof TYPES_PREUVE_WORKFLOW)[number];
export const TYPES_OBJET = ["DEMANDE", "TACHE", "RECOLEMENT"] as const;
export type TypeObjet = (typeof TYPES_OBJET)[number];

/** Types qu'un profil non decideur peut ajouter. */
export const TYPES_PERMIS: Readonly<Partial<Record<ProfilEffectif, readonly TypePreuveWorkflow[]>>> = {
  INSPECTEUR: ["NOTE", "REFERENCE_DOCUMENT", "RELEVE_TERRAIN"],
  REFERENT: ["NOTE", "REFERENCE_DOCUMENT", "REPONSE_CONCESSIONNAIRE", "PLAN_RECOLEMENT"],
};

/** Etats dans lesquels un REFERENT ajoute une preuve a un objet (jamais a un objet terminal, jamais a un brouillon qu'il ne voit pas). */
const ETATS_REFERENT: Readonly<Record<TypeObjet, readonly string[]>> = {
  DEMANDE: ["ENVOYEE", "RECUE"],
  TACHE: ["A_FAIRE", "EN_COURS", "A_VALIDER"],
  RECOLEMENT: ["SOUMIS", "REJETE"],
};
const ETATS_TERMINAUX: Readonly<Record<TypeObjet, readonly string[]>> = {
  DEMANDE: ["CLOTUREE", "ANNULEE"],
  TACHE: ["TERMINEE", "ANNULEE"],
  RECOLEMENT: ["VALIDE"],
};

export interface CibleProuve { type: TypeObjet; statut: string; responsableId?: string | null }

export interface EntreeAjoutPreuve {
  profil: ProfilEffectif;
  peutAjouter: boolean;
  acteurId: string;
  cible: CibleProuve;
  typePreuve: TypePreuveWorkflow;
  partageeDemandee: boolean | undefined;
}

/**
 * Ordre des controles (stable, teste) :
 *   1. droit `preuve.ajouter` (403 ACTION_NON_AUTORISEE) ;
 *   2. objet terminal (409 STATUT_INCOMPATIBLE) ; referent : etat de l'objet (409 STATUT_INCOMPATIBLE) ;
 *   3. type de preuve permis au profil (403 ACTION_NON_AUTORISEE) ;
 *   4. inspecteur : seulement une TACHE dont il est le responsable (403 ACTION_NON_AUTORISEE).
 * `partagee` : un decideur choisit (defaut faux : note interne) ; un referent partage toujours ; un inspecteur ne partage jamais.
 */
export function evaluerAjoutPreuve(e: EntreeAjoutPreuve): { ok: true; partagee: boolean } | Refus {
  if (!e.peutAjouter) return refus(403, "ACTION_NON_AUTORISEE", "Votre profil ne permet pas d'ajouter une preuve.");
  if (ETATS_TERMINAUX[e.cible.type].includes(e.cible.statut)) {
    return refus(409, "STATUT_INCOMPATIBLE", "Cet élément est terminé : on n'y ajoute plus de preuve.");
  }
  if (e.profil === "REFERENT" && !ETATS_REFERENT[e.cible.type].includes(e.cible.statut)) {
    return refus(409, "STATUT_INCOMPATIBLE", "Cet élément n'accepte plus de pièce du concessionnaire dans son état actuel.");
  }
  const permis = TYPES_PERMIS[e.profil];
  if (permis && !permis.includes(e.typePreuve)) return refus(403, "ACTION_NON_AUTORISEE", `Votre profil n'ajoute pas de preuve de type ${e.typePreuve}.`);
  if (e.profil === "INSPECTEUR" && !(e.cible.type === "TACHE" && e.cible.responsableId === e.acteurId)) {
    return refus(403, "ACTION_NON_AUTORISEE", "Un agent de terrain n'ajoute des preuves qu'aux tâches dont il est le responsable.");
  }
  return { ok: true, partagee: estDecideurProfil(e.profil) ? e.partageeDemandee === true : e.profil === "REFERENT" };
}

export interface ChampsPreuve { texte: string; reference?: string | null; nomFichier?: string | null; sha256?: string | null; tailleOctets?: number | null }

/** Validation et normalisation des champs : texte 1 a 4000, reference 500 (sans schema executable), nom 255, SHA-256 en minuscules, taille entiere. */
export function validerChampsPreuve(c: ChampsPreuve): { ok: true; valeurs: { texte: string; reference: string | null; nomFichier: string | null; sha256: string | null; tailleOctets: number | null } } | Refus {
  const t = texteBorne("texte", c.texte, 4000);
  if (t) return t;
  let reference: string | null = null;
  if (c.reference !== undefined && c.reference !== null && c.reference.trim() !== "") {
    const r = texteBorne("reference", c.reference, 500);
    if (r) return r;
    if (!referenceAcceptable(c.reference)) return refus(400, "REFERENCE_INVALIDE", "La référence ne peut pas commencer par javascript:, data:, vbscript: ou file: : c'est un texte (numéro, nom, emplacement d'archive), jamais un lien exécutable.");
    reference = c.reference.trim();
  }
  let nomFichier: string | null = null;
  if (c.nomFichier !== undefined && c.nomFichier !== null && c.nomFichier.trim() !== "") {
    const n = texteBorne("nomFichier", c.nomFichier, 255);
    if (n) return n;
    nomFichier = c.nomFichier.trim();
  }
  let sha256: string | null = null;
  if (c.sha256 !== undefined && c.sha256 !== null && c.sha256.trim() !== "") {
    sha256 = normaliserSha256(c.sha256);
    if (sha256 === null) return refus(400, "CHAMPS_INVALIDES", "sha256 : empreinte SHA-256 en hexadécimal (64 caractères) attendue.");
  }
  let tailleOctets: number | null = null;
  if (c.tailleOctets !== undefined && c.tailleOctets !== null) {
    if (!Number.isInteger(c.tailleOctets) || c.tailleOctets < 0 || c.tailleOctets > 2_147_483_647) return refus(400, "CHAMPS_INVALIDES", "tailleOctets : entier de 0 à 2 147 483 647.");
    tailleOctets = c.tailleOctets;
  }
  return { ok: true, valeurs: { texte: c.texte.trim(), reference, nomFichier, sha256, tailleOctets } };
}
