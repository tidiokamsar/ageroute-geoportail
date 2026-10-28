import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonique, sha256Hex } from "./canonique";
import { construireScenario, entreesDepuisJson, entreesVersJson, validerEntrees, type EntreesScenario, type LigneScenario, type Scenario } from "./scenario.noyau";
import { BAREMES, candidat, candidatsDeBase } from "./scenario.fixtures";
import { entreesSimulation, optionsDeBase, versionDesBaremes } from "./contraintes.fixtures";
import { optionsDepuisJson, optionsVersJson, validerOptions } from "./contraintes.noyau";
import { motifPeremption, refDe, verifierVersionBaremes, versionBaremes, jourValide } from "./comparaison.baremes.noyau";

/**
 * Simulateur : contraintes, equilibre territorial, logiques, version des baremes. Valeurs posees a la main sur
 * `scenario.fixtures.ts` : RN-C (region 1) 800 M, RN-A (region 1) 4 400 M, RN-B (region 2) 3 500 M ; ordre du ratio C, A, B.
 */
function sim(e: EntreesScenario): Scenario {
  const r = construireScenario(e);
  if (!r.ok) throw new Error(r.erreurs.join(" ; "));
  return r.scenario;
}
const ligne = (s: Scenario, code: string): LigneScenario => s.lignes.find((l) => l.troncon.code === code)!;
const decisions = (s: Scenario) => Object.fromEntries(s.lignes.map((l) => [l.troncon.code, l.decision === "RETENUE" ? "R" : l.motifExclusion!.code]));
const codesInsat = (s: Scenario) => s.simulation!.contraintes.insatisfaisables.map((c) => c.code);

describe("noyaux du simulateur : imports", () => {
  const imports = (f: string) => [...readFileSync(join(__dirname, f), "utf8").matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]).sort();
  it("contraintes.noyau et comparaison.baremes.noyau n'importent que des noyaux purs", () => {
    expect(imports("contraintes.noyau.ts")).toEqual(["../engines/cout.noyau", "./comparaison.baremes.noyau", "./logiques.noyau"].sort());
    expect(imports("comparaison.baremes.noyau.ts")).toEqual(["../engines/cout.noyau", "./canonique"].sort());
    for (const f of ["contraintes.noyau.ts", "comparaison.baremes.noyau.ts"]) for (const i of imports(f)) expect(i).not.toMatch(/prisma|express|zod|lib\/|utils\/|middleware/);
  });
});

