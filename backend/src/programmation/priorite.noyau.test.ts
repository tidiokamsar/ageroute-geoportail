import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonique, sha256Hex } from "./canonique";
import { parametresAmorcage, type ParametresProgrammation } from "./parametres.noyau";
import { BLOC_PRIORITE_AMORCAGE, type BlocPriorite } from "./priorite.parametres";
import {
  CRITERES, classerInterventions, dernierConstatDe, evaluerUrgence, joursEntre, motifDeLaLigne, projectionEmpreinte, resoudreSecurite,
  type EntreesPriorite, type FaitsIntervention, type LigneClassee, type ResultatPriorite,
} from "./priorite.noyau";
import { BAREMES, CATALOGUE, CONDITIONS, MATRICES } from "./scenario.fixtures";
import { MAX_CANDIDATS, construireScenario } from "./scenario.noyau";

/**
 * Ce que ces tests defendent (cahier d'aide a la decision, paragraphes 6.1 a 6.4) :
 *   - un critere absent n'est JAMAIS un zero : la ligne est « score incomplet » avec la liste de ce qui manque ;
 *   - un etat non evalue n'est ni classe bon ni classe faible : la ligne est exclue, avec son motif, apres les lignes classees ;
 *   - « zero point noir » n'est une donnee que dans une region dont le registre est exploite ;
 *   - la priorite technique et l'ordre d'arbitrage sont deux classements distincts : un troncon critique et cher reste en tete
 *     de la priorite technique, et le simulateur peut le classer apres ;
 *   - memes entrees (dans n'importe quel ordre), meme classement, meme empreinte SHA-256 ;
 *   - tout est PROVISOIRE tant que les parametres ne sont pas approuves.
 * Les nombres attendus sont calcules a la main dans les commentaires.
 */

const REF = "2026-10-27";

function fait(id: string, o: Partial<FaitsIntervention> = {}): FaitsIntervention {
  return {
    id, code: o.code ?? `T-${id}`, nom: null, regionId: 1, regionNom: "Region 1", classe: "RN", revetement: "BITUME", prefecture: null,
    etat: "MAUVAIS", traficMoyenJma: null, traficDateComptage: null, criticiteStrategique: null,
    pointsNoirs: { confirmes: 0, nonConfirmes: 0, registreRegion: 10 },
    constats: [], dateDerniereEvaluation: null,
    longueurKm: 2, longueurMetierDerivee: false, longueurGeometriqueM: 2000,
    localisation: { valide: true, motif: null },
    qualiteEtat: null, sourceTroncon: { type: null, confiance: null },
    ...o,
  };
}

function entrees(candidats: FaitsIntervention[], o: Partial<EntreesPriorite> = {}): EntreesPriorite {
  return { dateReference: REF, parametres: parametresAmorcage(), candidats, baremes: BAREMES, catalogue: CATALOGUE, conditions: CONDITIONS, matrices: MATRICES, ...o };
}

function classer(candidats: FaitsIntervention[], o: Partial<EntreesPriorite> = {}): ResultatPriorite {
  const r = classerInterventions(entrees(candidats, o));
  if (!r.ok) throw new Error(`classement refuse : ${r.code} ${r.erreurs.join(" ; ")}`);
  return r.resultat;
}

const parId = (r: ResultatPriorite, id: string): LigneClassee => r.lignes.find((l) => l.id === id) as LigneClassee;

function avecBloc(bloc: Omit<Partial<BlocPriorite>, "poids"> & { poids?: Partial<BlocPriorite["poids"]> }, approuve = false): ParametresProgrammation {
  const p = parametresAmorcage();
  p.valeurs.priorite = { ...structuredClone(BLOC_PRIORITE_AMORCAGE), ...bloc, poids: { ...BLOC_PRIORITE_AMORCAGE.poids, ...(bloc.poids ?? {}) } };
  if (approuve) { p.approuveeLe = "2026-10-20T08:00:00.000Z"; p.approuveeParId = "u-approbateur"; }
  return p;
}

describe("Le noyau est pur", () => {
  const src = readFileSync(join(__dirname, "priorite.noyau.ts"), "utf8");
  const sansCommentaires = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("n'importe que des noyaux purs (aucune base, aucun client HTTP)", () => {
    const imports = [...src.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]).sort();
    expect(imports).toEqual([
      "../engines/cout.noyau", "../engines/famille-cout", "../engines/risque.noyau", "../engines/traitement.noyau",
      "../qualite/detecteurs.noyau", "./canonique", "./parametres.noyau", "./priorite.parametres", "./scenario.noyau",
    ]);
  });

  it("n'a ni horloge ni hasard", () => {
    expect(sansCommentaires).not.toMatch(/new Date\(\)|Date\.now|Math\.random|performance\.now/);
  });
});

describe("Catalogue des criteres du cahier (6.2)", () => {
  it("declare sept criteres, dont deux non disponibles et le cout rattache a l'arbitrage", () => {
    expect(CRITERES.map((c) => c.code)).toEqual(["ETAT_GRAVITE", "IMPORTANCE_AXE", "SECURITE_CRITICITE", "ACCESSIBILITE_SERVICE", "URGENCE_TEMPORELLE", "COUT_EFFICACITE", "MATURITE_FAISABILITE"]);
    expect(CRITERES.filter((c) => c.disponibilite === "NON_DISPONIBLE").map((c) => c.code)).toEqual(["ACCESSIBILITE_SERVICE", "MATURITE_FAISABILITE"]);
    expect(CRITERES.find((c) => c.code === "COUT_EFFICACITE")!.role).toBe("ARBITRAGE");
    expect(CRITERES.filter((c) => c.role === "PRIORITE_TECHNIQUE")).toHaveLength(6);
  });
});

