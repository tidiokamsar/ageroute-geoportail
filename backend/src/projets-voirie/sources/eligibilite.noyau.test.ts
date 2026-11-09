import { describe, expect, it } from "vitest";
import { evaluerEligibilite, type JeuEligible } from "./eligibilite.noyau";
import { filtreCleVersion, memeLignee, methodeDansCle } from "./cle-version.noyau";

const t0 = new Date("2026-11-01T10:00:00Z");
const jeu = (id: string, s: Partial<JeuEligible> = {}): JeuEligible => ({
  id, projetId: "p", role: "RESEAU_TIERS", statut: "AUTORISE", concessionnaireId: "c1", typeReseau: "TELECOM", methodeAcquisition: null, remplaceId: null, createdAt: t0, ...s,
});

describe("eligibilite d'une comparaison", () => {
  it("SOURCES : deux jeux AUTORISE du meme reseau (deux methodes) ; A = le depot le plus ancien, quel que soit l'ordre de la demande", () => {
    const vieux = jeu("j1", { methodeAcquisition: "NUMERISATION_PLAN" }), recent = jeu("j2", { methodeAcquisition: "GNSS_RTK", createdAt: new Date("2026-11-02T10:00:00Z") });
    const v = evaluerEligibilite(recent, vieux);
    expect(v).toMatchObject({ ok: true, mode: "SOURCES" });
    if (v.ok) { expect(v.a.id).toBe("j1"); expect(v.b.id).toBe("j2"); }
  });
  it("refus : meme jeu, roles differents, concessionnaire ou type different, role non comparable", () => {
    expect(evaluerEligibilite(jeu("j1"), jeu("j1"))).toMatchObject({ ok: false, motif: "MEME_JEU" });
    expect(evaluerEligibilite(jeu("j1"), jeu("j2", { concessionnaireId: "c2" }))).toMatchObject({ ok: false, motif: "RESEAU_DIFFERENT" });
    expect(evaluerEligibilite(jeu("j1"), jeu("j2", { typeReseau: "EAU_POTABLE" }))).toMatchObject({ ok: false, motif: "RESEAU_DIFFERENT" });
    expect(evaluerEligibilite(jeu("j1"), jeu("j2", { role: "AXES_TRAVAUX", concessionnaireId: null, typeReseau: null }))).toMatchObject({ ok: false, motif: "ROLE" });
    expect(evaluerEligibilite(jeu("j1", { role: "LIMITES_ROUTE" }), jeu("j2", { role: "LIMITES_ROUTE" }))).toMatchObject({ ok: false, motif: "ROLE" });
    expect(evaluerEligibilite(jeu("j1", { concessionnaireId: null }), jeu("j2", { concessionnaireId: null }))).toMatchObject({ ok: false, motif: "RESEAU_DIFFERENT" });
  });
  it("VERSION_CANDIDATE : un plan d'axes en controle face au plan autorise qu'il remplacera (PDF numerise puis DXF du bureau d'etudes)", () => {
    const axePdf = jeu("a1", { role: "AXES_TRAVAUX", concessionnaireId: null, typeReseau: null, methodeAcquisition: "NUMERISATION_PLAN" });
    const axeDxf = jeu("a2", { role: "AXES_TRAVAUX", concessionnaireId: null, typeReseau: null, methodeAcquisition: "PLAN_CAO", statut: "CONTROLE", remplaceId: "a1", createdAt: new Date("2026-11-03T10:00:00Z") });
    const v = evaluerEligibilite(axeDxf, axePdf);
    expect(v).toMatchObject({ ok: true, mode: "VERSION_CANDIDATE" });
    if (v.ok) { expect(v.a.id).toBe("a1"); expect(v.b.id).toBe("a2"); }
  });
  it("VERSION_CANDIDATE d'un reseau : meme lignee seulement (meme methode) ; un candidat qui ne remplace pas ce jeu est refuse", () => {
    const a = jeu("j1", { methodeAcquisition: "GNSS_RTK" });
    expect(evaluerEligibilite(a, jeu("j2", { statut: "CONTROLE", remplaceId: "j1", methodeAcquisition: "GNSS_RTK" }))).toMatchObject({ ok: true, mode: "VERSION_CANDIDATE" });
    expect(evaluerEligibilite(a, jeu("j2", { statut: "CONTROLE", remplaceId: "autre", methodeAcquisition: "GNSS_RTK" }))).toMatchObject({ ok: false, motif: "LIGNEE_DIFFERENTE" });
    expect(evaluerEligibilite(a, jeu("j2", { statut: "CONTROLE", remplaceId: "j1", methodeAcquisition: "GEORADAR" }))).toMatchObject({ ok: false, motif: "LIGNEE_DIFFERENTE" });
  });
  it("refus de statut : aucun jeu autorise, ou un second jeu rejete, remplace ou retire", () => {
    expect(evaluerEligibilite(jeu("j1", { statut: "CONTROLE" }), jeu("j2", { statut: "CONTROLE" }))).toMatchObject({ ok: false, motif: "STATUT" });
    for (const statut of ["REJETE", "REMPLACE", "RETIRE"]) expect(evaluerEligibilite(jeu("j1"), jeu("j2", { statut, remplaceId: "j1" }))).toMatchObject({ ok: false, motif: "STATUT" });
  });
});

describe("cle de version (meme regle que l'index de la migration)", () => {
  it("la methode n'entre dans la cle que pour un reseau de concessionnaire", () => {
    expect(methodeDansCle("RESEAU_TIERS")).toBe(true);
    for (const r of ["AXES_TRAVAUX", "LIMITES_ROUTE", "AUTRE"]) expect(methodeDansCle(r)).toBe(false);
    expect(filtreCleVersion({ projetId: "p", role: "RESEAU_TIERS", concessionnaireId: "c", methodeAcquisition: "GNSS_RTK" })).toEqual({ projetId: "p", role: "RESEAU_TIERS", concessionnaireId: "c", methodeAcquisition: "GNSS_RTK" });
    expect(filtreCleVersion({ projetId: "p", role: "RESEAU_TIERS", concessionnaireId: "c" })).toEqual({ projetId: "p", role: "RESEAU_TIERS", concessionnaireId: "c", methodeAcquisition: null });
    expect(filtreCleVersion({ projetId: "p", role: "AXES_TRAVAUX", concessionnaireId: null, methodeAcquisition: "PLAN_CAO" })).toEqual({ projetId: "p", role: "AXES_TRAVAUX", concessionnaireId: null });
  });
  it("deux plans d'axes de methodes differentes sont de la meme lignee ; deux reseaux de methodes differentes, non", () => {
    expect(memeLignee({ projetId: "p", role: "AXES_TRAVAUX", concessionnaireId: null, methodeAcquisition: "NUMERISATION_PLAN" }, { projetId: "p", role: "AXES_TRAVAUX", concessionnaireId: null, methodeAcquisition: "PLAN_CAO" })).toBe(true);
    expect(memeLignee({ projetId: "p", role: "RESEAU_TIERS", concessionnaireId: "c", methodeAcquisition: "GNSS_RTK" }, { projetId: "p", role: "RESEAU_TIERS", concessionnaireId: "c", methodeAcquisition: "GEORADAR" })).toBe(false);
    expect(memeLignee({ projetId: "p", role: "RESEAU_TIERS", concessionnaireId: "c", methodeAcquisition: null }, { projetId: "p", role: "RESEAU_TIERS", concessionnaireId: "c" })).toBe(true);
  });
});
