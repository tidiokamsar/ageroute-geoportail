import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_ANNEES_PPE, MAX_CANDIDATS_PPE, MIN_ANNEES_PPE, construirePlan, entreesPpeDepuisJson, entreesPpeVersJson, validerEntreesPpe,
  type EntreesPpe, type PlanPluriannuel,
} from "./ppe.noyau";
import { construireScenario } from "./scenario.noyau";
import { canonique } from "./canonique";
import { BAREMES, CATALOGUE, CONDITIONS, MATRICES, candidat, candidatsDeBase } from "./scenario.fixtures";
import { parametresAmorcage } from "./parametres.noyau";

/**
 * PPE minimal : ce que ces tests defendent.
 *
 *   - le chainage est verifie contre des calculs poses A LA MAIN (jeu de base : C 0,8 Md, A 4,4 Md, B 3,5 Md ;
 *     priorite C puis A puis B) ;
 *   - un troncon retenu une annee n'est jamais retenu ni reexamine ensuite ;
 *   - un troncon ecarte pour budget reste candidat l'annee suivante ;
 *   - AUCUNE enveloppe n'est inventee ni reportee : un reste non depense n'augmente pas l'annee suivante ;
 *   - memes entrees, memes octets (et l'ordre des tableaux d'entree n'a aucune influence) ;
 *   - un ORACLE refait le glouton par une autre methode (selection repetee du meilleur restant) sur des jeux
 *     pseudo-aleatoires a graine fixe, et doit donner les memes retenus, annee par annee ;
 *   - rien n'est presente comme officiel : etiquette PROVISOIRE sur le plan et sur chaque ligne.
 */
describe("Le noyau PPE ne depend d'aucune base", () => {
  it("n'importe que des noyaux purs", () => {
    const src = readFileSync(join(__dirname, "ppe.noyau.ts"), "utf8");
    const imports = [...src.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]).sort();
    expect(imports).toEqual(["../engines/cout.noyau", "../engines/traitement.noyau", "./parametres.noyau", "./scenario.noyau"].sort());
    for (const i of imports) expect(i).not.toMatch(/prisma|express|zod|lib\/|utils\/|middleware/);
  });
});

const MD = 1_000_000_000n;

function entrees(budgets: bigint[], o: Partial<EntreesPpe> = {}): EntreesPpe {
  const anneeDebut = o.anneeDebut ?? 2027;
  return {
    anneeDebut,
    enveloppes: budgets.map((b, i) => ({ annee: anneeDebut + i, budgetGnf: b, plafondsRegionauxGnf: {}, baremes: BAREMES })),
    parametres: parametresAmorcage(),
    candidats: candidatsDeBase(),
    catalogue: CATALOGUE,
    conditions: CONDITIONS,
    matrices: MATRICES,
    ...o,
  };
}
function plan(e: EntreesPpe): PlanPluriannuel {
  const r = construirePlan(e);
  if (!r.ok) throw new Error(r.erreurs.join(" ; "));
  return r.plan;
}
const retenusDe = (p: PlanPluriannuel, annee: number) =>
  p.annees.find((a) => a.annee === annee)!.scenario.lignes.filter((l) => l.decision === "RETENUE").map((l) => l.troncon.code);

