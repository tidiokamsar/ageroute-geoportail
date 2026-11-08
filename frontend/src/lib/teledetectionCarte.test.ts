import { describe, expect, it } from "vitest";
import {
  CENTRE_GUINEE, COULEUR_STATUT, COULEUR_STATUT_INCONNU, EMPRISE_MAX_DEGRES, PLAFOND_MARQUEURS, STATUTS, ZOOM_INITIAL, ZOOM_MINIMUM_PROPOSITIONS,
  arrondirBbox, bboxAutour, bboxDeGeometrie, bboxDeGeometrieTexte, bboxDepuisChaine, bboxDepuisLimites, bboxEnChaine, bboxInclus, bboxTropLarge,
  bboxValide, bboxVersLimitesLeaflet, centreBbox, cleIcone, comparerPropositions, elargirBbox, empriseARecharger, etatZoom, formaterDate,
  libelleDate, libelleMarqueur, libellePriorite, libelleRattachement, libelleStatut, libelleType, ligneVersLatLng, limiterMarqueurs,
  lireProposition, lirePropositions, messageIllisibles, messagePlafond, positionsGeometrie, styleMarqueur, svgMarqueur, syntheseAffichage,
  tailleMarqueur, zoomOuverture, zoomSuffisant, chantierLisible, geometrieDessinable, lireGeoJsonCouche, lireTableauCouche, lireTroncature, messageCoucheInvalide,
  messageIgnores, messageTroncature, pointLatLonLisible, type Bbox, type PropositionCarte,
} from "./teledetectionCarte";

/** Toutes les donnees de ce fichier sont SYNTHETIQUES : aucune position ne decrit un lieu reel. */
const point = (id: string, lon: number, lat: number, props: Record<string, unknown> = {}) => ({
  type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [lon, lat] },
  properties: { id, type: "COUPURE_PROBABLE", statut: "A_VERIFIER", priorite: "HAUTE", rattachee: true, ...props },
});
const prop = (id: string, over: Partial<PropositionCarte> = {}): PropositionCarte => ({
  id, type: "COUPURE_PROBABLE", statut: "A_VERIFIER", priorite: "HAUTE", rattachee: true, position: [10, -11], surfaces: [], lignes: [], ...over,
});

describe("constantes d'ouverture", () => {
  it("reprennent le centre du geoportail ; le zoom de depart est NATIONAL (6), celui du geoportail est 7", () => {
    expect(CENTRE_GUINEE).toEqual([10.5, -10.8]);
    expect(ZOOM_INITIAL).toBe(6);
    expect(ZOOM_INITIAL).toBe(ZOOM_MINIMUM_PROPOSITIONS); // on ouvre au zoom le plus eloigne admis, pas en dessous
  });
  it("vue nationale : zoom minimal 6 et emprise de 10 degres (la Guinee, environ 7,5 x 5,7 degres, y tient)", () => {
    expect(ZOOM_MINIMUM_PROPOSITIONS).toBe(6);
    expect(EMPRISE_MAX_DEGRES).toBe(10);
    expect(bboxTropLarge([-15.1, 7.1, -7.6, 12.8])).toBe(false);
    expect(etatZoom(ZOOM_INITIAL, [-15.1, 7.1, -7.6, 12.8])).toEqual({ suffisant: true, raison: null });
  });
});

describe("bboxValide", () => {
  it.each([
    [[-13.8, 9.5, -13.5, 9.8], true],
    [[-13.5, 9.5, -13.5, 9.5], true], // un point : emprise degeneree mais valide
    [[-13.5, 9.5, -13.8, 9.8], false], // ouest > est
    [[-13.8, 9.8, -13.5, 9.5], false], // sud > nord
    [[-181, 9.5, -13.5, 9.8], false],
    [[-13.8, 9.5, 181, 9.8], false],
    [[-13.8, -91, -13.5, 9.8], false],
    [[-13.8, 9.5, -13.5, 91], false],
    [[NaN, 9.5, -13.5, 9.8], false],
    [[-13.8, 9.5, -13.5], false],
    [["-13.8", 9.5, -13.5, 9.8], false],
    [null, false],
    ["-13.8,9.5,-13.5,9.8", false],
  ])("%j -> %s", (b, attendu) => { expect(bboxValide(b)).toBe(attendu); });
});

describe("conversions de bbox", () => {
  it("arrondit a quatre decimales par defaut", () => {
    expect(arrondirBbox([-13.812345678, 9.512345678, -13.512345678, 9.812345678])).toEqual([-13.8123, 9.5123, -13.5123, 9.8123]);
  });
  it("transforme les limites d'une vue en bbox, ou rien si elles sont incoherentes", () => {
    expect(bboxDepuisLimites({ ouest: -13.81234, sud: 9.5, est: -13.5, nord: 9.8 })).toEqual([-13.8123, 9.5, -13.5, 9.8]);
    expect(bboxDepuisLimites({ ouest: -13.5, sud: 9.5, est: -13.8, nord: 9.8 })).toBeNull();
    expect(bboxDepuisLimites({ ouest: NaN, sud: 9.5, est: -13.8, nord: 9.8 })).toBeNull();
  });
  it("ecrit et relit la forme du parametre ?bbox=", () => {
    const b: Bbox = [-13.8, 9.5, -13.5, 9.8];
    expect(bboxEnChaine(b)).toBe("-13.8,9.5,-13.5,9.8");
    expect(bboxDepuisChaine("-13.8,9.5,-13.5,9.8")).toEqual(b);
    expect(bboxDepuisChaine(" -13.8 , 9.5 , -13.5 , 9.8 ")).toEqual(b);
  });
  it.each([["a,b,c,d"], ["1,2,3"], ["1,2,3,4,5"], [""], ["1,,3,4"], ["10,2,3,4"]])("refuse la chaine %j", (s) => {
    expect(bboxDepuisChaine(s)).toBeNull();
  });
  it("rend les limites sous la forme [[sud, ouest], [nord, est]] de Leaflet", () => {
    expect(bboxVersLimitesLeaflet([-13.8, 9.5, -13.5, 9.8])).toEqual([[9.5, -13.8], [9.8, -13.5]]);
  });
  it("donne le centre [lat, lon]", () => {
    expect(centreBbox([-14, 9, -12, 11])).toEqual([10, -13]);
  });
});

