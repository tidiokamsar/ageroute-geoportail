import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { extraireEntree, inspecterZip } from "../formats/zip.noyau";
import { ErreurZip, dateDos, produireZip, verifierNomEntree } from "./zip-ecriture.noyau";
import { chaineLitterale, couper, mettreEnPage, produirePdf, versWinAnsi } from "./pdf.noyau";
import { NOM_EMPREINTES, NOM_MANIFESTE, assembler, nomGeojson, racineDossier, sha256, texteEmpreintes, verifierEmpreintes } from "./manifeste.noyau";

/**
 * Producteurs du dossier technique (lot X1) : ZIP, PDF texte simple, manifeste. Noyaux purs, sans base. L'archive produite est RELUE par le lecteur ZIP
 * borne du module (formats/zip.noyau.ts, celui des KMZ), qui refuse toute archive non conforme : c'est le meilleur temoin disponible sans dependance.
 */

const LIMITES = { entreesMax: 1000, tailleEntreeMax: 64 * 1024 * 1024, tailleTotaleMax: 256 * 1024 * 1024, tauxMax: 10_000, profondeurMax: 8 };
const DATE = new Date("2026-11-10T08:30:42.000Z");

function relire(zip: Buffer): Map<string, Buffer> {
  const inv = inspecterZip(zip, LIMITES);
  return new Map(inv.entrees.map((e) => [e.nom, extraireEntree(zip, e)]));
}

describe("producteur ZIP", () => {
  it("une archive de plusieurs fichiers est relue a l'identique par le lecteur strict du module (noms, contenus, CRC, tailles)", () => {
    const fichiers = [
      { nom: "dossier-x/LISEZMOI.txt", contenu: Buffer.from("Bonjour, dossier synthetique.\r\n".repeat(50), "utf8") },
      { nom: "dossier-x/geojson/axes_travaux-v1-abc.geojson", contenu: Buffer.from(JSON.stringify({ type: "FeatureCollection", features: [] })) },
      { nom: "dossier-x/aleatoire.bin", contenu: randomBytes(4096) },
      { nom: "dossier-x/vide.txt", contenu: Buffer.alloc(0) },
    ];
    const zip = produireZip(fichiers, DATE);
    const lus = relire(zip);
    expect([...lus.keys()]).toEqual(fichiers.map((f) => f.nom));
    for (const f of fichiers) expect(lus.get(f.nom)!.equals(f.contenu), f.nom).toBe(true);
  });

  it("deflate pour un texte compressible, stocke pour des octets incompressibles et pour un fichier vide ; drapeau UTF-8 ; hote MS-DOS sans attribut", () => {
    const zip = produireZip([{ nom: "a.txt", contenu: Buffer.from("x".repeat(10_000)) }, { nom: "b.bin", contenu: randomBytes(2000) }, { nom: "c.txt", contenu: Buffer.alloc(0) }], DATE);
    const inv = inspecterZip(zip, LIMITES);
    expect(inv.entrees.map((e) => e.methode)).toEqual([8, 0, 0]);
    expect(inv.entrees[0].tailleCompressee).toBeLessThan(200);
    // Repertoire central : fait par (octet haut 0 = MS-DOS), drapeaux 0x0800, attributs externes nuls.
    const debut = zip.readUInt32LE(zip.length - 22 + 16);
    expect(zip.readUInt16LE(debut + 4) >> 8).toBe(0);
    expect(zip.readUInt16LE(debut + 8)).toBe(0x0800);
    expect(zip.readUInt32LE(debut + 38)).toBe(0);
    expect(inflateRawSync(zip.subarray(inv.entrees[0].debutDonnees, inv.entrees[0].debutDonnees + inv.entrees[0].tailleCompressee)).toString()).toBe("x".repeat(10_000));
  });

  it("deterministe : memes fichiers et meme date, memes octets ; une date differente change l'archive", () => {
    const f = [{ nom: "r/a.json", contenu: Buffer.from('{"a":1}') }, { nom: "r/b.txt", contenu: Buffer.from("texte ".repeat(100)) }];
    expect(produireZip(f, DATE).equals(produireZip(f, DATE))).toBe(true);
    expect(produireZip(f, new Date("2027-01-01T00:00:00Z")).equals(produireZip(f, DATE))).toBe(false);
  });

  it("date DOS en UTC (secondes paires) et bornee a 1980", () => {
    const { date, heure } = dateDos(DATE);
    expect([(date >> 9) + 1980, (date >> 5) & 0xf, date & 0x1f]).toEqual([2026, 11, 10]);
    expect([heure >> 11, (heure >> 5) & 0x3f, (heure & 0x1f) * 2]).toEqual([8, 30, 42]);
    expect((dateDos(new Date("1970-01-01T00:00:00Z")).date >> 9) + 1980).toBe(1980);
  });

  it("refuse ce qu'un lecteur strict refuserait : nom dangereux, dossier, doublon (casse ignoree), archive vide", () => {
    for (const nom of ["", "../a.txt", "a/../b", "/abs.txt", "C:/x.txt", "a\\b.txt", "a//b.txt", "dossier/", "é.txt", "a b.txt", "./a.txt", "x".repeat(256)]) {
      expect(() => verifierNomEntree(nom), nom).toThrowError(ErreurZip);
    }
    expect(() => produireZip([{ nom: "A.txt", contenu: Buffer.from("1") }, { nom: "a.TXT", contenu: Buffer.from("2") }], DATE)).toThrowError(/meme nom/);
    expect(() => produireZip([], DATE)).toThrowError(/vide/);
  });
});

