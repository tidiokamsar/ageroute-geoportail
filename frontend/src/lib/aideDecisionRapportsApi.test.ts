import { describe, expect, it } from "vitest";
import { analyserJournal, analyserRapportRegions, erreurExport } from "./aideDecisionRapportsApi";

describe("analyserJournal", () => {
  const entree = {
    id: "e1", type: "reseau_regions", format: "csv", auteur: { id: "u", email: "a@x", role: "GESTIONNAIRE" }, filtres: { regionId: 3 }, perimetre: { libelle: "Region Kindia" },
    nbLignes: 2, tailleOctets: 900, empreinteSha256: "a".repeat(64), droitFinancier: false, colonnesRetirees: ["cout"], creeLe: "2026-10-29T10:00:00Z",
  };
  it("lit une entree complete", () => {
    const j = analyserJournal({ total: 5, data: [entree] });
    expect(j?.total).toBe(5);
    expect(j?.entrees[0]).toMatchObject({ auteurEmail: "a@x", perimetreLibelle: "Region Kindia", colonnesRetirees: ["cout"], nbLignes: 2 });
  });
  it("une forme inattendue est refusee (jamais un journal vide)", () => {
    expect(analyserJournal(null)).toBeNull();
    expect(analyserJournal({ data: "x" })).toBeNull();
    expect(analyserJournal({ data: [{ type: "x" }] })).toBeNull();
  });
  it("un nombre de lignes absent reste null (pas 0)", () => {
    expect(analyserJournal({ data: [{ ...entree, nbLignes: undefined }] })?.entrees[0].nbLignes).toBeNull();
  });
});

describe("analyserRapportRegions", () => {
  const l = { region: "Kindia", troncons: 3, kmBon: 10, kmMoyen: 0, kmMauvais: 5, kmCritique: 3, kmEtatNonValide: 0, kmNonEvalue: 40, kmEligible: 18, degradePct: 44.4, critiquePct: null, disponibilite: "PARTIEL" };
  it("un taux null reste null", () => {
    const r = analyserRapportRegions({ rapport: { perimetre: { libelle: "Ensemble du pays" }, regions: [l], total: l, avertissements: ["a"] }, filtres: { nonAppliques: [{ filtre: "depuis", raison: "r" }] } });
    expect(r?.regions[0].critiquePct).toBeNull();
    expect(r?.regions[0].degradePct).toBe(44.4);
    expect(r?.filtresNonAppliques).toEqual([{ filtre: "depuis", raison: "r" }]);
  });
  it("forme inattendue : null", () => {
    expect(analyserRapportRegions({ rapport: { regions: [{ km: 1 }] } })).toBeNull();
    expect(analyserRapportRegions(undefined)).toBeNull();
  });
});

describe("erreurExport", () => {
  it("relit le corps JSON d'un blob d'erreur : le mot du serveur est conserve", async () => {
    const blob = new Blob([JSON.stringify({ error: "L'export porterait 12000 lignes", code: "EXPORT_TROP_VOLUMINEUX" })], { type: "application/json" });
    const e = await erreurExport({ response: { status: 413, data: blob } });
    expect(e.message).toMatch(/12000 lignes/);
    expect(e.code).toBe("EXPORT_TROP_VOLUMINEUX");
    expect(e.status).toBe(413);
  });
  it("403 : genre permission", async () => {
    const blob = new Blob([JSON.stringify({ error: "refus" })]);
    expect((await erreurExport({ response: { status: 403, data: blob } })).genre).toBe("permission");
  });
  it("sans reponse : erreur reseau", async () => {
    expect((await erreurExport(new Error("Network"))).genre).toBe("reseau");
  });
});