describe("Logiques de bout en bout (enveloppe 8 Md)", () => {
  const e = (logique: string, extra: Partial<EntreesScenario["simulation"]> = {}) => entreesSimulation({ budgetGnf: 8_000_000_000n }, { logique: logique as never, ...extra });

  it("ratio_cout_impact : C puis A (5,2 Md) ; B (3,5 Md) ne tient pas dans les 2,8 Md restants", () => {
    const s = sim(e("ratio_cout_impact"));
    expect(decisions(s)).toEqual({ "RN-C": "R", "RN-A": "R", "RN-B": "BUDGET_INSUFFISANT" });
    expect(s.lignes.map((l) => l.simulation!.ordreArbitrage)).toEqual([1, 2, 3]);
    expect(s.lignes.map((l) => l.troncon.code)).toEqual(["RN-C", "RN-A", "RN-B"]);
  });

  it("urgence : l'etat CRITIQUE (B) puis MAUVAIS (A) ; C (MOYEN) ne tient plus. Le resultat differe du ratio", () => {
    const s = sim(e("urgence"));
    expect(s.lignes.map((l) => l.troncon.code)).toEqual(["RN-B", "RN-A", "RN-C"]);
    expect(decisions(s)).toEqual({ "RN-B": "R", "RN-A": "R", "RN-C": "BUDGET_INSUFFISANT" });
    expect(s.simulation!.bilan.consommeGnf).toBe("7900000000");
    expect(s.simulation!.logique).toMatchObject({ code: "urgence", provisoire: true });
    expect(s.simulation!.avertissements.map((a) => a.code)).toContain("LOGIQUE_PROVISOIRE");
    expect(s.provisoire).toBe(true);
    expect(s.motifsProvisoire.join(" ")).toMatch(/Urgence/);
  });

  it("criticite : le risque courant le plus haut d'abord (A 60,625 puis B 48,75 puis C 24,375)", () => {
    const s = sim(e("criticite"));
    expect(s.lignes.map((l) => l.troncon.code)).toEqual(["RN-A", "RN-B", "RN-C"]);
    expect(decisions(s)).toEqual({ "RN-A": "R", "RN-B": "R", "RN-C": "BUDGET_INSUFFISANT" });
  });

  it("personnalise : la liste [B, A, C] est suivie ; un identifiant inconnu, un doublon ou une liste hors logique sont refuses", () => {
    const ok = sim(e("personnalise", { ordrePersonnalise: ["b", "a", "c"] }));
    expect(ok.lignes.map((l) => l.troncon.code)).toEqual(["RN-B", "RN-A", "RN-C"]);
    expect(ok.simulation!.logique.ordrePersonnalise).toEqual(["b", "a", "c"]);
    expect(decisions(ok)).toEqual({ "RN-B": "R", "RN-A": "R", "RN-C": "BUDGET_INSUFFISANT" });
    const refus = (o: Partial<EntreesScenario["simulation"]>, motif: RegExp) => {
      const r = construireScenario(e("personnalise", o));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.erreurs.join(" ")).toMatch(motif);
    };
    refus({ ordrePersonnalise: ["b", "inconnu"] }, /ne sont pas des candidats/);
    refus({ ordrePersonnalise: ["b", "b"] }, /en double/);
    refus({ ordrePersonnalise: [] }, /exige une liste/);
    const horsLogique = construireScenario(e("ratio_cout_impact", { ordrePersonnalise: ["a"] }));
    expect(horsLogique.ok).toBe(false);
  });

  it("une logique inconnue est refusee", () => {
    const r = construireScenario(e("au_hasard"));
    expect(r.ok).toBe(false);
  });

  it("priorite technique et ordre d'arbitrage sont separes : A est le plus prioritaire techniquement mais arrive 2e a l'arbitrage", () => {
    const s = sim(e("ratio_cout_impact"));
    const rang = (c: string) => [ligne(s, c).simulation!.prioriteTechnique.rang, ligne(s, c).simulation!.ordreArbitrage];
    expect(rang("RN-A")).toEqual([1, 2]);
    expect(rang("RN-B")).toEqual([2, 3]);
    expect(rang("RN-C")).toEqual([3, 1]);
    expect(ligne(s, "RN-A").simulation!.prioriteTechnique.source).toBe("moteur_v2_risque_courant");
    expect(s.simulation!.rangsTechniquesSource).toBe("moteur_v2_risque_courant");
  });

  it("interface du lot 3 : ses rangs sont affiches a cote, ils ne changent PAS l'ordre d'arbitrage", () => {
    const sans = sim(e("ratio_cout_impact"));
    const avec = sim(e("ratio_cout_impact", { rangsTechniques: { a: 5, b: 1 } }));
    expect(avec.lignes.map((l) => l.troncon.code)).toEqual(sans.lignes.map((l) => l.troncon.code));
    expect(ligne(avec, "RN-A").simulation!.prioriteTechnique).toEqual({ rang: 5, source: "lot3_priorite_technique" });
    expect(ligne(avec, "RN-B").simulation!.prioriteTechnique.rang).toBe(1);
    expect(ligne(avec, "RN-C").simulation!.prioriteTechnique.rang).toBeNull(); // pas de rang fourni : absent, pas invente
    expect(avec.simulation!.rangsTechniquesSource).toBe("lot3_priorite_technique");
  });
});

