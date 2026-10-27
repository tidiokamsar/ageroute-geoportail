import { describe, expect, it } from "vitest";
import { PONDERATIONS_SELECTION, choisirSource, fractionSaisonDesPluies, type CandidatSource, type ParamsSelection } from "./selection";
import { normaliserItemStac } from "./normalisation";
import type { BBox, ProduitNormalise } from "./contrat";
import { charger } from "./essais.support";
import * as syn from "./__fixtures__/synthetiques";

/**
 * La selection est PURE : les produits viennent de VRAIES reponses de catalogue (fixtures du
 * 25/10/2026, normalisees par le vrai code) ; seuls les cas qu'aucune reponse reelle n'a produits
 * (un mois de pluie, des erreurs d'API, un quota) sont fabriques et marques synthetique.
 */

type Four = "CDSE" | "EARTH_SEARCH";
function lire(fichier: string, source: "cdse-stac" | "earth-search", fournisseur: Four, collection: string): ProduitNormalise[] {
  const f = charger(fichier);
  const items = [...f.reponse.features, ...(f.suite ? f.suite.reponse.features : [])];
  return items.map((it: unknown) => {
    const r = normaliserItemStac(it, { source, fournisseur, collection });
    if (!r.ok) throw new Error(r.code);
    return r.produit;
  });
}
const cdseS2 = lire("cdse-stac-s2-l2a.json", "cdse-stac", "CDSE", "sentinel-2-l2a"); // PET 25/10, PES 25/10, PET 22/10, PES 22/10
const esS2 = lire("earth-search-s2-l2a.json", "earth-search", "EARTH_SEARCH", "sentinel-2-l2a"); // les memes quatre prises de vue
const cdseS1 = lire("cdse-stac-s1-grd.json", "cdse-stac", "CDSE", "sentinel-1-grd");
const esS1 = lire("earth-search-s1-grd.json", "earth-search", "EARTH_SEARCH", "sentinel-1-grd");
const esLandsat = lire("earth-search-landsat-c2-l2.json", "earth-search", "EARTH_SEARCH", "landsat-c2-l2");

const BOKE: BBox = [-14.39, 10.83, -14.19, 11.03];
const FENETRE = { debut: "2026-10-20T00:00:00Z", fin: "2026-10-25T23:59:59Z" };
const cdse = (produits: ProduitNormalise[] | undefined, extra: Partial<CandidatSource> = {}): CandidatSource => ({ code: "cdse-stac", etat: "PRODUIT_DISPONIBLE", quota: "OK", priorite: 1, produits, ...extra });
const es = (produits: ProduitNormalise[] | undefined, extra: Partial<CandidatSource> = {}): CandidatSource => ({ code: "earth-search", etat: "ACCESSIBLE", priorite: 2, produits, ...extra });

function base(extra: Partial<ParamsSelection> = {}): ParamsSelection {
  return { zone: { bbox: BOKE }, dates: FENETRE, phenomene: "VEGETATION", nuagesMax: 50, sourcesDisponibles: [cdse(cdseS2), es(esS2)], ...extra };
}

/** Produit fabrique a partir d'un item reel (date, nuages) : synthetique. */
function produitVariante(item: any, id: string, datetime: string, nuages: number | undefined, source: "cdse-stac" | "earth-search", fournisseur: Four, collection: string): ProduitNormalise {
  const it = syn.variante(item, id, datetime, nuages);
  const r = normaliserItemStac(it, { source, fournisseur, collection });
  if (!r.ok) throw new Error(r.code);
  return r.produit;
}

