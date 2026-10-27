import { describe, expect, it } from "vitest";
import {
  CODES_COUT_NON_FIABLE, MENTION_SIMULATION, affecterGroupe, basculer, classerAvertissements, construireDemande, deplacer, enMilliardsTexte, exportPorteLaMention,
  droitExportScenario, estCandidats, estComparaison, estDetail, estListe, estOptions, estRapportRejeu, estResultatCalcul, estScenarioSim, formaterKm, formaterPart, formaterPct, formaterSolde, relancer, formulaireVide, groupeDe, jourValide, lireDeficit, listerExclusions, partDe, purgerSelection, validerEnveloppe, validerPeriode,
  type FormulaireSimulation,
} from "./aideDecisionScenarios";
import { BILAN_DEFICIT, CANDIDATS, OPTIONS, comparaisonSim, detailSim, resumeSim, scenarioSim } from "../components/decision/simulation/simulation.fixtures";

/**
 * Noyau pur du simulateur (frontend). Ce que ces tests defendent :
 *   - l'enveloppe est numerique, NON NEGATIVE, en GNF entiers ; 0 est valide ; rien n'est converti en nombre flottant ;
 *   - un deficit n'est jamais masque (solde signe, deficit dit en toutes lettres, minorant dit) ;
 *   - une longueur metier absente se dit ; les proportions se calculent en BigInt ;
 *   - la demande envoyee au serveur ne contient que ce qui concerne la logique choisie, jamais une valeur par defaut inventee.
 */
const sp = (s: string) => s.replace(/[\s\u202f\u00a0]/g, " ");

describe("validerEnveloppe", () => {
  it("accepte des chiffres, avec ou sans espaces de groupement, et rend une CHAINE", () => {
    expect(validerEnveloppe("5000000000")).toEqual({ ok: true, chiffres: "5000000000" });
    expect(validerEnveloppe(" 5 000 000 000 ")).toEqual({ ok: true, chiffres: "5000000000" });
    expect(validerEnveloppe("5\u202f000\u202f000")).toEqual({ ok: true, chiffres: "5000000" });
  });
  it("0 est une enveloppe valide (tout sera ecarte), les zeros de tete sont retires", () => {
    expect(validerEnveloppe("0")).toEqual({ ok: true, chiffres: "0" });
    expect(validerEnveloppe("000120")).toEqual({ ok: true, chiffres: "120" });
  });
  it("18 chiffres au plus, sans perte de precision au-dela de 2^53", () => {
    expect(validerEnveloppe("999999999999999999")).toEqual({ ok: true, chiffres: "999999999999999999" });
    const r = validerEnveloppe("1000000000000000000");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erreur).toMatch(/18 chiffres/);
    expect(validerEnveloppe("9007199254740993")).toEqual({ ok: true, chiffres: "9007199254740993" });
  });
  it("refuse le vide, le negatif (trois signes moins), le decimal, les lettres, la notation scientifique", () => {
    expect(validerEnveloppe("")).toMatchObject({ ok: false });
    expect(validerEnveloppe("   ")).toMatchObject({ ok: false });
    for (const neg of ["-1", "-5000", "−100", "–100"]) {
      const r = validerEnveloppe(neg);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.erreur).toMatch(/négative/);
    }
    for (const dec of ["1,5", "1.5", "5000000,00"]) {
      const r = validerEnveloppe(dec);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.erreur).toMatch(/entiers/);
    }
    for (const x of ["abc", "12abc", "1e9", "5 Md", "0x10", "NaN", "Infinity"]) expect(validerEnveloppe(x).ok).toBe(false);
  });
});