describe("Score pondere : calcul a la main", () => {
  it("quatre criteres disponibles : (40x65 + 25x50 + 20x33,3333 + 15x50) / 100 = 52,6667, complet", () => {
    // etat MAUVAIS = 65 ; trafic 2500 / 5000 = 50 ; 1 point noir / plafond 3 = 33,3333 ; degradation depuis 365 jours / 730 = 50
    const r = classer([fait("a", {
      etat: "MAUVAIS", traficMoyenJma: 2500, traficDateComptage: "2025-03-01",
      pointsNoirs: { confirmes: 1, nonConfirmes: 0, registreRegion: 10 },
      constats: [{ date: "2025-10-27", etat: "MAUVAIS" }],
    })]);
    const p = parId(r, "a").prioriteTechnique;
    expect(p.statut).toBe("CALCULE");
    expect(p.scoreIncomplet).toBe(false);
    expect(p.score).toBe(52.6667);
    expect(p.rang).toBe(1);
    expect(p.couverture).toBe(1);
    const points = Object.fromEntries(p.contributions.map((c) => [c.critere, c.points]));
    expect(points).toEqual({ ETAT_GRAVITE: 26, IMPORTANCE_AXE: 12.5, SECURITE_CRITICITE: 6.6667, URGENCE_TEMPORELLE: 7.5 });
    expect(p.contributions.reduce((s, c) => s + (c.points as number), 0)).toBeCloseTo(p.score as number, 3);
    expect(p.criteresManquants).toEqual([]);
    // la provenance du trafic dit la date du comptage (cahier 6.2 : documenter la source et la date)
    expect(p.contributions.find((c) => c.critere === "IMPORTANCE_AXE")!.provenance).toContain("2025-03-01");
  });

  it("les poids a zero ne sont pas des contributions : ils sont exclus explicitement (accessibilite, maturite)", () => {
    const r = classer([fait("a", { etat: "BON" })]);
    const criteres = parId(r, "a").prioriteTechnique.contributions.map((c) => c.critere);
    expect(criteres).not.toContain("ACCESSIBILITE_SERVICE");
    expect(criteres).not.toContain("MATURITE_FAISABILITE");
  });
});

describe("Criteres absents : score incomplet, jamais une valeur inventee", () => {
  it("l'etat seul (couverture 0,4) : score = valeur de l'etat, scoreIncomplet, trois criteres manquants avec leur raison", () => {
    const r = classer([fait("a", { etat: "CRITIQUE" })]); // registre de la region exploite mais 0 point noir confirme => securite = 0 (donnee)
    const p = parId(r, "a").prioriteTechnique;
    // securite disponible (zero, registre exploite) : etat 90 et securite 0 sur 60 => (40x90 + 20x0)/60 = 60, couverture 0,6
    expect(p.statut).toBe("INCOMPLET");
    expect(p.scoreIncomplet).toBe(true);
    expect(p.couverture).toBe(0.6);
    expect(p.score).toBe(60);
    expect(p.criteresManquants.map((m) => m.critere)).toEqual(["IMPORTANCE_AXE", "URGENCE_TEMPORELLE"]);
    for (const m of p.criteresManquants) expect(m.raison.length).toBeGreaterThan(10);
    // jamais de contribution nulle fabriquee : un critere manquant n'a ni valeur ni points
    for (const c of p.contributions.filter((x) => x.critere === "IMPORTANCE_AXE" || x.critere === "URGENCE_TEMPORELLE")) {
      expect(c.valeurNormalisee).toBeNull();
      expect(c.points).toBeNull();
    }
  });

  it("registre non exploite et rien d'autre que l'etat : couverture 0,4, score = etat, incomplet (pas 0, pas exclu)", () => {
    const r = classer([fait("a", { etat: "CRITIQUE", pointsNoirs: { confirmes: 0, nonConfirmes: 0, registreRegion: 0 } })]);
    const p = parId(r, "a").prioriteTechnique;
    expect(p.couverture).toBe(0.4);
    expect(p.score).toBe(90);
    expect(p.scoreIncomplet).toBe(true);
    expect(p.criteresManquants.map((m) => m.critere)).toEqual(["IMPORTANCE_AXE", "SECURITE_CRITICITE", "URGENCE_TEMPORELLE"]);
  });

  it("sous la couverture minimale : ligne EXCLUE (COUVERTURE_INSUFFISANTE), score nul et non classee, jamais 0", () => {
    const parametres = avecBloc({ couvertureMinimale: 0.5 });
    const r = classer([fait("a", { etat: "CRITIQUE", pointsNoirs: { confirmes: 0, nonConfirmes: 0, registreRegion: 0 } })], { parametres });
    const p = parId(r, "a").prioriteTechnique;
    expect(p.statut).toBe("EXCLU");
    expect(p.exclusion!.code).toBe("COUVERTURE_INSUFFISANTE");
    expect(p.score).toBeNull();
    expect(p.rang).toBeNull();
    expect(p.exclusion!.motif).toContain("0.4");
  });

  it("TOUS les criteres absents (etat non evalue, rien d'autre) : exclue, aucun score, aucune valeur inventee", () => {
    const r = classer([fait("a", { etat: "NON_EVALUE", pointsNoirs: null, longueurKm: null, longueurGeometriqueM: null })]);
    const p = parId(r, "a").prioriteTechnique;
    expect(p.statut).toBe("EXCLU");
    expect(p.score).toBeNull();
    expect(p.couverture).toBe(0);
    expect(p.contributions.every((c) => c.valeurNormalisee === null && c.points === null)).toBe(true);
    expect(p.criteresManquants).toHaveLength(4);
  });

  it("un poids sur un critere sans aucune donnee (accessibilite) le rend manquant sur TOUTES les lignes, avec sa raison", () => {
    const parametres = avecBloc({ poids: { ACCESSIBILITE_SERVICE: 10 } });
    const r = classer([fait("a", { etat: "MAUVAIS", traficMoyenJma: 2000 }), fait("b", { etat: "MOYEN", traficMoyenJma: 100 })], { parametres });
    for (const id of ["a", "b"]) {
      const m = parId(r, id).prioriteTechnique.criteresManquants.find((x) => x.critere === "ACCESSIBILITE_SERVICE");
      expect(m, "critere declare non disponible, jamais invente").toBeDefined();
      expect(m!.raison).toContain("non disponible");
      expect(parId(r, id).prioriteTechnique.scoreIncomplet).toBe(true);
    }
  });
});

