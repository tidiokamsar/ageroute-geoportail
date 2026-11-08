/**
 * DEMANDES DE DONNEES AUX CONCESSIONNAIRES : ETATS ET TRANSITIONS (noyau pur ; contrat docs/projets-voirie/CONTRAT-WORKFLOW.md, section 5.1).
 *
 *   BROUILLON -> ENVOYEE -> RECUE -> CLOTUREE ; ENVOYEE -> CLOTUREE (sans reponse) ; BROUILLON ou ENVOYEE -> ANNULEE.
 *
 * L'ENVOI SE FAIT HORS APPLICATION. Passer en ENVOYEE n'emet RIEN : c'est l'ENREGISTREMENT, par une personne identifiee, d'un envoi qu'elle a fait
 * par un autre canal (courriel, courrier, remise en main propre). Ce noyau n'a d'ailleurs aucune dependance reseau.
 */

import { refus, exigerDatePassee, exigerJustification, jourValide, texteBorne, type Refus } from "./validation.noyau";

export const STATUTS_DEMANDE = ["BROUILLON", "ENVOYEE", "RECUE", "CLOTUREE", "ANNULEE"] as const;
export type StatutDemande = (typeof STATUTS_DEMANDE)[number];
export const STATUTS_DEMANDE_TERMINAUX: readonly StatutDemande[] = ["CLOTUREE", "ANNULEE"];

export const TRANSITIONS_DEMANDE: readonly { de: StatutDemande; vers: StatutDemande }[] = [
  { de: "BROUILLON", vers: "ENVOYEE" },
  { de: "ENVOYEE", vers: "RECUE" },
  { de: "RECUE", vers: "CLOTUREE" },
  { de: "ENVOYEE", vers: "CLOTUREE" },
  { de: "BROUILLON", vers: "ANNULEE" },
  { de: "ENVOYEE", vers: "ANNULEE" },
];

export const transitionsDemandePossibles = (de: StatutDemande): StatutDemande[] => TRANSITIONS_DEMANDE.filter((t) => t.de === de).map((t) => t.vers);

export type CorpsStatutDemande =
  | { vers: "ENVOYEE"; canalEnvoi: string; dateEnvoi: string; referenceEnvoi?: string | null; interlocuteur?: string | null }
  | { vers: "RECUE"; dateReception: string; jeuRecuId?: string | null; note?: string | null }
  | { vers: "CLOTUREE" | "ANNULEE"; justification: string };

/** Champs a ecrire pour la transition (les dates de jour sont des chaines AAAA-MM-JJ). */
export type EffetTransitionDemande =
  | { vers: "ENVOYEE"; canalEnvoi: string; dateEnvoi: string; referenceEnvoi: string | null; interlocuteur: string | null }
  | { vers: "RECUE"; dateReception: string; jeuRecuId: string | null; note: string | null }
  | { vers: "CLOTUREE" | "ANNULEE"; motifFin: string };

export interface EntreeTransitionDemande {
  de: StatutDemande;
  corps: CorpsStatutDemande;
  /** Jour courant (AAAA-MM-JJ, UTC). */
  aujourdhui: string;
  /** Date d'envoi deja enregistree (AAAA-MM-JJ), pour controler que la reception ne la precede pas. */
  dateEnvoiEnregistree: string | null;
}

/**
 * Ordre des controles (stable, teste) :
 *   1. la transition existe (409 TRANSITION_INTERDITE ; un etat terminal : 409 STATUT_INCOMPATIBLE) ;
 *   2. champs propres a la transition : envoi (canal, date passee), reception (date passee, pas avant l'envoi), motif de 10 caracteres pour
 *      CLOTUREE et ANNULEE.
 */
