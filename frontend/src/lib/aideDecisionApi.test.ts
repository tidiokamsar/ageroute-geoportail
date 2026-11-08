import { beforeEach, describe, expect, it, vi } from "vitest";
import { dictionnaireReel, kpiReel, kpisReels, syntheseReelle } from "../components/decision/synthetique.testutil";

vi.mock("./api", () => ({ api: { get: vi.fn() } }));
import { api } from "./api";
import {
  analyserDictionnaire, analyserSynthese, classerErreurDecision, estErreurAutorisation, lireDictionnaire, lireKpi, lireSynthese, politiqueRetry, ReponseInattendue,
} from "./aideDecisionApi";

const get = api.get as unknown as ReturnType<typeof vi.fn>;

describe("garde de la reponse de /synthese : jamais de plantage", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["objet vide", {}],
    ["tableau", []],
    ["chaine", "<html>repli SPA</html>"],
    ["nombre", 0],
    ["kpis absent", { repartitionEtat: {}, budget: {} }],
    ["kpis non tableau", { kpis: { a: 1 } }],
  ])("%s : reponse inattendue (null), pas d'exception", (_nom, corps) => {
    expect(analyserSynthese(corps)).toBeNull();
  });
});

describe("lecteur sur les REPONSES REELLES du backend (composerSynthese)", () => {
  it("lit la reponse nationale entiere : douze indicateurs, aucune section ecartee", () => {
    const lu = analyserSynthese(syntheseReelle("nationale"));
    expect(lu).not.toBeNull();
    expect(lu?.kpis.map((k) => k.code)).toEqual([
      "reseau_degrade_pct", "reseau_critique_km", "reseau_critique_pct", "longueur_reseau_reference_km", "longueur_geometrique_km", "couverture_etat_part",
      "chantiers_en_cours", "chantiers_en_retard", "budget_engage_gnf", "budget_contractuel_gnf", "marches_recenses", "donnees_a_confirmer",
    ]);
    expect(lu?.kpisIgnores).toBe(0);
    for (const s of [lu?.repartitionEtat, lu?.degradationParRegion, lu?.budget, lu?.qualite, lu?.fraicheur]) expect(s?.ok).toBe(true);
    expect(lu?.perimetre).toMatchObject({ national: true, libelle: "Ensemble du pays" });
    expect(lu?.couverture).toMatchObject({ evalueKm: 700, eligibleKm: 200, nonEvalueKm: 100, etatNonValideKm: 500 });
  });

  it("lit les quatre reponses reelles (nationale, regionale sans droits, tronquee, vide) sans section inattendue", () => {
    for (const nom of ["nationale", "regionaleSansDroits", "tronque", "vide"] as const) {
      const lu = analyserSynthese(syntheseReelle(nom));
      expect(lu, nom).not.toBeNull();
      expect(lu?.kpisIgnores, nom).toBe(0);
      for (const [section, s] of Object.entries({ repartition: lu?.repartitionEtat, regions: lu?.degradationParRegion, budget: lu?.budget, qualite: lu?.qualite, fraicheur: lu?.fraicheur })) {
        expect(s?.ok, `${nom} / ${section}`).toBe(true);
      }
    }
  });

  it("repartitionEtat : classes {classe, km, troncons, partPct}, non evalues et etat non valide A PART", () => {
    const r = analyserSynthese(syntheseReelle("nationale"))?.repartitionEtat;
    expect(r?.ok && r.valeur.classes.map((c) => [c.classe, c.km, c.troncons, c.partPct])).toEqual([["BON", 70, 9, 35], ["MOYEN", 80, 8, 40], ["MAUVAIS", 30, 3, 15], ["CRITIQUE", 20, 2, 10]]);
    expect(r?.ok && r.valeur.nonEvalue).toEqual({ km: 100, troncons: 10, partDuPerimetre: 0.125 });
    expect(r?.ok && r.valeur.etatNonValide).toMatchObject({ km: 500, troncons: 5, partDuPerimetre: 0.625 });
    expect(r?.ok && r.valeur.longueurMetierAbsente).toEqual({ troncons: 2 });
  });

  it("degradationParRegion : {mention, regions[partDegradeePct, regionNom, nonEvalueKm...]}", () => {
    const d = analyserSynthese(syntheseReelle("nationale"))?.degradationParRegion;
    expect(d?.ok && d.valeur.mention).toMatch(/PAS un score de priorité/);
    expect(d?.ok && d.valeur.regions.map((r) => [r.regionNom, r.partDegradeePct, r.eligibleKm, r.nonEvalueKm])).toEqual([["Boké", 30, 100, 100], ["Kindia", 20, 100, 0]]);
  });

  it("budget.parBailleur : objet {etat, lignes[contractuelGnf, marches], autres, tronque}, montants en CHAINES", () => {
    const b = analyserSynthese(syntheseReelle("nationale"))?.budget;
    expect(b?.ok && b.valeur.contractuel.valeurGnf).toBe("9007199254740993");
    expect(b?.ok && b.valeur.parBailleur.etat).toBe("PARTIEL");
    expect(b?.ok && b.valeur.parBailleur.lignes.map((l) => [l.bailleur, l.contractuelGnf, l.marches])).toEqual([["Bailleur A", "9007199254740000", 2], ["Bailleur non renseigné", "993", 2]]);
    const t = analyserSynthese(syntheseReelle("tronque"))?.budget;
    expect(t?.ok && t.valeur.parBailleur).toMatchObject({ tronque: true, totalBailleurs: 3, autres: { bailleurs: 2, marches: 2, contractuelGnf: "993" } });
  });

  it("bailleur sans montant GNF : contractuelGnf null est LU (le panneau n'est pas rejete), avec marchesAvecMontantGnf", () => {
    const b = analyserSynthese(syntheseReelle("bailleurSansMontant"))?.budget;
    expect(b?.ok).toBe(true);
    expect(b?.ok && b.valeur.parBailleur.lignes.map((l) => [l.bailleur, l.contractuelGnf, l.marches, l.marchesAvecMontantGnf])).toEqual([["Bailleur A", "9007199254740000", 2, 2], ["Bailleur sans montant", null, 3, 0]]);
    const t = analyserSynthese(syntheseReelle("tronqueAutresSansMontant"))?.budget;
    expect(t?.ok && t.valeur.parBailleur.autres).toEqual({ bailleurs: 2, marches: 2, contractuelGnf: null });
  });

  it("un contractuelGnf NOMBRE sur une ligne bailleur reste refuse (precision perdue)", () => {
    const brut = syntheseReelle("bailleurSansMontant") as { budget: { parBailleur: { lignes: Record<string, unknown>[] } } };
    brut.budget.parBailleur.lignes[0].contractuelGnf = 12345;
    expect(analyserSynthese(brut)?.budget.ok).toBe(false);
  });

  it("budget sans droit : NON_AUTORISE est un etat LU (pas une reponse inattendue)", () => {
    const lu = analyserSynthese(syntheseReelle("regionaleSansDroits"));
    const b = lu?.budget;
    expect(b?.ok).toBe(true);
    expect(b?.ok && [b.valeur.contractuel.etat, b.valeur.decaisse.etat, b.valeur.previsionnel.etat, b.valeur.parBailleur.etat]).toEqual(["NON_AUTORISE", "NON_AUTORISE", "NON_AUTORISE", "NON_AUTORISE"]);
    expect(b?.ok && b.valeur.engage.etat).toBe("NON_DISPONIBLE");
    expect(lu?.perimetre).toMatchObject({ national: false, libelle: "Région Boké", regionId: 1 });
  });

  it("qualite : {total, population, parGravite{BLOQUANTE, A_TRAITER, A_SURVEILLER}}", () => {
    const q = analyserSynthese(syntheseReelle("nationale"))?.qualite;
    expect(q?.ok && q.valeur).toMatchObject({ total: 13, population: 37, parGravite: { BLOQUANTE: 0, A_TRAITER: 3, A_SURVEILLER: 10 }, donneesAConfirmer: 13, famillesNonExecutees: [] });
  });

  it("fraicheur : date de derniere evaluation et age en jours", () => {
    const f = analyserSynthese(syntheseReelle("nationale"))?.fraicheur;
    expect(f?.ok && f.valeur).toMatchObject({ calculeLe: "2026-10-26T12:00:00.000Z", derniereEvaluationLe: "2026-10-01T00:00:00.000Z", ageJours: 25 });
  });

  it("le perimetre vide : sections lues, tout inconnu reste null (jamais 0)", () => {
    const lu = analyserSynthese(syntheseReelle("vide"));
    expect(lu?.repartitionEtat.ok && lu.repartitionEtat.valeur.classes.every((c) => c.partPct === null)).toBe(true);
    expect(lu?.fraicheur.ok && lu.fraicheur.valeur.ageJours).toBeNull();
    expect(lu?.kpis.every((k) => k.etat === "NON_DISPONIBLE" && k.valeur === null)).toBe(true);
  });

  it("indicateurs : valeurTexte (montant exact), couverture detaillee, unites du dictionnaire", () => {
    expect(kpiReel("budget_contractuel_gnf")).toMatchObject({ valeur: null, valeurTexte: "9007199254740993", unite: "GNF", etat: "PARTIEL" });
    expect(kpiReel("reseau_degrade_pct").couverture).toMatchObject({ evalueKm: 700, eligibleKm: 200, nonEvalueKm: 100, etatNonValideKm: 500, tronconsSansLongueurMetier: 2 });
    expect(kpiReel("couverture_etat_part")).toMatchObject({ unite: "part", valeur: 0.25 });
    expect(kpiReel("donnees_a_confirmer").unite).toBe("éléments");
    expect(kpiReel("chantiers_en_cours").unite).toBe("nombre");
  });

  it("filtres non appliques rendus par le serveur : lus avec leur raison", () => {
    const lu = analyserSynthese(syntheseReelle("nationale", { filtres: { appliques: {}, nonAppliques: [{ nom: "etat", raison: "Non appliqué : raison du serveur." }, { nom: 3 }] } }));
    expect(lu?.filtresNonAppliques).toEqual([{ nom: "etat", raison: "Non appliqué : raison du serveur." }]);
  });
});