describe("inclusion et elargissement", () => {
  const grande: Bbox = [-14, 9, -12, 11];
  it("une emprise incluse (bords compris) est incluse ; une qui deborde ne l'est pas", () => {
    expect(bboxInclus([-13, 9.5, -12.5, 10], grande)).toBe(true);
    expect(bboxInclus(grande, grande)).toBe(true);
    expect(bboxInclus([-13, 9.5, -11.9, 10], grande)).toBe(false);
    expect(bboxInclus([-14.1, 9.5, -12.5, 10], grande)).toBe(false);
  });
  it("ajoute la marge de chaque cote", () => {
    expect(elargirBbox([-13, 10, -12, 11], 0.1)).toEqual([-13.1, 9.9, -11.9, 11.1]);
  });
  it("borne l'elargissement aux limites terrestres", () => {
    const e = elargirBbox([-179.9, 89.9, -179.5, 90], 0.5);
    expect(e[0]).toBeGreaterThanOrEqual(-180);
    expect(e[3]).toBeLessThanOrEqual(90);
  });
  it("n'ajoute pas de marge qui ferait depasser la taille maximale", () => {
    const vue: Bbox = [-16, 8, -6.2, 12]; // 9,8 degres de large : + 10 % chaque cote = 11,76
    expect(elargirBbox(vue, 0.1, EMPRISE_MAX_DEGRES)).toEqual(vue);
  });
  it("detecte une emprise trop large, en largeur comme en hauteur", () => {
    expect(bboxTropLarge([-16, 9, -5.9, 10])).toBe(true); // 10,1 de large
    expect(bboxTropLarge([-13, 9, -12, 19.1])).toBe(true); // 10,1 de haut
    expect(bboxTropLarge([-16, 9, -6.01, 10])).toBe(false); // 9,99
    expect(bboxTropLarge([-13, 9, -8, 18.99])).toBe(false);
  });
});

describe("zoom minimal", () => {
  it("suffit a partir du minimum et pas avant", () => {
    expect(zoomSuffisant(ZOOM_MINIMUM_PROPOSITIONS)).toBe(true);
    expect(zoomSuffisant(ZOOM_MINIMUM_PROPOSITIONS - 0.5)).toBe(false);
    expect(zoomSuffisant(18)).toBe(true);
  });
  it("ne suffit jamais pour une valeur non numerique", () => {
    expect(zoomSuffisant(NaN)).toBe(false);
    expect(zoomSuffisant(undefined as unknown as number)).toBe(false);
  });
  it("accepte un minimum different", () => {
    expect(zoomSuffisant(5, 5)).toBe(true);
    expect(zoomSuffisant(4, 5)).toBe(false);
  });
  it("etatZoom dit pourquoi : zoom d'abord, puis emprise", () => {
    expect(etatZoom(5, [-13, 9, -12, 10])).toEqual({ suffisant: false, raison: "zoom" });
    expect(etatZoom(10, [-23, 9, -12, 10])).toEqual({ suffisant: false, raison: "emprise" });
    expect(etatZoom(10, [-13, 9, -12, 10])).toEqual({ suffisant: true, raison: null });
    expect(etatZoom(10, null)).toEqual({ suffisant: true, raison: null });
  });
});

describe("empriseARecharger", () => {
  const vue: Bbox = [-13.5, 9.5, -13.0, 10.0];
  it("ne demande rien sous le zoom minimal", () => {
    expect(empriseARecharger({ chargee: null, courante: vue, zoom: ZOOM_MINIMUM_PROPOSITIONS - 1 })).toBeNull();
  });
  it("ne demande rien quand l'emprise est trop large pour le serveur", () => {
    expect(empriseARecharger({ chargee: null, courante: [-20, 5, -9, 12], zoom: 10 })).toBeNull();
  });
  it("demande la vue elargie quand rien n'est charge", () => {
    const e = empriseARecharger({ chargee: null, courante: vue, zoom: 10 });
    expect(e).not.toBeNull();
    expect(bboxInclus(vue, e as Bbox)).toBe(true);
    expect(e).toEqual(elargirBbox(vue));
  });
  it("ne recharge pas si la vue est incluse dans la derniere emprise chargee", () => {
    const chargee = elargirBbox(vue);
    const deplacee: Bbox = [-13.48, 9.52, -12.98, 10.0];
    expect(bboxInclus(deplacee, chargee)).toBe(true);
    expect(empriseARecharger({ chargee, courante: deplacee, zoom: 10 })).toBeNull();
  });
  it("ne recharge pas non plus quand on zoome dans l'emprise chargee", () => {
    const chargee = elargirBbox(vue);
    expect(empriseARecharger({ chargee, courante: [-13.3, 9.7, -13.2, 9.8], zoom: 12 })).toBeNull();
  });
  it("recharge quand la vue sort de l'emprise chargee", () => {
    const chargee = elargirBbox(vue);
    const loin: Bbox = [-12.5, 9.5, -12.0, 10.0];
    expect(empriseARecharger({ chargee, courante: loin, zoom: 10 })).toEqual(elargirBbox(loin));
  });
  it("recharge malgre l'inclusion si la derniere reponse etait tronquee", () => {
    const chargee = elargirBbox(vue);
    expect(empriseARecharger({ chargee, courante: [-13.3, 9.7, -13.2, 9.8], zoom: 12, tronquee: true })).not.toBeNull();
  });
});

describe("bboxAutour", () => {
  it("cadre un point", () => {
    expect(bboxAutour(10, -13, 0.1)).toEqual([-13.1, 9.9, -12.9, 10.1]);
  });
  it("refuse un point hors bornes ou non numerique", () => {
    expect(bboxAutour(95, 0)).toBeNull();
    expect(bboxAutour(NaN, 0)).toBeNull();
    expect(bboxAutour(10, -13, -1)).toBeNull();
  });
});

