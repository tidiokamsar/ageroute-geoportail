import { afterEach, describe, expect, it } from "vitest";
import { BBOX_GUINEE } from "../lecture.types";
import { epsgPourLongitude } from "../analyse.noyau";
import { analyseIntervalleMinS, conflitsParAnalyseMax, sommetsParObjetMax } from "../config";
import { crsSourceAutorises } from "../formats/import.config";
import { configurationParDefaut, estPerime, fenetreCacheMs, invalider, poser, protectionEnCache, vider } from "./configuration.cache";
import {
  CLES, DEFAUTS, entierEnv, epsgHorsListe, epsgPourLongitudeSelon, estCle, listeCrsEnv, lireValeurBase, resoudre, validerValeur,
} from "./configuration.noyau";

describe("cles et defauts", () => {
  it("quatre cles ; les defauts sont les constantes historiques du socle", () => {
    expect(CLES).toEqual(["EMPRISE_PLAUSIBILITE", "CRS_METRIQUE_BANDES", "CRS_IMPORT_LISTE_BLANCHE", "PROTECTIONS"]);
    expect(DEFAUTS.EMPRISE_PLAUSIBILITE.bbox).toEqual(BBOX_GUINEE);
    expect(DEFAUTS.CRS_IMPORT_LISTE_BLANCHE.epsg).toEqual([4326, 32628, 32629]);
    expect(estCle("PROTECTIONS")).toBe(true);
    expect(estCle("VILLES")).toBe(false);
  });
});

describe("schemas des valeurs", () => {
  it("EMPRISE_PLAUSIBILITE : nom et rectangle ordonne en degres", () => {
    expect(validerValeur("EMPRISE_PLAUSIBILITE", { nom: "Zone", bbox: [-15, 7, -7, 13] }).ok).toBe(true);
    expect(validerValeur("EMPRISE_PLAUSIBILITE", { nom: "Zone", bbox: [-7, 7, -15, 13] })).toMatchObject({ ok: false, erreurs: { bbox: expect.any(Array) } });
    expect(validerValeur("EMPRISE_PLAUSIBILITE", { nom: "Zone", bbox: [-15, 7, -7] }).ok).toBe(false);
    expect(validerValeur("EMPRISE_PLAUSIBILITE", { nom: "Zone", bbox: [-200, 7, -7, 13] }).ok).toBe(false);
    expect(validerValeur("EMPRISE_PLAUSIBILITE", { nom: "", bbox: [-15, 7, -7, 13] }).ok).toBe(false);
    expect(validerValeur("EMPRISE_PLAUSIBILITE", { nom: "Zone", bbox: [-15, 7, -7, 13], ville: "x" }).ok).toBe(false);
  });

  it("CRS_METRIQUE_BANDES : bandes triees strictement, EPSG entiers, defaut obligatoire", () => {
    expect(validerValeur("CRS_METRIQUE_BANDES", { bandes: [{ jusquaLongitude: -12, epsg: 32628 }], epsgDefaut: 32629 }).ok).toBe(true);
    expect(validerValeur("CRS_METRIQUE_BANDES", { bandes: [], epsgDefaut: 32629 }).ok).toBe(true);
    expect(validerValeur("CRS_METRIQUE_BANDES", { bandes: [{ jusquaLongitude: -6, epsg: 32629 }, { jusquaLongitude: -12, epsg: 32628 }], epsgDefaut: 32629 })).toMatchObject({ ok: false, erreurs: { bandes: expect.any(Array) } });
    expect(validerValeur("CRS_METRIQUE_BANDES", { bandes: [{ jusquaLongitude: -12, epsg: 32628 }, { jusquaLongitude: -12, epsg: 32629 }], epsgDefaut: 32629 }).ok).toBe(false);
    expect(validerValeur("CRS_METRIQUE_BANDES", { bandes: [], epsgDefaut: 3.5 }).ok).toBe(false);
    expect(validerValeur("CRS_METRIQUE_BANDES", { bandes: [] }).ok).toBe(false);
  });

  it("CRS_IMPORT_LISTE_BLANCHE : 1 a 20 codes, 4326 obligatoire, sans doublon", () => {
    expect(validerValeur("CRS_IMPORT_LISTE_BLANCHE", { epsg: [4326, 32628] }).ok).toBe(true);
    expect(validerValeur("CRS_IMPORT_LISTE_BLANCHE", { epsg: [32628] })).toMatchObject({ ok: false, erreurs: { epsg: expect.any(Array) } });
    expect(validerValeur("CRS_IMPORT_LISTE_BLANCHE", { epsg: [4326, 4326] }).ok).toBe(false);
    expect(validerValeur("CRS_IMPORT_LISTE_BLANCHE", { epsg: [] }).ok).toBe(false);
    expect(validerValeur("CRS_IMPORT_LISTE_BLANCHE", { epsg: [4326, ...Array.from({ length: 20 }, (_, i) => 30000 + i)] }).ok).toBe(false);
  });

  it("PROTECTIONS : sous-cles facultatives dans les bornes de config.ts, cle inconnue refusee", () => {
    expect(validerValeur("PROTECTIONS", {}).ok).toBe(true);
    expect(validerValeur("PROTECTIONS", { analyseIntervalleS: 0, conflitsMax: 100 }).ok).toBe(true);
    expect(validerValeur("PROTECTIONS", { analyseIntervalleS: 3601 })).toMatchObject({ ok: false, erreurs: { analyseIntervalleS: expect.any(Array) } });
    expect(validerValeur("PROTECTIONS", { conflitsMax: 99 }).ok).toBe(false);
    expect(validerValeur("PROTECTIONS", { delaiAnalyseMs: 20.5 }).ok).toBe(false);
    expect(validerValeur("PROTECTIONS", { inconnue: 1 }).ok).toBe(false);
  });

  it("une valeur en base illisible redonne le defaut, jamais une erreur", () => {
    expect(lireValeurBase("EMPRISE_PLAUSIBILITE", { casse: true })).toEqual({ valeur: DEFAUTS.EMPRISE_PLAUSIBILITE, valide: false });
    expect(lireValeurBase("PROTECTIONS", { conflitsMax: 500 })).toEqual({ valeur: { conflitsMax: 500 }, valide: true });
  });
});

