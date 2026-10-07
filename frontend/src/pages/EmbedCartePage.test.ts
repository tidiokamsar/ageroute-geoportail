import { describe, it, expect } from "vitest";
import { lireParametres, lireMessage, lireRoute, memeRoute, originePilote } from "./EmbedCartePage";

/**
 * L'URL d'embed est un contrat avec l'intranet SharePoint (DigitalRoad DOA&A et Maintenance) :
 * une carte SANS parametre doit rester celle de tous les portails.
 */
describe("Parametres de la carte embarquee", () => {
  it("sans parametre : aucune couche forcee, aucun filtre, fond sombre", () => {
    expect(lireParametres("")).toEqual({ couches: [], ouvrage: null, troncon: null, etats: [], region: null, fond: "sombre" });
  });

  it("lit les couches connues, cumulables, et ignore les autres", () => {
    expect(lireParametres("?couches=ouvrages").couches).toEqual(["ouvrages"]);
    expect(lireParametres("?couches=troncons").couches).toEqual(["troncons"]);
    expect(lireParametres("?couches=troncons,ouvrages,troncons").couches).toEqual(["troncons", "ouvrages"]);
    expect(lireParametres("?couches=tout").couches).toEqual([]);
    expect(lireParametres("?couches=troncons,franchissements").couches).toEqual(["troncons", "franchissements"]);
  });

  it("decoupe les etats, en majuscules, sans vides", () => {
    expect(lireParametres("?etat=critique,%20MAUVAIS,,").etats).toEqual(["CRITIQUE", "MAUVAIS"]);
  });

  it("garde la region exacte, les identifiants et le fond", () => {
    const p = lireParametres("?region=N%C3%A9r%C3%A9kor%C3%A9&troncon=abc&ouvrage=def&fond=satellite");
    expect(p.region).toBe("Nérékoré");
    expect(p.troncon).toBe("abc");
    expect(p.ouvrage).toBe("def");
    expect(p.fond).toBe("satellite");
  });
});

describe("Pilotage par la page hote", () => {
  it("n'accepte que l'intranet AGEROUTE", () => {
    expect(originePilote("https://ageroutegn.sharepoint.com")).toBe(true);
    expect(originePilote("https://intranet.ageroute.gov.gn")).toBe(true);
    expect(originePilote("https://ageroutegn.sharepoint.com.evil.example")).toBe(false);
    expect(originePilote("http://ageroutegn.sharepoint.com")).toBe(false);
  });

  it("lit la liste des ouvrages, ignore les messages etrangers", () => {
    expect(lireMessage({ type: "autre", items: [] })).toBeNull();
    expect(lireMessage("texte")).toBeNull();
    expect(lireMessage({ type: "agr-ouvrages", items: [{ id: "AB-1", etat: "critique", marque: "urgence" }, { etat: "BON" }, { id: "c", marque: "x" }] }))
      .toEqual([{ id: "ab-1", etat: "CRITIQUE", marque: "urgence" }, { id: "c", etat: undefined, marque: undefined }]);
  });
});

describe("Route demandee par la page hote", () => {
  it("normalise la route et rapproche N2 des franchissements de RN2", () => {
    expect(lireRoute({ type: "agr-ouvrages", items: [], route: " rn 2 " })).toBe("RN2");
    expect(lireRoute({ type: "agr-ouvrages", items: [] })).toBeNull();
    expect(memeRoute("N2", "RN2")).toBe(true);
    expect(memeRoute("RN2", "RN2")).toBe(true);
    expect(memeRoute("N22", "RN2")).toBe(false);
    expect(memeRoute("", "RN2")).toBe(false);
  });
});
