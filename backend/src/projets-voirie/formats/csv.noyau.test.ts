import { describe, expect, it } from "vitest";
import type { Brut, FormesBrutes } from "../collecteur.noyau";
import { ErreurLecture } from "../lecture.types";
import {
  analyserEnregistrements, choisirDelimiteur, decoderCsv, detecterSeparateurDecimal, inspecterCsv, lireCsv, lireNombre, normaliserEntetes,
  type LimitesCsv, type OptionsCsv,
} from "./csv.noyau";
import type { Puits } from "./puits.noyau";
import { lireWkt } from "./wkt.noyau";

/** Fixtures 100 % synthetiques : coordonnees inventees, aucun fichier d'un tiers. */
const LIM: LimitesCsv = { lignesMax: 1000, colonnesMax: 50, celluleMax: 10_000 };
const code = (f: () => unknown): string | null => { try { f(); } catch (e) { if (e instanceof ErreurLecture) return e.code; throw e; } return null; };

interface Recu { nom: string | null; attributs: Record<string, unknown>; formes: FormesBrutes }
function puitsEnregistreur(): { puits: Puits; recus: Recu[]; lus: () => number } {
  const recus: Recu[] = [];
  let lus = 0;
  return { recus, lus: () => lus, puits: { compter() {}, elementIgnore() {}, elementLu() { lus++; }, ajouter(nom, attributs, formes) { recus.push({ nom, attributs, formes }); } } };
}
function lire(csv: string | Buffer, o: OptionsCsv, lim = LIM) {
  const inv = inspecterCsv(Buffer.isBuffer(csv) ? csv : Buffer.from(csv), o, lim);
  if (!inv) throw new Error("pas du CSV");
  const p = puitsEnregistreur();
  const res = lireCsv(inv, o, lim, p.puits);
  return { inv, res, ...p };
}

describe("decoderCsv : encodage jamais devine", () => {
  const accent = "nom;x;y\nrégion;1;2\n";
  it("UTF-8 sans BOM, UTF-8 avec BOM, UTF-16 LE et BE avec BOM sont reconnus", () => {
    expect(decoderCsv(Buffer.from(accent, "utf8"))).toMatchObject({ encodage: "utf-8", encodageDetecte: true, bom: false });
    const t = decoderCsv(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(accent, "utf8")]));
    expect(t).toMatchObject({ encodage: "utf-8", bom: true });
    expect(t.texte).toBe(accent);
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(accent, "utf16le")]);
    expect(decoderCsv(le)).toMatchObject({ encodage: "utf-16le", texte: accent });
    const be = Buffer.from(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(accent, "utf16le").swap16()]));
    expect(decoderCsv(be)).toMatchObject({ encodage: "utf-16be", texte: accent });
  });

  it("des octets qui ne sont pas de l'UTF-8 valide sont AMBIGUS (ISO-8859-1 ou Windows-1252 ?) : refus tant que l'encodage n'est pas declare", () => {
    const latin1 = Buffer.from(accent, "latin1");
    expect(code(() => decoderCsv(latin1))).toBe("ENCODAGE_AMBIGU");
    expect(decoderCsv(latin1, "iso-8859-1").texte).toBe(accent);
    expect(decoderCsv(latin1, "windows-1252")).toMatchObject({ encodage: "windows-1252", encodageDetecte: false });
    // Windows-1252 : l'euro est en 0x80, qui n'est pas de l'ISO-8859-1 ; l'etiquette iso-8859-1 du standard designe windows-1252.
    expect(decoderCsv(Buffer.from([0x80]), "windows-1252").texte).toBe("€");
  });

  it("un encodage declare UTF-8 mais invalide est refuse, jamais reinterprete", () => {
    expect(code(() => decoderCsv(Buffer.from(accent, "latin1"), "utf-8"))).toBe("ENCODAGE_NON_SUPPORTE");
  });
});