describe("resolution environnement > base > defaut", () => {
  it("l'environnement l'emporte, puis la base, puis le defaut", () => {
    expect(resoudre(5, 7, 9)).toEqual({ valeur: 5, source: "ENV" });
    expect(resoudre(undefined, 7, 9)).toEqual({ valeur: 7, source: "BASE" });
    expect(resoudre(undefined, undefined, 9)).toEqual({ valeur: 9, source: "DEFAUT" });
  });

  it("un entier d'environnement absent, illisible ou hors bornes est ignore (meme regle que config.ts)", () => {
    expect(entierEnv(undefined, 0, 10)).toBeUndefined();
    expect(entierEnv("  ", 0, 10)).toBeUndefined();
    expect(entierEnv("abc", 0, 10)).toBeUndefined();
    expect(entierEnv("11", 0, 10)).toBeUndefined();
    expect(entierEnv("2.5", 0, 10)).toBeUndefined();
    expect(entierEnv("7", 0, 10)).toBe(7);
  });

  it("une liste de CRS d'environnement illisible est ignoree en entier", () => {
    expect(listeCrsEnv("4326, 32628,32628")).toEqual([4326, 32628]);
    expect(listeCrsEnv("4326,abc")).toBeUndefined();
    expect(listeCrsEnv("")).toBeUndefined();
    expect(listeCrsEnv(Array.from({ length: 21 }, (_, i) => String(10000 + i)).join(","))).toBeUndefined();
  });
});

describe("choix du CRS metrique par bandes", () => {
  const defaut = DEFAUTS.CRS_METRIQUE_BANDES;

  it("avec les defauts, redonne exactement la regle historique epsgPourLongitude (bornes comprises)", () => {
    for (const lon of [-15.2, -13.7, -12.0001, -12, -11.99, -10.1, -8, -7.5]) expect(epsgPourLongitudeSelon(defaut, lon)).toBe(epsgPourLongitude(lon));
  });

  it("plusieurs bandes : la premiere dont longitude < jusquaLongitude ; sinon le defaut ; sans bande, toujours le defaut", () => {
    const regle = { bandes: [{ jusquaLongitude: -18, epsg: 32627 }, { jusquaLongitude: -12, epsg: 32628 }, { jusquaLongitude: -6, epsg: 32629 }], epsgDefaut: 32630 };
    expect(epsgPourLongitudeSelon(regle, -20)).toBe(32627);
    expect(epsgPourLongitudeSelon(regle, -18)).toBe(32628);
    expect(epsgPourLongitudeSelon(regle, -9)).toBe(32629);
    expect(epsgPourLongitudeSelon(regle, -6)).toBe(32630);
    expect(epsgPourLongitudeSelon({ bandes: [], epsgDefaut: 32629 }, -14)).toBe(32629);
    expect(epsgPourLongitudeSelon(defaut, Number.NaN)).toBe(32629);
  });

  it("les EPSG d'une regle doivent etre projetes et dans la liste blanche", () => {
    expect(epsgHorsListe(defaut, [4326, 32628, 32629])).toEqual([]);
    expect(epsgHorsListe(defaut, [4326, 32629])).toEqual([32628]);
    expect(epsgHorsListe({ bandes: [], epsgDefaut: 4326 }, [4326])).toEqual([4326]);
  });
});

