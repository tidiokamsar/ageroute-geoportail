import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_SCENARIOS, comparerScenarios, type ScenarioComparable } from "./comparaison.noyau";
import { construireScenario, type EntreesScenario, type Scenario } from "./scenario.noyau";
import { candidatsDeBase, entreesDeBase } from "./scenario.fixtures";
import { entreesSimulation } from "./contraintes.fixtures";

function comparable(id: string, e: EntreesScenario): ScenarioComparable {
  const r = construireScenario(e);
  if (!r.ok) throw new Error(r.erreurs.join(" ; "));
  return { id, intitule: `Scénario ${id}`, creeParId: "u1", creeLe: "2026-10-26T10:00:00.000Z", empreinteResultat: "0".repeat(64), resultat: r.scenario };
}
const ok = (l: ScenarioComparable[]) => { const r = comparerScenarios(l); if (!r.ok) throw new Error(r.message); return r.comparaison; };

describe("comparaison.noyau : aucune base, aucune horloge", () => {
  it("n'importe que deficit.noyau (constante de mention) et des types", () => {
    const src = readFileSync(join(__dirname, "comparaison.noyau.ts"), "utf8");
    const imports = [...src.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]).sort();
    expect(imports).toEqual(["./deficit.noyau", "./scenario.noyau"]);
    expect(src).not.toMatch(/Date\.now|new Date\(|Math\.random/);
  });
});

describe("comparerScenarios : tableau cote a cote", () => {
  const a = comparable("s-a", entreesSimulation({ budgetGnf: 5_000_000_000n }));
  const b = comparable("s-b", entreesSimulation({ budgetGnf: 8_000_000_000n }, { logique: "urgence" }));
  const c = comparable("s-c", entreesSimulation({ budgetGnf: 10_000_000_000n }, { obligatoires: ["a"], groupesNonDivisibles: [["b", "c"]] }));

  it("enveloppe, consomme, reste, deficit, nombre d'interventions, risque couvert : valeurs lues dans les resultats scelles", () => {
    const k = ok([a, b]);
    expect(k.scenarios.map((s) => [s.enveloppeGnf, s.consommeGnf, s.resteGnf, s.deficitGnf, s.nbInterventions])).toEqual([
      ["5000000000", "4300000000", "700000000", "3700000000", 2],
      ["8000000000", "7900000000", "100000000", "700000000", 2],
    ]);
    expect(k.scenarios[0].soldeGnf).toBe("-3700000000");
    expect(k.scenarios[0].risqueCouvert.partChiffrablePct).toBe("54.6");
    expect(k.scenarios[0].logique).toEqual({ code: "ratio_cout_impact", libelle: "Ratio coût / impact" });
    expect(k.scenarios[1].logique.code).toBe("urgence");
    expect(k.mention).toMatch(/SIMULATION NON ENGAGEANTE/);
    expect(k.periode).toEqual({ debut: "2027-01-01", fin: "2027-12-31" });
    expect(k.devise).toBe("GNF");
  });

  it("kilometres : longueur metier absente est DITE, la geometrique n'est pas substituee", () => {
    const k = ok([a, b]);
    expect(k.scenarios[0].kilometres.metierKm).toBeNull();
    expect(k.scenarios[0].kilometres.note).toMatch(/Longueur métier absente/);
  });

  it("differences d'hypotheses : seules les lignes qui different sont marquees non identiques", () => {
    const k = ok([a, b, c]);
    const h = Object.fromEntries(k.hypotheses.map((x) => [x.champ, x]));
    expect(h.logique.identiques).toBe(false);
    expect(h.logique.valeurs).toEqual(["Ratio coût / impact", "Urgence", "Ratio coût / impact"]);
    expect(h.enveloppe.identiques).toBe(false);
    expect(h.obligatoires.valeurs).toEqual(["aucun", "aucun", "a"]);
    expect(h.groupes.valeurs[2]).toBe("[b, c]");
    expect(h.parametres.identiques).toBe(true);
    expect(h.baremes.identiques).toBe(true);
    expect(h.candidats.identiques).toBe(true);
  });

  it("interventions communes et propres a chaque scenario", () => {
    const k = ok([a, b]);
    // a retient C et B ; b (urgence, 8 Md) retient B et A : B est commune
    expect(k.interventions.communes).toBe(1);
    expect(k.interventions.propres).toEqual([{ id: "s-a", nb: 1 }, { id: "s-b", nb: 1 }]);
  });

  it("une comparaison ne modifie pas les resultats compares", () => {
    const avant = JSON.stringify([a.resultat, b.resultat]);
    ok([a, b]);
    expect(JSON.stringify([a.resultat, b.resultat])).toBe(avant);
  });

  it("5 scenarios acceptes, 6 refuses, 1 refuse, doublon refuse", () => {
    const cinq = [a, b, c, comparable("s-d", entreesSimulation()), comparable("s-e", entreesSimulation({ budgetGnf: 1n }))];
    expect(comparerScenarios(cinq).ok).toBe(true);
    expect(MAX_SCENARIOS).toBe(5);
    const six = [...cinq, comparable("s-f", entreesSimulation())];
    const r6 = comparerScenarios(six);
    expect(r6).toMatchObject({ ok: false, code: "NOMBRE_INVALIDE" });
    expect(comparerScenarios([a])).toMatchObject({ ok: false, code: "NOMBRE_INVALIDE" });
    expect(comparerScenarios([a, a])).toMatchObject({ ok: false, code: "DOUBLON" });
  });

  it("periodes incompatibles : refus avec un message qui nomme les deux periodes", () => {
    const autre = comparable("s-p", entreesSimulation({}, { periode: { debut: "2027-01-01", fin: "2028-12-31" } }));
    const r = comparerScenarios([a, autre]);
    expect(r).toMatchObject({ ok: false, code: "PERIODES_INCOMPATIBLES" });
    if (!r.ok) expect(r.message).toMatch(/2027-01-01 à 2027-12-31.*2027-01-01 à 2028-12-31/);
  });

  it("devises incompatibles : refus (simule par un resultat altere, la devise n'etant aujourd'hui que GNF)", () => {
    const autre: ScenarioComparable = { ...b, id: "s-eur", resultat: { ...b.resultat, simulation: { ...b.resultat.simulation!, devise: "EUR" as never } } };
    expect(comparerScenarios([a, autre])).toMatchObject({ ok: false, code: "DEVISES_INCOMPATIBLES" });
  });

  it("scenario herite (sans bloc simulation) : refuse, avec la marche a suivre, jamais assimile a une annee entiere", () => {
    const r0 = construireScenario(entreesDeBase({ candidats: candidatsDeBase() }));
    if (!r0.ok) throw new Error("refus");
    const ancien: ScenarioComparable = { id: "s-old", intitule: "PAE 2027 ancien", creeParId: "u", creeLe: "2026-10-01T00:00:00.000Z", empreinteResultat: "1".repeat(64), resultat: r0.scenario as Scenario };
    const r = comparerScenarios([a, ancien]);
    expect(r).toMatchObject({ ok: false, code: "SCENARIO_SANS_SIMULATION" });
    if (!r.ok) expect(r.message).toMatch(/avant le simulateur.*Relancez-le/);
  });
});

