import { describe, expect, it } from "vitest";
import { lireFichier, ErreurLecture, OBJETS_MAX, TAILLE_MAX_OCTETS } from "./lecture.noyau";
import { lireXml } from "./xml.noyau";

/** Fixtures 100 % synthetiques : coordonnees inventees autour de (-10,10 ; 9,18), aucun fichier d'un tiers. */
const kml = (corps: string, entete = "") =>
  Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">${entete}<Document>${corps}</Document></kml>`);
const pm = (nom: string, geom: string, extra = "") => `<Placemark><name>${nom}</name>${extra}${geom}</Placemark>`;
const ligne = (c: string) => `<LineString><coordinates>${c}</coordinates></LineString>`;
const code = (f: () => unknown) => { try { f(); } catch (e) { if (e instanceof ErreurLecture) return e.code; throw e; } return null; };

describe("xml.noyau : lecteur XML sans DTD ni entite", () => {
  it("lit elements, attributs, CDATA et entites predefinies", () => {
    const r = lireXml(`<?xml version="1.0"?><a x="1 &amp; 2"><b>t&lt;u</b><![CDATA[<br/>]]><gx:c y='z'/></a>`);
    expect(r.nom).toBe("a");
    expect(r.attrs.x).toBe("1 & 2");
    expect(r.enfants[0].texte).toBe("t<u");
    expect(r.texte).toBe("<br/>");
    expect(r.enfants[1].nom).toBe("c");
    expect(r.enfants[1].attrs.y).toBe("z");
  });
  it("refuse tout DOCTYPE et toute declaration d'entite (XXE, billion laughs)", () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY x SYSTEM "file:///etc/passwd">]><kml>&x;</kml>`;
    expect(() => lireXml(xxe)).toThrowError(/DTD/);
    expect(() => lireXml(`<!DOCTYPE a><a/>`)).toThrowError(/DTD/);
  });
  it("refuse une entite nommee hors des cinq predefinies", () => {
    expect(() => lireXml(`<a>&nbsp;</a>`)).toThrowError(/entite/);
    expect(() => lireXml(`<a>&#0;</a>`)).toThrowError(/reference/);
  });
  it("refuse un document mal forme, tronque, multi-racine ou trop profond", () => {
    expect(() => lireXml(`<a><b></a>`)).toThrow();
    expect(() => lireXml(`<a>`)).toThrow();
    expect(() => lireXml(`<a/><b/>`)).toThrow();
    expect(() => lireXml(`texte`)).toThrow();
    expect(() => lireXml("<a>".repeat(150) + "</a>".repeat(150))).toThrowError(/imbrication/);
  });
});

