import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codeMissionTeledetection, verifierDepecheVerification, verifierProduit, verifierVerdict, type ProduitSaisi, verifierDeuxDates } from "./teledetection.noyau";

/**
 * Observation de la Terre (partie E) : ce que ces tests defendent.
 *   - un produit sans licence, provenance, incertitude ou version de traitement n'entre pas ;
 *   - l'optique porte sa couverture nuageuse, un palier payant son autorisation de depense ;
 *   - le terrain juge une fois, en citant son constat ;
 *   - aucun seuil de score n'est ecrit.
 */

describe("Le noyau ne depend de rien", () => {
  it("n'a aucun import ni seuil de score", () => {
    const src = readFileSync(join(__dirname, "teledetection.noyau.ts"), "utf8");
    expect([...src.matchAll(/^import .*?from\s+["']/gm)]).toHaveLength(0);
    expect(src).not.toMatch(/score\s*[<>]=?\s*0?\.\d/);
  });
});

const optique: ProduitSaisi = {
  palier: 0, source: "Sentinel-2 L2A", nature: "OPTIQUE", dateAcquisition: new Date("2026-10-01"), resolutionM: 10,
  couvertureNuagesPct: 12, incertitude: "+/- 1 pixel", provenance: "scene-id", licence: "relevee a la source", versionTraitement: "v0",
};
const code = (v: ReturnType<typeof verifierProduit>) => (v.ok ? "OK" : v.code);

describe("verifierProduit", () => {
  it("accepte un produit complet, et un radar sans couverture nuageuse", () => {
    expect(code(verifierProduit(optique))).toBe("OK");
    expect(code(verifierProduit({ ...optique, nature: "RADAR", couvertureNuagesPct: null }))).toBe("OK");
  });
  it.each([
    [{ licence: "  " }, "CHAMP_MANQUANT"],
    [{ provenance: "" }, "CHAMP_MANQUANT"],
    [{ incertitude: "" }, "CHAMP_MANQUANT"],
    [{ versionTraitement: "" }, "CHAMP_MANQUANT"],
    [{ couvertureNuagesPct: null }, "NUAGES_REQUIS"],
    [{ couvertureNuagesPct: 120 }, "NUAGES_HORS_BORNES"],
    [{ palier: 1 }, "DEPENSE_NON_AUTORISEE"],
    [{ palier: 4 }, "PALIER_INVALIDE"],
    [{ nature: "LIDAR" }, "NATURE_INVALIDE"],
    [{ resolutionM: 0 }, "RESOLUTION_INVALIDE"],
    [{ dateFin: new Date("2026-09-01") }, "PERIODE_INVERSEE"],
  ])("refuse %j -> %s", (o, attendu) => {
    expect(code(verifierProduit({ ...optique, ...o } as ProduitSaisi))).toBe(attendu);
  });
  it("un palier payant passe avec la reference de l'autorisation", () => {
    expect(code(verifierProduit({ ...optique, palier: 1, autorisationDepenseRef: "DEC-2026-001" }))).toBe("OK");
  });
});

describe("verifierVerdict", () => {
  it("le terrain confirme ou infirme, en citant son constat", () => {
    expect(code(verifierVerdict("A_VERIFIER", { statut: "CONFIRMEE", motif: "Eau constatee", constatRef: "mission:X" }))).toBe("OK");
    expect(code(verifierVerdict("A_VERIFIER", { statut: "INFIRMEE", motif: "Chaussee seche", constatRef: "observation:Y" }))).toBe("OK");
  });
  it("refuse un verdict sans constat, un verdict inconnu, une reprise", () => {
    expect(code(verifierVerdict("A_VERIFIER", { statut: "CONFIRMEE", motif: "x" }))).toBe("CONSTAT_REQUIS");
    expect(code(verifierVerdict("A_VERIFIER", { statut: "PROBABLE", motif: "x", constatRef: "y" }))).toBe("VERDICT_INVALIDE");
    expect(code(verifierVerdict("CONFIRMEE", { statut: "INFIRMEE", motif: "x", constatRef: "y" }))).toBe("VERDICT_DEJA_RENDU");
  });
});

describe("Depeche d'une verification", () => {
  it("seulement sur une proposition a verifier, une seule fois", () => {
    expect(code(verifierDepecheVerification({ statut: "A_VERIFIER", missionId: null }))).toBe("OK");
    expect(code(verifierDepecheVerification({ statut: "A_VERIFIER", missionId: "m" }))).toBe("MISSION_DEJA_DEPECHEE");
    expect(code(verifierDepecheVerification({ statut: "INFIRMEE", missionId: null }))).toBe("VERDICT_DEJA_RENDU");
  });
  it("code de mission stable", () => {
    expect(codeMissionTeledetection("3f2a9c1e-77aa-4b2c-9d10-000000000000")).toBe("VER-TD-3F2A9C1E");
  });
});

describe("Comparaison de deux dates", () => {
  const produit = { id: "p-new", dateAcquisition: new Date("2026-10-01") };
  it("sans reference : rien a verifier", () => expect(verifierDeuxDates(produit, null)).toEqual({ ok: true }));
  it("reference anterieure : acceptee", () => expect(verifierDeuxDates(produit, { id: "p-ref", dateAcquisition: new Date("2026-09-01") })).toEqual({ ok: true }));
  it("reference du meme jour ou posterieure : refusee", () => {
    expect(verifierDeuxDates(produit, { id: "p-ref", dateAcquisition: new Date("2026-10-01") })).toMatchObject({ ok: false, code: "REFERENCE_NON_ANTERIEURE" });
    expect(verifierDeuxDates(produit, { id: "p-ref", dateAcquisition: new Date("2026-11-01") })).toMatchObject({ ok: false, code: "REFERENCE_NON_ANTERIEURE" });
  });
  it("le produit lui-meme comme reference : refuse", () => expect(verifierDeuxDates(produit, { ...produit })).toMatchObject({ ok: false, code: "REFERENCE_IDENTIQUE" }));
});
