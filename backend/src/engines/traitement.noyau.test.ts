import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { choisirTraitement, classeTraficDe, projeterDegradation, type ConditionTraitement } from "./traitement.noyau";
import { CATALOGUE, CONDITIONS, MATRICES } from "../programmation/scenario.fixtures";

/**
 * Ce que ces tests defendent :
 *   - la matrice d'orientation est une FONCTION : deux traitements possibles = refus, le moteur ne choisit pas ;
 *   - la classe de trafic ne se devine pas : sans comptage, aucune matrice de degradation n'est choisie ;
 *   - les attributs nuls du catalogue sont DITS non utilises, jamais combles ;
 *   - la projection de degradation reprend les probabilites de la matrice, a la main.
 */
describe("Le noyau ne depend d'aucune base", () => {
  it("n'importe que le noyau du risque (arrondi)", () => {
    const src = readFileSync(join(__dirname, "traitement.noyau.ts"), "utf8");
    const imports = [...src.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports).toEqual(["./risque.noyau"]);
  });
});

const SEUILS = { t1MaxJma: 500, t2MaxJma: 2000 };

describe("classeTraficDe", () => {
  it.each([[0, "T1_faible"], [499, "T1_faible"], [500, "T2_moyen"], [1999, "T2_moyen"], [2000, "T3_fort"], [90000, "T3_fort"]])(
    "%s veh/j -> %s", (jma, attendu) => { expect(classeTraficDe(jma, SEUILS)).toBe(attendu); });

  it("sans comptage, aucune classe : jamais T2 par defaut", () => {
    expect(classeTraficDe(null, SEUILS)).toBeNull();
    expect(classeTraficDe(-3, SEUILS)).toBeNull();
    expect(classeTraficDe(Number.NaN, SEUILS)).toBeNull();
  });
});

describe("choisirTraitement", () => {
  it("applique la condition generale (classe nulle) et dit les attributs non renseignes", () => {
    const r = choisirTraitement({ familleRevetement: "bitume", etat: "MAUVAIS", classeTrafic: "T2_moyen" }, CATALOGUE, CONDITIONS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.traitement.code).toBe("rehabilitation");
      expect(r.traitement.approuve).toBe(false);
      expect(r.condition.portee).toBe("generale");
      expect(r.attributsNonRenseignes).toEqual(["dureeVieAttendueAns", "effetSurIndice", "fenetreRealisation"]);
    }
  });

  it("fonctionne sans classe de trafic connue", () => {
    const r = choisirTraitement({ familleRevetement: "bitume", etat: "CRITIQUE", classeTrafic: null }, CATALOGUE, CONDITIONS);
    expect(r.ok && r.traitement.code).toBe("reconstruction");
  });

  it("une condition qui nomme la classe l'emporte sur la condition generale", () => {
    const cond: ConditionTraitement[] = [
      ...CONDITIONS,
      { traitementCode: "reconstruction", familleRevetement: "bitume", etatDepart: "MAUVAIS", classeTrafic: "T3_fort" },
    ];
    const t3 = choisirTraitement({ familleRevetement: "bitume", etat: "MAUVAIS", classeTrafic: "T3_fort" }, CATALOGUE, cond);
    expect(t3.ok && t3.traitement.code).toBe("reconstruction");
    expect(t3.ok && t3.condition.portee).toBe("exacte");
    const t1 = choisirTraitement({ familleRevetement: "bitume", etat: "MAUVAIS", classeTrafic: "T1_faible" }, CATALOGUE, cond);
    expect(t1.ok && t1.traitement.code).toBe("rehabilitation");
  });

  it("BON : aucune condition, donc aucun traitement (on ne traite pas ce qui est bon)", () => {
    const r = choisirTraitement({ familleRevetement: "bitume", etat: "BON", classeTrafic: null }, CATALOGUE, CONDITIONS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("AUCUNE_CONDITION");
  });

  it("famille de cout absente (revetement non renseigne) : refus", () => {
    const r = choisirTraitement({ familleRevetement: null, etat: "MAUVAIS", classeTrafic: null }, CATALOGUE, CONDITIONS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("FAMILLE_COUT_ABSENTE");
  });

  it("deux traitements pour le meme cas : CONDITIONS_AMBIGUES, le moteur ne choisit pas", () => {
    const cond: ConditionTraitement[] = [...CONDITIONS, { traitementCode: "reconstruction", familleRevetement: "bitume", etatDepart: "MAUVAIS", classeTrafic: null }];
    const r = choisirTraitement({ familleRevetement: "bitume", etat: "MAUVAIS", classeTrafic: null }, CATALOGUE, cond);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.code).toBe("CONDITIONS_AMBIGUES"); expect(r.motif).toMatch(/reconstruction/); }
  });

  it("une condition inactive est ignoree ; un traitement inactif ou absent du catalogue est refuse", () => {
    const inactives = CONDITIONS.map((c) => ({ ...c, actif: false }));
    const a = choisirTraitement({ familleRevetement: "bitume", etat: "MAUVAIS", classeTrafic: null }, CATALOGUE, inactives);
    expect(!a.ok && a.code).toBe("AUCUNE_CONDITION");
    const b = choisirTraitement({ familleRevetement: "bitume", etat: "MAUVAIS", classeTrafic: null }, CATALOGUE.map((t) => ({ ...t, actif: false })), CONDITIONS);
    expect(!b.ok && b.code).toBe("TRAITEMENT_ABSENT_DU_CATALOGUE");
  });

  it("un attribut renseigne n'est plus liste comme non renseigne", () => {
    const cat = CATALOGUE.map((t) => (t.code === "rehabilitation" ? { ...t, dureeVieAttendueAns: 12, approuveLe: "2026-10-23T00:00:00.000Z" } : t));
    const r = choisirTraitement({ familleRevetement: "bitume", etat: "MAUVAIS", classeTrafic: null }, cat, CONDITIONS);
    expect(r.ok && r.attributsNonRenseignes).toEqual(["effetSurIndice", "fenetreRealisation"]);
    expect(r.ok && r.traitement.approuve).toBe(true);
  });
});