describe("comparerScenarios : perimetres differents (revue : seules la periode et la devise etaient controlees)", () => {
  const avecPerimetre = (id: string, perimetre: ScenarioComparable["perimetre"], budget = 5_000_000_000n): ScenarioComparable => ({
    ...comparable(id, entreesSimulation({ budgetGnf: budget })), perimetre,
  });
  const P = (regionId: number | null, classe: string | null = null, selection: string[] | null = null) => ({ regionId, classe, selection });
  const hyp = (k: ReturnType<typeof ok>) => Object.fromEntries(k.hypotheses.map((x) => [x.champ, x]));

  it("region, classe de route et selection sont des HYPOTHESES comparees, avec une valeur lisible par scenario", () => {
    const k = ok([avecPerimetre("s-a", P(1, "RN")), avecPerimetre("s-b", P(2, null, ["a", "b"])), avecPerimetre("s-c", P(null, null, null))]);
    const h = hyp(k);
    expect(h.region.valeurs).toEqual(["région 1", "région 2", "toutes les régions"]);
    expect(h.classe.valeurs).toEqual(["RN", "toutes les classes", "toutes les classes"]);
    expect(h.selection.valeurs).toEqual(["tous les candidats du périmètre", "2 interventions sélectionnées", "tous les candidats du périmètre"]);
    expect([h.region.identiques, h.classe.identiques, h.selection.identiques]).toEqual([false, false, false]);
  });

  it("des perimetres differents donnent un AVERTISSEMENT (pas un refus : comparer deux regions est legitime) qui dit lesquels", () => {
    const k = ok([avecPerimetre("s-a", P(1)), avecPerimetre("s-b", P(2))]);
    expect(k.perimetresIdentiques).toBe(false);
    expect(k.avertissements).toHaveLength(1);
    expect(k.avertissements[0]).toMatch(/périmètres différents/i);
    expect(k.avertissements[0]).toMatch(/région/);
    expect(k.avertissements[0]).toMatch(/ne portent pas sur les mêmes tronçons/);
    const classe = ok([avecPerimetre("s-a", P(1, "RN")), avecPerimetre("s-b", P(1, "RR"))]);
    expect(classe.avertissements[0]).toMatch(/classe de route/);
    const selection = ok([avecPerimetre("s-a", P(1, null, ["a"])), avecPerimetre("s-b", P(1, null, ["b"]))]);
    expect(selection.avertissements[0]).toMatch(/sélection/);
  });

  it("une selection identique dans un autre ordre, ou des perimetres identiques : aucun avertissement", () => {
    const k = ok([avecPerimetre("s-a", P(1, "RN", ["a", "b"])), avecPerimetre("s-b", P(1, "RN", ["b", "a"]), 8_000_000_000n)]);
    expect(k.perimetresIdentiques).toBe(true);
    expect(k.avertissements).toEqual([]);
    expect(hyp(k).selection.identiques).toBe(true);
  });

  it("un perimetre non fourni est DIT (inconnu), jamais assimile a « national » : avertissement, perimetresIdentiques faux", () => {
    const k = ok([avecPerimetre("s-a", P(1)), { ...avecPerimetre("s-b", null), perimetre: undefined }]);
    expect(hyp(k).region.valeurs[1]).toBe("périmètre non précisé");
    expect(k.perimetresIdentiques).toBe(false);
    expect(k.avertissements[0]).toMatch(/non précisé/);
  });

  it("chaque colonne porte son perimetre", () => {
    const k = ok([avecPerimetre("s-a", P(1, "RN", ["a"])), avecPerimetre("s-b", P(2))]);
    expect(k.scenarios.map((s) => s.perimetre)).toEqual([{ regionId: 1, classe: "RN", nbSelection: 1 }, { regionId: 2, classe: null, nbSelection: null }]);
  });
});