export function evaluerTransitionDemande(e: EntreeTransitionDemande): { ok: true; effet: EffetTransitionDemande } | Refus {
  if (STATUTS_DEMANDE_TERMINAUX.includes(e.de)) return refus(409, "STATUT_INCOMPATIBLE", `Cette demande est ${e.de === "CLOTUREE" ? "close" : "annulée"} : elle ne change plus.`);
  if (!TRANSITIONS_DEMANDE.some((t) => t.de === e.de && t.vers === e.corps.vers)) {
    return refus(409, "TRANSITION_INTERDITE", `La transition ${e.de} vers ${e.corps.vers} n'existe pas.`);
  }
  const c = e.corps;
  if (c.vers === "ENVOYEE") {
    const canal = texteBorne("canalEnvoi", c.canalEnvoi, 100);
    if (canal) return canal;
    const date = exigerDatePassee("dateEnvoi", c.dateEnvoi, e.aujourdhui);
    if (date) return date;
    for (const [champ, v, max] of [["referenceEnvoi", c.referenceEnvoi, 200], ["interlocuteur", c.interlocuteur, 200]] as const) {
      if (v) { const r = texteBorne(champ, v, max); if (r) return r; }
    }
    return {
      ok: true,
      effet: { vers: "ENVOYEE", canalEnvoi: c.canalEnvoi.trim(), dateEnvoi: c.dateEnvoi, referenceEnvoi: c.referenceEnvoi?.trim() || null, interlocuteur: c.interlocuteur?.trim() || null },
    };
  }
  if (c.vers === "RECUE") {
    const date = exigerDatePassee("dateReception", c.dateReception, e.aujourdhui);
    if (date) return date;
    if (e.dateEnvoiEnregistree && c.dateReception < e.dateEnvoiEnregistree) {
      return refus(422, "DATE_INVALIDE", "dateReception ne peut pas précéder la date d'envoi enregistrée.");
    }
    if (c.note) { const r = texteBorne("note", c.note, 2000); if (r) return r; }
    return { ok: true, effet: { vers: "RECUE", dateReception: c.dateReception, jeuRecuId: c.jeuRecuId ?? null, note: c.note?.trim() || null } };
  }
  const j = exigerJustification(c.justification, "Un motif");
  if (j) return j;
  return { ok: true, effet: { vers: c.vers, motifFin: c.justification.trim() } };
}

export interface EntreeModificationDemande {
  statut: StatutDemande;
  champs: { objet?: string; description?: string | null; echeance?: string | null; jeuRecuId?: string | null; justification?: string };
}

/**
 * Ce qui se modifie selon l'etat : BROUILLON : objet, description, echeance ; ENVOYEE : echeance seule, avec justification (une extension de
 * delai se justifie) ; RECUE : jeuRecuId seul (lier le jeu recu) ; un etat terminal : rien. Un champ hors de ce qui est permis : 409.
 */
export function evaluerModificationDemande(e: EntreeModificationDemande): { ok: true } | Refus {
  const { champs } = e;
  const touches = (["objet", "description", "echeance", "jeuRecuId"] as const).filter((k) => champs[k] !== undefined);
  if (touches.length === 0) return refus(400, "CHAMPS_INVALIDES", "Au moins un champ à modifier.");
  if (STATUTS_DEMANDE_TERMINAUX.includes(e.statut)) return refus(409, "STATUT_INCOMPATIBLE", "Cette demande est terminée : elle ne change plus.");
  const permis: Record<string, readonly string[]> = { BROUILLON: ["objet", "description", "echeance"], ENVOYEE: ["echeance"], RECUE: ["jeuRecuId"] };
  const interdit = touches.find((k) => !permis[e.statut].includes(k));
  if (interdit) return refus(409, "STATUT_INCOMPATIBLE", `Le champ ${interdit} ne se modifie pas pour une demande ${e.statut}.`);
  if (e.statut === "ENVOYEE") { const j = exigerJustification(champs.justification); if (j) return j; }
  if (champs.echeance && !jourValide(champs.echeance)) return refus(422, "DATE_INVALIDE", "echeance : date AAAA-MM-JJ valide attendue.");
  if (champs.objet !== undefined) { const r = texteBorne("objet", champs.objet, 200); if (r) return r; }
  if (champs.description) { const r = texteBorne("description", champs.description, 4000); if (r) return r; }
  return { ok: true };
}
