import { describe, expect, it } from "vitest";
import { classerAcces, isoUtc, licencePour, normaliserItemStac, tuileMgrsValide, type ContexteNormalisation } from "./normalisation";
import { nettoyerLien } from "./http";
import { charger } from "./essais.support";
import * as syn from "./__fixtures__/synthetiques";
import type { ProduitNormalise } from "./contrat";

/**
 * Normalisation exacte contre des reponses REELLES (fixtures capturees le 25/10/2026, requetes
 * anonymes) : champs, unites, MGRS, resolution, licence, nuages null pour le radar. Les cas limites
 * qu'aucune reponse reelle n'a produits viennent de __fixtures__/synthetiques.ts (synthetique: true).
 */

const CDSE: Omit<ContexteNormalisation, "collection"> = { source: "cdse-stac", fournisseur: "CDSE" };
const ES: Omit<ContexteNormalisation, "collection"> = { source: "earth-search", fournisseur: "EARTH_SEARCH" };

function produits(fichier: string, ctx: Omit<ContexteNormalisation, "collection">, collection: string, page: "reponse" | "suite" = "reponse"): ProduitNormalise[] {
  const f = charger(fichier);
  const rep = page === "reponse" ? f.reponse : f.suite!.reponse;
  return rep.features.map((it: unknown) => {
    const r = normaliserItemStac(it, { ...ctx, collection });
    if (!r.ok) throw new Error(`${fichier} : ${r.code} ${r.message}`);
    return r.produit;
  });
}