describe("geometries GeoJSON", () => {
  it("extrait les positions de chaque type et rien d'un type inconnu", () => {
    expect(positionsGeometrie({ type: "Point", coordinates: [-13, 9] })).toEqual([[-13, 9]]);
    expect(positionsGeometrie({ type: "LineString", coordinates: [[-13, 9], [-12, 10]] })).toHaveLength(2);
    expect(positionsGeometrie({ type: "Polygon", coordinates: [[[-13, 9], [-12, 9], [-12, 10], [-13, 9]]] })).toHaveLength(4);
    expect(positionsGeometrie({ type: "MultiPolygon", coordinates: [[[[-13, 9], [-12, 9], [-12, 10], [-13, 9]]]] })).toHaveLength(4);
    expect(positionsGeometrie({ type: "GeometryCollection", geometries: [] })).toEqual([]);
    expect(positionsGeometrie(null)).toEqual([]);
    expect(positionsGeometrie({ type: "Point" })).toEqual([]);
  });
  it("ecarte les positions hors bornes", () => {
    expect(positionsGeometrie({ type: "Point", coordinates: [-13, 95] })).toEqual([]);
    expect(positionsGeometrie({ type: "Point", coordinates: [200, 9] })).toEqual([]);
    expect(positionsGeometrie({ type: "Point", coordinates: ["a", 9] })).toEqual([]);
  });
  it("calcule l'emprise d'une ligne et d'un polygone", () => {
    expect(bboxDeGeometrie({ type: "LineString", coordinates: [[-13, 9], [-12, 10.5], [-12.5, 9.2]] })).toEqual([-13, 9, -12, 10.5]);
    expect(bboxDeGeometrie({ type: "Point", coordinates: [-13, 9] })).toEqual([-13, 9, -13, 9]);
    expect(bboxDeGeometrie({ type: "LineString", coordinates: [] })).toBeNull();
  });
  it("lit une geometrie portee en texte, et rend null si elle est illisible", () => {
    expect(bboxDeGeometrieTexte('{"type":"LineString","coordinates":[[-13,9],[-12,10]]}')).toEqual([-13, 9, -12, 10]);
    expect(bboxDeGeometrieTexte("{pas json")).toBeNull();
    expect(bboxDeGeometrieTexte("")).toBeNull();
    expect(bboxDeGeometrieTexte(null)).toBeNull();
  });
  it("passe d'une ligne [lon, lat] a [lat, lon], et ignore tout ce qui n'est pas une ligne", () => {
    expect(ligneVersLatLng('{"type":"LineString","coordinates":[[-13,9],[-12,10]]}')).toEqual([[9, -13], [10, -12]]);
    expect(ligneVersLatLng('{"type":"Point","coordinates":[-13,9]}')).toEqual([]);
    expect(ligneVersLatLng("{x")).toEqual([]);
    expect(ligneVersLatLng(null)).toEqual([]);
  });
});

