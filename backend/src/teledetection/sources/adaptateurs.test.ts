import { describe, expect, it } from "vitest";
import { creerAdaptateurCdseStac } from "./adaptateurs/cdse-stac";
import { creerAdaptateurEarthSearch } from "./adaptateurs/earth-search";
import { MESSAGE_FACADE, creerFacadePlanetScope, creerFacadeSpot } from "./adaptateurs/facade";
import { urlBaseValide } from "./adaptateurs/commun";
import { creerAdaptateurs } from "./index";
import { PLAFOND_DECALAGE_STAC, deduireCollection } from "./stac";
import { ErreurSource, type BBox, type ParamsRecherche, type ProduitNormalise, type SourceAdaptateur } from "./contrat";
import { charger, fetchScenario, reponseJson, sommeilFactice } from "./essais.support";
import * as syn from "./__fixtures__/synthetiques";

const BOKE: BBox = [-14.39, 10.83, -14.19, 11.03];
const FENETRE = { debut: "2026-09-01T00:00:00Z", fin: "2026-10-25T23:59:59Z" };
const sommeil = () => sommeilFactice().sleep;

describe("recherche rejouee sur des reponses REELLES : la requete envoyee est celle de la capture", () => {
  const cas = [
    ["cdse-stac-s2-l2a.json", "cdse", 4, 2],
    ["cdse-stac-s2-l1c.json", "cdse", 2, 1],
    ["cdse-stac-s1-grd.json", "cdse", 2, 1],
    ["earth-search-s2-l2a.json", "es", 4, 2],
    ["earth-search-s1-grd.json", "es", 1, 1],
    ["earth-search-landsat-c2-l2.json", "es", 1, 1],
  ] as const;

  it.each(cas)("%s", async (nom, qui, nbProduits, nbPages) => {
    const f = charger(nom);
    const etapes = [reponseJson(f.reponse), ...(f.suite ? [reponseJson(f.suite.reponse)] : [])];
    const { fetch, appels } = fetchScenario(...etapes);
    const a = qui === "cdse" ? creerAdaptateurCdseStac({ fetch, sleep: sommeil() }) : creerAdaptateurEarthSearch({ fetch, sleep: sommeil() });
    const r = await a.rechercher(f._fixture.params as unknown as ParamsRecherche);

    expect(appels).toHaveLength(nbPages);
    expect(appels[0].methode).toBe("POST");
    expect(appels[0].url).toBe(f._fixture.requete.url);
    expect(appels[0].corps).toEqual(f._fixture.requete.corps);
    if (f.suite) {
      expect(appels[1].url).toBe(f.suite.requete.url);
      expect(appels[1].corps).toEqual(f.suite.requete.corps);
    }
    expect(r.produits).toHaveLength(nbProduits);
    expect(r.pagination.pagesLues).toBe(nbPages);
    expect(r.requetes).toHaveLength(nbPages);
    expect(r.diagnostics.filter((d) => d.niveau !== "INFO")).toEqual([]);
    // tous les produits sont des instances completes du contrat
    for (const p of r.produits) {
      expect(p.empreinteSha256).toBeNull();
      expect(p.resolutionNativeM).toBeGreaterThan(0);
      expect(p.licence.attribution.length).toBeGreaterThan(10);
      expect(Date.parse(p.dateAcquisition)).not.toBeNaN();
    }
  });

  it("le STAC du CDSE ne donne pas de total ; Earth Search le donne (numberMatched)", async () => {
    const cdse = charger("cdse-stac-s2-l1c.json");
    const es = charger("earth-search-s1-grd.json");
    const a = creerAdaptateurCdseStac({ fetch: fetchScenario(reponseJson(cdse.reponse)).fetch });
    const b = creerAdaptateurEarthSearch({ fetch: fetchScenario(reponseJson(es.reponse)).fetch });
    expect((await a.rechercher(cdse._fixture.params as unknown as ParamsRecherche)).pagination.totalAnnonce).toBeNull();
    expect((await b.rechercher(es._fixture.params as unknown as ParamsRecherche)).pagination.totalAnnonce).toBe(es.reponse.numberMatched);
    expect(es.reponse.numberMatched).toBeGreaterThan(0);
  });

  it("les requetes du CDSE demandent `fields` (reponse allegee) ; celles d'Earth Search non", () => {
    const c = charger("cdse-stac-s2-l2a.json")._fixture.requete.corps as any;
    const e = charger("earth-search-s2-l2a.json")._fixture.requete.corps as any;
    expect(c.fields.include).toEqual(expect.arrayContaining(["geometry", "properties.eo:cloud_cover", "assets.B02_10m.gsd", "assets.Product.file:size"]));
    expect(e.fields).toBeUndefined();
  });

  it("le seuil de nuages va dans `query` pour l'optique, jamais pour le radar", async () => {
    const f = charger("cdse-stac-s1-grd.json");
    const { fetch, appels } = fetchScenario(reponseJson(f.reponse));
    await creerAdaptateurCdseStac({ fetch }).rechercher({ bbox: BOKE, ...FENETRE, collections: ["sentinel-1-grd"], nuagesMax: 10, pagesMax: 1 });
    expect(appels[0].corps.query).toBeUndefined();
    const g = charger("cdse-stac-s2-l2a.json");
    const s2 = fetchScenario(reponseJson(g.reponse));
    await creerAdaptateurCdseStac({ fetch: s2.fetch }).rechercher({ bbox: BOKE, ...FENETRE, nuagesMax: 10, pagesMax: 1 });
    expect(s2.appels[0].corps.query).toEqual({ "eo:cloud_cover": { lte: 10 } });
  });

  it("plusieurs collections : une recherche par collection, dans l'ordre", async () => {
    const s2 = charger("cdse-stac-s2-l2a.json");
    const s1 = charger("cdse-stac-s1-grd.json");
    const { fetch, appels } = fetchScenario(reponseJson(s2.reponse), reponseJson(s1.reponse));
    const r = await creerAdaptateurCdseStac({ fetch }).rechercher({ bbox: BOKE, ...FENETRE, collections: ["sentinel-2-l2a", "sentinel-1-grd"], pagesMax: 1 });
    expect(appels.map((a) => a.corps.collections[0])).toEqual(["sentinel-2-l2a", "sentinel-1-grd"]);
    expect(r.produits.map((p) => p.capteur)).toEqual(["SENTINEL-2", "SENTINEL-2", "SENTINEL-1", "SENTINEL-1"]);
  });

  it("taille de page par defaut : 50 au CDSE, 20 chez Earth Search (items non allegeables)", async () => {
    const a = fetchScenario(reponseJson(syn.page([])));
    await creerAdaptateurCdseStac({ fetch: a.fetch }).rechercher({ bbox: BOKE, ...FENETRE });
    const b = fetchScenario(reponseJson(syn.page([])));
    await creerAdaptateurEarthSearch({ fetch: b.fetch }).rechercher({ bbox: BOKE, ...FENETRE });
    expect(a.appels[0].corps.limit).toBe(50);
    expect(b.appels[0].corps.limit).toBe(20);
  });
});