describe("Interventions obligatoires : jamais de coup de pouce silencieux", () => {
  const e = (budgetGnf: bigint, obligatoires: string[], extra: Partial<EntreesScenario> = {}) => entreesSimulation({ budgetGnf, ...extra }, { obligatoires });

  it("une obligatoire est financee AVANT l'ordre du ratio : enveloppe 5 Md, A obligatoire (4,4 Md) ; C (0,8 Md) ne tient plus", () => {
    const s = sim(e(5_000_000_000n, ["a"]));
    expect(decisions(s)).toEqual({ "RN-A": "R", "RN-C": "BUDGET_INSUFFISANT", "RN-B": "BUDGET_INSUFFISANT" });
    expect(ligne(s, "RN-A").simulation).toMatchObject({ phase: "OBLIGATOIRE", obligatoire: true });
    expect(s.simulation!.contraintes.obligatoires).toMatchObject({ demandees: ["a"], retenues: ["a"], nonRetenues: [] });
    expect(s.simulation!.contraintes.insatisfaisables).toEqual([]);
  });

  it("obligatoire hors enveloppe (A 4,4 Md pour 4 Md) : NON retenue, contrainte insatisfaisable rendue, enveloppe jamais depassee", () => {
    const s = sim(e(4_000_000_000n, ["a"]));
    expect(ligne(s, "RN-A").decision).toBe("ECARTEE");
    expect(ligne(s, "RN-A").motifExclusion?.code).toBe("BUDGET_INSUFFISANT");
    expect(codesInsat(s)).toEqual(["OBLIGATOIRE_NON_FINANCEE"]);
    expect(s.simulation!.contraintes.insatisfaisables[0]).toMatchObject({ portee: "TRONCON", reference: "a" });
    expect(s.simulation!.contraintes.insatisfaisables[0].detail).toMatch(/pas ajusté/);
    expect(BigInt(s.totaux.engageGnf)).toBeLessThanOrEqual(4_000_000_000n);
    // le cout n'a pas ete raccourci pour la faire tenir
    expect(ligne(s, "RN-A").cout).toMatchObject({ ok: true, montantGnf: "4400000000" });
    expect(s.simulation!.avertissements.map((a) => a.code)).toContain("CONTRAINTES_INSATISFAISABLES");
    expect(s.simulation!.bilan.deficitObligatoiresGnf).toBe("400000000");
  });

  it("obligatoire sans cout (barème absent) : rendue OBLIGATOIRE_NON_CHIFFRABLE avec la vraie cause, aucun cout invente", () => {
    const baremes = BAREMES.filter((b) => b.typeIntervention !== "reconstruction");
    const s = sim(e(10_000_000_000n, ["b"], { baremes }));
    expect(codesInsat(s)).toEqual(["OBLIGATOIRE_NON_CHIFFRABLE"]);
    expect(s.simulation!.contraintes.insatisfaisables[0].detail).toMatch(/COUT_NON_ESTIMABLE/);
    expect(ligne(s, "RN-B").motifExclusion?.code).toBe("COUT_NON_ESTIMABLE");
    expect(s.simulation!.contraintes.obligatoires.nonRetenues).toEqual(["b"]);
  });

  it("obligatoire au cout perime : rendue OBLIGATOIRE_NON_CHIFFRABLE (COUT_PERIME)", () => {
    const options = optionsDeBase({ obligatoires: ["a"], baremes: versionDesBaremes(BAREMES, { "2": [null, "2027-06-30"] }) });
    const s = sim({ ...entreesSimulation(), simulation: options });
    expect(codesInsat(s)).toEqual(["OBLIGATOIRE_NON_CHIFFRABLE"]);
    expect(s.simulation!.contraintes.insatisfaisables[0].detail).toMatch(/COUT_PERIME/);
  });

  it("obligatoire absente des candidats : OBLIGATOIRE_HORS_CANDIDATS (pas une erreur de saisie silencieuse)", () => {
    const s = sim(e(10_000_000_000n, ["fantome"]));
    expect(codesInsat(s)).toEqual(["OBLIGATOIRE_HORS_CANDIDATS"]);
    expect(s.totaux.retenues).toBe(3);
  });

  it("obligatoire bloquee par le plafond regional de sa region : OBLIGATOIRE_NON_FINANCEE (PLAFOND_REGIONAL)", () => {
    const s = sim(e(10_000_000_000n, ["a"], { plafondsRegionauxGnf: { "1": 4_000_000_000n } }));
    expect(ligne(s, "RN-A").motifExclusion?.code).toBe("PLAFOND_REGIONAL");
    expect(codesInsat(s)).toEqual(["OBLIGATOIRE_NON_FINANCEE"]);
  });

  it("deux obligatoires dont la somme depasse l'enveloppe : la premiere (ordre du ratio) est financee, l'autre est rendue insatisfaisable", () => {
    const s = sim(e(5_000_000_000n, ["a", "b"]));
    expect(decisions(s)).toMatchObject({ "RN-A": "R", "RN-B": "BUDGET_INSUFFISANT" });
    expect(s.simulation!.contraintes.insatisfaisables.map((c) => c.reference)).toEqual(["b"]);
  });

  it("doublon dans les obligatoires : refuse", () => {
    const r = construireScenario(e(1n, ["a", "a"]));
    expect(r.ok).toBe(false);
  });
});

