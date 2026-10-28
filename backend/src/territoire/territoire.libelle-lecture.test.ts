import { describe, expect, it } from "vitest";
import { perimetreDeRegions, verifierTerritoire } from "./territoire.noyau";

/**
 * Libelle du refus selon la nature de l'acces (relecture D9, point 7c) : une LECTURE hors perimetre (le rapport de qualite d'une
 * autre region) ne doit pas dire « ecriture ». Les libelles d'ecriture historiques sont inchanges (par defaut).
 */
describe("verifierTerritoire : libelle selon la nature de l'acces", () => {
  const regional = perimetreDeRegions("GESTIONNAIRE", [3]);

  it("ecriture (defaut) : libelles historiques inchanges", () => {
    expect(verifierTerritoire(regional, [7])).toEqual({ ok: false, code: "HORS_PERIMETRE", motif: "Cette ecriture touche une region hors de votre perimetre." });
    expect(verifierTerritoire(regional, [null])).toEqual({ ok: false, code: "REGION_INCONNUE", motif: "La region de cette fiche est inconnue : un compte regional ne peut pas l'ecrire." });
    expect(verifierTerritoire(regional, [7], "ecriture")).toEqual(verifierTerritoire(regional, [7]));
  });

  it("lecture : libelle neutre, memes codes, aucun mot « ecriture »", () => {
    const hors = verifierTerritoire(regional, [7], "lecture");
    const inconnue = verifierTerritoire(regional, [undefined], "lecture");
    expect(hors).toMatchObject({ ok: false, code: "HORS_PERIMETRE" });
    expect(inconnue).toMatchObject({ ok: false, code: "REGION_INCONNUE" });
    for (const v of [hors, inconnue]) expect(JSON.stringify(v)).not.toMatch(/ecri/i);
  });

  it("un compte national ou une region dans le perimetre passent, quelle que soit la nature", () => {
    expect(verifierTerritoire(regional, [3], "lecture")).toEqual({ ok: true });
    expect(verifierTerritoire(perimetreDeRegions("ADMIN", []), [7, null], "lecture")).toEqual({ ok: true });
  });
});