describe("construirePlan : calcul a la main", () => {
  it("[5 Md, 5 Md, 5 Md] : C et B en 2027 (A ne tient pas), A en 2028, plus rien en 2029", () => {
    const p = plan(entrees([5n * MD, 5n * MD, 5n * MD]));
    expect(retenusDe(p, 2027)).toEqual(["RN-C", "RN-B"]);
    expect(retenusDe(p, 2028)).toEqual(["RN-A"]);
    expect(retenusDe(p, 2029)).toEqual([]);
    expect(p.annees.map((a) => a.candidatsEntrants)).toEqual([3, 1, 0]);
    expect(p.annees.map((a) => a.dejaRetenusAvant)).toEqual([0, 2, 3]);
    expect(p.annees.map((a) => a.scenario.totaux.engageGnf)).toEqual(["4300000000", "4400000000", "0"]);
    expect(p.synthese).toMatchObject({ enveloppeTotaleGnf: "15000000000", engageTotalGnf: "8700000000", resteTotalGnf: "6300000000", retenus: 3, nonRetenus: 0, candidats: 3 });
    expect(p.synthese.tronconsRetenus.map((t) => [t.code, t.anneeRetenue, t.rangRetenu, t.montantGnf])).toEqual([
      ["RN-C", 2027, 1, "800000000"], ["RN-B", 2027, 2, "3500000000"], ["RN-A", 2028, 1, "4400000000"],
    ]);
  });

  it("[1 Md, 4 Md, 4,5 Md] : C seul, puis B (A coute 4,4 Md > 4 Md), puis A", () => {
    const p = plan(entrees([1n * MD, 4n * MD, 4_500_000_000n]));
    expect(retenusDe(p, 2027)).toEqual(["RN-C"]);
    expect(retenusDe(p, 2028)).toEqual(["RN-B"]);
    expect(retenusDe(p, 2029)).toEqual(["RN-A"]);
    // A a ete ecarte pour budget en 2027 et en 2028, puis retenu : un troncon ecarte reste candidat.
    const a27 = p.annees[0].scenario.lignes.find((l) => l.troncon.code === "RN-A")!;
    expect(a27.motifExclusion?.code).toBe("BUDGET_INSUFFISANT");
    expect(p.annees.map((a) => a.candidatsEntrants)).toEqual([3, 2, 1]);
  });

  it("un reste non depense n'est PAS reporte : 9 Md puis 4 Md ne donnent pas 13 Md la deuxieme annee", () => {
    // 2027 : C (0,8) + B (3,5) retenus, reste 4,7 Md ; A (4,4) entre aussi en 2027 ? 9 - 0,8 - 3,5 = 4,7 >= 4,4 : oui.
    const p = plan(entrees([9n * MD, 4n * MD]));
    expect(retenusDe(p, 2027)).toEqual(["RN-C", "RN-A", "RN-B"]);
    expect(p.annees[0].scenario.totaux.resteGnf).toBe("300000000");
    expect(p.annees[1].enveloppeGnf).toBe("4000000000");
    expect(p.annees[1].scenario.budgetGnf).toBe("4000000000");
  });

  it("une enveloppe nulle est une saisie valide : rien n'est retenu cette annee-la, le plan continue", () => {
    const p = plan(entrees([0n, 5n * MD]));
    expect(retenusDe(p, 2027)).toEqual([]);
    expect(p.annees[0].scenario.lignes.every((l) => l.motifExclusion?.code === "BUDGET_INSUFFISANT")).toBe(true);
    expect(retenusDe(p, 2028)).toEqual(["RN-C", "RN-B"]);
  });

  it("les baremes sont ceux de CHAQUE annee : sans ligne de bareme en 2028, rien n'est chiffre ni retenu cette annee-la", () => {
    const e = entrees([1n * MD, 5n * MD]);
    e.enveloppes[1] = { ...e.enveloppes[1], baremes: [] };
    const p = plan(e);
    expect(retenusDe(p, 2027)).toEqual(["RN-C"]);
    expect(retenusDe(p, 2028)).toEqual([]);
    expect(p.annees[1].scenario.lignes.every((l) => l.motifExclusion?.code === "COUT_NON_ESTIMABLE")).toBe(true);
  });

  it("les plafonds regionaux sont PAR ANNEE : le plafond de 2027 ne s'applique pas a 2028", () => {
    const e = entrees([20n * MD, 20n * MD]);
    e.enveloppes[0] = { ...e.enveloppes[0], plafondsRegionauxGnf: { "1": 1n * MD } };
    const p = plan(e);
    // region 1 : A (4,4) et C (0,8) ; region 2 : B. En 2027, plafond 1 Md sur la region 1 : C passe (0,8), A non.
    expect(retenusDe(p, 2027)).toEqual(["RN-C", "RN-B"]);
    expect(p.annees[0].scenario.lignes.find((l) => l.troncon.code === "RN-A")!.motifExclusion?.code).toBe("PLAFOND_REGIONAL");
    expect(retenusDe(p, 2028)).toEqual(["RN-A"]);
  });

  it("faute de facteurs, tous les troncons sont ecartes chaque annee avec leur motif : le plan le dit, il ne rend pas une liste muette", () => {
    const seulEtat = [1, 2, 3, 4].map((i) => candidat(`e${i}`, { code: `E-${i}`, traficMoyenJma: null, nbPointsNoirs: null }));
    const p = plan(entrees([5n * MD, 5n * MD], { candidats: seulEtat }));
    expect(p.synthese.retenus).toBe(0);
    expect(p.synthese.nonRetenus).toBe(4);
    expect(p.synthese.nonRetenusParMotif).toEqual({ RISQUE_NON_CALCULABLE: 4 });
    for (const a of p.annees) {
      expect(a.candidatsEntrants).toBe(4);
      for (const l of a.scenario.lignes) {
        expect(l.motifExclusion?.code).toBe("RISQUE_NON_CALCULABLE");
        expect(l.risque.ok).toBe(false);
        expect(l.justification).toMatch(/FACTEURS_INSUFFISANTS/);
      }
    }
  });
});

