import { describe, expect, it } from "vitest";
import {
  LONGUEUR_MAX_CITATION, analyserDateIso, decouperEnregistrementsCsvBorne, extrait, horsEtendueAttendue, lireCsv, lireGeoJson,
  verifierGeometrie, verifierLigne,
} from "./pivot.noyau";

/**
 * Durcissement du pivot (audit du 25/10/2026). CHAQUE test d'ici qui rejette une ligne jusque-la
 * acceptee est un CHANGEMENT DE CONTRAT, liste dans le rapport du chantier BE-I.
 */
const base = (): Record<string, unknown> => ({
  systeme_source: "ONR_BDR", type_objet: "comptage", identifiant_source: "C1",
});

describe("motifs : la valeur fautive est citee tronquee", () => {
  it("extrait coupe a 80 caracteres et dit la longueur totale", () => {
    expect(extrait("abc")).toBe("abc");
    const e = extrait("z".repeat(2_000_000));
    expect(e.length).toBeLessThan(LONGUEUR_MAX_CITATION + 40);
    expect(e).toMatch(/\(2000000 caracteres\)$/);
  });
  it("remplace les caracteres de controle et survit a un objet illisible", () => {
    expect(extrait("a\u0000b\nc")).toBe("a b c");
    expect(extrait({ toString() { throw new Error("x"); } })).toBe("(illisible)");
  });
  it("un type_objet de 2 Mo ne fait pas un motif de 2 Mo", () => {
    const v = verifierLigne({ ...base(), type_objet: "q".repeat(2_000_000) });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.motif.length).toBeLessThan(400);
  });
  it("un type de geometrie, un CRS et un type de collection enormes sont aussi tronques", () => {
    const g = verifierGeometrie({ type: "x".repeat(1e6), coordinates: [] });
    expect(!g.ok && g.motif.length).toBeLessThan(300);
    const c = lireGeoJson({ type: "FeatureCollection", crs: { properties: { name: "y".repeat(1e6) } }, features: [] });
    expect(!c.ok && c.motif.length).toBeLessThan(300);
    const t = lireGeoJson({ type: "t".repeat(1e6) });
    expect(!t.ok && t.motif.length).toBeLessThan(300);
  });
});

describe("coordonnees 3D (lon, lat, altitude)", () => {
  it("acceptees, l'altitude est laissee de cote", () => {
    const p = verifierGeometrie({ type: "Point", coordinates: [-13.6, 9.6, 52.4] });
    expect(p).toEqual({ ok: true, geometrie: { type: "Point", coordinates: [-13.6, 9.6] } });
    const l = verifierGeometrie({ type: "LineString", coordinates: [[-13.6, 9.6, 10], [-13.5, 9.7, 12]] });
    expect(l).toEqual({ ok: true, geometrie: { type: "LineString", coordinates: [[-13.6, 9.6], [-13.5, 9.7]] } });
  });
  it("une altitude non finie, ou quatre valeurs, restent refusees", () => {
    expect(verifierGeometrie({ type: "Point", coordinates: [-13.6, 9.6, "x"] }).ok).toBe(false);
    expect(verifierGeometrie({ type: "Point", coordinates: [-13.6, 9.6, 1, 2] }).ok).toBe(false);
    expect(verifierGeometrie({ type: "Point", coordinates: [-13.6] }).ok).toBe(false);
  });
  it("une longitude hors etendue est toujours refusee avec 3 valeurs, sans citer l'altitude", () => {
    const v = verifierGeometrie({ type: "Point", coordinates: [650000, 7500000, 12] });
    expect(!v.ok && v.motif).toMatch(/\(650000, 7500000\)/);
  });
});

