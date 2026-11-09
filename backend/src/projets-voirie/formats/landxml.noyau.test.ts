import { describe, expect, it } from "vitest";
import type { FormesBrutes } from "../collecteur.noyau";
import { ErreurMetier } from "../erreurs";
import { ErreurLecture } from "../lecture.types";
import { choisirCrs, META_WGS84, type MetaCrs } from "./crs.noyau";
import { limitesCsv, limitesZip } from "./import.config";
import { detecter, inventorier, preparer, type LimitesImport, type ResultatImport } from "./lecture-import.noyau";
import {
  ArcDegenere, crsDeclareLandXml, lireNombres, pointsArc, preparerArc, segmentsArc, SEGMENTS_ARC_MAX, traverserLandXml, type OptionsLandXml,
} from "./landxml.noyau";
import type { Puits } from "./puits.noyau";
import { lireXml } from "../xml.noyau";

/**
 * Noyau LandXML (lot D1 ; CONTRAT-DOCUMENTS.md, section 7.1). Fixtures 100 % SYNTHETIQUES : axes inventes en metres autour d'une origine arbitraire
 * (380 000 E, 1 015 000 N, repere UTM 29N), aucun fichier d'un tiers. Rappel : LandXML ecrit « Nord Est ».
 */
const E0 = 380000, N0 = 1015000;
const ne = (e: number, n: number) => `${N0 + n} ${E0 + e}`;
const LIM: LimitesImport = { lecture: {}, zip: limitesZip(), csv: limitesCsv(), crsAutorises: [4326, 32628, 32629], landxml: { toleranceArcM: 0.01 } };
const META_UTM29: MetaCrs = { epsg: 32629, nom: "WGS 84 / UTM zone 29N", unite: "metre", geographique: false };
const VERS_DEGRES = (x: number, y: number) => [-10 + (x - E0) / 110000, 9.2 + (y - N0) / 110000];
const code = (f: () => unknown): string | null => { try { f(); } catch (e) { if (e instanceof ErreurLecture || e instanceof ErreurMetier) return e.code; throw e; } return null; };

const UNITES = `<Units><Metric linearUnit="meter" areaUnit="squareMeter" volumeUnit="cubicMeter" angularUnit="decimal degrees"/></Units>`;
function landxml(corps: string, o: { unites?: string; crs?: string; prologue?: string } = {}): string {
  return `${o.prologue ?? `<?xml version="1.0" encoding="UTF-8"?>`}<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">${o.unites ?? UNITES}${o.crs ?? ""}${corps}</LandXML>`;
}
const ligneXml = (a: [number, number], b: [number, number]) => `<Line><Start>${ne(...a)}</Start><End>${ne(...b)}</End></Line>`;
const arcXml = (s: [number, number], c: [number, number], e: [number, number], rot = "ccw", extra = "") => `<Curve rot="${rot}"${extra}><Start>${ne(...s)}</Start><Center>${ne(...c)}</Center><End>${ne(...e)}</End></Curve>`;
const axe = (nom: string, elements: string, extra = "") => `<Alignment name="${nom}" length="0" staStart="0">${extra}<CoordGeom>${elements}</CoordGeom></Alignment>`;
const alignements = (...axes: string[]) => `<Alignments name="Axes">${axes.join("")}</Alignments>`;

/** Puits qui garde ce qui lui est livre (coordonnees source, sans controle de zone). */
class Capture implements Puits {
  objets: { nom: string | null; attributs: Record<string, unknown>; formes: FormesBrutes; couche?: string }[] = [];
  lus = 0;
  comptes: Record<string, number> = {};
  compter(c: string, n = 1): void { this.comptes[c] = (this.comptes[c] ?? 0) + n; }
  elementIgnore(): void { /* sans objet */ }
  elementLu(): void { this.lus++; }
  ajouter(nom: string | null, attributs: Record<string, unknown>, formes: FormesBrutes, couche?: string): void { this.objets.push({ nom, attributs, formes, couche }); }
}
const traverser = (xml: string, o: OptionsLandXml = {}) => { const c = new Capture(); const r = traverserLandXml(lireXml(xml), c, o); return { c, r }; };

