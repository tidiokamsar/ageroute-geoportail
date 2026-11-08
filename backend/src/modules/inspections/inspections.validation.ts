import { ROLES_VALIDATEURS, transitionPermise } from "../../governance/validation";

/**
 * Avis d'un responsable sur une inspection (BDRI, lot F), regle PURE : memes exigences que la validation du
 * patrimoine (role validateur, pas d'auto-validation, transitions, refus motive). Voir la route
 * `api-v2/inspections-validation.routes.ts`.
 */
export function jugerAvis(p: { statutActuel: string | null; inspecteurId: string; validateurId: string; validateurRole: string; decision: string; commentaire?: string | null }):
  { ok: true } | { ok: false; http: number; code: string; message: string } {
  if (!ROLES_VALIDATEURS.has(p.validateurRole)) return { ok: false, http: 403, code: "ROLE_INSUFFISANT", message: "Seul un responsable (administrateur ou gestionnaire) donne un avis." };
  if (p.inspecteurId === p.validateurId) return { ok: false, http: 403, code: "AUTO_VALIDATION", message: "Nul ne valide sa propre inspection." };
  // Une inspection anterieure au lot F n'a pas de statut : elle est jugee comme « a valider ».
  if (!transitionPermise(p.statutActuel ?? "A_VALIDER", p.decision)) return { ok: false, http: 409, code: "TRANSITION_INTERDITE", message: `Passage de ${p.statutActuel ?? "A_VALIDER"} à ${p.decision} non permis.` };
  if (p.decision !== "VALIDE" && !p.commentaire?.trim()) return { ok: false, http: 422, code: "COMMENTAIRE_REQUIS", message: "Un refus ou un renvoi en correction se motive." };
  return { ok: true };
}