describe("Couts non divisibles : un groupe se finance entier ou pas du tout", () => {
  const e = (budgetGnf: bigint, groupes: string[][], extra: Partial<EntreesScenario> = {}, obligatoires: string[] = []) =>
    entreesSimulation({ budgetGnf, ...extra }, { groupesNonDivisibles: groupes, obligatoires });

  it("groupe [A, C] (5,2 Md) pour 5 Md : le groupe est ecarte EN ENTIER, C n'est pas retenue seule alors qu'elle tiendrait ; B (3,5 Md) l'est", () => {
    const s = sim(e(5_000_000_000n, [["a", "c"]]));
    expect(decisions(s)).toEqual({ "RN-C": "BUDGET_INSUFFISANT", "RN-A": "BUDGET_INSUFFISANT", "RN-B": "R" });
    expect(ligne(s, "RN-C").motifExclusion?.detail).toMatch(/groupe non divisible n°1.*coût total 5200000000/);
    expect(ligne(s, "RN-C").simulation!.groupe).toBe(1);
    expect(s.simulation!.contraintes.groupesNonDivisibles).toEqual([
      { numero: 1, membres: ["a", "c"], retenu: false, coutGnf: "5200000000", motif: expect.objectContaining({ code: "BUDGET_INSUFFISANT" }) },
    ]);
  });

  it("le meme groupe pour 8,7 Md : retenu entier, somme des couts des membres", () => {
    const s = sim(e(8_700_000_000n, [["a", "c"]]));
    expect(s.totaux.retenues).toBe(3);
    expect(s.simulation!.contraintes.groupesNonDivisibles[0]).toMatchObject({ retenu: true, coutGnf: "5200000000", motif: null });
    expect(ligne(s, "RN-A").simulation!.groupe).toBe(1);
  });

  it("un membre non chiffrable (B sans barème) ecarte tout le groupe [B, A] : EXCLUE_CONTRAINTE, sans coup de pouce", () => {
    const baremes = BAREMES.filter((b) => b.typeIntervention !== "reconstruction");
    const s = sim(e(10_000_000_000n, [["a", "b"]], { baremes }));
    expect(ligne(s, "RN-A").motifExclusion?.code).toBe("EXCLUE_CONTRAINTE");
    expect(ligne(s, "RN-A").motifExclusion?.detail).toMatch(/RN-B écarté \(COUT_NON_ESTIMABLE\)/);
    expect(ligne(s, "RN-C").decision).toBe("RETENUE");
    expect(s.simulation!.contraintes.groupesNonDivisibles[0].retenu).toBe(false);
    expect(codesInsat(s)).toEqual([]); // ecarter un groupe incomplet respecte la contrainte (tout ou rien)
  });

  it("un membre absent des candidats ecarte le groupe (EXCLUE_CONTRAINTE)", () => {
    const s = sim(e(10_000_000_000n, [["a", "fantome"]]));
    expect(ligne(s, "RN-A").motifExclusion?.code).toBe("EXCLUE_CONTRAINTE");
    expect(ligne(s, "RN-A").motifExclusion?.detail).toMatch(/fantome absent des candidats/);
  });

  it("un groupe qui contient une obligatoire est obligatoire en entier ; impossible => GROUPE_OBLIGATOIRE_IMPOSSIBLE", () => {
    const ok = sim(e(10_000_000_000n, [["a", "c"]], {}, ["c"]));
    expect(ligne(ok, "RN-A").simulation).toMatchObject({ phase: "OBLIGATOIRE", obligatoire: true });
    expect(ok.simulation!.contraintes.obligatoires.effectives).toEqual(["a", "c"]);
    const baremes = BAREMES.filter((b) => b.typeIntervention !== "reconstruction");
    const ko = sim(e(10_000_000_000n, [["a", "b"]], { baremes }, ["a"]));
    expect(codesInsat(ko)).toEqual(["GROUPE_OBLIGATOIRE_IMPOSSIBLE"]);
  });

  it("obligatoire dans un groupe trop cher : OBLIGATOIRE_NON_FINANCEE", () => {
    const s = sim(e(5_000_000_000n, [["a", "c"]], {}, ["c"]));
    expect(codesInsat(s)).toEqual(["OBLIGATOIRE_NON_FINANCEE"]);
    expect(decisions(s)["RN-B"]).toBe("R");
  });

  it("un groupe d'un seul troncon, ou deux groupes qui partagent un troncon, sont refuses", () => {
    expect(construireScenario(e(1n, [["a"]])).ok).toBe(false);
    expect(construireScenario(e(1n, [["a", "b"], ["b", "c"]])).ok).toBe(false);
  });

  it("le plafond regional s'applique a la somme du groupe", () => {
    const s = sim(e(10_000_000_000n, [["a", "c"]], { plafondsRegionauxGnf: { "1": 5_000_000_000n } }));
    expect(ligne(s, "RN-A").motifExclusion?.code).toBe("PLAFOND_REGIONAL");
    expect(ligne(s, "RN-C").motifExclusion?.code).toBe("PLAFOND_REGIONAL");
  });
});