describe("validerPeriode", () => {
  it("deux jours reels, fin >= debut, annee deduite du debut", () => {
    expect(validerPeriode("2027-01-01", "2027-12-31")).toEqual({ ok: true, annee: 2027 });
    expect(validerPeriode("2027-07-01", "2027-07-01")).toEqual({ ok: true, annee: 2027 });
    expect(validerPeriode("2027-01-01", "2029-12-31")).toEqual({ ok: true, annee: 2027 });
  });
  it("refuse un jour impossible, une fin avant le debut, une annee hors plage, plus de 10 ans", () => {
    expect(validerPeriode("2027-02-31", "2027-12-31").ok).toBe(false);
    expect(validerPeriode("2027-01-01", "2027-13-01").ok).toBe(false);
    expect(validerPeriode("", "2027-12-31").ok).toBe(false);
    const inv = validerPeriode("2027-12-31", "2027-01-01");
    expect(inv.ok).toBe(false);
    if (!inv.ok) expect(inv.erreur).toMatch(/précède/);
    expect(validerPeriode("1999-01-01", "1999-12-31").ok).toBe(false);
    expect(validerPeriode("2027-01-01", "2040-01-01").ok).toBe(false);
    expect(jourValide("2028-02-29")).toBe(true);
    expect(jourValide("2027-02-29")).toBe(false);
  });
});

describe("construireDemande : ce qui part au serveur", () => {
  const f = (o: Partial<FormulaireSimulation> = {}): FormulaireSimulation => ({ ...formulaireVide(2027), enveloppe: "5 000 000 000", logique: "ratio_cout_impact", ...o });

  it("le minimum : enveloppe en chaine, periode, annee du debut, logique ; aucun champ facultatif", () => {
    const r = construireDemande(f());
    expect(r).toEqual({ ok: true, demande: { annee: 2027, budgetGnf: "5000000000", periode: { debut: "2027-01-01", fin: "2027-12-31" }, logique: "ratio_cout_impact" } });
  });

  it("aucune valeur par defaut : un formulaire vide est refuse avec une erreur par champ, jamais une enveloppe 0", () => {
    const r = construireDemande(formulaireVide(2027));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.erreurs).sort()).toEqual(["enveloppe", "logique"]);
      expect(r.erreurs.enveloppe).toMatch(/aucune valeur n'est proposée/);
    }
  });

  it("les contraintes d'une autre logique ne sont pas envoyees (le serveur les refuserait)", () => {
    const r = construireDemande(f({ partMinimalePct: "20", ordrePersonnalise: ["a"] }));
    expect(r.ok && r.demande.equilibre).toBeFalsy();
    expect(r.ok && r.demande.ordrePersonnalise).toBeFalsy();
  });

  it("equilibre territorial : part entiere de 1 a 100 exigee", () => {
    for (const p of ["", "0", "101", "12,5", "abc"]) expect(construireDemande(f({ logique: "equilibre_territorial", partMinimalePct: p })).ok).toBe(false);
    const ok = construireDemande(f({ logique: "equilibre_territorial", partMinimalePct: "30" }));
    expect(ok.ok && ok.demande.equilibre).toEqual({ partMinimaleParRegionPct: 30 });
  });

  it("ordre personnalise : liste non vide exigee, envoyee dans son ordre", () => {
    expect(construireDemande(f({ logique: "personnalise" })).ok).toBe(false);
    const ok = construireDemande(f({ logique: "personnalise", ordrePersonnalise: ["b", "a"] }));
    expect(ok.ok && ok.demande.ordrePersonnalise).toEqual(["b", "a"]);
  });

  it("perimetre, selection, plafonds, obligatoires, groupes, baremes : envoyes seulement s'ils sont saisis", () => {
    const r = construireDemande(f({
      regionId: "2", classe: "RN", parametresId: "p-seed", selection: ["a", "b"], obligatoires: ["a"], groupes: [["a", "b"]], baremeIds: [2, 3],
      plafonds: [{ regionId: "1", montant: "3 000 000 000" }],
    }));
    expect(r).toEqual({
      ok: true,
      demande: {
        annee: 2027, budgetGnf: "5000000000", periode: { debut: "2027-01-01", fin: "2027-12-31" }, logique: "ratio_cout_impact",
        regionId: 2, classe: "RN", parametresId: "p-seed", selection: ["a", "b"], plafondsRegionauxGnf: { "1": "3000000000" }, obligatoires: ["a"], groupesNonDivisibles: [["a", "b"]], baremeIds: [2, 3],
      },
    });
  });

  it("plafond negatif, sans region, en double ; groupe d'un seul ; selection vide ; aucun bareme : refus nommes", () => {
    const e = (o: Partial<FormulaireSimulation>) => { const r = construireDemande(f(o)); return r.ok ? {} : r.erreurs; };
    expect(e({ plafonds: [{ regionId: "1", montant: "-5" }] }).plafond0).toMatch(/négative/);
    expect(e({ plafonds: [{ regionId: "", montant: "5" }] }).plafond0).toMatch(/région/);
    expect(e({ plafonds: [{ regionId: "1", montant: "5" }, { regionId: "1", montant: "6" }] }).plafond1).toMatch(/deux fois/);
    expect(e({ groupes: [["a"]] }).groupe0).toMatch(/au moins deux/);
    expect(e({ groupes: [["a", "b"], ["b", "c"]] }).groupes).toMatch(/seul groupe/);
    expect(e({ selection: [] }).selection).toMatch(/Aucune intervention/);
    expect(e({ baremeIds: [] }).baremes).toMatch(/Aucun barème/);
  });

  it("l'enveloppe invalide est refusee meme si tout le reste est bon", () => {
    for (const x of ["-1", "1,5", "abc", ""]) expect(construireDemande(f({ enveloppe: x })).ok).toBe(false);
  });
});