describe("nombres : decimal ordinaire seulement", () => {
  const fin = (debut_m: unknown, fin_m: unknown) => verifierLigne({ ...base(), type_objet: "portion", debut_m, fin_m });
  it.each(["0x10", "0b11", "1e300", "1e3", "Infinity", "NaN", "12abc", "1 000", "--1", "1.2.3", " ", "0o7"])("refuse %j", (v) => {
    const r = fin(v, "500");
    expect(r.ok, v).toBe(false);
    if (!r.ok && v.trim() !== "") expect(r.motif).toMatch(/non numeriques/);
  });
  it.each([["10", 10], ["10,5", 10.5], ["10.5", 10.5], [" 7 ", 7], ["+3", 3], [".5", 0.5], ["0", 0], [12, 12], [0.25, 0.25]])("accepte %j", (v, n) => {
    const r = fin(v, 1000);
    expect(r.ok, String(v)).toBe(true);
    if (r.ok) expect(r.ligne.debutM).toBe(n);
  });
  it("un nombre JSON non fini est refuse", () => {
    expect(fin(Number.POSITIVE_INFINITY, 5).ok).toBe(false);
  });
});

describe("date_source : ISO 8601 strict", () => {
  it.each(["2026-07-08", "2026-07-08T10:20:30Z", "2026-07-08 10:20", "2026-07-08T10:20:30.123+01:00", "2024-02-29", "1999-12-31T23:59:59-0500"])("accepte %s", (d) => {
    expect(analyserDateIso(d).ok).toBe(true);
  });
  it.each(["05/10/2026", "Foo 1", "1", "2026-02-30", "2025-02-29", "2026-13-01", "2026-00-10", "26-07-08", "2026-7-8", "2026-07-08T25:00", "2026-07-08T10:61", "hier", "1800-01-01", "2200-01-01", ""])("refuse %j", (d) => {
    const r = analyserDateIso(d);
    expect(r.ok, d).toBe(false);
    if (!r.ok) expect(r.motif).toMatch(/^date_source non interpretable/);
  });
  it("une date dans le futur n'est refusee que si l'appelant fournit sa date du jour (pas d'horloge ici)", () => {
    expect(analyserDateIso("2099-01-01").ok).toBe(true);
    const r = analyserDateIso("2099-01-01", new Date("2026-10-25T00:00:00Z"));
    expect(!r.ok && r.motif).toMatch(/futur/);
    expect(analyserDateIso("2026-10-26", new Date("2026-10-25T00:00:00Z")).ok).toBe(true);   // tolerance de fuseau
    expect(verifierLigne({ ...base(), date_source: "2099-01-01" }, { aujourdhui: new Date("2026-10-25") }).ok).toBe(false);
  });
  it("la valeur citee dans le motif est tronquee", () => {
    const r = analyserDateIso("d".repeat(100_000));
    expect(!r.ok && r.motif.length).toBeLessThan(300);
  });
});

describe("CRS : formes admises, ancrees", () => {
  const crs = (name: unknown) => lireGeoJson({ type: "FeatureCollection", crs: { type: "name", properties: { name } }, features: [] }).ok;
  it.each([
    "urn:ogc:def:crs:OGC:1.3:CRS84", "urn:ogc:def:crs:OGC::CRS84", "urn:ogc:def:crs:EPSG::4326", "urn:ogc:def:crs:EPSG:6.6:4326",
    "EPSG:4326", "EPSG::4326", "CRS84", "OGC:CRS84", "epsg:4326", " EPSG:4326 ",
    "http://www.opengis.net/def/crs/OGC/1.3/CRS84", "http://www.opengis.net/def/crs/EPSG/0/4326",
  ])("accepte %j", (n) => { expect(crs(n), n).toBe(true); });
  it.each([
    "my-4326-fake", "EPSG:34326", "EPSG:43260", "x4326", "urn:ogc:def:crs:EPSG::32628", "EPSG:3857", "CRS84x", "xCRS84",
    "urn:ogc:def:crs:EPSG::4326:extra", "EPSG:::4326", "", 4326,
  ])("refuse %j", (n) => { expect(crs(n), String(n)).toBe(false); });
});

describe("colonnes dupliquees dans l'en-tete CSV", () => {
  it("sont signalees (la derniere valeur gagnait en silence)", () => {
    const r = lireCsv("systeme_source;type_objet;identifiant_source;type_objet;a;a\nONR;comptage;C1;troncon;1;2\n");
    expect(r.entetesDupliques.sort()).toEqual(["a", "type_objet"]);
  });
  it("un en-tete sans doublon n'en signale aucun", () => {
    expect(lireCsv("a;b;c\n1;2;3\n").entetesDupliques).toEqual([]);
  });
  it("une colonne __proto__ est une colonne, pas une propriete avalee", () => {
    const r = lireCsv("a;__proto__\n1;2\n");
    expect(Object.keys(r.lignes[0])).toEqual(["a", "__proto__"]);
    expect(r.lignes[0]["__proto__" as string]).toBe("2");
  });
});