describe("Plafonds regionaux", () => {
  it("le plafond de la region 1 (3 Md) retient C (0,8) mais ecarte A (4,4) ; B (region 2) n'est pas concernee", () => {
    const s = sim(entreesSimulation({ plafondsRegionauxGnf: { "1": 3_000_000_000n } }));
    expect(decisions(s)).toEqual({ "RN-C": "R", "RN-A": "PLAFOND_REGIONAL", "RN-B": "R" });
    expect(s.totaux.engageParRegionGnf).toEqual({ "1": "800000000", "2": "3500000000" });
    expect(s.simulation!.contraintes.plafondsRegionauxGnf).toEqual({ "1": "3000000000" });
  });
});

describe("Equilibre territorial : plancher de depense par region, regle explicite", () => {
  // Region 1 : deux troncons identiques (1,1 Md chacun) ; region 2 : un troncon moins risque (1,1 Md).
  const params = { etat: "MAUVAIS" as const, nbPointsNoirs: 2, longueurM: 1000 };
  const R1A = candidat("r1a", { code: "R1A", regionId: 1, traficMoyenJma: 2500, ...params });
  const R1B = candidat("r1b", { code: "R1B", regionId: 1, traficMoyenJma: 2500, ...params });
  const R2A = candidat("r2a", { code: "R2A", regionId: 2, traficMoyenJma: 100, ...params, nbPointsNoirs: 0 });
  const e = (budgetGnf: bigint, pct: number | null, candidats = [R1A, R1B, R2A]) =>
    entreesSimulation({ budgetGnf, candidats }, pct === null ? { logique: "ratio_cout_impact" } : { logique: "equilibre_territorial", equilibre: { partMinimaleParRegionPct: pct } });

  it("sans equilibre (ratio) : la region 1 prend tout (R1A, R1B) et la region 2 n'a rien", () => {
    const s = sim(e(2_200_000_000n, null));
    expect(decisions(s)).toEqual({ R1A: "R", R1B: "R", R2A: "BUDGET_INSUFFISANT" });
  });

  it("avec equilibre 40 % (plancher 880 M par region) : R1A atteint le plancher de la region 1, R2A garantit la region 2 ; R1B cede", () => {
    const s = sim(e(2_200_000_000n, 40));
    expect(decisions(s)).toEqual({ R1A: "R", R1B: "BUDGET_INSUFFISANT", R2A: "R" });
    expect(ligne(s, "R1A").simulation!.phase).toBe("PLANCHER_REGIONAL");
    expect(ligne(s, "R2A").simulation!.phase).toBe("PLANCHER_REGIONAL");
    expect(s.simulation!.contraintes.equilibre).toEqual([
      { regionId: 1, plancherGnf: "880000000", depenseGnf: "1100000000", atteint: true },
      { regionId: 2, plancherGnf: "880000000", depenseGnf: "1100000000", atteint: true },
    ]);
    expect(codesInsat(s)).toEqual([]);
    // le plancher peut etre depasse : un cout ne se divise pas (1,1 Md > 0,88 Md)
    expect(s.totaux.engageParRegionGnf).toEqual({ "1": "1100000000", "2": "1100000000" });
  });

  it("plancher NON atteint (enveloppe epuisee par la region 1) : rendu EQUILIBRE_NON_ATTEINT, jamais comble en silence", () => {
    const s = sim(e(1_500_000_000n, 40));
    expect(decisions(s)).toEqual({ R1A: "R", R1B: "BUDGET_INSUFFISANT", R2A: "BUDGET_INSUFFISANT" });
    expect(codesInsat(s)).toEqual(["EQUILIBRE_NON_ATTEINT"]);
    expect(s.simulation!.contraintes.insatisfaisables[0]).toMatchObject({ portee: "REGION", reference: "2" });
    expect(s.simulation!.contraintes.equilibre![1]).toMatchObject({ regionId: 2, depenseGnf: "0", atteint: false });
  });

  it("region sans candidat chiffrable (etat non evalue) : EQUILIBRE_REGION_SANS_CANDIDAT_CHIFFRABLE", () => {
    const R3 = candidat("r3", { code: "R3", regionId: 3, etat: "NON_EVALUE" });
    const s = sim(e(10_000_000_000n, 10, [R1A, R2A, R3])); // plancher 1 Md : R1A et R2A (1,1 Md) l'atteignent, la region 3 ne le peut pas
    expect(codesInsat(s)).toEqual(["EQUILIBRE_REGION_SANS_CANDIDAT_CHIFFRABLE"]);
    expect(ligne(s, "R3").motifExclusion?.code).toBe("RISQUE_NON_CALCULABLE");
  });

  it("les planchers cumules ne peuvent pas depasser 100 % : 2 regions x 60 % est refuse", () => {
    const r = construireScenario(e(1_000_000_000n, 60));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erreurs.join(" ")).toMatch(/2 région\(s\) x 60 %/);
  });

  it("part minimale hors de 1..100, ou fournie pour une autre logique : refus", () => {
    for (const pct of [0, 101, 1.5]) expect(construireScenario(e(1_000_000_000n, pct)).ok).toBe(false);
    const horsLogique = entreesSimulation({}, { logique: "ratio_cout_impact", equilibre: { partMinimaleParRegionPct: 10 } });
    expect(construireScenario(horsLogique).ok).toBe(false);
    const sansPart = entreesSimulation({}, { logique: "equilibre_territorial", equilibre: null });
    expect(construireScenario(sansPart).ok).toBe(false);
  });

  it("les obligatoires comptent dans le plancher de leur region", () => {
    const s = sim({ ...e(2_200_000_000n, 40), simulation: optionsDeBase({ logique: "equilibre_territorial", equilibre: { partMinimaleParRegionPct: 40 }, obligatoires: ["r1b"] }) });
    expect(ligne(s, "R1B").simulation!.phase).toBe("OBLIGATOIRE");
    expect(ligne(s, "R2A").simulation!.phase).toBe("PLANCHER_REGIONAL");
    expect(ligne(s, "R1A").decision).toBe("ECARTEE");
  });
});