describe("listes : selection, groupes, ordre", () => {
  it("basculer ajoute ou retire sans doublon ni effet de bord", () => {
    const l = ["a"];
    expect(basculer(l, "b")).toEqual(["a", "b"]);
    expect(basculer(["a", "b"], "a")).toEqual(["b"]);
    expect(l).toEqual(["a"]);
  });
  it("deplacer reste dans les bornes", () => {
    expect(deplacer(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(deplacer(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(deplacer(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(deplacer(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
    expect(deplacer(["a"], 5, 1)).toEqual(["a"]);
  });
  it("affecterGroupe : un groupe nouveau, un groupe existant, le retrait, la disparition d'un groupe vide", () => {
    let g = affecterGroupe([], "a", 1);
    expect(g).toEqual([["a"]]);
    g = affecterGroupe(g, "b", 1);
    expect(g).toEqual([["a", "b"]]);
    g = affecterGroupe(g, "c", 2);
    expect(g).toEqual([["a", "b"], ["c"]]);
    expect(groupeDe(g, "c")).toBe(2);
    g = affecterGroupe(g, "a", 2);                 // a quitte le groupe 1 pour le groupe 2
    expect(g).toEqual([["b"], ["c", "a"]]);
    g = affecterGroupe(g, "b", null);              // retrait : le groupe 1 devient vide et disparait
    expect(g).toEqual([["c", "a"]]);
    expect(groupeDe(g, "zzz")).toBeNull();
    expect(affecterGroupe([["a"]], "b", 9)).toEqual([["a"]]); // numero hors bornes : sans effet
  });
  it("purgerSelection : une intervention decochee n'est plus obligatoire, dans un groupe ni dans l'ordre", () => {
    const base: FormulaireSimulation = { ...formulaireVide(2027), obligatoires: ["a", "b"], ordrePersonnalise: ["b", "a", "c"], groupes: [["a", "b"], ["c", "d"]] };
    const r = purgerSelection(base, ["a", "c"]);
    expect(r.selection).toEqual(["a", "c"]);
    expect(r.obligatoires).toEqual(["a"]);
    expect(r.ordrePersonnalise).toEqual(["a", "c"]);
    expect(r.groupes).toEqual([["a"], ["c"]]);
    expect(purgerSelection(base, null).obligatoires).toEqual(["a", "b"]);
  });
});

describe("affichage : le deficit n'est jamais masque", () => {
  it("formaterSolde garde le signe et groupe les chiffres", () => {
    expect(sp(formaterSolde("-3700000000"))).toBe("- 3 700 000 000 GNF");
    expect(sp(formaterSolde("1300000000"))).toBe("1 300 000 000 GNF");
    expect(sp(formaterSolde("0"))).toBe("0 GNF");
    expect(formaterSolde("abc")).toBe("non calculable");
    expect(formaterSolde("-1")).toMatch(/^-/);
  });

  it("un deficit est dit en alerte, avec son montant et le besoin", () => {
    const d = lireDeficit(BILAN_DEFICIT);
    expect(d.niveau).toBe("deficit");
    expect(sp(d.titre)).toBe("Déficit de 3 700 000 000 GNF");
    expect(sp(d.detail)).toContain("8 700 000 000 GNF");
  });

  it("un deficit de 1 franc est un deficit (pas arrondi a zero)", () => {
    const d = lireDeficit({ ...BILAN_DEFICIT, deficitGnf: "1", soldeGnf: "-1" });
    expect(d.niveau).toBe("deficit");
    expect(sp(d.titre)).toBe("Déficit de 1 GNF");
  });

  it("minorant : le deficit dit qu'il est un minimum quand des couts manquent", () => {
    const d = lireDeficit({ ...BILAN_DEFICIT, deficitMinorant: true, nbCoutsNonFiables: 2 });
    expect(d.detail).toMatch(/un minimum.*2 candidat\(s\) sans coût fiable/);
    expect(lireDeficit(BILAN_DEFICIT).detail).not.toMatch(/un minimum/);
  });

  it("excedent et egalite sont dits comme tels, jamais comme un « 0 » nu", () => {
    const ex = lireDeficit({ ...BILAN_DEFICIT, deficitGnf: "0", excedentGnf: "1300000000", soldeGnf: "1300000000" });
    expect(ex.niveau).toBe("excedent");
    expect(sp(ex.titre)).toBe("Aucun déficit : excédent de 1 300 000 000 GNF");
    const eg = lireDeficit({ ...BILAN_DEFICIT, deficitGnf: "0", excedentGnf: "0", soldeGnf: "0" });
    expect(eg.niveau).toBe("equilibre");
    expect(eg.titre).toMatch(/égale le besoin/);
  });
});

describe("affichage : kilometres, pourcentages, proportions", () => {
  it("une longueur metier absente se dit (jamais 0 ni la geometrique)", () => {
    expect(formaterKm(null)).toBe("longueur métier absente");
    expect(sp(formaterKm("12.345"))).toBe("12,345 km");
    expect(sp(formaterKm("0.000"))).toBe("0,000 km");
  });
  it("pourcentage absent = non calculable, pas 0 %", () => {
    expect(formaterPct(null)).toBe("non calculable");
    expect(sp(formaterPct("54.6"))).toBe("54,6 %");
  });
  it("partDe : BigInt, borne a 100 ; un ratio INDEFINI vaut null, jamais 0 (denominateur nul ou valeur invalide)", () => {
    expect(partDe("4300000000", "5000000000")).toBe(86);
    expect(partDe("1", "3")).toBe(33.3);
    expect(partDe("9007199254740993", "9007199254740993")).toBe(100);
    expect(partDe("10", "5")).toBe(100);
    expect(partDe("5", "0")).toBeNull();
    expect(partDe("0", "0")).toBeNull();
    expect(partDe("x", "5")).toBeNull();
    expect(partDe("0", "5")).toBe(0);                    // 0 sur un denominateur connu est un VRAI zero
  });

  it("formaterPart : « non calculable » pour un ratio indefini, jamais « 0 % »", () => {
    expect(formaterPart(null)).toBe("non calculable");
    expect(sp(formaterPart(0))).toBe("0 %");
    expect(sp(formaterPart(86))).toBe("86 %");
    expect(sp(formaterPart(33.3))).toBe("33,3 %");
    expect(formaterPart(partDe("0", "0"))).not.toMatch(/0/);
  });
  it("enMilliardsTexte", () => {
    expect(sp(enMilliardsTexte("5000000000"))).toBe("5 Md GNF");
    expect(sp(enMilliardsTexte("8700000000"))).toBe("8,70 Md GNF");
    expect(sp(enMilliardsTexte("1234"))).toBe("1 234 GNF");
    expect(enMilliardsTexte("x")).toBe("non calculable");
  });
});

describe("exclusions et avertissements", () => {
  it("listerExclusions : tri par frequence, libelles, couts non fiables reperes", () => {
    const l = listerExclusions({ BUDGET_INSUFFISANT: 1, COUT_PERIME: 3, COUT_NON_ESTIMABLE: 3, INCONNU: 1 });
    expect(l.map((x) => x.code)).toEqual(["COUT_NON_ESTIMABLE", "COUT_PERIME", "BUDGET_INSUFFISANT", "INCONNU"]);
    expect(l.find((x) => x.code === "COUT_PERIME")).toMatchObject({ libelle: "Coût périmé pour la période", coutNonFiable: true });
    expect(l.find((x) => x.code === "BUDGET_INSUFFISANT")?.coutNonFiable).toBe(false);
    expect(l.find((x) => x.code === "INCONNU")?.libelle).toBe("INCONNU");
    expect(CODES_COUT_NON_FIABLE).toContain("COUT_PERIME");
  });
  it("classerAvertissements : les alertes d'abord, l'ordre serveur conserve par niveau", () => {
    const r = classerAvertissements([
      { code: "I1", niveau: "INFO", nb: null, message: "" }, { code: "A1", niveau: "ALERTE", nb: null, message: "" },
      { code: "I2", niveau: "INFO", nb: null, message: "" }, { code: "A2", niveau: "ALERTE", nb: null, message: "" },
    ]);
    expect(r.map((x) => x.code)).toEqual(["A1", "A2", "I1", "I2"]);
  });
});

describe("export : la mention est exigee", () => {
  it("reconnait la mention, avec ou sans BOM", () => {
    expect(exportPorteLaMention(`\uFEFF${MENTION_SIMULATION}\nSection;Clé;Valeur`)).toBe(true);
    expect(exportPorteLaMention(JSON.stringify({ mention: MENTION_SIMULATION }))).toBe(true);
  });
  it("refuse un export qui ne la porte pas", () => {
    expect(exportPorteLaMention("Section;Clé;Valeur\nBilan;Déficit;0")).toBe(false);
    expect(exportPorteLaMention("")).toBe(false);
    expect(exportPorteLaMention("simulation engageante")).toBe(false);
  });
  it("la constante est celle du serveur", () => {
    expect(MENTION_SIMULATION).toBe("SIMULATION NON ENGAGEANTE : ne constitue ni une autorisation de dépense ni un ordre de travaux.");
  });
});

describe("droitExportScenario : la regle du serveur (module rapports ET role ADMIN ou GESTIONNAIRE)", () => {
  it("ADMIN n'est jamais restreint, meme avec une liste de modules vide", () => {
    expect(droitExportScenario({ role: "ADMIN", modulesAutorises: [] })).toEqual({ ok: true });
    expect(droitExportScenario({ role: "ADMIN" })).toEqual({ ok: true });
  });
  it("un gestionnaire a besoin du module rapports ; une liste VIDE vaut AUCUN module (et non « tous »)", () => {
    expect(droitExportScenario({ role: "GESTIONNAIRE", modulesAutorises: ["rapports", "decision"] })).toEqual({ ok: true });
    const sans = droitExportScenario({ role: "GESTIONNAIRE", modulesAutorises: ["decision", "programmation"] });
    expect(sans).toMatchObject({ ok: false });
    expect(sans.ok === false && sans.raison).toMatch(/module Rapports/);
    expect(droitExportScenario({ role: "GESTIONNAIRE", modulesAutorises: [] }).ok).toBe(false);
    expect(droitExportScenario({ role: "GESTIONNAIRE" }).ok).toBe(false);
  });
  it("lecteur et inspecteur n'exportent pas, meme avec le module rapports ; un compte inconnu non plus", () => {
    for (const role of ["LECTEUR", "INSPECTEUR"]) {
      const v = droitExportScenario({ role, modulesAutorises: ["rapports"] });
      expect(v.ok).toBe(false);
      expect(v.ok === false && v.raison).toMatch(/administrateur et gestionnaire/);
    }
    expect(droitExportScenario(null).ok).toBe(false);
    expect(droitExportScenario(undefined).ok).toBe(false);
  });
});

describe("relancer : une seule relance, aucune sur 400, 401, 403, 404", () => {
  const e = (status: number) => ({ response: { status } });
  it("aucune relance sur une erreur que la relance ne corrige pas", () => {
    for (const st of [400, 401, 403, 404]) expect(relancer(0, e(st))).toBe(false);
  });
  it("une relance sur 422, 500, 503 ou une erreur sans reponse, puis plus", () => {
    for (const x of [e(422), e(500), e(503), new Error("reseau"), null]) { expect(relancer(0, x)).toBe(true); expect(relancer(1, x)).toBe(false); }
  });
});

describe("gardes d'execution : une reponse mal formee est refusee, une reponse conforme passe", () => {
  it("les reponses fabriquees par les fixtures (forme du serveur) passent", () => {
    expect(estScenarioSim(scenarioSim())).toBe(true);
    expect(estScenarioSim({ ...scenarioSim(), simulation: undefined })).toBe(true);      // scenario herite
    expect(estResultatCalcul({ resultat: scenarioSim(), empreinteEntrees: "e", empreinteResultat: "r", enregistre: false })).toBe(true);
    expect(estOptions(OPTIONS)).toBe(true);
    expect(estOptions({ ...OPTIONS, baremes: null })).toBe(true);
    expect(estCandidats(CANDIDATS)).toBe(true);
    expect(estListe({ data: [resumeSim("a"), resumeSim("b", { simulateur: false, logique: null, periode: null, deficitGnf: null, deficitMinorant: null })], total: 2, page: 1, pageSize: 20 })).toBe(true);
    expect(estDetail(detailSim("a"))).toBe(true);
    expect(estDetail(detailSim("a", { simulateur: false }))).toBe(true);
    expect(estComparaison(comparaisonSim())).toBe(true);
    expect(estRapportRejeu({ identique: true, entreesIntegres: true, empreinteStockee: "a", empreinteRecalculee: "a", explication: "x" })).toBe(true);
  });

  it("rien de ce qui n'est pas un objet conforme ne passe (null, texte, tableau, objet vide)", () => {
    for (const garde of [estScenarioSim, estResultatCalcul, estOptions, estCandidats, estListe, estDetail, estComparaison, estRapportRejeu]) {
      for (const v of [null, undefined, "texte", 3, [], {}]) expect(garde(v)).toBe(false);
    }
  });

  it("un champ que l'ecran lit et qui manque ou change de type est refuse", () => {
    const s = scenarioSim();
    const sans = (cle: string) => { const c = structuredClone(s) as unknown as Record<string, unknown>; delete c[cle]; return c; };
    for (const cle of ["lignes", "totaux", "parametres", "limites", "motifsProvisoire", "budgetGnf"]) expect(estScenarioSim(sans(cle))).toBe(false);
    const bilanCasse = structuredClone(s); (bilanCasse.simulation!.bilan as unknown as { deficitGnf: unknown }).deficitGnf = 3700000000;
    expect(estScenarioSim(bilanCasse)).toBe(false);                                         // un montant en nombre, pas en chaine
    const soldeCasse = structuredClone(s); (soldeCasse.simulation!.bilan as unknown as { soldeGnf: unknown }).soldeGnf = "-1.5";
    expect(estScenarioSim(soldeCasse)).toBe(false);
    const negatif = structuredClone(s); negatif.simulation!.bilan.deficitGnf = "-5";
    expect(estScenarioSim(negatif)).toBe(false);                                             // un deficit n'est jamais negatif
    const ligneCassee = structuredClone(s); (ligneCassee.lignes[0] as unknown as { troncon: unknown }).troncon = null;
    expect(estScenarioSim(ligneCassee)).toBe(false);
    const sansAvert = structuredClone(s); (sansAvert.simulation as unknown as { avertissements: unknown }).avertissements = "x";
    expect(estScenarioSim(sansAvert)).toBe(false);
  });

  it("liste, detail, comparaison, options : cles et types essentiels", () => {
    expect(estListe({ data: [{ id: "a" }], total: 1, page: 1, pageSize: 20 })).toBe(false);
    expect(estListe({ data: [], total: 0, page: 1, pageSize: 0 })).toBe(false);
    expect(estDetail({ ...detailSim("a"), entrees: { nbCandidats: "3" } })).toBe(false);
    const c = comparaisonSim(); c.hypotheses[0].valeurs = ["une seule"];
    expect(estComparaison(c)).toBe(false);                                                   // une valeur par scenario
    expect(estComparaison({ ...comparaisonSim(), scenarios: [comparaisonSim().scenarios[0]] })).toBe(false);
    expect(estOptions({ ...OPTIONS, devise: "EUR" })).toBe(false);
    expect(estOptions({ ...OPTIONS, logiques: [{ code: "x" }] })).toBe(false);
  });
});