function lire(xml: string, epsgSource: number | null = 32629, lim = LIM): ResultatImport {
  const opts = epsgSource === null ? {} : { epsgSource };
  const p = preparer(detecter(Buffer.from(xml), "axes.xml", opts, lim), opts, lim);
  if (!p.besoinTransformation) return p.terminer(META_WGS84, null);
  const s = p.sommets!;
  const lon = new Float64Array(s.x.length), lat = new Float64Array(s.x.length);
  for (let i = 0; i < s.x.length; i++) [lon[i], lat[i]] = VERS_DEGRES(s.x[i], s.y[i]);
  return p.terminer(META_UTM29, "9.x.y", { lon, lat });
}

/** Fleche maximale (m) entre un arc (centre, rayon) et les cordes d'une polyligne de ses points. */
function flecheMax(pts: [number, number][], c: [number, number], r: number): number {
  let m = 0;
  for (let k = 1; k < pts.length; k++) {
    const mx = (pts[k - 1][0] + pts[k][0]) / 2, my = (pts[k - 1][1] + pts[k][1]) / 2;
    m = Math.max(m, r - Math.hypot(mx - c[0], my - c[1]));
  }
  return m;
}

describe("lecture des axes en plan : lignes et arcs (coordonnees « Nord Est » de la norme)", () => {
  it("un axe ligne + arc + ligne : un objet LIGNE continu, X = Est et Y = Nord, extremites exactes, attributs de l'axe", () => {
    const xml = landxml(alignements(axe("Axe A", ligneXml([0, 0], [100, 0]) + arcXml([100, 0], [100, 50], [150, 50]) + ligneXml([150, 50], [150, 150]))));
    const { c, r } = traverser(xml, { toleranceArcM: 0.01 });
    expect(c.objets).toHaveLength(1);
    const o = c.objets[0];
    expect(o.couche).toBe("alignements");
    expect(o.nom).toBe("Axe A");
    expect(o.formes.lignes).toHaveLength(1);
    const l = o.formes.lignes[0];
    expect(l[0]).toEqual([E0, N0]);
    expect(l[l.length - 1]).toEqual([E0 + 150, N0 + 150]);
    expect(o.attributs).toMatchObject({ name: "Axe A", nbElements: "3", nbArcs: "1", nbLignes: "2" });
    expect(r).toMatchObject({ nbAlignements: 1, nbLignes: 2, nbArcs: 1, nbDiscontinuites: 0 });
    // Quart de cercle de rayon 50 m, depart (100, 0), centre (100, 50) : sens anti-horaire, donc passage par l'est du centre.
    const milieu = l[Math.floor(l.length / 2)];
    expect(milieu[0] - E0).toBeGreaterThan(130);
  });

  it("arc anti-horaire et horaire : tous les points sur le cercle, sens respecte, fleche mesuree au plus egale a la tolerance", () => {
    const s: [number, number] = [0, -50], c: [number, number] = [0, 0], e: [number, number] = [50, 0];
    for (const tol of [0.001, 0.01, 0.1]) {
      for (const rot of ["ccw", "cw"]) {
        const a = preparerArc(s, c, e, rot, tol);
        const pts = pointsArc(s, c, e, a);
        expect(pts[0]).toEqual(s);
        expect(pts[pts.length - 1]).toEqual(e);
        for (const p of pts) expect(Math.abs(Math.hypot(p[0], p[1]) - 50)).toBeLessThan(1e-9);
        expect(flecheMax(pts, c, 50)).toBeLessThanOrEqual(tol + 1e-12);
        // ccw de (0,-50) a (50,0) : quart de tour (pi/2) ; cw : trois quarts de tour, par l'ouest.
        expect(Math.abs(a.balayage)).toBeCloseTo(rot === "ccw" ? Math.PI / 2 : (3 * Math.PI) / 2, 9);
        if (rot === "cw") expect(pts.some((p) => p[0] < -40)).toBe(true);
      }
    }
  });

  it("une tolerance plus fine donne plus de segments ; un tres grand rayon peu de segments ; jamais plus de SEGMENTS_ARC_MAX", () => {
    expect(segmentsArc(50, Math.PI / 2, 0.001)).toBeGreaterThan(segmentsArc(50, Math.PI / 2, 0.1));
    expect(segmentsArc(1e6, 0.0002, 0.01)).toBe(1);
    expect(segmentsArc(1, Math.PI, 5)).toBe(2);
  });

  it("IrregularLine (PntList2D) et elements disjoints : nouvelle partie sans raccord invente, comptee", () => {
    const irr = `<IrregularLine><Start>${ne(0, 0)}</Start><End>${ne(20, 10)}</End><PntList2D>${ne(0, 0)} ${ne(10, 5)} ${ne(20, 10)}</PntList2D></IrregularLine>`;
    const { c, r } = traverser(landxml(alignements(axe("Axe B", irr + ligneXml([30, 10], [40, 10])))));
    expect(c.objets[0].formes.lignes).toHaveLength(2);
    expect(c.objets[0].formes.lignes[0]).toEqual([[E0, N0], [E0 + 10, N0 + 5], [E0 + 20, N0 + 10]]);
    expect(r.nbDiscontinuites).toBe(1);
    expect(r.avertissements).toContainEqual(expect.objectContaining({ code: "LANDXML_DISCONTINUITES", nb: 1 }));
  });

  it("pntRef resolu dans les CgPoints ; introuvable : LANDXML_POINT_INTROUVABLE", () => {
    const pts = `<CgPoints><CgPoint name="P1">${ne(0, 0)}</CgPoint><CgPoint name="P2">${ne(10, 0)}</CgPoint></CgPoints>`;
    const ok = traverser(landxml(pts + alignements(axe("Axe R", `<Line><Start pntRef="P1"/><End pntRef="P2"/></Line>`))));
    expect(ok.c.objets.find((o) => o.couche === "alignements")!.formes.lignes[0]).toEqual([[E0, N0], [E0 + 10, N0]]);
    expect(code(() => traverser(landxml(pts + alignements(axe("Axe R", `<Line><Start pntRef="P1"/><End pntRef="P9"/></Line>`)))))).toBe("LANDXML_POINT_INTROUVABLE");
  });

  it("CgPoints : un objet POINT par point (couche cgpoints), Est puis Nord, altitude transmise au collecteur (qui l'ignore)", () => {
    const { c, r } = traverser(landxml(`<CgPoints><CgPoint name="B1" code="BORNE">${ne(5, 7)} 12.5</CgPoint><CgPoint name="B2">${ne(8, 9)}</CgPoint></CgPoints>`));
    expect(r.nbPoints).toBe(2);
    expect(c.objets.map((o) => o.couche)).toEqual(["cgpoints", "cgpoints"]);
    expect(c.objets[0].formes.points[0]).toEqual([E0 + 5, N0 + 7, 12.5]);
    expect(c.objets[0].attributs).toEqual({ name: "B1", code: "BORNE" });
  });
});

