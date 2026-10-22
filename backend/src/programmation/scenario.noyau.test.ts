import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_CANDIDATS, construireScenario, entreesDepuisJson, entreesVersJson, ratioPointsParMilliard, validerEntrees,
  type EntreesScenario, type LigneScenario, type Scenario,
} from "./scenario.noyau";
import { canonique } from "./canonique";
import { BAREMES, candidat, candidatsDeBase, entreesDeBase } from "./scenario.fixtures";
import { parametresAmorcage } from "./parametres.noyau";

/**
 * Scenario A22 : « programmation reproductible, justifiee ». Ce que ces tests defendent :
 *
 *   - les valeurs sont verifiees contre des calculs poses A LA MAIN (voir scenario.fixtures.ts) ;
 *   - le moteur de cout continue de REFUSER sans bareme : la ligne est ecartee avec son motif, rien n'est chiffre ;
 *   - chaque ligne, retenue ou ecartee, porte une justification, des entrees et la version des parametres ;
 *   - l'ordre est TOTAL : un meme jeu, melange dans n'importe quel ordre, donne les memes octets ;
 *   - rien n'est presente comme officiel : l'etiquette PROVISOIRE est dans le scenario et dans chaque ligne.
 */
describe("Le noyau ne depend d'aucune base", () => {
  it("n'importe que des noyaux purs", () => {
    const src = readFileSync(join(__dirname, "scenario.noyau.ts"), "utf8");
    const imports = [...src.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]).sort();
    expect(imports).toEqual([
      "../engines/cout.noyau", "../engines/famille-cout", "../engines/risque.noyau", "../engines/traitement.noyau", "./parametres.noyau",
    ].sort());
    for (const i of imports) expect(i).not.toMatch(/prisma|express|zod|lib\/|utils\/|middleware/);
  });
});

function construire(e: EntreesScenario): Scenario {
  const r = construireScenario(e);
  if (!r.ok) throw new Error(r.erreurs.join(" ; "));
  return r.scenario;
}
const ligne = (s: Scenario, code: string): LigneScenario => s.lignes.find((l) => l.troncon.code === code)!;

describe("construireScenario : calcul a la main", () => {
  const s = construire(entreesDeBase());

  it("risque : 60,625 / 48,75 / 24,375 ; risque attendu par la matrice : 65,375 / 48,75 / 29,625", () => {
    const a = ligne(s, "RN-A"), b = ligne(s, "RN-B"), c = ligne(s, "RN-C");
    expect(a.risque.ok && a.risque.score).toBe(60.625);
    expect(a.risqueAttendu?.score).toBe(65.375);          // 60,625 + 0,38 x (73,125 - 60,625)
    expect(b.risque.ok && b.risque.score).toBe(48.75);
    expect(b.risqueAttendu?.score).toBe(48.75);            // CRITIQUE est absorbant
    expect(c.risque.ok && c.risque.score).toBe(24.375);
    expect(c.risqueAttendu?.score).toBe(29.625);          // 24,375 + 0,35 x (39,375 - 24,375)
  });

  it("cout : 4 000 m x 1,1 Md/km, 1 000 m x 3,5 Md/km, 10 000 m x 80 M/km", () => {
    const m = (code: string) => { const l = ligne(s, code); return l.cout && l.cout.ok ? l.cout.montantGnf : null; };
    expect(m("RN-A")).toBe("4400000000");
    expect(m("RN-B")).toBe("3500000000");
    expect(m("RN-C")).toBe("800000000");
  });

  it("priorite : C (37,0312) avant A (14,8579) avant B (13,9285), ratio calcule en entiers", () => {
    expect(s.lignes.map((l) => l.troncon.code)).toEqual(["RN-C", "RN-A", "RN-B"]);
    expect(s.lignes.map((l) => l.priorite?.ratioPointsParMilliardGnf)).toEqual(["37.0312", "14.8579", "13.9285"]);
    expect(s.lignes.map((l) => l.rangPriorite)).toEqual([1, 2, 3]);
  });

  it("enveloppe de 10 Md : tout tient, 8,7 Md engages, 1,3 Md de reste", () => {
    expect(s.totaux).toMatchObject({ candidats: 3, eligibles: 3, retenues: 3, ecartees: 0, engageGnf: "8700000000", resteGnf: "1300000000" });
    expect(s.lignes.map((l) => l.rangRetenu)).toEqual([1, 2, 3]);
    expect(s.lignes.map((l) => l.budget?.resteApresGnf)).toEqual(["9200000000", "4800000000", "1300000000"]);
  });

  it("traitement et projection sont cites dans chaque ligne", () => {
    const a = ligne(s, "RN-A");
    expect(a.traitement && a.traitement.ok && a.traitement.traitement.code).toBe("rehabilitation");
    expect(a.projection && a.projection.ok && a.projection.pAnnuelle).toBe(0.38);
    expect(a.projection && a.projection.ok && a.projection.matrice.classeTrafic).toBe("T3_fort");
    expect(a.cout && a.cout.ok && a.cout.bareme.typeIntervention).toBe("rehabilitation");
  });

  it("ratioPointsParMilliard : exact, sans flottant", () => {
    expect(ratioPointsParMilliard(653750, 4_400_000_000n)).toBe("14.8579");
    expect(ratioPointsParMilliard(10000, 1_000_000_000n)).toBe("1.0000");
    expect(ratioPointsParMilliard(1, 1_000_000_000n)).toBe("0.0001");
  });
});