describe("pagination bornee (pages fabriquees : synthetique)", () => {
  const base = syn.itemCdseReel();
  const item = (i: number, nuages = 10) => syn.variante(base, `P${i}`, `2026-10-${String(20 + (i % 5)).padStart(2, "0")}T11:00:00.000Z`, nuages);
  const suivant = (n: number) => ({ href: "https://stac.dataspace.copernicus.eu/v1/search", body: { token: `page-${n}` } });
  const params: ParamsRecherche = { bbox: BOKE, ...FENETRE, collections: ["sentinel-2-l2a"], limiteParPage: 2 };

  it("plafond de pages : s'arrete, rend le curseur de reprise et le dit", async () => {
    const pages = Array.from({ length: 10 }, (_, i) => reponseJson(syn.page([item(2 * i), item(2 * i + 1)], suivant(i + 1))));
    const { fetch, appels } = fetchScenario(...pages);
    const r = await creerAdaptateurCdseStac({ fetch }).rechercher({ ...params, pagesMax: 3 });
    expect(appels).toHaveLength(3);
    expect(r.produits).toHaveLength(6);
    expect(r.pagination.raisonArret).toBe("PLAFOND_PAGES");
    expect(r.pagination.suivant).toMatchObject({ collection: "sentinel-2-l2a", methode: "POST", decalage: 6, corps: { token: "page-3" } });
    expect(r.diagnostics.find((d) => d.code === "PLAFOND_PAGES")).toMatchObject({ niveau: "INFO", nombre: 1 });
  });

  it("reprise d'une recherche interrompue : repart du curseur, sans refaire la premiere requete", async () => {
    const pages = Array.from({ length: 4 }, (_, i) => reponseJson(syn.page([item(2 * i), item(2 * i + 1)], i < 3 ? suivant(i + 1) : undefined)));
    const a = fetchScenario(...pages);
    const r1 = await creerAdaptateurCdseStac({ fetch: a.fetch }).rechercher({ ...params, pagesMax: 1 });
    const b = fetchScenario(pages[1], pages[2], pages[3]);
    const r2 = await creerAdaptateurCdseStac({ fetch: b.fetch }).rechercher({ ...params, pagesMax: 5, reprendre: r1.pagination.suivant! });
    expect(b.appels[0].corps).toEqual({ token: "page-1" });
    expect(r2.produits.map((p) => p.identifiantFournisseur)).toEqual(["P2", "P3", "P4", "P5", "P6", "P7"]);
    expect(r2.pagination.raisonArret).toBe("FIN");
    expect(r2.pagination.suivant).toBeNull();
  });

  it("plafond de produits : tenu au produit pres, y compris en milieu de page (avant EO-FIX-BACK 4 : 4 produits pour un plafond de 3)", async () => {
    const pages = Array.from({ length: 5 }, (_, i) => reponseJson(syn.page([item(2 * i), item(2 * i + 1)], suivant(i + 1))));
    const { fetch, appels } = fetchScenario(...pages);
    const r = await creerAdaptateurCdseStac({ fetch }).rechercher({ ...params, pagesMax: 10, produitsMax: 3 });
    expect(appels).toHaveLength(2);
    expect(r.produits).toHaveLength(3);
    expect(r.pagination.raisonArret).toBe("PLAFOND_PRODUITS");
  });

  it("garde du STAC : (page - 1) x limite <= 10 000. A 10 000 on demande, a 10 001 non", async () => {
    const curseur = (decalage: number) => ({ collection: "sentinel-2-l2a", methode: "POST" as const, url: "https://stac.dataspace.copernicus.eu/v1/search", corps: { token: "x" }, decalage });
    expect(PLAFOND_DECALAGE_STAC).toBe(10_000);
    const ok = fetchScenario(reponseJson(syn.page([item(1)])));
    const r1 = await creerAdaptateurCdseStac({ fetch: ok.fetch }).rechercher({ ...params, reprendre: curseur(10_000) });
    expect(ok.appels).toHaveLength(1);
    expect(r1.produits).toHaveLength(1);
    const ko = fetchScenario(reponseJson(syn.page([item(1)])));
    const r2 = await creerAdaptateurCdseStac({ fetch: ko.fetch }).rechercher({ ...params, reprendre: curseur(10_001) });
    expect(ko.appels).toHaveLength(0);
    expect(r2.pagination.raisonArret).toBe("PLAFOND_DECALAGE");
    expect(r2.pagination.suivant).not.toBeNull();
    expect(r2.diagnostics[0].code).toBe("PLAFOND_DECALAGE");
  });

  it("fin naturelle : pas de lien suivant, une seule requete", async () => {
    const { fetch, appels } = fetchScenario(reponseJson(syn.page([item(1), item(2)])));
    const r = await creerAdaptateurCdseStac({ fetch }).rechercher({ ...params, pagesMax: 5 });
    expect(appels).toHaveLength(1);
    expect(r.pagination.raisonArret).toBe("FIN");
    expect(r.pagination.suivant).toBeNull();
  });

  it("une page vide qui annonce encore une suite ne boucle pas", async () => {
    const { fetch, appels } = fetchScenario(reponseJson(syn.page([], suivant(1))));
    const r = await creerAdaptateurCdseStac({ fetch }).rechercher({ ...params, pagesMax: 50 });
    expect(appels).toHaveLength(1);
    expect(r.produits).toEqual([]);
  });

  it("un lien « next » vers un autre hote est refuse : rien n'y est envoye", async () => {
    const { fetch, appels } = fetchScenario(reponseJson(syn.page([item(1)], { href: "https://pirate.example.test/v1/search", body: { token: "x" } })), reponseJson(syn.page([item(2)])));
    const r = await creerAdaptateurCdseStac({ fetch }).rechercher({ ...params, pagesMax: 5 });
    expect(appels).toHaveLength(1);
    expect(r.diagnostics.find((d) => d.code === "LIEN_SUIVANT_REFUSE")).toMatchObject({ niveau: "ERREUR" });
  });

  it("un lien « next » en GET est suivi tel quel ; avec merge, le corps courant est complete", async () => {
    const g = fetchScenario(
      reponseJson(syn.page([item(1)], { href: "https://stac.dataspace.copernicus.eu/v1/search?token=abc", methode: "GET" })),
      reponseJson(syn.page([item(2)])),
    );
    await creerAdaptateurCdseStac({ fetch: g.fetch }).rechercher({ ...params, pagesMax: 5 });
    expect(g.appels[1]).toMatchObject({ methode: "GET", url: "https://stac.dataspace.copernicus.eu/v1/search?token=abc", corps: null });
    const m = fetchScenario(
      reponseJson(syn.page([item(1)], { href: "https://stac.dataspace.copernicus.eu/v1/search", body: { token: "t2" }, merge: true })),
      reponseJson(syn.page([item(2)])),
    );
    await creerAdaptateurCdseStac({ fetch: m.fetch }).rechercher({ ...params, pagesMax: 5 });
    expect(m.appels[1].corps).toMatchObject({ token: "t2", limit: 2, collections: ["sentinel-2-l2a"], bbox: BOKE });
  });

  it("un meme produit rendu sur deux pages n'est garde qu'une fois", async () => {
    const { fetch } = fetchScenario(reponseJson(syn.page([item(1), item(2)], suivant(1))), reponseJson(syn.page([item(2), item(3)])));
    const r = await creerAdaptateurCdseStac({ fetch }).rechercher({ ...params, pagesMax: 5 });
    expect(r.produits.map((p) => p.identifiantFournisseur)).toEqual(["P1", "P2", "P3"]);
    expect(r.diagnostics.find((d) => d.code === "DOUBLON_PAGINATION")).toMatchObject({ nombre: 1, exemples: ["P2"] });
  });

  it("le total annonce (numberMatched ou context.matched) est rendu ; il s'additionne entre collections", async () => {
    const a = fetchScenario(reponseJson(syn.page([item(1)], undefined, { numberMatched: 29 })));
    expect((await creerAdaptateurEarthSearch({ fetch: a.fetch }).rechercher(params)).pagination.totalAnnonce).toBe(29);
    const b = fetchScenario(reponseJson(syn.page([item(1)], undefined, { context: { matched: 8 } })), reponseJson(syn.page([item(2)], undefined, { numberMatched: 4 })));
    const r = await creerAdaptateurEarthSearch({ fetch: b.fetch }).rechercher({ ...params, collections: ["sentinel-2-l2a", "sentinel-1-grd"] });
    expect(r.pagination.totalAnnonce).toBe(12);
  });
});