describe("lireProposition", () => {
  it("lit un point (latitude et longitude dans le bon ordre)", () => {
    const l = lireProposition(point("p1", -13.2, 9.9));
    expect(l).toEqual({ ok: true, proposition: { id: "p1", type: "COUPURE_PROBABLE", statut: "A_VERIFIER", priorite: "HAUTE", rattachee: true, position: [9.9, -13.2], surfaces: [], lignes: [] } });
  });
  it("lit un polygone : contour dessine, repere au centre de son emprise", () => {
    const l = lireProposition({
      type: "Feature", properties: { id: "p2", type: "VEGETATION", statut: "EN_ATTENTE", priorite: "FAIBLE", rattachee: false },
      geometry: { type: "Polygon", coordinates: [[[-13, 9], [-12, 9], [-12, 11], [-13, 11], [-13, 9]]] },
    });
    expect(l.ok).toBe(true);
    if (l.ok) {
      expect(l.proposition.position).toEqual([10, -12.5]);
      expect(l.proposition.surfaces).toHaveLength(1);
      expect(l.proposition.surfaces[0]).toHaveLength(5);
      expect(l.proposition.surfaces[0][0]).toEqual([9, -13]);
      expect(l.proposition.lignes).toEqual([]);
    }
  });
  // E2E-EO-1 : l'API sert aussi des lignes (nouvelle route, coupure) ; la carte les declarait « illisibles ».
  describe("geometries valides servies par l'API (E2E-EO-1)", () => {
    const feat = (geometry: unknown) => ({ type: "Feature", properties: { id: "g", type: "NOUVELLE_ROUTE", statut: "A_VERIFIER", priorite: "HAUTE", rattachee: true }, geometry });
    const lue = (geometry: unknown) => { const l = lireProposition(feat(geometry)); if (!l.ok) throw new Error(l.raison); return l.proposition; };

    it("LineString : trait dessine ([lat, lon]), repere a mi-longueur du trace", () => {
      const p = lue({ type: "LineString", coordinates: [[-13, 9], [-12, 9], [-11, 9]] });
      expect(p.lignes).toEqual([[[9, -13], [9, -12], [9, -11]]]);
      expect(p.surfaces).toEqual([]);
      expect(p.position).toEqual([9, -12]);
    });
    it("LineString en L : le repere est SUR le trace (mi-longueur), pas au centre de l'emprise", () => {
      const p = lue({ type: "LineString", coordinates: [[-13, 9], [-13, 11], [-12, 11]] });
      // longueur 3, moitie 1,5 : a mi-chemin du premier segment (2) = 9 + 1,5 de latitude
      expect(p.position).toEqual([10.5, -13]);
    });
    it("MultiLineString : tous les traits sont dessines, le repere est au milieu du plus long", () => {
      const p = lue({ type: "MultiLineString", coordinates: [[[-13, 9], [-12.5, 9]], [[-11, 9], [-9, 9]]] });
      expect(p.lignes).toHaveLength(2);
      expect(p.position).toEqual([9, -10]);
    });
    it("MultiPolygon : toutes les surfaces sont dessinees, repere au centre de l'emprise de l'ensemble", () => {
      const p = lue({ type: "MultiPolygon", coordinates: [[[[-13, 9], [-12, 9], [-12, 10], [-13, 9]]], [[[-11, 10], [-10, 10], [-10, 11], [-11, 10]]]] });
      expect(p.surfaces).toHaveLength(2);
      expect(p.lignes).toEqual([]);
      expect(p.position).toEqual([10, -11.5]);
    });
    it("MultiPoint : un repere sur le premier point", () => {
      const p = lue({ type: "MultiPoint", coordinates: [[-13, 9], [-12, 10]] });
      expect(p.position).toEqual([9, -13]);
      expect(p.lignes).toEqual([]);
      expect(p.surfaces).toEqual([]);
    });
    it("GeometryCollection : lue membre par membre", () => {
      const p = lue({ type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [-13, 9] }, { type: "LineString", coordinates: [[-13, 9], [-12, 9]] }] });
      expect(p.lignes).toHaveLength(1);
      expect(p.position).toEqual([9, -12.5]);
    });
    it("ligne de longueur nulle (sommets confondus) : son seul lieu, sans NaN", () => {
      const p = lue({ type: "LineString", coordinates: [[-13, 9], [-13, 9]] });
      expect(p.position).toEqual([9, -13]);
    });
    it("lirePropositions ne compte AUCUNE illisible pour un melange Point, LineString, Polygon et leurs Multi", () => {
      const r = lirePropositions({
        features: [
          { ...feat({ type: "Point", coordinates: [-13, 9] }), properties: { id: "a" } },
          { ...feat({ type: "LineString", coordinates: [[-13, 9], [-12, 10]] }), properties: { id: "b" } },
          { ...feat({ type: "Polygon", coordinates: [[[-13, 9], [-12, 9], [-12, 10], [-13, 9]]] }), properties: { id: "c" } },
          { ...feat({ type: "MultiLineString", coordinates: [[[-13, 9], [-12, 10]]] }), properties: { id: "d" } },
          { ...feat({ type: "MultiPolygon", coordinates: [[[[-13, 9], [-12, 9], [-12, 10], [-13, 9]]]] }), properties: { id: "e" } },
        ],
      });
      expect(r.ignorees).toBe(0);
      expect(r.propositions.map((x) => x.id)).toEqual(["a", "b", "c", "d", "e"]);
    });
  });
  it("accepte une priorite sous la forme { niveau } de la liste (contrat §6)", () => {
    const l = lireProposition(point("p3", -13, 9, { priorite: { niveau: "MOYENNE", regle: "r" } }));
    expect(l.ok && l.proposition.priorite).toBe("MOYENNE");
  });
  it("ne devine pas une priorite absente, nulle ou inconnue", () => {
    for (const priorite of [undefined, null, "URGENTE", { niveau: null }, 3]) {
      const l = lireProposition(point("p4", -13, 9, { priorite }));
      expect(l.ok && l.proposition.priorite).toBeNull();
    }
  });
  it("ne devine pas le rattachement : seul un booleen compte", () => {
    expect((lireProposition(point("a", -13, 9, { rattachee: true })) as { proposition: PropositionCarte }).proposition.rattachee).toBe(true);
    expect((lireProposition(point("b", -13, 9, { rattachee: false })) as { proposition: PropositionCarte }).proposition.rattachee).toBe(false);
    expect((lireProposition(point("c", -13, 9, { rattachee: "oui" })) as { proposition: PropositionCarte }).proposition.rattachee).toBeNull();
    expect((lireProposition(point("d", -13, 9, { rattachee: undefined })) as { proposition: PropositionCarte }).proposition.rattachee).toBeNull();
  });
  it("convertit un identifiant numerique en texte", () => {
    const l = lireProposition(point("x", -13, 9, { id: 42 }));
    expect(l.ok && l.proposition.id).toBe("42");
  });
  it.each([
    ["sans identifiant", point("", -13, 9), "SANS_IDENTIFIANT"],
    ["identifiant blanc", point("   ", -13, 9), "SANS_IDENTIFIANT"],
    ["sans proprietes", { type: "Feature", geometry: { type: "Point", coordinates: [-13, 9] } }, "SANS_IDENTIFIANT"],
    ["sans geometrie", { type: "Feature", properties: { id: "z" }, geometry: null }, "GEOMETRIE_ABSENTE"],
    ["de type inconnu", { type: "Feature", properties: { id: "z" }, geometry: { type: "Cercle", coordinates: [[-13, 9], [-12, 10]] } }, "GEOMETRIE_NON_DESSINABLE"],
    ["ligne a un seul sommet", { type: "Feature", properties: { id: "z" }, geometry: { type: "LineString", coordinates: [[-13, 9]] } }, "POSITION_INVALIDE"],
    ["ligne sans coordonnees", { type: "Feature", properties: { id: "z" }, geometry: { type: "LineString" } }, "POSITION_INVALIDE"],
    ["ligne dont un sommet est hors bornes", { type: "Feature", properties: { id: "z" }, geometry: { type: "LineString", coordinates: [[-13, 9], [-12, 95], [-11, 9]] } }, "POSITION_INVALIDE"],
    ["multiligne vide", { type: "Feature", properties: { id: "z" }, geometry: { type: "MultiLineString", coordinates: [] } }, "POSITION_INVALIDE"],
    ["multiligne dont un trait est trop court", { type: "Feature", properties: { id: "z" }, geometry: { type: "MultiLineString", coordinates: [[[-13, 9], [-12, 10]], [[-11, 9]]] } }, "POSITION_INVALIDE"],
    ["multipolygone dont un anneau est trop court", { type: "Feature", properties: { id: "z" }, geometry: { type: "MultiPolygon", coordinates: [[[[-13, 9], [-12, 9]]]] } }, "POSITION_INVALIDE"],
    ["collection vide", { type: "Feature", properties: { id: "z" }, geometry: { type: "GeometryCollection", geometries: [] } }, "POSITION_INVALIDE"],
    ["point hors bornes", point("z", -13, 95), "POSITION_INVALIDE"],
    ["point sans coordonnees", { type: "Feature", properties: { id: "z" }, geometry: { type: "Point" } }, "POSITION_INVALIDE"],
    ["polygone a deux sommets", { type: "Feature", properties: { id: "z" }, geometry: { type: "Polygon", coordinates: [[[-13, 9], [-12, 9]]] } }, "POSITION_INVALIDE"],
  ])("ecarte une feature %s", (_nom, f, raison) => {
    expect(lireProposition(f)).toEqual({ ok: false, raison });
  });
  it("ecarte une valeur qui n'est pas une feature", () => {
    expect(lireProposition(null).ok).toBe(false);
    expect(lireProposition(42).ok).toBe(false);
  });
});