describe("les fixtures sont des reponses reelles etiquetees", () => {
  it.each([
    "cdse-stac-s2-l2a.json", "cdse-stac-s2-l1c.json", "cdse-stac-s1-grd.json", "cdse-stac-s2-l2a-item-complet.json",
    "cdse-stac-s1-grd-item-complet.json", "earth-search-s2-l2a.json", "earth-search-s1-grd.json", "earth-search-landsat-c2-l2.json",
    "collections-licences.json",
  ])("%s porte capturee, requete, reel et la nature de sa reduction, sans secret", (nom) => {
    const f = charger(nom);
    expect(f._fixture.reel).toBe(true);
    expect(f._fixture.capturee).toBe("2026-10-25");
    expect(f._fixture.requete.url).toMatch(/^https:\/\//);
    expect(f._fixture.reduction.length).toBeGreaterThan(10);
    const texte = JSON.stringify(f);
    expect(texte).not.toMatch(/access_token|client_secret|Bearer |password/i);
    expect(texte).not.toContain('"synthetique"');
    expect(texte.length).toBeLessThan(60_000);
  });
});

describe("Sentinel-2 L2A du CDSE (requete a `fields`)", () => {
  const [pet, pes] = produits("cdse-stac-s2-l2a.json", CDSE, "sentinel-2-l2a");

  it("rend exactement les champs du produit", () => {
    expect(pet).toMatchObject({
      identifiantFournisseur: "S2C_MSIL2A_20261025T112141_N0513_R037_T28PET_20261025T142809",
      fournisseur: "CDSE", source: "cdse-stac", collection: "sentinel-2-l2a", capteur: "SENTINEL-2", nature: "OPTIQUE",
      plateforme: "sentinel-2c", typeProduit: "S2MSI2A", niveauTraitement: "L2A",
      dateAcquisition: "2026-10-25T11:21:41.025Z", dateFinAcquisition: "2026-10-25T11:21:41.025Z",
      orbite: { numeroRelatif: 37, numeroAbsolu: 11161, sens: "descending" },
      tuileMgrs: "28PET", grille: "MGRS-28PET",
      scene: "S2C_MSIL2A_20261025T112141_N0513_R037_T28PET_20261025T142809",
      cleScene: "S2|sentinel-2c|L2A|28PET|2026-10-25",
      couvertureNuagesPct: 35.65, nuagesPortee: "TUILE", echantillonnageM: null, empreinteSha256: null,
    });
    expect(pes.tuileMgrs).toBe("28PES");
    expect(pes.couvertureNuagesPct).toBe(37.54);
  });

  it("emprise : Polygon WGS84 valide, de la tuile entiere (pas de la zone demandee)", () => {
    expect(pet.emprise.type).toBe("Polygon");
    const xs = pet.emprise.coordinates[0].map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(-15.0, 1);
    expect(pet.emprise.coordinates[0][0]).toEqual(pet.emprise.coordinates[0].at(-1));
  });

  it("resolution : 10 m native, detail par bande lu chez le fournisseur", () => {
    expect(pet.resolutionNativeM).toBe(10);
    expect(pet.resolutionOrigine).toBe("FOURNISSEUR");
    expect(pet.resolutionParBande).toEqual({ B01: 60, B02: 10, B03: 10, B04: 10, B05: 20, B06: 20, B07: 20, B08: 10, B09: 60, B11: 20, B12: 20, B8A: 20 });
  });

  it("licence Copernicus Sentinel, attribution portant l'annee d'acquisition", () => {
    expect(pet.licence).toEqual({
      code: "COPERNICUS-SENTINEL", attribution: "Contains modified Copernicus Sentinel data 2026",
      url: "https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice",
    });
  });

  it("taille annoncee : celle de l'archive telechargeable, pas celle du dossier SAFE", () => {
    expect(pet.tailleOctetsAnnoncee).toBe(1_128_150_327);
    expect(pet.brut.proprietes).toMatchObject({ "_private.product_size": 1_128_115_341 });
  });

  it("liens : actifs retenus avec leur mode d'acces, sans parametre de requete", () => {
    const b02 = pet.liens.actifs.find((a) => a.cle === "B02_10m")!;
    expect(b02).toMatchObject({ type: "image/jp2", resolutionM: 10, tailleOctets: 116_845_253, acces: "CLES_S3" });
    expect(b02.href).toMatch(/^s3:\/\/eodata\/Sentinel-2\/MSI\/L2A\/2026\/10\/25\//);
    expect(pet.liens.actifs.find((a) => a.cle === "Product")).toMatchObject({ acces: "JETON_OIDC", resolutionM: null });
    expect(pet.liens.actifs.map((a) => a.cle)).toEqual(["B02_10m", "B03_10m", "B04_10m", "B08_10m", "B8A_20m", "B11_20m", "B12_20m", "SCL_20m", "TCI_10m", "Product"]);
    for (const a of pet.liens.actifs) expect(a.href).not.toMatch(/[?#]/);
  });

  it("vignette du CDSE : acces anonyme NON verifie, donc INCONNU", () => {
    expect(pet.liens.vignette).toMatchObject({ cle: "thumbnail", type: "image/jpeg", acces: "INCONNU" });
  });

  it("le brut est un sous-ensemble : aucun lien, aucun secret, aucun schema de stockage", () => {
    const texte = JSON.stringify(pet.brut);
    expect(texte).toContain("sentinel-2c");
    expect(texte).not.toMatch(/auth:schemes|storage:schemes|openIdConnect/);
    expect(texte.length).toBeLessThan(1500);
  });
});

describe("le meme produit en item COMPLET donne les memes valeurs", () => {
  const complets = produits("cdse-stac-s2-l2a-item-complet.json", CDSE, "sentinel-2-l2a");
  const reduits = produits("cdse-stac-s2-l2a.json", CDSE, "sentinel-2-l2a");
  it("resolution native par bande : les versions reechantillonnees (B02_20m, B02_60m) sont ignorees", () => {
    expect(complets[0].resolutionParBande.B02).toBe(10);
    expect(complets[0].resolutionParBande.B05).toBe(20);
    expect(complets[0].resolutionParBande).toEqual(reduits[0].resolutionParBande);
    expect(complets[0].resolutionOrigine).toBe("FOURNISSEUR");
  });
  it("memes identifiants, dates, nuages, taille", () => {
    for (const k of ["identifiantFournisseur", "dateAcquisition", "couvertureNuagesPct", "tailleOctetsAnnoncee", "cleScene", "tuileMgrs", "resolutionNativeM"] as const) {
      expect(complets[0][k]).toEqual(reduits[0][k]);
    }
  });
});

describe("Sentinel-2 L1C du CDSE", () => {
  const [a, b] = produits("cdse-stac-s2-l1c.json", CDSE, "sentinel-2-l1c");
  it("niveau L1C, bande B10 (cirrus) presente, cle de scene distincte de la L2A", () => {
    expect(a).toMatchObject({ niveauTraitement: "L1C", typeProduit: "S2MSI1C", couvertureNuagesPct: 20.76, tuileMgrs: "28PET", cleScene: "S2|sentinel-2c|L1C|28PET|2026-10-25" });
    expect(a.resolutionParBande.B10).toBe(60);
    expect(b.couvertureNuagesPct).toBe(25.24);
    expect(a.liens.actifs.map((l) => l.cle)).toContain("TCI");
  });
});

describe("Sentinel-1 GRD du CDSE", () => {
  const [s1] = produits("cdse-stac-s1-grd.json", CDSE, "sentinel-1-grd");
  it("radar : nature RADAR, nuages null (jamais 0), pas de tuile MGRS", () => {
    expect(s1).toMatchObject({
      nature: "RADAR", capteur: "SENTINEL-1", niveauTraitement: "L1_GRD", typeProduit: "IW_GRDH_1S", plateforme: "sentinel-1d",
      couvertureNuagesPct: null, nuagesPortee: null, tuileMgrs: null, grille: null,
      orbite: { numeroRelatif: 60, numeroAbsolu: 5176, sens: "ascending" },
    });
  });
  it("resolution 20 m (portee, la plus fine de 20 x 22 m), pas d'echantillonnage de 10 m, origine = table", () => {
    expect(s1.resolutionNativeM).toBe(20);
    expect(s1.resolutionParBande).toEqual({ VV: 20, VH: 20 });
    expect(s1.echantillonnageM).toBe(10);
    expect(s1.resolutionOrigine).toBe("TABLE_CAPTEUR");
  });
  it("identifiant de scene commun aux catalogues : les huit premiers segments, sans CRC ni _COG", () => {
    expect(s1.identifiantFournisseur).toBe("S1D_IW_GRDH_1SDV_20261025T190808_20261025T190833_005176_009D21_624C_COG");
    expect(s1.scene).toBe("S1D_IW_GRDH_1SDV_20261025T190808_20261025T190833_005176_009D21");
    expect(s1.cleScene).toBe(`S1|${s1.scene}`);
  });
  it("taille de l'archive, attribution, liens vv/vh en CLES_S3", () => {
    expect(s1.tailleOctetsAnnoncee).toBe(1_177_914_294);
    expect(s1.licence.attribution).toBe("Contains modified Copernicus Sentinel data 2026");
    expect(s1.liens.actifs.filter((l) => l.cle === "vv" || l.cle === "vh").every((l) => l.acces === "CLES_S3")).toBe(true);
  });
  it("item complet : meme resultat", () => {
    const [complet] = produits("cdse-stac-s1-grd-item-complet.json", CDSE, "sentinel-1-grd");
    expect(complet).toMatchObject({ resolutionNativeM: 20, echantillonnageM: 10, couvertureNuagesPct: null, typeProduit: "IW_GRDH_1S" });
  });
});

describe("Earth Search", () => {
  const [pes, pet] = produits("earth-search-s2-l2a.json", ES, "sentinel-2-l2a");
  it("Sentinel-2 : identifiant propre au catalogue, MGRS, nuages, pas de taille annoncee (null, pas 0)", () => {
    expect(pes).toMatchObject({
      identifiantFournisseur: "S2C_28PES_20261025_0_L2A", fournisseur: "EARTH_SEARCH", tuileMgrs: "28PES", grille: "MGRS-28PES",
      dateAcquisition: "2026-10-25T11:38:32.428Z", couvertureNuagesPct: 37.540361, tailleOctetsAnnoncee: null, typeProduit: "S2MSI2A",
    });
    expect(pet.tuileMgrs).toBe("28PET");
  });
  it("orbite relative lue dans le nom du produit ESA quand le fournisseur ne la donne pas ; le reste reste null", () => {
    expect(pes.orbite).toEqual({ numeroRelatif: 37, numeroAbsolu: null, sens: null });
  });
  it("resolution lue dans les actifs (eo:bands + gsd), 10 m", () => {
    expect(pes.resolutionNativeM).toBe(10);
    expect(pes.resolutionOrigine).toBe("FOURNISSEUR");
    expect(pes.resolutionParBande).toMatchObject({ B02: 10, B03: 10, B04: 10, B08: 10, B05: 20, B8A: 20, B11: 20, B12: 20, B01: 60, B09: 60 });
  });
  it("vignette et COG Sentinel-2 : acces ANONYME (constate), s3:// non", () => {
    expect(pes.liens.vignette).toMatchObject({ acces: "ANONYME", type: "image/jpeg" });
    expect(pes.liens.actifs.map((a) => a.acces)).toEqual(Array(9).fill("ANONYME"));
  });
  it("le meme produit, vu par les deux catalogues, a la meme cle de scene (deduplication)", () => {
    const cdse = produits("cdse-stac-s2-l2a.json", CDSE, "sentinel-2-l2a");
    expect(pes.cleScene).toBe(cdse[1].cleScene); // 28PES
    expect(pet.cleScene).toBe(cdse[0].cleScene); // 28PET
    expect(pes.scene).toBe(cdse[1].scene);
    expect(pes.identifiantFournisseur).not.toBe(cdse[1].identifiantFournisseur);
  });
  it("Sentinel-1 : resolution lue chez le fournisseur (20 x 22 m), identifiant de scene egal a celui du CDSE", () => {
    const [es] = produits("earth-search-s1-grd.json", ES, "sentinel-1-grd");
    const [cdse] = produits("cdse-stac-s1-grd.json", CDSE, "sentinel-1-grd");
    expect(es).toMatchObject({ resolutionNativeM: 20, resolutionOrigine: "FOURNISSEUR", echantillonnageM: 10, couvertureNuagesPct: null, typeProduit: "IW_GRDH_1S" });
    expect(es.cleScene).toBe(cdse.cleScene);
    expect(es.liens.vignette?.acces).toBe("IDENTIFIANTS_CLOUD");
  });
  it("Landsat C2 L2 : 30 m, thermique a 100 m a part, domaine public, nuages de SCENE", () => {
    const [ls] = produits("earth-search-landsat-c2-l2.json", ES, "landsat-c2-l2");
    expect(ls).toMatchObject({
      capteur: "LANDSAT", nature: "OPTIQUE", niveauTraitement: "L2", plateforme: "landsat-9", typeProduit: "L2SP", grille: "WRS2-203053",
      scene: "LC92030532026288LGN00", resolutionNativeM: 30, couvertureNuagesPct: 77.07, nuagesPortee: "SCENE", tuileMgrs: null,
      cleScene: "LANDSAT|landsat-9|WRS2-203053|2026-10-15",
    });
    expect(ls.resolutionParBande).toMatchObject({ blue: 30, nir08: 30, swir16: 30, lwir11: 100 });
    expect(ls.licence.code).toBe("USGS-LANDSAT-DOMAINE-PUBLIC");
  });
});

describe("licences : ce que disent les collections reelles", () => {
  const coll = charger("collections-licences.json").reponse;
  it("Sentinel : la licence de collection renvoie a la Sentinel Data Legal Notice", () => {
    expect(coll["earth-search:sentinel-2-l2a"].liens.find((l: any) => l.rel === "license").href).toMatch(/Sentinel_Data_Legal_Notice/);
    expect(coll["cdse-stac:sentinel-2-l1c"].liens.find((l: any) => l.rel === "license").href).toMatch(/Sentinel_Data_Legal_Notice/);
    expect(licencePour("SENTINEL-2", 2026).url).toMatch(/Sentinel_Data_Legal_Notice/);
  });
  it("Landsat : la licence de collection renvoie a la politique de donnees USGS", () => {
    expect(coll["earth-search:landsat-c2-l2"].liens.find((l: any) => l.rel === "license").href).toBe(licencePour("LANDSAT", 2026).url);
  });
});

describe("cas limites (jeux fabriques, synthetique: true)", () => {
  const norm = (item: unknown, ctx = CDSE, collection = "sentinel-2-l2a") => normaliserItemStac(item, { ...ctx, collection });

  it("couverture nuageuse absente : le produit reste, nuages null et avertissement, jamais 0", () => {
    const r = norm(syn.sansNuages());
    expect(r.ok && r.produit.couvertureNuagesPct).toBeNull();
    expect(r.ok && r.produit.nuagesPortee).toBeNull();
    expect(r.ok && r.avertissements.map((a) => a.code)).toEqual(["NUAGES_ABSENTS"]);
  });
  it("un vrai zero annonce reste 0", () => {
    const r = norm(syn.zeroNuagesAnnonce());
    expect(r.ok && r.produit.couvertureNuagesPct).toBe(0);
    expect(r.ok && r.produit.nuagesPortee).toBe("TUILE");
  });
  it("couverture nuageuse hors 0-100 : ignoree (null) avec avertissement", () => {
    for (const v of [140, -3]) {
      const r = norm(syn.nuagesHorsBornes(v));
      expect(r.ok && r.produit.couvertureNuagesPct).toBeNull();
      expect(r.ok && r.avertissements[0].code).toBe("NUAGES_INVALIDES");
    }
  });
  it("radar qui annonce des nuages par erreur : ignores", () => {
    const r = norm(syn.radarAvecNuagesParErreur(), CDSE, "sentinel-1-grd");
    expect(r.ok && r.produit.couvertureNuagesPct).toBeNull();
  });
  it.each([
    ["emprise non fermee", syn.empriseNonFermee(), "EMPRISE_INVALIDE"],
    ["emprise absente", syn.empriseAbsente(), "EMPRISE_INVALIDE"],
    ["emprise degeneree", syn.empriseDegeneree(), "EMPRISE_INVALIDE"],
    ["emprise hors du globe", syn.empriseHorsGlobe(), "EMPRISE_INVALIDE"],
    ["date illisible", syn.dateIllisible(), "DATE_INVALIDE"],
    ["collection inconnue", syn.collectionInconnue(), "COLLECTION_INCONNUE"],
    ["item sans identifiant", syn.sansIdentifiant(), "ITEM_ILLISIBLE"],
  ])("%s : le produit est ECARTE avec sa cause, pas corrige", (_nom, item, code) => {
    const r = norm(item);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  });
  it("on ne fabrique pas d'emprise a partir du bbox", () => {
    const item = syn.empriseAbsente();
    expect(item.bbox).toBeDefined();
    expect(norm(item).ok).toBe(false);
  });
  it("radar en mode EW : resolution indeterminable, ecarte (la table ne couvre que IW GRDH)", () => {
    const r = norm(syn.radarModeEw(), CDSE, "sentinel-1-grd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("RESOLUTION_INCONNUE");
  });
  it("lien signe : identifiant, signature, parametres et fragment retires", () => {
    const r = norm(syn.lienSigne(), ES);
    expect(r.ok && r.produit.liens.vignette?.href).toBe("https://sentinel-cogs.s3.us-west-2.amazonaws.com/preview.jpg");
    expect(JSON.stringify(r.ok && r.produit)).not.toMatch(/ABCDEF123456|motdepasse|utilisateur/);
  });
  it("une entree qui n'est pas un objet est ecartee proprement", () => {
    for (const v of [null, 12, "x", [], undefined]) expect(norm(v).ok).toBe(false);
  });
});

describe("petites fonctions", () => {
  it("isoUtc : une date sans fuseau est lue comme UTC, une date seule comme minuit UTC", () => {
    expect(isoUtc("2026-10-25T11:21:41.025000Z")).toBe("2026-10-25T11:21:41.025Z");
    expect(isoUtc("2026-10-25T11:21:41")).toBe("2026-10-25T11:21:41.000Z");
    expect(isoUtc("2026-10-25")).toBe("2026-10-25T00:00:00.000Z");
    expect(isoUtc("2026-10-25T12:00:00+02:00")).toBe("2026-10-25T10:00:00.000Z");
    expect(isoUtc("hier")).toBeNull();
    expect(isoUtc(12)).toBeNull();
  });
  it("tuileMgrsValide", () => {
    expect(tuileMgrsValide("28PET")).toBe(true);
    for (const t of ["28PEZ", "00PET", "61PET", "28IET", "28PIT", "28pet", "28PE"]) expect(tuileMgrsValide(t)).toBe(false);
  });
  it("classerAcces", () => {
    expect(classerAcces("s3://eodata/Sentinel-2/x")).toBe("CLES_S3");
    expect(classerAcces("s3://sentinel-s1-l1c/GRD/x")).toBe("IDENTIFIANTS_CLOUD");
    expect(classerAcces("https://download.dataspace.copernicus.eu/odata/v1/Products(x)/$value")).toBe("JETON_OIDC");
    expect(classerAcces("https://sentinel-cogs.s3.us-west-2.amazonaws.com/a/B02.tif")).toBe("ANONYME");
    expect(classerAcces("http://sentinel-cogs.s3.us-west-2.amazonaws.com/a/B02.tif")).toBe("INCONNU");
    expect(classerAcces("https://exemple.org/x")).toBe("INCONNU");
    expect(classerAcces("pas une url")).toBe("INCONNU");
  });
  it("nettoyerLien garde s3:// et retire userinfo, requete et fragment", () => {
    expect(nettoyerLien("s3://eodata/a/b?x=1")).toBe("s3://eodata/a/b");
    expect(nettoyerLien("https://u:p@h.example/a?sig=1#f")).toBe("https://h.example/a");
    expect(nettoyerLien("illisible")).toBe("");
  });
});
