import { describe, expect, it } from "vitest";
import { construireZip } from "../formats/zip.fixtures";
import { limitesZip } from "../formats/import.config";
import { ErreurLecture } from "../lecture.types";
import { detecterFormatGdal, jeuxShapefile } from "./format.noyau";
import { dxfMixte } from "./fixtures.gdal";

/** Detection PAR LE CONTENU des formats GDAL (lot B2) : ni l'extension, ni le Content-Type. Archive controlee par le noyau ZIP du module. */

const lim = limitesZip();
const sqlite = (appId: number): Buffer => {
  const b = Buffer.alloc(4096);
  Buffer.from("SQLite format 3\u0000", "latin1").copy(b, 0);
  b.writeUInt32BE(appId, 68);
  return b;
};
const zipShp = (noms: string[]): Buffer => construireZip(noms.map((nom) => ({ nom, contenu: "x" }))).buffer;
const code = (f: () => unknown): string => { try { f(); } catch (e) { return e instanceof ErreurLecture ? e.code : `AUTRE:${String(e)}`; } return "AUCUN"; };

describe("GeoPackage", () => {
  it("reconnu à l'identifiant d'application GPKG (ou GP10, GP11), pas au nom", () => {
    for (const id of [0x47504b47, 0x47503130, 0x47503131]) expect(detecterFormatGdal(sqlite(id), lim, true)).toEqual({ format: "GPKG" });
  });
  it("une autre base SQLite n'est pas un GeoPackage", () => {
    expect(detecterFormatGdal(sqlite(0), lim, true)).toBeNull();
    expect(detecterFormatGdal(sqlite(0x12345678), lim, true)).toBeNull();
  });
  it("un en-tête SQLite tronqué n'est rien", () => {
    expect(detecterFormatGdal(sqlite(0x47504b47).subarray(0, 60), lim, true)).toBeNull();
  });
});

describe("Shapefile en archive ZIP", () => {
  it("jeu complet .shp .shx .dbf (le .prj est signalé), sous un dossier, sans tenir compte de la casse", () => {
    const r = detecterFormatGdal(zipShp(["reseau/Axes.SHP", "reseau/Axes.shx", "reseau/axes.DBF", "reseau/axes.prj"]), lim, true);
    expect(r).toEqual({ format: "SHAPEFILE", shapefiles: [{ nom: "reseau/axes", prj: true }] });
    expect(detecterFormatGdal(zipShp(["a.shp", "a.shx", "a.dbf"]), lim, true)).toEqual({ format: "SHAPEFILE", shapefiles: [{ nom: "a", prj: false }] });
  });

  it("un jeu sans .shx ou sans .dbf est INCOMPLET : refusé en entier à la création du job", () => {
    expect(code(() => detecterFormatGdal(zipShp(["a.shp", "a.dbf"]), lim, true))).toBe("SHAPEFILE_INCOMPLET");
    expect(code(() => detecterFormatGdal(zipShp(["a.shp", "a.shx"]), lim, true))).toBe("SHAPEFILE_INCOMPLET");
    expect(code(() => detecterFormatGdal(zipShp(["a.shx", "a.dbf", "a.prj"]), lim, true))).toBe("SHAPEFILE_INCOMPLET");
    // un jeu complet et un incomplet dans la même archive : refus (rien n'est lu à moitié)
    expect(code(() => detecterFormatGdal(zipShp(["a.shp", "a.shx", "a.dbf", "b.shp"]), lim, true))).toBe("SHAPEFILE_INCOMPLET");
  });

  it("un KMZ (une entrée .kml) n'est pas un Shapefile : voie synchrone inchangée", () => {
    expect(detecterFormatGdal(zipShp(["doc.kml", "a.shp", "a.shx", "a.dbf"]), lim, true)).toBeNull();
    expect(detecterFormatGdal(zipShp(["doc.kml"]), lim, true)).toBeNull();
  });

  it("une archive de documents n'est pas un Shapefile", () => {
    expect(detecterFormatGdal(zipShp(["lisez-moi.txt", "plan.pdf"]), lim, true)).toBeNull();
  });

  it("archive hostile : refusée avec son code à la création (strict), ignorée par les voies synchrones", () => {
    const slip = construireZip([{ nom: "../../etc/passwd", contenu: "x" }]).buffer;
    expect(code(() => detecterFormatGdal(slip, lim, true))).toBe("ARCHIVE_CHEMIN_DANGEREUX");
    expect(detecterFormatGdal(slip, lim, false)).toBeNull();
    const imbriquee = construireZip([{ nom: "interne.zip", contenu: "x" }, { nom: "a.shp", contenu: "x" }]).buffer;
    expect(code(() => detecterFormatGdal(imbriquee, lim, true))).toBe("ARCHIVE_IMBRIQUEE");
    const lien = construireZip([{ nom: "a.shp", contenu: "cible", faitPar: 3 << 8, attrExterne: (0o120777 << 16) >>> 0 }]).buffer;
    expect(code(() => detecterFormatGdal(lien, lim, true))).toBe("ARCHIVE_LIEN_SYMBOLIQUE");
    const trop = construireZip(Array.from({ length: lim.entreesMax + 1 }, (_, i) => ({ nom: `f${i}.txt`, contenu: "x" }))).buffer;
    expect(code(() => detecterFormatGdal(trop, lim, true))).toBe("ARCHIVE_TROP_D_ENTREES");
  });

  it("jeuxShapefile : par nom de base, sans casse, sur toute l'arborescence", () => {
    const r = jeuxShapefile(["d/A.shp", "d/a.shx", "d/a.dbf", "x/b.shp", "x/b.shx", "y/c.prj"]);
    expect(r.complets.map((c) => c.nom)).toEqual(["d/a"]);
    expect(r.incomplets).toEqual([{ nom: "x/b", manque: ["dbf"] }]);
  });
});

