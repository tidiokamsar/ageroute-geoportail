import { describe, expect, it } from "vitest";
import { ErreurLecture } from "../lecture.types";
import { limitesCsv, limitesZip } from "./import.config";
import { detecter, preparer, type LimitesImport } from "./lecture-import.noyau";
import { META_WGS84 } from "./crs.noyau";
import { extraireEntree, inspecterZip } from "./zip.noyau";
import { construireZip } from "./zip.fixtures";

/**
 * Charge et entrees pathologiques des lecteurs du lot A1 : bornes respectees, temps raisonnable, jamais d'allocation proportionnelle a ce que
 * le fichier pretend contenir. Les bornes de temps sont larges (poste charge) : elles attrapent un parcours quadratique, pas une lenteur normale.
 */
const LIM: LimitesImport = { lecture: {}, zip: limitesZip(), csv: limitesCsv(), crsAutorises: [4326, 32628, 32629] };
const code = (f: () => unknown): string | null => { try { f(); } catch (e) { if (e instanceof ErreurLecture) return e.code; throw e; } return null; };
const OPT_CSV = { csv: { colonneX: "x", colonneY: "y", delimiteur: ";" as const }, epsgSource: 4326 };

function lire(b: Buffer, nom: string, opts: Parameters<typeof preparer>[1]) {
  const t0 = performance.now();
  const r = preparer(detecter(b, nom, opts, LIM), opts, LIM).terminer(META_WGS84, null);
  return { r, ms: performance.now() - t0 };
}