describe("garde : formes mal formees, par rapport a la forme REELLE", () => {
  it("ecarte et COMPTE les indicateurs mal formes, sans toucher aux autres", () => {
    const k = kpisReels();
    const lu = analyserSynthese(syntheseReelle("nationale", {
      kpis: [k[0], null, { ...k[1], etat: "INVENTE" }, { ...k[2], ouvre: { onglet: "nimporte", filtres: {} } }, { ...k[3], valeur: "12" }, "texte", { ...k[9], valeurTexte: Number.MAX_SAFE_INTEGER + 2 }],
    }));
    expect(lu?.kpis.map((x) => x.code)).toEqual(["reseau_degrade_pct"]);
    expect(lu?.kpisIgnores).toBe(6);
  });

  it("une section mal formee n'invalide que son panneau", () => {
    const lu = analyserSynthese(syntheseReelle("nationale", { repartitionEtat: { classes: "x" }, budget: null, qualite: { total: "beaucoup" }, degradationParRegion: { regions: [{}] } }));
    expect(lu?.kpis).toHaveLength(12);
    expect(lu?.repartitionEtat.ok).toBe(false);
    expect(lu?.budget.ok).toBe(false);
    expect(lu?.qualite.ok).toBe(false);
    expect(lu?.degradationParRegion.ok).toBe(false);
    expect(lu?.fraicheur.ok).toBe(true);
  });

  it("l'ANCIENNE forme inventee (classes[etat], regions en tableau nu, parBailleur en tableau) n'est plus lue", () => {
    const lu = analyserSynthese(syntheseReelle("nationale", {
      repartitionEtat: { classes: [{ etat: "BON", km: 1, nbTroncons: 1, partPct: 1 }], nonEvalue: { km: 1, nbTroncons: 1 }, eligibleKm: 1 },
      degradationParRegion: [{ regionId: 1, regionNom: "x", degradePct: 1, eligibleKm: 1, nonEvalueKm: 1 }],
    }));
    expect(lu?.repartitionEtat.ok).toBe(false);
    expect(lu?.degradationParRegion.ok).toBe(false);
  });

  it("un montant en NOMBRE est refuse (la chaine seule garde la precision)", () => {
    const brut = syntheseReelle("nationale") as { budget: { contractuel: Record<string, unknown> } };
    const lu = analyserSynthese({ ...brut, budget: { ...brut.budget, contractuel: { ...brut.budget.contractuel, valeurGnf: Number.MAX_SAFE_INTEGER + 2 } } });
    expect(lu?.budget.ok).toBe(false);
  });

  it("un etat de montant inconnu est refuse, NON_AUTORISE est accepte", () => {
    const brut = syntheseReelle("nationale") as { budget: { contractuel: Record<string, unknown> } };
    const faux = analyserSynthese({ ...brut, budget: { ...brut.budget, contractuel: { ...brut.budget.contractuel, etat: "INTERDIT" } } });
    expect(faux?.budget.ok).toBe(false);
  });

  it("repli prudent d'un indicateur : definition sans statut = PROVISOIRE, filtres d'ouverture assainis", () => {
    const k = lireKpi({
      code: "x", libelle: "X", valeur: 1, unite: "km", etat: "DISPONIBLE",
      ouvre: { onglet: "liste", filtres: { regionId: "7", etat: "BON,<b>,INVENTE", depuis: "n'importe quoi", classe: "RN,XX" } },
    });
    expect(k?.statutDefinition).toBe("PROVISOIRE");
    expect(k?.ouvre.filtres).toEqual({ regionId: 7, etat: ["BON"], classe: ["RN"] });
    expect(k?.avertissements).toEqual([]);
    expect(k?.periode).toBeNull();
    expect(k?.couverture).toBeNull();
  });
});

