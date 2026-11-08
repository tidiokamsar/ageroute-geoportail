import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CODES_LOGIQUE, LOGIQUES, comparerRatio, logiqueDe, ordonner, type ElementClassable } from "./logiques.noyau";
import { construireScenario } from "./scenario.noyau";
import { entreesDeBase, candidat } from "./scenario.fixtures";
import { entreesSimulation } from "./contraintes.fixtures";
import { canonique } from "./canonique";

const el = (id: string, o: Partial<ElementClassable> = {}): ElementClassable => ({
  id, code: `C-${id}`, regionId: 1, coutGnf: 1_000_000_000n, risqueMicro: 500_000, attenduMicro: 500_000, etat: "MAUVAIS", ...o,
});
const ids = (l: ElementClassable[]) => l.map((x) => x.id);

describe("logiques.noyau : aucun import", () => {
  it("n'importe rien", () => {
    const src = readFileSync(join(__dirname, "logiques.noyau.ts"), "utf8");
    expect([...src.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)]).toEqual([]);
  });
  it("cinq logiques nommees, chacune explicable (libelle, explication, regle)", () => {
    expect(CODES_LOGIQUE).toEqual(["ratio_cout_impact", "urgence", "criticite", "equilibre_territorial", "personnalise"]);
    expect(LOGIQUES).toHaveLength(5);
    for (const l of LOGIQUES) {
      expect(l.libelle.length).toBeGreaterThan(3);
      expect(l.explication.length).toBeGreaterThan(20);
      expect(l.regle.length).toBeGreaterThan(20);
      expect(logiqueDe(l.code)).toBe(l);
    }
    // Les conventions non validees par le metier sont dites provisoires.
    expect(logiqueDe("urgence").provisoire).toBe(true);
    expect(logiqueDe("equilibre_territorial").provisoire).toBe(true);
    expect(logiqueDe("ratio_cout_impact").provisoire).toBe(false);
  });
});

describe("ordonner : chaque logique, avec ses departages", () => {
  it("ratio_cout_impact : attendu / cout decroissant, produit croise EXACT (pas de flottant)", () => {
    // 3/7 > 2/5 > 1/3 sans arrondi ; un flottant aurait pu confondre 0.4285... et 0.4
    const a = el("a", { attenduMicro: 3, coutGnf: 7n }), b = el("b", { attenduMicro: 2, coutGnf: 5n }), c = el("c", { attenduMicro: 1, coutGnf: 3n });
    expect(ids(ordonner([c, b, a], "ratio_cout_impact"))).toEqual(["a", "b", "c"]);
  });

  it("ratio : a ratio egal, risque courant decroissant, puis cout croissant, puis code, puis identifiant", () => {
    const x = el("x", { code: "B", attenduMicro: 100, coutGnf: 10n, risqueMicro: 50 });
    const y = el("y", { code: "A", attenduMicro: 200, coutGnf: 20n, risqueMicro: 90 }); // meme ratio 10 ; risque plus haut
    expect(ids(ordonner([x, y], "ratio_cout_impact"))).toEqual(["y", "x"]);
    const z1 = el("z1", { code: "Z", attenduMicro: 10, coutGnf: 1n }), z2 = el("z2", { code: "Z", attenduMicro: 10, coutGnf: 1n });
    expect(ids(ordonner([z2, z1], "ratio_cout_impact"))).toEqual(["z1", "z2"]);
  });

  it("urgence : l'etat le plus degrade d'abord, MEME s'il est plus cher et de risque plus bas", () => {
    const critique = el("crit", { etat: "CRITIQUE", risqueMicro: 400_000, attenduMicro: 400_000, coutGnf: 9_000_000_000n });
    const mauvais = el("mauv", { etat: "MAUVAIS", risqueMicro: 700_000, attenduMicro: 750_000, coutGnf: 100_000_000n });
    expect(ids(ordonner([mauvais, critique], "urgence"))).toEqual(["crit", "mauv"]);
    // ... alors que le ratio met le troncon bon marche en tete : les deux ordres ne se confondent pas.
    expect(ids(ordonner([critique, mauvais], "ratio_cout_impact"))).toEqual(["mauv", "crit"]);
  });

  it("urgence : a etat egal, l'aggravation attendue la plus forte d'abord", () => {
    const stable = el("stable", { etat: "MAUVAIS", risqueMicro: 600_000, attenduMicro: 600_000 });
    const aggrave = el("aggrave", { etat: "MAUVAIS", risqueMicro: 500_000, attenduMicro: 650_000 });
    expect(ids(ordonner([stable, aggrave], "urgence"))).toEqual(["aggrave", "stable"]);
  });

  it("criticite : risque courant decroissant, indifferent au cout ; puis risque attendu, puis cout", () => {
    const cher = el("cher", { risqueMicro: 800_000, coutGnf: 50_000_000_000n });
    const bonMarche = el("bm", { risqueMicro: 100_000, coutGnf: 1n });
    expect(ids(ordonner([bonMarche, cher], "criticite"))).toEqual(["cher", "bm"]);
    const p = el("p", { risqueMicro: 300_000, attenduMicro: 310_000 }), q = el("q", { risqueMicro: 300_000, attenduMicro: 350_000 });
    expect(ids(ordonner([p, q], "criticite"))).toEqual(["q", "p"]);
  });

  it("equilibre_territorial : l'ordre de base est le ratio (la regle d'equilibre agit a la selection)", () => {
    const a = el("a", { attenduMicro: 3, coutGnf: 7n }), b = el("b", { attenduMicro: 1, coutGnf: 3n });
    expect(ids(ordonner([b, a], "equilibre_territorial"))).toEqual(ids(ordonner([b, a], "ratio_cout_impact")));
  });

  it("personnalise : la liste d'abord dans SON ordre, les non listes apres par ratio", () => {
    const a = el("a", { attenduMicro: 9, coutGnf: 1n }), b = el("b", { attenduMicro: 5, coutGnf: 1n }), c = el("c", { attenduMicro: 7, coutGnf: 1n }), d = el("d", { attenduMicro: 1, coutGnf: 1n });
    expect(ids(ordonner([a, b, c, d], "personnalise", ["d", "b"]))).toEqual(["d", "b", "a", "c"]);
  });

  it("l'ordre est total : melanger l'entree ne change pas la sortie, et l'entree n'est pas modifiee", () => {
    const base = Array.from({ length: 40 }, (_, i) => el(String(i), { code: `K${i % 7}`, attenduMicro: (i * 37) % 11, coutGnf: BigInt(1 + (i % 5)), risqueMicro: (i * 13) % 9, etat: ["BON", "MOYEN", "MAUVAIS", "CRITIQUE"][i % 4] }));
    const copie = [...base];
    for (const logique of CODES_LOGIQUE) {
      const a = ids(ordonner(base, logique, ["3", "9"]));
      const b = ids(ordonner([...base].reverse(), logique, ["3", "9"]));
      expect(b).toEqual(a);
    }
    expect(base).toEqual(copie);
  });

  it("comparerRatio reste coherent (antisymetrique)", () => {
    const a = el("a", { attenduMicro: 3, coutGnf: 7n }), b = el("b", { attenduMicro: 2, coutGnf: 5n });
    expect(Math.sign(comparerRatio(a, b))).toBe(-Math.sign(comparerRatio(b, a)));
    expect(comparerRatio(a, a)).toBe(0);
  });
});