describe("ce qui est refuse : spirales, arcs degeneres, unites", () => {
  it("une spirale (ou une chaine) est REFUSEE avec un code type, jamais approchee ; l'inventaire la compte et previent", () => {
    const xml = landxml(alignements(axe("Axe S", ligneXml([0, 0], [100, 0]) + `<Spiral length="30" radiusStart="INF" radiusEnd="100" rot="cw" spiType="clothoid"><Start>${ne(100, 0)}</Start><PI>${ne(115, 0)}</PI><End>${ne(130, 2)}</End></Spiral>`)));
    expect(code(() => traverser(xml))).toBe("LANDXML_SPIRALE_NON_PRISE_EN_CHARGE");
    expect(code(() => lire(xml))).toBe("LANDXML_SPIRALE_NON_PRISE_EN_CHARGE");
    expect(code(() => traverser(landxml(alignements(axe("Axe C", `<Chain>P1 P2</Chain>`)))))).toBe("LANDXML_SPIRALE_NON_PRISE_EN_CHARGE");
    const inv = inventorier(detecter(Buffer.from(xml), "axes.xml", {}, LIM));
    expect(inv.avertissements).toContainEqual(expect.objectContaining({ code: "LANDXML_SPIRALES", nb: 1 }));
  });

  it("arc degenere : rayon nul, rayons incoherents, depart egal a l'arrivee, sens absent ou inconnu, coordonnee illisible : LANDXML_ARC_DEGENERE", () => {
    const cas: [string, string][] = [
      ["rayon nul", arcXml([0, 0], [0, 0], [10, 0])],
      ["rayons incoherents", arcXml([0, -50], [0, 0], [60, 0])],
      ["depart egal a l'arrivee", arcXml([0, -50], [0, 0], [0, -50])],
      ["sens absent", `<Curve><Start>${ne(0, -50)}</Start><Center>${ne(0, 0)}</Center><End>${ne(50, 0)}</End></Curve>`],
      ["sens inconnu", arcXml([0, -50], [0, 0], [50, 0], "gauche")],
      ["coordonnee illisible", `<Curve rot="cw"><Start>abc def</Start><Center>${ne(0, 0)}</Center><End>${ne(50, 0)}</End></Curve>`],
      ["centre absent", `<Curve rot="cw"><Start>${ne(0, -50)}</Start><End>${ne(50, 0)}</End></Curve>`],
    ];
    for (const [nom, el] of cas) {
      expect(code(() => traverser(landxml(alignements(axe("Axe D", el))))), nom).toBe("LANDXML_ARC_DEGENERE");
    }
    expect(() => preparerArc([0, 0], [0, 0], [1, 1], "cw", 0.01)).toThrow(ArcDegenere);
    // Le message ne recopie aucune coordonnee du fichier.
    try { traverser(landxml(alignements(axe("Axe D", arcXml([0, -50], [0, 0], [60, 0]))))); } catch (e) { expect((e as Error).message).not.toMatch(/\d{5,}/); }
  });

  it("unites absentes : UNITES_REQUISES ; pieds ou millimetres : LANDXML_UNITES_NON_SUPPORTEES (aucune mise a l'echelle) ; l'inventaire ne refuse pas", () => {
    const corps = alignements(axe("Axe U", ligneXml([0, 0], [10, 0])));
    expect(code(() => traverser(landxml(corps, { unites: "" })))).toBe("UNITES_REQUISES");
    expect(code(() => traverser(landxml(corps, { unites: `<Units><Imperial linearUnit="USSurveyFoot"/></Units>` })))).toBe("LANDXML_UNITES_NON_SUPPORTEES");
    expect(code(() => traverser(landxml(corps, { unites: `<Units><Metric linearUnit="millimeter"/></Units>` })))).toBe("LANDXML_UNITES_NON_SUPPORTEES");
    expect(traverser(landxml(corps, { unites: "" }), { inventaire: true }).r.unites).toBeNull();
  });
});

