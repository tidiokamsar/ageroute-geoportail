import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approbationPermise, ENTITES_A_DOUBLE_CONTROLE, EXPLICATION_AUTO_VALIDATION } from "./separation-taches";
import { ENTITES_VALIDABLES, EXPLICATIONS } from "./validation";

/**
 * Separation des taches pour les objets du module Aide a la decision (AD-07).
 *
 * Ce que ces tests defendent : celui qui APPROUVE n'est jamais celui qui a PRODUIT, quel que soit son role (ADMIN compris),
 * avec le meme code stable `AUTO_VALIDATION` que `validationPermise`.
 */
const d = (o: Partial<Parameters<typeof approbationPermise>[0]> = {}) => ({
  entityType: "ParametresProgrammation",
  approbateurId: "u-approbateur",
  approbateurRole: "ADMIN",
  intervenants: [{ id: "u-auteur", etape: "a créé cette version" }],
  ...o,
});

describe("approbationPermise", () => {
  it("refuse l'auto-approbation, meme a un ADMIN, avec le code stable AUTO_VALIDATION et une explication qui nomme l'etape", () => {
    const v = approbationPermise(d({ approbateurId: "u-auteur" }));
    expect(v).toMatchObject({ permis: false, motif: "AUTO_VALIDATION" });
    if (!v.permis) {
      expect(v.explication).toContain(EXPLICATIONS.AUTO_VALIDATION);
      expect(v.explication).toContain("a créé cette version");
    }
  });

  it("autorise un autre compte habilite", () => {
    expect(approbationPermise(d()).permis).toBe(true);
    expect(approbationPermise(d({ approbateurRole: "GESTIONNAIRE" })).permis).toBe(true);
  });

  it("refuse si l'approbateur figure parmi TOUS les intervenants precedents, pas seulement le premier", () => {
    const v = approbationPermise(d({
      approbateurId: "u2",
      intervenants: [{ id: "u1", etape: "a figé la fiche" }, { id: "u2", etape: "a arbitré la fiche" }],
    }));
    expect(v).toMatchObject({ permis: false, motif: "AUTO_VALIDATION" });
    if (!v.permis) expect(v.explication).toContain("a arbitré la fiche");
  });

  it("n'oppose rien a un objet sans auteur identifie (amorcage, import) : la separation n'a personne a opposer", () => {
    for (const id of [null, undefined]) {
      expect(approbationPermise(d({ intervenants: [{ id, etape: "x" }] })).permis, String(id)).toBe(true);
    }
    expect(approbationPermise(d({ intervenants: [] })).permis).toBe(true);
  });

  it("refuse un role non habilite et un type d'objet inconnu (echoue ferme)", () => {
    for (const role of ["LECTEUR", "INSPECTEUR", "CHEF_DE_SERVICE"]) {
      expect(approbationPermise(d({ approbateurRole: role })), role).toMatchObject({ permis: false, motif: "ROLE_INSUFFISANT" });
    }
    expect(approbationPermise(d({ entityType: "Marche" }))).toMatchObject({ permis: false, motif: "ENTITE_NON_VALIDABLE" });
  });

  it("le role, plus grossier, se juge avant l'auto-approbation (meme ordre que validationPermise)", () => {
    expect(approbationPermise(d({ approbateurId: "u-auteur", approbateurRole: "LECTEUR" }))).toMatchObject({ motif: "ROLE_INSUFFISANT" });
  });
});

describe("ENTITES_A_DOUBLE_CONTROLE", () => {
  // CONTRAT MODIFIE (revue) : la liste contenait `ScenarioProgrammation` alors qu'aucun point d'approbation de scenario n'existe : elle
  // annoncait un double controle qui ne controlait rien. Elle ne liste que les types effectivement approuves par une route.
  it("couvre parametres, baremes, fiches et previsions (les seuls objets qui ont un point d'approbation)", () => {
    expect([...ENTITES_A_DOUBLE_CONTROLE].sort()).toEqual(["BaremeIntervention", "FicheIntervention", "ParametresProgrammation", "ProgrammeBudgetaire"]);
  });

  it("un scenario n'a pas de point d'approbation : approbationPermise le refuse (echoue ferme) plutot que de feindre un controle", () => {
    expect(approbationPermise(d({ entityType: "ScenarioProgrammation" }))).toMatchObject({ permis: false, motif: "ENTITE_NON_VALIDABLE" });
  });

  it("chaque type de la liste est appele par une route : aucun type decoratif", () => {
    const src = (f: string) => readFileSync(join(__dirname, "..", f), "utf8");
    const code = [src("programmation/moteur.service.ts"), src("api-v2/baremes.routes.ts"), src("api-v2/programmation.routes.ts")].join("\n");
    for (const e of ENTITES_A_DOUBLE_CONTROLE) expect(code, e).toMatch(new RegExp(`entityType: "${e}"`));
  });

  it("n'elargit PAS ENTITES_VALIDABLES : les domaines de delegation (UI de gouvernance) restent ceux du patrimoine", () => {
    for (const e of ENTITES_A_DOUBLE_CONTROLE) expect(ENTITES_VALIDABLES.has(e), e).toBe(false);
  });

  it("l'explication exportee est celle de validation.ts (un seul texte)", () => {
    expect(EXPLICATION_AUTO_VALIDATION).toBe(EXPLICATIONS.AUTO_VALIDATION);
  });
});