describe("diagnostics (items fabriques : synthetique)", () => {
  const params: ParamsRecherche = { bbox: BOKE, ...FENETRE, collections: ["sentinel-2-l2a"], nuagesMax: 50, pagesMax: 1 };
  const base = syn.itemCdseReel();

  it("produits invalides ecartes, regroupes par cause, exemples bornes ; produits valides conserves", async () => {
    const mauvais = [1, 2, 3, 4].map((i) => ({ ...syn.empriseNonFermee(), id: `MAUVAIS-${i}` }));
    const { fetch } = fetchScenario(reponseJson(syn.page([base, ...mauvais, { ...syn.dateIllisible(), id: "DATE-X" }])));
    const r = await creerAdaptateurCdseStac({ fetch }).rechercher(params);
    expect(r.produits).toHaveLength(1);
    expect(r.pagination.produitsLus).toBe(6);
    const e = r.diagnostics.find((d) => d.code === "PRODUIT_ECARTE_EMPRISE_INVALIDE")!;
    expect(e).toMatchObject({ niveau: "AVERTISSEMENT", nombre: 4 });
    expect(e.exemples).toHaveLength(3);
    expect(r.diagnostics.find((d) => d.code === "PRODUIT_ECARTE_DATE_INVALIDE")?.nombre).toBe(1);
  });

  it("optique sans nuages : garde avec null et signale ; zero annonce : garde a 0", async () => {
    const { fetch } = fetchScenario(reponseJson(syn.page([{ ...syn.sansNuages(), id: "SANS" }, { ...syn.zeroNuagesAnnonce(), id: "ZERO" }])));
    const r = await creerAdaptateurCdseStac({ fetch }).rechercher(params);
    expect(r.produits.map((p) => [p.identifiantFournisseur, p.couvertureNuagesPct])).toEqual([["SANS", null], ["ZERO", 0]]);
    expect(r.diagnostics.find((d) => d.code === "NUAGES_ABSENTS")).toMatchObject({ niveau: "AVERTISSEMENT", exemples: ["SANS"] });
  });

  it("le serveur ne filtre pas toujours : un produit au-dessus du seuil est ecarte cote client", async () => {
    const { fetch } = fetchScenario(reponseJson(syn.page([{ ...syn.nuagesHorsBornes(80), id: "NUAGEUX" }, { ...syn.zeroNuagesAnnonce(), id: "CLAIR" }])));
    const r = await creerAdaptateurCdseStac({ fetch }).rechercher(params);
    expect(r.produits.map((p) => p.identifiantFournisseur)).toEqual(["CLAIR"]);
    expect(r.diagnostics.find((d) => d.code === "NUAGES_AU_DESSUS_SEUIL")).toBeDefined();
  });

  it("reponse sans `features` : erreur d'indisponibilite, pas une liste vide", async () => {
    const { fetch } = fetchScenario(reponseJson({ code: "InternalError" }));
    await expect(creerAdaptateurCdseStac({ fetch }).rechercher(params)).rejects.toMatchObject({ code: "REPONSE_ILLISIBLE", categorie: "INDISPONIBLE" });
  });

  it("un 429 persistant remonte en QUOTA ; les requetes sont comptees dans quotas()", async () => {
    const { fetch } = fetchScenario(reponseJson({ code: "RATE_LIMIT_EXCEEDED" }, 429, { "retry-after": "1" }));
    const a = creerAdaptateurCdseStac({ fetch, sleep: sommeil() });
    await expect(a.rechercher(params)).rejects.toMatchObject({ categorie: "QUOTA" });
    expect(a.classerErreur(await a.rechercher(params).catch((e) => e))).toBe("QUOTA");
    const q = a.quotas();
    expect(q.compteurs.reponses429).toBe(8);
    expect(q.compteurs.requetesEnvoyees).toBe(8);
    expect(q.compteurs.appelsLogiques).toBe(2);
  });
});

