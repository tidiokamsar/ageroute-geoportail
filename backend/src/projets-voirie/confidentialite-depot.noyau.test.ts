import { describe, expect, it } from "vitest";
import { NIVEAUX_CONFIDENTIALITE, niveauDuDepot, plusRestrictif, rangNiveau } from "./confidentialite-depot.noyau";

/**
 * Niveau de confidentialite d'un depot (revue du lot X1, M1) : heritage du plus restrictif de la lignee, plancher CONFIDENTIEL_CONCESSIONNAIRE d'un reseau
 * de concessionnaire, abaissement reserve a l'ADMIN avec justification.
 */

const code = (v: ReturnType<typeof niveauDuDepot>) => (v.ok ? `OK:${v.niveau}` : `${v.status}:${v.code}`);

describe("niveau de confidentialite d'un depot", () => {
  it("ordre des niveaux ; un niveau inconnu est le plus restrictif", () => {
    expect(NIVEAUX_CONFIDENTIALITE.map(rangNiveau)).toEqual([0, 1, 2, 3, 4]);
    expect(rangNiveau("SECRET_FUTUR")).toBe(5);
    expect(plusRestrictif(["INTERNE", "INFRASTRUCTURE_SENSIBLE", "PUBLIC"])).toBe("INFRASTRUCTURE_SENSIBLE");
    expect(plusRestrictif([])).toBeNull();
  });

  it("premiere version sans niveau demande : le defaut du role (inchange)", () => {
    expect(code(niveauDuDepot({ role: "RESEAU_TIERS", niveauxLignee: [], roleActeur: "GESTIONNAIRE" }))).toBe("OK:CONFIDENTIEL_CONCESSIONNAIRE");
    expect(code(niveauDuDepot({ role: "AXES_TRAVAUX", niveauxLignee: [], roleActeur: "GESTIONNAIRE" }))).toBe("OK:RESTREINT_PROJET");
  });

  it("nouvelle version sans niveau demande : herite du plus restrictif de la lignee (avertissement)", () => {
    const v = niveauDuDepot({ role: "AXES_TRAVAUX", niveauxLignee: ["INTERNE", "INFRASTRUCTURE_SENSIBLE"], roleActeur: "GESTIONNAIRE" });
    expect(v).toMatchObject({ ok: true, niveau: "INFRASTRUCTURE_SENSIBLE", herite: true, abaissement: null });
  });

  it("un GESTIONNAIRE ne peut pas abaisser : redepot INTERNE d'un reseau confidentiel, ou premier depot d'un reseau sous CONFIDENTIEL_CONCESSIONNAIRE : 403", () => {
    for (const [lignee, demande] of [[["CONFIDENTIEL_CONCESSIONNAIRE"], "INTERNE"], [[], "INTERNE"], [[], "RESTREINT_PROJET"], [["INFRASTRUCTURE_SENSIBLE"], "CONFIDENTIEL_CONCESSIONNAIRE"]] as const) {
      expect(code(niveauDuDepot({ role: "RESEAU_TIERS", demande, niveauxLignee: lignee, roleActeur: "GESTIONNAIRE" })), `${lignee} -> ${demande}`).toBe("403:CONFIDENTIALITE_ABAISSEMENT_RESERVE");
    }
    expect(code(niveauDuDepot({ role: "AXES_TRAVAUX", demande: "PUBLIC", niveauxLignee: ["INTERNE"], roleActeur: "GESTIONNAIRE" }))).toBe("403:CONFIDENTIALITE_ABAISSEMENT_RESERVE");
  });

  it("monter ou garder le niveau est toujours admis ; un premier plan d'axes choisit librement son niveau", () => {
    expect(code(niveauDuDepot({ role: "RESEAU_TIERS", demande: "INFRASTRUCTURE_SENSIBLE", niveauxLignee: ["CONFIDENTIEL_CONCESSIONNAIRE"], roleActeur: "GESTIONNAIRE" }))).toBe("OK:INFRASTRUCTURE_SENSIBLE");
    expect(code(niveauDuDepot({ role: "RESEAU_TIERS", demande: "CONFIDENTIEL_CONCESSIONNAIRE", niveauxLignee: [], roleActeur: "GESTIONNAIRE" }))).toBe("OK:CONFIDENTIEL_CONCESSIONNAIRE");
    expect(code(niveauDuDepot({ role: "AXES_TRAVAUX", demande: "PUBLIC", niveauxLignee: [], roleActeur: "GESTIONNAIRE" }))).toBe("OK:PUBLIC");
  });

  it("ADMIN : abaissement avec justification (10 caracteres), rendu pour l'audit ; sans justification : 400", () => {
    expect(code(niveauDuDepot({ role: "RESEAU_TIERS", demande: "INTERNE", niveauxLignee: ["CONFIDENTIEL_CONCESSIONNAIRE"], roleActeur: "ADMIN" }))).toBe("400:JUSTIFICATION_INVALIDE");
    expect(code(niveauDuDepot({ role: "RESEAU_TIERS", demande: "INTERNE", niveauxLignee: [], roleActeur: "ADMIN", justification: "  court  " }))).toBe("400:JUSTIFICATION_INVALIDE");
    const v = niveauDuDepot({ role: "RESEAU_TIERS", demande: "INTERNE", niveauxLignee: ["INFRASTRUCTURE_SENSIBLE"], roleActeur: "ADMIN", justification: "Plan public du concessionnaire, publie par lui" });
    expect(v).toMatchObject({ ok: true, niveau: "INTERNE", abaissement: { de: "INFRASTRUCTURE_SENSIBLE", vers: "INTERNE", justification: "Plan public du concessionnaire, publie par lui" } });
  });
});