describe("Equivalence avec le moteur historique (ratio_cout_impact, sans contrainte)", () => {
  // Generateur deterministe (graine fixe) : 400 troncons, regions 1 a 4, etats varies, trafics varies.
  function jeu(n: number) {
    let s = 12345;
    const alea = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const etats = ["MOYEN", "MAUVAIS", "CRITIQUE"];
    return Array.from({ length: n }, (_, i) => candidat(String(i).padStart(4, "0"), {
      code: `G-${String(i).padStart(4, "0")}`, regionId: 1 + Math.floor(alea() * 4), etat: etats[Math.floor(alea() * 3)],
      traficMoyenJma: Math.floor(alea() * 4000), nbPointsNoirs: Math.floor(alea() * 4), longueurM: 500 + Math.floor(alea() * 20000),
      revetement: alea() < 0.3 ? "TERRE" : "BITUME",
    }));
  }

  it("meme ordre de priorite, memes lignes retenues, memes totaux que construireScenario", () => {
    const candidats = jeu(400);
    const budgetGnf = 30_000_000_000n;
    const hist = construireScenario(entreesDeBase({ candidats, budgetGnf }));
    const sim = construireScenario(entreesSimulation({ candidats, budgetGnf }));
    if (!hist.ok || !sim.ok) throw new Error("refus");
    const classees = (s: typeof hist.scenario) => s.lignes.filter((l) => l.rangPriorite !== null).map((l) => `${l.troncon.id}:${l.rangPriorite}:${l.decision}:${l.motifExclusion?.code ?? ""}`);
    expect(classees(sim.scenario)).toEqual(classees(hist.scenario));
    expect(sim.scenario.totaux.engageGnf).toBe(hist.scenario.totaux.engageGnf);
    expect(sim.scenario.totaux.retenues).toBe(hist.scenario.totaux.retenues);
    expect(sim.scenario.totaux.ecartesParMotif).toEqual(hist.scenario.totaux.ecartesParMotif);
    expect(hist.scenario.totaux.retenues).toBeGreaterThan(10); // le jeu est assez riche pour que la comparaison compte
    expect(hist.scenario.totaux.ecartees).toBeGreaterThan(10);
    // le resultat historique n'a pas ete modifie par l'existence du simulateur
    expect(canonique(hist.scenario)).not.toContain("simulation");
  });
});