describe("validation des parametres : rien n'est envoye si l'entree est mauvaise", () => {
  const valide: ParamsRecherche = { bbox: BOKE, ...FENETRE };
  it.each([
    ["bbox inversee", { bbox: [-14.19, 10.83, -14.39, 11.03] }],
    ["bbox a 3 valeurs", { bbox: [1, 2, 3] }],
    ["bbox hors globe", { bbox: [-200, 0, 1, 2] }],
    ["date illisible", { debut: "hier" }],
    ["fin avant debut", { debut: "2026-10-25T00:00:00Z", fin: "2026-10-01T00:00:00Z" }],
    ["nuagesMax > 100", { nuagesMax: 101 }],
    ["nuagesMax < 0", { nuagesMax: -1 }],
    ["collection inconnue", { collections: ["sentinel-3-olci"] }],
    ["aucune collection", { collections: [] }],
    ["limite 0", { limiteParPage: 0 }],
    ["limite 101", { limiteParPage: 101 }],
    ["limite decimale", { limiteParPage: 2.5 }],
    ["pagesMax 0", { pagesMax: 0 }],
  ])("%s", async (_nom, extra) => {
    const { fetch, appels } = fetchScenario(reponseJson(syn.page([])));
    await expect(creerAdaptateurCdseStac({ fetch }).rechercher({ ...valide, ...extra } as ParamsRecherche)).rejects.toMatchObject({ code: "ENTREE_INVALIDE", categorie: "ENTREE" });
    expect(appels).toHaveLength(0);
  });
  it("des dates au format Date sont acceptees", async () => {
    const { fetch, appels } = fetchScenario(reponseJson(syn.page([])));
    await creerAdaptateurCdseStac({ fetch }).rechercher({ bbox: BOKE, debut: new Date("2026-09-01T00:00:00Z"), fin: new Date("2026-10-25T23:59:59Z") });
    expect(appels[0].corps.datetime).toBe("2026-09-01T00:00:00Z/2026-10-25T23:59:59Z");
  });
});