describe("cache de configuration et lecteurs synchrones de config.ts", () => {
  const ENV = ["PROJETS_VOIRIE_ANALYSE_INTERVALLE_S", "PROJETS_VOIRIE_CONFLITS_MAX", "PROJETS_VOIRIE_SOMMETS_PAR_OBJET", "PROJETS_VOIRIE_CRS_SOURCE_AUTORISES", "PROJETS_VOIRIE_CONFIG_CACHE_MS"];
  const sauvegarde = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of ENV) { if (sauvegarde[k] === undefined) delete process.env[k]; else process.env[k] = sauvegarde[k]; }
    vider();
  });

  it("avant tout chargement : perime, aucune protection en cache, defauts codes", () => {
    vider();
    expect(estPerime()).toBe(true);
    expect(protectionEnCache("conflitsMax")).toBeUndefined();
    delete process.env.PROJETS_VOIRIE_CONFLITS_MAX;
    expect(conflitsParAnalyseMax()).toBe(20_000);
  });

  it("une valeur posee en base est lue par config.ts tant que l'environnement ne la fixe pas ; l'environnement l'emporte", () => {
    delete process.env.PROJETS_VOIRIE_CONFLITS_MAX;
    delete process.env.PROJETS_VOIRIE_ANALYSE_INTERVALLE_S;
    poser({ ...configurationParDefaut(), PROTECTIONS: { conflitsMax: 5_000, analyseIntervalleS: 0 } });
    expect(conflitsParAnalyseMax()).toBe(5_000);
    expect(analyseIntervalleMinS()).toBe(0);
    process.env.PROJETS_VOIRIE_CONFLITS_MAX = "777";
    expect(conflitsParAnalyseMax()).toBe(777);
    // Une valeur de base hors bornes (schema contourne) est ignoree : jamais un plafond absurde.
    poser({ ...configurationParDefaut(), PROTECTIONS: { sommetsParObjet: 5 } });
    delete process.env.PROJETS_VOIRIE_SOMMETS_PAR_OBJET;
    expect(sommetsParObjetMax()).toBe(100_000);
  });

  it("la liste blanche des CRS suit la meme resolution", () => {
    delete process.env.PROJETS_VOIRIE_CRS_SOURCE_AUTORISES;
    vider();
    expect(crsSourceAutorises()).toEqual([4326, 32628, 32629]);
    poser({ ...configurationParDefaut(), CRS_IMPORT_LISTE_BLANCHE: { epsg: [4326, 2043] } });
    expect(crsSourceAutorises()).toEqual([4326, 2043]);
    process.env.PROJETS_VOIRIE_CRS_SOURCE_AUTORISES = "4326,32629";
    expect(crsSourceAutorises()).toEqual([4326, 32629]);
  });

  it("fenetre de fraicheur bornee, peremption et invalidation", () => {
    delete process.env.PROJETS_VOIRIE_CONFIG_CACHE_MS;
    expect(fenetreCacheMs()).toBe(30_000);
    process.env.PROJETS_VOIRIE_CONFIG_CACHE_MS = "999";
    expect(fenetreCacheMs()).toBe(30_000);
    process.env.PROJETS_VOIRIE_CONFIG_CACHE_MS = "5000";
    expect(fenetreCacheMs()).toBe(5_000);
    poser(configurationParDefaut(), 1_000_000);
    expect(estPerime(1_000_000 + 4_999)).toBe(false);
    expect(estPerime(1_000_000 + 5_001)).toBe(true);
    poser(configurationParDefaut(), 2_000_000);
    expect(estPerime(2_000_000)).toBe(false);
    invalider();
    expect(estPerime(2_000_000)).toBe(true);
  });
});
