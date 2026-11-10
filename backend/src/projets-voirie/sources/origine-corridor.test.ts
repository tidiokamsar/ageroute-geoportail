import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma", () => ({ prisma: {} }));

import { origineCorridorDe, vueResultat } from "./comparaison.service";

/** Demande de l'architecte (10/11/2026) : la provenance du corridor est un champ explicite, jamais deduite par l'interface. */
describe("provenance du corridor", () => {
  it("INCERTAIN sans corridor ; BAREME_APPROUVE si une classe convertie est d'un cote ; PRECISIONS_METRES sinon", () => {
    expect(origineCorridorDe({ corridorM: null, origineA: "CLASSE", origineB: "JEU" })).toBe("INCERTAIN");
    expect(origineCorridorDe({ corridorM: 3, origineA: "CLASSE", origineB: "JEU" })).toBe("BAREME_APPROUVE");
    expect(origineCorridorDe({ corridorM: 3, origineA: "OBJET", origineB: "CLASSE" })).toBe("BAREME_APPROUVE");
    expect(origineCorridorDe({ corridorM: 2, origineA: "JEU", origineB: "OBJET" })).toBe("PRECISIONS_METRES");
  });
  it("la vue d'un resultat porte origineCorridor, nulle pour un objet sans correspondance", () => {
    const base = { id: "r", comparaisonId: "c", projetId: "p", ordre: 1, cle: "k", nomA: "a", nomB: "b", precisionAM: null, precisionBM: null, mesure: null, conflitId: null, createdAt: new Date() };
    expect(vueResultat({ ...base, statut: "CONCORDANCE", objetAId: 1n, objetBId: 2n, origineA: "JEU", origineB: "JEU", corridorM: 2 } as never).origineCorridor).toBe("PRECISIONS_METRES");
    expect(vueResultat({ ...base, statut: "SANS_CORRESPONDANCE_A", objetAId: 1n, objetBId: null, origineA: "JEU", origineB: "INCONNUE", corridorM: null } as never).origineCorridor).toBeNull();
  });
});