describe("metadonnees(id)", () => {
  it("CDSE : GET de l'item dans la collection deduite de l'identifiant", async () => {
    const f = charger("cdse-stac-s2-l2a-item-complet.json");
    const { fetch, appels } = fetchScenario(reponseJson(f.reponse.features[0]));
    const p = await creerAdaptateurCdseStac({ fetch }).metadonnees(f.reponse.features[0].id);
    expect(appels[0]).toMatchObject({ methode: "GET", url: `https://stac.dataspace.copernicus.eu/v1/collections/sentinel-2-l2a/items/${f.reponse.features[0].id}` });
    expect(p).toMatchObject({ niveauTraitement: "L2A", tuileMgrs: "28PET" });
  });
  it("Earth Search : identifiant propre au catalogue", async () => {
    const f = charger("earth-search-s2-l2a.json");
    const { fetch, appels } = fetchScenario(reponseJson(f.reponse.features[0]));
    const p = await creerAdaptateurEarthSearch({ fetch }).metadonnees("S2C_28PES_20261025_0_L2A");
    expect(appels[0].url).toBe("https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/S2C_28PES_20261025_0_L2A");
    expect(p?.identifiantFournisseur).toBe("S2C_28PES_20261025_0_L2A");
  });
  it("404 : null (le fournisseur ne connait pas l'identifiant), sans nouvelle tentative", async () => {
    const { fetch, appels } = fetchScenario(reponseJson({ code: "NotFoundError" }, 404));
    expect(await creerAdaptateurEarthSearch({ fetch }).metadonnees("S2C_28PES_20200101_0_L2A")).toBeNull();
    expect(appels).toHaveLength(1);
  });
  it("collection non deductible sans l'option : erreur d'entree, rien d'envoye ; avec l'option : ca marche", async () => {
    const f = charger("cdse-stac-s1-grd.json");
    const { fetch, appels } = fetchScenario(reponseJson(f.reponse.features[0]));
    const a = creerAdaptateurCdseStac({ fetch });
    await expect(a.metadonnees("X-INCONNU")).rejects.toMatchObject({ code: "ENTREE_INVALIDE" });
    expect(appels).toHaveLength(0);
    expect(await a.metadonnees("X-INCONNU", { collection: "sentinel-1-grd" })).not.toBeNull();
  });
  it("identifiant vide ou trop long, collection inconnue : erreur d'entree", async () => {
    const a = creerAdaptateurCdseStac({ fetch: fetchScenario(reponseJson({})).fetch });
    for (const id of ["", "  ", "x".repeat(300)]) await expect(a.metadonnees(id)).rejects.toMatchObject({ code: "ENTREE_INVALIDE" });
    await expect(a.metadonnees("abc", { collection: "sentinel-3" })).rejects.toMatchObject({ code: "ENTREE_INVALIDE" });
  });
  it("un item recu mais inexploitable est une erreur, pas un produit approximatif", async () => {
    const { fetch } = fetchScenario(reponseJson(syn.empriseAbsente()));
    await expect(creerAdaptateurCdseStac({ fetch }).metadonnees("S2C_MSIL2A_X")).rejects.toMatchObject({ code: "REPONSE_ILLISIBLE" });
  });
  it("deduireCollection", () => {
    expect(deduireCollection("S2C_MSIL2A_20261025T112141_N0513_R037_T28PET_20261025T142809")).toBe("sentinel-2-l2a");
    expect(deduireCollection("S2C_MSIL1C_20261025T112141_N0513_R037_T28PET_20261025T131709")).toBe("sentinel-2-l1c");
    expect(deduireCollection("S2C_28PES_20261025_0_L2A")).toBe("sentinel-2-l2a");
    expect(deduireCollection("S1D_IW_GRDH_1SDV_20261025T190808_20261025T190833_005176_009D21")).toBe("sentinel-1-grd");
    expect(deduireCollection("LC09_L2SP_203053_20261015_02_T1")).toBe("landsat-c2-l2");
    expect(deduireCollection("n'importe quoi")).toBeNull();
  });
});