describe("dictionnaire REEL", () => {
  it("lit l'objet { indicateurs } avec conditionsCalcul, reglesExclusion, decisionsOuvertes, perimetre objet", () => {
    const d = analyserDictionnaire(dictionnaireReel());
    expect(d?.length).toBe(15);
    const e = d?.find((x) => x.code === "reseau_degrade_pct");
    expect(e?.perimetre.libelle.length).toBeGreaterThan(3);
    expect(e?.perimetre.definition.length).toBeGreaterThan(3);
    expect(e?.conditionsCalcul.length).toBeGreaterThan(0);
    expect(e?.reglesExclusion.length).toBeGreaterThan(0);
    expect(e?.decisionsOuvertes.length).toBe(3);
    expect(e?.responsableMetier).toMatch(/À confirmer/);
    expect(e?.statutDefinition).toBe("PROVISOIRE");
  });

  it("chaque indicateur de la synthese reelle a son entree de dictionnaire", () => {
    const codes = new Set(analyserDictionnaire(dictionnaireReel())?.map((x) => x.code));
    for (const k of kpisReels()) expect(codes.has(k.code), k.code).toBe(true);
  });

  it("accepte un tableau nu, refuse le reste", () => {
    expect(analyserDictionnaire([{ code: "a", conditionsCalcul: "une seule", perimetre: "texte" }])?.[0]).toMatchObject({ conditionsCalcul: ["une seule"], perimetre: { libelle: "texte" } });
    expect(analyserDictionnaire({ rien: 1 })).toBeNull();
    expect(analyserDictionnaire(null)).toBeNull();
    expect(analyserDictionnaire([{ libelle: "sans code" }])).toBeNull();
  });
});

