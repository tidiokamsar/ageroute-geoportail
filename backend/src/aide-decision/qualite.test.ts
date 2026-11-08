import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  appels: [] as { client: unknown; options: Record<string, unknown> }[],
  rapports: new Map<string, unknown>(),
  limitesUtilisables: 3,
  echec: false,
}));

vi.mock("../lib/prisma", () => ({ prisma: {} }));
vi.mock("../qualite/detecteurs.service", async (original) => {
  const reel = await original<typeof import("../qualite/detecteurs.service")>();
  return {
    ...reel,
    lancerEnLectureSeule: async (client: unknown, options: { portee: { regionId: number | null } }) => {
      h.appels.push({ client, options: options as unknown as Record<string, unknown> });
      if (h.echec) throw new Error("base indisponible");
      return h.rapports.get(String(options.portee.regionId)) ?? rapportVide();
    },
  };
});
vi.mock("../qualite/detecteurs.depot", async (original) => {
  const reel = await original<typeof import("../qualite/detecteurs.depot")>();
  return {
    ...reel,
    etatDesLimites: async () => ({ utilisables: h.limitesUtilisables, invalides: 0 }),
    nomsDesRegions: async () => new Map([[1, "Boké"], [2, "Kindia"], [3, "Non renseigné"]]),
  };
});

import {
  FAMILLES_SYNTHESE, NON_COUVERT_AIDE_DECISION, collecterQualite, collecterQualitePartage, composerQualite, couvertureParRegion, donneesAConfirmer,
  fusionnerPassages, type DepotQualite, type PassageDetecteurs,
} from "./qualite";
import { agregerEtat, type LigneEtat } from "./kpi.noyau";
import type { RapportDetecteurs } from "../qualite/detecteurs.service";
import type { CodeAnomalie } from "../qualite/detecteurs.noyau";

function rapportVide(): RapportDetecteurs {
  return { genereLe: "x", portee: { regionId: null, reseau: "reference" }, familles: [], seuils: [], populationTronconsActifs: 0, total: 0, parCode: [], parRegion: [], codesSansAnomalie: [], avertissements: [], nonCouvert: [] };
}

/** Un rapport de detecteurs : `regions` = { regionId: { code: nombre } }. */
function rapport(population: number, regions: Record<number, Partial<Record<CodeAnomalie, number>>>, avertissements: string[] = []): RapportDetecteurs {
  const gravite = (c: CodeAnomalie) => (c === "GEOM_INVALIDE" || c === "PK_CHEVAUCHEMENT" ? "BLOQUANTE" : c === "ETAT_NON_EVALUE" ? "A_SURVEILLER" : "A_TRAITER");
  const parCode = new Map<CodeAnomalie, number>();
  const parRegion = Object.entries(regions).map(([id, codes]) => {
    let total = 0;
    for (const [c, v] of Object.entries(codes) as [CodeAnomalie, number][]) { parCode.set(c, (parCode.get(c) ?? 0) + v); total += v; }
    return { regionId: Number(id), total, parCode: codes };
  });
  return {
    ...rapportVide(), populationTronconsActifs: population, avertissements,
    seuils: [{ nom: "LONGUEUR_ECART_RELATIF", valeur: 0.1, unite: "part", statut: "PROVISOIRE", origine: "test" }],
    parCode: [...parCode.entries()].map(([code, nombre]) => ({ code, famille: "ETAT", gravite: gravite(code), nombre, tronque: false, entites: [] })) as RapportDetecteurs["parCode"],
    parRegion: parRegion.map((r) => ({ ...r, regionNom: null })) as RapportDetecteurs["parRegion"],
  };
}

const NOMS = new Map([[1, "Boké"], [2, "Kindia"]]);

beforeEach(() => { h.appels = []; h.rapports = new Map(); h.limitesUtilisables = 3; h.echec = false; });