describe("urlApercu : une description d'acces cote serveur, jamais une cle", () => {
  const produits = (nom: string, qui: "cdse" | "es", collection: string) => {
    const f = charger(nom);
    const a = qui === "cdse" ? creerAdaptateurCdseStac({ fetch: fetchScenario(reponseJson(f.reponse)).fetch }) : creerAdaptateurEarthSearch({ fetch: fetchScenario(reponseJson(f.reponse)).fetch });
    return a.rechercher({ bbox: BOKE, ...FENETRE, collections: [collection], pagesMax: 1 }).then((r) => ({ a, p: r.produits[0] }));
  };

  it("Earth Search Sentinel-2 : vignette HTTPS anonyme, verifiee", async () => {
    const { a, p } = await produits("earth-search-s2-l2a.json", "es", "sentinel-2-l2a");
    expect(a.urlApercu(p)).toMatchObject({ executionCote: "SERVEUR", disponible: true, verifie: true, methode: "GET", authentification: "ANONYME", typeContenu: "image/jpeg" });
    expect(a.urlApercu(p).url).toMatch(/^https:\/\/sentinel-cogs\.s3\.us-west-2\.amazonaws\.com\/.+preview\.jpg$/);
  });
  it("CDSE : vignette a tenter cote serveur, acces NON verifie, reponse d'echec prevue", async () => {
    const { a, p } = await produits("cdse-stac-s2-l2a.json", "cdse", "sentinel-2-l2a");
    const d = a.urlApercu(p);
    expect(d).toMatchObject({ executionCote: "SERVEUR", disponible: true, verifie: false, authentification: "INCONNU" });
    expect(d.raison).toMatch(/APERCU_INDISPONIBLE/);
  });
  it("vignette s3:// (Earth Search radar) : indisponible, identifiants cloud requis", async () => {
    const { a, p } = await produits("earth-search-s1-grd.json", "es", "sentinel-1-grd");
    expect(a.urlApercu(p)).toMatchObject({ disponible: false, url: null, methode: null, authentification: "IDENTIFIANTS_CLOUD" });
    expect(a.urlApercu(p).raison).toMatch(/ACCES_NON_HTTP/);
  });
  it("vignette qui exige un jeton : indisponible, IDENTIFIANTS_REQUIS", async () => {
    const { a, p } = await produits("cdse-stac-s1-grd.json", "cdse", "sentinel-1-grd");
    const avecJeton: ProduitNormalise = { ...p, liens: { ...p.liens, vignette: { ...p.liens.vignette!, acces: "JETON_OIDC" } } };
    expect(a.urlApercu(avecJeton)).toMatchObject({ disponible: false, authentification: "JETON_OIDC" });
    expect(a.urlApercu(avecJeton).raison).toMatch(/IDENTIFIANTS_REQUIS/);
  });
  it("pas de vignette : on le dit, sans image de remplacement", async () => {
    const { a, p } = await produits("earth-search-s2-l2a.json", "es", "sentinel-2-l2a");
    const sans: ProduitNormalise = { ...p, liens: { vignette: null, actifs: p.liens.actifs } };
    expect(a.urlApercu(sans)).toMatchObject({ disponible: false, url: null, typeContenu: null });
    expect(a.urlApercu(sans).raison).toMatch(/^VIGNETTE_ABSENTE/);
  });
});

