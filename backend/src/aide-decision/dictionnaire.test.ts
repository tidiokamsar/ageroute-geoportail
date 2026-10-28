import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({ prisma: {} }));

import { DICTIONNAIRE, entree, reponseDictionnaire } from "./dictionnaire";
import { PARAMETRES_KPI } from "./kpi.noyau";

/** Le dictionnaire est la description du code (cahier 9.1) : complet, provisoire, sans responsable invente. */
describe("dictionnaire des indicateurs", () => {
  const MINIMUM = [
    "reseau_degrade_pct", "reseau_critique_km", "reseau_critique_pct", "longueur_reseau_reference_km", "longueur_geometrique_km",
    "chantiers_en_cours", "chantiers_en_retard", "budget_engage_gnf", "budget_contractuel_gnf", "marches_recenses",
    "donnees_a_confirmer", "couverture_etat_part",
  ];

  it("contient au minimum les douze indicateurs du brief, sans doublon", () => {
    const codes = DICTIONNAIRE.map((e) => e.code);
    for (const c of MINIMUM) expect(codes, c).toContain(c);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("documente aussi decaisse, previsionnel et la ventilation par bailleur", () => {
    for (const c of ["budget_decaisse_gnf", "budget_previsionnel_gnf", "budget_contractuel_par_bailleur_gnf"]) expect(() => entree(c)).not.toThrow();
  });

  it.each(DICTIONNAIRE.map((e) => [e.code, e] as const))("%s : tous les champs du cahier 9.1 sont renseignes", (_c, e) => {
    for (const champ of ["libelle", "definition", "formule", "source", "miseAJour", "responsableMetier", "dateDefinition"] as const) {
      expect(e[champ].trim().length, champ).toBeGreaterThan(5);
    }
    expect(e.perimetre.code && e.perimetre.libelle && e.perimetre.definition).toBeTruthy();
    expect(["%", "km", "GNF", "nombre", "part", "elements"]).toContain(e.unite);
    expect(e.conditionsCalcul.length, "conditions de calcul").toBeGreaterThan(0);
    expect(e.limites.length, "limites").toBeGreaterThan(0);
    expect(e.reglesExclusion.length, "regles d'exclusion").toBeGreaterThan(0);
    expect(e.decisionsOuvertes.length, "decisions ouvertes").toBeGreaterThan(0);
  });

  it("aucune definition n'est validee : toutes PROVISOIRES, responsable metier a confirmer, jamais nomme", () => {
    for (const e of DICTIONNAIRE) {
      expect(e.statutDefinition).toBe("PROVISOIRE");
      expect(e.responsableMetier).toMatch(/^À confirmer par la Direction (technique|financière)$/);
    }
  });

  it("le budget engage n'a ni formule ni colonne : il n'est pas calcule, et la raison est ecrite", () => {
    const e = entree("budget_engage_gnf");
    expect(e.colonnes).toEqual([]);
    expect(e.tablesSources).toEqual([]);
    expect(e.formule).toMatch(/B-08/);
    expect(e.formule).toMatch(/ADR-003/);
    expect(e.definition).toMatch(/somme des montants des chantiers n'est PAS un budget engagé/);
  });

  it("marches recenses : lignes de `marches`, pas de chantiers, jamais « actifs »", () => {
    const e = entree("marches_recenses");
    expect(e.tablesSources).toContain("marches");
    expect(e.formule).toMatch(/COUNT\(marches\)/);
    expect(e.definition).toMatch(/ni actif ni validé/);
  });

  it("la longueur geometrique est separee de la longueur metier : aucune formule ne melange les deux", () => {
    expect(entree("longueur_geometrique_km").formule).toMatch(/ST_Length/);
    expect(entree("longueur_geometrique_km").formule).not.toMatch(/longueurKm/);
    expect(entree("longueur_reseau_reference_km").formule).toMatch(/longueurKm/);
    expect(entree("longueur_reseau_reference_km").formule).not.toMatch(/ST_Length/);
    expect(entree("longueur_reseau_reference_km").limites.join(" ")).toMatch(/Jamais complétée par la longueur géométrique/);
  });

  it("les taux disent leur denominateur, leur regle d'etat valide et le sort des non evalues", () => {
    const e = entree("reseau_degrade_pct");
    expect(e.formule).toMatch(/état valide/);
    expect(e.conditionsCalcul.join(" ")).toMatch(/null/);
    expect(e.reglesExclusion.join(" ")).toMatch(/NON_EVALUE/);
    expect(e.reglesExclusion.join(" ")).toMatch(/voirie_locale/);
    expect(e.decisionsOuvertes.join(" ")).toMatch(/dégradées/);
  });

  it("le perimetre « reseau classe saisi » ne se dit jamais « reseau national »", () => {
    for (const e of DICTIONNAIRE) expect(`${e.libelle} ${e.perimetre.libelle}`).not.toMatch(/r[eé]seau national/i);
  });

  it("entree() leve pour un code inconnu (un indicateur sans definition est un defaut)", () => {
    expect(() => entree("inconnu")).toThrow(/sans entree/);
  });

  it("la reponse porte les parametres PROVISOIRES et la mention consultative", () => {
    const r = reponseDictionnaire(new Date("2026-10-26T10:00:00Z"));
    expect(r.statutDefinition).toBe("PROVISOIRE");
    expect(r.version).toBe(PARAMETRES_KPI.version);
    expect(r.parametres.classesDegradees).toEqual(["MAUVAIS", "CRITIQUE"]);
    expect(r.parametres.classesCritiques).toEqual(["CRITIQUE"]);
    expect(r.parametres.regleEtatValide).toMatch(/état valide/i);
    expect(r.mention).toMatch(/non engageants/);
    expect(r.indicateurs.length).toBe(DICTIONNAIRE.length);
    expect(JSON.parse(JSON.stringify(r)).genereLe).toBe("2026-10-26T10:00:00.000Z");
  });
});
