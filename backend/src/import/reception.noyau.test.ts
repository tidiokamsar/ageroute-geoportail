import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  LIMITE_CELLULE_CHARGE, assainirNomFichier, comparerMetadonnees, construireErreursCsv, decoderUtf8, estImprimable,
  neutraliserFormule, nettoyerCharge, premierOctetInvalideUtf8, sourceNormalisee, verifierAutorisationRef, verifierCoherenceFormat,
} from "./reception.noyau";
import { lireCsv } from "./pivot.noyau";

/**
 * Le noyau de la RECEPTION : ce que l'audit du 25/10/2026 a montre absent, chacun avec son essai.
 * Pur : ni base, ni horloge.
 */
const octets = (s: string) => Buffer.from(s, "utf8");

describe("le noyau de reception est pur", () => {
  it("n'importe que le noyau du pivot (types seulement)", () => {
    const source = readFileSync(join(__dirname, "reception.noyau.ts"), "utf8");
    const imports = [...source.matchAll(/^import .*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports).toEqual(["./pivot.noyau"]);
  });
});

describe("coherence du format declare (FORMAT_INCOHERENT)", () => {
  it("un CSV declare geojson est refuse ; un GeoJSON declare csv aussi ; chacun passe sous son vrai format", () => {
    const csv = octets("systeme_source;type_objet\nA;B\n");
    const gj = octets('  \n{"type":"FeatureCollection","features":[]}');
    expect(verifierCoherenceFormat("geojson", csv).ok).toBe(false);
    expect(verifierCoherenceFormat("csv", gj).ok).toBe(false);
    expect(verifierCoherenceFormat("csv", octets('[1,2]')).ok).toBe(false);
    expect(verifierCoherenceFormat("csv", csv).ok).toBe(true);
    expect(verifierCoherenceFormat("geojson", gj).ok).toBe(true);
  });

  it("le BOM UTF-8 et les blancs de tete ne trompent pas le controle", () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), octets('\r\n {"type":"FeatureCollection"}')]);
    expect(verifierCoherenceFormat("geojson", bom).ok).toBe(true);
    expect(verifierCoherenceFormat("csv", bom).ok).toBe(false);
  });

  it("un binaire (zip, SQLite, octets aleatoires) n'est ni l'un ni l'autre ; un NUL ISOLE n'en fait pas un binaire", () => {
    expect(verifierCoherenceFormat("csv", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 6, 0])).ok).toBe(false);
    expect(verifierCoherenceFormat("csv", Buffer.concat([octets("SQLite format 3"), Buffer.from([0]), Buffer.alloc(100)])).ok).toBe(false);
    expect(verifierCoherenceFormat("csv", randomBytes(4000)).ok).toBe(false);
    expect(verifierCoherenceFormat("csv", octets(`a;b\nc;d\u0000e\n${"x;y\n".repeat(100)}`)).ok).toBe(true);
  });

  it("un BOM UTF-16 n'est pas juge ici : c'est un probleme d'encodage, dit en toutes lettres plus loin", () => {
    expect(verifierCoherenceFormat("csv", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a;b", "utf16le")])).ok).toBe(true);
  });
});

describe("encodage strict", () => {
  it("accepte l'UTF-8 (accents, emoji) et retire le BOM", () => {
    expect(decoderUtf8(octets("relevé été 🚧"))).toEqual({ ok: true, texte: "relevé été 🚧" });
    expect(decoderUtf8(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), octets("a;b")]))).toEqual({ ok: true, texte: "a;b" });
  });

  it("refuse le Latin-1 / Windows-1252 en donnant la POSITION de l'octet, jamais U+FFFD en silence", () => {
    const r = decoderUtf8(Buffer.concat([octets("caf"), Buffer.from([0xe9]), octets("\n")]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motif).toMatch(/encodage non UTF-8 : reenregistrez le fichier en UTF-8.*position 3/);
  });

  it("nomme l'UTF-16 (BOM) au lieu d'un motif trompeur de colonne absente", () => {
    for (const bom of [[0xff, 0xfe], [0xfe, 0xff]]) {
      const r = decoderUtf8(Buffer.concat([Buffer.from(bom), Buffer.from("a;b", "utf16le")]));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.motif).toMatch(/UTF-16.*UTF-8/);
    }
  });

  it("le validateur a la main est d'accord avec TextDecoder sur 3 000 sequences aleatoires et des cas limites", () => {
    const fatal = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const valide = (b: Uint8Array) => { try { fatal.decode(b); return true; } catch { return false; } };
    const cas: Uint8Array[] = [
      Buffer.from([0xc0, 0x80]), Buffer.from([0xc1, 0xbf]), Buffer.from([0xe0, 0x80, 0x80]), Buffer.from([0xed, 0xa0, 0x80]),
      Buffer.from([0xf4, 0x90, 0x80, 0x80]), Buffer.from([0xf5, 0x80, 0x80, 0x80]), Buffer.from([0xe2, 0x82]), Buffer.from([0x80]),
      Buffer.from("é€😀", "utf8"), Buffer.from([0xf0, 0x9f, 0x98]),
    ];
    for (let i = 0; i < 3000; i += 1) cas.push(randomBytes(1 + (i % 9)));
    // Des sequences presque valides : un texte UTF-8 dont un octet est altere.
    for (let i = 0; i < 500; i += 1) { const b = Buffer.from("aé€😀z", "utf8"); b[i % b.length] = randomBytes(1)[0]; cas.push(b); }
    for (const b of cas) {
      expect(premierOctetInvalideUtf8(b) === -1, `octets ${Buffer.from(b).toString("hex")}`).toBe(valide(b));
    }
  });
});