describe("DXF", () => {
  it("DXF texte reconnu à ses paires SECTION (commentaires 999 et BOM tolérés), pas à l'extension", () => {
    expect(detecterFormatGdal(dxfMixte(), lim, true)).toEqual({ format: "DXF" });
    expect(detecterFormatGdal(Buffer.from("999\ncree par un outil\n  0\nSECTION\n  2\nHEADER\n  0\nENDSEC\n  0\nEOF\n"), lim, true)).toEqual({ format: "DXF" });
    expect(detecterFormatGdal(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), dxfMixte()]), lim, true)).toEqual({ format: "DXF" });
  });
  it("DXF binaire reconnu pour être refusé proprement", () => {
    expect(detecterFormatGdal(Buffer.concat([Buffer.from("AutoCAD Binary DXF\r\n\u001a\u0000", "latin1"), Buffer.alloc(40)]), lim, true)).toEqual({ format: "DXF_BINAIRE" });
  });
  it("ni HTML, ni PDF, ni exécutable, ni JSON, ni CSV, ni DXF tronqué ne sont reconnus", () => {
    for (const b of [
      Buffer.from("<!DOCTYPE html><html><body>0\nSECTION</body></html>"), Buffer.from("%PDF-1.7\n0\nSECTION\n"), Buffer.from("MZ\u0090\u0000\u0003"),
      Buffer.from('{"type":"FeatureCollection","features":[]}'), Buffer.from("x;y\n1;2\n"), Buffer.from("0\nSECTION\n"), Buffer.from("0\nSECTION\n2\nheader minuscule\n"), Buffer.alloc(0),
    ]) expect(detecterFormatGdal(b, lim, true), b.subarray(0, 12).toString()).toBeNull();
  });
  it("un fichier à octet NUL en tête n'est pas un DXF texte", () => {
    expect(detecterFormatGdal(Buffer.concat([Buffer.from("  0\nSECTION\n  2\nHEADER\n"), Buffer.from([0]), Buffer.alloc(10)]), lim, true)).toBeNull();
  });
});
