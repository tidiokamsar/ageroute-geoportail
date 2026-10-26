import { describe, expect, it } from "vitest";
import {
  BBOX_COTE_MAX_DEG, bornesFiltre, decoderCurseur, encoderCurseur, formerProposition, lireBbox, lireDateIso, lireFiltresGeo, lireFiltresProduits, lireFiltresPropositions,
  lireFiltresSynthese, verifierDemandeSynchro, verifierEmpriseProduit, verifierGeometrieDepot, REGLE_PRIORITE_ABSENTE, type LignePropositionBase,
} from "./api.noyau";

/**
 * Noyau de l'API : ce que ces tests defendent est que CHAQUE entree est ou bien formee ou refusee avec une phrase -- jamais ignoree
 * (`?statut=` qui ne filtrait rien), jamais une erreur serveur (coordonnees en texte, polygone auto-intersecte, an 2999).
 */

const MAINTENANT = new Date("2026-10-25T12:00:00Z");
const ID = "11111111-1111-4111-8111-111111111111";

describe("dates", () => {
  const b = bornesFiltre(MAINTENANT);
  it("accepte une date ISO et une date-heure avec fuseau", () => {
    expect(lireDateIso("2026-10-01", "d", b)).toEqual({ ok: true, valeur: new Date("2026-10-01T00:00:00Z") });
    expect(lireDateIso("2026-10-01T10:30:00+02:00", "d", b)).toMatchObject({ ok: true });
  });
  it("refuse l'an 2999, l'an 1, un jour inexistant, un format libre, du vide", () => {
    for (const t of ["2999-01-01", "0001-01-01", "2026-02-31", "demain", "2026-10-01T10:00:00", "", "  ", "1e9"]) {
      expect(lireDateIso(t, "d", b).ok, t).toBe(false);
    }
    expect(lireDateIso(12345, "d", b).ok).toBe(false);
  });
  it("une date sans heure en borne haute vaut la fin de ce jour", () => {
    expect(lireDateIso("2026-10-01", "d", b, true)).toEqual({ ok: true, valeur: new Date("2026-10-01T23:59:59.999Z") });
  });
});

describe("filtres de la liste", () => {
  it("normalise statut en liste : valeur seule, virgule, tableau (statut[]=X)", () => {
    expect(lireFiltresPropositions({ statut: "A_VERIFIER" }, MAINTENANT)).toMatchObject({ ok: true, valeur: { statut: ["A_VERIFIER"], limite: 25 } });
    expect(lireFiltresPropositions({ statut: "A_VERIFIER,CONFIRMEE" }, MAINTENANT)).toMatchObject({ ok: true, valeur: { statut: ["A_VERIFIER", "CONFIRMEE"] } });
    expect(lireFiltresPropositions({ statut: ["A_VERIFIER", "A_VERIFIER", "INFIRMEE"] }, MAINTENANT)).toMatchObject({ ok: true, valeur: { statut: ["A_VERIFIER", "INFIRMEE"] } });
  });
  it("REFUSE un filtre vide, inconnu, en objet : il ne s'ignore jamais", () => {
    for (const q of [{ statut: "" }, { statut: "BIDON" }, { statut: "A_VERIFIER," }, { statut: { a: "b" } }, { type: "GLISSEMENT" }, { priorite: "URGENTE" }, { rattachee: "peut-etre" }, { rattachee: "" }]) {
      expect(lireFiltresPropositions(q as never, MAINTENANT).ok, JSON.stringify(q)).toBe(false);
    }
  });
  it("refuse un parametre inconnu (sinon un filtre mal ecrit semblerait applique)", () => {
    const r = lireFiltresPropositions({ statuts: "A_VERIFIER" }, MAINTENANT);
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toMatch(/inconnu/);
  });
  it("borne la limite (1 a 100) et refuse le reste au lieu de le rogner", () => {
    expect(lireFiltresPropositions({ limite: "100" }, MAINTENANT)).toMatchObject({ ok: true, valeur: { limite: 100 } });
    for (const l of ["0", "101", "-1", "abc", "1.5", "1e3", ""]) expect(lireFiltresPropositions({ limite: l }, MAINTENANT).ok, l).toBe(false);
  });
  it("identifiants en UUID, regionId entier, q borne, dates dans les bornes, depuis <= jusqua", () => {
    expect(lireFiltresPropositions({ tronconId: "pas-un-uuid" }, MAINTENANT).ok).toBe(false);
    expect(lireFiltresPropositions({ tronconId: ID }, MAINTENANT).ok).toBe(true);
    expect(lireFiltresPropositions({ regionId: "x" }, MAINTENANT).ok).toBe(false);
    expect(lireFiltresPropositions({ q: "x".repeat(101) }, MAINTENANT).ok).toBe(false);
    expect(lireFiltresPropositions({ q: "a\u0000b" }, MAINTENANT).ok).toBe(false);
    expect(lireFiltresPropositions({ depuis: "2999-01-01" }, MAINTENANT).ok).toBe(false);
    expect(lireFiltresPropositions({ depuis: "2026-10-10", jusqua: "2026-10-01" }, MAINTENANT).ok).toBe(false);
    expect(lireFiltresPropositions({ rattachee: "false" }, MAINTENANT)).toMatchObject({ ok: true, valeur: { rattachee: false } });
  });
  it("lecture des filtres de synthese et de produits", () => {
    expect(lireFiltresSynthese({ regionId: "3", depuis: "2026-01-01" }, MAINTENANT)).toMatchObject({ ok: true, valeur: { regionId: 3 } });
    expect(lireFiltresSynthese({ nope: "1" }, MAINTENANT).ok).toBe(false);
    expect(lireFiltresProduits({ nature: "OPTIQUE", bbox: "-14.4,10.8,-14.2,11.0" }, MAINTENANT)).toMatchObject({ ok: true });
    expect(lireFiltresProduits({ nature: "SOLAIRE" }, MAINTENANT).ok).toBe(false);
  });
});