describe("facades PlanetScope et SPOT : rien n'est contacte", () => {
  const facades = (): SourceAdaptateur[] => [creerFacadePlanetScope(), creerFacadeSpot()];
  const produitBidon = {} as ProduitNormalise;

  it("verifierConnectivite : EN_ATTENTE_CONFIGURATION et le message prevu, sans requete", async () => {
    for (const f of facades()) {
      const r = await f.verifierConnectivite();
      expect(r).toMatchObject({ etatAtteint: "EN_ATTENTE_CONFIGURATION", message: "interface prevue, aucune commande sans autorisation humaine", latenceMs: 0, requete: null });
    }
    expect(MESSAGE_FACADE).toBe("interface prevue, aucune commande sans autorisation humaine");
  });
  it("rechercher et metadonnees sont refuses (NON_SUPPORTE), aucun appel reseau", async () => {
    const reseau = fetchScenario(reponseJson({}));
    const original = globalThis.fetch;
    globalThis.fetch = ((...a: unknown[]) => { void a; throw new Error("reseau interdit pour une facade"); }) as typeof fetch;
    try {
      for (const f of facades()) {
        await expect(f.rechercher({ bbox: BOKE, ...FENETRE })).rejects.toMatchObject({ code: "NON_SUPPORTE", categorie: "NON_SUPPORTE" });
        await expect(f.metadonnees("x")).rejects.toMatchObject({ code: "NON_SUPPORTE" });
        await expect(f.declencherTraitement()).rejects.toMatchObject({ code: "NON_SUPPORTE" });
        expect(f.urlApercu(produitBidon)).toMatchObject({ disponible: false, url: null });
        expect(f.quotas().compteurs.requetesEnvoyees).toBe(0);
        expect(f.quotas().limites).toEqual([]);
      }
    } finally { globalThis.fetch = original; }
    expect(reseau.appels).toHaveLength(0);
  });
  it("le descriptif n'affirme ni resolution ni tarif ni licence precise, et ne cree aucun abonnement", () => {
    for (const f of facades()) {
      expect(f.descriptif).toMatchObject({ interface: "FACADE", urlService: null, collections: [], resolutionsNatives: {} });
      expect(f.descriptif.exigencesAcces).toMatchObject({ recherche: "NON_DISPONIBLE", traitement: "NON_DISPONIBLE", variablesEnvironnement: [] });
    }
  });
});