describe("Kilometres : la longueur metier ne se substitue pas a la geometrique", () => {
  it("seule la longueur metier est comptee ; la geometrique est donnee a part ; l'absence est dite", () => {
    const c = candidatsDeBase();
    c[0] = { ...c[0], longueurOrigine: "LONGUEUR_KM" };   // A : 4 000 m metier
    c[1] = { ...c[1], longueurOrigine: null };            // B : 1 000 m, origine inconnue
    c[2] = { ...c[2], longueurOrigine: "GEOMETRIE" };     // C : 10 000 m geometrique
    const s = sim(entreesSimulation({ candidats: c }));
    const k = s.simulation!.kilometres;
    expect(k.metierM).toBe(4000);
    expect(k.metierKm).toBe("4.000");
    expect(k.lignesAvecLongueurMetier).toBe(1);
    expect(k.lignesSansLongueurMetier).toBe(2);
    expect(k.geometriqueKm).toBe("10.000");
    expect(k.note).toMatch(/Longueur métier absente pour 2 intervention/);
    expect(s.simulation!.avertissements.map((a) => a.code)).toContain("LONGUEUR_METIER_ABSENTE");
    expect(s.provisoire).toBe(true);
  });

  it("aucune longueur metier : null (pas 0), avec la phrase", () => {
    const s = sim(entreesSimulation());
    expect(s.simulation!.kilometres.metierKm).toBeNull();
    expect(s.simulation!.kilometres.metierM).toBeNull();
    expect(s.simulation!.kilometres.note).toMatch(/Longueur métier absente/);
  });
});

describe("Risque couvert et distribution regionale", () => {
  it("risque couvert (en points x 10 000), part exacte, et regions", () => {
    const s = sim(entreesSimulation({ budgetGnf: 5_000_000_000n }));
    // retenues : C (24,375) et B (48,75) = 73,125 ; total chiffrable : + A 60,625 = 133,75
    expect(s.simulation!.risqueCouvert).toMatchObject({ retenuMicro: 731_250, totalChiffrableMicro: 1_337_500, totalCalculableMicro: 1_337_500, nbSansRisqueCalculable: 0 });
    expect(s.simulation!.risqueCouvert.partChiffrablePct).toBe("54.6");
    expect(s.simulation!.distributionRegionale).toEqual([
      { regionId: 1, nbRetenues: 1, engageGnf: "800000000", nbEcartees: 1, besoinGnf: "5200000000" },
      { regionId: 2, nbRetenues: 1, engageGnf: "3500000000", nbEcartees: 0, besoinGnf: "3500000000" },
    ]);
  });

  it("un tronçon sans risque calculable est compte a part, jamais comme un risque nul", () => {
    const s = sim(entreesSimulation({ candidats: [...candidatsDeBase(), candidat("n", { code: "RN-N", etat: "NON_EVALUE", regionId: null })] }));
    expect(s.simulation!.risqueCouvert.nbSansRisqueCalculable).toBe(1);
    expect(s.simulation!.distributionRegionale.at(-1)).toMatchObject({ regionId: null, nbRetenues: 0, nbEcartees: 1 });
    expect(ligne(s, "RN-N").motifExclusion?.code).toBe("RISQUE_NON_CALCULABLE");
    expect(s.simulation!.avertissements.find((a) => a.code === "DONNEES_PARTIELLES")?.nb).toBe(1);
  });
});