describe("Etat non evalue : exclusion nommee, ni bon ni faible", () => {
  it("NON_EVALUE, null et etat inconnu sont exclus avec ETAT_NON_EVALUE, listes APRES les lignes classees", () => {
    const r = classer([
      fait("z", { etat: "NON_EVALUE", code: "A-NON-EVALUE" }),
      fait("n", { etat: null, code: "A-NULL" }),
      fait("x", { etat: "XYZ", code: "A-INCONNU" }),
      fait("b", { etat: "BON", code: "Z-BON" }),
    ]);
    expect(r.lignes.map((l) => l.id)).toEqual(["b", "x", "z", "n"]); // classee d'abord, puis exclues par code (A-INCONNU, A-NON-EVALUE, A-NULL)
    for (const id of ["z", "n", "x"]) {
      const p = parId(r, id).prioriteTechnique;
      expect(p.exclusion!.code).toBe("ETAT_NON_EVALUE");
      expect(p.rang).toBeNull();
      expect(p.score).toBeNull();
    }
    expect(parId(r, "b").prioriteTechnique.rang).toBe(1); // un BON est classe (score bas), il n'est pas confondu avec un non evalue
    expect(r.resume).toMatchObject({ candidats: 4, classes: 1, exclus: 3, parMotifExclusion: { ETAT_NON_EVALUE: 3 } });
  });

  it("l'etat reste obligatoire meme avec un poids nul (comme le moteur de risque)", () => {
    const r = classer([fait("a", { etat: "NON_EVALUE" })], { parametres: avecBloc({ poids: { ETAT_GRAVITE: 0, IMPORTANCE_AXE: 50 } }) });
    expect(parId(r, "a").prioriteTechnique.exclusion!.code).toBe("ETAT_NON_EVALUE");
  });
});

