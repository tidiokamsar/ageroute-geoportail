import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MENTION_SIMULATION, bilanBudgetaire, pourcentage } from "./deficit.noyau";
import { construireScenario, type Scenario } from "./scenario.noyau";
import { BAREMES, candidat, entreesDeBase } from "./scenario.fixtures";
import { entreesSimulation } from "./contraintes.fixtures";
import { versionDesBaremes } from "./contraintes.fixtures";

/**
 * Bilan budgetaire du simulateur. Valeurs posees A LA MAIN sur les trois candidats de `scenario.fixtures.ts` :
 * RN-C 800 M GNF, RN-A 4 400 M GNF, RN-B 3 500 M GNF, soit un besoin chiffre de 8 700 M GNF. Ordre du ratio : C, A, B.
 */
describe("deficit.noyau : aucun import, aucun flottant", () => {
  it("n'importe rien", () => {
    const src = readFileSync(join(__dirname, "deficit.noyau.ts"), "utf8");
    expect([...src.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)]).toEqual([]);
  });
});

describe("bilanBudgetaire : arithmetique exacte en BigInt", () => {
  const e = (enveloppe: bigint, consomme: bigint, besoin: bigint[], nonFiables = 0, oblig: bigint[] = []) =>
    bilanBudgetaire({ enveloppeGnf: enveloppe, consommeGnf: consomme, coutsFiablesGnf: besoin, nbCoutsNonFiables: nonFiables, coutsObligatoiresGnf: oblig });

  it("enveloppe egale au besoin : deficit 0, excedent 0, solde 0", () => {
    const b = e(8_700_000_000n, 8_700_000_000n, [800_000_000n, 4_400_000_000n, 3_500_000_000n]);
    expect([b.resteGnf, b.besoinTotalGnf, b.deficitGnf, b.excedentGnf, b.soldeGnf]).toEqual(["0", "8700000000", "0", "0", "0"]);
    expect(b.couvertureBesoinPct).toBe("100.0");
    expect(b.deficitMinorant).toBe(false);
  });

  it("un franc de moins : deficit de 1 GNF, solde SIGNE -1 (jamais masque)", () => {
    const b = e(8_699_999_999n, 5_199_999_999n, [800_000_000n, 4_400_000_000n, 3_500_000_000n]);
    expect(b.deficitGnf).toBe("1");
    expect(b.soldeGnf).toBe("-1");
    expect(b.excedentGnf).toBe("0");
    expect(b.couvertureBesoinPct).toBe("99.9");
  });

  it("un franc de plus : excedent de 1 GNF, deficit 0", () => {
    const b = e(8_700_000_001n, 8_700_000_000n, [8_700_000_000n]);
    expect([b.deficitGnf, b.excedentGnf, b.soldeGnf, b.resteGnf]).toEqual(["0", "1", "1", "1"]);
  });

  it("au-dela de 2^53 : aucune perte de precision", () => {
    const grand = 9_007_199_254_740_993n; // 2^53 + 1
    const b = e(grand, 0n, [grand + 7n]);
    expect(b.deficitGnf).toBe("7");
    expect(b.besoinTotalGnf).toBe("9007199254741000");
  });

  it("enveloppe nulle : tout le besoin est deficit, couverture 0.0", () => {
    const b = e(0n, 0n, [100n, 200n]);
    expect([b.deficitGnf, b.resteGnf, b.couvertureBesoinPct]).toEqual(["300", "0", "0.0"]);
  });

  it("aucun besoin chiffre : couverture inconnue (null), pas 100 %", () => {
    expect(e(1000n, 0n, []).couvertureBesoinPct).toBeNull();
    expect(pourcentage(1n, 0n)).toBeNull();
  });

  it("des couts non fiables rendent le deficit minorant, sans valoriser ces couts", () => {
    const b = e(1000n, 0n, [500n], 2);
    expect(b.deficitMinorant).toBe(true);
    expect(b.nbCoutsNonFiables).toBe(2);
    expect(b.besoinTotalGnf).toBe("500");
  });

  it("deficit des obligatoires seuls", () => {
    const b = e(1000n, 0n, [900n, 800n], 0, [900n, 800n]);
    expect([b.besoinObligatoiresGnf, b.deficitObligatoiresGnf]).toEqual(["1700", "700"]);
  });

  it("refuse une enveloppe negative et un consomme superieur a l'enveloppe", () => {
    expect(() => e(-1n, 0n, [])).toThrow();
    expect(() => e(10n, 11n, [])).toThrow();
  });
});