describe("nom de fichier", () => {
  it.each([
    ["relevé-été.csv", "relevé-été.csv"],
    ["../../etc/passwd", "passwd"],
    ["C:\\Users\\x\\lot.csv", "lot.csv"],
    ["a\u0000b\r\nc.csv", "abc.csv"],
    ["fichier\u202Egpj.csv", "fichiergpj.csv"],
    ["   ", "fichier"],
    ["..", "fichier"],
    ["", "fichier"],
  ])("%j devient %j", (brut, attendu) => { expect(assainirNomFichier(brut)).toBe(attendu); });

  it("borne a 255 caracteres sans couper un caractere en deux", () => {
    expect(Array.from(assainirNomFichier("n".repeat(100_000))).length).toBe(255);
    expect(Array.from(assainirNomFichier("😀".repeat(400))).length).toBe(255);
    expect(assainirNomFichier("😀".repeat(400))).not.toMatch(/\ufffd/);
  });
});

describe("metadonnees de la demande", () => {
  it("autorisationRef : cinq caracteres imprimables au moins, rien d'autre n'est invente", () => {
    for (const mauvais of ["", "x", ".", "n/a", "  ab  ", "AUT\n2026", "AUT-2026\u0000", "AUT-2026\u007f"]) expect(verifierAutorisationRef(mauvais), JSON.stringify(mauvais)).not.toBeNull();
    for (const bon of ["AUT-2026-01", "12345", "Decision n° 12/MTP/2026", "=1+1<script>"]) expect(verifierAutorisationRef(bon), bon).toBeNull();
  });

  it("estImprimable refuse controle et direction, accepte accents et espaces", () => {
    expect(estImprimable("Ministère des Travaux publics")).toBe(true);
    for (const c of ["\u0000", "\n", "\t", "\u202e", "\u2028"]) expect(estImprimable(`a${c}b`)).toBe(false);
  });

  it("comparerMetadonnees nomme les differences, jamais l'absence d'un champ facultatif", () => {
    const conserve = { autorisationRef: "A-1", versionMapping: "v0", methodeSource: "export", auteurSource: "Camara", dateSource: new Date("2026-09-15") };
    expect(comparerMetadonnees({ ...conserve }, conserve)).toEqual([]);
    expect(comparerMetadonnees({ ...conserve, auteurSource: undefined, dateSource: undefined }, conserve)).toEqual([]);
    expect(comparerMetadonnees({ ...conserve, autorisationRef: " A-2 ", auteurSource: "Diallo", dateSource: new Date("2026-09-16") }, conserve)).toEqual([
      { champ: "autorisationRef", recu: "A-2", conserve: "A-1" },
      { champ: "auteurSource", recu: "Diallo", conserve: "Camara" },
      { champ: "dateSource", recu: "2026-09-16T00:00:00.000Z", conserve: "2026-09-15T00:00:00.000Z" },
    ]);
  });

  it("sourceNormalisee compare sans casse ni blancs superflus (jamais pour stocker)", () => {
    expect(sourceNormalisee("  ONR   BDR ")).toBe(sourceNormalisee("onr bdr"));
    expect(sourceNormalisee("ONR_BDR")).not.toBe(sourceNormalisee("ONR-BDR"));
  });
});

