import { describe, it, expect } from "vitest";
import { lireParametres } from "./EmbedCartePage";

/**
 * L'URL d'embed est un contrat avec l'intranet SharePoint (DigitalRoad DOA&A et Maintenance) :
 * une carte SANS parametre doit rester celle de tous les portails.
 */
describe("Parametres de la carte embarquee", () => {
  it("sans parametre : aucune couche forcee, aucun filtre", () => {
    expect(lireParametres("")).toEqual({ couches: null, ouvrage: null, troncon: null, etats: [], region: null });
  });

  it("lit les couches connues et ignore les autres", () => {
    expect(lireParametres("?couches=ouvrages").couches).toBe("ouvrages");
    expect(lireParametres("?couches=troncons").couches).toBe("troncons");
    expect(lireParametres("?couches=tout").couches).toBeNull();
  });

  it("decoupe les etats, en majuscules, sans vides", () => {
    expect(lireParametres("?etat=critique,%20MAUVAIS,,").etats).toEqual(["CRITIQUE", "MAUVAIS"]);
  });

  it("garde la region exacte et les identifiants", () => {
    const p = lireParametres("?region=N%C3%A9r%C3%A9kor%C3%A9&troncon=abc&ouvrage=def");
    expect(p.region).toBe("Nérékoré");
    expect(p.troncon).toBe("abc");
    expect(p.ouvrage).toBe("def");
  });
});
