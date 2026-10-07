import { describe, it, expect } from "vitest";
import { lireParametres, lireMessage, lireRoute, memeRoute, originePilote, cleFranchissement, lireStatutsFranchissements, couleurFranchissement } from "./EmbedCartePage";

/**
 * L'URL d'embed est un contrat avec l'intranet SharePoint (DigitalRoad DOA&A et Maintenance) :
 * une carte SANS parametre doit rester celle de tous les portails.
 */
describe("Parametres de la carte embarquee", () => {
  it("sans parametre : aucune couche forcee, aucun filtre, fond sombre", () => {
    expect(lireParametres("")).toEqual({ couches: [], ouvrage: null, troncon: null, etats: [], region: null, fond: "sombre", chantiersPrecis: false });
    expect(lireParametres("?chantiers=precis").chantiersPrecis).toBe(true);
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
    expect(lireMessage({ type: "agr-ouvrages", items: [{ id: "a", valide: true }, { id: "b", valide: "oui" }] }))
      .toEqual([{ id: "a", etat: undefined, marque: undefined, valide: true }, { id: "b", etat: undefined, marque: undefined }]);
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

describe("Fiches des franchissements (DOA_FRANCHISSEMENTS)", () => {
  it("cle = point milieu a 5 decimales, identique a celle de l'import SharePoint", () => {
    expect(cleFranchissement(10.123456, -13.9)).toBe("10.12346,-13.90000");
    expect(cleFranchissement(9.5, -10)).toBe("9.50000,-10.00000");
  });

  it("lit les statuts d'instruction, ignore les statuts inconnus et les messages etrangers", () => {
    expect(lireStatutsFranchissements({ type: "agr-ouvrages", items: [] })).toBeNull();
    expect(lireStatutsFranchissements(null)).toBeNull();
    const m = lireStatutsFranchissements({ type: "agr-franchissements", items: [
      { cle: "1.00000,2.00000", statut: "Ouvrage confirmé" }, { cle: "3.00000,4.00000", statut: "Fini" }, { statut: "Doublon" },
    ] });
    expect(m && Array.from(m.entries())).toEqual([["1.00000,2.00000", "Ouvrage confirmé"]]);
  });

  it("colore selon l'instruction DOA&A, sinon selon le classement OSM", () => {
    expect(couleurFranchissement("PONT_SANS_OUVRAGE")).toBe("#dc2626");
    expect(couleurFranchissement("PONT_BDRI_PROCHE_25M")).toBe("#16a34a");
    expect(couleurFranchissement("PONT_SANS_OUVRAGE", "À instruire")).toBe("#dc2626");
    expect(couleurFranchissement("PONT_SANS_OUVRAGE", "Ouvrage confirmé")).toBe("#2563eb");
    expect(couleurFranchissement("PONT_SANS_OUVRAGE", "Doublon")).toBe("#9ca3af");
  });
});