describe("analyserEnregistrements : RFC 4180 borne", () => {
  const opts = { lignesMax: 100, colonnesMax: 20, celluleMax: 1000 };
  it("guillemets : delimiteur et retour a la ligne dans un champ, guillemet double, CRLF, lignes vides ignorees", () => {
    const r = analyserEnregistrements('a,b,c\r\n"x,1","dit ""oui""","l1\nl2"\r\n\r\n4,5,6', ",", opts);
    expect(r.lignes).toEqual([["a", "b", "c"], ["x,1", 'dit "oui"', "l1\nl2"], ["4", "5", "6"]]);
    expect(r.numeros).toEqual([1, 2, 5]);
  });
  it("ligne terminee par un delimiteur : derniere cellule vide conservee", () => {
    expect(analyserEnregistrements("a,b\n1,\n", ",", opts).lignes).toEqual([["a", "b"], ["1", ""]]);
  });
  it("guillemet non ferme, caractere apres un champ guillemete : CSV_STRUCTURE_INVALIDE", () => {
    expect(code(() => analyserEnregistrements('a,b\n"x,1\n', ",", opts))).toBe("CSV_STRUCTURE_INVALIDE");
    expect(code(() => analyserEnregistrements('a,b\n"x"y,1\n', ",", opts))).toBe("CSV_STRUCTURE_INVALIDE");
  });
  it("bornes : lignes, colonnes, cellule", () => {
    expect(code(() => analyserEnregistrements("a,b\n1,2\n3,4\n5,6\n", ",", { ...opts, lignesMax: 2 }))).toBe("CSV_TROP_DE_LIGNES");
    expect(code(() => analyserEnregistrements("a,b,c,d\n", ",", { ...opts, colonnesMax: 3 }))).toBe("CSV_TROP_DE_COLONNES");
    expect(code(() => analyserEnregistrements(`a,b\n${"x".repeat(1001)},2\n`, ",", opts))).toBe("CSV_CELLULE_TROP_LONGUE");
    expect(code(() => analyserEnregistrements(`a,b\n"${"x".repeat(1001)}",2\n`, ",", opts))).toBe("CSV_CELLULE_TROP_LONGUE");
  });
});

describe("choisirDelimiteur : detecte seulement s'il est le seul candidat coherent", () => {
  it("point-virgule, virgule, tabulation, barre verticale", () => {
    expect(choisirDelimiteur("nom;x;y\na;1;2\nb;3;4\n")).toEqual({ delimiteur: ";", detecte: true });
    expect(choisirDelimiteur("nom,x,y\na,1,2\nb,3,4\n")).toEqual({ delimiteur: ",", detecte: true });
    expect(choisirDelimiteur("nom\tx\ty\na\t1\t2\n")).toEqual({ delimiteur: "\t", detecte: true });
    expect(choisirDelimiteur("nom|x|y\na|1|2\n")).toEqual({ delimiteur: "|", detecte: true });
  });
  it("virgule decimale avec point-virgule : seul `;` est coherent", () => {
    expect(choisirDelimiteur("x;y\n9,5;-10,2\n9,6;-10,3\n")).toEqual({ delimiteur: ";", detecte: true });
  });
  it("deux delimiteurs coherents : DELIMITEUR_AMBIGU, jamais un choix silencieux ; le delimiteur declare l'emporte", () => {
    const ambigu = "a;b,c\n1;2,3\n4;5,6\n";
    expect(code(() => choisirDelimiteur(ambigu))).toBe("DELIMITEUR_AMBIGU");
    expect(choisirDelimiteur(ambigu, ",")).toEqual({ delimiteur: ",", detecte: false });
  });
  it("un texte sans structure n'est pas du CSV : null", () => {
    expect(choisirDelimiteur("juste du texte\nsur deux lignes\n")).toBeNull();
    expect(choisirDelimiteur("une seule ligne;avec;des;champs\n")).toBeNull();
  });
});