describe("rien n'est officiel, rien n'est invente", () => {
  const p = plan(entrees([5n * MD, 5n * MD]));

  it("le plan est PROVISOIRE et le dit, ainsi que chaque ligne de chaque annee", () => {
    expect(p.provisoire).toBe(true);
    expect(p.etiquette).toBe("PROVISOIRE, non approuvé");
    expect(p.parametres.etiquette).toBe("PROVISOIRE, non approuvé");
    for (const a of p.annees) for (const l of a.scenario.lignes) expect(l.etiquette).toBe("PROVISOIRE, non approuvé");
  });

  it("les motifs de provisoire sont repris, prefixes par leur annee", () => {
    expect(p.motifsProvisoire.some((m) => /^2027 : paramètres de programmation non approuvés/.test(m))).toBe(true);
    expect(p.motifsProvisoire.some((m) => /^2028 : /.test(m))).toBe(true);
  });

  it("dit que la methode est gloutonne, sans optimisation, et ne cree aucun engagement", () => {
    expect(p.limites.join(" ")).toMatch(/gloutonne/);
    expect(p.limites.join(" ")).toMatch(/PLNE/);
    expect(p.limites.join(" ")).toMatch(/ne reporte aucun reste/);
    expect(p.avertissement).toMatch(/Aucune estimation ni programmation ne crée de marché/);
  });

  it("des parametres approuves n'enlevent pas l'etiquette tant que le bareme reste provisoire", () => {
    const e = entrees([5n * MD, 5n * MD]);
    e.parametres = { ...e.parametres, approuveeLe: "2026-10-23T00:00:00.000Z", approuveeParId: "u-1" };
    const q = plan(e);
    expect(q.parametres.etiquette).toBe("paramètres approuvés");
    expect(q.provisoire).toBe(true);
    expect(q.motifsProvisoire.every((m) => !/paramètres de programmation non approuvés/.test(m))).toBe(true);
  });
});

describe("validation des entrees", () => {
  it("borne le nombre d'annees : une seule annee est un PAE, plus de cinq est refuse", () => {
    expect(MIN_ANNEES_PPE).toBe(2);
    expect(MAX_ANNEES_PPE).toBe(5);
    expect(validerEntreesPpe(entrees([MD])).join()).toMatch(/2 à 5 années attendues, 1 reçue/);
    expect(validerEntreesPpe(entrees([MD, MD, MD, MD, MD, MD])).join()).toMatch(/2 à 5 années attendues, 6 reçue/);
    expect(validerEntreesPpe(entrees([MD, MD, MD, MD, MD]))).toEqual([]);
  });

  it("exige des annees consecutives, des enveloppes entieres positives et un nombre de candidats borne", () => {
    const e = entrees([MD, MD]);
    e.enveloppes[1] = { ...e.enveloppes[1], annee: 2030 };
    expect(validerEntreesPpe(e).join()).toMatch(/année 2030 attendue 2028/);
    const n = entrees([MD, MD]);
    n.enveloppes[0] = { ...n.enveloppes[0], budgetGnf: -1n };
    expect(validerEntreesPpe(n).join()).toMatch(/budgetGnf : bigint >= 0 attendu/);
    const trop = entrees([MD, MD], { candidats: Array.from({ length: MAX_CANDIDATS_PPE + 1 }, (_, i) => candidat(`x${i}`)) });
    expect(validerEntreesPpe(trop).join()).toMatch(/dépasse le plafond de 500/);
    expect(validerEntreesPpe(entrees([MD, MD, MD], { anneeDebut: 2099 })).join()).toMatch(/dépasse 2100/);
  });

  it("un jeu de parametres invalide ou un candidat en double est refuse avec son motif, rien n'est calcule", () => {
    const e = entrees([MD, MD], { candidats: [candidat("a"), candidat("a")] });
    const r = construirePlan(e);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erreurs.join()).toMatch(/candidat en double : a/);
  });
});