describe("curseur", () => {
  it("fait l'aller-retour", () => {
    const c = { d: "2026-10-02T00:00:00.000Z", id: ID };
    expect(decoderCurseur(encoderCurseur(c), MAINTENANT)).toEqual({ ok: true, valeur: c });
  });
  it("refuse tout ce qui n'est pas un curseur emis : texte, JSON etranger, champ en trop, date ou identifiant invalide", () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    for (const c of ["xxx", "!!!", "", "a".repeat(400), enc([1]), enc({ d: "2026-10-02T00:00:00.000Z" }), enc({ d: "hier", id: ID }), enc({ d: "2026-10-02T00:00:00.000Z", id: "1; DROP TABLE" }), enc({ d: "2026-10-02T00:00:00.000Z", id: ID, x: 1 })]) {
      expect(decoderCurseur(c, MAINTENANT).ok, c.slice(0, 20)).toBe(false);
    }
  });
});

describe("curseur : dates impossibles (constat EO-FIX-BACK 3)", () => {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  // Ces dates passaient le format et donnaient une erreur SQL (`::timestamp`) donc un 500.
  it.each([
    "0000-01-01T00:00:00.000Z", "0001-01-01T00:00:00.000Z", "1999-12-31T23:59:59.999Z", "2026-02-31T00:00:00.000Z",
    "2026-13-01T00:00:00.000Z", "2026-10-02T24:00:00.000Z", "9999-12-31T23:59:59.999Z", "2028-01-01T00:00:00.000Z",
  ])("refuse %s", (d) => {
    expect(decoderCurseur(enc({ d, id: ID }), MAINTENANT).ok).toBe(false);
  });
  it("accepte les bornes : 2000-01-01 et la fin de l'annee suivante", () => {
    expect(decoderCurseur(enc({ d: "2000-01-01T00:00:00.000Z", id: ID }), MAINTENANT).ok).toBe(true);
    expect(decoderCurseur(enc({ d: "2027-12-31T23:59:59.999Z", id: ID }), MAINTENANT).ok).toBe(true);
  });
  it("les filtres de propositions et de produits refusent un curseur impossible en 400 (jamais un 500)", () => {
    const c = enc({ d: "2026-02-31T00:00:00.000Z", id: ID });
    expect(lireFiltresPropositions({ curseur: c }, MAINTENANT).ok).toBe(false);
    expect(lireFiltresProduits({ curseur: c }, MAINTENANT).ok).toBe(false);
  });
});