describe("colonnes et nombres", () => {
  it("entetes vides renommes, doublons suffixes, longueur bornee", () => {
    expect(normaliserEntetes(["x", "", "X", "y", " y "])).toEqual({ colonnes: ["x", "colonne_2", "X (2)", "y", "y (2)"], renommees: 3 });
    expect(normaliserEntetes(["a".repeat(300)]).colonnes[0]).toHaveLength(200);
  });
  it("lireNombre : separateur declare, exact, pas de separateur de milliers", () => {
    expect(lireNombre("9.5", ".")).toBe(9.5);
    expect(lireNombre("-10,25", ",")).toBe(-10.25);
    expect(lireNombre("1e3", ".")).toBe(1000);
    expect(lireNombre(" 380000 ", ",")).toBe(380000);
    for (const [s, sep] of [["9,5", "."], ["9.5", ","], ["1 234,5", ","], ["1.234,5", ","], ["", "."], ["abc", "."], ["1e3", ","], ["0x10", "."], ["9.5.1", "."], ["NaN", "."], ["Infinity", "."], ["-", "."]] as const) {
      expect(Number.isNaN(lireNombre(s, sep)), `${s} ${sep}`).toBe(true);
    }
  });
  it("detecterSeparateurDecimal : sans ambiguite, entiers seuls (null), melange (ambigu)", () => {
    expect(detecterSeparateurDecimal(["9.5", "10.25", "3"])).toBe(".");
    expect(detecterSeparateurDecimal(["9,5", "10,25"])).toBe(",");
    expect(detecterSeparateurDecimal(["380000", "1015000"])).toBeNull();
    expect(detecterSeparateurDecimal(["9.5", "10,25"])).toBe("ambigu");
  });
});

describe("lireCsv : points", () => {
  const CSV = "libelle;X;Y;proprietaire\nRegard 1;380000,5;1015000,25;Concessionnaire A\nRegard 2;380100;1015100;\n";
  it("virgule decimale detectee sur les colonnes de coordonnees, attributs = colonnes non vides en chaines, un objet par ligne", () => {
    const { res, recus, inv, lus } = lire(CSV, { colonneX: "X", colonneY: "Y" });
    expect(inv).toMatchObject({ delimiteur: ";", nbLignes: 2 });
    expect(res).toMatchObject({ mode: "points", separateurDecimal: ",", separateurDecimalDetecte: true, nbLignes: 2, nbLignesRejetees: 0, maxAbsCoordonnee: 1015100 });
    expect(lus()).toBe(2);
    expect(recus[0].formes.points).toEqual([[380000.5, 1015000.25]]);
    expect(recus[0].attributs).toEqual({ libelle: "Regard 1", X: "380000,5", Y: "1015000,25", proprietaire: "Concessionnaire A" });
    expect(recus[1].attributs).not.toHaveProperty("proprietaire");
    expect(recus[0].nom).toBeNull();
  });

  it("separateur decimal ambigu sur les coordonnees : refus ; declare, il est applique", () => {
    const melange = "x;y\n9.5;10,2\n";
    expect(code(() => lire(melange, { colonneX: "x", colonneY: "y" }))).toBe("SEPARATEUR_DECIMAL_AMBIGU");
    const { recus, res } = lire("x;y\n9,5;10,2\n", { colonneX: "x", colonneY: "y", separateurDecimal: "," });
    expect(res.separateurDecimalDetecte).toBe(false);
    expect(recus[0].formes.points[0]).toEqual([9.5, 10.2]);
  });

  it("lignes inexploitables rejetees UNE A UNE avec leur numero dans le fichier (champ multi-ligne compris), jamais en silence", () => {
    const csv = 'id,x,y\na,1.5,2.5\nb,abc,2\n"c\nsuite",,3\nd,4,5\n';
    const { res, recus } = lire(csv, { colonneX: "x", colonneY: "y" });
    expect(recus).toHaveLength(2);
    expect(res.nbLignesRejetees).toBe(2);
    expect(res.rejets.map((r) => [r.ligne, r.code])).toEqual([[3, "COORDONNEES_ILLISIBLES"], [4, "COORDONNEES_ABSENTES"]]);
    expect(res.avertissements).toContainEqual(expect.objectContaining({ code: "LIGNES_CSV_REJETEES", nb: 2 }));
  });

  it("le rapport de rejets est borne a 50 lignes", () => {
    const lignes = Array.from({ length: 120 }, (_, i) => `r${i},abc,1`).join("\n");
    const { res } = lire(`id,x,y\n${lignes}\n`, { colonneX: "x", colonneY: "y" });
    expect(res.nbLignesRejetees).toBe(120);
    expect(res.rejets).toHaveLength(50);
    expect(res.rejetsTronques).toBe(true);
  });

  it("INJECTION DE FORMULES SANS EFFET : =, +, -, @ et DDE sont lus comme du texte et conserves tels quels, rien n'est evalue", () => {
    const csv = "nom,x,y\n=cmd|' /C calc'!A0,1,2\n+SUM(1+1),3,4\n-2+3,5,6\n@SUM(A1),7,8\n";
    const { recus } = lire(csv, { colonneX: "x", colonneY: "y" });
    expect(recus.map((r) => r.attributs.nom)).toEqual(["=cmd|' /C calc'!A0", "+SUM(1+1)", "-2+3", "@SUM(A1)"]);
    for (const r of recus) expect(typeof r.attributs.nom).toBe("string");
  });

  it("colonnes de coordonnees : non designees, inconnues, ou melangees avec WKT : erreurs typees, rien n'est devine", () => {
    const csv = "x,y,g\n1,2,POINT(1 2)\n";
    expect(code(() => lire(csv, {}))).toBe("CSV_COLONNES_REQUISES");
    expect(code(() => lire(csv, { colonneX: "x" }))).toBe("CSV_COLONNES_REQUISES");
    expect(code(() => lire(csv, { colonneX: "x", colonneY: "absente" }))).toBe("CSV_COLONNE_INTROUVABLE");
    expect(code(() => lire(csv, { colonneX: "x", colonneY: "y", colonneWkt: "g" }))).toBe("CSV_COLONNES_REQUISES");
    expect(code(() => lire(csv, { colonneX: "x", colonneY: "y", colonneOrdre: "x" }))).toBe("CSV_COLONNES_REQUISES");
  });

  it("une cellule ordinaire de plus de 10 000 caracteres est refusee a la lecture (la colonne WKT est exemptee)", () => {
    const grosse = "z".repeat(10_001);
    expect(code(() => lire(`x,y,note\n1,2,${grosse}\n`, { colonneX: "x", colonneY: "y" }))).toBe("CSV_CELLULE_TROP_LONGUE");
  });
});

