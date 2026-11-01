import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NATIONAL, perimetreDeRegions, verifierTerritoire } from "./territoire.noyau";

/**
 * Controle d'acces territorial (A10) : la regle pure.
 *   - ADMIN et compte sans region : NATIONAL, rien n'est restreint (comportement d'avant) ;
 *   - compte regional : toutes les regions touchees doivent etre dans son perimetre ;
 *   - region inconnue : refusee a un compte regional, jamais deduite.
 */
describe("Le noyau ne depend de rien", () => {
  it("aucun import", () => {
    expect(readFileSync(join(__dirname, "territoire.noyau.ts"), "utf8")).not.toMatch(/^import /m);
  });
});

describe("perimetreDeRegions", () => {
  it("ADMIN est national meme avec des regions", () => expect(perimetreDeRegions("ADMIN", [3])).toEqual(NATIONAL));
  it("un compte sans region est national (resserrement a la demande d'AGEROUTE)", () => expect(perimetreDeRegions("GESTIONNAIRE", [])).toEqual(NATIONAL));
  it("un compte rattache est regional", () => {
    const p = perimetreDeRegions("INSPECTEUR", [3, 5]);
    expect(p.national).toBe(false);
    if (!p.national) expect([...p.regions].sort()).toEqual([3, 5]);
  });
});

describe("verifierTerritoire", () => {
  const regional = perimetreDeRegions("GESTIONNAIRE", [3, 5]);
  it("national : tout passe, region inconnue comprise", () => expect(verifierTerritoire(NATIONAL, [1, null, 9])).toEqual({ ok: true }));
  it("regional : dans le perimetre, passe", () => expect(verifierTerritoire(regional, [3, 5])).toEqual({ ok: true }));
  it("regional : une seule region hors perimetre suffit a refuser (deplacement d'une fiche vers une autre region)", () => {
    expect(verifierTerritoire(regional, [3, 7])).toMatchObject({ ok: false, code: "HORS_PERIMETRE" });
  });
  it("regional : region inconnue refusee, jamais deduite", () => {
    expect(verifierTerritoire(regional, [null])).toMatchObject({ ok: false, code: "REGION_INCONNUE" });
    expect(verifierTerritoire(regional, [undefined])).toMatchObject({ ok: false, code: "REGION_INCONNUE" });
  });
  it("regional : aucune region touchee (fiche introuvable, la route rendra son 404) : rien a refuser ici", () => {
    expect(verifierTerritoire(regional, [])).toEqual({ ok: true });
  });
});
