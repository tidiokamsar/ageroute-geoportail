import { describe, expect, it } from "vitest";
import { calculerIri, PAS_IRI_M, type DemandeIri } from "./iri";

const demande = (surcharge: Partial<DemandeIri> = {}): DemandeIri => ({
  accelerations: [
    { tMs: 0, axMs2: 0, ayMs2: 0, azMs2: 9.81 },
    { tMs: 10, axMs2: 0, ayMs2: 0, azMs2: 9.9 },
  ],
  frequenceHz: 100,
  positions: [
    { tMs: 0, lat: 9.64, lon: -13.6, vitesseMs: 10 },
    { tMs: 1000, lat: 9.64, lon: -13.5999, vitesseMs: 10 },
  ],
  pasM: PAS_IRI_M,
  ...surcharge,
});

describe("calculerIri : un refus explicite, jamais un nombre", () => {
  it("sans etalonnage approuve : ETALONNAGE_ABSENT", () => {
    const r = calculerIri(demande());
    expect(r).toMatchObject({ statut: "REFUSE", motif: "ETALONNAGE_ABSENT" });
  });

  it("meme avec un etalonnage, l'algorithme n'est pas ecrit : CALCUL_NON_IMPLEMENTE", () => {
    const r = calculerIri(demande(), { reference: "ETALON-X", approuveLe: "2026-12-01", approuvePar: "AGEROUTE" });
    expect(r).toMatchObject({ statut: "REFUSE", motif: "CALCUL_NON_IMPLEMENTE" });
  });

  it("entree hors contrat : pas different de 100 m, ou trop peu de donnees", () => {
    expect(calculerIri(demande({ pasM: 50 }))).toMatchObject({ statut: "REFUSE", motif: "ENTREE_INVALIDE" });
    expect(calculerIri(demande({ accelerations: [] }))).toMatchObject({ statut: "REFUSE", motif: "ENTREE_INVALIDE" });
  });

  it("aucune entree ne produit jamais le statut CALCULE", () => {
    const etalon = { reference: "E", approuveLe: "2026-12-01", approuvePar: "AGEROUTE" };
    for (const e of [null, etalon]) {
      for (const d of [demande(), demande({ pasM: 1 }), demande({ accelerations: [] })]) {
        expect(calculerIri(d, e).statut).toBe("REFUSE");
      }
    }
  });
});