/** Extraction du texte d'un PDF de ce producteur : decode les chaines litterales des operateurs Tj (echappements et octal compris). */
function textePdf(pdf: Buffer): string[] {
  const s = pdf.toString("latin1");
  const sortie: string[] = [];
  for (const m of s.matchAll(/\((?:\\.|[^\\)])*\) Tj/g)) {
    const lit = m[0].slice(1, -4);
    sortie.push(lit.replace(/\\([0-7]{3}|.)/g, (_x, e: string) => (e.length === 3 ? String.fromCharCode(parseInt(e, 8)) : e)));
  }
  return sortie.map((t) => Buffer.from(t, "latin1").toString("latin1"));
}

describe("producteur PDF texte simple", () => {
  const lignes = [{ texte: "Dossier technique du projet SYNTH-1", taille: 16, gras: true }, { texte: "Électricité, réseau d'eau : à vérifier (chaussée) ; coût 12 €" }, { texte: "Chemin \\ serveur (test) et « guillemets » – tiret… œuvre" }];
  const pdf = produirePdf(lignes, { titre: "Fiche (synthetique)", creeLe: DATE });

  it("structure PDF 1.4 : en-tete, catalogue, pages, polices standard non incorporees, %%EOF", () => {
    const s = pdf.toString("latin1");
    expect(s.startsWith("%PDF-1.4\n")).toBe(true);
    expect(s.endsWith("%%EOF\n")).toBe(true);
    expect(s).toContain("/BaseFont /Helvetica /Encoding /WinAnsiEncoding");
    expect(s).toContain("/BaseFont /Helvetica-Bold");
    expect(s).not.toMatch(/FontFile/);
    expect(s).toContain("/CreationDate (D:20261110083042Z)");
  });

  it("table de renvois exacte : chaque decalage pointe sur « n 0 obj », startxref sur « xref », /Length egal au flux", () => {
    const s = pdf.toString("latin1");
    const debutXref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(s)![1]);
    expect(s.slice(debutXref, debutXref + 4)).toBe("xref");
    const [, nb] = /xref\n0 (\d+)\n/.exec(s.slice(debutXref))!;
    const entrees = s.slice(debutXref).split("\n").slice(3, 2 + Number(nb));
    entrees.forEach((e, i) => {
      expect(e).toMatch(/^\d{10} 00000 n $/);
      expect(s.slice(Number(e.slice(0, 10)), Number(e.slice(0, 10)) + 12)).toMatch(new RegExp(`^${i + 1} 0 obj\\n`));
    });
    for (const m of s.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
      const debut = m.index! + m[0].length;
      expect(s.slice(debut + Number(m[1]), debut + Number(m[1]) + 9)).toBe("endstream");
    }
  });

  it("texte retrouve a l'identique (accents, euro, oe, tirets, guillemets) ; parentheses et antislash echappes ; numero de page", () => {
    const t = textePdf(pdf);
    const latin = (x: string) => Buffer.from(versWinAnsi(x)).toString("latin1");
    expect(t).toContain(latin("Électricité, réseau d'eau : à vérifier (chaussée) ; coût 12 €"));
    expect(t).toContain(latin("Chemin \\ serveur (test) et « guillemets » – tiret… œuvre"));
    expect(t).toContain("Page 1 / 1");
    expect(chaineLitterale("a(b)c\\d")).toBe("(a\\(b\\)c\\\\d)");
    expect(chaineLitterale("é€")).toBe("(\\351\\200)");
  });

  it("un texte d'utilisateur ne peut pas fermer la chaine ni injecter un operateur ; caracteres non representables : « ? » ; controles : espace", () => {
    const hostile = ") Tj ET BT /F1 99 Tf (pirate";
    const p = produirePdf([{ texte: hostile }, { texte: "Ligne\u0007avec\u0000controle et 中文 et 😀" }], { titre: "t", creeLe: DATE });
    expect(textePdf(p)).toContain(hostile);
    // Une seule instruction de texte par ligne (deux lignes et le numero de page) : la chaine hostile reste une chaine, echappee.
    expect(p.toString("latin1").match(/^BT \/F[12] /gm)).toHaveLength(3);
    expect(p.toString("latin1")).toContain("(\\) Tj ET BT /F1 99 Tf \\(pirate) Tj ET");
    expect(Buffer.from(versWinAnsi("Ligne\u0007avec\u0000controle et 中文 et 😀")).toString("latin1")).toBe("Ligne avec controle et ?? et ?");
    // Fichier entierement ASCII hors de l'en-tete binaire de quatre octets.
    expect([...p.subarray(15)].every((o) => o === 0x0a || (o >= 0x20 && o < 0x7f))).toBe(true);
  });

  it("decomposition (NFD) recomposee avant le codage", () => {
    expect(versWinAnsi("e\u0301")).toEqual([0xe9]);
  });

  it("coupure aux espaces, mot trop long coupe, plusieurs pages numerotees quand le texte est long", () => {
    expect(couper("un deux trois quatre", 9)).toEqual(["un deux", "trois", "quatre"]);
    expect(couper("abcdefghijkl", 5)).toEqual(["abcde", "fghij", "kl"]);
    expect(couper("", 5)).toEqual([""]);
    const long = Array.from({ length: 200 }, (_, i) => ({ texte: `Ligne ${i} ${"mot ".repeat(30)}` }));
    const pages = mettreEnPage(long);
    expect(pages.length).toBeGreaterThan(3);
    for (const page of pages) for (const l of page) expect(l.y).toBeGreaterThanOrEqual(70);
    const p = produirePdf(long, { titre: "long", creeLe: DATE });
    expect(p.toString("latin1")).toContain(`/Count ${pages.length}`);
    expect(textePdf(p)).toContain(`Page ${pages.length} / ${pages.length}`);
  });

  it("deterministe : memes lignes, meme titre, meme date, memes octets", () => {
    expect(produirePdf(lignes, { titre: "Fiche (synthetique)", creeLe: DATE }).equals(pdf)).toBe(true);
  });
});

