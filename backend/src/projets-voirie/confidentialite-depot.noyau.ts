/**
 * NIVEAU DE CONFIDENTIALITE D'UN JEU DEPOSE (noyau pur ; revue du lot X1, M1, decision de l'architecte du 10/11/2026 ; CONTRAT-IMPORT.md et
 * CONTRAT-EXPORTS.md).
 *
 * Le niveau garde l'export du dossier technique : il ne doit pas pouvoir etre abaisse par un simple redepot. REGLES :
 *   - une nouvelle version HERITE du niveau le plus restrictif de sa lignee (toutes les versions de meme cle : projet, role, concessionnaire, methode) ;
 *   - un reseau de concessionnaire (RESEAU_TIERS) ne descend jamais, par defaut, sous CONFIDENTIEL_CONCESSIONNAIRE ;
 *   - demander un niveau PLUS BAS que ce plancher est reserve a l'ADMIN, avec une justification (10 caracteres au moins), auditee : 403
 *     CONFIDENTIALITE_ABAISSEMENT_RESERVE pour tout autre compte, 400 JUSTIFICATION_INVALIDE pour un ADMIN sans justification ;
 *   - un niveau plus restrictif que le plancher est toujours admis ; sans niveau demande : le plus restrictif du defaut du role et de la lignee.
 * Un niveau inconnu (valeur future de l'enumeration) compte comme le plus restrictif (echec ferme).
 */

export const NIVEAUX_CONFIDENTIALITE = ["PUBLIC", "INTERNE", "RESTREINT_PROJET", "CONFIDENTIEL_CONCESSIONNAIRE", "INFRASTRUCTURE_SENSIBLE"] as const;
export type NiveauConfidentialite = (typeof NIVEAUX_CONFIDENTIALITE)[number];

export const JUSTIFICATION_ABAISSEMENT_MIN = 10;

/** Rang d'un niveau (0 = le moins restrictif) ; inconnu : le plus restrictif. */
export function rangNiveau(n: string): number {
  const i = (NIVEAUX_CONFIDENTIALITE as readonly string[]).indexOf(n);
  return i < 0 ? NIVEAUX_CONFIDENTIALITE.length : i;
}

/** Le plus restrictif d'une liste (nul si vide). */
export function plusRestrictif(niveaux: readonly string[]): string | null {
  let m: string | null = null;
  for (const n of niveaux) if (m === null || rangNiveau(n) > rangNiveau(m)) m = n;
  return m;
}

export const defautDuRole = (role: string): NiveauConfidentialite => (role === "RESEAU_TIERS" ? "CONFIDENTIEL_CONCESSIONNAIRE" : "RESTREINT_PROJET");

export type VerdictNiveau =
  | { ok: true; niveau: string; plancher: string | null; herite: boolean; abaissement: { de: string; vers: string; justification: string } | null }
  | { ok: false; status: number; code: string; message: string; extra: Record<string, unknown> };

export function niveauDuDepot(e: { role: string; demande?: string; niveauxLignee: readonly string[]; roleActeur: string; justification?: string }): VerdictNiveau {
  const lignee = plusRestrictif(e.niveauxLignee);
  // Plancher : la lignee, et pour un reseau de concessionnaire le defaut du role.
  const plancher = plusRestrictif([...(lignee ? [lignee] : []), ...(e.role === "RESEAU_TIERS" ? [defautDuRole(e.role)] : [])]);
  if (e.demande === undefined) {
    const niveau = plusRestrictif([defautDuRole(e.role), ...(plancher ? [plancher] : [])])!;
    return { ok: true, niveau, plancher, herite: lignee !== null && rangNiveau(lignee) > rangNiveau(defautDuRole(e.role)), abaissement: null };
  }
  if (plancher === null || rangNiveau(e.demande) >= rangNiveau(plancher)) return { ok: true, niveau: e.demande, plancher, herite: false, abaissement: null };
  if (e.roleActeur !== "ADMIN") {
    return {
      ok: false, status: 403, code: "CONFIDENTIALITE_ABAISSEMENT_RESERVE",
      message: `Le niveau ${e.demande} est moins restrictif que celui de la lignée du jeu ou du rôle (${plancher}) : seul un administrateur peut l'abaisser, avec une justification.`,
      extra: { plancher, demande: e.demande },
    };
  }
  const j = (e.justification ?? "").trim();
  if (j.length < JUSTIFICATION_ABAISSEMENT_MIN) {
    return {
      ok: false, status: 400, code: "JUSTIFICATION_INVALIDE",
      message: `Abaisser le niveau de confidentialité (de ${plancher} à ${e.demande}) exige une justification de ${JUSTIFICATION_ABAISSEMENT_MIN} caractères au moins (champ justificationConfidentialite).`,
      extra: { plancher, demande: e.demande },
    };
  }
  return { ok: true, niveau: e.demande, plancher, herite: false, abaissement: { de: plancher, vers: e.demande, justification: j } };
}