describe("« zero point noir » ou « registre non fiable »", () => {
  const min = 5;
  it("resoudreSecurite : quatre cas nommes", () => {
    expect(resoudreSecurite({ confirmes: 2, nonConfirmes: 0, registreRegion: 0 }, min)).toMatchObject({ code: "POINTS_NOIRS_CONFIRMES", nb: 2 });
    expect(resoudreSecurite({ confirmes: 0, nonConfirmes: 0, registreRegion: 5 }, min)).toMatchObject({ code: "ZERO_REGISTRE_EXPLOITE", nb: 0 });
    expect(resoudreSecurite({ confirmes: 0, nonConfirmes: 0, registreRegion: 4 }, min)).toMatchObject({ code: "REGISTRE_NON_EXPLOITE", nb: null });
    expect(resoudreSecurite(null, min)).toMatchObject({ code: "SOURCE_ILLISIBLE", nb: null });
    expect(resoudreSecurite({ confirmes: -1, nonConfirmes: 0, registreRegion: 9 }, min)).toMatchObject({ code: "SOURCE_ILLISIBLE", nb: null });
    expect(resoudreSecurite({ confirmes: 1.5, nonConfirmes: 0, registreRegion: 9 }, min)).toMatchObject({ code: "SOURCE_ILLISIBLE", nb: null });
  });

  it("registre exploite : zero est une DONNEE (valeur 0, points 0) ; registre non exploite : critere ABSENT, jamais 0", () => {
    const r = classer([
      fait("exploite", { etat: "MAUVAIS", traficMoyenJma: 2500, pointsNoirs: { confirmes: 0, nonConfirmes: 0, registreRegion: 12 } }),
      fait("vide", { etat: "MAUVAIS", traficMoyenJma: 2500, pointsNoirs: { confirmes: 0, nonConfirmes: 0, registreRegion: 1 }, code: "T-vide" }),
    ]);
    const a = parId(r, "exploite").prioriteTechnique;
    const secuA = a.contributions.find((c) => c.critere === "SECURITE_CRITICITE")!;
    expect(secuA.valeurNormalisee).toBe(0);
    expect(secuA.points).toBe(0);
    expect(a.criteresManquants.map((m) => m.critere)).not.toContain("SECURITE_CRITICITE");

    const b = parId(r, "vide").prioriteTechnique;
    const secuB = b.contributions.find((c) => c.critere === "SECURITE_CRITICITE")!;
    expect(secuB.valeurNormalisee).toBeNull();
    expect(secuB.points).toBeNull();
    const manquant = b.criteresManquants.find((m) => m.critere === "SECURITE_CRITICITE")!;
    expect(manquant.raison).toContain("pas zero");
    // la meme situation, deux scores differents : le premier mele une donnee 0, le second renormalise sans elle
    expect(a.score).not.toBe(b.score);
  });

  it("une alerte non confirmee ne compte pas dans le score, mais elle est dite", () => {
    const r = classer([fait("a", { etat: "MAUVAIS", pointsNoirs: { confirmes: 0, nonConfirmes: 4, registreRegion: 10 } })]);
    const c = parId(r, "a").prioriteTechnique.contributions.find((x) => x.critere === "SECURITE_CRITICITE")!;
    expect(c.valeurNormalisee).toBe(0);
    expect(c.note).toContain("4 alerte(s) non confirmee(s)");
  });

  it("le minimum du registre est un parametre : a 20, une region de 12 points n'est plus exploitee", () => {
    const r = classer([fait("a", { etat: "MAUVAIS", pointsNoirs: { confirmes: 0, nonConfirmes: 0, registreRegion: 12 } })], { parametres: avecBloc({ registrePointsNoirsMinimum: 20 }) });
    expect(parId(r, "a").prioriteTechnique.criteresManquants.map((m) => m.critere)).toContain("SECURITE_CRITICITE");
  });

  it("des points noirs confirmes sur le troncon comptent meme dans une region au registre pauvre", () => {
    const r = classer([fait("a", { etat: "MAUVAIS", pointsNoirs: { confirmes: 3, nonConfirmes: 0, registreRegion: 3 } })]);
    const c = parId(r, "a").prioriteTechnique.contributions.find((x) => x.critere === "SECURITE_CRITICITE")!;
    expect(c.valeurNormalisee).toBe(100); // 3 / plafond 3
  });
});

describe("Tri total, egalites et poids", () => {
  it("deux egalites parfaites : departagees par code puis identifiant, quel que soit l'ordre des entrees", () => {
    const a = fait("2", { code: "RN-B", etat: "MAUVAIS", traficMoyenJma: 1000 });
    const b = fait("1", { code: "RN-A", etat: "MAUVAIS", traficMoyenJma: 1000 });
    const c = fait("3", { code: "RN-A", etat: "MAUVAIS", traficMoyenJma: 1000 }); // meme code que b : l'identifiant tranche
    for (const ordre of [[a, b, c], [c, b, a], [b, a, c]]) {
      const r = classer(ordre);
      expect(r.lignes.map((l) => l.id)).toEqual(["1", "3", "2"]);
      expect(r.lignes.map((l) => l.prioriteTechnique.rang)).toEqual([1, 2, 3]);
      expect(new Set(r.lignes.map((l) => l.prioriteTechnique.score)).size).toBe(1);
    }
  });

  it("changer les poids change l'ordre (A critique mais peu expose, B moyen mais tres expose)", () => {
    const A = fait("A", { code: "A", etat: "CRITIQUE", traficMoyenJma: 500 }); // etat 90, trafic 10, securite 0 (registre exploite)
    const B = fait("B", { code: "B", etat: "MOYEN", traficMoyenJma: 5000, pointsNoirs: { confirmes: 3, nonConfirmes: 0, registreRegion: 10 } }); // 35, 100, 100
    // poids d'amorcage 40/25/20 sur 85 : A = (3600 + 250 + 0)/85 = 45,2941 ; B = (1400 + 2500 + 2000)/85 = 69,4118
    const defaut = classer([A, B]);
    expect(defaut.lignes.map((l) => l.id)).toEqual(["B", "A"]);
    expect(parId(defaut, "A").prioriteTechnique.score).toBe(45.2941);
    expect(parId(defaut, "B").prioriteTechnique.score).toBe(69.4118);
    // l'etat pese 80, le reste 5 : A = (7200 + 50 + 0)/90 = 80,5556 ; B = (2800 + 500 + 500)/90 = 42,2222
    const etat = classer([A, B], { parametres: avecBloc({ poids: { ETAT_GRAVITE: 80, IMPORTANCE_AXE: 5, SECURITE_CRITICITE: 5, URGENCE_TEMPORELLE: 0 } }) });
    expect(etat.lignes.map((l) => l.id)).toEqual(["A", "B"]);
    expect(parId(etat, "A").prioriteTechnique.score).toBe(80.5556);
    expect(parId(etat, "B").prioriteTechnique.score).toBe(42.2222);
    // et l'empreinte change avec les poids
    expect(etat.empreinte).not.toBe(defaut.empreinte);
  });
});