describe("lireFichier : KML", () => {
  it("lit Point, LineString, Polygon et MultiGeometry et ignore l'altitude 0", () => {
    const r = lireFichier(kml(
      pm("Axe 1", ligne("-10.10,9.18,0 -10.09,9.18,0 -10.08,9.181,0")) +
      pm("Poteau", `<Point><coordinates>-10.1,9.18,0</coordinates></Point>`) +
      pm("Place", `<Polygon><outerBoundaryIs><LinearRing><coordinates>-10.1,9.18 -10.09,9.18 -10.09,9.19 -10.1,9.19 -10.1,9.18</coordinates></LinearRing></outerBoundaryIs></Polygon>`) +
      pm("Mixte", `<MultiGeometry>${ligne("-10.1,9.2 -10.09,9.2")}${ligne("-10.1,9.21 -10.09,9.21")}<Point><coordinates>-10.1,9.2</coordinates></Point></MultiGeometry>`),
    ), "reseau.kml");
    expect(r.format).toBe("KML");
    expect(r.resume.nbObjets).toBe(5);
    expect(r.resume.parTypeGeom).toEqual({ LIGNE: 2, POINT: 2, POLYGONE: 1 });
    expect(r.objets[0].geometrie).toEqual({ type: "LineString", coordinates: [[-10.1, 9.18], [-10.09, 9.18], [-10.08, 9.181]] });
    const mixte = r.objets.filter((o) => o.nom === "Mixte");
    expect(mixte.map((o) => o.geometrie.type).sort()).toEqual(["MultiLineString", "Point"]);
    expect(r.avertissements.find((a) => a.code === "ALTITUDE_IGNOREE")).toBeUndefined();
    expect(r.resume.bbox).toEqual([-10.1, 9.18, -10.08, 9.21]);
  });

  it("signale l'altitude non nulle (nombre d'objets) et ne la conserve pas", () => {
    const r = lireFichier(kml(pm("A", ligne("-10.1,9.2,35 -10.09,9.2,40")) + pm("B", ligne("-10.1,9.3,0 -10.09,9.3,0"))), "a.kml");
    expect(r.avertissements).toContainEqual(expect.objectContaining({ code: "ALTITUDE_IGNOREE", nb: 1 }));
    expect(JSON.stringify(r.objets[0].geometrie)).not.toContain("35");
  });

  it("tolere l'extension Google Earth : gx:Track, gx:MultiTrack, espaces apres les virgules", () => {
    const r = lireFichier(kml(
      `<Placemark><name>Trace</name><gx:Track><gx:coord>-10.1 9.2 0</gx:coord><gx:coord>-10.09 9.2 0</gx:coord></gx:Track></Placemark>` +
      `<Placemark><name>Multi</name><gx:MultiTrack><gx:Track><gx:coord>-10.1 9.3 0</gx:coord><gx:coord>-10.09 9.3 0</gx:coord></gx:Track><gx:Track><gx:coord>-10.1 9.4 0</gx:coord><gx:coord>-10.09 9.4 0</gx:coord></gx:Track></gx:MultiTrack></Placemark>` +
      pm("Espaces", ligne("-10.1, 9.5, 0  -10.09, 9.5, 0")),
    ), "g.kml");
    expect(r.objets.map((o) => o.geometrie.type)).toEqual(["LineString", "MultiLineString", "LineString"]);
    expect(r.objets[2].geometrie).toEqual({ type: "LineString", coordinates: [[-10.1, 9.5], [-10.09, 9.5]] });
  });

  it("lit ExtendedData/Data, SchemaData/SimpleData, name, description et dossier, et tolere l'en-tete Schema", () => {
    const entete = `<Schema name="S" id="S"><SimpleField type="string" name="Statut"/></Schema>`;
    const corps = `<Folder><name>Secteur A</name><Folder><name>Fibre</name>` +
      pm("T1", ligne("-10.1,9.2 -10.09,9.2"),
        `<description><![CDATA[<b>gras</b> & texte]]></description><ExtendedData><Data name="capacite"><value>48 FO</value></Data><SchemaData schemaUrl="#S"><SimpleData name="Statut">pose</SimpleData></SchemaData></ExtendedData>`) +
      `</Folder></Folder>`;
    const r = lireFichier(kml(corps, entete), "s.kml");
    expect(r.objets[0].nom).toBe("T1");
    expect(r.objets[0].attributs).toEqual({
      name: "T1", description: "<b>gras</b> & texte", dossier: "Secteur A / Fibre", capacite: "48 FO", Statut: "pose",
    });
    expect(r.resume.attributsDetectes.map((a) => a.nom).sort()).toEqual(["Statut", "capacite", "description", "dossier", "name"]);
  });

  it("une donnee etendue qui porte le nom d'un champ de base ne l'ecrase pas", () => {
    const r = lireFichier(kml(pm("T", ligne("-10.1,9.2 -10.09,9.2"), `<ExtendedData><Data name="name"><value>autre</value></Data></ExtendedData>`)), "a.kml");
    expect(r.objets[0].attributs).toEqual({ name: "T", "name (donnees etendues)": "autre" });
  });

  it("refuse les entites XML et les DTD, sans les resoudre", () => {
    const xxe = Buffer.from(`<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY x SYSTEM "file:///etc/passwd">]><kml><Document><Placemark><name>&x;</name></Placemark></Document></kml>`);
    expect(code(() => lireFichier(xxe, "x.kml"))).toBe("DTD_REFUSEE");
    expect(code(() => lireFichier(Buffer.from(`<kml><Document><Placemark><name>&bomb;</name>${ligne("-10.1,9.2 -10.09,9.2")}</Placemark></Document></kml>`), "x.kml"))).toBe("ENTITE_REFUSEE");
  });

  it("ecarte sans nom un Placemark sans geometrie et signale les elements non pris en charge", () => {
    const r = lireFichier(kml(
      pm("Vide", "") + pm("Bon", ligne("-10.1,9.2 -10.09,9.2")) +
      `<NetworkLink><Link><href>http://exemple.invalid/x.kml</href></Link></NetworkLink><GroundOverlay><name>img</name></GroundOverlay>`,
    ), "a.kml");
    expect(r.resume.nbObjets).toBe(1);
    expect(r.avertissements).toContainEqual(expect.objectContaining({ code: "OBJETS_SANS_GEOMETRIE", nb: 1 }));
    expect(r.avertissements).toContainEqual(expect.objectContaining({ code: "ELEMENTS_KML_IGNORES", nb: 2 }));
  });

  it("refuse un fichier sans objet : FICHIER_VIDE", () => {
    expect(code(() => lireFichier(kml(""), "v.kml"))).toBe("FICHIER_VIDE");
    expect(code(() => lireFichier(kml(pm("Vide", "")), "v.kml"))).toBe("FICHIER_VIDE");
    expect(code(() => lireFichier(Buffer.alloc(0), "v.kml"))).toBe("FICHIER_VIDE");
    expect(code(() => lireFichier(Buffer.from("  \n "), "v.kml"))).toBe("FICHIER_VIDE");
  });

  it("refuse la geometrie degeneree : ligne a un point, anneau a deux points, coordonnees illisibles", () => {
    expect(code(() => lireFichier(kml(pm("L", ligne("-10.1,9.2"))), "g.kml"))).toBe("GEOMETRIE_INVALIDE");
    expect(code(() => lireFichier(kml(pm("L", ligne("-10.1,9.2 -10.1,9.2 -10.1,9.2"))), "g.kml"))).toBe("GEOMETRIE_INVALIDE");
    expect(code(() => lireFichier(kml(pm("L", ligne("abc,def ghi,jkl"))), "g.kml"))).toBe("GEOMETRIE_INVALIDE");
    expect(code(() => lireFichier(kml(pm("P", `<Polygon><outerBoundaryIs><LinearRing><coordinates>-10.1,9.2 -10.09,9.2</coordinates></LinearRing></outerBoundaryIs></Polygon>`)), "g.kml"))).toBe("GEOMETRIE_INVALIDE");
  });

  it("refuse un fichier entierement hors Guinee (latitude et longitude inversees) : HORS_GUINEE", () => {
    expect(code(() => lireFichier(kml(pm("Inverse", ligne("9.2,-10.1 9.2,-10.09"))), "h.kml"))).toBe("HORS_GUINEE");
    expect(code(() => lireFichier(kml(pm("Paris", `<Point><coordinates>2.35,48.85</coordinates></Point>`)), "h.kml"))).toBe("HORS_GUINEE");
  });

  it("ecarte un objet hors Guinee parmi d'autres et le signale, sans refuser le fichier", () => {
    const r = lireFichier(kml(pm("Bon", ligne("-10.1,9.2 -10.09,9.2")) + pm("Loin", ligne("2.3,48.8 2.4,48.9"))), "m.kml");
    expect(r.resume.nbObjets).toBe(1);
    expect(r.avertissements).toContainEqual(expect.objectContaining({ code: "ELEMENTS_HORS_GUINEE", nb: 1 }));
  });

  it("ferme les anneaux ouverts et retire les sommets consecutifs identiques", () => {
    const r = lireFichier(kml(
      pm("P", `<Polygon><outerBoundaryIs><LinearRing><coordinates>-10.1,9.18 -10.09,9.18 -10.09,9.19</coordinates></LinearRing></outerBoundaryIs></Polygon>`) +
      pm("L", ligne("-10.1,9.2 -10.1,9.2 -10.09,9.2")),
    ), "a.kml");
    expect(r.objets[0].geometrie).toEqual({ type: "Polygon", coordinates: [[[-10.1, 9.18], [-10.09, 9.18], [-10.09, 9.19], [-10.1, 9.18]]] });
    expect(r.objets[1].geometrie).toEqual({ type: "LineString", coordinates: [[-10.1, 9.2], [-10.09, 9.2]] });
    expect(r.avertissements).toContainEqual(expect.objectContaining({ code: "ANNEAUX_FERMES", nb: 1 }));
    expect(r.avertissements).toContainEqual(expect.objectContaining({ code: "POINTS_REPETES_RETIRES", nb: 1 }));
  });

  it("signale les trace en double, y compris parcourus en sens inverse (circuits superposes)", () => {
    const r = lireFichier(kml(pm("C1", ligne("-10.1,9.2 -10.09,9.2")) + pm("C2", ligne("-10.1,9.2 -10.09,9.2")) + pm("C3", ligne("-10.09,9.2 -10.1,9.2"))), "d.kml");
    expect(r.resume.nbObjets).toBe(3);
    expect(r.avertissements).toContainEqual(expect.objectContaining({ code: "TRACES_DOUBLES", nb: 2 }));
  });

  it("refuse plus de 50 000 objets : TROP_D_OBJETS", () => {
    const un = pm("n", `<Point><coordinates>-10.1,9.2</coordinates></Point>`);
    expect(code(() => lireFichier(kml(un.repeat(OBJETS_MAX + 1)), "t.kml"))).toBe("TROP_D_OBJETS");
    expect(lireFichier(kml(un.repeat(OBJETS_MAX)), "t.kml").resume.nbObjets).toBe(OBJETS_MAX);
  }, 60_000);

  it("refuse un fichier de plus de 25 Mo et les formats non pris en charge", () => {
    expect(code(() => lireFichier(Buffer.alloc(TAILLE_MAX_OCTETS + 1, 32), "gros.kml"))).toBe("FICHIER_TROP_GROS");
    expect(code(() => lireFichier(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), "r.kmz"))).toBe("FORMAT_NON_SUPPORTE");
    expect(code(() => lireFichier(Buffer.from([0x00, 0x00, 0x27, 0x0a, 0, 0]), "r.shp"))).toBe("FORMAT_NON_SUPPORTE");
    expect(code(() => lireFichier(Buffer.from("0\nSECTION\n2\nHEADER\n"), "plan.dxf"))).toBe("FORMAT_NON_SUPPORTE");
    expect(code(() => lireFichier(Buffer.from(`<gpx version="1.1"/>`), "t.xml"))).toBe("FORMAT_NON_SUPPORTE");
    expect(code(() => lireFichier(Buffer.from("a,b,c\n1,2,3"), "t.csv"))).toBe("FORMAT_NON_SUPPORTE");
  });

  it("decode UTF-8 avec BOM, ISO-8859-1 declare et refuse un encodage inconnu", () => {
    const corps = pm("Rue de l'Eglise", ligne("-10.1,9.2 -10.09,9.2"));
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), kml(corps)]);
    expect(lireFichier(bom, "a.kml").objets[0].nom).toBe("Rue de l'Eglise");
    const latin = Buffer.from(`<?xml version="1.0" encoding="ISO-8859-1"?><kml><Document>${pm("Rue René", ligne("-10.1,9.2 -10.09,9.2"))}</Document></kml>`, "latin1");
    expect(lireFichier(latin, "a.kml").objets[0].nom).toBe("Rue René");
    expect(code(() => lireFichier(Buffer.from(`<?xml version="1.0" encoding="Shift_JIS"?><kml/>`), "a.kml"))).toBe("ENCODAGE_NON_SUPPORTE");
    expect(code(() => lireFichier(Buffer.concat([Buffer.from("<kml>"), Buffer.from([0xff, 0xfe, 0xfd]), Buffer.from("</kml>")]), "a.kml"))).toBe("ENCODAGE_NON_SUPPORTE");
  });
});

