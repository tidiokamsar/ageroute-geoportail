import { describe, expect, it } from "vitest";
import { evaluerTransition, type EntreeTransition } from "./etats.noyau";

/**
 * Extension minimale de RC-3 au lot B3 : la cloture d'un dossier a deplacement de reseau decide peut s'appuyer sur un RECOLEMENT VALIDE
 * (`recolementValide`), au lieu de la seule mention `recolementAValider`. Rien ne change pour les appelants qui ne passent pas ces champs
 * (`etats.noyau.test.ts`, 46 tests, inchanges). Contrat : docs/projets-voirie/CONTRAT-CONFLITS.md section 9 point 35 ; CONTRAT-WORKFLOW.md section 7.
 */
const JUSTIF = "Controle effectue avec le chef de projet";
const deplacer = { id: "d1", option: "DEPLACER_RESEAU" as const, proposeParId: "u-prop" };
const proteger = { id: "d2", option: "PROTEGER" as const, proposeParId: "u-prop" };
const cloture = (s: Partial<EntreeTransition> = {}) => evaluerTransition({
  de: "TRAITEMENT_DECIDE", vers: "CLOTURE", role: "ADMIN", acteurId: "u-admin", justification: JUSTIF, nbPreuves: 1, decisionsApprouvees: [deplacer], proposeurClotureId: "u-autre", ...s,
});

describe("cloture d'un dossier a deplacement de reseau decide", () => {
  it("comportement de RC-3 inchange : sans recolement, la mention est exigee (422 MENTION_RECOLEMENT_REQUISE), et enregistree quand elle est donnee", () => {
    expect(cloture()).toMatchObject({ ok: false, status: 422, code: "MENTION_RECOLEMENT_REQUISE" });
    expect(cloture({ recolementAValider: false })).toMatchObject({ ok: false, code: "MENTION_RECOLEMENT_REQUISE" });
    expect(cloture({ recolementAValider: true })).toMatchObject({ ok: true, recolementMentionne: true, recolementValideUtilise: false });
  });

  it("un recolement valide designe dispense de la mention : la cloture passe et le dit (aucune mention « a valider » n'est enregistree)", () => {
    expect(cloture({ recolementValide: true })).toMatchObject({ ok: true, recolementMentionne: false, recolementValideUtilise: true });
    // La mention en plus n'est pas necessaire et n'est pas retenue : le recolement valide fait foi.
    expect(cloture({ recolementValide: true, recolementAValider: true })).toMatchObject({ ok: true, recolementMentionne: false, recolementValideUtilise: true });
  });

  it("reglage « recolement obligatoire » : sans recolement valide, 409 RECOLEMENT_NON_VALIDE, meme avec la mention ; avec un recolement valide, la cloture passe", () => {
    expect(cloture({ recolementObligatoire: true })).toMatchObject({ ok: false, status: 409, code: "RECOLEMENT_NON_VALIDE" });
    expect(cloture({ recolementObligatoire: true, recolementAValider: true })).toMatchObject({ ok: false, status: 409, code: "RECOLEMENT_NON_VALIDE" });
    expect(cloture({ recolementObligatoire: true, recolementValide: true })).toMatchObject({ ok: true, recolementValideUtilise: true });
  });

  it("sans deplacement decide, ni la mention ni le recolement ne sont exiges, et aucun n'est utilise", () => {
    expect(cloture({ decisionsApprouvees: [proteger] })).toMatchObject({ ok: true, recolementMentionne: false, recolementValideUtilise: false });
    expect(cloture({ decisionsApprouvees: [proteger], recolementObligatoire: true })).toMatchObject({ ok: true });
    expect(cloture({ decisionsApprouvees: [proteger], recolementValide: true })).toMatchObject({ ok: true, recolementValideUtilise: false });
  });

  it("le recolement valide ne dispense de rien d'autre : separation des taches, role, justification", () => {
    expect(cloture({ recolementValide: true, acteurId: "u-admin", proposeurClotureId: "u-admin" })).toMatchObject({ ok: false, status: 409, code: "SEPARATION_DES_TACHES" });
    expect(cloture({ recolementValide: true, role: "GESTIONNAIRE" })).toMatchObject({ ok: false, status: 403, code: "ROLE_INSUFFISANT" });
    expect(cloture({ recolementValide: true, justification: "court" })).toMatchObject({ ok: false, status: 422, code: "JUSTIFICATION_REQUISE" });
  });

  it("une approbation perimee (anterieure a la derniere confirmation) ne compte pas, comme pour RC-3 (revue m3) : aucun deplacement en vigueur, donc ni mention ni recolement exiges", () => {
    const perimee = { ...deplacer, approuveLe: new Date("2026-11-01T10:00:00Z") };
    const v = evaluerTransition({
      de: "TRAITEMENT_DECIDE", vers: "CLOTURE", role: "ADMIN", acteurId: "u-admin", justification: JUSTIF, nbPreuves: 1, decisionsApprouvees: [perimee],
      dernierPassageConfirmeLe: new Date("2026-11-05T10:00:00Z"), proposeurClotureId: "u-autre",
    });
    expect(v).toMatchObject({ ok: true, recolementMentionne: false, recolementValideUtilise: false });
    // Avec le reglage obligatoire, rien de plus n'est exige non plus : il n'y a pas de deplacement en vigueur.
    expect(evaluerTransition({
      de: "TRAITEMENT_DECIDE", vers: "CLOTURE", role: "ADMIN", acteurId: "u-admin", justification: JUSTIF, nbPreuves: 1, decisionsApprouvees: [perimee],
      dernierPassageConfirmeLe: new Date("2026-11-05T10:00:00Z"), proposeurClotureId: "u-autre", recolementObligatoire: true,
    })).toMatchObject({ ok: true });
  });
});