describe("Version des baremes : identifiant stable", () => {
  it("l'empreinte est stable (ordre de lecture sans effet) et change des qu'un cout, une fenetre ou une approbation change", () => {
    const a = versionDesBaremes();
    const b = versionDesBaremes([...BAREMES].reverse());
    expect(b.empreinte).toBe(a.empreinte);
    expect(a.empreinte).toMatch(/^[0-9a-f]{64}$/);
    expect(a.liste.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const cher = BAREMES.map((x) => (x.id === 2 ? { ...x, coutKmGnf: x.coutKmGnf + 1n } : x));
    expect(versionDesBaremes(cher).empreinte).not.toBe(a.empreinte);
    expect(versionDesBaremes(BAREMES, { "2": [null, "2027-12-31"] }).empreinte).not.toBe(a.empreinte);
    const approuve = BAREMES.map((x) => (x.id === 2 ? { ...x, approuveLe: "2026-10-01T00:00:00.000Z" } : x));
    expect(versionDesBaremes(approuve).empreinte).not.toBe(a.empreinte);
  });

  it("le scenario enregistre la version : empreinte, liste (id, version, statut), nombre d'approuvees", () => {
    const s = sim(entreesSimulation());
    expect(s.simulation!.baremes).toMatchObject({ empreinte: versionDesBaremes().empreinte, nbLignes: 9, nbApprouvees: 0, nbProvisoires: 9 });
    expect(s.simulation!.baremes.liste[0]).toMatchObject({ id: 1, version: 1, approuveLe: null });
  });

  it("une liste retouchee, une empreinte fausse ou un bareme de calcul absent de la version : refus", () => {
    const e = entreesSimulation();
    const retouche = { ...e, simulation: { ...e.simulation!, baremes: { ...e.simulation!.baremes, liste: e.simulation!.baremes.liste.map((r) => (r.id === 2 ? { ...r, validA: "2020-01-01" } : r)) } } };
    expect(construireScenario(retouche).ok).toBe(false);
    const fausse = { ...e, simulation: { ...e.simulation!, baremes: { ...e.simulation!.baremes, empreinte: "0".repeat(64) } } };
    expect(construireScenario(fausse).ok).toBe(false);
    const manquant = { ...e, simulation: { ...e.simulation!, baremes: versionBaremes(e.simulation!.baremes.liste.filter((r) => r.id !== 2)) } };
    const r = construireScenario(manquant);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erreurs.join(" ")).toMatch(/ligne 2 sert au calcul/);
    const cout = { ...e, baremes: BAREMES.map((x) => (x.id === 2 ? { ...x, coutKmGnf: 1n } : x)) };
    expect(construireScenario(cout).ok).toBe(false);
  });

  it("motifPeremption et jourValide", () => {
    const p = { debut: "2027-01-01", fin: "2027-12-31" };
    expect(motifPeremption({ id: 1, validDe: null, validA: null }, p)).toBeNull();
    expect(motifPeremption({ id: 1, validDe: "2026-01-01", validA: "2028-01-01" }, p)).toBeNull();
    expect(motifPeremption({ id: 1, validDe: null, validA: "2027-12-30" }, p)).toMatch(/ne couvre pas/);
    expect(jourValide("2027-02-29")).toBe(false);
    expect(jourValide("2028-02-29")).toBe(true);
    expect(jourValide("27-01-01")).toBe(false);
    expect(verifierVersionBaremes(BAREMES, versionDesBaremes())).toEqual([]);
    expect(refDe(BAREMES[0], { version: 3, validDe: null, validA: null }).version).toBe(3);
  });
});

describe("Periode et devise", () => {
  const avec = (o: Partial<EntreesScenario["simulation"]>) => construireScenario(entreesSimulation({}, o));
  it("periode invalide : fin avant debut, 31 fevrier, annee differente de celle du programme, annee trop lointaine", () => {
    expect(avec({ periode: { debut: "2027-12-31", fin: "2027-01-01" } }).ok).toBe(false);
    expect(avec({ periode: { debut: "2027-02-31", fin: "2027-12-31" } }).ok).toBe(false);
    expect(avec({ periode: { debut: "2028-01-01", fin: "2028-12-31" } }).ok).toBe(false);
    expect(avec({ periode: { debut: "2027-01-01", fin: "2040-12-31" } }).ok).toBe(false);
    expect(avec({ periode: { debut: "2027-07-01", fin: "2027-07-01" } }).ok).toBe(true);
    expect(avec({ periode: { debut: "2027-01-01", fin: "2029-12-31" } }).ok).toBe(true);
  });
  it("devise autre que GNF : refusee", () => {
    expect(avec({ devise: "EUR" as never }).ok).toBe(false);
  });
  it("le resultat porte la periode, la devise et la mention", () => {
    const s = sim(entreesSimulation());
    expect(s.simulation).toMatchObject({ periode: { debut: "2027-01-01", fin: "2027-12-31" }, devise: "GNF", version: 1 });
    expect(s.simulation!.mention).toMatch(/^SIMULATION NON ENGAGEANTE : ne constitue ni une autorisation de dépense ni un ordre de travaux\.$/);
    expect(s.avertissement).toMatch(/Aucune estimation ni programmation/);
  });
});