describe("CRS jamais deduit, liste blanche, projete en metres", () => {
  const xml = landxml(alignements(axe("Axe K", ligneXml([0, 0], [100, 0]))), { crs: `<CoordinateSystem name="UTM 29 synthetique" epsgCode="32629"/>` });

  it("sans epsgSource : CRS_REQUIS, meme quand le fichier declare un code EPSG", () => {
    expect(code(() => lire(xml, null))).toBe("CRS_REQUIS");
    expect(code(() => lire(landxml(alignements(axe("Axe K", ligneXml([0, 0], [100, 0])))), null))).toBe("CRS_REQUIS");
  });

  it("CRS demande different du CRS declare : CRS_CONFLIT ; hors liste blanche : CRS_NON_AUTORISE ; EPSG:4326 : CRS_INCOMPATIBLE_FORMAT", () => {
    expect(code(() => lire(xml, 32628))).toBe("CRS_CONFLIT");
    expect(code(() => choisirCrs("LANDXML", 2154, null, [4326, 32629]))).toBe("CRS_NON_AUTORISE");
    expect(code(() => choisirCrs("LANDXML", 4326, null, [4326, 32629]))).toBe("CRS_INCOMPATIBLE_FORMAT");
    expect(choisirCrs("LANDXML", 32629, { nom: "x", epsg: 32629 }, [4326, 32629])).toEqual({ epsg: 32629, origine: "choisi_par_utilisateur", transformer: true });
  });

  it("un CRS geographique de la liste blanche (lu dans spatial_ref_sys) est refuse a la fin de la lecture : CRS_INCOMPATIBLE_FORMAT", () => {
    const lim = { ...LIM, crsAutorises: [4326, 4269, 32629] };
    const p = preparer(detecter(Buffer.from(xml.replace(` epsgCode="32629"`, "")), "axes.xml", { epsgSource: 4269 }, lim), { epsgSource: 4269 }, lim);
    const s = p.sommets!;
    expect(code(() => p.terminer({ epsg: 4269, nom: "NAD83", unite: "degre", geographique: true }, null, { lon: s.x, lat: s.y }))).toBe("CRS_INCOMPATIBLE_FORMAT");
  });

  it("le CRS declare est montre par l'inventaire, sans valoir confirmation (choix obligatoire, aucune norme du format)", () => {
    const inv = inventorier(detecter(Buffer.from(xml), "axes.xml", {}, LIM));
    expect(inv.format).toBe("LANDXML");
    expect(inv.crs).toEqual({ normeDuFormat: null, declareDansLeFichier: "EPSG:32629", choixObligatoire: true });
    expect(crsDeclareLandXml(lireXml(xml))).toEqual({ epsg: 32629, nom: "UTM 29 synthetique" });
  });
});