describe("fusionnerPassages", () => {
  it("un passage « pays entier » apporte toutes les regions, les comptes par code et par gravite", () => {
    const r = fusionnerPassages([{ regionId: null, rapport: rapport(100, { 1: { ETAT_NON_EVALUE: 40, GEOM_INVALIDE: 2 }, 2: { ETAT_NON_EVALUE: 10, PK_CHEVAUCHEMENT: 1 } }) }], NOMS, [], "2026-10-26T00:00:00.000Z");
    expect(r.population).toBe(100);
    expect(r.total).toBe(53);
    expect(r.parCode.map((c) => [c.code, c.nombre, c.gravite])).toEqual([
      ["GEOM_INVALIDE", 2, "BLOQUANTE"], ["PK_CHEVAUCHEMENT", 1, "BLOQUANTE"], ["ETAT_NON_EVALUE", 50, "A_SURVEILLER"],
    ]);
    expect(r.parGravite).toEqual({ BLOQUANTE: 3, A_TRAITER: 0, A_SURVEILLER: 50 });
    expect(r.parRegion.map((x) => [x.regionId, x.regionNom, x.total])).toEqual([[1, "Boké", 42], [2, "Kindia", 11]]);
    expect(r.parCode.find((c) => c.code === "GEOM_INVALIDE")?.part).toBe(0.02);
  });

  it("un passage de region ne retient QUE la ligne de sa region (pas de fuite vers une autre region, pas de double compte)", () => {
    // Le passage de la region 1 voit aussi une anomalie de chainage portee par un troncon de la region 2 : elle n'est pas retenue ici.
    const p: PassageDetecteurs[] = [
      { regionId: 1, rapport: rapport(60, { 1: { PK_CHEVAUCHEMENT: 1, ETAT_NON_EVALUE: 5 }, 2: { PK_CHEVAUCHEMENT: 1 } }) },
      { regionId: 2, rapport: rapport(40, { 2: { PK_CHEVAUCHEMENT: 1, ETAT_NON_EVALUE: 3 }, 1: { PK_CHEVAUCHEMENT: 1 } }) },
    ];
    const r = fusionnerPassages(p, NOMS, [], "x");
    expect(r.population).toBe(100);
    expect(r.parCode.find((c) => c.code === "PK_CHEVAUCHEMENT")?.nombre).toBe(2); // une par region porteuse, pas 4
    expect(r.parRegion.map((x) => [x.regionId, x.total])).toEqual([[1, 6], [2, 4]]);
  });

  it("un compte a UNE region ne recoit jamais la ligne d'une autre", () => {
    const r = fusionnerPassages([{ regionId: 1, rapport: rapport(60, { 1: { GEOM_INVALIDE: 1 }, 2: { GEOM_INVALIDE: 9 } }) }], NOMS, [], "x");
    expect(r.parRegion.map((x) => x.regionId)).toEqual([1]);
    expect(r.total).toBe(1);
  });

  it("les codes sans anomalie ne comptent pas les familles non executees (aucune limite administrative : REGION)", () => {
    const sans = fusionnerPassages([{ regionId: null, rapport: rapport(10, {}) }], NOMS, ["REGION"], "x");
    expect(sans.famillesNonExecutees).toEqual(["REGION"]);
    expect(sans.codesSansAnomalie).not.toContain("HORS_TERRITOIRE");
    expect(sans.codesSansAnomalie).not.toContain("REGION_DISCORDANTE");
    expect(sans.codesSansAnomalie).toContain("GEOM_INVALIDE");
    const avec = fusionnerPassages([{ regionId: null, rapport: rapport(10, {}) }], NOMS, [], "x");
    expect(avec.codesSansAnomalie).toContain("HORS_TERRITOIRE");
  });

  it("zero anomalie : total 0 et part nulle sans population", () => {
    const r = fusionnerPassages([{ regionId: null, rapport: rapport(0, {}) }], NOMS, [], "x");
    expect(r.total).toBe(0);
    expect(r.parCode).toEqual([]);
  });

  it("reprend les seuils provisoires et dedoublonne les avertissements", () => {
    const r = fusionnerPassages([
      { regionId: 1, rapport: rapport(1, {}, ["A", "B"]) }, { regionId: 2, rapport: rapport(1, {}, ["B", "C"]) },
    ], NOMS, [], "x");
    expect(r.avertissements).toEqual(["A", "B", "C"]);
    expect(r.seuils[0].statut).toBe("PROVISOIRE");
  });
});