describe("bbox", () => {
  it("accepte une emprise du globe de cote borne", () => {
    expect(lireBbox("-13.7,9.5,-13.4,9.8", 5)).toEqual({ ok: true, valeur: [-13.7, 9.5, -13.4, 9.8] });
  });
  it("refuse absente, mal formee, hors du globe, inversee, trop grande", () => {
    for (const b of [undefined, "", "1,2,3", "a,b,c,d", "-13.7,9.5,-13.4", "-200,0,10,10", "0,-95,10,10", "10,0,0,10", "0,10,10,0", "0,0,6,1", "0,0,1,6", "1e2,0,5,5", ["0,0,1,1"]]) {
      expect(lireBbox(b, 5).ok, String(b)).toBe(false);
    }
  });
  it("la requete GeoJSON admet une emprise de 10 degres de cote au plus (vue nationale), pas davantage", () => {
    expect(BBOX_COTE_MAX_DEG).toBe(10);
    // 9,99 passe (largeur ou hauteur), 10,01 est refuse : la borne est la constante, aucune copie.
    expect(lireFiltresGeo({ bbox: "-15,7,-5.01,12" }).ok).toBe(true);
    expect(lireFiltresGeo({ bbox: "-15,7,-5,12" }).ok).toBe(true);
    expect(lireFiltresGeo({ bbox: "-15,2,-8,11.99" }).ok).toBe(true);
    const large = lireFiltresGeo({ bbox: "-15,7,-4.99,12" });
    expect(large.ok).toBe(false);
    expect(lireFiltresGeo({ bbox: "-15,2,-8,12.01" }).ok).toBe(false);
    if (!large.ok) expect(large.message).toContain("10 degres");
    // la Guinee entiere (environ 7,5 x 5,7 degres) tient dans une seule requete
    expect(lireFiltresGeo({ bbox: "-15.1,7.1,-7.6,12.8" }).ok).toBe(true);
  });
  it("le GeoJSON ne rend jamais plus de 1000 et par defaut 300", () => {
    expect(lireFiltresGeo({ bbox: "0,0,1,1" })).toMatchObject({ ok: true, valeur: { limite: 300 } });
    expect(lireFiltresGeo({ bbox: "0,0,1,1", limite: "1001" }).ok).toBe(false);
    expect(lireFiltresGeo({ statut: "A_VERIFIER" }).ok).toBe(false);
  });
});