describe("projeterDegradation", () => {
  it("lit la bonne probabilite selon l'etat : bitume T3, MAUVAIS -> CRITIQUE a 0,38", () => {
    const r = projeterDegradation({ familleRevetement: "bitume", etat: "MAUVAIS", classeTrafic: "T3_fort", horizonAnnees: 1 }, MATRICES);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.pAnnuelle).toBe(0.38); expect(r.etatSuivant).toBe("CRITIQUE"); expect(r.pHorizon).toBe(0.38); expect(r.matrice.approuvee).toBe(false); }
  });

  it("horizon de 3 ans : 1 - (1 - 0,12)^3 = 0,318528 -> 0,3185", () => {
    const r = projeterDegradation({ familleRevetement: "bitume", etat: "MOYEN", classeTrafic: "T1_faible", horizonAnnees: 3 }, MATRICES);
    expect(r.ok && r.pHorizon).toBe(0.3185);
  });

  it("CRITIQUE est absorbant : probabilite nulle, pas d'etat suivant", () => {
    const r = projeterDegradation({ familleRevetement: "bitume", etat: "CRITIQUE", classeTrafic: "T2_moyen", horizonAnnees: 1 }, MATRICES);
    expect(r.ok && r.pHorizon).toBe(0);
    expect(r.ok && r.etatSuivant).toBeNull();
  });

  it("refuse sans choisir : classe de trafic inconnue, famille inconnue, matrice absente ou ambigue", () => {
    const sansClasse = projeterDegradation({ familleRevetement: "bitume", etat: "MAUVAIS", classeTrafic: null, horizonAnnees: 1 }, MATRICES);
    expect(sansClasse.ok).toBe(false);
    if (!sansClasse.ok) expect(sansClasse.motif).toMatch(/aucun comptage/);
    expect(projeterDegradation({ familleRevetement: null, etat: "MAUVAIS", classeTrafic: "T1_faible", horizonAnnees: 1 }, MATRICES).ok).toBe(false);
    expect(projeterDegradation({ familleRevetement: "bitume", etat: "MAUVAIS", classeTrafic: "T1_faible", horizonAnnees: 1 }, []).ok).toBe(false);
    const doublon = [...MATRICES, { ...MATRICES[0] }];
    expect(projeterDegradation({ familleRevetement: "bitume", etat: "MAUVAIS", classeTrafic: "T1_faible", horizonAnnees: 1 }, doublon).ok).toBe(false);
  });

  it("refuse une probabilite hors de [0 ; 1]", () => {
    const m = MATRICES.map((x, i) => (i === 0 ? { ...x, pMoyenVersMauvais: 1.4 } : x));
    expect(projeterDegradation({ familleRevetement: "bitume", etat: "MOYEN", classeTrafic: "T1_faible", horizonAnnees: 1 }, m).ok).toBe(false);
  });
});