describe("collecterQualite : lecture seule, comptes seuls", () => {
  it("lance les detecteurs avec plafond 0 (aucune liste d'entites), reseau « reference », la date injectee", async () => {
    const maintenant = new Date("2026-10-26T12:00:00Z");
    h.rapports.set("null", rapport(5, { 1: { GEOM_INVALIDE: 1 } }));
    const r = await collecterQualite({} as never, null, maintenant);
    expect(h.appels).toHaveLength(1);
    expect(h.appels[0].options).toMatchObject({ portee: { regionId: null, reseau: "reference" }, plafondParCode: 0, maintenant });
    expect((h.appels[0].options.familles as string[]).length).toBe(6); // par defaut : les six familles
    expect(r.genereLe).toBe(maintenant.toISOString());
    expect(JSON.stringify(r)).not.toMatch(/entites/);
  });

  it("un compte regional est servi region par region, jamais par un balayage du pays", async () => {
    h.rapports.set("1", rapport(5, { 1: { GEOM_INVALIDE: 1 } }));
    h.rapports.set("2", rapport(7, { 2: { GEOM_INVALIDE: 2 } }));
    const r = await collecterQualite({} as never, [2, 1], new Date());
    expect(h.appels.map((a) => (a.options.portee as { regionId: number | null }).regionId)).toEqual([2, 1]);
    expect(h.appels.some((a) => (a.options.portee as { regionId: number | null }).regionId === null)).toBe(false);
    expect(r.population).toBe(12);
    expect(r.total).toBe(3);
  });

  it("la synthese ne lance que les quatre familles a passage borne ; REGION et DOUBLON sont declarees NON executees (cout)", async () => {
    const r = await collecterQualite({} as never, null, new Date(), FAMILLES_SYNTHESE);
    expect(h.appels[0].options.familles).toEqual(["PK", "LONGUEUR", "GEOMETRIE", "ETAT"]);
    expect(r.famillesExecutees).toEqual(["PK", "LONGUEUR", "GEOMETRIE", "ETAT"]);
    expect(r.famillesNonExecutees).toEqual(["REGION", "DOUBLON"]);
    expect(r.codesSansAnomalie).not.toContain("DOUBLON_GEOMETRIE_STRICT");
    expect(r.codesSansAnomalie).not.toContain("HORS_TERRITOIRE");
    expect(r.codesSansAnomalie).toContain("GEOM_INVALIDE");
  });

  it("deux appels simultanes de portee ou de familles differentes ne se partagent PAS", async () => {
    await Promise.all([collecterQualitePartage({} as never, null, new Date(), FAMILLES_SYNTHESE), collecterQualitePartage({} as never, null, new Date())]);
    expect(h.appels).toHaveLength(2);
  });

  it("sans limite administrative en base, la famille REGION est declaree non executee", async () => {
    h.limitesUtilisables = 0;
    const r = await collecterQualite({} as never, null, new Date());
    expect(r.famillesNonExecutees).toEqual(["REGION"]);
  });

  it("deux appels simultanes de meme portee partagent UN SEUL balayage ; le suivant recalcule", async () => {
    const [a, b] = await Promise.all([collecterQualitePartage({} as never, null, new Date()), collecterQualitePartage({} as never, null, new Date())]);
    expect(a).toBe(b);
    expect(h.appels).toHaveLength(1);
    await collecterQualitePartage({} as never, null, new Date());
    expect(h.appels).toHaveLength(2);
  });

  it("un echec se propage et ne reste pas en cache", async () => {
    h.echec = true;
    await expect(collecterQualitePartage({} as never, [1], new Date())).rejects.toThrow(/indisponible/);
    h.echec = false;
    await expect(collecterQualitePartage({} as never, [1], new Date())).resolves.toBeTruthy();
  });
});