describe("traitement : non implemente dans ce lot, sans simulation", () => {
  it.each(["cdse", "es"] as const)("%s : declencher, suivre, recuperer rendent NON_SUPPORTE", async (qui) => {
    const { fetch, appels } = fetchScenario(reponseJson({}));
    const a = qui === "cdse" ? creerAdaptateurCdseStac({ fetch }) : creerAdaptateurEarthSearch({ fetch });
    for (const op of [() => a.declencherTraitement({ x: 1 }), () => a.statutTraitement("id"), () => a.recupererResultat("id")]) {
      const e = await op().catch((x) => x as ErreurSource);
      expect(e).toBeInstanceOf(ErreurSource);
      expect(e).toMatchObject({ code: "NON_SUPPORTE", categorie: "NON_SUPPORTE", source: a.code });
      expect(a.classerErreur(e)).toBe("NON_SUPPORTE");
    }
    expect(appels).toHaveLength(0);
  });
});

describe("assemblage", () => {
  it("creerAdaptateurs rend les quatre sources avec leur interface", () => {
    const tous = creerAdaptateurs({ fetch: fetchScenario(reponseJson({})).fetch });
    expect(Object.keys(tous).sort()).toEqual(["cdse-stac", "earth-search", "planetscope", "spot"]);
    expect(tous["cdse-stac"].descriptif.interface).toBe("INTERFACE_ACTIVE");
    expect(tous.planetscope.descriptif.interface).toBe("FACADE");
    for (const [code, a] of Object.entries(tous)) expect(a.code).toBe(code);
  });

  it("les descriptifs : exigences d'acces et noms de variables seulement (aucune valeur)", () => {
    const tous = creerAdaptateurs();
    expect(tous["cdse-stac"].descriptif.exigencesAcces).toMatchObject({ recherche: "ANONYME", telechargement: "COMPTE", traitement: "COMPTE" });
    expect(tous["earth-search"].descriptif.exigencesAcces.recherche).toBe("ANONYME");
    for (const a of Object.values(tous)) for (const v of a.descriptif.exigencesAcces.variablesEnvironnement) expect(v).toMatch(/^[A-Z][A-Z0-9_]+$/);
    expect(tous["cdse-stac"].descriptif.resolutionsNatives["SENTINEL-2"]).toMatchObject({ B02: 10, B05: 20, B01: 60 });
    expect(tous["cdse-stac"].descriptif.licence.attribution).toBe("Contains modified Copernicus Sentinel data [annee]");
  });

  it("quotas() : limites citees avec leur source ; une limite non chiffree reste null", () => {
    const cdse = creerAdaptateurCdseStac().quotas();
    expect(cdse.limites.length).toBeGreaterThan(5);
    for (const l of cdse.limites) {
      expect(l.source.url).toMatch(/^https:\/\//);
      expect(l.source.consulteLe).toBe("2026-10-25");
    }
    expect(cdse.limites.find((l) => l.cle === "stac_requetes_par_minute")).toMatchObject({ valeur: null, concerneRecherche: true });
    expect(cdse.limites.find((l) => l.cle === "s3_requetes_par_minute")).toMatchObject({ valeur: 2000, concerneRecherche: false });
    expect(cdse.limites.find((l) => l.cle === "sentinelhub_requetes_par_mois")?.valeur).toBe(10_000);
    expect(creerAdaptateurEarthSearch().quotas().limites[0].valeur).toBeNull();
    expect(cdse.compteurs.requetesEnvoyees).toBe(0);
  });

  it("urlBase : https exigee (http seulement en local), barre finale retiree, et utilisee", async () => {
    expect(urlBaseValide("https://exemple.test/v1/")).toBe("https://exemple.test/v1");
    expect(urlBaseValide("http://localhost:8080/v1")).toBe("http://localhost:8080/v1");
    expect(() => urlBaseValide("http://exemple.test/v1")).toThrow(/https/);
    expect(() => urlBaseValide("n'importe quoi")).toThrow(/illisible/);
    const { fetch, appels } = fetchScenario(reponseJson(syn.page([])));
    await creerAdaptateurCdseStac({ fetch, urlBase: "https://miroir.test/stac/" }).rechercher({ bbox: BOKE, ...FENETRE });
    expect(appels[0].url).toBe("https://miroir.test/stac/search");
  });
});