describe("geometrie deposee", () => {
  const carre = [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]];
  it("accepte les six types bien formes", () => {
    for (const g of [
      { type: "Point", coordinates: [-13.6, 9.64] }, { type: "MultiPoint", coordinates: [[0, 0], [1, 1]] }, { type: "LineString", coordinates: [[0, 0], [1, 1]] },
      { type: "MultiLineString", coordinates: [[[0, 0], [1, 1]]] }, { type: "Polygon", coordinates: carre }, { type: "MultiPolygon", coordinates: [carre] },
    ]) expect(verifierGeometrieDepot(g).ok, g.type).toBe(true);
  });
  it("refuse coordinates en texte ou absentes, type inconnu, GeometryCollection", () => {
    for (const g of [
      { type: "Point", coordinates: "9.6,-13.6" }, { type: "Point" }, { type: "Point", coordinates: null }, { type: "Triangle", coordinates: [[0, 0]] },
      { type: "GeometryCollection", geometries: [] }, null, "Point", [], { type: 5, coordinates: [0, 0] }, { coordinates: [0, 0] },
    ]) expect(verifierGeometrieDepot(g).ok, JSON.stringify(g)).toBe(false);
  });
  it("refuse positions hors du globe, non finies, en 3D, ou en texte", () => {
    for (const c of [[200, 0], [0, 95], [Number.NaN, 0], [Infinity, 0], [0, 0, 5], ["0", "0"], [0], []]) {
      expect(verifierGeometrieDepot({ type: "Point", coordinates: c }).ok, JSON.stringify(c)).toBe(false);
    }
  });
  it("refuse une ligne d'une position ou de positions identiques", () => {
    expect(verifierGeometrieDepot({ type: "LineString", coordinates: [[0, 0]] }).ok).toBe(false);
    expect(verifierGeometrieDepot({ type: "LineString", coordinates: [[1, 1], [1, 1]] }).ok).toBe(false);
  });
  it("refuse un polygone ouvert, d'aire nulle, ou AUTO-INTERSECTE (noeud papillon)", () => {
    expect(verifierGeometrieDepot({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }).ok).toBe(false);
    expect(verifierGeometrieDepot({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [2, 0], [0, 0]]] }).ok).toBe(false);
    expect(verifierGeometrieDepot({ type: "Polygon", coordinates: [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]] }).ok).toBe(false); // symetrique : aire nulle
    const papillon = { type: "Polygon", coordinates: [[[0, 0], [2, 2], [2, 0], [0, 1], [0, 0]]] }; // asymetrique : aire non nulle, aretes qui se croisent
    const r = verifierGeometrieDepot(papillon);
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toMatch(/auto-intersecte/);
  });
  it("refuse un polygone dont une pointe se replie sur elle-meme", () => {
    expect(verifierGeometrieDepot({ type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [1, 2], [1, 3], [1, 2], [0, 2], [0, 0]]] }).ok).toBe(false);
  });
  it("un MultiPolygon dont un seul polygone est invalide est refuse, et dit lequel", () => {
    const r = verifierGeometrieDepot({ type: "MultiPolygon", coordinates: [carre, [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]]] });
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toMatch(/polygone 2/);
  });
  it("emprise de produit : hors du globe, non fermee, Point, MultiPolygon de deux polygones -> refus ; Polygon valide -> accepte", () => {
    expect(verifierEmpriseProduit({ type: "Polygon", coordinates: carre }).ok).toBe(true);
    expect(verifierEmpriseProduit({ type: "Polygon", coordinates: [[[0, 0], [200, 0], [200, 1], [0, 1], [0, 0]]] }).ok).toBe(false);
    expect(verifierEmpriseProduit({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }).ok).toBe(false);
    expect(verifierEmpriseProduit({ type: "Point", coordinates: [0, 0] }).ok).toBe(false);
    expect(verifierEmpriseProduit({ type: "MultiPolygon", coordinates: [carre, carre] }).ok).toBe(false);
    expect(verifierEmpriseProduit({ type: "Polygon", coordinates: [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]] }).ok).toBe(false);
    expect(verifierEmpriseProduit(undefined).ok).toBe(false);
  });
});

describe("demande de synchronisation", () => {
  const ok = { bbox: [-14.39, 10.83, -14.19, 11.03], depuis: "2026-09-25", jusqua: "2026-10-25", nuagesMax: 50 };
  it("accepte la zone de Boke sur 30 jours", () => {
    expect(verifierDemandeSynchro(ok, MAINTENANT)).toMatchObject({ ok: true, valeur: { nuagesMax: 50 } });
  });
  it("borne la surface, la fenetre, les dates et les nuages", () => {
    const cas: Partial<typeof ok>[] = [
      { bbox: [-15, 9, -10, 12] }, { bbox: [-14.4, 10.8, -14.2] } as never, { depuis: "2026-10-25", jusqua: "2026-09-25" }, { depuis: "2026-01-01", jusqua: "2026-10-25" },
      { depuis: "1999-01-01" }, { jusqua: "2999-01-01" }, { nuagesMax: 101 }, { nuagesMax: -1 }, { nuagesMax: "50" as never }, { nuagesMax: undefined as never },
    ];
    for (const c of cas) expect(verifierDemandeSynchro({ ...ok, ...c }, MAINTENANT).ok, JSON.stringify(c)).toBe(false);
  });
});

