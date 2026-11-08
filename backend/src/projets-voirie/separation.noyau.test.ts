import { describe, expect, it } from "vitest";
import { verifierSeparation, type EntreeSeparation } from "./separation.noyau";
import { verifierSeparationCloture, verifierSeparationDecision } from "./conflits/etats.noyau";

/**
 * Noyau commun de la separation des taches (extrait de RC-3 au lot B3). Les deux fonctions de RC-3 qui le delèguent gardent leurs refus a l'identique
 * (`conflits/etats.noyau.test.ts`, 46 tests, inchanges) ; ici, la regle elle-meme et l'equivalence avec l'ancien code.
 */
const base: EntreeSeparation = {
  acteurId: "u1", role: "GESTIONNAIRE", auteursIds: ["u1"], derogation: undefined, adminExige: true,
  messageSansDerogation: "sans derogation", messageAdminExige: "admin exige",
};

describe("verifierSeparation", () => {
  it("une personne qui n'est pas l'un des auteurs n'a besoin d'aucune derogation", () => {
    expect(verifierSeparation({ ...base, acteurId: "u2" })).toEqual({ ok: true, derogation: null });
    expect(verifierSeparation({ ...base, auteursIds: [] })).toEqual({ ok: true, derogation: null });
  });

  it("les auteurs nuls ou absents sont ignores (un acteur ne correspond jamais a « personne »)", () => {
    expect(verifierSeparation({ ...base, auteursIds: [null, undefined] })).toEqual({ ok: true, derogation: null });
  });

  it("un auteur sans derogation, ou avec une derogation de moins de 10 caracteres : 409 SEPARATION_DES_TACHES avec le message sans derogation", () => {
    for (const d of [undefined, "", "   ", "court"]) {
      expect(verifierSeparation({ ...base, derogation: d, role: "ADMIN" })).toEqual({ ok: false, status: 409, code: "SEPARATION_DES_TACHES", message: "sans derogation" });
    }
  });

  it("l'auteur est l'une des personnes de la liste, pas seulement la premiere", () => {
    expect(verifierSeparation({ ...base, auteursIds: ["u0", "u1"] })).toMatchObject({ ok: false, code: "SEPARATION_DES_TACHES" });
  });

  it("un ADMIN est exige : une derogation d'un non-ADMIN est refusee avec le message `admin exige` (ou, a defaut, le premier)", () => {
    expect(verifierSeparation({ ...base, derogation: "motif suffisamment long" })).toMatchObject({ ok: false, message: "admin exige" });
    expect(verifierSeparation({ ...base, derogation: "motif suffisamment long", messageAdminExige: undefined })).toMatchObject({ ok: false, message: "sans derogation" });
  });

  it("derogation motivee d'un ADMIN : accordee, et rendue sans espaces de bord", () => {
    expect(verifierSeparation({ ...base, role: "ADMIN", derogation: "  motif suffisamment long  " })).toEqual({ ok: true, derogation: "motif suffisamment long" });
  });

  it("quand l'ADMIN n'est pas exige, un non-ADMIN avec une derogation motivee passe", () => {
    expect(verifierSeparation({ ...base, adminExige: false, derogation: "motif suffisamment long" })).toEqual({ ok: true, derogation: "motif suffisamment long" });
  });
});

describe("equivalence avec les regles de RC-3 (aucun changement de comportement)", () => {
  const dec = { option: "PROTEGER" as const, proposeurId: "u1", acteurId: "u1", role: "GESTIONNAIRE", nbHabilites: 1 };

  it("decision : meme personne sans derogation, avec derogation d'un seul compte habilite, ou avec un second compte habilite", () => {
    expect(verifierSeparationDecision({ ...dec, derogation: undefined })).toMatchObject({ ok: false, status: 409, code: "SEPARATION_DES_TACHES" });
    expect(verifierSeparationDecision({ ...dec, derogation: "motif suffisamment long" })).toEqual({ ok: true, derogation: "motif suffisamment long" });
    const deux = verifierSeparationDecision({ ...dec, nbHabilites: 2, derogation: "motif suffisamment long" });
    expect(deux).toMatchObject({ ok: false, message: "Plusieurs comptes habilités existent : seul un administrateur peut déroger à la séparation des tâches." });
    expect(verifierSeparationDecision({ ...dec, nbHabilites: 2, role: "ADMIN", derogation: "motif suffisamment long" })).toMatchObject({ ok: true });
  });

  it("decision d'un deplacement de reseau : seul un ADMIN deroge, avec son message propre", () => {
    const r = verifierSeparationDecision({ ...dec, option: "DEPLACER_RESEAU", derogation: "motif suffisamment long" });
    expect(r).toMatchObject({ ok: false, message: "Le déplacement d'un réseau ne peut être approuvé par son proposant que par une dérogation d'un administrateur." });
  });

  it("decision : une autre personne que le proposant n'a rien a justifier", () => {
    expect(verifierSeparationDecision({ ...dec, acteurId: "u2", derogation: undefined })).toEqual({ ok: true, derogation: null });
  });

  it("cloture : le proposeur de la cloture ne clot pas sans derogation d'un ADMIN ; un autre compte, ou un proposeur inconnu, le peut", () => {
    const c = { acteurId: "u1", role: "GESTIONNAIRE", proposeurClotureId: "u1", derogation: "motif suffisamment long" };
    expect(verifierSeparationCloture(c)).toMatchObject({ ok: false, code: "SEPARATION_DES_TACHES" });
    expect(verifierSeparationCloture({ ...c, role: "ADMIN" })).toEqual({ ok: true, derogation: "motif suffisamment long" });
    expect(verifierSeparationCloture({ ...c, acteurId: "u2" })).toEqual({ ok: true, derogation: null });
    expect(verifierSeparationCloture({ ...c, proposeurClotureId: null })).toEqual({ ok: true, derogation: null });
  });
});
