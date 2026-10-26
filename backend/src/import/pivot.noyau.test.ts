/**
 * Tests du format pivot ouvert et du noyau d'import.
 *
 * Ils eprouvent les criteres que ONR_BDR_TEST_PLAN.md et BDR_IMPORT_ACCEPTANCE_TESTS.md ont
 * fixes AVANT que ce code n'existe : X-02 (memes comptes en CSV et GeoJSON), T-02 (100 % des
 * lignes dans un statut), T-04 (un rejet porte sa raison), T-06 (cle d'idempotence stable),
 * T-11 (SRID 4326 seul).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleIdempotence, comptabiliser, compteursComplets, decouperLigneCsv,
  ecrireCsv, ecrireGeoJson, lireCsv, lireGeoJson, marquerDoublonsInternes,
  verifierGeometrie, verifierLigne,
  SRID_PIVOT, TYPES_OBJET_PIVOT, type LignePivot,
} from "./pivot.noyau";

describe("Le noyau du pivot ne depend de rien", () => {
  it("n'a aucun import : il transforme des valeurs en valeurs", () => {
    const source = readFileSync(join(__dirname, "pivot.noyau.ts"), "utf8");
    const imports = [...source.matchAll(/^import .*?from\s+["']([^"']+)["']/gm)];
    expect(imports).toHaveLength(0);
  });
});

/** Une ligne correcte, a casser une chose a la fois. */
const correcte = (): Record<string, unknown> => ({
  systeme_source: "ONR_BDR",
  type_objet: "troncon",
  identifiant_source: "RN1-003",
  code_route: "RN1",
  geometrie: { type: "LineString", coordinates: [[-13.5784, 9.6412], [-13.5700, 9.6450]] },
  date_source: "2026-07-08",
  longueur_declaree_km: "12.4",
});

describe("verifierLigne : un rejet porte toujours sa raison (T-04)", () => {
  it("accepte une ligne correcte et range le reste dans attributs sans rien jeter", () => {
    const v = verifierLigne(correcte());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.ligne.typeObjet).toBe("troncon");
    expect(v.ligne.attributs).toEqual({ longueur_declaree_km: "12.4" });
  });

  it.each([
    [{ systeme_source: "" }, /systeme_source manquant/],
    [{ type_objet: "route" }, /type_objet .*inconnu/],
    [{ identifiant_source: "  " }, /identifiant_source manquant.*rapprochement/],
    [{ geometrie: null }, /sans geometrie n'est localise/],
    [{ date_source: "hier" }, /date_source non interpretable/],
  ])("refuse %o avec un motif explicite", (surcharge, motif) => {
    const v = verifierLigne({ ...correcte(), ...surcharge });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.motif).toMatch(motif);
  });

  it("exige debut_m et fin_m ensemble, dans le bon sens", () => {
    const seul = verifierLigne({ ...correcte(), type_objet: "portion", debut_m: "100" });
    expect(seul.ok).toBe(false);
    const inverse = verifierLigne({ ...correcte(), type_objet: "portion", debut_m: "500", fin_m: "100" });
    expect(inverse.ok).toBe(false);
    if (!inverse.ok) expect(inverse.motif).toMatch(/emprise incoherente/);
    const virgule = verifierLigne({ ...correcte(), type_objet: "portion", debut_m: "100,5", fin_m: "250" });
    expect(virgule.ok).toBe(true);
    if (virgule.ok) expect(virgule.ligne.debutM).toBe(100.5);
  });

  it("accepte un comptage sans geometrie : il n'est pas localise par un trace", () => {
    const v = verifierLigne({ ...correcte(), type_objet: "comptage", geometrie: null, debut_m: "", fin_m: "" });
    expect(v.ok).toBe(true);
  });
});