describe("manifeste et empreintes", () => {
  const contenus = [
    { chemin: "LISEZMOI.txt", contenu: Buffer.from("lisez-moi") },
    { chemin: "fiche-projet.json", contenu: Buffer.from('{"projet":{}}\n') },
    { chemin: "geojson/reseau_tiers-v2-0000.geojson", contenu: Buffer.from('{"type":"FeatureCollection","features":[]}') },
  ];
  const r = assembler("dossier-synth-1", contenus, { format: "BDRI-DOSSIER-1", exportId: "e1" });

  it("le manifeste liste chaque fichier (sauf lui-meme et manifeste.sha256) avec taille et SHA-256 exactes", () => {
    const m = r.manifeste.fichiers as { chemin: string; octets: number; sha256: string }[];
    expect(m.map((x) => x.chemin)).toEqual(contenus.map((c) => c.chemin));
    contenus.forEach((c, i) => { expect(m[i].octets).toBe(c.contenu.length); expect(m[i].sha256).toBe(sha256(c.contenu)); });
    expect(r.fichiers.map((f) => f.nom)).toEqual([...contenus.map((c) => `dossier-synth-1/${c.chemin}`), `dossier-synth-1/${NOM_MANIFESTE}`, `dossier-synth-1/${NOM_EMPREINTES}`]);
  });

  it("manifeste.sha256 (format sha256sum) couvre tous les fichiers, manifeste.json compris, et se verifie sur l'archive relue ; une alteration est detectee", () => {
    const zip = produireZip(r.fichiers, DATE);
    const lus = relire(zip);
    const lire = (c: string) => lus.get(`dossier-synth-1/${c}`);
    const sums = lire(NOM_EMPREINTES)!.toString("utf8");
    expect(sums.split("\n").filter(Boolean)).toHaveLength(contenus.length + 1);
    expect(sums).toMatch(/^[0-9a-f]{64} {2}manifeste\.json$/m);
    expect(verifierEmpreintes(sums, lire)).toEqual({ ok: true, erreurs: [] });
    const altere = (c: string) => (c === "fiche-projet.json" ? Buffer.from('{"projet":{"x":1}}\n') : lire(c));
    expect(verifierEmpreintes(sums, altere).erreurs).toEqual(["empreinte differente : fiche-projet.json"]);
    expect(verifierEmpreintes(sums, (c) => (c === "LISEZMOI.txt" ? undefined : lire(c))).ok).toBe(false);
    expect(verifierEmpreintes("", lire).ok).toBe(false);
    expect(texteEmpreintes([{ chemin: "a", octets: 1, sha256: "0".repeat(64) }])).toBe(`${"0".repeat(64)}  a\n`);
  });

  it("noms : racine depuis le code (minuscules, caracteres surs), GeoJSON par role, version et identifiant (aucun nom de fichier ni de concessionnaire)", () => {
    expect(racineDossier("PV-SYNTH_01")).toBe("dossier-pv-synth_01");
    expect(racineDossier("A/B C")).toBe("dossier-a-b-c");
    expect(nomGeojson({ role: "RESEAU_TIERS", version: 3, id: "0F0e-12" })).toBe("geojson/reseau_tiers-v3-0f0e-12.geojson");
    expect(() => verifierNomEntree(`${racineDossier("PV-1")}/${nomGeojson({ role: "AXES_TRAVAUX", version: 1, id: "a-b" })}`)).not.toThrow();
  });
});