describe("lirePropositions", () => {
  it("compte ce qu'elle ecarte, sans le perdre en silence", () => {
    const r = lirePropositions({ features: [point("a", -13, 9), point("", -13, 9), point("b", -13, 95), point("c", -12, 10)] });
    expect(r.propositions.map((p) => p.id)).toEqual(["a", "c"]);
    expect(r.ignorees).toBe(2);
  });
  it("ecarte un identifiant en double", () => {
    const r = lirePropositions({ features: [point("a", -13, 9), point("a", -12, 10)] });
    expect(r.propositions).toHaveLength(1);
    expect(r.ignorees).toBe(1);
  });
  it("rend un resultat vide pour une collection vide, absente ou mal formee", () => {
    for (const fc of [{ features: [] }, {}, null, undefined, { features: "x" }]) {
      expect(lirePropositions(fc as never)).toEqual({ propositions: [], ignorees: 0 });
    }
  });
});

describe("ordre et plafond", () => {
  it("classe la priorite haute d'abord, puis A_VERIFIER, puis l'identifiant ; l'absence de priorite en dernier", () => {
    const l = [
      prop("e", { priorite: null }), prop("d", { priorite: "FAIBLE" }), prop("c", { priorite: "HAUTE", statut: "CONFIRMEE" }),
      prop("b", { priorite: "HAUTE", statut: "A_VERIFIER" }), prop("a", { priorite: "HAUTE", statut: "A_VERIFIER" }), prop("m", { priorite: "MOYENNE" }),
    ];
    expect([...l].sort(comparerPropositions).map((p) => p.id)).toEqual(["a", "b", "c", "m", "d", "e"]);
  });
  it("un statut inconnu passe apres les statuts connus de meme priorite", () => {
    const l = [prop("x", { statut: "BIZARRE" }), prop("y", { statut: "INFIRMEE" })];
    expect([...l].sort(comparerPropositions).map((p) => p.id)).toEqual(["y", "x"]);
  });
  it("ne tronque rien sous le plafond", () => {
    const r = limiterMarqueurs([prop("a"), prop("b")], 5);
    expect(r).toEqual({ affichees: [prop("a"), prop("b")], nonAffichees: 0 });
  });
  it("garde les plus prioritaires et compte le reste, sans le perdre", () => {
    const items = [prop("1", { priorite: "FAIBLE" }), prop("2", { priorite: "HAUTE" }), prop("3", { priorite: "MOYENNE" }), prop("4", { priorite: null })];
    const r = limiterMarqueurs(items, 2);
    expect(r.affichees.map((p) => p.id)).toEqual(["2", "3"]);
    expect(r.nonAffichees).toBe(2);
    expect(r.affichees.length + r.nonAffichees).toBe(items.length);
  });
  it("garde TOUJOURS la proposition selectionnee, meme de faible priorite", () => {
    const items = [prop("1", { priorite: "HAUTE" }), prop("2", { priorite: "HAUTE" }), prop("3", { priorite: "FAIBLE" })];
    const r = limiterMarqueurs(items, 2, "3");
    expect(r.affichees.map((p) => p.id).sort()).toEqual(["1", "3"]);
    expect(r.nonAffichees).toBe(1);
  });
  it("une selection absente des donnees ne change rien", () => {
    const items = [prop("1"), prop("2"), prop("3")];
    expect(limiterMarqueurs(items, 2, "inconnue").affichees).toHaveLength(2);
  });
  it("un plafond nul ne dessine rien et compte tout", () => {
    const r = limiterMarqueurs([prop("1"), prop("2")], 0);
    expect(r).toEqual({ affichees: [], nonAffichees: 2 });
  });
  it("le plafond par defaut est celui de la constante", () => {
    const items = Array.from({ length: PLAFOND_MARQUEURS + 7 }, (_, i) => prop(`p${String(i).padStart(4, "0")}`));
    const r = limiterMarqueurs(items);
    expect(r.affichees).toHaveLength(PLAFOND_MARQUEURS);
    expect(r.nonAffichees).toBe(7);
  });
  it("ne modifie pas le tableau recu", () => {
    const items = [prop("b"), prop("a")];
    limiterMarqueurs(items, 1);
    expect(items.map((p) => p.id)).toEqual(["b", "a"]);
  });
});

describe("messages", () => {
  it("dit combien de propositions ne sont pas affichees, et quoi faire", () => {
    expect(messagePlafond(12)).toBe("12 propositions non affichées, zoomez");
    expect(messagePlafond(1)).toBe("1 proposition non affichée, zoomez");
  });
  it("ne dit rien quand rien n'est cache", () => {
    expect(messagePlafond(0)).toBe("");
    expect(messagePlafond(-3)).toBe("");
    expect(messagePlafond(NaN)).toBe("");
  });
  it("dit combien de propositions sont illisibles", () => {
    expect(messageIllisibles(3)).toContain("3 propositions illisibles ignorées");
    expect(messageIllisibles(1)).toContain("1 proposition illisible ignorée");
    expect(messageIllisibles(0)).toBe("");
  });
  it("resume l'affichage, dont les non rattachees", () => {
    expect(syntheseAffichage([])).toBe("Aucune proposition affichée.");
    expect(syntheseAffichage([prop("a")])).toBe("1 proposition affichée.");
    expect(syntheseAffichage([prop("a"), prop("b", { rattachee: false }), prop("c", { rattachee: null })])).toBe("3 propositions affichées, dont 2 non rattachées à un tronçon.");
    expect(syntheseAffichage([prop("a", { rattachee: false })])).toBe("1 proposition affichée, dont 1 non rattachée à un tronçon.");
  });
});