describe("lireCsv : lignes par cle d'axe", () => {
  const CSV = "axe,ordre,x,y,commune\nA,10,380100,1015000,Kis\nA,2,380000,1015000,Kis\nB,1,380000,1015100,Kis\nB,2,380050,1015100,Autre\nC,1,380500,1015500,Kis\n";
  it("une ligne par cle, points tries par la colonne d'ordre NUMERIQUE (2 avant 10), colonnes constantes conservees, cle seule rejetee", () => {
    const { recus, res } = lire(CSV, { colonneX: "x", colonneY: "y", colonneCle: "axe", colonneOrdre: "ordre" });
    expect(res.mode).toBe("lignes");
    expect(recus.map((r) => r.nom)).toEqual(["A", "B"]);
    expect(recus[0].formes.lignes[0]).toEqual([[380000, 1015000], [380100, 1015000]]);
    expect(recus[0].attributs).toEqual({ axe: "A", commune: "Kis", nbPoints: "2" });
    // `commune` varie dans B (Kis puis Autre) : non conservee.
    expect(recus[1].attributs).toEqual({ axe: "B", nbPoints: "2" });
    expect(res.rejets).toEqual([expect.objectContaining({ ligne: 6, code: "LIGNE_TROP_COURTE" })]);
  });
  it("sans colonne d'ordre : l'ordre du fichier ; ordre illisible : ligne rejetee", () => {
    const { recus } = lire("axe,x,y\nA,3,0\nA,1,0\nA,2,0\n", { colonneX: "x", colonneY: "y", colonneCle: "axe" });
    expect(recus[0].formes.lignes[0].map((p: Brut) => p[0])).toEqual([3, 1, 2]);
    const { res } = lire("axe,o,x,y\nA,1,0,0\nA,zz,1,1\nA,3,2,2\n", { colonneX: "x", colonneY: "y", colonneCle: "axe", colonneOrdre: "o" });
    expect(res.rejets).toEqual([expect.objectContaining({ ligne: 3, code: "ORDRE_ILLISIBLE" })]);
  });
});