describe("construireScenario : contrainte budgetaire", () => {
  it("5 Md : C retenue, A (4,4 Md) ecartee car il reste 4,2 Md, B (3,5 Md) retenue malgre un rang inferieur", () => {
    const s = construire(entreesDeBase({ budgetGnf: 5_000_000_000n }));
    expect(ligne(s, "RN-C").decision).toBe("RETENUE");
    const a = ligne(s, "RN-A");
    expect(a.decision).toBe("ECARTEE");
    expect(a.motifExclusion?.code).toBe("BUDGET_INSUFFISANT");
    expect(a.motifExclusion?.detail).toContain("4400000000");
    expect(a.motifExclusion?.detail).toContain("4200000000");
    expect(a.rangRetenu).toBeNull();
    expect(a.rangPriorite).toBe(2);
    const b = ligne(s, "RN-B");
    expect(b.decision).toBe("RETENUE");
    expect(b.rangRetenu).toBe(2);
    expect(s.totaux).toMatchObject({ retenues: 2, ecartees: 1, engageGnf: "4300000000", resteGnf: "700000000" });
    expect(s.totaux.ecartesParMotif).toEqual({ BUDGET_INSUFFISANT: 1 });
  });

  it("enveloppe nulle : rien n'est retenu, tout est ecarte pour budget, aucun montant n'est invente", () => {
    const s = construire(entreesDeBase({ budgetGnf: 0n }));
    expect(s.totaux.retenues).toBe(0);
    expect(s.totaux.engageGnf).toBe("0");
    expect(s.lignes.every((l) => l.motifExclusion?.code === "BUDGET_INSUFFISANT")).toBe(true);
  });

  it("enveloppe egale au cout exact : la ligne tient (borne incluse)", () => {
    const s = construire(entreesDeBase({ budgetGnf: 800_000_000n }));
    expect(ligne(s, "RN-C").decision).toBe("RETENUE");
    expect(s.totaux.resteGnf).toBe("0");
  });

  it("plafond regional : A (region 1) ecartee car 0,8 + 4,4 depasse 4 Md, B (region 2) retenue", () => {
    const s = construire(entreesDeBase({ plafondsRegionauxGnf: { "1": 4_000_000_000n } }));
    const a = ligne(s, "RN-A");
    expect(a.motifExclusion?.code).toBe("PLAFOND_REGIONAL");
    expect(a.motifExclusion?.detail).toMatch(/région 1/);
    expect(ligne(s, "RN-B").decision).toBe("RETENUE");
    expect(s.totaux.engageParRegionGnf).toEqual({ "1": "800000000", "2": "3500000000" });
  });
});