const sc = (r: ReturnType<typeof construireScenario>): Scenario => {
  if (!r.ok) throw new Error(r.erreurs.join(" ; "));
  return r.scenario;
};

describe("Le bilan dans un scenario du simulateur (valeurs a la main)", () => {
  it("enveloppe 10 Md : tout est retenu, reste 1,3 Md, besoin 8,7 Md, aucun deficit", () => {
    const s = sc(construireScenario(entreesSimulation()));
    const b = s.simulation!.bilan;
    expect([b.enveloppeGnf, b.consommeGnf, b.resteGnf, b.besoinTotalGnf, b.deficitGnf, b.excedentGnf]).toEqual(["10000000000", "8700000000", "1300000000", "8700000000", "0", "1300000000"]);
    expect(s.totaux.retenues).toBe(3);
    expect(s.simulation!.mention).toBe(MENTION_SIMULATION);
  });

  it("enveloppe nulle : rien n'est retenu, deficit = besoin, avertissement ENVELOPPE_NULLE", () => {
    const s = sc(construireScenario(entreesSimulation({ budgetGnf: 0n })));
    expect(s.totaux.retenues).toBe(0);
    expect(s.totaux.ecartesParMotif).toEqual({ BUDGET_INSUFFISANT: 3 });
    expect(s.simulation!.bilan.deficitGnf).toBe("8700000000");
    expect(s.simulation!.avertissements.map((a) => a.code)).toContain("ENVELOPPE_NULLE");
  });

  it("enveloppe negative : refusee (ENTREES_INVALIDES), jamais corrigee a zero", () => {
    const r = construireScenario(entreesSimulation({ budgetGnf: -1n }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erreurs.join(" ")).toMatch(/budgetGnf/);
  });

  it("enveloppe exactement egale au besoin : tout est retenu, reste 0, deficit 0", () => {
    const s = sc(construireScenario(entreesSimulation({ budgetGnf: 8_700_000_000n })));
    expect(s.totaux.retenues).toBe(3);
    expect(s.totaux.resteGnf).toBe("0");
    expect(s.simulation!.bilan.deficitGnf).toBe("0");
    expect(s.simulation!.bilan.soldeGnf).toBe("0");
  });

  it("un franc de moins que le besoin : RN-B (la derniere) est ecartee, deficit de 1 GNF", () => {
    const s = sc(construireScenario(entreesSimulation({ budgetGnf: 8_699_999_999n })));
    expect(s.totaux.retenues).toBe(2);
    const b = s.lignes.find((l) => l.troncon.code === "RN-B")!;
    expect(b.decision).toBe("ECARTEE");
    expect(b.motifExclusion?.code).toBe("BUDGET_INSUFFISANT");
    expect(s.simulation!.bilan.deficitGnf).toBe("1");
    expect(s.simulation!.bilan.soldeGnf).toBe("-1");
    expect(s.simulation!.bilan.resteGnf).toBe("3499999999");
  });

  it("enveloppe 5 Md : RN-C et RN-B tiennent, RN-A (4,4 Md) est ecartee ; deficit 3,7 Md ; reste 0,7 Md", () => {
    const s = sc(construireScenario(entreesSimulation({ budgetGnf: 5_000_000_000n })));
    const dec = Object.fromEntries(s.lignes.map((l) => [l.troncon.code, l.decision]));
    expect(dec).toEqual({ "RN-C": "RETENUE", "RN-A": "ECARTEE", "RN-B": "RETENUE" });
    expect(s.simulation!.bilan.consommeGnf).toBe("4300000000");
    expect(s.simulation!.bilan.resteGnf).toBe("700000000");
    expect(s.simulation!.bilan.deficitGnf).toBe("3700000000");
    expect(s.simulation!.avertissements.map((a) => a.code)).toContain("DEFICIT");
  });

  it("cout MANQUANT (barème de reconstruction absent) : RN-B ecartee COUT_NON_ESTIMABLE, non comptee dans le besoin, deficit minorant", () => {
    const baremes = BAREMES.filter((b) => b.typeIntervention !== "reconstruction");
    const s = sc(construireScenario(entreesSimulation({ baremes, budgetGnf: 1_000_000_000n })));
    const b = s.lignes.find((l) => l.troncon.code === "RN-B")!;
    expect(b.motifExclusion?.code).toBe("COUT_NON_ESTIMABLE");
    expect(b.cout).toMatchObject({ ok: false });
    expect(b.simulation?.coutFiable).toBe(false);
    expect(s.simulation!.bilan.besoinTotalGnf).toBe("5200000000");
    expect(s.simulation!.bilan.deficitMinorant).toBe(true);
    expect(s.simulation!.bilan.nbCoutsNonFiables).toBe(1);
    expect(s.simulation!.coutsNonFiables).toEqual([{ code: "COUT_NON_ESTIMABLE", nb: 1, troncons: ["RN-B"] }]);
    const codes = s.simulation!.avertissements.map((a) => a.code);
    expect(codes).toContain("COUT_NON_ESTIMABLE");
    expect(codes).toContain("DEFICIT_MINORANT");
  });

  it("cout PERIME (fenetre du bareme finie avant la fin de la periode) : ecarte COUT_PERIME, non simule comme fiable", () => {
    // Barème 2 = réhabilitation bitume MAUVAIS (RN-A), valable jusqu'au 30/06/2027 : ne couvre pas 2027-01-01 a 2027-12-31.
    const e = entreesSimulation({}, { baremes: versionDesBaremes(BAREMES, { "2": [null, "2027-06-30"] }) });
    const s = sc(construireScenario(e));
    const a = s.lignes.find((l) => l.troncon.code === "RN-A")!;
    expect(a.decision).toBe("ECARTEE");
    expect(a.motifExclusion?.code).toBe("COUT_PERIME");
    expect(a.motifExclusion?.detail).toMatch(/2027-06-30/);
    expect(a.cout).toMatchObject({ ok: false, code: "COUT_PERIME" });
    expect(a.simulation?.coutFiable).toBe(false);
    expect(s.simulation!.bilan.besoinTotalGnf).toBe("4300000000"); // C + B seulement : le cout perime n'est pas valorise
    expect(s.simulation!.bilan.deficitMinorant).toBe(true);
    expect(s.simulation!.avertissements.find((x) => x.code === "COUT_PERIME")?.nb).toBe(1);
    expect(s.totaux.ecartesParMotif).toEqual({ COUT_PERIME: 1 });
  });

  it("peremption : bareme pas encore en vigueur, fin exactement a la fin de periode (fiable), un jour avant (perime)", () => {
    const motifDeA = (fenetre: [string | null, string | null]) => {
      const e = entreesSimulation({}, { baremes: versionDesBaremes(BAREMES, { "2": fenetre }) });
      return sc(construireScenario(e)).lignes.find((l) => l.troncon.code === "RN-A")!.motifExclusion?.code ?? null;
    };
    expect(motifDeA(["2027-03-01", null])).toBe("COUT_PERIME");
    expect(motifDeA([null, "2027-12-31"])).toBeNull();
    expect(motifDeA(["2027-01-01", "2027-12-31"])).toBeNull();
    expect(motifDeA([null, "2027-12-30"])).toBe("COUT_PERIME");
    expect(motifDeA([null, null])).toBeNull();
  });

  it("jamais de cout invente : une intervention a cout inconnu ou perime n'a ni montant retenu ni part du consomme", () => {
    const baremes = BAREMES.filter((b) => b.typeIntervention !== "rehabilitation");
    const s = sc(construireScenario(entreesSimulation({ baremes })));
    const a = s.lignes.find((l) => l.troncon.code === "RN-A")!;
    expect(a.decision).toBe("ECARTEE");
    expect(a.budget).toBeNull();
    expect(BigInt(s.totaux.engageGnf)).toBe(4_300_000_000n);
  });

  it("une ligne sans longueur ne rend pas de montant nul retenu (cout nul = non estimable)", () => {
    const s = sc(construireScenario(entreesSimulation({ candidats: [candidat("z", { code: "Z", etat: "MAUVAIS", traficMoyenJma: 2500, nbPointsNoirs: 2, longueurM: 0 })] })));
    expect(s.totaux.retenues).toBe(0);
  });
});

describe("Le noyau historique n'est pas touche par les entrees sans simulation", () => {
  it("un scenario sans options n'a ni bloc simulation ni code de simulation", () => {
    const r = construireScenario(entreesDeBase());
    if (!r.ok) throw new Error("refus");
    expect(r.scenario.simulation).toBeUndefined();
    expect(r.scenario.lignes.every((l) => l.simulation === undefined)).toBe(true);
  });
});
