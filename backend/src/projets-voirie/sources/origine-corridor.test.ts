import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma", () => ({ prisma: {} }));

import { baremeAtteste, origineCorridorDe, vueResultat } from "./comparaison.service";

/** Demande de l'architecte (10/11/2026) : la provenance du corridor est un champ explicite, jamais deduite par l'interface. */
describe("provenance du corridor", () => {
  it("INCERTAIN sans corridor ; PRECISIONS_METRES sans classe convertie ; classe convertie : BAREME_APPROUVE seulement si atteste", () => {
    expect(origineCorridorDe({ corridorM: null, origineA: "CLASSE", origineB: "JEU" }, true)).toBe("INCERTAIN");
    expect(origineCorridorDe({ corridorM: 3, origineA: "CLASSE", origineB: "JEU" }, true)).toBe("BAREME_APPROUVE");
    expect(origineCorridorDe({ corridorM: 3, origineA: "OBJET", origineB: "CLASSE" }, true)).toBe("BAREME_APPROUVE");
    expect(origineCorridorDe({ corridorM: 2, origineA: "JEU", origineB: "OBJET" }, false)).toBe("PRECISIONS_METRES");
  });

  it("revue UI-C (ecart 1) : une classe convertie sans bareme atteste n'est JAMAIS dite approuvee (comparaisons de la regle systeme provisoire)", () => {
    expect(origineCorridorDe({ corridorM: 3, origineA: "CLASSE", origineB: "JEU" }, false)).toBe("BAREME_NON_ATTESTE");
    expect(origineCorridorDe({ corridorM: 3, origineA: "JEU", origineB: "CLASSE" }, false)).toBe("BAREME_NON_ATTESTE");
  });

  it("baremeAtteste : seulement si la comparaison enregistree porte l'approbateur du bareme", () => {
    expect(baremeAtteste(null)).toBe(false);
    expect(baremeAtteste({})).toBe(false);
    // Comparaison anterieure aux correctifs M6 : aucun champ bareme.
    expect(baremeAtteste({ statut: "TERMINEE", totaux: {} })).toBe(false);
    expect(baremeAtteste({ bareme: { applique: true, regle: null } })).toBe(false);
    expect(baremeAtteste({ bareme: { applique: true, regle: { regleId: "r", approuveParId: null } } })).toBe(false);
    expect(baremeAtteste({ bareme: { applique: true, regle: { regleId: "r", approuveParId: "" } } })).toBe(false);
    expect(baremeAtteste({ bareme: { applique: true, regle: { regleId: "r", approuveParId: "admin-2" } } })).toBe(true);
  });

  it("la vue d'un resultat porte origineCorridor, nulle pour un objet sans correspondance ; non attestee par defaut", () => {
    const base = { id: "r", comparaisonId: "c", projetId: "p", ordre: 1, cle: "k", nomA: "a", nomB: "b", precisionAM: null, precisionBM: null, mesure: null, conflitId: null, createdAt: new Date() };
    expect(vueResultat({ ...base, statut: "CONCORDANCE", objetAId: 1n, objetBId: 2n, origineA: "JEU", origineB: "JEU", corridorM: 2 } as never).origineCorridor).toBe("PRECISIONS_METRES");
    expect(vueResultat({ ...base, statut: "SANS_CORRESPONDANCE_A", objetAId: 1n, objetBId: null, origineA: "JEU", origineB: "INCONNUE", corridorM: null } as never).origineCorridor).toBeNull();
    const classe = { ...base, statut: "DIVERGENCE", objetAId: 1n, objetBId: 2n, origineA: "CLASSE", origineB: "JEU", corridorM: 3 } as never;
    expect(vueResultat(classe).origineCorridor).toBe("BAREME_NON_ATTESTE");
    expect(vueResultat(classe, true).origineCorridor).toBe("BAREME_APPROUVE");
  });
});
