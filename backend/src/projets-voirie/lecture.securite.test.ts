import { describe, expect, it } from "vitest";
import { ErreurLecture, PROFONDEUR_JSON_MAX, lireFichier, profondeurJson } from "./lecture.noyau";

/** Fixtures 100 % synthetiques. Contrat v2, sections 4.1 et 4.3 : detection par le contenu, aucune transformation silencieuse. */
const code = (f: () => unknown) => { try { f(); } catch (e) { if (e instanceof ErreurLecture) return e.code; throw e; } return null; };
const kml = (corps: string) => Buffer.from(`<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>${corps}</Document></kml>`);
const ligne = (nom: string, c: string) => `<Placemark><name>${nom}</name><LineString><coordinates>${c}</coordinates></LineString></Placemark>`;
const point = Buffer.from(JSON.stringify({ type: "Point", coordinates: [-10.1, 9.2] }));

describe("securite de lecture : detection par le contenu, pas par l'extension", () => {
  it("refuse HTML, PDF, executable, image, script et binaire, quelle que soit l'extension", () => {
    expect(code(() => lireFichier(Buffer.from("<!DOCTYPE html><html><body>x</body></html>"), "plan.kml"))).toBe("CONTENU_NON_RECONNU");
    expect(code(() => lireFichier(Buffer.from("<html><script>alert(1)</script></html>"), "a.geojson"))).toBe("CONTENU_NON_RECONNU");
    expect(code(() => lireFichier(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "a.kml"))).toBe("CONTENU_NON_RECONNU");
    expect(code(() => lireFichier(Buffer.from("%PDF-1.7\n1 0 obj"), "a.kml"))).toBe("CONTENU_NON_RECONNU");
    expect(code(() => lireFichier(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]), "a.geojson"))).toBe("CONTENU_NON_RECONNU");
    expect(code(() => lireFichier(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]), "a.kml"))).toBe("CONTENU_NON_RECONNU");
    expect(code(() => lireFichier(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]), "a.kml"))).toBe("CONTENU_NON_RECONNU");
    expect(code(() => lireFichier(Buffer.from("#!/bin/sh\nrm -rf /"), "a.kml"))).toBe("CONTENU_NON_RECONNU");
  });

  it("refuse les octets NUL, meme dans un document qui ressemble a du GeoJSON", () => {
    const avecNul = Buffer.concat([Buffer.from('{"type":"Point","coordinates":[-10.1,9.2],"x":"a'), Buffer.from([0]), Buffer.from('b"}')]);
    expect(code(() => lireFichier(avecNul, "a.geojson"))).toBe("CONTENU_NON_RECONNU");
    expect(lireFichier(point, "a.geojson").resume.nbObjets).toBe(1);
  });

  it("refuse les archives avec le message « prevu au lot suivant », sans rien decompresser, meme sous l'extension kml", () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]);
    for (const nom of ["r.kmz", "r.zip", "r.kml"]) {
      let erreur: ErreurLecture | null = null;
      try { lireFichier(zip, nom); } catch (e) { erreur = e as ErreurLecture; }
      expect(erreur?.code, nom).toBe("FORMAT_NON_SUPPORTE");
      expect(erreur?.message, nom).toContain("lot suivant");
    }
    expect(code(() => lireFichier(Buffer.from([0x00, 0x00, 0x27, 0x0a, 0, 0]), "x.dat"))).toBe("FORMAT_NON_SUPPORTE");
    expect(code(() => lireFichier(Buffer.from("AC1027xxxx"), "x.dat"))).toBe("FORMAT_NON_SUPPORTE");
  });

  it("borne l'imbrication JSON sans exploser la pile", () => {
    const bombe = "[".repeat(100000) + "]".repeat(100000);
    expect(profondeurJson(bombe)).toBe(100000);
    expect(code(() => lireFichier(Buffer.from(`{"type":"Feature","properties":{"a":${bombe}}}`), "a.json"))).toBe("JSON_TROP_PROFOND");
    const n = PROFONDEUR_JSON_MAX - 3;
    const limite = "[".repeat(n) + "]".repeat(n);
    expect(lireFichier(Buffer.from(`{"type":"Feature","geometry":{"type":"Point","coordinates":[-10.1,9.2]},"properties":{"a":${limite}}}`), "a.json").resume.nbObjets).toBe(1);
  });

  it("ne compte pas les crochets contenus dans les chaines", () => {
    expect(profondeurJson('{"a":"[[[[[[\\"]]]]"}')).toBe(1);
  });

  it("n'interprete jamais le texte d'un attribut : un script reste une chaine", () => {
    const r = lireFichier(kml(`<Placemark><name>x</name><description><![CDATA[<script>alert(1)</script>]]></description><LineString><coordinates>-10.1,9.2 -10.09,9.2</coordinates></LineString></Placemark>`), "a.kml");
    expect(r.objets[0].attributs.description).toBe("<script>alert(1)</script>");
  });
});

describe("CRS explicite et empreinte (delta de versions)", () => {
  it("dit la source, la cible, la methode et la justification, pour KML comme pour GeoJSON", () => {
    const k = lireFichier(kml(ligne("A", "-10.1,9.2 -10.09,9.2")), "a.kml");
    expect(k.crs).toMatchObject({ source: "WGS84 (EPSG:4326)", cible: "EPSG:4326", methode: "aucune transformation" });
    expect(k.crs.justification).toContain("KML 2.2");
    const g = lireFichier(point, "a.json");
    expect(g.crs.cible).toBe("EPSG:4326");
    expect(g.crs.justification).toContain("RFC 7946");
  });

  it("un CRS projete est refuse avec l'indication du lot suivant", () => {
    let erreur: ErreurLecture | null = null;
    try {
      lireFichier(Buffer.from(JSON.stringify({ type: "FeatureCollection", crs: { type: "name", properties: { name: "EPSG:32629" } }, features: [] })), "a.json");
    } catch (e) { erreur = e as ErreurLecture; }
    expect(erreur?.code).toBe("CRS_NON_SUPPORTE");
    expect(erreur?.message).toContain("lot suivant");
  });

  it("l'empreinte est stable, insensible au sens d'une ligne et a l'altitude, sensible au nom et a la geometrie", () => {
    const e = (nom: string, coords: string) => lireFichier(kml(ligne(nom, coords)), "a.kml").objets[0].empreinte;
    expect(e("A", "-10.1,9.2 -10.09,9.2")).toMatch(/^[0-9a-f]{40}$/);
    expect(e("A", "-10.1,9.2 -10.09,9.2")).toBe(e("A", "-10.1,9.2 -10.09,9.2"));
    expect(e("A", "-10.1,9.2 -10.09,9.2")).toBe(e("A", "-10.09,9.2 -10.1,9.2"));
    expect(e("A", "-10.1,9.2 -10.09,9.2")).toBe(e("A", "-10.1,9.2,0 -10.09,9.2,0"));
    expect(e("A", "-10.1,9.2 -10.09,9.2")).not.toBe(e("B", "-10.1,9.2 -10.09,9.2"));
    expect(e("A", "-10.1,9.2 -10.09,9.2")).not.toBe(e("A", "-10.1,9.2 -10.08,9.2"));
  });
});