describe("Reproductibilite : empreinte SHA-256 de la sortie canonique", () => {
  const jeu = (): FaitsIntervention[] => [
    fait("a", { code: "RN-A", etat: "CRITIQUE", traficMoyenJma: 2500, pointsNoirs: { confirmes: 2, nonConfirmes: 1, registreRegion: 9 }, constats: [{ date: "2025-01-10", etat: "MAUVAIS" }, { date: "2025-09-01", etat: "CRITIQUE" }] }),
    fait("b", { code: "RN-B", etat: "MOYEN", traficMoyenJma: 600, longueurKm: null, longueurGeometriqueM: 8123.4 }),
    fait("c", { code: "RN-C", etat: "NON_EVALUE" }),
    fait("d", { code: "RN-D", etat: "MAUVAIS", revetement: "TERRE", longueurKm: 10 }),
    fait("e", { code: "RN-E", etat: "BON" }),
  ];

  it("memes entrees melangees (candidats, baremes, catalogue, constats) : sortie canonique et empreinte identiques", () => {
    const e1 = entrees(jeu());
    const melange = jeu().reverse().map((f) => ({ ...f, constats: [...f.constats].reverse() }));
    const e2 = entrees(melange, { baremes: [...BAREMES].reverse(), catalogue: [...CATALOGUE].reverse(), conditions: [...CONDITIONS].reverse(), matrices: [...MATRICES].reverse() });
    const r1 = classerInterventions(e1), r2 = classerInterventions(e2);
    if (!r1.ok || !r2.ok) throw new Error("refus");
    expect(canonique(r1.resultat)).toBe(canonique(r2.resultat));
    expect(r1.resultat.empreinte).toBe(r2.resultat.empreinte);
    expect(r1.resultat.empreinte).toMatch(/^[0-9a-f]{64}$/);
  });

  it("l'empreinte est le SHA-256 de la projection canonique de decision, independante de l'ordre des cles et du nombre de calculs", () => {
    const r = classer(jeu());
    const texte = canonique(projectionEmpreinte({ modele: r.modele, dateReference: r.dateReference, parametres: { version: r.parametres.version, source: r.parametres.source, approuveeLe: r.parametres.approuveeLe, approuveeParId: r.parametres.approuveeParId, bloc: r.parametres.bloc, blocOrigine: r.parametres.blocOrigine }, lignes: r.lignes }));
    expect(sha256Hex(texte)).toBe(r.empreinte);
    expect(classer(jeu()).empreinte).toBe(r.empreinte);
  });

  it("la projection ne contient aucune phrase explicative (notes, motifs, justifications) : elles sont derivees des valeurs", () => {
    const r = classer(jeu());
    const texte = canonique(projectionEmpreinte({ modele: r.modele, dateReference: r.dateReference, parametres: { version: r.parametres.version, source: r.parametres.source, approuveeLe: r.parametres.approuveeLe, approuveeParId: r.parametres.approuveeParId, bloc: r.parametres.bloc, blocOrigine: r.parametres.blocOrigine }, lignes: r.lignes }));
    expect(texte).not.toContain("registre de la region");
    expect(texte).not.toContain("sur un plafond de");
    expect(texte.length).toBeLessThan(canonique(r.lignes).length / 3);
  });

  it("change si la date de reference, un fait ou la version de parametres change", () => {
    const base = classer(jeu()).empreinte;
    expect(classer(jeu(), { dateReference: "2026-10-28" }).empreinte).not.toBe(base);
    const modifie = jeu(); modifie[0].traficMoyenJma = 2501;
    expect(classer(modifie).empreinte).not.toBe(base);
    const p = parametresAmorcage(); p.version = "autre-version-1";
    expect(classer(jeu(), { parametres: p }).empreinte).not.toBe(base);
  });

  it("chaque ligne porte la version du modele et celle des parametres", () => {
    const r = classer(jeu());
    for (const l of r.lignes) {
      expect(l.modeleVersion).toBe("priorite-technique-1.1");
      expect(l.parametresVersion).toBe("prog-provisoire-1");
    }
    expect(r.modele).toEqual({ id: "priorite-technique-1", version: "1" });
  });
});

