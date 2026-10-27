import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({ prisma: {} }));

import { composerSynthese, type DepotSynthese, type Synthese } from "./synthese";
import { entree } from "./dictionnaire";
import { FAMILLES_SYNTHESE, fusionnerPassages } from "./qualite";
import { PARAMETRES_KPI, type LigneEtat, type ParametresKpi } from "./kpi.noyau";
import type { IndicateurEvalue } from "../tableau-de-bord/tableau-de-bord.service";
import type { RapportDetecteurs } from "../qualite/detecteurs.service";
import type { CodeAnomalie } from "../qualite/detecteurs.noyau";

/**
 * L'assemblage de la synthese, sans base : les lectures sont injectees. Ce que ces tests defendent :
 *   - un inconnu n'est jamais un zero (valeur null, etat NON_DISPONIBLE) ;
 *   - le budget engage n'est JAMAIS calcule ; contractuel, decaisse, previsionnel sont distincts, en chaines ;
 *   - la somme des chantiers n'est jamais lue ; les marches ne sont pas les chantiers ;
 *   - le perimetre d'un compte regional est dit, jamais « pays » ;
 *   - une lecture secondaire en echec degrade son bloc ; la lecture de l'etat fait echouer l'appel ;
 *   - la reponse est stable et serialisable (aucun BigInt).
 */

const MAINTENANT = new Date("2026-10-26T12:00:00Z");
const NOMS = new Map([[1, "Boké"], [2, "Kindia"], [3, "Non renseigné"]]);

const L = (o: Partial<LigneEtat>): LigneEtat => ({
  regionId: 1, etat: "BON", provenance: "OBSERVED", observeDate: true, statutValidation: null, longueurConnue: true, nb: 1, km: 10,
  derniereEvaluation: null, plusAncienneEvaluation: null, ...o,
});

/** Region 1 : 30 km mauvais + 70 km bon constates, 500 km critiques importes (non valides), 10 troncons non evalues (100 km), 2 sans longueur. Region 2 : 20 km critiques + 80 km moyens constates. */
const LIGNES: LigneEtat[] = [
  L({ etat: "MAUVAIS", nb: 3, km: 30, derniereEvaluation: new Date("2026-10-01T00:00:00Z"), plusAncienneEvaluation: new Date("2026-06-01T00:00:00Z") }),
  L({ etat: "BON", nb: 7, km: 70, derniereEvaluation: new Date("2026-09-01T00:00:00Z"), plusAncienneEvaluation: new Date("2025-01-01T00:00:00Z") }),
  L({ etat: "CRITIQUE", provenance: "IMPORTED_UNVERIFIED", nb: 5, km: 500 }),
  L({ etat: "NON_EVALUE", provenance: "UNKNOWN", observeDate: false, nb: 10, km: 100 }),
  L({ etat: "BON", nb: 2, km: 0, longueurConnue: false }),
  L({ regionId: 2, etat: "CRITIQUE", nb: 2, km: 20 }),
  L({ regionId: 2, etat: "MOYEN", nb: 8, km: 80 }),
];

function rapport(population: number, regions: Record<number, Partial<Record<CodeAnomalie, number>>>, avertissements: string[] = []): RapportDetecteurs {
  const parCode = new Map<CodeAnomalie, number>();
  const parRegion = Object.entries(regions).map(([id, codes]) => {
    let total = 0;
    for (const [c, v] of Object.entries(codes) as [CodeAnomalie, number][]) { parCode.set(c, (parCode.get(c) ?? 0) + v); total += v; }
    return { regionId: Number(id), total, parCode: codes, regionNom: null };
  });
  return {
    genereLe: "x", portee: { regionId: null, reseau: "reference" }, familles: [], seuils: [], populationTronconsActifs: population, total: 0,
    parCode: [...parCode.entries()].map(([code, nombre]) => ({ code, famille: "ETAT", gravite: code === "ETAT_NON_EVALUE" ? "A_SURVEILLER" : "A_TRAITER", nombre, tronque: false, entites: [] })),
    parRegion, codesSansAnomalie: [], avertissements, nonCouvert: [],
  } as unknown as RapportDetecteurs;
}

const evalue = (code: string, valeur: number | string | null, o: Partial<IndicateurEvalue> = {}): IndicateurEvalue => ({
  code, libelle: code, groupe: "reseau", unite: "nombre", perimetre: { code: "P", libelle: "P", definition: "P" },
  statut: "CALCULE", valeur, motif: null, aucuneDonnee: false, sourceLibelle: null, ...o,
});