describe("classement des erreurs et relance", () => {
  it("distingue 403, 401, 5xx, reseau et reponse inattendue", () => {
    expect(classerErreurDecision({ response: { status: 403, data: {} } }).genre).toBe("permission");
    expect(classerErreurDecision({ response: { status: 401 } }).genre).toBe("session");
    expect(classerErreurDecision({ response: { status: 500 } }).genre).toBe("serveur");
    expect(classerErreurDecision({ response: { status: 404 } }).genre).toBe("autre");
    expect(classerErreurDecision(new Error("Network Error")).genre).toBe("reseau");
    expect(classerErreurDecision(new ReponseInattendue("x")).genre).toBe("inattendue");
    expect(classerErreurDecision({ response: { status: 500, data: { error: "Panne SQL" } } }).message).toBe("Panne SQL");
  });

  it("un refus de droit ou de session ne se retente pas", () => {
    expect(estErreurAutorisation({ response: { status: 403 } })).toBe(true);
    expect(estErreurAutorisation({ response: { status: 500 } })).toBe(false);
  });

  it("politiqueRetry : jamais sur 400, 401, 403, 404 ni reponse mal formee ; une fois sur panne 5xx ou reseau", () => {
    for (const status of [400, 401, 403, 404]) expect(politiqueRetry(0, { response: { status } }), String(status)).toBe(false);
    expect(politiqueRetry(0, new ReponseInattendue("x"))).toBe(false);
    expect(politiqueRetry(0, { response: { status: 500 } })).toBe(true);
    expect(politiqueRetry(0, { response: { status: 503 } })).toBe(true);
    expect(politiqueRetry(0, new Error("Network Error"))).toBe(true);
    expect(politiqueRetry(1, { response: { status: 500 } })).toBe(false);
  });
});

describe("appels", () => {
  beforeEach(() => get.mockReset());

  it("lireSynthese envoie les filtres serialises et rend la forme lue", async () => {
    get.mockResolvedValue({ data: syntheseReelle("nationale") });
    const lu = await lireSynthese({ regionId: 3, etat: ["BON", "MOYEN"] });
    expect(get).toHaveBeenCalledWith("/v2/aide-decision/synthese", { params: { regionId: "3", etat: "BON,MOYEN" } });
    expect(lu.kpis).toHaveLength(12);
  });

  it("lireSynthese leve ReponseInattendue sur un corps mal forme, au lieu de le laisser passer", async () => {
    for (const corps of [{}, null, "<html>"]) {
      get.mockResolvedValue({ data: corps });
      await expect(lireSynthese({})).rejects.toBeInstanceOf(ReponseInattendue);
    }
  });

  it("lireDictionnaire interroge /dictionnaire et lit la reponse reelle", async () => {
    get.mockResolvedValue({ data: dictionnaireReel() });
    await expect(lireDictionnaire()).resolves.toHaveLength(15);
    expect(get).toHaveBeenCalledWith("/v2/aide-decision/dictionnaire");
  });
});