describe("mise en forme d'une proposition", () => {
  const base: LignePropositionBase = {
    id: ID, type: "INONDATION", statut: "A_VERIFIER", prioriteNiveau: null, prioriteRegle: null, confianceDetection: null, confianceCalibree: false,
    imageCouvertureNuagesPct: null, imageNote: null, rattachementConfiance: null, rattachementAlgorithme: null, distanceTronconM: null,
    methode: "seuil-sar v0", methodeNom: null, methodeVersion: null, missionId: null, synthetique: false, regionId: null,
    produitId: ID, dateObservation: new Date("2026-10-02T00:00:00Z"), dateReference: null, sourceCode: null, sourceLibelle: "Sentinel-1 GRD",
    produitCapteur: null, resolutionM: 10, resolutionNativeM: null, fournisseur: null, identifiantFournisseur: null, collection: null, cycleVie: "CATALOGUE",
    produitSynthetique: false, sourceNom: null, sourceCapteur: null, sourceResolutionM: null, tronconId: null, tronconCode: null, tronconNom: null, regionNom: null,
    lat: null, lon: null,
  };
  it("une ligne d'avant la migration ne fabrique ni priorite, ni confiance, ni rattachement", () => {
    const p = formerProposition(base);
    expect(p.priorite).toEqual({ niveau: null, regle: REGLE_PRIORITE_ABSENTE });
    expect(p.confianceDetection).toMatchObject({ valeur: null, calibree: false });
    expect(p.rattachement).toEqual({ confiance: "AUCUN", distanceM: null, algorithme: "NON_EVALUE" });
    expect(p.methode).toEqual({ nom: "seuil-sar v0", version: null });
    expect(p.qualiteImage).toEqual({ couvertureNuagesPct: null, note: null });
    expect(p.centre).toBeNull();
    expect(p.apercuDisponible).toBe(false);
    expect(p.rattachee).toBe(false);
    expect(p.troncon).toBeNull();
  });
  it("rattachee sans evaluation : confiance nulle (non evalue), jamais « faible » ni « aucun »", () => {
    expect(formerProposition({ ...base, tronconId: ID, tronconCode: "RN1", tronconNom: "Conakry-Kindia", regionId: 1, regionNom: "Conakry" }).rattachement.confiance).toBeNull();
  });
  it("l'indice de detection n'est jamais presente comme une probabilite", () => {
    const p = formerProposition({ ...base, confianceDetection: 0.87, prioriteNiveau: "HAUTE", prioriteRegle: "regle-1" });
    expect(p.confianceDetection).toMatchObject({ valeur: 0.87, calibree: false });
    expect(p.confianceDetection.signification).toMatch(/non calibre/);
    expect(p.priorite).toEqual({ niveau: "HAUTE", regle: "regle-1" });
  });
  it("la source dit D'OU viennent sa resolution et son capteur : native du produit, produit livre, ou source ; jamais un repli silencieux", () => {
    expect(formerProposition({ ...base, resolutionNativeM: 10, resolutionM: 20, produitCapteur: "MSI" }).source).toMatchObject({ resolutionM: 10, resolutionOrigine: "NATIVE_PRODUIT", capteur: "MSI", capteurOrigine: "PRODUIT" });
    // pas de resolution native : la resolution du produit LIVRE est rendue, et elle est etiquetee comme telle
    expect(formerProposition({ ...base, resolutionNativeM: null, resolutionM: 20 }).source).toMatchObject({ resolutionM: 20, resolutionOrigine: "PRODUIT_LIVRE" });
    // le capteur de la ligne de source remplace celui du produit absent : etiquete aussi
    expect(formerProposition({ ...base, produitCapteur: null, sourceCapteur: "OLI/OLI-2" }).source).toMatchObject({ capteur: "OLI/OLI-2", capteurOrigine: "SOURCE" });
    expect(formerProposition({ ...base, resolutionM: null, resolutionNativeM: null }).source).toMatchObject({ resolutionM: null, resolutionOrigine: null, capteur: null, capteurOrigine: null });
  });
  it("un produit de catalogue donne un apercu tentable, une donnee synthetique jamais", () => {
    const cat = { ...base, sourceCode: "SENTINEL2", identifiantFournisseur: "S2A_X", collection: "sentinel-2-l2a" };
    expect(formerProposition(cat).apercuDisponible).toBe(true);
    expect(formerProposition({ ...cat, produitSynthetique: true }).apercuDisponible).toBe(false);
  });
});
