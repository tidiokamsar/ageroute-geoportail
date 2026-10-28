import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLASSES_EVALUEES, PARAMETRES_KPI, agregerEtat, ageEnJours, avertissementsEtat, classerEtat, decrirePerimetre,
  differenceGnf, indicateursReseau, nombreSur, sommeGnf, type LigneEtat, type ParametresKpi,
} from "./kpi.noyau";

/**
 * NOYAU PUR des formules : zero, un, beaucoup de troncons, tout non evalue, etat absent, longueur absente, eligible nul,
 * pourcentage jamais superieur a 100, numerateur et denominateur sur le meme perimetre. Aucune base : les lignes sont
 * celles que `kpi.depot.ts` rend (groupes categoriels). Les formules sont rejouees contre PostGIS par
 * `tests-integration/aide-decision-kpi.integration.mts`.
 */

function ligne(o: Partial<LigneEtat> & { km?: number }): LigneEtat {
  return {
    regionId: 1, etat: "BON", provenance: "OBSERVED", observeDate: true, statutValidation: null, longueurConnue: true,
    nb: 1, km: 10, derniereEvaluation: null, plusAncienneEvaluation: null, ...o,
  };
}
const observe = (etat: string, km: number, extra: Partial<LigneEtat> = {}) => ligne({ etat, km, ...extra });

describe("classerEtat : qu'est-ce qu'un etat valide (regle PROVISOIRE, la plus prudente par defaut)", () => {
  it("le defaut est l'exigence la plus prudente : seul un etat CONSTATE ET DATE est valide", () => {
    expect(PARAMETRES_KPI.exigenceEtat).toBe("OBSERVE_SEULEMENT");
    expect(PARAMETRES_KPI.statutDefinition).toBe("PROVISOIRE");
    expect(classerEtat({ etat: "MAUVAIS", provenance: "OBSERVED", observeDate: true, statutValidation: null })).toEqual({ categorie: "VALIDE", classe: "MAUVAIS" });
  });

  it.each([
    ["IMPORTED_UNVERIFIED", "ETAT_NON_CONSTATE"],
    ["DERIVED", "ETAT_NON_CONSTATE"],
    ["SANS_LIGNE", "ETAT_NON_CONSTATE"],
    ["CONFLICTING", "ETAT_EN_CONFLIT"],
    ["UNKNOWN", "ETAT_INCOHERENT_AVEC_LA_QUALITE"],
  ])("un etat de provenance %s n'est pas valide (motif %s)", (provenance, motif) => {
    expect(classerEtat({ etat: "CRITIQUE", provenance, observeDate: true, statutValidation: null })).toEqual({ categorie: "NON_VALIDE", classe: "CRITIQUE", motif });
  });

  it("un constat sans date n'est pas valide", () => {
    expect(classerEtat({ etat: "BON", provenance: "OBSERVED", observeDate: false, statutValidation: null })).toEqual({ categorie: "NON_VALIDE", classe: "BON", motif: "CONSTAT_SANS_DATE" });
  });

  it.each(["REJETE", "A_CORRIGER"])("un troncon %s n'a pas d'etat valide, meme observe", (sv) => {
    expect(classerEtat({ etat: "BON", provenance: "OBSERVED", observeDate: true, statutValidation: sv }).categorie).toBe("NON_VALIDE");
  });

  it.each(["A_VALIDER", "VALIDE", null])("un statut de validation %s n'ecarte pas un etat constate", (sv) => {
    expect(classerEtat({ etat: "BON", provenance: "OBSERVED", observeDate: true, statutValidation: sv }).categorie).toBe("VALIDE");
  });

  it.each([["NON_EVALUE"], [null], [""], ["INCONNU"], ["bon"]])("l'etat %j est non evalue (jamais assimile a bon)", (etat) => {
    expect(classerEtat({ etat, provenance: "OBSERVED", observeDate: true, statutValidation: null })).toEqual({ categorie: "NON_EVALUE" });
  });

  it("l'exigence NON_CONTESTE accepte l'importe non verifie, le derive et l'absence de ligne, mais ni le conflit ni l'incoherence", () => {
    const p = { exigenceEtat: "NON_CONTESTE" } as const;
    for (const prov of ["OBSERVED", "IMPORTED_UNVERIFIED", "DERIVED", "SANS_LIGNE"]) {
      expect(classerEtat({ etat: "MOYEN", provenance: prov, observeDate: false, statutValidation: null }, p).categorie, prov).toBe("VALIDE");
    }
    for (const prov of ["CONFLICTING", "UNKNOWN"]) {
      expect(classerEtat({ etat: "MOYEN", provenance: prov, observeDate: false, statutValidation: null }, p).categorie, prov).toBe("NON_VALIDE");
    }
  });

  it("echoue FERME : une provenance inconnue n'est jamais valide", () => {
    expect(classerEtat({ etat: "BON", provenance: "AUTRE", observeDate: true, statutValidation: null }, { exigenceEtat: "NON_CONTESTE" }).categorie).toBe("NON_VALIDE");
    expect(classerEtat({ etat: "BON", provenance: "AUTRE", observeDate: true, statutValidation: null }).categorie).toBe("NON_VALIDE");
  });
});