describe("styleMarqueur : le statut et la priorite se lisent sans la couleur", () => {
  it("chaque statut connu a sa couleur ET son glyphe, tous differents", () => {
    const styles = STATUTS.map((s) => styleMarqueur(s, "HAUTE", true));
    expect(new Set(styles.map((s) => s.remplissage)).size).toBe(STATUTS.length);
    expect(new Set(styles.map((s) => s.glyphe)).size).toBe(STATUTS.length);
    for (const s of STATUTS) expect(styleMarqueur(s, "HAUTE", true).remplissage).toBe(COULEUR_STATUT[s]);
  });
  it("chaque priorite a sa forme, et l'absence de priorite a la sienne", () => {
    const formes = (["HAUTE", "MOYENNE", "FAIBLE", null] as const).map((p) => styleMarqueur("A_VERIFIER", p, true).forme);
    expect(formes).toEqual(["triangle", "losange", "cercle", "carre"]);
  });
  it("une priorite ne change jamais la couleur, un statut ne change jamais la forme", () => {
    expect(styleMarqueur("CONFIRMEE", "HAUTE", true).remplissage).toBe(styleMarqueur("CONFIRMEE", "FAIBLE", true).remplissage);
    expect(styleMarqueur("CONFIRMEE", "HAUTE", true).forme).toBe(styleMarqueur("INFIRMEE", "HAUTE", true).forme);
  });
  it("un statut inconnu a un style neutre, distinct de tous les statuts connus", () => {
    const s = styleMarqueur("BIZARRE", "HAUTE", true);
    expect(s.statutInconnu).toBe(true);
    expect(s.remplissage).toBe(COULEUR_STATUT_INCONNU);
    expect(Object.values(COULEUR_STATUT)).not.toContain(s.remplissage);
    expect(s.glyphe).toBe("point");
    expect(styleMarqueur("", null, null).statutInconnu).toBe(true);
  });
  it("seule une proposition rattachee n'a pas l'anneau pointille", () => {
    expect(styleMarqueur("A_VERIFIER", "HAUTE", true).anneauNonRattachee).toBe(false);
    expect(styleMarqueur("A_VERIFIER", "HAUTE", false).anneauNonRattachee).toBe(true);
    expect(styleMarqueur("A_VERIFIER", "HAUTE", null).anneauNonRattachee).toBe(true);
  });
  it("le blanc du glyphe tient 4,5:1 sur chaque couleur de statut", () => {
    const lum = (hex: string) => {
      const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    };
    for (const c of [...Object.values(COULEUR_STATUT), COULEUR_STATUT_INCONNU]) {
      expect(1.05 / (lum(c) + 0.05), c).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("svgMarqueur", () => {
  const svg = (s: string, p: PropositionCarte["priorite"], r: PropositionCarte["rattachee"], sel = false) => svgMarqueur(styleMarqueur(s, p, r), { selectionne: sel });
  it("est decoratif pour les technologies d'assistance", () => {
    expect(svg("A_VERIFIER", "HAUTE", true)).toContain('aria-hidden="true"');
    expect(svg("A_VERIFIER", "HAUTE", true)).toContain('focusable="false"');
  });
  it("dessine la forme de la priorite", () => {
    expect(svg("A_VERIFIER", "HAUTE", true)).toContain("<polygon points=\"16,4 27.5");
    expect(svg("A_VERIFIER", "MOYENNE", true)).toContain("<polygon points=\"16,4.5");
    expect(svg("A_VERIFIER", "FAIBLE", true)).toContain("<circle cx=\"16\" cy=\"16\" r=\"10.5\"");
    expect(svg("A_VERIFIER", null, true)).toContain("<rect");
  });
  it("porte la couleur du statut", () => {
    expect(svg("CONFIRMEE", "FAIBLE", true)).toContain(COULEUR_STATUT.CONFIRMEE);
    expect(svg("INFIRMEE", "FAIBLE", true)).toContain(COULEUR_STATUT.INFIRMEE);
  });
  it("ajoute l'anneau pointille aux seules non rattachees", () => {
    expect(svg("A_VERIFIER", "HAUTE", false)).toContain("stroke-dasharray");
    expect(svg("A_VERIFIER", "HAUTE", true)).not.toContain("stroke-dasharray");
  });
  it("ajoute le halo dore et agrandit la proposition selectionnee", () => {
    const normal = svg("A_VERIFIER", "HAUTE", true);
    const choisi = svg("A_VERIFIER", "HAUTE", true, true);
    expect(choisi).toContain("#f5a623");
    expect(normal).not.toContain("#f5a623");
    expect(choisi).toContain(`width="${tailleMarqueur(true)}"`);
    expect(normal).toContain(`width="${tailleMarqueur(false)}"`);
    expect(tailleMarqueur(true)).toBeGreaterThan(tailleMarqueur(false));
  });
  it("donne un dessin different pour chaque statut", () => {
    const dessins = STATUTS.map((s) => svg(s, "HAUTE", true).replace(/#[0-9a-f]{6}/g, ""));
    expect(new Set(dessins).size).toBe(STATUTS.length);
  });
  it("accepte une taille explicite", () => {
    expect(svgMarqueur(styleMarqueur("A_VERIFIER", "HAUTE", true), { taille: 16 })).toContain('width="16"');
  });
  it("la cle d'icone distingue tout ce qui change le dessin", () => {
    const base = prop("a");
    const cles = new Set([
      cleIcone(base, false), cleIcone(base, true), cleIcone({ ...base, statut: "CONFIRMEE" }, false),
      cleIcone({ ...base, priorite: "FAIBLE" }, false), cleIcone({ ...base, rattachee: false }, false),
    ]);
    expect(cles.size).toBe(5);
    expect(cleIcone({ ...base, rattachee: null }, false)).toBe(cleIcone({ ...base, rattachee: false }, false));
  });
});

describe("libelles accessibles", () => {
  it("nomme le type, le statut, la priorite et le rattachement", () => {
    expect(libelleMarqueur(prop("a"))).toBe("Coupure probable, à vérifier, priorité haute, rattachée à un tronçon");
    expect(libelleMarqueur(prop("a", { rattachee: false, statut: "CONFIRMEE", priorite: "FAIBLE", type: "INONDATION" })))
      .toBe("Inondation, confirmée, priorité faible, non rattachée à un tronçon");
  });
  it("dit l'absence de priorite et de rattachement au lieu de la masquer", () => {
    const l = libelleMarqueur(prop("a", { priorite: null, rattachee: null }));
    expect(l).toContain("priorité non établie");
    expect(l).toContain("rattachement non renseigné");
  });
  it("garde le code brut d'un type ou d'un statut inconnu", () => {
    expect(libelleType("PONT_EFFONDRE")).toBe("Pont effondre");
    expect(libelleType("")).toBe("Type non renseigné");
    expect(libelleStatut("BIZARRE")).toBe("statut BIZARRE");
    expect(libellePriorite(null)).toBe("priorité non établie");
    expect(libelleRattachement(null)).toBe("rattachement non renseigné");
  });
});

describe("dates", () => {
  it("lit la date telle qu'ecrite, sans decalage de fuseau", () => {
    expect(formaterDate("2026-10-23")).toBe("23/10/2026");
    expect(formaterDate("2026-10-23T23:59:59-05:00")).toBe("23/10/2026");
    expect(formaterDate("2026-10-23T00:00:00Z")).toBe("23/10/2026");
    expect(formaterDate(" 2026-01-02 ")).toBe("02/01/2026");
  });
  it.each([[null], [undefined], [""], ["hier"], ["2026-13-01"], ["2026-00-10"], ["2026-10-32"], ["23/10/2026"], ["2026-10-2"]])("refuse %j", (v) => {
    expect(formaterDate(v as string | null)).toBeNull();
  });
  it("ecrit « date inconnue » plutot que de masquer une date absente", () => {
    expect(libelleDate("Avant", "2026-09-15")).toBe("Avant (15/09/2026)");
    expect(libelleDate("Après", null)).toBe("Après (date inconnue)");
    expect(libelleDate("Après", "n'importe quoi")).toBe("Après (date inconnue)");
  });
});

describe("troncature serveur (contrat §5 : tronque et total)", () => {
  it("lit tronque et total quand ils sont bien formes", () => {
    expect(lireTroncature({ type: "FeatureCollection", features: [], tronque: true, total: 412 })).toEqual({ tronque: true, total: 412 });
    expect(lireTroncature({ type: "FeatureCollection", features: [], tronque: false, total: 3 })).toEqual({ tronque: false, total: 3 });
  });

  it.each([[null], [undefined], ["texte"], [{}], [{ features: [] }], [{ tronque: "oui", total: 3 }], [{ tronque: 1, total: 3 }]])(
    "ne devine rien quand le serveur n'a rien dit de lisible : %j",
    (v) => { expect(lireTroncature(v)).toBeNull(); },
  );

  it("un total illisible sans troncature n'est pas une troncature", () => {
    expect(lireTroncature({ tronque: false, total: "beaucoup" })).toBeNull();
    expect(lireTroncature({ tronque: false, total: -2 })).toBeNull();
  });

  it("MAIS une troncature annoncee avec un total illisible reste dite (jamais silencieuse)", () => {
    const t = lireTroncature({ tronque: true, total: "beaucoup" });
    expect(t).not.toBeNull();
    expect(t!.tronque).toBe(true);
    expect(Number.isNaN(t!.total)).toBe(true);
    expect(messageTroncature(t, 40)).toBe("Résultat tronqué par le serveur, total inconnu, seules les 40 plus prioritaires sont affichées : zoomez");
  });

  it("message : N au total, seules les M plus prioritaires sont affichees, zoomez", () => {
    expect(messageTroncature({ tronque: true, total: 412 }, 300)).toBe("412 propositions au total, seules les 300 plus prioritaires sont affichées : zoomez");
    expect(messageTroncature({ tronque: true, total: 2 }, 1)).toBe("2 propositions au total, seule la plus prioritaire est affichée : zoomez");
    expect(messageTroncature({ tronque: true, total: 5 }, 0)).toBe("5 propositions au total, aucune n'est affichée : zoomez");
  });

  it("aucun message quand la reponse n'est pas tronquee ou inconnue", () => {
    expect(messageTroncature({ tronque: false, total: 3 }, 3)).toBe("");
    expect(messageTroncature(null, 3)).toBe("");
    expect(messageTroncature(undefined, 3)).toBe("");
  });

  it("une reponse tronquee force le rechargement meme dans l'emprise chargee (zoomer ferait sinon manquer des propositions)", () => {
    const chargee: Bbox = [-13.83, 9.47, -13.47, 9.83];
    const dedans: Bbox = [-13.7, 9.6, -13.6, 9.7];
    expect(empriseARecharger({ chargee, courante: dedans, zoom: 12 })).toBeNull();
    expect(empriseARecharger({ chargee, courante: dedans, zoom: 12, tronquee: true })).toEqual(elargirBbox(dedans));
  });
});

describe("couches optionnelles : validation avant Leaflet", () => {
  const polygone = { type: "Polygon", coordinates: [[[-13.7, 9.6], [-13.6, 9.6], [-13.6, 9.7], [-13.7, 9.6]]] };
  const trait = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[-13.7, 9.6], [-13.6, 9.7]] } };

  it.each([
    ["{}", {}],
    ["null", null],
    ["undefined", undefined],
    ["une page HTML (repli SPA)", "<!doctype html><html></html>"],
    ["un nombre", 42],
    ["un tableau", []],
    ["FeatureCollection sans features", { type: "FeatureCollection" }],
    ["FeatureCollection dont features n'est pas un tableau", { type: "FeatureCollection", features: {} }],
    ["Feature a geometrie nulle", { type: "Feature", properties: {}, geometry: null }],
    ["Feature a geometrie sans position", { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [] } }],
    ["type inconnu", { type: "Truc", coordinates: [1, 2] }],
    ["FeatureCollection dont aucun element n'est lisible", { type: "FeatureCollection", features: [{ type: "Feature", geometry: null }, { type: "Feature", geometry: { type: "Foo", coordinates: [] } }] }],
  ])("refuse %s", (_nom, donnees) => {
    const l = lireGeoJsonCouche(donnees);
    expect(l.ok).toBe(false);
    if (!l.ok) expect(l.raison.length).toBeGreaterThan(0);
  });

  it("accepte une Feature, une geometrie seule et une collection vide (rien en base : pas une anomalie)", () => {
    expect(lireGeoJsonCouche(trait)).toMatchObject({ ok: true, ignores: 0 });
    expect(lireGeoJsonCouche(polygone)).toMatchObject({ ok: true, ignores: 0 });
    expect(lireGeoJsonCouche({ type: "FeatureCollection", features: [] })).toMatchObject({ ok: true, ignores: 0 });
  });

  it("collection mixte : ecarte et COMPTE les elements illisibles, garde les autres", () => {
    const l = lireGeoJsonCouche({
      type: "FeatureCollection",
      features: [trait, { type: "Feature", properties: {}, geometry: null }, { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [NaN, 3] } }, null],
    });
    expect(l.ok).toBe(true);
    if (l.ok) {
      expect(l.ignores).toBe(3);
      expect((l.donnees as GeoJSON.FeatureCollection).features).toHaveLength(1);
    }
  });

  it("geometrieDessinable : type connu, positions finies et bornees, au moins une position", () => {
    expect(geometrieDessinable({ type: "Point", coordinates: [-13.7, 9.6] })).toBe(true);
    expect(geometrieDessinable({ type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [1, 2] }] })).toBe(true);
    expect(geometrieDessinable({ type: "GeometryCollection", geometries: [] })).toBe(false);
    expect(geometrieDessinable({ type: "Point", coordinates: [-13.7, 99] })).toBe(false);
    expect(geometrieDessinable({ type: "Point", coordinates: [-13.7] })).toBe(false);
    expect(geometrieDessinable({ type: "MultiPoint", coordinates: [] })).toBe(false);
    expect(geometrieDessinable(null)).toBe(false);
  });

  it("tableaux (ouvrages, chantiers) : un objet, null ou un texte sont refuses, une liste vide est valide", () => {
    for (const mauvais of [{}, null, undefined, "x", 3]) expect(lireTableauCouche(mauvais, pointLatLonLisible).ok).toBe(false);
    expect(lireTableauCouche([], pointLatLonLisible)).toEqual({ ok: true, donnees: [], ignores: 0 });
  });

  it("tableaux : les elements sans position finie sont ecartes et comptes ; tous illisibles : couche refusee", () => {
    const bon = { id: "o1", lat: 9.6, lon: -13.7 };
    const l = lireTableauCouche<typeof bon>([bon, { id: "o2", lat: null, lon: -13.7 }, { id: "o3", lat: "9.6", lon: -13.7 }, { lat: 9.6, lon: -13.7 }, null], pointLatLonLisible);
    expect(l).toEqual({ ok: true, donnees: [bon], ignores: 4 });
    expect(lireTableauCouche([{ id: "x" }, { id: "y", lat: 200, lon: 0 }], pointLatLonLisible).ok).toBe(false);
  });

  it("chantierLisible ne demande qu'un identifiant (la position est controlee au dessin)", () => {
    expect(chantierLisible({ id: "c1" })).toBe(true);
    expect(chantierLisible({ id: 7 })).toBe(true);
    expect(chantierLisible({})).toBe(false);
    expect(chantierLisible(null)).toBe(false);
  });

  it("messages : couche invalide et elements ignores", () => {
    expect(messageCoucheInvalide("Limites administratives", "réponse vide")).toBe("Données de la couche « Limites administratives » invalides : couche ignorée (réponse vide).");
    expect(messageIgnores(0)).toBe("");
    expect(messageIgnores(1)).toBe("1 élément illisible ignoré");
    expect(messageIgnores(3)).toBe("3 éléments illisibles ignorés");
  });
});