describe("lireCsv : colonne WKT", () => {
  it("lit points, lignes et polygones ; la colonne WKT n'est pas recopiee dans les attributs ; WKT invalide ou SRID= : ligne rejetee", () => {
    const csv = [
      "nom;geom",
      "p;POINT(380000 1015000)",
      'l;"LINESTRING(380000 1015000, 380100 1015000)"',
      'q;"POLYGON((0 0, 10 0, 10 10, 0 0))"',
      "x;POINT(1)",
      "s;SRID=32629;POINT(1 2)",
      "v;",
    ].join("\n");
    const { recus, res } = lire(csv, { colonneWkt: "geom", delimiteur: ";" });
    expect(recus).toHaveLength(3);
    expect(recus[0].formes.points).toEqual([[380000, 1015000]]);
    expect(recus[1].formes.lignes[0]).toHaveLength(2);
    expect(recus[2].formes.polygones[0][0]).toHaveLength(4);
    expect(recus[0].attributs).toEqual({ nom: "p" });
    expect(res.rejets.map((r) => r.code)).toEqual(["WKT_INVALIDE", "WKT_INVALIDE", "WKT_ABSENT"]);
  });
});

describe("wkt.noyau", () => {
  it("six types, Z conserve, M ignore, espaces et casse libres", () => {
    expect(lireWkt("point (1 2)").points).toEqual([[1, 2]]);
    expect(lireWkt("POINT Z (1 2 3)").points).toEqual([[1, 2, 3]]);
    expect(lireWkt("POINT M (1 2 9)").points).toEqual([[1, 2]]);
    expect(lireWkt("MULTIPOINT((1 2),(3 4))").points).toEqual([[1, 2], [3, 4]]);
    expect(lireWkt("MULTIPOINT(1 2, 3 4)").points).toEqual([[1, 2], [3, 4]]);
    expect(lireWkt("LINESTRING(0 0,1 1,2 0)").lignes[0]).toHaveLength(3);
    expect(lireWkt("MULTILINESTRING((0 0,1 1),(2 2,3 3))").lignes).toHaveLength(2);
    expect(lireWkt("POLYGON((0 0,4 0,4 4,0 0),(1 1,2 1,2 2,1 1))").polygones[0]).toHaveLength(2);
    expect(lireWkt("MULTIPOLYGON(((0 0,4 0,4 4,0 0)),((9 9,10 9,10 10,9 9)))").polygones).toHaveLength(2);
    expect(lireWkt("POINT(1.5e2 -2.25)").points).toEqual([[150, -2.25]]);
  });
  it("refuse EMPTY, SRID=, GEOMETRYCOLLECTION, texte tronque, caracteres etrangers, texte apres la geometrie", () => {
    for (const w of ["POINT EMPTY", "SRID=4326;POINT(1 2)", "GEOMETRYCOLLECTION(POINT(1 2))", "POINT(1 2", "POINT(1)", "POINT(1 2 3 4 5)", "POINT(a b)", "POINT(1 2) x", "LINESTRING(0 0,1 1))", "CIRCULARSTRING(0 0,1 1,2 0)", "POINT(1 2); DROP TABLE x", ""]) {
      expect(() => lireWkt(w), w).toThrow();
    }
  });
  it("cout lineaire : 100 000 sommets en moins de 3 secondes (un parcours quadratique serait de plusieurs minutes)", () => {
    const pts = Array.from({ length: 100_000 }, (_, i) => `${i} ${i}`).join(",");
    const t0 = performance.now();
    expect(lireWkt(`LINESTRING(${pts})`).lignes[0]).toHaveLength(100_000);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