describe("donneesAConfirmer", () => {
  it("n'ajoute pas deux fois ce qui dit « non evalue »", () => {
    const q = fusionnerPassages([{ regionId: null, rapport: rapport(100, { 1: { ETAT_NON_EVALUE: 40, ETAT_ABSENT: 1, GEOM_INVALIDE: 2, PK_TROU: 3 } }) }], NOMS, [], "x");
    expect(donneesAConfirmer(41, q)).toEqual({ valeur: 41 + 2 + 3, anomalies: 5 });
  });
  it("zero tronçon non évalué et zéro anomalie : zéro réel (les détecteurs ont tourné)", () => {
    const q = fusionnerPassages([{ regionId: null, rapport: rapport(3, {}) }], NOMS, [], "x");
    expect(donneesAConfirmer(0, q)).toEqual({ valeur: 0, anomalies: 0 });
  });
});

describe("couvertureParRegion", () => {
  const ligne = (o: Partial<LigneEtat>): LigneEtat => ({
    regionId: 1, etat: "BON", provenance: "OBSERVED", observeDate: true, statutValidation: null, longueurConnue: true, nb: 1, km: 10,
    derniereEvaluation: null, plusAncienneEvaluation: null, ...o,
  });
  const noms = new Map([[1, "Boké"], [2, "Kindia"], [3, "Non renseigné"], [4, "Labé"]]);

  it("taux de non evalues par region, region sans troncon presente avec taux nul, « Non renseigné » vide omis", () => {
    const b = agregerEtat([
      ligne({ regionId: 1, nb: 3, km: 30 }), ligne({ regionId: 1, etat: "NON_EVALUE", provenance: "UNKNOWN", nb: 1, km: 10 }),
      ligne({ regionId: 2, etat: "NON_EVALUE", provenance: "UNKNOWN", nb: 2, km: 0, longueurConnue: false }),
    ]);
    const c = couvertureParRegion(b, noms, null, null);
    expect(c.map((x) => x.regionNom)).toEqual(["Boké", "Kindia", "Labé"]); // « Non renseigné » omis, aucun troncon
    const boke = c[0];
    expect(boke).toMatchObject({ troncons: 4, tronconsNonEvalues: 1, tauxNonEvalues: 0.25, longueurConnueKm: 40, nonEvalueKm: 10, partNonEvalueeKm: 0.25, eligibleKm: 30, anomalies: null });
    expect(c[1]).toMatchObject({ troncons: 2, tauxNonEvalues: 1, tronconsSansLongueurMetier: 2, partNonEvalueeKm: null });
    expect(c[2]).toMatchObject({ troncons: 0, tauxNonEvalues: null, partNonEvalueeKm: null });
  });

  it("un compte regional ne voit que ses regions", () => {
    const b = agregerEtat([ligne({ regionId: 2 })]);
    expect(couvertureParRegion(b, noms, [2], null).map((x) => x.regionId)).toEqual([2]);
  });

  it("rejoint les anomalies des detecteurs, hors celles qui disent « non evalue »", () => {
    const b = agregerEtat([ligne({ regionId: 1 })]);
    const q = fusionnerPassages([{ regionId: null, rapport: rapport(5, { 1: { ETAT_NON_EVALUE: 4, GEOM_INVALIDE: 2 } }) }], NOMS, [], "x");
    const c = couvertureParRegion(b, noms, [1], q.parRegion);
    expect(c[0]).toMatchObject({ anomalies: 6, anomaliesHorsEtatNonEvalue: 2 });
  });
});

