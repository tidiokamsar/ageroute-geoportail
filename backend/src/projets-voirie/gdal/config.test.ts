import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gdalActif, reglagesGdal, spoolRacine } from "./config";
import { TESTS_REELS, formatsGdalAnnonces } from "./formats.registre";

/** Interrupteur desactive par defaut, bornes des reglages, formats annonces seulement avec une preuve reelle (lot B2). */

const VARIABLES = ["PROJETS_VOIRIE_GDAL", "PROJETS_VOIRIE_GDAL_SPOOL", "PROJETS_VOIRIE_GDAL_DELAI_S", "PROJETS_VOIRIE_GDAL_TENTATIVES", "PROJETS_VOIRIE_GDAL_RETENTION_H",
  "PROJETS_VOIRIE_GDAL_ACTIFS_COMPTE", "PROJETS_VOIRIE_GDAL_SORTIE_MAX_OCTETS", "PROJETS_VOIRIE_GDAL_CONCURRENCE"];
const avant = Object.fromEntries(VARIABLES.map((v) => [v, process.env[v]]));
afterEach(() => { for (const v of VARIABLES) { if (avant[v] === undefined) delete process.env[v]; else process.env[v] = avant[v]; } });

describe("interrupteur PROJETS_VOIRIE_GDAL", () => {
  it("DESACTIVE par defaut, et pour toute valeur autre que 1, oui, true, on", () => {
    delete process.env.PROJETS_VOIRIE_GDAL;
    expect(gdalActif()).toBe(false);
    for (const v of ["", "0", "non", "false", "off", "activé", " ", "2", "oui oui"]) { process.env.PROJETS_VOIRIE_GDAL = v; expect(gdalActif(), v).toBe(false); }
    for (const v of ["1", "oui", "TRUE", " On "]) { process.env.PROJETS_VOIRIE_GDAL = v; expect(gdalActif(), v).toBe(true); }
  });

  it("le dossier d'echange n'a aucun defaut (jamais un chemin devine) ; une valeur vide est refusee", () => {
    delete process.env.PROJETS_VOIRIE_GDAL_SPOOL;
    expect(spoolRacine()).toBeNull();
    process.env.PROJETS_VOIRIE_GDAL_SPOOL = "  ";
    expect(spoolRacine()).toBeNull();
    process.env.PROJETS_VOIRIE_GDAL_SPOOL = "/var/spool/geoconv";
    expect(spoolRacine()).toBe("/var/spool/geoconv");
  });
});

describe("reglages bornes : une valeur illisible ou hors bornes redonne le defaut", () => {
  it("defauts documentes", () => {
    expect(reglagesGdal()).toMatchObject({ delaiJobS: 90, objetsMax: 50_000, sortieOctetsMax: 80 * 1024 * 1024, entreeOctetsMax: 25 * 1024 * 1024, tentativesMax: 3, retentionH: 24, sondageS: 3, concurrence: 2, actifsParCompte: 2, actifsParProjet: 3, fileMax: 20, creationsParHeure: 12 });
  });

  it("jamais au-dessus des plafonds du conteneur (delai 120 s, retention 72 h) ni a zero", () => {
    process.env.PROJETS_VOIRIE_GDAL_DELAI_S = "600";
    process.env.PROJETS_VOIRIE_GDAL_RETENTION_H = "500";
    process.env.PROJETS_VOIRIE_GDAL_TENTATIVES = "0";
    process.env.PROJETS_VOIRIE_GDAL_ACTIFS_COMPTE = "abc";
    process.env.PROJETS_VOIRIE_GDAL_SORTIE_MAX_OCTETS = "9999999999999";
    process.env.PROJETS_VOIRIE_GDAL_CONCURRENCE = "50";
    expect(reglagesGdal()).toMatchObject({ delaiJobS: 90, retentionH: 24, tentativesMax: 3, actifsParCompte: 2, sortieOctetsMax: 80 * 1024 * 1024, concurrence: 2 });
    process.env.PROJETS_VOIRIE_GDAL_DELAI_S = "120";
    process.env.PROJETS_VOIRIE_GDAL_RETENTION_H = "72";
    expect(reglagesGdal()).toMatchObject({ delaiJobS: 120, retentionH: 72 });
  });
});

describe("formats annonces : seulement avec une preuve de bout en bout", () => {
  it("chaque preuve citee existe dans le banc et porte le texte exact de sa verification", () => {
    const racine = path.join(__dirname, "../../../../");
    for (const [format, p] of Object.entries(TESTS_REELS)) {
      const f = path.join(racine, p.fichier);
      expect(existsSync(f), `${format} : ${p.fichier}`).toBe(true);
      const texte = readFileSync(f, "utf8");
      expect(texte.includes(`verifier("${p.verification}`) || texte.includes(`"${p.verification}`), `${format} : verification « ${p.verification} » introuvable dans le banc`).toBe(true);
    }
  });

  it("desactive ou dossier inaccessible : INDISPONIBLE avec la raison ; actif et accessible : SUPPORTE", () => {
    const off = formatsGdalAnnonces({ actif: false, disponible: false, raison: "interrupteur desactive" });
    expect(off.formats.map((f) => f.etat)).toEqual(["INDISPONIBLE", "INDISPONIBLE", "INDISPONIBLE"]);
    expect(off.formats.every((f) => f.raison === "interrupteur desactive")).toBe(true);
    expect(off.limites).toBeNull();
    const inacc = formatsGdalAnnonces({ actif: true, disponible: false, raison: "dossiers inaccessibles" });
    expect(inacc.formats.every((f) => f.etat === "INDISPONIBLE")).toBe(true);
    const ok = formatsGdalAnnonces({ actif: true, disponible: true, raison: null });
    expect(ok.formats.map((f) => f.format)).toEqual(["GPKG", "SHAPEFILE", "DXF"]);
    expect(ok.formats.every((f) => f.etat === "SUPPORTE" && f.raison === null)).toBe(true);
  });

  it("le DXF annonce ses entites supportees et ce qui est ignore et compte ; jamais de promesse sur le DXF binaire, DWG, GML", () => {
    const f = formatsGdalAnnonces({ actif: true, disponible: true, raison: null }).formats;
    const dxf = f.find((x) => x.format === "DXF")!;
    expect(dxf.specifique.entitesSupportees).toEqual(["LINE", "LWPOLYLINE", "POLYLINE", "3DPOLYLINE"]);
    expect(String(dxf.specifique.texte)).toMatch(/binaire est refuse/);
    expect(JSON.stringify(f)).not.toMatch(/DWG|GML|LandXML|raster/);
  });
});