describe("zoomOuverture : la vue d'ouverture la plus nationale que le serveur admet", () => {
  // Largeur d'un conteneur de `px` pixels au zoom z, en degres de longitude : px * 360 / (256 * 2^z).
  const largeurDeg = (px: number, z: number) => (px * 360) / (256 * 2 ** z);
  const tropLarge = (px: number) => (z: number) => largeurDeg(px, z) > EMPRISE_MAX_DEGRES;

  it("un conteneur etroit ouvre au zoom 6 (la Guinee entiere) ; un conteneur plus large s'approche d'un cran, jamais plus que necessaire", () => {
    expect(zoomOuverture(tropLarge(323))).toBe(6); // 7,1 degres
    expect(zoomOuverture(tropLarge(453))).toBe(6); // 9,96 degres : sous la borne de 10
    expect(zoomOuverture(tropLarge(470))).toBe(7); // 10,3 degres au zoom 6 : trop large, 5,2 au zoom 7
    expect(zoomOuverture(tropLarge(900))).toBe(7);
    expect(zoomOuverture(tropLarge(1000))).toBe(8);
  });
  it("la vue retenue n'est JAMAIS plus large que la borne (sinon la carte afficherait « Zoomez » des l'ouverture)", () => {
    for (const px of [200, 323, 453, 470, 640, 900, 1200, 1900]) {
      const z = zoomOuverture(tropLarge(px));
      expect(largeurDeg(px, z), `${px} px`).toBeLessThanOrEqual(EMPRISE_MAX_DEGRES);
      expect(z).toBeGreaterThanOrEqual(ZOOM_INITIAL);
    }
  });
  it("s'arrete au maximum fourni : un conteneur sans fin ne boucle pas", () => {
    expect(zoomOuverture(() => true, 6, 9)).toBe(9);
    expect(zoomOuverture(() => false, 6, 9)).toBe(6);
  });
});