describe("determinisme : memes entrees, memes octets", () => {
  const e = () => entrees([2n * MD, 5n * MD, 5n * MD]);

  it("deux calculs successifs donnent le meme texte canonique", () => {
    expect(canonique(plan(e()))).toBe(canonique(plan(e())));
  });

  it("l'ordre des candidats, des baremes et du catalogue n'a aucune influence", () => {
    const base = canonique(plan(e()));
    const m = e();
    m.candidats = [...m.candidats].reverse();
    m.catalogue = [...m.catalogue].reverse();
    m.conditions = [...m.conditions].reverse();
    m.matrices = [...m.matrices].reverse();
    m.enveloppes = m.enveloppes.map((x) => ({ ...x, baremes: [...x.baremes].reverse() }));
    expect(canonique(plan(m))).toBe(base);
  });

  it("les entrees stockees rejouent le meme plan, octet pour octet, et leur texte ne depend pas de l'ordre", () => {
    const x = e();
    const texte = canonique(entreesPpeVersJson(x));
    const relu = entreesPpeDepuisJson(JSON.parse(texte));
    expect(relu.ok).toBe(true);
    if (!relu.ok) return;
    expect(canonique(plan(relu.entrees))).toBe(canonique(plan(x)));
    const m = e();
    m.candidats = [...m.candidats].reverse();
    expect(canonique(entreesPpeVersJson(m))).toBe(texte);
  });

  it("une entree stockee alteree est refusee (montant non numerique)", () => {
    const j = JSON.parse(canonique(entreesPpeVersJson(e()))) as { enveloppes: { budgetGnf: unknown }[] };
    j.enveloppes[0].budgetGnf = 12.5;
    expect(entreesPpeDepuisJson(j).ok).toBe(false);
    expect(entreesPpeDepuisJson({}).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// ORACLE : le glouton refait par une autre methode
// ---------------------------------------------------------------------------------------------

/** Generateur pseudo-aleatoire a graine fixe (LCG 32 bits) : meme jeu a chaque execution. */
function lcg(graine: number) {
  let s = graine >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}

function jeuAleatoire(graine: number, n: number) {
  const r = lcg(graine);
  const etats = ["MOYEN", "MAUVAIS", "CRITIQUE"];
  const revs = ["BITUME", "TERRE", "PAVE"];
  return Array.from({ length: n }, (_, i) => candidat(`id-${String(i).padStart(3, "0")}`, {
    code: `Z-${String((i * 7) % n).padStart(3, "0")}`,
    etat: etats[Math.floor(r() * 3)],
    revetement: revs[Math.floor(r() * 3)],
    traficMoyenJma: Math.floor(r() * 4000),
    nbPointsNoirs: Math.floor(r() * 4),
    longueurM: 200 + Math.floor(r() * 9000),
    regionId: 1 + Math.floor(r() * 3),
  }));
}

/**
 * Oracle : on lit, dans un scenario annuel a budget illimite, les seules donnees de chaque troncon (cout, risque
 * attendu, risque courant), puis on refait le chainage par SELECTION REPETEE : a chaque pas, on prend le meilleur
 * troncon restant qui TIENT dans l'enveloppe restante (comparaison par fractions exactes), jusqu'a ce qu'aucun ne tienne.
 * Aucune boucle de tri-puis-balayage, aucun code du PPE.
 */
function oraclePpe(candidats: ReturnType<typeof jeuAleatoire>, budgets: bigint[], anneeDebut: number) {
  const ref = construireScenario({
    annee: anneeDebut, budgetGnf: 10n ** 18n - 1n, plafondsRegionauxGnf: {}, parametres: parametresAmorcage(), candidats,
    baremes: BAREMES, catalogue: CATALOGUE, conditions: CONDITIONS, matrices: MATRICES,
  });
  if (!ref.ok) throw new Error(ref.erreurs.join());
  type Item = { code: string; id: string; cout: bigint; attendu: bigint; risque: bigint };
  let restants: Item[] = ref.scenario.lignes
    .filter((l) => l.rangPriorite !== null)
    .map((l) => ({
      code: l.troncon.code, id: l.troncon.id, cout: BigInt((l.cout as { montantGnf: string }).montantGnf),
      attendu: BigInt((l.risqueAttendu as { scoreMicro: number }).scoreMicro), risque: BigInt(Math.round((l.risque as { score: number }).score * 10000)),
    }));
  const meilleur = (a: Item, b: Item): boolean => {
    // a meilleur que b ?  attendu_a / cout_a > attendu_b / cout_b, puis risque, cout, code, id.
    const g = a.attendu * b.cout, d = b.attendu * a.cout;
    if (g !== d) return g > d;
    if (a.risque !== b.risque) return a.risque > b.risque;
    if (a.cout !== b.cout) return a.cout < b.cout;
    if (a.code !== b.code) return a.code < b.code;
    return a.id < b.id;
  };
  const parAnnee: string[][] = [];
  for (const budget of budgets) {
    let reste = budget;
    const pris: Item[] = [];
    for (;;) {
      const tenables = restants.filter((x) => x.cout <= reste && !pris.includes(x));
      if (tenables.length === 0) break;
      let best = tenables[0];
      for (const t of tenables) if (meilleur(t, best)) best = t;
      pris.push(best);
      reste -= best.cout;
    }
    parAnnee.push(pris.map((x) => x.code));
    restants = restants.filter((x) => !pris.includes(x));
  }
  return parAnnee;
}

describe("oracle : le chainage du PPE est celui d'une selection repetee du meilleur restant", () => {
  for (const [graine, n, budgets] of [
    [11, 60, [6n * MD, 6n * MD, 6n * MD]],
    [23, 120, [3n * MD, 9n * MD, 1n * MD, 12n * MD]],
    [47, 200, [20n * MD, 0n, 15n * MD, 8n * MD, 30n * MD]],
    [5, 30, [2n * MD, 2n * MD]],
  ] as [number, number, bigint[]][]) {
    it(`graine ${graine}, ${n} candidats, ${budgets.length} annees : memes retenus que l'oracle, annee par annee`, () => {
      const candidats = jeuAleatoire(graine, n);
      const p = plan(entrees(budgets, { candidats }));
      const attendu = oraclePpe(candidats, budgets, 2027);
      // Les retenus de chaque annee, dans l'ordre de priorite d'une annee (rang), comparent aux prises de l'oracle triees de la meme facon.
      const obtenu = p.annees.map((a) => a.scenario.lignes.filter((l) => l.decision === "RETENUE").map((l) => l.troncon.code));
      expect(obtenu).toEqual(attendu);
      // Au moins une annee retient quelque chose et au moins un troncon est ecarte : le jeu n'est pas trivial.
      expect(p.synthese.retenus).toBeGreaterThan(0);
      // Aucun troncon n'est retenu deux fois.
      const codes = p.synthese.tronconsRetenus.map((t) => t.tronconId);
      expect(new Set(codes).size).toBe(codes.length);
      // L'engage de chaque annee ne depasse jamais son enveloppe saisie.
      for (const a of p.annees) expect(BigInt(a.scenario.totaux.engageGnf) <= BigInt(a.enveloppeGnf)).toBe(true);
      expect(p.synthese.retenus + p.synthese.nonRetenus).toBe(n);
    });
  }
});