describe("composerQualite", () => {
  const depot = (q: (...a: unknown[]) => Promise<unknown>): DepotQualite => ({
    etat: async () => [{ regionId: 1, etat: "NON_EVALUE", provenance: "UNKNOWN", observeDate: false, statutValidation: null, longueurConnueme: true } as unknown as LigneEtat].map((l) => ({ ...l, longueurConnue: true, nb: 4, km: 20, derniereEvaluation: null, plusAncienneEvaluation: null })),
    qualite: q as DepotQualite["qualite"],
    nomsRegions: async () => new Map([[1, "Boké"]]),
  });

  it("rend les detecteurs, la couverture et la liste de ce qui n'est pas couvert", async () => {
    const q = fusionnerPassages([{ regionId: null, rapport: rapport(4, { 1: { ETAT_NON_EVALUE: 4 } }) }], NOMS, [], "x");
    const appelee: unknown[][] = [];
    const d = depot(async (...a: unknown[]) => { appelee.push(a); return q; });
    const r = await composerQualite(d, { regions: null, maintenant: new Date("2026-10-26T00:00:00Z"), regionDemandee: null, filtresNonAppliques: [] });
    expect(appelee[0][2]).toHaveLength(6); // /qualite execute les six familles
    expect(r.detecteurs.famillesExecutees).toHaveLength(6);
    expect(r.statutDefinition).toBe("PROVISOIRE");
    expect(r.perimetre.national).toBe(true);
    expect(r.detecteurs.etat).toBe("DISPONIBLE");
    expect(r.detecteurs.total).toBe(4);
    expect(r.couvertureParRegion[0]).toMatchObject({ regionNom: "Boké", tauxNonEvalues: 1 });
    expect(r.etatDuReseau).toMatchObject({ troncons: 4, tronconsNonEvalues: 4, partNonEvaluee: 1, eligibleKm: 0 });
    expect(r.donneesAConfirmer.valeur).toBe(4);
    expect(r.nonCouvert).toBe(NON_COUVERT_AIDE_DECISION);
    expect(r.consultatif).toMatch(/non engageants/);
  });

  it("si les detecteurs echouent : NON_DISPONIBLE, la couverture reste rendue, aucune valeur inventee", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await composerQualite(depot(async () => { throw new Error("boom"); }), { regions: [1], maintenant: new Date(), regionDemandee: 1, filtresNonAppliques: [] });
    spy.mockRestore();
    expect(r.detecteurs.etat).toBe("NON_DISPONIBLE");
    expect(r.detecteurs.total).toBeNull();
    expect(r.detecteurs.parGravite).toBeNull();
    expect(r.donneesAConfirmer.valeur).toBeNull();
    expect(r.couvertureParRegion).toHaveLength(1);
    expect(r.avertissements[0]).toMatch(/n'ont pas pu être exécutés/);
    expect(r.filtres.appliques).toEqual({ regionId: 1 });
    expect(r.perimetre).toMatchObject({ national: false, regionId: 1, libelle: "Région Boké" });
  });

  it("un perimetre sans troncon : donnees a confirmer inconnues, jamais 0", async () => {
    const q = fusionnerPassages([{ regionId: null, rapport: rapport(0, {}) }], NOMS, [], "x");
    const vide: DepotQualite = { etat: async () => [], qualite: async () => q, nomsRegions: async () => new Map() };
    const r = await composerQualite(vide, { regions: null, maintenant: new Date(), regionDemandee: null, filtresNonAppliques: [] });
    expect(r.donneesAConfirmer.valeur).toBeNull();
    expect(r.etatDuReseau.partNonEvaluee).toBeNull();
  });
});

describe("ce que les detecteurs ne couvrent pas", () => {
  const texte = NON_COUVERT_AIDE_DECISION.join("\n");
  it("liste les trous du cahier 9.2 sans les inventer comme anomalies", () => {
    expect(texte).toMatch(/Contradictions entre le referentiel, les inspections, les chantiers et la source contractuelle/);
    expect(texte).toMatch(/Source inconnue/);
    expect(texte).toMatch(/Date de mesure absente/);
    expect(texte).toMatch(/Associations marche-chantier-troncon manquantes ou ambigues/);
    expect(texte).toMatch(/Donnees trop anciennes/);
  });
  it("reprend aussi la liste du service des detecteurs", () => {
    expect(NON_COUVERT_AIDE_DECISION.length).toBeGreaterThan(9);
    expect(texte).toMatch(/Les seuils sont PROVISOIRES/);
  });
});