describe("indicateursReseau : cas limites", () => {
  it("ZERO troncon : aucune valeur, jamais 0, avertissement explicite", () => {
    const { total } = agregerEtat([]);
    const i = indicateursReseau(total);
    expect(i.degradePct).toBeNull();
    expect(i.critiquePct).toBeNull();
    expect(i.partNonEvaluee).toBeNull();
    expect(i.couvertureEtatPart).toBeNull();
    expect(i.etat).toBe("NON_DISPONIBLE");
    expect(total.troncons).toBe(0);
    expect(avertissementsEtat(total, i)[0]).toMatch(/Aucun tronçon/);
  });

  it("UN troncon mauvais constate : 100 % degrade, rien de non evalue, etat DISPONIBLE", () => {
    const i = indicateursReseau(agregerEtat([observe("MAUVAIS", 12.5)]).total);
    expect(i.degradePct).toBe(100);
    expect(i.critiquePct).toBe(0);
    expect(i.critiqueKm).toBe(0);
    expect(i.eligibleKm).toBe(12.5);
    expect(i.etat).toBe("DISPONIBLE");
    expect(i.partNonEvaluee).toBe(0);
  });

  it("un troncon BON constate : degrade 0 % (une vraie valeur : le denominateur existe)", () => {
    const i = indicateursReseau(agregerEtat([observe("BON", 4)]).total);
    expect(i.degradePct).toBe(0);
    expect(i.critiquePct).toBe(0);
  });

  it("TOUT non evalue : valeur nulle, etat NON_DISPONIBLE, part non evaluee 1", () => {
    const { total } = agregerEtat([ligne({ etat: "NON_EVALUE", provenance: "UNKNOWN", nb: 40, km: 300 }), ligne({ etat: null, nb: 2, km: 8 })]);
    const i = indicateursReseau(total);
    expect(i.degradePct).toBeNull();
    expect(i.critiquePct).toBeNull();
    expect(i.eligibleKm).toBe(0);
    expect(i.nonEvalueKm).toBe(308);
    expect(i.partNonEvaluee).toBe(1);
    expect(i.etat).toBe("NON_DISPONIBLE");
    expect(total.nonEvalue.troncons).toBe(42);
    expect(avertissementsEtat(total, i).join(" ")).toMatch(/pas calculable/);
  });

  it("un etat absent (null) est non evalue, pas un bon etat", () => {
    const { total } = agregerEtat([ligne({ etat: null, nb: 3, km: 6 }), observe("CRITIQUE", 4)]);
    expect(total.nonEvalue.troncons).toBe(3);
    const i = indicateursReseau(total);
    expect(i.eligibleKm).toBe(4);
    expect(i.degradePct).toBe(100);
    expect(i.partNonEvaluee).toBe(0.6);
    expect(i.etat).toBe("PARTIEL");
  });

  it("une longueur ABSENTE : le troncon est compte, sa longueur n'est jamais additionnee, la geometrique ne la remplace pas", () => {
    const { total } = agregerEtat([
      observe("CRITIQUE", 5),
      ligne({ etat: "CRITIQUE", longueurConnue: false, nb: 4, km: 0 }),
      ligne({ etat: "BON", longueurConnue: false, nb: 1, km: 999 }), // km fourni a tort : ignore, la longueur est inconnue
    ]);
    const i = indicateursReseau(total);
    expect(total.troncons).toBe(1 + 4 + 1);
    expect(total.tronconsSansLongueur).toBe(5);
    expect(total.valide.tronconsSansLongueur).toBe(5);
    expect(i.eligibleKm).toBe(5);
    expect(i.degradePct).toBe(100);
    expect(i.etat).toBe("PARTIEL");
    expect(total.longueurConnueKm).toBe(5);
    expect(avertissementsEtat(total, i).join(" ")).toMatch(/5 tronçons sans longueur métier/);
  });

  it("eligible NUL avec des troncons valides mais sans longueur : valeur nulle (pas 0 %)", () => {
    const { total } = agregerEtat([ligne({ etat: "CRITIQUE", longueurConnue: false, nb: 7, km: 0 })]);
    const i = indicateursReseau(total);
    expect(total.valide.troncons).toBe(7);
    expect(i.eligibleKm).toBe(0);
    expect(i.degradePct).toBeNull();
    expect(i.etat).toBe("NON_DISPONIBLE");
  });

  it("des longueurs non finies ou negatives venues du SQL n'entrent jamais dans une somme", () => {
    const { total } = agregerEtat([observe("BON", Number.NaN), observe("MAUVAIS", -3), observe("MAUVAIS", 6), observe("MAUVAIS", Number.POSITIVE_INFINITY)]);
    expect(total.valide.km).toBe(6);
    expect(total.tronconsSansLongueur).toBe(3); // ces trois lignes sont lues comme « longueur inconnue »
    expect(indicateursReseau(total).degradePct).toBe(100);
  });

  it("des lignes sans troncon (nb <= 0 ou non fini) sont ignorees", () => {
    const { total } = agregerEtat([ligne({ nb: 0 }), ligne({ nb: -2 }), ligne({ nb: Number.NaN }), observe("BON", 1)]);
    expect(total.troncons).toBe(1);
  });

  it("numerateur et denominateur : un etat non valide (voirie, importe) n'entre ni dans l'un ni dans l'autre", () => {
    const { total } = agregerEtat([
      observe("MAUVAIS", 30),
      observe("BON", 70),
      ligne({ etat: "CRITIQUE", provenance: "IMPORTED_UNVERIFIED", km: 500 }), // non valide : exclu des deux
    ]);
    const i = indicateursReseau(total);
    expect(i.eligibleKm).toBe(100);
    expect(i.degradeKm).toBe(30);
    expect(i.degradePct).toBe(30);
    expect(i.etatNonValideKm).toBe(500);
    expect(i.evalueKm).toBe(600);
    expect(i.partNonEvaluee).toBe(0);
    expect(total.etatNonValide.parClasse.CRITIQUE.km).toBe(500);
    expect(total.etatNonValide.parMotif.ETAT_NON_CONSTATE).toEqual({ troncons: 1, km: 500 });
  });

  it("parametre NON_CONTESTE : le meme jeu de lignes change de valeur, et la regle est une donnee, pas du code disperse", () => {
    const lignes = [observe("MAUVAIS", 30), observe("BON", 70), ligne({ etat: "CRITIQUE", provenance: "IMPORTED_UNVERIFIED", km: 100 })];
    const strict = indicateursReseau(agregerEtat(lignes).total);
    const p: ParametresKpi = { ...PARAMETRES_KPI, exigenceEtat: "NON_CONTESTE" };
    const souple = indicateursReseau(agregerEtat(lignes, p).total, p);
    expect(strict.degradePct).toBe(30);
    expect(souple.degradePct).toBe(65); // (30 + 100) / 200
    expect(souple.critiqueKm).toBe(100);
  });

  it("classes degradees et critiques sont des parametres : on les change sans toucher aux formules", () => {
    const lignes = [observe("MOYEN", 50), observe("MAUVAIS", 30), observe("CRITIQUE", 20)];
    expect(indicateursReseau(agregerEtat(lignes).total).degradePct).toBe(50);
    const p: ParametresKpi = { ...PARAMETRES_KPI, classesDegradees: ["CRITIQUE"] as const };
    expect(indicateursReseau(agregerEtat(lignes, p).total, p).degradePct).toBe(20);
  });

  it("le pourcentage est arrondi a 0,1 et ne depasse JAMAIS 100", () => {
    const i = indicateursReseau(agregerEtat([observe("CRITIQUE", 2), observe("BON", 1)]).total);
    expect(i.degradePct).toBe(66.7);
    const tout = indicateursReseau(agregerEtat([observe("CRITIQUE", 0.1), observe("MAUVAIS", 0.2), observe("CRITIQUE", 0.3)]).total);
    expect(tout.degradePct).toBeLessThanOrEqual(100);
    expect(tout.degradePct).toBe(100);
  });

  it("BEAUCOUP de troncons : invariants sur 5 000 groupes tires de facon deterministe", () => {
    let graine = 12345;
    const alea = () => { graine = (graine * 1103515245 + 12345) & 0x7fffffff; return graine / 0x7fffffff; };
    const etats = ["BON", "MOYEN", "MAUVAIS", "CRITIQUE", "NON_EVALUE", null];
    const provs = ["OBSERVED", "IMPORTED_UNVERIFIED", "DERIVED", "CONFLICTING", "UNKNOWN", "SANS_LIGNE"];
    const svs = [null, "A_VALIDER", "VALIDE", "REJETE", "A_CORRIGER"];
    const lignes: LigneEtat[] = Array.from({ length: 5000 }, () => {
      const connue = alea() > 0.2;
      return ligne({
        regionId: 1 + Math.floor(alea() * 8), etat: etats[Math.floor(alea() * etats.length)], provenance: provs[Math.floor(alea() * provs.length)],
        observeDate: alea() > 0.3, statutValidation: svs[Math.floor(alea() * svs.length)], longueurConnue: connue,
        nb: 1 + Math.floor(alea() * 30), km: connue ? Math.round(alea() * 5000) / 10 : 0,
      });
    });
    for (const exigence of ["OBSERVE_SEULEMENT", "NON_CONTESTE"] as const) {
      const p: ParametresKpi = { ...PARAMETRES_KPI, exigenceEtat: exigence };
      const { total, parRegion } = agregerEtat(lignes, p);
      const i = indicateursReseau(total, p);
      const nbTotal = lignes.reduce((s, l) => s + l.nb, 0);
      expect(total.troncons).toBe(nbTotal);
      expect(total.nonEvalue.troncons + total.etatNonValide.troncons + total.valide.troncons).toBe(nbTotal);
      expect(i.degradePct as number).toBeLessThanOrEqual(100);
      expect(i.degradePct as number).toBeGreaterThanOrEqual(0);
      expect(i.critiquePct as number).toBeLessThanOrEqual(i.degradePct as number);
      expect(i.degradeKm).toBeLessThanOrEqual(i.eligibleKm + 1e-9);
      expect(i.eligibleKm).toBeLessThanOrEqual(i.evalueKm + 1e-9);
      expect(i.evalueKm + i.nonEvalueKm).toBeCloseTo(i.perimetreKm, 6);
      expect(i.perimetreKm).toBeCloseTo(total.longueurConnueKm, 6);
      // MEME PERIMETRE : la somme des regions egale le total, pour le numerateur comme pour le denominateur.
      const sommeEligible = parRegion.reduce((s, r) => s + r.bilan.valide.km, 0);
      const sommeDegrade = parRegion.reduce((s, r) => s + indicateursReseau(r.bilan, p).degradeKm, 0);
      expect(sommeEligible).toBeCloseTo(i.eligibleKm, 6);
      expect(sommeDegrade).toBeCloseTo(i.degradeKm, 6);
      for (const r of parRegion) {
        const ir = indicateursReseau(r.bilan, p);
        if (ir.degradePct !== null) expect(ir.degradePct).toBeLessThanOrEqual(100);
        expect(r.bilan.tronconsSansLongueur).toBeLessThanOrEqual(r.bilan.troncons);
      }
    }
  });

  it("parRegion est trie par identifiant et reprend les memes lignes", () => {
    const { parRegion } = agregerEtat([observe("BON", 1, { regionId: 5 }), observe("BON", 1, { regionId: 2 })]);
    expect(parRegion.map((r) => r.regionId)).toEqual([2, 5]);
  });

  it("la repartition des classes couvre les quatre classes evaluees, NON_EVALUE n'est pas une classe", () => {
    expect([...CLASSES_EVALUEES]).toEqual(["BON", "MOYEN", "MAUVAIS", "CRITIQUE"]);
  });
});