describe("parcours d'import complet (detection, inventaire, lecture, transformation, resume)", () => {
  const xml = landxml(
    `<CgPoints><CgPoint name="B1">${ne(5, 5)}</CgPoint></CgPoints>`
    + alignements(axe("Axe 1", ligneXml([0, 0], [100, 0]) + arcXml([100, 0], [100, 50], [150, 50])), axe("Axe 2", ligneXml([0, 30], [80, 30]), `<Profile name="PL"/>`))
    + `<Surfaces><Surface name="TN"/><Surface name="Projet"/></Surfaces><Parcels/>`,
  );

  it("detecte par le contenu (racine LandXML), quelle que soit l'extension ; couches stables alignements et cgpoints", () => {
    const d = detecter(Buffer.from(xml), "plan.txt", {}, LIM);
    expect(d.format).toBe("LANDXML");
    expect(d.avertissements).toContainEqual(expect.objectContaining({ code: "EXTENSION_INCOHERENTE" }));
    const inv = inventorier(d);
    expect(inv.couches.map((c) => [c.id, c.nbObjets])).toEqual([["alignements", 2], ["cgpoints", 1]]);
    expect(inv.avertissements).toContainEqual(expect.objectContaining({ code: "LANDXML_SURFACES_IGNOREES", nb: 2 }));
  });

  it("lecture avec epsgSource : deux LIGNE et un POINT en WGS 84, arcs discretises, surfaces, profils et autres elements ignores et comptes, resume.import.landxml", () => {
    const r = lire(xml, 32629);
    expect(r.format).toBe("LANDXML");
    expect(r.resume.parTypeGeom).toEqual({ LIGNE: 2, POINT: 1, POLYGONE: 0 });
    expect(r.crs).toMatchObject({ epsgSource: 32629, origine: "choisi_par_utilisateur", transformation: "ST_Transform" });
    const codes = r.avertissements.map((a) => a.code);
    for (const c of ["LANDXML_ARCS_DISCRETISES", "LANDXML_SURFACES_IGNOREES", "LANDXML_PROFILS_IGNORES", "LANDXML_ELEMENTS_IGNORES", "CRS_CHOISI_PAR_UTILISATEUR"]) expect(codes).toContain(c);
    expect(r.importInfo.landxml).toMatchObject({ toleranceArcM: 0.01, nbAlignements: 2, nbLignes: 2, nbArcs: 1, nbPoints: 1, nbSurfacesIgnorees: 2, nbProfilsIgnores: 1 });
    expect(r.importInfo.landxml!.sommetsArcs).toBeGreaterThan(10);
  });

  it("une couche choisie : seuls ses objets", () => {
    const opts = { epsgSource: 32629, couche: "cgpoints" };
    const p = preparer(detecter(Buffer.from(xml), "a.xml", opts, LIM), opts, LIM);
    const s = p.sommets!;
    const lon = new Float64Array(s.x.length), lat = new Float64Array(s.x.length);
    for (let i = 0; i < s.x.length; i++) [lon[i], lat[i]] = VERS_DEGRES(s.x[i], s.y[i]);
    expect(p.terminer(META_UTM29, null, { lon, lat }).resume.parTypeGeom).toEqual({ LIGNE: 0, POINT: 1, POLYGONE: 0 });
  });

  it("aucun axe ni point : FICHIER_VIDE (rien n'est invente)", () => {
    expect(code(() => lire(landxml(`<Surfaces><Surface name="TN"/></Surfaces>`)))).toBe("FICHIER_VIDE");
  });
});

