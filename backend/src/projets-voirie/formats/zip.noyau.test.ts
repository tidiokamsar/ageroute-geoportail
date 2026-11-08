import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ErreurLecture } from "../lecture.types";
import { construireZip, kmzSimple } from "./zip.fixtures";
import { choisirEntreeKml, crc32, estZip, extraireEntree, inspecterZip, typeEntree, type LimitesZip } from "./zip.noyau";

/** Archives 100 % synthetiques fabriquees par zip.fixtures.ts : aucun fichier d'un tiers. */
const LIM: LimitesZip = { entreesMax: 100, tailleEntreeMax: 25 * 1024 * 1024, tailleTotaleMax: 100 * 1024 * 1024, tauxMax: 100, profondeurMax: 8 };
const KML = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>A</name><Point><coordinates>-10.1,9.2</coordinates></Point></Placemark></Document></kml>`;
const code = (f: () => unknown): string | null => { try { f(); } catch (e) { if (e instanceof ErreurLecture) return e.code; throw e; } return null; };
const inspecter = (b: Buffer, lim: Partial<LimitesZip> = {}) => inspecterZip(b, { ...LIM, ...lim });

describe("zip.noyau : archive nominale", () => {
  it("inspecte, choisit doc.kml et le decompresse (taille et CRC verifies) ; les images ne sont jamais decompressees", () => {
    const b = kmzSimple(KML, [{ nom: "images/icone.png", contenu: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }, { nom: "images/", contenu: "" }]);
    expect(estZip(b)).toBe(true);
    const inv = inspecter(b);
    expect(inv.entrees.map((e) => e.nom)).toEqual(["doc.kml", "images/icone.png", "images/"]);
    expect(inv.entrees.map(typeEntree)).toEqual(["kml", "image", "dossier"]);
    const choix = choisirEntreeKml(inv.entrees);
    expect(choix.principal.nom).toBe("doc.kml");
    expect(extraireEntree(b, choix.principal).toString("utf8")).toBe(KML);
  });

  it("une entree stockee (methode 0) et un nom accentue UTF-8 sont lus", () => {
    const b = construireZip([{ nom: "reseau-é.kml", contenu: KML, methode: 0, flags: 0x800 }]).buffer;
    const inv = inspecter(b);
    expect(inv.entrees[0].nom).toBe("reseau-é.kml");
    expect(extraireEntree(b, inv.entrees[0]).toString("utf8")).toBe(KML);
  });

  it("une archive vide est lue (aucune entree) ; elle n'est pas un KMZ", () => {
    const b = construireZip([]).buffer;
    expect(inspecter(b).entrees).toEqual([]);
    expect(code(() => choisirEntreeKml([]))).toBe("KMZ_SANS_KML");
  });

  it("crc32 : vecteur connu", () => { expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926); });
});

describe("zip.noyau : choix de l'entree KML", () => {
  const deux = construireZip([{ nom: "a.kml", contenu: KML }, { nom: "sous/b.kml", contenu: KML }]).buffer;
  it("plusieurs KML sans doc.kml : refus, l'inventaire les liste ; l'utilisateur choisit par nom exact", () => {
    const inv = inspecter(deux);
    expect(code(() => choisirEntreeKml(inv.entrees))).toBe("KMZ_PLUSIEURS_KML");
    expect(choisirEntreeKml(inv.entrees, "sous/b.kml").principal.nom).toBe("sous/b.kml");
    expect(choisirEntreeKml(inv.entrees, "sous/b.kml").kml.map((e) => e.nom)).toEqual(["a.kml", "sous/b.kml"]);
    expect(code(() => choisirEntreeKml(inv.entrees, "absent.kml"))).toBe("ENTREE_KML_INTROUVABLE");
    expect(code(() => choisirEntreeKml(inv.entrees, "a.KML"))).toBe("ENTREE_KML_INTROUVABLE");
  });

  it("doc.kml a la racine l'emporte sur les autres KML ; un doc.kml dans un sous-dossier ne compte pas", () => {
    const b = construireZip([{ nom: "z.kml", contenu: KML }, { nom: "doc.kml", contenu: KML }]).buffer;
    expect(choisirEntreeKml(inspecter(b).entrees).principal.nom).toBe("doc.kml");
    const c = construireZip([{ nom: "x/doc.kml", contenu: KML }, { nom: "y.kml", contenu: KML }]).buffer;
    expect(code(() => choisirEntreeKml(inspecter(c).entrees))).toBe("KMZ_PLUSIEURS_KML");
  });

  it("KMZ sans KML : KMZ_SANS_KML ; archive de Shapefile ou GeoPackage : FORMAT_NON_SUPPORTE (chaine GDAL)", () => {
    const docs = construireZip([{ nom: "notes.txt", contenu: "x" }, { nom: "plan.png", contenu: "x" }]).buffer;
    expect(code(() => choisirEntreeKml(inspecter(docs).entrees))).toBe("KMZ_SANS_KML");
    const shp = construireZip([{ nom: "axes.shp", contenu: "x" }, { nom: "axes.dbf", contenu: "x" }]).buffer;
    expect(code(() => choisirEntreeKml(inspecter(shp).entrees))).toBe("FORMAT_NON_SUPPORTE");
  });
});

describe("zip.noyau : archives hostiles refusees en entier", () => {
  const un = (nom: string, extra: object = {}) => construireZip([{ nom: "doc.kml", contenu: KML }, { nom, contenu: "x", ...extra }]).buffer;

  it("zip-slip : `..`, chemin absolu, lettre de lecteur, antislash, octet NUL, caractere de controle", () => {
    for (const nom of ["../evil.kml", "a/../../evil.kml", "/etc/passwd", "C:/Windows/x.kml", "c:evil", "a\\b.kml", "x\u0000.kml", "x\ny.kml", "a//b.kml"]) {
      expect(code(() => inspecter(un(nom))), JSON.stringify(nom)).toBe("ARCHIVE_CHEMIN_DANGEREUX");
    }
  });

  it("profondeur : 8 niveaux passent, 9 sont refuses", () => {
    expect(inspecter(un("a/b/c/d/e/f/g/h.png")).entrees).toHaveLength(2);
    expect(code(() => inspecter(un("a/b/c/d/e/f/g/h/i.png")))).toBe("ARCHIVE_TROP_PROFONDE");
  });

  it("lien symbolique et entrees speciales (mode Unix), point d'analyse NTFS", () => {
    const hoteUnix = (3 << 8) | 20;
    expect(code(() => inspecter(un("lien", { faitPar: hoteUnix, attrExterne: (0o120777 << 16) >>> 0 })))).toBe("ARCHIVE_LIEN_SYMBOLIQUE");
    expect(code(() => inspecter(un("dev", { faitPar: hoteUnix, attrExterne: (0o020666 << 16) >>> 0 })))).toBe("ARCHIVE_ENTREE_SPECIALE");
    expect(code(() => inspecter(un("tube", { faitPar: hoteUnix, attrExterne: (0o010644 << 16) >>> 0 })))).toBe("ARCHIVE_ENTREE_SPECIALE");
    expect(code(() => inspecter(un("ntfs", { faitPar: (10 << 8) | 20, attrExterne: 0x400 })))).toBe("ARCHIVE_LIEN_SYMBOLIQUE");
    // Un fichier Unix ordinaire (mode 0644 regulier) passe.
    expect(inspecter(un("ok.png", { faitPar: hoteUnix, attrExterne: (0o100644 << 16) >>> 0 })).entrees).toHaveLength(2);
  });

  it("entree chiffree : refus ; methode inconnue : refus", () => {
    expect(code(() => inspecter(un("secret.kml", { flags: 0x1 })))).toBe("ARCHIVE_CHIFFREE");
    expect(code(() => inspecter(un("s.kml", { flags: 0x40 })))).toBe("ARCHIVE_CHIFFREE");
    const b = construireZip([{ nom: "doc.kml", contenu: KML }]).buffer;
    b.writeUInt16LE(12, b.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10); // methode bzip2 annoncee dans le repertoire central
    expect(code(() => inspecter(b))).toBe("ARCHIVE_METHODE_NON_SUPPORTEE");
  });

  it("noms en double (casse ignoree, dossier et fichier de meme nom) : refus", () => {
    expect(code(() => inspecter(construireZip([{ nom: "A.kml", contenu: KML }, { nom: "a.KML", contenu: KML }]).buffer))).toBe("ARCHIVE_NOMS_AMBIGUS");
    expect(code(() => inspecter(construireZip([{ nom: "d", contenu: "x" }, { nom: "d/", contenu: "" }]).buffer))).toBe("ARCHIVE_NOMS_AMBIGUS");
  });

  it("archives imbriquees : par extension, quelle que soit la casse", () => {
    for (const nom of ["autre.kmz", "a.ZIP", "a.tar", "a.gz", "a.7z", "a.rar", "a.jar"]) {
      expect(code(() => inspecter(un(nom))), nom).toBe("ARCHIVE_IMBRIQUEE");
    }
  });

  it("trop d'entrees : refus decide AVANT de lire le repertoire central", () => {
    const specs = Array.from({ length: 4 }, (_, i) => ({ nom: `f${i}.png`, contenu: "x" }));
    const b = construireZip(specs).buffer;
    expect(code(() => inspecter(b, { entreesMax: 3 }))).toBe("ARCHIVE_TROP_D_ENTREES");
    // Repertoire central saccage : le compteur de fin suffit a refuser, sans le lire.
    const casse = Buffer.from(b);
    casse.fill(0xff, casse.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])), casse.length - 22);
    expect(code(() => inspecter(casse, { entreesMax: 3 }))).toBe("ARCHIVE_TROP_D_ENTREES");
    expect(inspecter(b, { entreesMax: 4 }).entrees).toHaveLength(4);
  });

  it("bombe : taux de compression superieur a 100 sur une entree de plus de 1 Mo", () => {
    const zeros = Buffer.alloc(5 * 1024 * 1024);
    const b = construireZip([{ nom: "doc.kml", contenu: zeros }]).buffer;
    expect(b.length).toBeLessThan(10_000);
    expect(code(() => inspecter(b))).toBe("ARCHIVE_TAUX_COMPRESSION");
    // Sous 1 Mo, le taux n'est pas controle (petits fichiers tres compressibles).
    expect(inspecter(construireZip([{ nom: "a.png", contenu: Buffer.alloc(500_000) }]).buffer).entrees).toHaveLength(1);
  });

  it("bombe : tailles declarees au-dela des plafonds, par entree et au total, sans rien allouer", () => {
    const petit = deflateRawSync(Buffer.alloc(10));
    const enorme = construireZip([{ nom: "doc.kml", brut: { compresse: petit, tailleDecompressee: 200 * 1024 * 1024, crc: 0 } }]).buffer;
    expect(code(() => inspecter(enorme))).toBe("ARCHIVE_TROP_GROSSE");
    const deux = construireZip([{ nom: "a.png", brut: { compresse: petit, tailleDecompressee: 800_000, crc: 0 } }, { nom: "b.png", brut: { compresse: petit, tailleDecompressee: 800_000, crc: 0 } }]).buffer;
    expect(code(() => inspecter(deux, { tailleTotaleMax: 1_000_000, tauxMax: 1_000_000 }))).toBe("ARCHIVE_TROP_GROSSE");
  });

  it("bombe : taille annoncee mensongere (petite) pour des donnees qui se decompressent en beaucoup plus : arret au plafond declare", () => {
    const zeros = Buffer.alloc(3 * 1024 * 1024);
    const b = construireZip([{ nom: "doc.kml", brut: { compresse: deflateRawSync(zeros), tailleDecompressee: 1000, crc: 0 } }]).buffer;
    const inv = inspecter(b);
    expect(code(() => extraireEntree(b, inv.entrees[0]))).toBe("ARCHIVE_TROP_GROSSE");
  });

  it("recouvrement : les donnees d'une entree debordent sur l'entete de la suivante", () => {
    const f = construireZip([{ nom: "a.png", contenu: "aaaaaaaaaaaaaaaaaaaaaaaa", methode: 0 }, { nom: "b.png", contenu: "bbbbbbbbbbbbbbbbbbbb", methode: 0 }]);
    const b = f.buffer;
    const central1 = f.debutRepertoire;
    b.writeUInt32LE(24 + 40, central1 + 20); // taille compressee de a.png gonflee
    b.writeUInt32LE(24 + 40, central1 + 24);
    expect(code(() => inspecter(b))).toBe("ARCHIVE_CHEVAUCHEMENT");
  });

  it("archive corrompue : tronquee, octets de tete ajoutes, commentaire incoherent, ZIP64, deflate corrompu, CRC faux, nom local different", () => {
    const b = kmzSimple(KML);
    expect(code(() => inspecter(b.subarray(0, b.length - 10)))).toBe("ARCHIVE_INVALIDE");
    expect(code(() => inspecter(Buffer.concat([Buffer.from("MZjunk"), b])))).toBe("ARCHIVE_INVALIDE");
    expect(code(() => inspecter(Buffer.concat([b, Buffer.from("xx")])))).toBe("ARCHIVE_INVALIDE");
    expect(code(() => inspecter(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0])))).toBe("ARCHIVE_INVALIDE");
    const zip64 = Buffer.from(b);
    zip64.writeUInt16LE(0xffff, zip64.length - 22 + 10);
    expect(code(() => inspecter(zip64))).toBe("ARCHIVE_INVALIDE");
    const f = construireZip([{ nom: "doc.kml", contenu: KML }]);
    const corrompu = Buffer.from(f.buffer);
    corrompu[30 + "doc.kml".length + 3] ^= 0xff;
    const inv = inspecter(corrompu);
    expect(code(() => extraireEntree(corrompu, inv.entrees[0]))).toBe("ARCHIVE_INVALIDE");
    const crcFaux = construireZip([{ nom: "doc.kml", contenu: KML, crcFaux: true }]).buffer;
    expect(code(() => extraireEntree(crcFaux, inspecter(crcFaux).entrees[0]))).toBe("ARCHIVE_INVALIDE");
    expect(code(() => inspecter(construireZip([{ nom: "doc.kml", contenu: KML, nomLocal: "autre.kml" }]).buffer))).toBe("ARCHIVE_INVALIDE");
  });

  it("une entree decompressee d'une taille differente de l'annonce est refusee", () => {
    const b = construireZip([{ nom: "doc.kml", contenu: KML, tailleAnnoncee: KML.length + 5 }]).buffer;
    expect(code(() => extraireEntree(b, inspecter(b).entrees[0]))).toBe("ARCHIVE_INVALIDE");
  });

  it("aucune entree n'est ecrite sur disque : le module n'importe pas node:fs", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(__dirname, "zip.noyau.ts"), "utf8");
    expect(source).not.toMatch(/from "node:(fs|child_process|path|os)"/);
  });
});