describe("Priorite technique et ordre d'arbitrage : deux classements, jamais confondus", () => {
  // A : critique et cher (reconstruction bitume 4 km x 3,5 Md/km = 14 Md) ; B : moyen et bon marche (entretien 1 km x 350 M = 350 M)
  const A = fait("A", { code: "RN-A", etat: "CRITIQUE", traficMoyenJma: 1000, longueurKm: 4, longueurGeometriqueM: 4000, pointsNoirs: { confirmes: 3, nonConfirmes: 0, registreRegion: 9 } });
  const B = fait("B", { code: "RN-B", etat: "MOYEN", traficMoyenJma: 1000, longueurKm: 1, longueurGeometriqueM: 1000, pointsNoirs: { confirmes: 1, nonConfirmes: 0, registreRegion: 9 } });

  it("un troncon CRITIQUE cher reste en tete de la priorite technique ; l'arbitrage coute-efficacite le classe apres", () => {
    const r = classer([A, B]);
    const a = parId(r, "A"), b = parId(r, "B");
    expect(a.prioriteTechnique.rang).toBe(1);
    expect(b.prioriteTechnique.rang).toBe(2);
    // arbitrage : risque attendu / cout. A : 70 / 14 Md = 5 ; B : 32,7 / 0,35 Md = 93,4 => B d'abord
    expect(b.ordreArbitrage.rang).toBe(1);
    expect(a.ordreArbitrage.rang).toBe(2);
    expect(a.coutEstime!.montantGnf).toBe("14000000000");
    expect(b.coutEstime!.montantGnf).toBe("350000000");
    expect(a.ordreArbitrage.ratioPointsParMilliardGnf).toBe("5.0000");
  });

  it("l'ordre d'arbitrage est EXACTEMENT celui du simulateur (meme moteur, enveloppe illimitee)", () => {
    const r = classer([A, B]);
    const sim = construireScenario({
      annee: 2026, budgetGnf: 10n ** 18n, plafondsRegionauxGnf: {}, parametres: parametresAmorcage(),
      candidats: [A, B].map((f) => ({
        id: f.id, code: f.code, nom: null, regionId: 1, classe: "RN", revetement: "BITUME", longueurM: (f.longueurKm as number) * 1000, longueurOrigine: "LONGUEUR_KM" as const,
        etat: f.etat, traficMoyenJma: f.traficMoyenJma, criticiteStrategique: null, nbPointsNoirs: f.pointsNoirs!.confirmes, vulnerabiliteClimatique: null, populationDesservie: null,
      })),
      baremes: BAREMES, catalogue: CATALOGUE, conditions: CONDITIONS, matrices: MATRICES,
    });
    if (!sim.ok) throw new Error("simulateur refuse");
    for (const l of sim.scenario.lignes) {
      const mien = parId(r, l.troncon.id);
      expect(mien.ordreArbitrage.rang).toBe(l.rangPriorite);
      expect(mien.ordreArbitrage.ratioPointsParMilliardGnf).toBe(l.priorite!.ratioPointsParMilliardGnf);
      expect(mien.coutEstime!.montantGnf).toBe((l.cout as { montantGnf: string }).montantGnf);
    }
  });

  it("le cout ne pese pas dans la priorite technique : multiplier le prix par dix ne change pas un seul rang technique", () => {
    const cher = BAREMES.map((b) => ({ ...b, coutKmGnf: b.coutKmGnf * 10n }));
    const normal = classer([A, B]);
    const surcout = classer([A, B], { baremes: cher });
    expect(surcout.lignes.map((l) => [l.id, l.prioriteTechnique.rang, l.prioriteTechnique.score])).toEqual(normal.lignes.map((l) => [l.id, l.prioriteTechnique.rang, l.prioriteTechnique.score]));
  });

  it("un troncon que le simulateur ne sait pas classer garde sa priorite technique, avec le motif du simulateur", () => {
    // critique, sans trafic ni point noir confirme exploitable : le risque du simulateur (3 facteurs minimum) n'est pas calculable
    const C = fait("C", { code: "RN-C", etat: "CRITIQUE", pointsNoirs: { confirmes: 0, nonConfirmes: 0, registreRegion: 0 } });
    const r = classer([C]);
    const c = parId(r, "C");
    expect(c.prioriteTechnique.rang).toBe(1);
    expect(c.ordreArbitrage.rang).toBeNull();
    expect(c.ordreArbitrage.motifAbsence!.code).toBe("RISQUE_NON_CALCULABLE");
    // mais le cout est estimable : il ne depend pas du risque, et le dire n'est pas « cout non estimable »
    expect(c.coutEstime!.montantGnf).toBe("7000000000"); // 2 km x 3,5 Md/km
    expect(c.coutNonEstimable).toBeNull();
  });
});

describe("Cout : unite, source, validite, ou refus motive", () => {
  it("rend l'unite, la classe de precision, la validite du bareme et le caractere provisoire", () => {
    const r = classer([fait("a", { etat: "MAUVAIS", longueurKm: 4, longueurGeometriqueM: 4000 })], { validitesBaremes: { "2": { version: 1, source: "standard_initial", validDe: null, validA: "2027-12-31" } } });
    const c = parId(r, "a").coutEstime!;
    expect(c.montantGnf).toBe("4400000000");
    expect(c.unite).toBe("KM");
    expect(c.devise).toBe("GNF");
    expect(c.classePrecision).toBe("RESEAU_30");
    expect(c.provisoire).toBe(true);
    expect(c.bareme).toMatchObject({ id: 2, typeIntervention: "rehabilitation", version: 1, source: "standard_initial", validDe: null, validA: "2027-12-31", approuve: false });
    expect(c.hypothesesManquantes).toContain("ligne de bareme non approuvee");
    expect(c.traitement.code).toBe("rehabilitation");
  });

  it("sans bareme (revetement sans famille de cout, etat BON, longueur inconnue) : coutNonEstimable motive, jamais un montant", () => {
    const r = classer([
      fait("r", { code: "R", revetement: "NON_RENSEIGNE" }),
      fait("b", { code: "B", etat: "BON" }),
      fait("l", { code: "L", longueurKm: null, longueurGeometriqueM: null }),
      fait("n", { code: "N", etat: "NON_EVALUE" }),
    ]);
    expect(parId(r, "r").coutNonEstimable!.code).toBe("FAMILLE_COUT_ABSENTE");
    expect(parId(r, "b").coutNonEstimable!.code).toBe("AUCUNE_CONDITION");
    expect(parId(r, "l").coutNonEstimable!.code).toBe("LONGUEUR_INVALIDE");
    expect(parId(r, "n").coutNonEstimable!.code).toBe("ETAT_NON_EVALUE");
    for (const id of ["r", "b", "l", "n"]) expect(parId(r, id).coutEstime).toBeNull();
  });
});