describe("fichiers hostiles : XXE, entites, bombes", () => {
  it("entite externe (XXE) : DTD_REFUSEE avant toute lecture ; « billion laughs » : DTD_REFUSEE ; entite non definie : ENTITE_REFUSEE", () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE LandXML [<!ENTITY x SYSTEM "file:///etc/passwd">]><LandXML>${UNITES}<Alignments><Alignment name="&x;"/></Alignments></LandXML>`;
    expect(code(() => detecter(Buffer.from(xxe), "a.xml", {}, LIM))).toBe("DTD_REFUSEE");
    const rires = `<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]><LandXML>&c;</LandXML>`;
    expect(code(() => detecter(Buffer.from(rires), "a.xml", {}, LIM))).toBe("DTD_REFUSEE");
    expect(code(() => detecter(Buffer.from(`<LandXML>${UNITES}<CgPoints><CgPoint name="&passwd;">1 2</CgPoint></CgPoints></LandXML>`), "a.xml", {}, LIM))).toBe("ENTITE_REFUSEE");
    expect(code(() => detecter(Buffer.from(`<LandXML><Units/><!ENTITY x "y"></LandXML>`), "a.xml", {}, LIM))).toBe("DTD_REFUSEE");
  });

  it("bombe de sommets : un arc immense refuse sans allocation (plus de SEGMENTS_ARC_MAX segments) ; des milliers d'arcs refuses au plafond du fichier, en moins d'une seconde", () => {
    const geant = landxml(alignements(axe("Geant", arcXml([0, -1e7], [0, 0], [-1e7, 0], "ccw"))));
    expect(code(() => traverser(geant, { toleranceArcM: 0.001 }))).toBe("TROP_DE_SOMMETS");
    expect(segmentsArc(1e7, Math.PI * 1.5, 0.001)).toBeGreaterThan(SEGMENTS_ARC_MAX);
    // 2 000 arcs de 1 000 m de rayon a 1 mm de fleche (~2 500 sommets chacun) : 5 millions de sommets annonces, refus au plafond de 2 millions.
    const arcs = Array.from({ length: 2000 }, (_, k) => arcXml([0, -1000 + k * 0], [0, 0], [1000, 0], "cw")).join("");
    const t = performance.now();
    expect(code(() => traverser(landxml(alignements(axe("Bombe", arcs))), { toleranceArcM: 0.001, sommetsParObjet: 1_000_000, sommetsParFichier: 2_000_000 }))).toBe("TROP_DE_SOMMETS");
    expect(performance.now() - t).toBeLessThan(1500);
    // Plafond par axe (sommets par objet du socle) applique pendant la discretisation.
    expect(code(() => traverser(landxml(alignements(axe("Long", arcs.slice(0, 20 * arcXml([0, -1000], [0, 0], [1000, 0], "cw").length)))), { toleranceArcM: 0.001, sommetsParObjet: 10_000 }))).toBe("TROP_DE_SOMMETS");
  });

  it("nombres illisibles ou demesures : NaN, jamais evalues ; un champ de plus de 40 caracteres est illisible", () => {
    expect(lireNombres("1 2.5 -3e2 abc 1e999999")).toEqual([1, 2.5, -300, NaN, NaN]);
    expect(lireNombres(`${"9".repeat(41)} 4`)).toEqual([NaN, 4]);
  });

  it("racine autre que LandXML : le noyau la refuse ; un XML inconnu reste FORMAT_NON_SUPPORTE a la detection", () => {
    expect(code(() => traverserLandXml(lireXml("<Autre/>"), new Capture()))).toBe("FORMAT_NON_SUPPORTE");
    expect(code(() => detecter(Buffer.from("<LandXMLx/>"), "a.xml", {}, LIM))).toBe("FORMAT_NON_SUPPORTE");
  });
});