describe("construireScenario : il refuse quand il ne sait pas (D-07, ecartes avec motif)", () => {
  it("sans bareme : plus rien n'est chiffre, chaque ligne dit AUCUNE_LIGNE_DE_BAREME", () => {
    const s = construire(entreesDeBase({ baremes: [] }));
    expect(s.totaux.retenues).toBe(0);
    expect(s.totaux.eligibles).toBe(0);
    for (const l of s.lignes) {
      expect(l.motifExclusion?.code).toBe("COUT_NON_ESTIMABLE");
      expect(l.cout && !l.cout.ok && l.cout.code).toBe("AUCUNE_LIGNE_DE_BAREME");
      expect(l.justification).toMatch(/n'estime pas ce qu'il ne sait pas chiffrer/);
    }
  });

  it("une seule ligne de bareme manquante n'ecarte que les troncons qu'elle couvre", () => {
    const s = construire(entreesDeBase({ baremes: BAREMES.filter((b) => b.id !== 2) }));
    expect(ligne(s, "RN-A").motifExclusion?.code).toBe("COUT_NON_ESTIMABLE");
    expect(ligne(s, "RN-B").decision).toBe("RETENUE");
    expect(ligne(s, "RN-C").decision).toBe("RETENUE");
  });

  it("etat non evalue : RISQUE_NON_CALCULABLE, jamais un etat bon", () => {
    const e = entreesDeBase({ candidats: [...candidatsDeBase(), candidat("d", { code: "RN-D", etat: "NON_EVALUE", traficMoyenJma: 2500, nbPointsNoirs: 2 })] });
    const l = ligne(construire(e), "RN-D");
    expect(l.motifExclusion?.code).toBe("RISQUE_NON_CALCULABLE");
    expect(l.risque.ok).toBe(false);
    expect(l.cout).toBeNull();
    expect(l.traitement).toBeNull();
  });

  it("deux facteurs seulement (la realite de la base aujourd'hui) : FACTEURS_INSUFFISANTS", () => {
    const e = entreesDeBase({ candidats: [candidat("h", { code: "RN-H", etat: "MAUVAIS", nbPointsNoirs: 2 })] });
    const l = ligne(construire(e), "RN-H");
    expect(l.motifExclusion?.code).toBe("RISQUE_NON_CALCULABLE");
    expect(l.motifExclusion?.detail).toMatch(/FACTEURS_INSUFFISANTS/);
  });

  it("revetement non renseigne et etat BON : AUCUN_TRAITEMENT, avec le code du refus", () => {
    const e = entreesDeBase({
      candidats: [
        candidat("e", { code: "RN-E", revetement: "NON_RENSEIGNE", traficMoyenJma: 2500, nbPointsNoirs: 2 }),
        candidat("g", { code: "RN-G", etat: "BON", traficMoyenJma: 2500, nbPointsNoirs: 2 }),
      ],
    });
    const s = construire(e);
    expect(ligne(s, "RN-E").motifExclusion?.detail).toMatch(/FAMILLE_COUT_ABSENTE/);
    expect(ligne(s, "RN-G").motifExclusion?.detail).toMatch(/AUCUNE_CONDITION/);
    expect(s.totaux.ecartesParMotif).toEqual({ AUCUN_TRAITEMENT: 2 });
  });

  it("longueur absente ou nulle : le moteur de cout refuse (LONGUEUR_INVALIDE)", () => {
    const e = entreesDeBase({ candidats: [candidat("z", { code: "RN-Z", traficMoyenJma: 2500, nbPointsNoirs: 2, longueurM: null })] });
    const l = ligne(construire(e), "RN-Z");
    expect(l.motifExclusion?.code).toBe("COUT_NON_ESTIMABLE");
    expect(l.motifExclusion?.detail).toMatch(/LONGUEUR_INVALIDE/);
  });

  it("longueur inferieure a un demi-metre : montant nul, refuse (pas de division par zero)", () => {
    const e = entreesDeBase({ candidats: [candidat("y", { code: "RN-Y", traficMoyenJma: 2500, nbPointsNoirs: 2, longueurM: 0.3 })] });
    const l = ligne(construire(e), "RN-Y");
    expect(l.motifExclusion?.detail).toMatch(/MONTANT_NUL/);
  });

  it("seuil de risque minimal : un parametre visible, motif SOUS_SEUIL_RISQUE", () => {
    const p = parametresAmorcage();
    p.valeurs.seuilRisqueMinimal = 30;
    const s = construire(entreesDeBase({ parametres: p }));
    expect(ligne(s, "RN-C").motifExclusion?.code).toBe("SOUS_SEUIL_RISQUE");
    expect(ligne(s, "RN-A").decision).toBe("RETENUE");
  });

  it("sans comptage de trafic : pas de classe, pas de matrice, risque attendu = risque courant (dit)", () => {
    const p = parametresAmorcage();
    p.valeurs.facteursMinimum = 2;
    const e = entreesDeBase({ parametres: p, candidats: [candidat("n", { code: "RN-N", nbPointsNoirs: 1, criticiteStrategique: 70, etat: "MAUVAIS", longueurM: 2000 })] });
    const l = ligne(construire(e), "RN-N");
    expect(l.projection && !l.projection.ok && l.projection.motif).toMatch(/aucun comptage/);
    expect(l.risqueAttendu?.score).toBe(l.risque.ok ? l.risque.score : -1);
  });
});