describe("Reproductibilite : memes entrees, memes octets", () => {
  const riche = () => entreesSimulation({ budgetGnf: 6_000_000_000n, plafondsRegionauxGnf: { "2": 4_000_000_000n } }, {
    logique: "personnalise", ordrePersonnalise: ["b", "c"], obligatoires: ["c"], groupesNonDivisibles: [["a", "b"]],
    perimetre: { regionId: null, classe: "RN", selection: ["a", "b", "c"] },
  });

  it("l'ordre des candidats, des baremes et des options sans ordre propre n'a aucune influence", () => {
    const e1 = riche();
    const e2: EntreesScenario = {
      ...riche(), candidats: [...candidatsDeBase()].reverse(), baremes: [...BAREMES].reverse(),
      simulation: { ...riche().simulation!, obligatoires: ["c"], groupesNonDivisibles: [["b", "a"]], perimetre: { regionId: null, classe: "RN", selection: ["c", "a", "b"] }, baremes: versionBaremes([...riche().simulation!.baremes.liste].reverse()) },
    };
    expect(canonique(entreesVersJson(e2))).toBe(canonique(entreesVersJson(e1)));
    expect(canonique(sim(e2))).toBe(canonique(sim(e1)));
    expect(sha256Hex(canonique(sim(e1)))).toBe(sha256Hex(canonique(sim(riche()))));
  });

  it("l'ordre personnalise, lui, porte le sens : l'inverser change le resultat", () => {
    const e = riche();
    const inverse = { ...e, simulation: { ...e.simulation!, ordrePersonnalise: ["c", "b"] } };
    expect(canonique(entreesVersJson(inverse))).not.toBe(canonique(entreesVersJson(e)));
  });

  it("aller-retour JSON des entrees stockees : le rejeu donne le meme resultat, octet pour octet", () => {
    const e = riche();
    const texte = canonique(entreesVersJson(e));
    const relu = entreesDepuisJson(JSON.parse(texte));
    if (!relu.ok) throw new Error(relu.erreurs.join(" ; "));
    expect(canonique(entreesVersJson(relu.entrees))).toBe(texte);
    expect(canonique(sim(relu.entrees))).toBe(canonique(sim(e)));
  });

  it("des options non normalisees (groupes et obligatoires melanges) donnent le meme resultat que normalisees (numeros de groupe stables)", () => {
    const a = entreesSimulation({ budgetGnf: 9_000_000_000n }, { groupesNonDivisibles: [["c", "a"], ["b", "zz"]] });
    const b = entreesSimulation({ budgetGnf: 9_000_000_000n }, { groupesNonDivisibles: [["b", "zz"], ["a", "c"]] });
    expect(canonique(sim(a))).toBe(canonique(sim(b)));
  });

  it("options illisibles ou version inconnue : refus a la relecture", () => {
    const e = riche();
    const j = JSON.parse(canonique(entreesVersJson(e)));
    j.simulation.version = 2;
    expect(entreesDepuisJson(j).ok).toBe(false);
    const j2 = JSON.parse(canonique(entreesVersJson(e)));
    delete j2.simulation.obligatoires;
    expect(entreesDepuisJson(j2).ok).toBe(false);
    expect(optionsDepuisJson(optionsVersJson(e.simulation!)).ok).toBe(true);
  });
});

describe("validerOptions et validerEntrees", () => {
  it("rien n'est corrige : une option incoherente est un refus nomme", () => {
    const e = entreesSimulation();
    const ctx = { annee: 2027, candidatIds: new Set(["a", "b", "c"]), regionsCandidates: [1, 2], baremes: BAREMES };
    expect(validerOptions(e.simulation!, ctx)).toEqual([]);
    expect(validerOptions({ ...e.simulation!, rangsTechniques: { a: 0 } }, ctx).join(" ")).toMatch(/rangsTechniques\.a/);
    expect(validerOptions({ ...e.simulation!, perimetre: { regionId: null, classe: null, selection: [] } }, ctx).join(" ")).toMatch(/selection/);
    expect(validerEntrees({ ...e, budgetGnf: -5n }).join(" ")).toMatch(/budgetGnf/);
  });
});