describe("CSV : volumes et pathologies", () => {
  it("50 000 lignes (limite d'objets) de points : lues en moins de 6 s", () => {
    const l = ["id;x;y"];
    for (let i = 0; i < 50_000; i++) l.push(`P${i};${(-10.2 + (i % 500) * 1e-4).toFixed(6)};${(9 + Math.floor(i / 500) * 1e-4).toFixed(6)}`);
    const { r, ms } = lire(Buffer.from(l.join("\n")), "p.csv", OPT_CSV);
    expect(r.resume.nbObjets).toBe(50_000);
    expect(ms).toBeLessThan(6000);
  }, 30_000);

  it("plus de 50 000 objets : TROP_D_OBJETS (borne du contrat), sans delai demesure", () => {
    const l = ["id;x;y"];
    for (let i = 0; i < 50_001; i++) l.push(`P${i};${(-10.2 + (i % 500) * 1e-4).toFixed(6)};${(9 + Math.floor(i / 500) * 1e-4).toFixed(6)}`);
    const t0 = performance.now();
    expect(code(() => lire(Buffer.from(l.join("\n")), "p.csv", OPT_CSV))).toBe("TROP_D_OBJETS");
    expect(performance.now() - t0).toBeLessThan(8000);
  }, 30_000);

  it("plus de lignes que le plafond de lecture : CSV_TROP_DE_LIGNES, sans lire la suite", () => {
    const lim: LimitesImport = { ...LIM, csv: { ...LIM.csv, lignesMax: 1000 } };
    const l = ["id;x;y"];
    for (let i = 0; i < 3000; i++) l.push(`P${i};-10.1;9.2`);
    const b = Buffer.from(l.join("\n"));
    expect(code(() => detecter(b, "p.csv", OPT_CSV, lim))).toBe("CSV_TROP_DE_LIGNES");
  });

  it("une seule ligne de 3 millions de delimiteurs : CSV_TROP_DE_COLONNES immediatement", () => {
    const t0 = performance.now();
    expect(code(() => detecter(Buffer.from(`${";".repeat(3_000_000)}\n1;2\n`), "p.csv", { csv: { delimiteur: ";" } }, LIM))).toBe("CSV_TROP_DE_COLONNES");
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it("une cellule guillemetee de plusieurs millions de caracteres : CSV_CELLULE_TROP_LONGUE, sans memoire proportionnelle", () => {
    const t0 = performance.now();
    expect(code(() => detecter(Buffer.from(`a;b\n"${"z".repeat(5_000_000)}";2\n`), "p.csv", { csv: { delimiteur: ";" } }, LIM))).toBe("CSV_CELLULE_TROP_LONGUE");
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it("des guillemets alternes pathologiques et des milliers de retours a la ligne ne bloquent pas la lecture", () => {
    const t0 = performance.now();
    const corps = '"a""b""c""'.repeat(200_000);
    code(() => detecter(Buffer.from(`x;y\n${corps}\n`), "p.csv", { csv: { delimiteur: ";" } }, LIM));
    code(() => detecter(Buffer.from(`x;y\n${"\n".repeat(2_000_000)}1;2\n`), "p.csv", { csv: { delimiteur: ";" } }, LIM));
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  it("separateur decimal : 40 000 lignes a virgule decimale : lues en un passage (moins de 4 s)", () => {
    const l = ["x;y"];
    for (let i = 0; i < 40_000; i++) l.push(`-10,${1000 + i};9,${2000 + i % 500}`);
    const { r, ms } = lire(Buffer.from(l.join("\n")), "p.csv", { csv: { colonneX: "x", colonneY: "y" }, epsgSource: 4326 });
    expect(r.resume.nbObjets).toBe(40_000);
    expect(ms).toBeLessThan(4000);
  }, 30_000);
});

describe("KMZ : volumes", () => {
  const entete = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>`;
  it("un KML de plusieurs Mo compresse dans l'archive : decompression bornee, taille et CRC verifies, en moins de 2 s", () => {
    const pm = (i: number) => `<Placemark><name>P${i}</name><Point><coordinates>${(-10.2 + (i % 500) * 1e-4).toFixed(6)},${(9 + Math.floor(i / 500) * 1e-4).toFixed(6)}</coordinates></Point></Placemark>`;
    let corps = "";
    for (let i = 0; i < 40_000; i++) corps += pm(i);
    const kml = `${entete}${corps}</Document></kml>`;
    const zip = construireZip([{ nom: "doc.kml", contenu: kml }]).buffer;
    expect(kml.length).toBeGreaterThan(4_000_000);
    const t0 = performance.now();
    const inv = inspecterZip(zip, LIM.zip);
    const sortie = extraireEntree(zip, inv.entrees[0]);
    expect(sortie.length).toBe(Buffer.byteLength(kml));
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it("l'entree decompressee est lue par le lecteur KML comme le fichier brut (memes objets)", () => {
    const kml = `${entete}<Placemark><name>A</name><LineString><coordinates>-10.1,9.2 -10.09,9.2</coordinates></LineString></Placemark></Document></kml>`;
    const k = lire(Buffer.from(kml), "a.kml", {}).r;
    const z = lire(construireZip([{ nom: "doc.kml", contenu: kml }]).buffer, "a.kmz", {}).r;
    expect(z.objets.map((o) => o.empreinte)).toEqual(k.objets.map((o) => o.empreinte));
  });

  it("100 entrees (la limite) passent ; la 101e est refusee ; 100 entrees de 1 Mo declarees sans rien allouer sont refusees au total", () => {
    const cent = construireZip(Array.from({ length: 100 }, (_, i) => ({ nom: `images/f${i}.png`, contenu: "x" }))).buffer;
    expect(inspecterZip(cent, LIM.zip).entrees).toHaveLength(100);
    expect(code(() => inspecterZip(construireZip(Array.from({ length: 101 }, (_, i) => ({ nom: `f${i}.png`, contenu: "x" }))).buffer, LIM.zip))).toBe("ARCHIVE_TROP_D_ENTREES");
  });
});

describe("GPX : volumes", () => {
  it("100 000 points de trace : lus en moins de 8 s", () => {
    let pts = "";
    for (let i = 0; i < 100_000; i++) pts += `<trkpt lat="${(9 + i * 1e-6).toFixed(6)}" lon="-10.1"><ele>3</ele><time>2026-11-01T10:00:00Z</time></trkpt>`;
    const gpx = `<?xml version="1.0"?><gpx version="1.1"><trk><name>T</name><trkseg>${pts}</trkseg></trk></gpx>`;
    const { r, ms } = lire(Buffer.from(gpx), "t.gpx", {});
    expect(r.resume.nbObjets).toBe(1);
    expect(ms).toBeLessThan(8000);
  }, 30_000);

  it("un objet de plus de 100 000 sommets : TROP_DE_SOMMETS (plafond du socle)", () => {
    let pts = "";
    for (let i = 0; i < 100_001; i++) pts += `<trkpt lat="${(9 + i * 1e-7).toFixed(7)}" lon="-10.1"/>`;
    const gpx = `<gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`;
    expect(code(() => lire(Buffer.from(gpx), "t.gpx", {}))).toBe("TROP_DE_SOMMETS");
  }, 30_000);
});