describe("classement sur des produits reels des deux catalogues", () => {
  const r = choisirSource(base());

  it("retient la tuile qui couvre toute la zone, et dit pourquoi, critere par critere", () => {
    expect(r.retenue?.produit.identifiantFournisseur).toBe("S2C_MSIL2A_20261025T112141_N0513_R037_T28PET_20261025T142809");
    expect(r.retenue?.rang).toBe(1);
    expect(r.retenue?.couvertureZonePct).toBe(100);
    expect(r.retenue?.raisons.map((x) => x.critere)).toEqual(["couverture", "nuages", "resolution", "fraicheur", "etat_source", "quota", "cache"]);
    const pts = Object.fromEntries(r.retenue!.raisons.map((x) => [x.critere, x.points]));
    expect(pts).toMatchObject({ couverture: 40, resolution: 15, etat_source: 3, quota: 2, cache: 0 });
    expect(pts.nuages).toBeCloseTo(7.18, 2); // 25 x (1 - 35,65 / 50)
    expect(r.retenue!.raisons.reduce((t, x) => t + x.points, 0)).toBeCloseTo(r.retenue!.score, 1);
    expect(r.retenue!.score).toBeLessThanOrEqual(100);
    expect(Object.values(PONDERATIONS_SELECTION).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("la raison « nuages » rappelle que la mesure est celle de la tuile entiere", () => {
    const n = r.retenue!.raisons.find((x) => x.critere === "nuages")!;
    expect(n.valeur).toBe("35.65 % (tuile)");
    expect(n.explication).toMatch(/TUILE ENTIERE/);
  });

  it("classe deux scenes de la zone ; les deux autres ne la couvrent que partiellement et sont ecartees avec leur part", () => {
    expect(r.classement.map((c) => c.rang)).toEqual([1, 2]);
    expect(r.classement[1].produit.dateAcquisition.slice(0, 10)).toBe("2026-10-22");
    expect(r.classement[1].couvertureZonePct).toBeGreaterThan(50);
    const partielles = r.ecartes.filter((e) => e.cause === "COUVERTURE_PARTIELLE");
    expect(partielles).toHaveLength(4);
    expect(partielles[0].detail).toMatch(/ne couvre que \d+(\.\d+)? % de la zone \(minimum 50 %\)/);
  });

  it("deduplication entre catalogues : les memes prises de vue chez Earth Search sont citees, pas comptees deux fois", () => {
    expect(r.ecartes.filter((e) => e.cause === "DOUBLON").map((e) => e.identifiantFournisseur).sort()).toEqual(["S2C_28PET_20261022_0_L2A", "S2C_28PET_20261025_0_L2A"]);
    expect(r.retenue!.aussiChez).toEqual([{ source: "earth-search", identifiantFournisseur: "S2C_28PET_20261025_0_L2A" }]);
    expect(r.classement).toHaveLength(2);
  });

  it("la source prioritaire garde la representation : inverser les priorites inverse le representant, pas le choix de scene", () => {
    const inv = choisirSource(base({ sourcesDisponibles: [cdse(cdseS2, { priorite: 2 }), es(esS2, { priorite: 1 })] }));
    expect(inv.retenue!.produit.source).toBe("earth-search");
    expect(inv.retenue!.produit.cleScene).toBe(r.retenue!.produit.cleScene);
    expect(inv.retenue!.aussiChez[0].source).toBe("cdse-stac");
  });

  it("le cache (produit deja au registre, ou source deja synchronisee) ajoute ses points et le dit", () => {
    const c = choisirSource(base({ dejaConnus: ["S2C_MSIL2A_20261022T111111_N0513_R137_T28PET_20261022T144304"] }));
    const rang2 = c.classement.find((x) => x.produit.dateAcquisition.startsWith("2026-10-22"))!;
    expect(rang2.raisons.find((x) => x.critere === "cache")).toMatchObject({ points: 5, valeur: "oui" });
    expect(rang2.score).toBeCloseTo(62.79 + 5, 1);
    const s = choisirSource(base({ sourcesDisponibles: [cdse(cdseS2, { enCache: true }), es(esS2)] }));
    expect(s.retenue!.raisons.find((x) => x.critere === "cache")?.points).toBe(5);
  });

  it("etat de la source et quota entrent dans le score", () => {
    const proche = choisirSource(base({ sourcesDisponibles: [cdse(cdseS2, { quota: "PROCHE", etat: "ACCESSIBLE" })] }));
    const pts = Object.fromEntries(proche.retenue!.raisons.map((x) => [x.critere, x.points]));
    expect(pts.etat_source).toBe(1.5);
    expect(pts.quota).toBe(0.5);
  });

  it("des ponderations differentes changent le classement et sont rendues dans les metadonnees", () => {
    const f = choisirSource(base({ ponderations: { couverture: 0, nuages: 100, fraicheur: 0 } }));
    expect(f.retenue!.produit.dateAcquisition.startsWith("2026-10-22")).toBe(true); // 17 % de nuages bat 36 %
    expect((f.metadonnees.parametres as any).ponderations.nuages).toBe(100);
  });
});

describe("le seuil de nuages", () => {
  it("30 % : la scene du 25/10 (35,65 %) est ecartee, celle du 22/10 (17,09 %) est retenue", () => {
    const r = choisirSource(base({ nuagesMax: 30 }));
    expect(r.retenue!.produit.dateAcquisition.startsWith("2026-10-22")).toBe(true);
    expect(r.ecartes.some((e) => e.cause === "NUAGES_AU_DESSUS_SEUIL" && /35\.65 %/.test(e.detail))).toBe(true);
  });

  it("10 % pour la vegetation : aucune source satisfaisante, cause NUAGES chiffree, et PAS d'alternative radar", () => {
    const r = choisirSource(base({ nuagesMax: 10, sourcesDisponibles: [cdse([...cdseS2, ...cdseS1]), es([...esS2, ...esS1])] }));
    expect(r.retenue).toBeNull();
    expect(r.aucune?.cause).toBe("NUAGES");
    expect(r.aucune?.details[0]).toMatch(/meilleure couverture de tuile observee 17\.09 % > seuil 10 %/);
    expect(r.alternative).toBeNull();
    expect(r.raisons.join(" ")).toMatch(/pas d'alternative radar pour VEGETATION/);
    expect(r.ecartes.some((e) => e.cause === "NATURE_NON_ADAPTEE")).toBe(true);
  });

  it("un produit sans couverture nuageuse ne peut pas etre compare au seuil : ecarte, cause QUALITE", () => {
    const sans = normaliserItemStac(syn.sansNuages(), { source: "cdse-stac", fournisseur: "CDSE", collection: "sentinel-2-l2a" });
    if (!sans.ok) throw new Error("fixture");
    const r = choisirSource(base({ dates: { debut: "2026-10-20T00:00:00Z", fin: "2026-10-26T00:00:00Z" }, sourcesDisponibles: [cdse([sans.produit])] }));
    expect(r.aucune?.cause).toBe("QUALITE");
    expect(r.ecartes[0].cause).toBe("NUAGES_INCONNUS");
    expect(r.aucune?.details[0]).toMatch(/inverifiable/);
  });
});

describe("radar : proposé, jamais substitue en silence", () => {
  const sources = (): CandidatSource[] => [cdse([...cdseS2, ...cdseS1]), es([...esS2, ...esS1])];
  const inondation = (extra: Partial<ParamsSelection> = {}) => choisirSource(base({ phenomene: "INONDATION", nuagesMax: 10, sourcesDisponibles: sources(), ...extra }));

  it("inondation sans optique clair : pas de produit retenu, radar propose et dit changement de capteur", () => {
    const r = inondation();
    expect(r.retenue).toBeNull();
    expect(r.aucune?.cause).toBe("NUAGES");
    expect(r.alternative).toMatchObject({ nature: "RADAR", proposee: true, motif: "AUCUN_OPTIQUE" });
    expect(r.alternative!.message).toMatch(/CHANGEMENT DE CAPTEUR, a confirmer/);
    expect(r.alternative!.classement[0].produit.capteur).toBe("SENTINEL-1");
    expect(r.alternative!.classement[0].changementDeCapteur).toBe(true);
    expect(r.alternative!.classement[0].raisons.find((x) => x.critere === "nuages")?.explication).toMatch(/insensible aux nuages/);
  });

  it("le radar est deduplique entre catalogues comme l'optique (meme scene Sentinel-1D chez les deux)", () => {
    const r = inondation();
    expect(r.alternative!.classement).toHaveLength(1);
    expect(r.alternative!.classement[0].aussiChez).toEqual([{ source: "earth-search", identifiantFournisseur: "S1D_IW_GRDH_1SDV_20261025T190808_20261025T190833_005176_009D21" }]);
  });

  it("l'appelant accepte l'alternative : le radar est retenu, marque changementDeCapteur, et la decision le consigne", () => {
    const r = inondation({ accepterAlternativeRadar: true });
    expect(r.retenue?.produit.nature).toBe("RADAR");
    expect(r.retenue?.changementDeCapteur).toBe(true);
    expect(r.aucune).toBeNull();
    expect(r.raisons.join(" ")).toMatch(/alternative radar acceptee par l'appelant/);
    expect((r.metadonnees.retenue as any).changementDeCapteur).toBe(true);
  });

  it.each(["EAU_SURFACE", "COUPURE_PROBABLE"] as const)("%s : meme logique (radar propose)", (phenomene) => {
    expect(inondation({ phenomene }).alternative?.proposee).toBe(true);
  });

  it("nouvelle route : le radar (20 x 22 m) n'est jamais propose, meme s'il est disponible", () => {
    const r = choisirSource(base({ phenomene: "NOUVELLE_ROUTE", nuagesMax: 10, sourcesDisponibles: sources() }));
    expect(r.alternative).toBeNull();
    expect(r.retenue).toBeNull();
    expect(r.ecartes.find((e) => e.cause === "NATURE_NON_ADAPTEE")?.detail).toMatch(/ne remplace pas l'optique pour NOUVELLE_ROUTE/);
  });

  it("l'optique clair l'emporte : pas d'alternative en saison seche", () => {
    const r = choisirSource(base({ phenomene: "INONDATION", nuagesMax: 50, sourcesDisponibles: sources() }));
    expect(r.retenue?.produit.nature).toBe("OPTIQUE");
    expect(r.alternative).toBeNull();
  });

  describe("saison des pluies (juin a septembre)", () => {
    // Prises de vue fabriquees en juillet a partir d'items reels : synthetique
    const FEN_JUILLET = { debut: "2026-07-01T00:00:00Z", fin: "2026-07-31T23:59:59Z" };
    const optiqueJuillet = produitVariante(syn.itemCdseReel(), "S2C_MSIL2A_JUILLET_SYN", "2026-07-10T11:00:00.000Z", 12, "cdse-stac", "CDSE", "sentinel-2-l2a");
    const radarJuillet = produitVariante(syn.itemCdseRadarReel(), "S1D_IW_GRDH_1SDV_JUILLET_SYN_A_B_C_D_E", "2026-07-12T19:08:08.000Z", undefined, "cdse-stac", "CDSE", "sentinel-1-grd");

    it("avec un optique disponible, le capteur reste optique ; le radar est signale comme complement", () => {
      const r = choisirSource(base({ phenomene: "EAU_SURFACE", dates: FEN_JUILLET, sourcesDisponibles: [cdse([optiqueJuillet, radarJuillet])] }));
      expect(r.retenue?.produit.nature).toBe("OPTIQUE");
      expect(r.alternative).toMatchObject({ motif: "SAISON_DES_PLUIES", proposee: true });
      expect(r.alternative!.message).toMatch(/saison des pluies/);
      expect(r.alternative!.message).toMatch(/le capteur retenu reste OPTIQUE/);
      expect((r.metadonnees.parametres as any).saisonDesPluies.fractionFenetre).toBe(1);
    });

    it("sans radar disponible, on le dit au lieu de promettre un complement", () => {
      const r = choisirSource(base({ phenomene: "EAU_SURFACE", dates: FEN_JUILLET, sourcesDisponibles: [cdse([optiqueJuillet])] }));
      expect(r.alternative).toMatchObject({ proposee: false });
      expect(r.alternative!.message).toMatch(/aucun produit radar/);
    });

    it("hors saison des pluies, aucune alternative tant que l'optique suffit", () => {
      const janvier = produitVariante(syn.itemCdseReel(), "S2C_JANVIER_SYN", "2026-01-10T11:00:00.000Z", 5, "cdse-stac", "CDSE", "sentinel-2-l2a");
      const r = choisirSource(base({ phenomene: "EAU_SURFACE", dates: { debut: "2026-01-01T00:00:00Z", fin: "2026-01-31T00:00:00Z" }, sourcesDisponibles: [cdse([janvier])] }));
      expect(r.alternative).toBeNull();
    });

    it("les mesures de disponibilite reelles de Boke sont citees dans les raisons (explicatives, jamais decisives)", () => {
      const mesures = [
        { capteur: "SENTINEL-2" as const, mois: "2026-07", seuilNuagesPct: 50, produits: 1, reference: "cdse_s2l2a_resume.json, Boke, 25/10/2026" },
        { capteur: "SENTINEL-2" as const, mois: "2026-08", seuilNuagesPct: 50, produits: 2, reference: "cdse_s2l2a_resume.json, Boke, 25/10/2026" },
        { capteur: "SENTINEL-2" as const, mois: "2026-01", seuilNuagesPct: 50, produits: 9, reference: "hors fenetre" },
      ];
      const sans = choisirSource(base({ phenomene: "EAU_SURFACE", dates: FEN_JUILLET, sourcesDisponibles: [cdse([optiqueJuillet])] }));
      const avec = choisirSource(base({ phenomene: "EAU_SURFACE", dates: FEN_JUILLET, sourcesDisponibles: [cdse([optiqueJuillet])], mesuresDispo: mesures }));
      expect(avec.raisons.join(" ")).toMatch(/mesure de disponibilite optique Sentinel-2 sur la fenetre : 1 produit\(s\) \(2026-07 : 1 a <= 50 %\)/);
      expect(avec.raisons.join(" ")).not.toMatch(/hors fenetre/);
      expect(avec.retenue?.produit.identifiantFournisseur).toBe(sans.retenue?.produit.identifiantFournisseur);
    });

    it("fractionSaisonDesPluies", () => {
      expect(fractionSaisonDesPluies(Date.parse("2026-07-01T00:00:00Z"), Date.parse("2026-07-31T00:00:00Z"))).toBe(1);
      expect(fractionSaisonDesPluies(Date.parse("2026-01-01T00:00:00Z"), Date.parse("2026-01-31T00:00:00Z"))).toBe(0);
      const mi = fractionSaisonDesPluies(Date.parse("2026-05-16T00:00:00Z"), Date.parse("2026-06-15T00:00:00Z"));
      expect(mi).toBeGreaterThan(0.4);
      expect(mi).toBeLessThan(0.6);
    });
  });
});

describe("aucune source satisfaisante : la cause exacte", () => {
  const cause = (p: ParamsSelection) => choisirSource(p).aucune;

  it("aucune source fournie, ou seulement des facades : SOURCE_NON_CONFIGUREE", () => {
    expect(cause(base({ sourcesDisponibles: [] }))?.cause).toBe("SOURCE_NON_CONFIGUREE");
    const facades: CandidatSource[] = [{ code: "planetscope", etat: "EN_ATTENTE_CONFIGURATION" }, { code: "spot", etat: "NON_CONFIGUREE" }];
    const a = cause(base({ sourcesDisponibles: facades }));
    expect(a?.cause).toBe("SOURCE_NON_CONFIGUREE");
    expect(a?.details.join(" ")).toMatch(/planetscope/);
  });

  it("source non interrogee : SOURCE_NON_INTERROGEE, pas une absence de couverture", () => {
    expect(cause(base({ sourcesDisponibles: [cdse(undefined)] }))?.cause).toBe("SOURCE_NON_INTERROGEE");
  });

  it("toutes en erreur : ERREUR_API ; l'etat EN_ERREUR sans recherche recente compte aussi", () => {
    const e = cause(base({ sourcesDisponibles: [cdse(undefined, { erreur: { categorie: "INDISPONIBLE", message: "HTTP 503" } }), es(undefined, { erreur: { categorie: "RESEAU", message: "delai" } })] }));
    expect(e?.cause).toBe("ERREUR_API");
    expect(e?.details).toHaveLength(2);
    expect(cause(base({ sourcesDisponibles: [cdse(undefined, { etat: "EN_ERREUR" })] }))?.cause).toBe("ERREUR_API");
  });

  it("quota epuise : QUOTA ; erreur et quota ensemble : ERREUR_API prime", () => {
    expect(cause(base({ sourcesDisponibles: [cdse(cdseS2, { quota: "EPUISE" })] }))?.cause).toBe("QUOTA");
    const mixte = cause(base({ sourcesDisponibles: [cdse(cdseS2, { quota: "EPUISE" }), es(undefined, { erreur: { categorie: "RESEAU", message: "x" } })] }));
    expect(mixte?.cause).toBe("ERREUR_API");
  });

  it("une source en quota epuise n'est pas utilisee : ses produits ne sont pas retenus", () => {
    const r = choisirSource(base({ sourcesDisponibles: [cdse(cdseS2, { quota: "EPUISE" }), es(esS2)] }));
    expect(r.retenue?.produit.source).toBe("earth-search");
    expect(r.raisons.join(" ")).toMatch(/source cdse-stac ecartee \(QUOTA\)/);
  });

  it("aucun produit rendu : ABSENCE_COUVERTURE ; fenetre plus courte que la revisite de Sentinel-2 : FENETRE_TROP_COURTE", () => {
    expect(cause(base({ sourcesDisponibles: [cdse([]), es([])] }))?.cause).toBe("ABSENCE_COUVERTURE");
    const courte = cause(base({ dates: { debut: "2026-10-24T00:00:00Z", fin: "2026-10-26T00:00:00Z" }, sourcesDisponibles: [cdse([]), es([])] }));
    expect(courte?.cause).toBe("FENETRE_TROP_COURTE");
    expect(courte?.details[0]).toMatch(/revisite de Sentinel-2 \(5 j/);
  });

  it("des produits existent mais hors de la fenetre : ABSENCE_COUVERTURE (ou FENETRE_TROP_COURTE si la fenetre est trop courte)", () => {
    const hors = { debut: "2026-10-01T00:00:00Z", fin: "2026-10-10T00:00:00Z" };
    const a = cause(base({ dates: hors, sourcesDisponibles: [cdse(cdseS2)] }));
    expect(a?.cause).toBe("ABSENCE_COUVERTURE");
    expect(a?.details[0]).toMatch(/aucun dans la fenetre/);
    const b = cause(base({ dates: { debut: "2026-10-01T00:00:00Z", fin: "2026-10-03T00:00:00Z" }, sourcesDisponibles: [cdse(cdseS2)] }));
    expect(b?.cause).toBe("FENETRE_TROP_COURTE");
  });

  it("zone ailleurs (Nzerekore) : aucun produit ne la couvre", () => {
    const a = cause(base({ zone: { bbox: [-8.92, 7.65, -8.72, 7.85] }, sourcesDisponibles: [cdse(cdseS2), es(esS2)] }));
    expect(a?.cause).toBe("ABSENCE_COUVERTURE");
    expect(a?.details[0]).toMatch(/aucun ne couvre la zone/);
  });

  it("zone etendue qu'aucune scene ne couvre assez : ABSENCE_COUVERTURE avec la meilleure part ; couvertureMinZone = 0 les admet", () => {
    const vaste: BBox = [-15.2, 9.9, -13.8, 11.7];
    const a = cause(base({ zone: { bbox: vaste }, sourcesDisponibles: [cdse(cdseS2)] }));
    expect(a?.cause).toBe("ABSENCE_COUVERTURE");
    expect(a?.details[0]).toMatch(/coupent la zone mais aucun n'en couvre 50 % \(meilleur : \d+(\.\d+)? %\)/);
    expect(choisirSource(base({ zone: { bbox: vaste }, couvertureMinZone: 0, sourcesDisponibles: [cdse(cdseS2)] })).retenue).not.toBeNull();
  });

  it("radar seul pour une nouvelle route : ABSENCE_COUVERTURE, la nature est inadaptee", () => {
    const a = cause(base({ phenomene: "NOUVELLE_ROUTE", sourcesDisponibles: [cdse(cdseS1)], dates: { debut: "2026-10-19T00:00:00Z", fin: "2026-10-26T00:00:00Z" } }));
    expect(a?.cause).toBe("ABSENCE_COUVERTURE");
    expect(a?.details[0]).toMatch(/tous radar/);
  });

  it("resolution insuffisante : Landsat (30 m) pour une nouvelle route (10 m exiges) donne QUALITE ; pour la vegetation il convient", () => {
    const fen = { debut: "2026-10-10T00:00:00Z", fin: "2026-10-20T00:00:00Z" };
    const a = cause(base({ phenomene: "NOUVELLE_ROUTE", nuagesMax: 90, dates: fen, sourcesDisponibles: [es(esLandsat)] }));
    expect(a?.cause).toBe("QUALITE");
    expect(a?.details[0]).toMatch(/plus grossiers que 10 m/);
    const veg = choisirSource(base({ phenomene: "VEGETATION", nuagesMax: 90, dates: fen, sourcesDisponibles: [es(esLandsat)] }));
    expect(veg.retenue?.produit.capteur).toBe("LANDSAT");
    expect(veg.retenue?.raisons.find((x) => x.critere === "nuages")?.valeur).toBe("77.07 % (tuile)");
  });

  it("resultat partiel : une source en erreur, l'autre ne trouve rien -> on n'affirme pas l'absence de couverture", () => {
    const a = cause(base({ sourcesDisponibles: [cdse(undefined, { erreur: { categorie: "INDISPONIBLE", message: "HTTP 503" } }), es([])] }));
    expect(a?.cause).toBe("ERREUR_API");
    expect(a?.details.join(" ")).toMatch(/resultat partiel/);
    const q = cause(base({ sourcesDisponibles: [cdse(cdseS2, { quota: "EPUISE" }), es([])] }));
    expect(q?.cause).toBe("QUOTA");
  });

  it("resultat partiel mais des produits trop nuageux ont ete vus : la cause NUAGES tient", () => {
    const a = cause(base({ nuagesMax: 10, sourcesDisponibles: [cdse(undefined, { erreur: { categorie: "RESEAU", message: "x" } }), es(esS2)] }));
    expect(a?.cause).toBe("NUAGES");
    expect(a?.details.join(" ")).toMatch(/resultat partiel/);
  });
});

describe("deduplication (cas fabriques sur items reels : synthetique)", () => {
  it("meme identifiant fournisseur chez deux sources : un seul garde", () => {
    const r = choisirSource(base({ sourcesDisponibles: [cdse(cdseS2), { ...cdse(cdseS2), code: "earth-search", priorite: 2 }] }));
    expect(r.classement).toHaveLength(2);
    expect(r.ecartes.filter((e) => e.cause === "DOUBLON")).toHaveLength(2);
  });
  it("L1C et L2A de la meme tuile le meme jour ne sont PAS des doublons (niveaux differents) ; a score egal, la L2A passe avant", () => {
    const itemL1c = charger("cdse-stac-s2-l1c.json").reponse.features[0];
    // meme couverture nuageuse que la L2A pour que le score soit egal : seul le niveau les departage
    const l1c = produitVariante(itemL1c, "S2C_MSIL1C_SYN", "2026-10-25T11:21:41.025Z", 35.65, "cdse-stac", "CDSE", "sentinel-2-l1c");
    const r = choisirSource(base({ sourcesDisponibles: [cdse([l1c, cdseS2[0]])] }));
    expect(r.classement).toHaveLength(2);
    expect(r.ecartes.filter((e) => e.cause === "DOUBLON")).toHaveLength(0);
    expect(r.classement[0].score).toBe(r.classement[1].score);
    expect(r.classement[0].produit.niveauTraitement).toBe("L2A");
    expect(r.classement[1].produit.niveauTraitement).toBe("L1C");
  });
});

describe("determinisme, purete, entrees", () => {
  it("memes entrees, memes sorties ; les entrees ne sont pas modifiees", () => {
    const p = base();
    const avant = structuredClone(p);
    const a = choisirSource(p);
    const b = choisirSource(p);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(p).toEqual(avant);
  });

  it("les metadonnees sont serialisables en JSON sans perte et portent l'entonnoir", () => {
    const m = choisirSource(base()).metadonnees as any;
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
    expect(m.regle).toBe("selection-v1");
    expect(m.entonnoir).toMatchObject({ produitsRendus: 8, coupantLaZone: 8, couvrantLaZone: 4, dansLaFenetre: 4, admissiblesApresDeduplication: 2 });
    expect(m.sources).toEqual([
      { code: "cdse-stac", etat: "PRODUIT_DISPONIBLE", quota: "OK", produits: 4, blocage: null, enCache: false },
      { code: "earth-search", etat: "ACCESSIBLE", quota: "INCONNU", produits: 4, blocage: null, enCache: false },
    ]);
    expect(m.ecartes).toEqual({ COUVERTURE_PARTIELLE: 4, DOUBLON: 2 });
    expect(m.causeAucune).toBeNull();
  });

  it("une zone peut etre un polygone", () => {
    const polygone = { type: "Polygon" as const, coordinates: [[[-14.39, 10.83], [-14.19, 10.83], [-14.19, 11.03], [-14.39, 11.03], [-14.39, 10.83]]] };
    expect(choisirSource(base({ zone: { polygone } })).retenue?.produit.tuileMgrs).toBe("28PET");
  });

  it.each([
    ["bbox invalide", { zone: { bbox: [1, 2, 0, 1] as BBox } }],
    ["fenetre inversee", { dates: { debut: "2026-10-25T00:00:00Z", fin: "2026-10-01T00:00:00Z" } }],
    ["date illisible", { dates: { debut: "hier", fin: "2026-10-01T00:00:00Z" } }],
    ["nuagesMax > 100", { nuagesMax: 120 }],
    ["couvertureMinZone > 1", { couvertureMinZone: 2 }],
  ])("%s : erreur d'entree", (_nom, extra) => {
    expect(() => choisirSource(base(extra as Partial<ParamsSelection>))).toThrowError(/invalide|illisible|pourcentage|entre 0 et 1/);
  });
});