describe("SRID 4326, et rien d'autre (T-11)", () => {
  it("refuse une coordonnee qui ne peut pas etre une longitude", () => {
    // 7 500 000 est une coordonnee UTM, pas une longitude : le fichier n'est pas en 4326.
    const v = verifierGeometrie({ type: "Point", coordinates: [650000, 7500000] });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.motif).toMatch(new RegExp(`SRID ${SRID_PIVOT}`));
  });

  it("refuse une collection GeoJSON qui declare un autre CRS", () => {
    const r = lireGeoJson({
      type: "FeatureCollection",
      crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32628" } },
      features: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motif).toMatch(/32628.*refuse/);
  });

  it("accepte CRS84, EPSG:4326 et l'absence de crs (RFC 7946)", () => {
    for (const crs of [
      { type: "name", properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" } },
      { type: "name", properties: { name: "EPSG:4326" } },
      undefined,
    ]) {
      const r = lireGeoJson({ type: "FeatureCollection", crs, features: [] });
      expect(r.ok, `crs ${JSON.stringify(crs)}`).toBe(true);
    }
  });

  it("refuse un type de geometrie que le pivot ne transporte pas", () => {
    const v = verifierGeometrie({ type: "Polygon", coordinates: [] });
    expect(v.ok).toBe(false);
  });
});

describe("CSV : decoupage fidele", () => {
  it("respecte les guillemets, le separateur dans un champ cite et le guillemet double", () => {
    expect(decouperLigneCsv('a;"b;c";"d ""e"" f";;g')).toEqual(["a", "b;c", 'd "e" f', "", "g"]);
  });

  it("ignore le BOM, les lignes vides et les commentaires, et garde les colonnes inconnues", () => {
    const texte = "﻿# dictionnaire\nsysteme_source;type_objet;identifiant_source;couleur\n\nONR_BDR;troncon;X;rouge\n";
    const { entete, lignes } = lireCsv(texte);
    expect(entete).toEqual(["systeme_source", "type_objet", "identifiant_source", "couleur"]);
    expect(lignes).toHaveLength(1);
    expect(lignes[0].couleur).toBe("rouge");
  });
});

describe("Memes comptes en CSV et en GeoJSON (X-02)", () => {
  const lignes: LignePivot[] = [
    { systemeSource: "ONR_BDR", typeObjet: "troncon", identifiantSource: "A", codeRoute: "RN1",
      geometrie: { type: "LineString", coordinates: [[-13.5, 9.6], [-13.4, 9.7]] }, attributs: { libelle: "Km 3; carrefour" } },
    { systemeSource: "ONR_BDR", typeObjet: "portion", identifiantSource: "B", debutM: 100, finM: 250,
      geometrie: null, attributs: {} },
    { systemeSource: "ANASUR_COLLECT", typeObjet: "degradation", identifiantSource: "C",
      geometrie: { type: "Point", coordinates: [-13.45, 9.65] }, dateSource: "2026-07-08", attributs: { gravite: 3 } },
    { systemeSource: "AI4_TRAFIC", typeObjet: "comptage", identifiantSource: "D", geometrie: null, attributs: { tmja: 1240 } },
  ];

  it("un aller-retour CSV conserve chaque ligne, y compris un libelle avec le separateur", () => {
    const csv = ecrireCsv(lignes);
    const relu = lireCsv(csv).lignes.map((x) => verifierLigne(x));
    expect(relu.every((v) => v.ok)).toBe(true);
    const ok = relu.filter((v): v is { ok: true; ligne: LignePivot } => v.ok).map((v) => v.ligne);
    expect(ok.map((l) => l.identifiantSource)).toEqual(["A", "B", "C", "D"]);
    expect(ok[0].attributs.libelle).toBe("Km 3; carrefour");
    expect(ok[1].debutM).toBe(100);
    expect(ok[2].geometrie).toEqual({ type: "Point", coordinates: [-13.45, 9.65] });
  });

  it("un aller-retour GeoJSON conserve les memes lignes, et les deux formats donnent les memes comptes", () => {
    const gj = ecrireGeoJson(lignes);
    expect(gj.crs.properties.name).toBe("urn:ogc:def:crs:OGC:1.3:CRS84");
    const lu = lireGeoJson(JSON.parse(JSON.stringify(gj)));
    expect(lu.ok).toBe(true);
    if (!lu.ok) return;
    const verdictsGj = lu.lignes.map((x) => verifierLigne(x));
    const verdictsCsv = lireCsv(ecrireCsv(lignes)).lignes.map((x) => verifierLigne(x));

    const comptes = (vs: ReturnType<typeof verifierLigne>[]) =>
      comptabiliser(vs.map((v) => (v.ok ? "VALIDEE" : "REJETEE")));
    expect(comptes(verdictsGj)).toEqual(comptes(verdictsCsv));
    expect(comptes(verdictsGj)).toEqual({ lues: 4, validees: 4, importees: 0, rejetees: 0, enConflit: 0, ignorees: 0 });
  });
});

describe("100 % des lignes dans un statut (T-02, A28)", () => {
  it("la somme des compteurs egale le nombre de lignes, quel que soit le melange", () => {
    const c = comptabiliser(["VALIDEE", "IMPORTEE", "REJETEE", "EN_CONFLIT", "IGNOREE", "VALIDEE", "REJETEE"]);
    expect(c).toEqual({ lues: 7, validees: 2, importees: 1, rejetees: 2, enConflit: 1, ignorees: 1 });
    expect(compteursComplets(c)).toBe(true);
  });

  it("detecte des compteurs qui ne se somment pas -- la propriete que la base impose aussi", () => {
    expect(compteursComplets({ lues: 5, validees: 0, importees: 2, rejetees: 2, enConflit: 0, ignorees: 0 })).toBe(false);
  });

  it("un lot vide se comptabilise sans erreur", () => {
    expect(comptabiliser([])).toEqual({ lues: 0, validees: 0, importees: 0, rejetees: 0, enConflit: 0, ignorees: 0 });
  });
});

describe("Doublons internes au lot", () => {
  const ok = (type: "troncon" | "degradation", id: string) =>
    verifierLigne({ systeme_source: "ONR", type_objet: type, identifiant_source: id,
      geometrie: { type: "Point", coordinates: [-13.5, 9.6] } });

  it("met a l'ecart la seconde occurrence et conserve la premiere, en disant laquelle", () => {
    const r = marquerDoublonsInternes([
      { numeroLigne: 1, verdict: ok("troncon", "A") },
      { numeroLigne: 2, verdict: ok("troncon", "B") },
      { numeroLigne: 3, verdict: ok("troncon", "A") },
    ]);
    expect(r.map((x) => x.statut)).toEqual(["VALIDEE", "VALIDEE", "IGNOREE"]);
    expect(r[2].motif).toMatch(/ligne 1, conservee/);
  });

  it("ne confond pas deux types d'objet portant le meme identifiant", () => {
    const r = marquerDoublonsInternes([
      { numeroLigne: 1, verdict: ok("troncon", "A") },
      { numeroLigne: 2, verdict: ok("degradation", "A") },
    ]);
    expect(r.map((x) => x.statut)).toEqual(["VALIDEE", "VALIDEE"]);
  });

  it("laisse un rejet rejete, avec son motif, sans le compter comme doublon", () => {
    const r = marquerDoublonsInternes([
      { numeroLigne: 1, verdict: verifierLigne({ systeme_source: "ONR" }) },
      { numeroLigne: 2, verdict: ok("troncon", "A") },
    ]);
    expect(r[0].statut).toBe("REJETEE");
    expect(r[0].motif).toMatch(/type_objet/);
    expect(r[1].statut).toBe("VALIDEE");
  });
});

describe("Idempotence (T-06)", () => {
  const empreinte = "a".repeat(64);

  it("la meme ligne du meme fichier donne toujours la meme cle", () => {
    expect(cleIdempotence(empreinte, 12)).toBe(cleIdempotence(empreinte, 12));
    expect(cleIdempotence(empreinte, 12)).not.toBe(cleIdempotence(empreinte, 13));
  });

  it("refuse une empreinte qui n'a pas la forme d'un SHA-256 plutot que de rendre une cle douteuse", () => {
    expect(cleIdempotence("fichier.csv", 1)).toBeNull();
    expect(cleIdempotence("A".repeat(64), 1)).toBeNull();
    expect(cleIdempotence(empreinte, 0)).toBeNull();
    expect(cleIdempotence(empreinte, 1.5)).toBeNull();
  });
});

describe("Ce que le pivot declare ne pas faire", () => {
  it("ne transporte que les cinq types d'objet convenus", () => {
    expect([...TYPES_OBJET_PIVOT]).toEqual(["troncon", "portion", "degradation", "ouvrage", "comptage"]);
  });

  it("n'offre aucune fonction GeoPackage : l'ecart est consigne, pas masque", async () => {
    const mod = await import("./pivot.noyau");
    expect(Object.keys(mod).some((k) => /gpkg|geopackage/i.test(k))).toBe(false);
  });
});
