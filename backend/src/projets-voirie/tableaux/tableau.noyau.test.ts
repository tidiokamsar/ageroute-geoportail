import { describe, expect, it } from "vitest";
import { CLE_TOTAL, agregatVide, ranger, type LignesTableau } from "./tableau.noyau";

/** Assemblage des tableaux de bord (lot X1) : rangement des lignes GROUPING SETS, zeros, lisibilite (pieces et referents nuls pour un lecteur). */

const lignes = (pieces: LignesTableau["pieces"], referents: LignesTableau["referents"]): LignesTableau => ({
  projets: [{ cle: "1", g: 0, n: 2 }, { cle: "2", g: 0, n: 1 }, { cle: null, g: 1, n: 3 }],
  jeux: [{ cle: "1", g: 0, s: "AUTORISE", n: 4 }, { cle: "1", g: 0, s: "CONTROLE", n: 1 }, { cle: null, g: 1, s: "AUTORISE", n: 4 }, { cle: null, g: 1, s: "CONTROLE", n: 1 }],
  conflits: [{ cle: "2", g: 0, s: "A_INVESTIGUER", n: 5 }, { cle: null, g: 1, s: "A_INVESTIGUER", n: 5 }],
  types: [{ cle: "1", g: 0, n: 2, projets: 1 }, { cle: null, g: 1, n: 2, projets: 1 }],
  pieces, referents,
});

describe("tableau de bord : rangement des agregats", () => {
  it("decideur : total et cles, zeros par defaut, pieces en attente sommees par statut, referents (comptes distincts du total pris tels quels)", () => {
    const m = ranger(lignes(
      [{ cle: "1", g: 0, s: "ATTENDU", n: 2 }, { cle: "1", g: 0, s: "RECU", n: 1 }, { cle: null, g: 1, s: "ATTENDU", n: 2 }, { cle: null, g: 1, s: "RECU", n: 1 }],
      [{ cle: "1", g: 0, rattachements: 2, comptes: 1 }, { cle: "2", g: 0, rattachements: 1, comptes: 1 }, { cle: null, g: 1, rattachements: 3, comptes: 1 }],
    ), true);
    const total = m.get(CLE_TOTAL)!;
    expect(total).toEqual({
      projets: 3, jeux: { AUTORISE: 4, CONTROLE: 1 }, conflits: { A_INVESTIGUER: 5 },
      documentsManquants: { typesObligatoiresNonFournis: 2, projetsIncomplets: 1, piecesEnAttente: 3, piecesEnAttenteParStatut: { ATTENDU: 2, RECU: 1 } },
      referentsActifs: { comptes: 1, rattachements: 3 },
    });
    expect(m.get("2")).toEqual({ ...agregatVide(true), projets: 1, conflits: { A_INVESTIGUER: 5 }, referentsActifs: { comptes: 1, rattachements: 1 } });
  });

  it("lecteur : pieces en attente et referents valent null, meme si des lignes etaient fournies par erreur", () => {
    const m = ranger(lignes([{ cle: null, g: 1, s: "ATTENDU", n: 9 }], [{ cle: null, g: 1, rattachements: 9, comptes: 9 }]), false);
    const total = m.get(CLE_TOTAL)!;
    expect(total.documentsManquants.piecesEnAttente).toBeNull();
    expect(total.documentsManquants.piecesEnAttenteParStatut).toBeNull();
    expect(total.referentsActifs).toBeNull();
    expect(total.projets).toBe(3);
  });

  it("aucune ligne : un total a zero (perimetre vide)", () => {
    const m = ranger({ projets: [], jeux: [], conflits: [], types: [], pieces: [], referents: [] }, true);
    expect(m.get(CLE_TOTAL)).toEqual(agregatVide(true));
    expect([...m.keys()]).toEqual([CLE_TOTAL]);
  });

  it("une cle de region nulle (projets sans region) devient la cle vide, distincte du total", () => {
    const m = ranger({ projets: [{ cle: null, g: 0, n: 2 }, { cle: null, g: 1, n: 2 }], jeux: [], conflits: [], types: [], pieces: null, referents: null }, false);
    expect(m.get("")!.projets).toBe(2);
    expect(m.get(CLE_TOTAL)!.projets).toBe(2);
  });
});