describe("lireFichier : GeoJSON", () => {
  const fc = (...features: unknown[]) => Buffer.from(JSON.stringify({ type: "FeatureCollection", features }));
  const feat = (geometry: unknown, properties: unknown = {}) => ({ type: "Feature", geometry, properties });

  it("lit une FeatureCollection : types, noms, proprietes conservees, altitude ignoree", () => {
    const r = lireFichier(fc(
      feat({ type: "LineString", coordinates: [[-10.1, 9.2, 55], [-10.09, 9.2, 56]] }, { name: "Axe 1", classe: "A", largeur: 7 }),
      feat({ type: "Point", coordinates: [-10.1, 9.2] }, { nom: "Poste" }),
      feat({ type: "Polygon", coordinates: [[[-10.1, 9.18], [-10.09, 9.18], [-10.09, 9.19], [-10.1, 9.18]]] }),
    ), "p.geojson");
    expect(r.format).toBe("GEOJSON");
    expect(r.objets.map((o) => [o.nom, o.typeGeom])).toEqual([["Axe 1", "LIGNE"], ["Poste", "POINT"], [null, "POLYGONE"]]);
    expect(r.objets[0].attributs).toEqual({ name: "Axe 1", classe: "A", largeur: 7 });
    expect(r.objets[0].geometrie).toEqual({ type: "LineString", coordinates: [[-10.1, 9.2], [-10.09, 9.2]] });
    expect(r.avertissements).toContainEqual(expect.objectContaining({ code: "ALTITUDE_IGNOREE", nb: 1 }));
    expect(r.avertissements).toContainEqual(expect.objectContaining({ code: "OBJETS_SANS_NOM", nb: 1 }));
  });

  it("lit une Feature isolee, une geometrie nue et une GeometryCollection", () => {
    expect(lireFichier(Buffer.from(JSON.stringify(feat({ type: "Point", coordinates: [-10.1, 9.2] }))), "a.json").resume.nbObjets).toBe(1);
    expect(lireFichier(Buffer.from(JSON.stringify({ type: "LineString", coordinates: [[-10.1, 9.2], [-10.09, 9.2]] })), "a.json").resume.nbObjets).toBe(1);
    const gc = { type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [-10.1, 9.2] }, { type: "LineString", coordinates: [[-10.1, 9.2], [-10.09, 9.2]] }] };
    expect(lireFichier(fc(feat(gc)), "a.json").resume.nbObjets).toBe(2);
  });

  it("compte les entites sans geometrie, refuse JSON illisible, CRS autre que WGS 84, geometrie vide, hors Guinee", () => {
    const r = lireFichier(fc(feat(null), feat({ type: "Point", coordinates: [-10.1, 9.2] })), "a.json");
    expect(r.avertissements).toContainEqual(expect.objectContaining({ code: "OBJETS_SANS_GEOMETRIE", nb: 1 }));
    expect(code(() => lireFichier(Buffer.from("{ pas du json"), "a.json"))).toBe("JSON_INVALIDE");
    expect(code(() => lireFichier(Buffer.from(JSON.stringify({ type: "FeatureCollection", crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32629" } }, features: [] })), "a.json"))).toBe("CRS_NON_SUPPORTE");
    expect(lireFichier(Buffer.from(JSON.stringify({ type: "FeatureCollection", crs: { type: "name", properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" } }, features: [feat({ type: "Point", coordinates: [-10.1, 9.2] })] })), "a.json").resume.nbObjets).toBe(1);
    expect(code(() => lireFichier(fc(), "a.json"))).toBe("FICHIER_VIDE");
    expect(code(() => lireFichier(fc(feat({ type: "LineString", coordinates: [] })), "a.json"))).toBe("GEOMETRIE_INVALIDE");
    expect(code(() => lireFichier(fc(feat({ type: "Point", coordinates: [2.35, 48.85] })), "a.json"))).toBe("HORS_GUINEE");
    // Coordonnees projetees (metres) au lieu de degres : illisibles en WGS 84.
    expect(code(() => lireFichier(fc(feat({ type: "Point", coordinates: [500000, 1000000] })), "a.json"))).toBe("GEOMETRIE_INVALIDE");
    expect(code(() => lireFichier(Buffer.from(JSON.stringify({ hello: 1 })), "a.json"))).toBe("FORMAT_NON_SUPPORTE");
    expect(code(() => lireFichier(Buffer.from(JSON.stringify({ type: "Topology" })), "a.json"))).toBe("FORMAT_NON_SUPPORTE");
  });

  it("retire les caracteres NUL (refuses par jsonb) et ne pollue pas le prototype", () => {
    const brut = `{"type":"Feature","geometry":{"type":"Point","coordinates":[-10.1,9.2]},"properties":{"__proto__":{"x":1},"a":"b\\u0000c"}}`;
    const r = lireFichier(Buffer.from(brut), "a.json");
    expect(r.objets[0].attributs.a).toBe("bc");
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(Object.getPrototypeOf(r.objets[0].attributs)).toBe(Object.prototype);
  });

  it("detecte les doublons de trace dans un GeoJSON", () => {
    const g = { type: "LineString", coordinates: [[-10.1, 9.2], [-10.09, 9.2]] };
    const r = lireFichier(fc(feat(g, { circuit: 1 }), feat(g, { circuit: 2 })), "a.geojson");
    expect(r.avertissements).toContainEqual(expect.objectContaining({ code: "TRACES_DOUBLES", nb: 1 }));
  });
});
