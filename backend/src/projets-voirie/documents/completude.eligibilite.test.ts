import { describe, expect, it, vi } from "vitest";

/**
 * Revue D1, M2 : la completude n'a PAS sa propre regle d'identite de reseau ; elle appelle l'eligibilite du lot S1 (`sources/eligibilite.noyau.ts`) et lui
 * transmet `typeReseauCode`. Ici l'eligibilite est simulee avec la regle de la decision M3 de la revue T1+S1 (concessionnaire ET code TYPE_RESEAU, sinon
 * famille) : la completude doit la suivre sans aucun changement de son code. Le cas reel (regle S1 du jour) est dans completude.noyau.test.ts.
 */
vi.mock("../sources/eligibilite.noyau", async (original) => {
  const m = await original<typeof import("../sources/eligibilite.noyau")>();
  return {
    ...m,
    evaluerEligibilite: vi.fn((a: { typeReseauCode?: string | null; typeReseau: string | null }, b: { typeReseauCode?: string | null; typeReseau: string | null }) => {
      const r = m.evaluerEligibilite(a as never, b as never);
      if (r.ok && (a.typeReseauCode ?? a.typeReseau) !== (b.typeReseauCode ?? b.typeReseau)) return { ok: false, motif: "RESEAU_DIFFERENT", message: "codes differents" };
      return r;
    }),
  };
});

import { reseauxDepuisJeux, calculerCompletude } from "./completude.noyau";

const jeu = (id: string, code: string, jour: number) => ({
  id, projetId: "p", role: "RESEAU_TIERS", statut: "AUTORISE", concessionnaireId: "c1", concessionnaireNom: "Concessionnaire synthetique", typeReseau: "TELECOM",
  typeReseauCode: code, methodeAcquisition: null, remplaceId: null, createdAt: new Date(Date.UTC(2026, 10, jour)),
});

describe("la completude suit l'eligibilite du lot S1 (identite d'un reseau)", () => {
  it("deux types configurables de la meme famille, refuses par l'eligibilite : deux reseaux d'une source chacun, comparaison INDISPONIBLE", () => {
    const reseaux = reseauxDepuisJeux([jeu("j1", "FIBRE_SYNTH", 1), jeu("j2", "CUIVRE_SYNTH", 2)]);
    expect(reseaux.map((r) => [r.typeReseauCode, r.nbSources])).toEqual([["FIBRE_SYNTH", 1], ["CUIVRE_SYNTH", 1]]);
    const c = calculerCompletude({ etat: { nbAxesAutorises: 1, reseaux, nbDecisionsDeplacement: 0 }, types: [], documents: [], jeuxAutorisesParRole: { RESEAU_TIERS: 2 }, decideur: true });
    expect(c.fonctions.find((f) => f.code === "COMPARAISON_SOURCES")?.etat).toBe("INDISPONIBLE");
    expect(c.piecesManquantes.filter((p) => p.nature === "CONDITION" && p.code === "SECONDE_SOURCE")).toHaveLength(2);
  });
  it("meme code : une seule source de plus pour le meme reseau", () => {
    expect(reseauxDepuisJeux([jeu("j1", "FIBRE_SYNTH", 1), jeu("j2", "FIBRE_SYNTH", 2)]).map((r) => r.nbSources)).toEqual([2]);
  });
});