describe("construireScenario : justification et etiquette", () => {
  it("chaque ligne porte justification, entrees, facteurs, formules et etiquette PROVISOIRE", () => {
    const e = entreesDeBase({ budgetGnf: 5_000_000_000n, baremes: BAREMES.filter((b) => b.id !== 1) });
    const s = construire(e);
    expect(s.lignes.length).toBe(3);
    for (const l of s.lignes) {
      expect(l.justification.length).toBeGreaterThan(40);
      expect(l.etiquette).toBe("PROVISOIRE, non approuvé");
      expect(l.troncon.id).toBeTruthy();
      expect(l.risque.facteurs).toHaveLength(5);
    }
    const retenue = s.lignes.find((l) => l.decision === "RETENUE")!;
    expect(retenue.risque.ok && retenue.risque.formule).toMatch(/somme\(poids x valeur\)/);
    expect(retenue.risqueAttendu?.formule).toMatch(/risque attendu/);
    expect(retenue.priorite?.formule).toMatch(/risque attendu \/ cout/);
    expect(retenue.justification).toMatch(/^Retenue \(rang 1/);
    const ecartee = s.lignes.find((l) => l.decision === "ECARTEE")!;
    expect(ecartee.justification).toMatch(/^Écartée/);
    expect(ecartee.motifExclusion?.code).toBeTruthy();
  });

  it("le scenario est PROVISOIRE : parametres, bareme sans millesime ni largeur, catalogue et matrices non approuves", () => {
    const s = construire(entreesDeBase());
    expect(s.provisoire).toBe(true);
    expect(s.etiquette).toBe("PROVISOIRE, non approuvé");
    expect(s.parametres.etiquette).toBe("PROVISOIRE, non approuvé");
    const m = s.motifsProvisoire.join(" | ");
    expect(m).toMatch(/paramètres de programmation non approuvés \(version prog-provisoire-1/);
    expect(m).toMatch(/barème provisoire/);
    expect(m).toMatch(/ligne de bareme non approuvee/);
    expect(m).toMatch(/millesime du prix inconnu/);
    expect(m).toMatch(/largeur de chaussee de reference inconnue/);
    expect(m).toMatch(/traitement\(s\) du catalogue non approuvé\(s\)/);
    expect(m).toMatch(/matrice de dégradation non approuvée/);
    expect(s.avertissement).toMatch(/ne crée de marché, contrat, ordre de travaux, chantier, décompte/);
    expect(s.limites.length).toBeGreaterThanOrEqual(4);
  });

  it("tout approuve : le scenario cesse d'etre provisoire (et seulement alors)", () => {
    const ok = "2026-10-23T00:00:00.000Z";
    const e = entreesDeBase({
      parametres: { ...parametresAmorcage(), approuveeLe: ok, approuveeParId: "u1" },
      baremes: BAREMES.map((b) => ({ ...b, approuveLe: ok, anneeReference: 2026, largeurChausseeM: 7 })),
    });
    e.catalogue = e.catalogue.map((t) => ({ ...t, approuveLe: ok }));
    e.matrices = e.matrices.map((m) => ({ ...m, approuveLe: ok }));
    const s = construire(e);
    expect(s.provisoire).toBe(false);
    expect(s.motifsProvisoire).toEqual([]);
    expect(s.etiquette).toBe("paramètres et barèmes approuvés");
    expect(s.lignes.every((l) => l.etiquette === "paramètres approuvés")).toBe(true);
  });

  it("un seul maillon non approuve suffit a garder l'etiquette", () => {
    const ok = "2026-10-23T00:00:00.000Z";
    const e = entreesDeBase({
      parametres: { ...parametresAmorcage(), approuveeLe: ok, approuveeParId: "u1" },
      baremes: BAREMES.map((b) => ({ ...b, approuveLe: ok, anneeReference: 2026, largeurChausseeM: 7 })),
    });
    e.catalogue = e.catalogue.map((t) => ({ ...t, approuveLe: ok }));
    // matrices laissees non approuvees
    expect(construire(e).provisoire).toBe(true);
  });

  it("une longueur calculee sur la geometrie est dite dans la ligne, et rend le scenario provisoire", () => {
    const e = entreesDeBase({ candidats: [candidat("g", { code: "RN-G2", etat: "MAUVAIS", traficMoyenJma: 2500, nbPointsNoirs: 2, longueurM: 2000, longueurOrigine: "GEOMETRIE" })] });
    const s = construire(e);
    const l = ligne(s, "RN-G2");
    expect(l.decision).toBe("RETENUE");
    expect(l.troncon.longueurOrigine).toBe("GEOMETRIE");
    expect(l.justification).toMatch(/sur 2000 m calculés sur la géométrie/);
    expect(s.motifsProvisoire.join()).toMatch(/1 ligne\(s\) retenue\(s\) chiffrée\(s\) sur une longueur calculée sur la géométrie, non saisie/);
    const saisie = construire(entreesDeBase({ candidats: [candidat("g", { code: "RN-G2", etat: "MAUVAIS", traficMoyenJma: 2500, nbPointsNoirs: 2, longueurM: 2000, longueurOrigine: "LONGUEUR_KM" })] }));
    expect(saisie.motifsProvisoire.join()).not.toMatch(/géométrie/);
    expect(ligne(saisie, "RN-G2").justification).toMatch(/sur 2000 m \(/);
  });

  it("la version des parametres est dans le scenario", () => {
    expect(construire(entreesDeBase()).parametres).toMatchObject({ version: "prog-provisoire-1", source: "amorcage_provisoire", approuveeLe: null });
  });
});

describe("construireScenario : ordre total et determinisme", () => {
  it("memes entrees, memes octets, deux appels", () => {
    const e = entreesDeBase({ budgetGnf: 5_000_000_000n });
    expect(canonique(construire(e))).toBe(canonique(construire(e)));
  });

  it("l'ordre des tableaux d'entree n'a aucune influence (melange, inverse, rotation)", () => {
    const e = entreesDeBase({ budgetGnf: 5_000_000_000n, plafondsRegionauxGnf: { "2": 9_000_000_000n } });
    const ref = canonique(construire(e));
    const rot = <T,>(t: T[], k: number) => [...t.slice(k), ...t.slice(0, k)];
    const variantes: EntreesScenario[] = [
      { ...e, candidats: [...e.candidats].reverse() },
      { ...e, candidats: rot(e.candidats, 1), baremes: [...e.baremes].reverse() },
      { ...e, matrices: [...e.matrices].reverse(), conditions: rot(e.conditions, 4), catalogue: [...e.catalogue].reverse() },
    ];
    for (const v of variantes) expect(canonique(construire(v))).toBe(ref);
  });

  it("depart explicite a egalite : meme ratio, le risque courant le plus haut passe devant", () => {
    // X : MOYEN 35 sur 11 km a 350 M/km = 3,85 Md ; Y : MAUVAIS 65 sur 6,5 km a 1,1 Md/km = 7,15 Md.
    // 35/3,85 = 65/7,15 : produit croise 350000 x 7,15e9 = 650000 x 3,85e9 -> egalite EXACTE.
    const p = parametresAmorcage();
    p.valeurs.poidsRisque = { ETAT: 1, TRAFIC_IMPORTANCE: 0, SECURITE: 0, CLIMAT: 0, POPULATION: 0 };
    p.valeurs.facteursMinimum = 1;
    const e = entreesDeBase({
      parametres: p, budgetGnf: 100_000_000_000n,
      candidats: [candidat("x", { code: "T-X", etat: "MOYEN", longueurM: 11000 }), candidat("y", { code: "T-Y", etat: "MAUVAIS", longueurM: 6500 })],
    });
    const s = construire(e);
    expect(s.lignes.map((l) => l.priorite?.ratioPointsParMilliardGnf)).toEqual(["9.0909", "9.0909"]);
    expect(s.lignes.map((l) => l.troncon.code)).toEqual(["T-Y", "T-X"]);
  });

  it("depart total : meme risque, meme cout, codes differents -> ordre du code ; meme code -> ordre de l'identifiant", () => {
    const p = parametresAmorcage();
    p.valeurs.poidsRisque = { ETAT: 1, TRAFIC_IMPORTANCE: 0, SECURITE: 0, CLIMAT: 0, POPULATION: 0 };
    p.valeurs.facteursMinimum = 1;
    const mk = (id: string, code: string) => candidat(id, { code, etat: "MAUVAIS", longueurM: 1000 });
    const e = entreesDeBase({ parametres: p, candidats: [mk("2", "B-1"), mk("9", "A-1"), mk("7", "A-1"), mk("1", "B-1")] });
    const s = construire(e);
    expect(s.lignes.map((l) => `${l.troncon.code}/${l.troncon.id}`)).toEqual(["A-1/7", "A-1/9", "B-1/1", "B-1/2"]);
  });

  it("2000 candidats generes (graine fixe) : invariants du glouton, et melange sans effet", () => {
    let graine = 123456789;
    const alea = () => { graine = (Math.imul(graine, 1664525) + 1013904223) >>> 0; return graine / 4294967296; };
    const etats = ["BON", "MOYEN", "MAUVAIS", "CRITIQUE", "NON_EVALUE"];
    const revs = ["BITUME", "TERRE", "LATERITE", "PAVE", "NON_RENSEIGNE"];
    const candidats = Array.from({ length: 2000 }, (_, i) => candidat(`id-${String(i).padStart(5, "0")}`, {
      code: `RN-${Math.floor(alea() * 400)}`, regionId: 1 + Math.floor(alea() * 8),
      etat: etats[Math.floor(alea() * 5)], revetement: revs[Math.floor(alea() * 5)],
      traficMoyenJma: alea() < 0.7 ? Math.floor(alea() * 8000) : null, nbPointsNoirs: alea() < 0.8 ? Math.floor(alea() * 5) : null,
      criticiteStrategique: alea() < 0.3 ? Math.floor(alea() * 100) : null, longueurM: 200 + Math.floor(alea() * 20000),
    }));
    const e = entreesDeBase({ candidats, budgetGnf: 60_000_000_000n, plafondsRegionauxGnf: { "3": 5_000_000_000n } });
    const s = construire(e);

    // (1) jamais au-dela de l'enveloppe, et le total des lignes retenues = engage
    const retenues = s.lignes.filter((l) => l.decision === "RETENUE");
    const somme = retenues.reduce((t, l) => t + BigInt(l.cout && l.cout.ok ? l.cout.montantGnf : "0"), 0n);
    expect(somme).toBe(BigInt(s.totaux.engageGnf));
    expect(somme <= 60_000_000_000n).toBe(true);
    expect(BigInt(s.totaux.engageGnf) + BigInt(s.totaux.resteGnf)).toBe(60_000_000_000n);
    // (2) region 3 : plafond respecte
    expect(BigInt(s.totaux.engageParRegionGnf["3"] ?? "0") <= 5_000_000_000n).toBe(true);
    // (3) les lignes classees sont dans l'ordre exact du ratio (produit croise) ; rangs 1..n sans trou
    const classees = s.lignes.filter((l) => l.rangPriorite !== null);
    expect(classees.map((l) => l.rangPriorite)).toEqual(classees.map((_, i) => i + 1));
    for (let i = 1; i < classees.length; i++) {
      const p = classees[i - 1], q = classees[i];
      const gp = BigInt(Math.round((p.risqueAttendu as { score: number }).score * 10000)) * BigInt((q.cout as { montantGnf: string }).montantGnf);
      const gq = BigInt(Math.round((q.risqueAttendu as { score: number }).score * 10000)) * BigInt((p.cout as { montantGnf: string }).montantGnf);
      expect(gp >= gq).toBe(true);
    }
    // (4) toute ligne ecartee pour budget coutait plus que ce qui restait a ce moment-la
    for (const l of s.lignes.filter((x) => x.motifExclusion?.code === "BUDGET_INSUFFISANT")) {
      expect(BigInt((l.cout as { montantGnf: string }).montantGnf) > BigInt((l.budget as { resteAvantGnf: string }).resteAvantGnf)).toBe(true);
    }
    // (5) toute ligne porte une justification
    expect(s.lignes.every((l) => l.justification.length > 20)).toBe(true);
    expect(s.lignes.length).toBe(2000);
    expect(retenues.length).toBeGreaterThan(10);
    // (6) melange : memes octets
    const melange = [...candidats].sort((a, b) => (a.id < b.id ? 1 : -1));
    expect(canonique(construire({ ...e, candidats: melange }))).toBe(canonique(s));
  });
});

describe("serialisation des entrees (stockage et rejeu)", () => {
  it("aller-retour JSON : le scenario recalcule est identique octet pour octet", () => {
    const e = entreesDeBase({ budgetGnf: 5_000_000_000n, plafondsRegionauxGnf: { "1": 6_000_000_000n } });
    const texte = canonique(entreesVersJson(e));
    const relu = entreesDepuisJson(JSON.parse(texte));
    expect(relu.ok).toBe(true);
    if (relu.ok) {
      expect(canonique(construire(relu.entrees))).toBe(canonique(construire(e)));
      expect(canonique(entreesVersJson(relu.entrees))).toBe(texte);
    }
  });

  it("deux jeux identiques a l'ordre pres donnent le meme texte d'entrees, donc la meme empreinte", () => {
    const e = entreesDeBase();
    const inverse = { ...e, candidats: [...e.candidats].reverse(), baremes: [...e.baremes].reverse(), matrices: [...e.matrices].reverse() };
    expect(canonique(entreesVersJson(inverse))).toBe(canonique(entreesVersJson(e)));
  });

  it("refuse un montant qui n'est pas une chaine de chiffres, ou un jeu devenu invalide", () => {
    const j = entreesVersJson(entreesDeBase()) as Record<string, unknown>;
    expect(entreesDepuisJson({ ...j, budgetGnf: 5000000000 }).ok).toBe(false);
    expect(entreesDepuisJson({ ...j, budgetGnf: "-5" }).ok).toBe(false);
    expect(entreesDepuisJson({ ...j, annee: 1999 }).ok).toBe(false);
    expect(entreesDepuisJson("n'importe quoi").ok).toBe(false);
  });
});

describe("validation des entrees", () => {
  it("refuse annee, budget, doublons, plafond du nombre de candidats, parametres invalides", () => {
    const base = entreesDeBase();
    expect(validerEntrees({ ...base, annee: 1900 }).length).toBeGreaterThan(0);
    expect(validerEntrees({ ...base, budgetGnf: -1n }).length).toBeGreaterThan(0);
    expect(validerEntrees({ ...base, candidats: [candidat("a"), candidat("a")] }).join()).toMatch(/en double/);
    expect(validerEntrees({ ...base, candidats: [candidat("a", { traficMoyenJma: Number.NaN })] }).join()).toMatch(/traficMoyenJma/);
    const trop = Array.from({ length: MAX_CANDIDATS + 1 }, (_, i) => candidat(`c${i}`));
    expect(validerEntrees({ ...base, candidats: trop }).join()).toMatch(/plafond/);
    const p = parametresAmorcage();
    p.valeurs.horizonAnnees = 0;
    expect(validerEntrees({ ...base, parametres: p }).join()).toMatch(/horizonAnnees/);
    const r = construireScenario({ ...base, annee: 1900 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ENTREES_INVALIDES");
  });

  it("aucun candidat : un scenario vide, honnete, pas une erreur", () => {
    const s = construire(entreesDeBase({ candidats: [] }));
    expect(s.lignes).toEqual([]);
    expect(s.totaux).toMatchObject({ candidats: 0, retenues: 0, engageGnf: "0", resteGnf: "10000000000" });
  });
});