describe("fraicheur", () => {
  it("garde la date d'evaluation la plus recente et la plus ancienne des seuls troncons valides", () => {
    const d = (s: string) => new Date(s);
    const { total } = agregerEtat([
      observe("BON", 1, { derniereEvaluation: d("2026-01-10T00:00:00Z"), plusAncienneEvaluation: d("2025-06-01T00:00:00Z") }),
      observe("MAUVAIS", 1, { derniereEvaluation: d("2026-09-30T00:00:00Z"), plusAncienneEvaluation: d("2026-02-01T00:00:00Z") }),
      ligne({ etat: "BON", provenance: "IMPORTED_UNVERIFIED", derniereEvaluation: d("2026-10-25T00:00:00Z"), plusAncienneEvaluation: d("2020-01-01T00:00:00Z") }), // non valide : ignore
    ]);
    expect(total.derniereEvaluationValide?.toISOString()).toBe("2026-09-30T00:00:00.000Z");
    expect(total.plusAncienneEvaluationValide?.toISOString()).toBe("2025-06-01T00:00:00.000Z");
    expect(ageEnJours(total.derniereEvaluationValide, new Date("2026-10-26T00:00:00Z"))).toBe(26);
  });

  it("aucune date : age null (jamais 0)", () => {
    expect(ageEnJours(null, new Date())).toBeNull();
    expect(agregerEtat([observe("BON", 1)]).total.derniereEvaluationValide).toBeNull();
  });

  it("une date future ne donne pas un age negatif", () => {
    expect(ageEnJours(new Date("2027-01-01T00:00:00Z"), new Date("2026-10-26T00:00:00Z"))).toBe(0);
  });
});