function depot(over: Partial<DepotSynthese> = {}): DepotSynthese & { appels: Record<string, unknown[][]> } {
  const appels: Record<string, unknown[][]> = {};
  const trace = <A extends unknown[]>(nom: string, a: A) => { (appels[nom] ??= []).push(a); };
  const base: DepotSynthese = {
    etat: async (...a) => { trace("etat", a); return LIGNES; },
    marches: async (...a) => { trace("marches", a); return { marches: 4, sansMontant: 1, horsGnf: 1, gnfAvecMontant: 2, contractuelGnf: "9007199254740993" }; },
    decaisse: async (...a) => { trace("decaisse", a); return { payes: 2, payeGnf: "1000", payesSansDate: 0, payesRetenueGarantie: 0, emis: 0 }; },
    parBailleur: async (...a) => {
      trace("parBailleur", a);
      return { totalBailleurs: 2, lignes: [
        { bailleurId: 5, nom: "Bailleur A", marches: 2, sansMontant: 0, horsGnf: 0, avecMontantGnf: 2, contractuelGnf: "9007199254740000", decaisseGnf: "1000" },
        { bailleurId: null, nom: null, marches: 2, sansMontant: 1, horsGnf: 1, avecMontantGnf: 1, contractuelGnf: "993", decaisseGnf: null },
      ] };
    },
    chantiersSansEcheance: async (...a) => { trace("sansEcheance", a); return 0; },
    registre: async (codes, ...a) => {
      trace("registre", [codes, ...a]);
      return [evalue("chantiers_en_cours", 5), evalue("chantiers_en_retard", 2), evalue("longueur_geometrique_km", 812.5, { unite: "km" }),
        evalue("previsions_retenues_nb", 3), evalue("previsions_retenues_gnf", "777", { unite: "GNF" })];
    },
    qualite: async (...a) => { trace("qualite", a); return fusionnerPassages([{ regionId: null, rapport: rapport(37, { 1: { ETAT_NON_EVALUE: 10, GEOM_INVALIDE: 2 }, 2: { LONGUEUR_ECART_GEOMETRIE: 1 } }) }], NOMS, [], MAINTENANT.toISOString()); },
    nomsRegions: async () => NOMS,
  };
  return { ...base, ...over, appels } as DepotSynthese & { appels: Record<string, unknown[][]> };
}

const TOUS_DROITS = { marches: true, programmation: true };
const ctx = (o: Partial<Parameters<typeof composerSynthese>[1]> = {}): Parameters<typeof composerSynthese>[1] => ({
  regions: null, maintenant: MAINTENANT, filtres: {}, droits: TOUS_DROITS, ...o,
});
const kpi = (s: Synthese, code: string) => s.kpis.find((k) => k.code === code)!;

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => undefined); });