describe("charge d'une ligne enregistrable", () => {
  it("rend la charge intacte (meme objet) quand rien ne l'empeche", () => {
    const brute = { a: "x", b: { c: [1, "é"] }, d: null };
    const r = nettoyerCharge(brute);
    expect(r.motif).toBeNull();
    expect(r.propre).toBe(brute);
  });

  it("NUL : remplace par U+2400, motif qui nomme la colonne, JSON sans \\u0000", () => {
    const r = nettoyerCharge({ id: "A", note: "av\u0000ap", ok: "1" });
    expect(r.motif).toMatch(/colonne « note ».*NUL.*U\+2400/);
    expect(r.propre.note).toBe("av\u2400ap");
    expect(JSON.stringify(r.propre)).not.toContain("\\u0000");
    expect(r.propre.ok).toBe("1");
  });

  it("NUL dans une CLE, dans un tableau imbrique, substitut isole : tout est nettoye", () => {
    const r = nettoyerCharge({ "k\u0000": "v", liste: [["x\u0000"]], s: "\ud800" });
    expect(Object.keys(r.propre)[0]).toBe("k\u2400");
    expect(JSON.stringify(r.propre)).not.toContain("\\u0000");
    expect(JSON.stringify(r.propre)).not.toContain("\\ud800");
    expect(r.motif).toMatch(/NUL.*substitut/);
  });

  it("un substitut BIEN forme (emoji) n'est pas un probleme", () => {
    expect(nettoyerCharge({ s: "chantier 🚧" }).motif).toBeNull();
  });

  it("tronque au-dela de 32 niveaux sans depasser la pile", () => {
    let profond: unknown = "fond";
    for (let i = 0; i < 100_000; i += 1) profond = [profond];
    const r = nettoyerCharge({ cache: profond });
    expect(r.motif).toMatch(/imbriquee au-dela de 32 niveaux/);
    expect(JSON.stringify(r.propre).length).toBeLessThan(500);
  });

  it("une colonne nommee __proto__ reste une propriete", () => {
    const brute = JSON.parse('{"__proto__":"x\\u0000"}') as Record<string, unknown>;
    const r = nettoyerCharge(brute);
    expect(Object.keys(r.propre)).toEqual(["__proto__"]);
  });
});

describe("export d'erreurs : formules neutralisees et volume borne", () => {
  it.each([
    ["=HYPERLINK(\"http://x\")", "'=HYPERLINK(\"http://x\")"], ["+cmd", "'+cmd"], ["-2+3", "'-2+3"], ["@SUM(A1)", "'@SUM(A1)"],
    ["\tx", "'\tx"], ["\rx", "'\rx"], ["normal", "normal"], ["a=b", "a=b"], ["", ""],
  ])("%j -> %j", (v, attendu) => { expect(neutraliserFormule(v)).toBe(attendu); });

  const l = (n: number, id: string, motif = "m") => ({ numeroLigne: n, statut: "IGNOREE", motifRejet: motif, identifiantSource: id, chargeOriginale: { identifiant_source: id } });

  it("aucune cellule texte du CSV ne commence par un declencheur ; les colonnes se relisent a l'identique", () => {
    const { csv } = construireErreursCsv([l(1, "=1+1"), l(2, "+cmd"), l(3, "-2+3+cmd"), l(4, "@SUM"), l(5, "a;b"), l(6, "x\"y")], 6, ";");
    const { lignes, entete } = lireCsv(csv);
    expect(entete).toEqual(["numero_ligne", "statut", "motif", "identifiant_source", "charge_originale"]);
    expect(lignes).toHaveLength(6);
    expect(lignes.map((x) => x.identifiant_source)).toEqual(["'=1+1", "'+cmd", "'-2+3+cmd", "'@SUM", "a;b", 'x"y']);
    for (const x of lignes) for (const v of Object.values(x)) expect(v).not.toMatch(/^[=+\-@]/);
  });

  it("le motif lui-meme est neutralise", () => {
    const { csv } = construireErreursCsv([l(1, "A", "=2+2")], 1, ";");
    expect(lireCsv(csv).lignes[0].motif).toBe("'=2+2");
  });

  it("borne le nombre de lignes et le dit par un commentaire final, ignore a la relecture", () => {
    const lignes = Array.from({ length: 50 }, (_, i) => l(i + 1, `A${i}`));
    const r = construireErreursCsv(lignes, 50, ";", { lignes: 10, caracteres: 1e9 });
    expect(r.exportees).toBe(10);
    expect(r.tronque).toBe(true);
    expect(r.csv.trimEnd().split("\n").pop()).toBe("# export tronque : 10 lignes sur 50 (limite de l'export)");
    expect(lireCsv(r.csv).lignes).toHaveLength(10);
  });

  it("borne le nombre de caracteres, et chaque cellule de charge", () => {
    const grosse = { ...l(1, "A"), chargeOriginale: { x: "z".repeat(100_000) } };
    const r = construireErreursCsv([grosse], 1, ";");
    expect(r.csv.length).toBeLessThan(LIMITE_CELLULE_CHARGE + 500);
    expect(r.csv).toMatch(/tronque a 5000 caracteres/);
    const beaucoup = Array.from({ length: 100 }, (_, i) => l(i + 1, "A".repeat(100)));
    const r2 = construireErreursCsv(beaucoup, 100, ";", { lignes: 1000, caracteres: 1000 });
    expect(r2.exportees).toBeLessThan(100);
    expect(r2.tronque).toBe(true);
  });

  it("un export complet n'a pas de commentaire", () => {
    const r = construireErreursCsv([l(1, "A")], 1, ";");
    expect(r.tronque).toBe(false);
    expect(r.csv).not.toContain("#");
  });
});