describe("montants GNF", () => {
  it("la somme est exacte au-dela de 2^53", () => {
    expect(sommeGnf(["9007199254740993", "10", 5n])).toBe("9007199254741008");
    expect(sommeGnf([])).toBe("0");
  });
  it("la difference est bornee a zero", () => {
    expect(differenceGnf("100", "30")).toBe("70");
    expect(differenceGnf("10", "30")).toBe("0");
  });
  it("le nombre equivalent n'est rendu que s'il est exact", () => {
    expect(nombreSur("123456789")).toBe(123456789);
    expect(nombreSur("9007199254740993")).toBeNull();
  });
});

describe("decrirePerimetre", () => {
  const noms = new Map([[1, "Boké"], [2, "Kindia"]]);
  it("le pays entier est dit tel", () => {
    expect(decrirePerimetre(null, noms)).toEqual({ national: true, libelle: "Ensemble du pays", regionId: null, regions: [] });
  });
  it("une region ne se dit jamais « pays » ; plusieurs regions listent leurs noms", () => {
    expect(decrirePerimetre([1], noms)).toMatchObject({ national: false, libelle: "Région Boké", regionId: 1 });
    const deux = decrirePerimetre([2, 1], noms);
    expect(deux.libelle).toBe("Régions du périmètre : Boké, Kindia");
    expect(deux.regionId).toBeNull();
    expect(deux.libelle).not.toMatch(/pays/i);
  });
  it("une region sans nom connu garde son identifiant", () => {
    expect(decrirePerimetre([9], noms).libelle).toBe("Région 9");
  });
});

describe("pureté du noyau", () => {
  const source = readFileSync(join(__dirname, "kpi.noyau.ts"), "utf8");
  it("n'importe rien, ne lit ni l'horloge ni le hasard", () => {
    expect(source).not.toMatch(/^import /m);
    expect(source).not.toMatch(/\bnew Date\(\)|Date\.now|Math\.random/);
  });
  it("ne contient aucun repli « || 0 » sur une absence", () => {
    expect(source).not.toMatch(/\|\|\s*0\b/);
  });
});