describe("synthese complete, compte national", () => {
  let s: Synthese;
  beforeEach(async () => { s = await composerSynthese(depot(), ctx()); });

  it("rend les douze indicateurs du brief, dans l'ordre, chacun avec une entree de dictionnaire", () => {
    expect(s.kpis.map((k) => k.code)).toEqual([
      "reseau_degrade_pct", "reseau_critique_km", "reseau_critique_pct", "longueur_reseau_reference_km", "longueur_geometrique_km", "couverture_etat_part",
      "chantiers_en_cours", "chantiers_en_retard", "budget_engage_gnf", "budget_contractuel_gnf", "marches_recenses", "donnees_a_confirmer",
    ]);
    for (const k of s.kpis) {
      const e = entree(k.code);
      expect(k.definition).toBe(e.definition);
      expect(k.formule).toBe(e.formule);
      expect(k.statutDefinition).toBe("PROVISOIRE");
      expect(k.calculeLe).toBe(MAINTENANT.toISOString());
      expect(k.perimetre.libelle.length).toBeGreaterThan(5);
      expect(k.ouvre.onglet).toBeTruthy();
    }
  });

  it("reseau degrade : numerateur et denominateur sur les memes troncons a etat valide, non evalues et etats non valides a part", () => {
    const k = kpi(s, "reseau_degrade_pct");
    expect(k.valeur).toBe(25); // (30 + 20) / 200
    expect(k.etat).toBe("PARTIEL");
    expect(k.unite).toBe("%");
    expect(k.couverture).toMatchObject({ eligibleKm: 200, evalueKm: 700, nonEvalueKm: 100, partNonEvaluee: 0.125, etatNonValideKm: 500, tronconsNonEvalues: 10, tronconsEtatNonValide: 5, tronconsSansLongueurMetier: 2 });
    expect(k.avertissements.join(" ")).toMatch(/10 tronçons non évalués/);
    expect(k.avertissements.join(" ")).toMatch(/état renseigné mais non valide/);
    expect(k.avertissements.join(" ")).toMatch(/PROVISOIRE/);
    expect(k.ouvre).toEqual({ onglet: "carte", filtres: { etat: ["MAUVAIS", "CRITIQUE"] } });
  });

  it("reseau critique : km et part, etat valide seulement (les 500 km critiques importes n'y sont pas)", () => {
    expect(kpi(s, "reseau_critique_km").valeur).toBe(20);
    expect(kpi(s, "reseau_critique_pct").valeur).toBe(10);
    expect(kpi(s, "reseau_critique_km").unite).toBe("km");
  });

  it("longueur de reference = longueur metier connue ; la geometrique est un autre indicateur, jamais melangee", () => {
    const ref = kpi(s, "longueur_reseau_reference_km");
    expect(ref.valeur).toBe(800);
    expect(ref.etat).toBe("PARTIEL");
    expect(ref.avertissements.join(" ")).toMatch(/2 tronçons sans longueur métier sur 37/);
    expect(ref.avertissements.join(" ")).toMatch(/La longueur géométrique n'est pas substituée/);
    expect(ref.avertissements.join(" ")).toMatch(/1 tronçon dont la longueur saisie s'écarte/);
    const geo = kpi(s, "longueur_geometrique_km");
    expect(geo.valeur).toBe(812.5);
    expect(geo.valeur).not.toBe(ref.valeur);
  });

  it("couverture de l'etat : part des longueurs connues dont l'etat est valide", () => {
    expect(kpi(s, "couverture_etat_part").valeur).toBe(0.25);
    expect(kpi(s, "couverture_etat_part").unite).toBe("part");
  });

  it("chantiers : repris du registre, sans plafond ; l'avertissement de retard dit ce que la regle ignore", () => {
    expect(kpi(s, "chantiers_en_cours").valeur).toBe(5);
    const r = kpi(s, "chantiers_en_retard");
    expect(r.valeur).toBe(2);
    expect(r.etat).toBe("DISPONIBLE");
    expect(r.avertissements.join(" ")).toMatch(/suspensions/);
    expect(r.avertissements.join(" ")).toMatch(/avenants/);
  });

  it("le registre est interroge avec des codes precis, JAMAIS « chantiers_montant_gnf » (la somme des chantiers n'est pas un engage)", async () => {
    const d = depot();
    await composerSynthese(d, ctx());
    const codes = d.appels.registre[0][0] as string[];
    expect(codes).toContain("chantiers_en_cours");
    expect(codes).not.toContain("chantiers_montant_gnf");
  });

  it("budget engage : NON_DISPONIBLE avec la raison (B-08, ADR-003), jamais une somme", () => {
    const k = kpi(s, "budget_engage_gnf");
    expect(k.valeur).toBeNull();
    expect(k.valeurTexte).toBeNull();
    expect(k.etat).toBe("NON_DISPONIBLE");
    expect(k.avertissements[0]).toMatch(/source financière de référence non validée \(B-08, ADR-003\)/);
    expect(s.budget.engage).toEqual({
      etat: "NON_DISPONIBLE", valeurGnf: null, source: null,
      avertissement: expect.stringMatching(/source financière de référence non validée \(B-08, ADR-003\)/),
    });
    expect(JSON.stringify(s)).not.toMatch(/"valeurGnf":"15000000"/);
  });

  it("budget contractuel : montant des marches en GNF, chaine exacte (> 2^53), etiquete et PARTIEL (sans montant, devise etrangere)", () => {
    const c = s.budget.contractuel;
    expect(c.valeurGnf).toBe("9007199254740993");
    expect(c.etat).toBe("PARTIEL");
    expect(c.source).toMatch(/marches\.montantTotal/);
    expect(c.avertissement).toMatch(/1 marché sans montant saisi/);
    expect(c.avertissement).toMatch(/1 marché en devise étrangère exclu/);
    const k = kpi(s, "budget_contractuel_gnf");
    expect(k.valeur).toBeNull(); // 2^53 + 1 : pas representable, le lecteur prend la chaine
    expect(k.valeurTexte).toBe("9007199254740993");
    expect(k.periode).toBeNull();
  });

  it("marches recenses = lignes de marches, dit « recensés », jamais « actifs »", () => {
    const k = kpi(s, "marches_recenses");
    expect(k.valeur).toBe(4);
    expect(k.etat).toBe("DISPONIBLE");
    expect(k.avertissements[0]).toMatch(/ni actif ni validé/);
    expect(k.libelle).toMatch(/recensés/);
    expect(k.libelle).not.toMatch(/actif/i);
  });

  it("decaisse et previsionnel : chacun avec son etat, en chaines", () => {
    expect(s.budget.decaisse).toMatchObject({ etat: "DISPONIBLE", valeurGnf: "1000", avertissement: null });
    expect(s.budget.previsionnel).toMatchObject({ etat: "DISPONIBLE", valeurGnf: "777", avertissement: null });
  });

  it("parBailleur : par bailleurId, groupe « non renseigné », decaisse inconnu = null, jamais 0", () => {
    const p = s.budget.parBailleur;
    expect(p.critere).toMatch(/marches\.bailleurId/);
    expect(p.critere).toMatch(/jamais le texte libre/);
    expect(p.lignes[0]).toMatchObject({ bailleurId: 5, bailleur: "Bailleur A", contractuelGnf: "9007199254740000", decaisseGnf: "1000" });
    expect(p.lignes[1]).toMatchObject({ bailleurId: null, bailleur: "Bailleur non renseigné", decaisseGnf: null });
    expect(p.tronque).toBe(false);
    expect(p.message).toBeNull();
    expect(p.autres).toBeNull();
  });

  it("donnees a confirmer : non evalues + anomalies, sans compter deux fois « non evalue »", () => {
    const k = kpi(s, "donnees_a_confirmer");
    expect(k.valeur).toBe(10 + 2 + 1); // 10 non evalues + GEOM_INVALIDE 2 + LONGUEUR_ECART 1 ; ETAT_NON_EVALUE ecarte
    expect(k.etat).toBe("DISPONIBLE");
    expect(k.unite).toBe("éléments");
    expect(k.ouvre.onglet).toBe("rapports");
  });

  it("la synthese ne lance que les familles de detecteurs a passage borne ; REGION et DOUBLON, couteuses, sont dites non executees et le nombre est une borne basse", async () => {
    const d = depot({ qualite: async () => fusionnerPassages([{ regionId: null, rapport: rapport(37, { 1: { ETAT_NON_EVALUE: 10, GEOM_INVALIDE: 2 } }) }], NOMS, ["REGION", "DOUBLON"], MAINTENANT.toISOString()) });
    const s2 = await composerSynthese(d, ctx());
    expect(FAMILLES_SYNTHESE).toEqual(["PK", "LONGUEUR", "GEOMETRIE", "ETAT"]);
    const k = kpi(s2, "donnees_a_confirmer");
    expect(k.etat).toBe("PARTIEL");
    expect(k.valeur).toBe(12);
    expect(k.avertissements.join(" ")).toMatch(/Familles de détecteurs non exécutées dans la synthèse : REGION, DOUBLON/);
    expect(k.avertissements.join(" ")).toMatch(/borne basse/);
    expect(s2.qualite.famillesNonExecutees).toEqual(["REGION", "DOUBLON"]);
    expect(s2.qualite.etat).toBe("PARTIEL");
  });

  it("la repartition de l'etat : km par classe, parts rapportees aux etats valides, non evalue et non valide a part", () => {
    const r = s.repartitionEtat;
    expect(r.eligibleKm).toBe(200);
    expect(r.perimetreKm).toBe(800);
    expect(r.classes).toEqual([
      { classe: "BON", km: 70, troncons: 9, partPct: 35 }, // 7 avec longueur + 2 sans longueur (comptes, jamais additionnes)
      { classe: "MOYEN", km: 80, troncons: 8, partPct: 40 },
      { classe: "MAUVAIS", km: 30, troncons: 3, partPct: 15 },
      { classe: "CRITIQUE", km: 20, troncons: 2, partPct: 10 },
    ]);
    expect(r.classes.reduce((a, c) => a + (c.partPct ?? 0), 0)).toBe(100);
    expect(r.nonEvalue).toEqual({ km: 100, troncons: 10, partDuPerimetre: 0.125 });
    expect(r.etatNonValide.km).toBe(500);
    expect(r.etatNonValide.parClasse.CRITIQUE).toEqual({ km: 500, troncons: 5 });
    expect(r.etatNonValide.parMotif.ETAT_NON_CONSTATE).toEqual({ km: 500, troncons: 5 });
    expect(r.longueurMetierAbsente.troncons).toBe(2);
    expect(r.troncons).toBe(37);
  });

  it("degradation par region : une part d'etat, PAS un score de priorite", () => {
    const d = s.degradationParRegion;
    expect(d.mention).toMatch(/PAS un score de priorité/);
    expect(d.regions.map((r) => [r.regionNom, r.partDegradeePct, r.eligibleKm, r.nonEvalueKm])).toEqual([["Boké", 30, 100, 100], ["Kindia", 20, 100, 0]]);
    expect(Object.keys(d.regions[0])).not.toContain("score");
    expect(Object.keys(s)).not.toContain("prioritesRegion");
  });

  it("fraicheur : dates et age de l'evaluation la plus recente des etats valides, sans verdict", () => {
    expect(s.fraicheur.calculeLe).toBe(MAINTENANT.toISOString());
    expect(s.fraicheur.derniereEvaluationLe).toBe("2026-10-01T00:00:00.000Z");
    expect(s.fraicheur.plusAncienneEvaluationLe).toBe("2025-01-01T00:00:00.000Z");
    expect(s.fraicheur.ageJours).toBe(25);
    expect(s.fraicheur.note).toMatch(/aucun seuil de fraîcheur n'est validé/);
  });

  it("couverture globale et perimetre : pays entier, jamais un reseau « national »", () => {
    expect(s.couverture).toMatchObject({ eligibleKm: 200, evalueKm: 700, nonEvalueKm: 100, partNonEvaluee: 0.125, tronconsTotal: 37, tronconsNonEvalues: 10, tronconsEtatNonValide: 5, tronconsSansLongueurMetier: 2 });
    expect(s.perimetre).toEqual({ national: true, libelle: "Ensemble du pays", regionId: null, regions: [] });
    // Les libelles de perimetre ne disent jamais « reseau national » (la definition peut le nier : « ce n'est pas... »).
    for (const k of s.kpis) expect(k.perimetre.libelle, k.code).not.toMatch(/r[eé]seau national/i);
  });

  it("qualite : comptes, familles non executees, couverture par region ; liens", () => {
    expect(s.qualite).toMatchObject({ etat: "DISPONIBLE", population: 37, total: 13, tronconsNonEvalues: 10, donneesAConfirmer: 13, lien: "/api/v2/aide-decision/qualite" });
    expect(s.qualite.couvertureParRegion.map((c) => [c.regionNom, c.tauxNonEvalues])).toEqual([["Boké", 0.3704], ["Kindia", 0]]);
  });

  it("les parametres PROVISOIRES et la mention consultative accompagnent la reponse", () => {
    expect(s.parametres).toMatchObject({ version: PARAMETRES_KPI.version, statutDefinition: "PROVISOIRE", classesDegradees: ["MAUVAIS", "CRITIQUE"], classesCritiques: ["CRITIQUE"], exigenceEtat: "OBSERVE_SEULEMENT" });
    expect(s.consultatif).toMatch(/non engageants/);
    expect(s.avertissements.at(-1)).toMatch(/non engageants/);
    expect(s.avertissements.join(" ")).toMatch(/PROVISOIRES/);
  });

  it("aucun total ne depasse un pourcentage de 100 et aucun nombre n'est NaN", () => {
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/NaN|Infinity|null%/);
    for (const k of s.kpis.filter((x) => x.unite === "%")) expect(k.valeur === null || (k.valeur >= 0 && k.valeur <= 100)).toBe(true);
  });
});

describe("rien n'est un zero quand c'est inconnu", () => {
  it("base vide : tous les indicateurs sont NON_DISPONIBLE, valeur null, aucun montant, aucun zero", async () => {
    const vide = depot({
      etat: async () => [],
      marches: async () => ({ marches: 0, sansMontant: 0, horsGnf: 0, gnfAvecMontant: 0, contractuelGnf: "0" }),
      decaisse: async () => ({ payes: 0, payeGnf: "0", payesSansDate: 0, payesRetenueGarantie: 0, emis: 0 }),
      parBailleur: async () => ({ totalBailleurs: 0, lignes: [] }),
      registre: async () => [
        evalue("chantiers_en_cours", null, { aucuneDonnee: true }), evalue("chantiers_en_retard", null, { aucuneDonnee: true }),
        evalue("longueur_geometrique_km", 0, { aucuneDonnee: true }), evalue("previsions_retenues_nb", 0), evalue("previsions_retenues_gnf", "0"),
      ],
      qualite: async () => fusionnerPassages([{ regionId: null, rapport: rapport(0, {}) }], NOMS, [], "x"),
    });
    const s = await composerSynthese(vide, ctx());
    for (const k of s.kpis) {
      expect(k.valeur, k.code).toBeNull();
      expect(k.etat, k.code).toBe("NON_DISPONIBLE");
      expect(k.avertissements.length, k.code).toBeGreaterThan(0);
    }
    for (const m of [s.budget.contractuel, s.budget.engage, s.budget.decaisse, s.budget.previsionnel]) {
      expect(m.etat).toBe("NON_DISPONIBLE");
      expect(m.valeurGnf).toBeNull();
      expect(m.avertissement).toBeTruthy();
    }
    expect(s.budget.parBailleur.etat).toBe("NON_DISPONIBLE");
    expect(s.budget.parBailleur.lignes).toEqual([]);
    expect(s.repartitionEtat.classes.every((c) => c.partPct === null)).toBe(true);
    expect(s.couverture.partNonEvaluee).toBeNull();
    expect(s.fraicheur.ageJours).toBeNull();
    expect(s.degradationParRegion.regions).toEqual([]);
  });

  it("tout non evalue : taux nuls, part non evaluee 1, le reste est dit", async () => {
    const s = await composerSynthese(depot({ etat: async () => [L({ etat: "NON_EVALUE", provenance: "UNKNOWN", nb: 20, km: 400 })] }), ctx());
    expect(kpi(s, "reseau_degrade_pct")).toMatchObject({ valeur: null, etat: "NON_DISPONIBLE" });
    expect(kpi(s, "reseau_critique_km").valeur).toBeNull();
    expect(kpi(s, "couverture_etat_part").valeur).toBe(0);
    expect(kpi(s, "longueur_reseau_reference_km").valeur).toBe(400);
    expect(s.couverture.partNonEvaluee).toBe(1);
  });

  it("aucune longueur metier connue : longueur de reference inconnue, pas 0", async () => {
    const s = await composerSynthese(depot({ etat: async () => [L({ longueurConnue: false, nb: 12, km: 0 })] }), ctx());
    expect(kpi(s, "longueur_reseau_reference_km")).toMatchObject({ valeur: null, etat: "NON_DISPONIBLE" });
    expect(kpi(s, "reseau_degrade_pct").valeur).toBeNull();
    expect(kpi(s, "couverture_etat_part")).toMatchObject({ valeur: null, etat: "NON_DISPONIBLE" });
  });

  it("des chantiers au registre mais aucun en cours : 0 est un vrai compte (la source n'est pas vide)", async () => {
    const s = await composerSynthese(depot({ registre: async () => [evalue("chantiers_en_cours", 0), evalue("chantiers_en_retard", 0)] }), ctx());
    expect(kpi(s, "chantiers_en_cours")).toMatchObject({ valeur: 0, etat: "DISPONIBLE" });
  });

  it("une longueur geometrique nulle alors que des troncons existent est dite inconnue, pas 0 km", async () => {
    const s = await composerSynthese(depot({ registre: async () => [evalue("longueur_geometrique_km", 0, { unite: "km" }), evalue("chantiers_en_cours", 1), evalue("chantiers_en_retard", 0)] }), ctx());
    expect(kpi(s, "longueur_geometrique_km")).toMatchObject({ valeur: null, etat: "NON_DISPONIBLE" });
    expect(kpi(s, "longueur_geometrique_km").avertissements[0]).toMatch(/inconnue, pas nulle/);
  });
});

describe("chantiers en retard : ce que la regle ne sait pas", () => {
  it("des chantiers en cours sans date de fin prevue : retard non juge, etat PARTIEL et nombre rendu", async () => {
    const s = await composerSynthese(depot({ chantiersSansEcheance: async () => 3 }), ctx());
    const k = kpi(s, "chantiers_en_retard");
    expect(k.etat).toBe("PARTIEL");
    expect(k.avertissements.join(" ")).toMatch(/3 chantiers en cours sans date de fin prévue/);
  });
  it("lecture du nombre en echec : PARTIEL, et dit", async () => {
    const s = await composerSynthese(depot({ chantiersSansEcheance: async () => { throw new Error("x"); } }), ctx());
    expect(kpi(s, "chantiers_en_retard").etat).toBe("PARTIEL");
    expect(kpi(s, "chantiers_en_retard").avertissements.join(" ")).toMatch(/n'a pas pu être lu/);
  });
});

describe("droits financiers", () => {
  it("sans le module marches : montants non communiques (NON_AUTORISE), jamais un zero ; les comptages restent", async () => {
    const s = await composerSynthese(depot(), ctx({ droits: { marches: false, programmation: true } }));
    expect(s.budget.contractuel).toMatchObject({ etat: "NON_AUTORISE", valeurGnf: null });
    expect(s.budget.decaisse).toMatchObject({ etat: "NON_AUTORISE", valeurGnf: null });
    expect(s.budget.parBailleur).toMatchObject({ etat: "NON_AUTORISE", lignes: [] });
    expect(s.budget.previsionnel.etat).toBe("DISPONIBLE");
    expect(kpi(s, "budget_contractuel_gnf")).toMatchObject({ etat: "NON_DISPONIBLE", valeur: null, valeurTexte: null });
    expect(JSON.stringify(s)).not.toContain("9007199254740993");
    expect(kpi(s, "marches_recenses").valeur).toBe(4);
  });
  it("sans le module programmation : previsionnel non communique", async () => {
    const s = await composerSynthese(depot(), ctx({ droits: { marches: true, programmation: false } }));
    expect(s.budget.previsionnel).toMatchObject({ etat: "NON_AUTORISE", valeurGnf: null });
    expect(JSON.stringify(s)).not.toContain('"777"');
  });
});

describe("perimetre regional", () => {
  it("une region : le libelle la nomme, les lectures recoivent SA region, les montants sont PARTIEL et expliques", async () => {
    const d = depot();
    const s = await composerSynthese(d, ctx({ regions: [1] }));
    expect(s.perimetre).toMatchObject({ national: false, libelle: "Région Boké", regionId: 1 });
    for (const nom of ["etat", "marches", "decaisse", "parBailleur", "sansEcheance"]) expect(d.appels[nom][0][0]).toEqual([1]);
    expect(d.appels.registre[0][1]).toEqual([1]);
    expect(d.appels.qualite[0][0]).toEqual([1]);
    expect(d.appels.qualite[0][2]).toBe(FAMILLES_SYNTHESE);
    expect(kpi(s, "reseau_degrade_pct").perimetre).toEqual({ libelle: "Région Boké : réseau classé saisi", regionId: 1 });
    expect(kpi(s, "reseau_degrade_pct").ouvre.filtres.regionId).toBe(1);
    expect(s.budget.contractuel.etat).toBe("PARTIEL");
    expect(s.budget.contractuel.avertissement).toMatch(/Un marché n'a pas de région propre/);
    expect(s.budget.decaisse.etat).toBe("PARTIEL");
    expect(s.budget.previsionnel.etat).toBe("PARTIEL");
    expect(kpi(s, "marches_recenses").etat).toBe("PARTIEL");
    expect(s.avertissements[0]).toMatch(/Périmètre limité à votre compte : Région Boké\. Aucun total national n'est communiqué\./);
  });

  it("plusieurs regions : jamais « pays », regionId nul", async () => {
    const s = await composerSynthese(depot(), ctx({ regions: [2, 1] }));
    expect(s.perimetre.libelle).toBe("Régions du périmètre : Boké, Kindia");
    expect(s.perimetre.regionId).toBeNull();
    expect(kpi(s, "reseau_degrade_pct").perimetre.libelle).not.toMatch(/pays/i);
  });
});

describe("filtres", () => {
  it("la classe est transmise aux lectures de troncons, rendue dans les filtres appliques, et la longueur geometrique devient NON_DISPONIBLE", async () => {
    const d = depot();
    const s = await composerSynthese(d, ctx({ filtres: { classe: ["RN"] } }));
    expect(d.appels.etat[0][1]).toEqual(["RN"]);
    expect(s.filtres.appliques).toEqual({ classe: ["RN"] });
    expect(kpi(s, "longueur_geometrique_km")).toMatchObject({ valeur: null, etat: "NON_DISPONIBLE" });
    expect(kpi(s, "longueur_geometrique_km").avertissements[0]).toMatch(/Non ventilée par classe/);
    expect(kpi(s, "reseau_degrade_pct").perimetre.libelle).toMatch(/classes RN/);
    expect(kpi(s, "reseau_degrade_pct").ouvre.filtres.classe).toEqual(["RN"]);
    expect(kpi(s, "chantiers_en_cours").ouvre.filtres.classe).toBeUndefined();
    expect(s.avertissements.join(" ")).toMatch(/ne qualifie ni les chantiers, ni les marchés/);
  });

  it("les filtres non appliques sont dits, jamais ignores en silence", async () => {
    const s = await composerSynthese(depot(), ctx({ filtres: { etat: ["BON"], statutChantier: ["EN_COURS"], depuis: "2026-01-01" } }));
    expect(s.filtres.nonAppliques.map((f) => f.nom)).toEqual(["etat", "statutChantier", "periode"]);
    expect(s.avertissements.filter((a) => /^Non appliqué/.test(a))).toHaveLength(3);
    expect(kpi(s, "reseau_degrade_pct").valeur).toBe(25); // le filtre « etat » ne fausse pas le taux
  });
});

describe("parametres", () => {
  it("la regle d'etat valide est un parametre : NON_CONTESTE accepte l'importe non verifie et change le taux", async () => {
    const p: ParametresKpi = { ...PARAMETRES_KPI, exigenceEtat: "NON_CONTESTE" };
    const s = await composerSynthese(depot(), ctx({ parametres: p }));
    expect(s.parametres.exigenceEtat).toBe("NON_CONTESTE");
    // eligible = 200 + 500 (critiques importes) ; degrade = 50 + 500
    expect(kpi(s, "reseau_degrade_pct").valeur).toBe(78.6);
  });
  it("les classes degradees sont un parametre", async () => {
    const p: ParametresKpi = { ...PARAMETRES_KPI, classesDegradees: ["CRITIQUE"] };
    const s = await composerSynthese(depot(), ctx({ parametres: p }));
    expect(kpi(s, "reseau_degrade_pct").valeur).toBe(10);
    expect(s.parametres.classesDegradees).toEqual(["CRITIQUE"]);
  });
});

describe("bailleurs : limite explicite", () => {
  it("au-dela de la limite : tronque dit, total rendu, autres agreges avec la somme qui reste", async () => {
    const s = await composerSynthese(depot({
      parBailleur: async () => ({ totalBailleurs: 30, lignes: [{ bailleurId: 1, nom: "A", marches: 3, sansMontant: 0, horsGnf: 0, avecMontantGnf: 3, contractuelGnf: "400", decaisseGnf: null }] }),
      marches: async () => ({ marches: 10, sansMontant: 0, horsGnf: 0, gnfAvecMontant: 10, contractuelGnf: "1000" }),
    }), ctx());
    const p = s.budget.parBailleur;
    expect(p.tronque).toBe(true);
    expect(p.totalBailleurs).toBe(30);
    expect(p.limite).toBe(PARAMETRES_KPI.limiteBailleurs);
    expect(p.message).toMatch(/Liste limitée aux 20 bailleurs aux plus gros montants contractuels sur 30 : 29 autres bailleurs sont agrégés/);
    expect(p.autres).toEqual({ bailleurs: 29, marches: 7, contractuelGnf: "600" });
    expect(p.etat).toBe("PARTIEL");
  });
});

describe("bailleurs : un contractuel inconnu n'est pas zero (revue : \"0\" pour un bailleur sans aucun montant)", () => {
  const sansMontant = { bailleurId: 7, nom: "B sans montant", marches: 2, sansMontant: 1, horsGnf: 1, avecMontantGnf: 0, contractuelGnf: null, decaisseGnf: null };

  it("la ligne d'un bailleur sans aucun montant GNF rend contractuelGnf = null (comme le total global NON_DISPONIBLE), avec le nombre de marches avec montant", async () => {
    const s = await composerSynthese(depot({
      parBailleur: async () => ({ totalBailleurs: 2, lignes: [
        { bailleurId: 5, nom: "Bailleur A", marches: 2, sansMontant: 0, horsGnf: 0, avecMontantGnf: 2, contractuelGnf: "400", decaisseGnf: null }, sansMontant,
      ] }),
      marches: async () => ({ marches: 4, sansMontant: 1, horsGnf: 1, gnfAvecMontant: 2, contractuelGnf: "400" }),
    }), ctx());
    const p = s.budget.parBailleur;
    expect(p.lignes[0]).toMatchObject({ contractuelGnf: "400", marchesAvecMontantGnf: 2 });
    expect(p.lignes[1]).toMatchObject({ bailleur: "B sans montant", contractuelGnf: null, marchesAvecMontantGnf: 0 });
    expect(JSON.stringify(p.lignes[1])).not.toMatch(/"contractuelGnf":"0"/);
  });

  it("« autres » : montant inconnu (null) quand aucun des marches regroupes n'a de montant GNF, somme restante sinon", async () => {
    const lignes = [{ bailleurId: 1, nom: "A", marches: 3, sansMontant: 0, horsGnf: 0, avecMontantGnf: 3, contractuelGnf: "400", decaisseGnf: null }];
    const inconnu = await composerSynthese(depot({
      parBailleur: async () => ({ totalBailleurs: 30, lignes }),
      marches: async () => ({ marches: 10, sansMontant: 7, horsGnf: 0, gnfAvecMontant: 3, contractuelGnf: "400" }),
    }), ctx());
    expect(inconnu.budget.parBailleur.autres).toEqual({ bailleurs: 29, marches: 7, contractuelGnf: null });
    const connu = await composerSynthese(depot({
      parBailleur: async () => ({ totalBailleurs: 30, lignes }),
      marches: async () => ({ marches: 10, sansMontant: 0, horsGnf: 0, gnfAvecMontant: 10, contractuelGnf: "1000" }),
    }), ctx());
    expect(connu.budget.parBailleur.autres).toEqual({ bailleurs: 29, marches: 7, contractuelGnf: "600" });
  });

  it("le total des bailleurs sans montant n'est pas \"0\" : un bailleur au contractuel inconnu ne fausse pas la somme des autres", async () => {
    const s = await composerSynthese(depot({
      parBailleur: async () => ({ totalBailleurs: 30, lignes: [sansMontant, { bailleurId: 1, nom: "A", marches: 3, sansMontant: 0, horsGnf: 0, avecMontantGnf: 3, contractuelGnf: "400", decaisseGnf: null }] }),
      marches: async () => ({ marches: 10, sansMontant: 2, horsGnf: 0, gnfAvecMontant: 8, contractuelGnf: "1000" }),
    }), ctx());
    expect(s.budget.parBailleur.autres).toMatchObject({ marches: 5, contractuelGnf: "600" });
  });
});

describe("incidents : un bloc degrade, jamais un faux chiffre", () => {
  it("le registre en echec : chantiers, longueur geometrique et previsionnel sont NON_DISPONIBLE ; le reseau reste calcule", async () => {
    const s = await composerSynthese(depot({ registre: async () => { throw new Error("boom"); } }), ctx());
    for (const c of ["chantiers_en_cours", "chantiers_en_retard", "longueur_geometrique_km"]) expect(kpi(s, c)).toMatchObject({ valeur: null, etat: "NON_DISPONIBLE" });
    expect(s.budget.previsionnel).toMatchObject({ etat: "NON_DISPONIBLE", valeurGnf: null });
    expect(kpi(s, "reseau_degrade_pct").valeur).toBe(25);
    expect(s.avertissements.join(" ")).toMatch(/registre d'indicateurs n'a pas pu être lu/);
  });

  it("les detecteurs en echec : donnees a confirmer inconnues, qualite NON_DISPONIBLE, jamais le seul compte de non evalues", async () => {
    const s = await composerSynthese(depot({ qualite: async () => { throw new Error("boom"); } }), ctx());
    expect(kpi(s, "donnees_a_confirmer")).toMatchObject({ valeur: null, etat: "NON_DISPONIBLE" });
    expect(s.qualite).toMatchObject({ etat: "NON_DISPONIBLE", total: null, donneesAConfirmer: null, tronconsNonEvalues: 10 });
  });

  it("les marches en echec : contractuel, decaisse et bailleurs NON_DISPONIBLE, marches recenses inconnu", async () => {
    const e = async () => { throw new Error("boom"); };
    const s = await composerSynthese(depot({ marches: e, decaisse: e, parBailleur: e }), ctx());
    expect(s.budget.contractuel).toMatchObject({ etat: "NON_DISPONIBLE", valeurGnf: null });
    expect(s.budget.decaisse).toMatchObject({ etat: "NON_DISPONIBLE", valeurGnf: null });
    expect(s.budget.parBailleur.etat).toBe("NON_DISPONIBLE");
    expect(kpi(s, "marches_recenses")).toMatchObject({ valeur: null, etat: "NON_DISPONIBLE" });
  });

  it("la lecture de l'etat du reseau en echec fait echouer l'appel (pas de synthese sans reseau)", async () => {
    await expect(composerSynthese(depot({ etat: async () => { throw new Error("boom"); } }), ctx())).rejects.toThrow("boom");
  });
});

describe("stabilite de la reponse", () => {
  it("deux calculs sur les memes donnees rendent exactement la meme reponse, serialisable (aucun BigInt)", async () => {
    const a = await composerSynthese(depot(), ctx());
    const b = await composerSynthese(depot(), ctx());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(() => JSON.stringify(a)).not.toThrow();
  });

  it("l'ordre des regions et des classes ne depend pas de l'ordre des lignes lues", async () => {
    const a = await composerSynthese(depot(), ctx());
    const b = await composerSynthese(depot({ etat: async () => [...LIGNES].reverse() }), ctx());
    expect(b.degradationParRegion).toEqual(a.degradationParRegion);
    expect(b.repartitionEtat).toEqual(a.repartitionEtat);
    expect(b.kpis.map((k) => k.valeur)).toEqual(a.kpis.map((k) => k.valeur));
  });
});