describe("Longueur metier et longueur geometrique : separees, jamais corrigees", () => {
  it("rend les deux, l'origine de celle du cout, et signale une divergence avec le detecteur de qualite", () => {
    // 10 km declares contre 8,5 km geometriques : ecart 17,6 %, au-dela du seuil provisoire de 10 %
    const r = classer([fait("a", { longueurKm: 10, longueurGeometriqueM: 8500 }), fait("b", { code: "T-b", longueurKm: 10, longueurGeometriqueM: 9900 })]);
    const a = parId(r, "a").longueur;
    expect(a).toMatchObject({ metierKm: 10, geometriqueM: 8500, utiliseeM: 10000, longueurOrigine: "LONGUEUR_KM" });
    expect(a.divergence.signalee).toBe(true);
    expect(a.divergence.ecartRelatif).toBeCloseTo(0.1765, 3);
    expect(a.divergence.statutSeuil).toBe("PROVISOIRE");
    expect(parId(r, "b").longueur.divergence.signalee).toBe(false); // 1 %
  });

  it("sans longueur metier, la longueur du cout vient de la geometrie ET LE DIT (longueurOrigine)", () => {
    const l = parId(classer([fait("a", { longueurKm: null, longueurGeometriqueM: 5432.1 })]), "a").longueur;
    expect(l).toMatchObject({ metierKm: null, geometriqueM: 5432.1, utiliseeM: 5432, longueurOrigine: "GEOMETRIE" });
    expect(l.divergence.signalee).toBe(false);
  });

  it("une longueur metier nulle ou negative n'est pas une longueur", () => {
    const l = parId(classer([fait("a", { longueurKm: 0, longueurGeometriqueM: 1000 })]), "a").longueur;
    expect(l.metierKm).toBeNull();
    expect(l.longueurOrigine).toBe("GEOMETRIE");
  });
});

describe("Localisation", () => {
  it("une geometrie inexploitable reste une ligne de la liste, marquee « invalide » avec son motif", () => {
    const r = classer([fait("a", { localisation: { valide: false, motif: "GEOMETRIE_ABSENTE" } }), fait("b", { code: "T-b" })]);
    expect(parId(r, "a").localisation).toBe("invalide");
    expect(parId(r, "a").localisationMotif).toBe("GEOMETRIE_ABSENTE");
    expect(parId(r, "a").prioriteTechnique.rang).not.toBeNull(); // classee malgre tout
    expect(parId(r, "b").localisation).toBe("valide");
    expect(parId(r, "b").localisationMotif).toBeNull();
  });
});

describe("Urgence temporelle (anciennete de la degradation connue)", () => {
  it("aucune inspection : critere absent, jamais zero", () => {
    expect(evaluerUrgence([], REF, 730)).toMatchObject({ disponible: false });
  });

  it("derniere inspection non degradee : valeur 0 (un constat, pas une absence)", () => {
    const u = evaluerUrgence([{ date: "2024-01-01", etat: "CRITIQUE" }, { date: "2025-06-01", etat: "BON" }], REF, 730);
    expect(u).toMatchObject({ disponible: true, valeur: 0, brut: 0 });
  });

  it("serie courante : depuis la PREMIERE inspection de la suite ininterrompue d'inspections degradees", () => {
    const u = evaluerUrgence([
      { date: "2024-01-01", etat: "MAUVAIS" }, { date: "2024-06-01", etat: "BON" }, // serie close par une inspection bonne
      { date: "2025-10-27", etat: "MAUVAIS" }, { date: "2026-03-01", etat: "CRITIQUE" },
    ], REF, 730);
    // debut 2025-10-27, reference 2026-10-27 : 365 jours / 730 = 50
    expect(u).toMatchObject({ disponible: true, valeur: 50, brut: 365, debutDegradation: "2025-10-27" });
  });

  it("borne a 100 au-dela du plafond", () => {
    expect(evaluerUrgence([{ date: "2020-01-01", etat: "CRITIQUE" }], REF, 730)).toMatchObject({ valeur: 100 });
  });

  it("ecarte, en les comptant, les constats futurs, sans etat ou de date invalide", () => {
    const u = evaluerUrgence([
      { date: "2027-01-01", etat: "CRITIQUE" }, { date: "2025-02-30", etat: "CRITIQUE" }, { date: "2025-01-01", etat: "NON_EVALUE" },
      { date: "2025-10-27", etat: "MAUVAIS" },
    ], REF, 730);
    expect(u).toMatchObject({ disponible: true, valeur: 50, constatsIgnores: 3 });
    expect(evaluerUrgence([{ date: "2027-01-01", etat: "CRITIQUE" }], REF, 730)).toMatchObject({ disponible: false, constatsIgnores: 1 });
  });

  it("independante de l'ordre des entrees, y compris a date egale (le pire etat de la journee est le dernier)", () => {
    const cs = [{ date: "2025-10-27", etat: "BON" }, { date: "2025-10-27", etat: "CRITIQUE" }, { date: "2025-01-01", etat: "MAUVAIS" }];
    expect(evaluerUrgence(cs, REF, 730)).toEqual(evaluerUrgence([...cs].reverse(), REF, 730));
    expect(evaluerUrgence(cs, REF, 730)).toMatchObject({ disponible: true });
  });

  it("joursEntre compte des jours calendaires", () => {
    expect(joursEntre("2026-10-27", "2026-10-27")).toBe(0);
    expect(joursEntre("2025-10-27", "2026-10-27")).toBe(365);
    expect(joursEntre("2024-02-28", "2024-03-01")).toBe(2);
  });
});