describe("plafond de lignes : la lecture s'arrete tot", () => {
  const corps = (n: number) => Array.from({ length: n }, (_, i) => `ONR;comptage;C${i}`).join("\n");
  it("CSV : un de plus que le plafond -> depasse, et on n'a pas tout decoupe", () => {
    const texte = `systeme_source;type_objet;identifiant_source\n${corps(50_000)}\n`;
    const r = lireCsv(texte, ";", { maxLignes: 100 });
    expect(r.depasse).toBe(true);
    expect(r.lignes.length).toBeLessThanOrEqual(100);
    const brut = decouperEnregistrementsCsvBorne(texte, 100);
    expect(brut.depasse).toBe(true);
    expect(brut.enregistrements.length).toBeLessThan(200);
  });
  it("CSV : exactement le plafond passe, avec ou sans lignes vides et commentaires", () => {
    const texte = `# note\nsysteme_source;type_objet;identifiant_source\n\n${corps(100)}\n\n# fin\n`;
    const r = lireCsv(texte, ";", { maxLignes: 100 });
    expect(r.depasse).toBe(false);
    expect(r.lignes).toHaveLength(100);
    expect(lireCsv(`systeme_source;type_objet;identifiant_source\n${corps(101)}\n`, ";", { maxLignes: 100 }).depasse).toBe(true);
  });
  it("CSV : sans plafond, le comportement d'avant", () => {
    const r = lireCsv(`a;b\n1;2\n3;4\n`);
    expect(r.lignes).toHaveLength(2);
    expect(r.depasse).toBe(false);
  });
  it("CSV : un guillemet ouvert qui avale le fichier ne contourne pas le plafond", () => {
    const texte = `systeme_source;type_objet;identifiant_source\nONR;comptage;"ouvert\n${corps(500)}\n`;
    expect(lireCsv(texte, ";", { maxLignes: 100 }).depasse).toBe(true);
  });
  it("GeoJSON : 50 001 `null` sont refuses AVANT toute transformation", () => {
    const r = lireGeoJson({ type: "FeatureCollection", features: Array.from({ length: 50_001 }, () => null) }, { maxLignes: 1000 });
    expect(r).toEqual({ ok: true, lignes: [], depasse: true });
    const ok = lireGeoJson({ type: "FeatureCollection", features: [null, null] }, { maxLignes: 2 });
    expect(ok.ok && ok.depasse).toBe(false);
  });
});

describe("etendue attendue du pays : un avertissement, jamais un refus", () => {
  const p = (lon: number, lat: number) => ({ type: "Point" as const, coordinates: [lon, lat] as [number, number] });
  it("Conakry, Kankan, Nzerekore sont dans l'etendue ; Paris, [0, 0], l'Atlantique et lon/lat inverses non", () => {
    expect(horsEtendueAttendue(p(-13.68, 9.64))).toBe(false);
    expect(horsEtendueAttendue(p(-9.3, 10.38))).toBe(false);
    expect(horsEtendueAttendue(p(-8.82, 7.75))).toBe(false);
    expect(horsEtendueAttendue(p(2.35, 48.85))).toBe(true);
    expect(horsEtendueAttendue(p(0, 0))).toBe(true);
    expect(horsEtendueAttendue(p(-30, 9.6))).toBe(true);
    expect(horsEtendueAttendue(p(9.64, -13.68))).toBe(true);
  });
  it("une seule position hors etendue dans un trace suffit", () => {
    expect(horsEtendueAttendue({ type: "LineString", coordinates: [[-13.6, 9.6], [2.3, 48.8]] })).toBe(true);
  });
  it("la ligne hors etendue reste VALIDE pour le pivot", () => {
    expect(verifierLigne({ ...base(), type_objet: "ouvrage", geometrie: p(2.35, 48.85) }).ok).toBe(true);
  });
});