describe("Date du dernier constat", () => {
  it("la plus recente entre les inspections et la date d'evaluation du troncon, avec sa source", () => {
    const f = { constats: [{ date: "2026-05-01", etat: "MAUVAIS" }], dateDerniereEvaluation: "2026-03-01" };
    expect(dernierConstatDe(f, REF)).toEqual({ date: "2026-05-01", source: "inspections.dateInspection", ageJours: 179 });
    expect(dernierConstatDe({ ...f, dateDerniereEvaluation: "2026-08-01" }, REF)).toMatchObject({ date: "2026-08-01", source: "troncons.dateDerniereEvaluation" });
  });

  it("sans constat date : aucune date (null), pas la date du jour", () => {
    expect(dernierConstatDe({ constats: [], dateDerniereEvaluation: null }, REF)).toEqual({ date: null, source: null, ageJours: null });
  });

  it("un constat posterieur a la date de reference n'est pas le dernier constat", () => {
    expect(dernierConstatDe({ constats: [{ date: "2027-01-01", etat: "BON" }], dateDerniereEvaluation: null }, REF).date).toBeNull();
  });
});

describe("Provisoire tant que les parametres ne sont pas approuves", () => {
  const un = [fait("a", { etat: "MAUVAIS", traficMoyenJma: 1000 })];

  it("amorcage : provisoire, avec TOUS ses motifs", () => {
    const r = classer(un);
    expect(r.provisoire).toBe(true);
    expect(r.parametres.etiquette).toBe("PROVISOIRE, non approuvé");
    expect(r.parametres.blocOrigine).toBe("AMORCAGE_CODE");
    expect(r.motifsProvisoire.join(" | ")).toContain("parametres non approuves");
    expect(r.motifsProvisoire.join(" | ")).toContain("ne porte pas de bloc de priorite");
    expect(parId(r, "a").provisoire).toBe(true);
    expect(r.avertissement).toContain("Consultatif, non engageant");
  });

  it("version approuvee qui porte son bloc, dans sa validite : plus provisoire", () => {
    const r = classer(un, { parametres: avecBloc({ validiteDe: "2026-01-01", validiteA: "2026-12-31" }, true) });
    expect(r.provisoire).toBe(false);
    expect(r.motifsProvisoire).toEqual([]);
    expect(r.parametres).toMatchObject({ blocOrigine: "VERSION", etiquette: "paramètres approuvés", approuveeParId: "u-approbateur", validite: { de: "2026-01-01", a: "2026-12-31", horsValidite: false } });
    expect(parId(r, "a").provisoire).toBe(false);
  });

  it("approuvee mais HORS de sa periode de validite : provisoire, et le motif le dit", () => {
    const r = classer(un, { parametres: avecBloc({ validiteA: "2026-06-30" }, true) });
    expect(r.provisoire).toBe(true);
    expect(r.parametres.validite.horsValidite).toBe(true);
    expect(r.motifsProvisoire.join(" ")).toContain("hors de la periode de validite");
    const avant = classer(un, { parametres: avecBloc({ validiteDe: "2026-11-01" }, true) });
    expect(avant.provisoire).toBe(true);
  });
});

describe("Entrees refusees", () => {
  it("plus de 3 000 candidats : PERIMETRE_TROP_LARGE, pas de classement partiel", () => {
    const r = classerInterventions(entrees(Array.from({ length: MAX_CANDIDATS + 1 }, (_, i) => fait(`id-${i}`, { code: `C-${i}` }))));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PERIMETRE_TROP_LARGE");
  });

  it("candidat en double, code manquant, date de reference invalide, parametres invalides", () => {
    const doublon = classerInterventions(entrees([fait("a"), fait("a", { code: "autre" })]));
    expect(doublon.ok).toBe(false);
    const sansCode = classerInterventions(entrees([fait("a", { code: "" })]));
    expect(sansCode.ok).toBe(false);
    const date = classerInterventions(entrees([fait("a")], { dateReference: "2026-02-30" }));
    expect(date.ok).toBe(false);
    const p = parametresAmorcage(); p.valeurs.poidsRisque.ETAT = -1;
    const param = classerInterventions(entrees([fait("a")], { parametres: p }));
    expect(param.ok).toBe(false);
    if (!param.ok) expect(param.code).toBe("PARAMETRES_INVALIDES");
  });

  it("une liste vide donne un classement vide, pas une erreur", () => {
    const r = classer([]);
    expect(r.lignes).toEqual([]);
    expect(r.resume).toMatchObject({ candidats: 0, classes: 0, exclus: 0 });
  });
});

describe("Motif de la priorite (fiche, cahier 6.4)", () => {
  it("cite le rang, le score, les contributions principales et les criteres manquants", () => {
    const r = classer([fait("a", { etat: "CRITIQUE", traficMoyenJma: 2500 })]);
    const m = motifDeLaLigne(parId(r, "a"), r.resume.classes);
    expect(m).toContain("Priorite technique 1/1");
    expect(m).toContain("État / gravité");
    expect(m).toContain("Score incomplet");
    expect(m).toContain("Urgence temporelle");
  });

  it("pour une ligne exclue, dit pourquoi elle n'est pas classee", () => {
    const r = classer([fait("a", { etat: "NON_EVALUE" })]);
    expect(motifDeLaLigne(parId(r, "a"), 0)).toMatch(/^Non classee \(ETAT_NON_EVALUE\)/);
  });
});
