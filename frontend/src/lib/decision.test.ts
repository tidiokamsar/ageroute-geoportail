import { describe, expect, it } from "vitest";
import { kpiReel, MAINTENANT_SYNTHETIQUE, syntheseReelle } from "../components/decision/synthetique.testutil";
import { analyserSynthese, type KpiLu, type RepartitionEtat } from "./aideDecisionApi";
import {
  affichageKpi, arcsAnneau, ageEnJours, dateValide, ecrireUrl, erreurPeriode, evaluerFraicheur, filtresEgaux, formaterGnf, formaterPct, formaterKm,
  lireFiltres, lireOnglet, nombreFiltresActifs, nomRegion, normaliserFiltres, ONGLETS, paramsApi, partDuTotalContractuel, partMontant, repartitionVide,
  segmentsRepartition, serialiserFiltres, texteCouverture, textePeriode, totalGnf, trierBailleurs, trierRegions,
} from "./decision";

const nette = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
const lecture = (nom: Parameters<typeof syntheseReelle>[0] = "nationale") => analyserSynthese(syntheseReelle(nom))!;
const repartitionReelle = (): RepartitionEtat => {
  const r = lecture().repartitionEtat;
  if (!r.ok) throw new Error("repartition reelle illisible");
  return r.valeur;
};

describe("filtres partages et URL (contrat paragraphe 3)", () => {
  it("serialise dans un ordre stable et relit les memes filtres (aller-retour)", () => {
    const f = { regionId: 4, classe: ["RN", "RR"], etat: ["CRITIQUE"], statutChantier: ["EN_COURS"], depuis: "2026-01-01", jusqua: "2026-06-30" };
    const p = serialiserFiltres(f);
    expect(p.toString()).toBe("regionId=4&classe=RN%2CRR&etat=CRITIQUE&statutChantier=EN_COURS&depuis=2026-01-01&jusqua=2026-06-30");
    expect(lireFiltres(p)).toEqual(f);
    expect(lireFiltres(`?${p.toString()}`)).toEqual(f);
  });

  it("des filtres vides donnent des parametres vides", () => {
    expect(serialiserFiltres({}).toString()).toBe("");
    expect(lireFiltres("")).toEqual({});
    expect(nombreFiltresActifs({})).toBe(0);
  });

  it("ecarte les valeurs HORS ENUMERATION (le serveur repondrait 400) : classe, etat, statut de chantier", () => {
    expect(lireFiltres("classe=RN,XX,rn,PISTE&etat=BON,SUPER&statutChantier=EN_COURS,FINI")).toEqual({ classe: ["RN", "PISTE"], etat: ["BON"], statutChantier: ["EN_COURS"] });
    expect(lireFiltres("classe=XX&etat=<script>&statutChantier=")).toEqual({});
  });

  it("plafonne les listes a 10 elements (limite du serveur)", () => {
    const f = normaliserFiltres({ classe: ["RN", "RR", "RU", "PISTE", "NON_CLASSEE", "RN", "RR"] });
    expect(f.classe).toEqual(["RN", "RR", "RU", "PISTE", "NON_CLASSEE"]);
  });

  it("ecarte les dates hors 2000-2100, au mauvais format ou impossibles (le serveur repondrait 400)", () => {
    expect(lireFiltres("depuis=1999-12-31&jusqua=2101-01-01")).toEqual({});
    expect(lireFiltres("depuis=0002-05-01")).toEqual({});
    expect(lireFiltres("depuis=2000-01-01&jusqua=2100-12-31")).toEqual({ depuis: "2000-01-01", jusqua: "2100-12-31" });
    expect(lireFiltres("depuis=2026-02-31&jusqua=hier")).toEqual({});
    expect(lireFiltres("depuis=2026-1-5")).toEqual({});
    expect(dateValide("2026-10-26")).toBe(true);
    expect(dateValide("2026-02-30")).toBe(false);
    expect(dateValide("2101-01-01")).toBe(false);
    expect(dateValide("")).toBe(false);
  });

  it("ignore une region non entiere ou hors borne et une URL hostile sans planter", () => {
    expect(lireFiltres("regionId=abc")).toEqual({});
    expect(lireFiltres("regionId=-3")).toEqual({});
    expect(lireFiltres("regionId=0")).toEqual({});
    expect(lireFiltres("regionId=12.5")).toEqual({});
    expect(lireFiltres("regionId=1234567890")).toEqual({});
  });

  it("normaliserFiltres accepte un objet quelconque sans planter", () => {
    expect(normaliserFiltres(null)).toEqual({});
    expect(normaliserFiltres("x")).toEqual({});
    expect(normaliserFiltres({ regionId: 3, classe: "RN,RR", inconnu: 1 })).toEqual({ regionId: 3, classe: ["RN", "RR"] });
  });

  it("paramsApi est la meme serialisation, en objet pour axios", () => {
    expect(paramsApi({ regionId: 2, etat: ["BON", "MOYEN"] })).toEqual({ regionId: "2", etat: "BON,MOYEN" });
  });

  it("ecrit l'onglet (sauf le defaut) et les filtres en conservant les parametres etrangers", () => {
    const base = new URLSearchParams("autre=1&regionId=9&onglet=liste");
    expect(ecrireUrl(base, "carte", {}).toString()).toBe("autre=1");
    expect(ecrireUrl(base, "scenarios", { regionId: 2 }).toString()).toBe("autre=1&onglet=scenarios&regionId=2");
  });

  it("lit l'onglet, avec repli sur Carte pour une valeur inconnue", () => {
    expect(lireOnglet(new URLSearchParams("onglet=rapports"))).toBe("rapports");
    expect(lireOnglet(new URLSearchParams("onglet=bidon"))).toBe("carte");
    expect(lireOnglet(new URLSearchParams(""))).toBe("carte");
  });

  it("compte les filtres actifs (la periode compte pour un) et detecte l'egalite", () => {
    expect(nombreFiltresActifs({ regionId: 1, etat: ["BON"], depuis: "2026-01-01", jusqua: "2026-02-01" })).toBe(3);
    expect(filtresEgaux({ etat: ["BON"] }, { etat: ["BON"] })).toBe(true);
    expect(filtresEgaux({ etat: ["BON"] }, { etat: ["MOYEN"] })).toBe(false);
  });

  it("signale une periode incoherente", () => {
    expect(erreurPeriode({ depuis: "2026-05-01", jusqua: "2026-04-01" })).toMatch(/postérieure/);
    expect(erreurPeriode({ depuis: "2026-04-01", jusqua: "2026-04-01" })).toBeNull();
    expect(erreurPeriode({ depuis: "2026-04-01" })).toBeNull();
  });

  it("les six onglets de la maquette, dans l'ordre", () => {
    expect(ONGLETS.map((o) => o.libelle)).toEqual(["Carte et priorisation", "Liste des interventions", "Simulation budgétaire", "Suivi contractuel", "Scénarios", "Rapports"]);
  });
});

describe("montants en GNF : jamais de flottant", () => {
  it("garde chaque chiffre au-dela de 2^53", () => {
    // Number("9007199254740993") vaut 9007199254740992 : la precision serait perdue.
    expect(nette(formaterGnf("9007199254740993"))).toBe("9 007 199 254 740 993 GNF");
  });

  it("abrege par calcul entier, au dixieme", () => {
    expect(nette(formaterGnf("20200000000000", true))).toBe("20,2 T GNF");
    expect(nette(formaterGnf("20000000000000", true))).toBe("20 T GNF");
    expect(nette(formaterGnf("3500000000", true))).toBe("3,5 Md GNF");
    expect(nette(formaterGnf("1500000", true))).toBe("1,5 M GNF");
    expect(nette(formaterGnf("999999", true))).toBe("999 999 GNF");
  });

  it("dit l'absence et l'illisible en mots, jamais 0", () => {
    expect(formaterGnf(null)).toBe("Non disponible");
    expect(formaterGnf(undefined)).toBe("Non disponible");
    expect(formaterGnf("12abc")).toBe("Montant illisible");
    expect(formaterGnf("")).toBe("Montant illisible");
  });

  it("conserve un zero REEL envoye par le serveur", () => {
    expect(nette(formaterGnf("0"))).toBe("0 GNF");
  });

  it("calcule des parts et des totaux par entiers", () => {
    const { total, illisibles } = totalGnf(["3000000000", "1000000000", "n/a"]);
    expect(total).toBe(BigInt("4000000000"));
    expect(illisibles).toBe(1);
    expect(partMontant("3000000000", total)).toBe(75);
    expect(partMontant("n/a", total)).toBeNull();
    expect(partMontant("1", BigInt(0))).toBeNull();
  });

  it("la part par bailleur se calcule sur le total CONTRACTUEL du budget, pas sur la somme des lignes affichees", () => {
    // Reponse reelle tronquee : ligne A = 9007199254740000, « autres » = 993, total contractuel = 9007199254740993.
    const lu = lecture("tronque");
    const budget = lu.budget.ok ? lu.budget.valeur : null;
    const ligneA = budget!.parBailleur.lignes[0].contractuelGnf;
    const total = budget!.contractuel.valeurGnf;
    expect(total).toBe("9007199254740993");
    // Sur le total contractuel complet (lignes + « autres »), A pese 99,9 % (calcul entier, arrondi par defaut au dixieme).
    expect(partDuTotalContractuel(ligneA, total)).toBe(99.9);
    // Un denominateur construit sur les seules lignes affichees donnerait 100 % : c'est l'erreur que ce calcul evite.
    expect(partDuTotalContractuel(ligneA, ligneA)).toBe(100);
    expect(partDuTotalContractuel("500", "1000")).toBe(50);
    expect(partDuTotalContractuel("500", null)).toBeNull();
    expect(partDuTotalContractuel(null, "1000")).toBeNull(); // montant inconnu : pas de part, jamais 0 %
    expect(partDuTotalContractuel("500", "illisible")).toBeNull();
    expect(partDuTotalContractuel("500", "0")).toBeNull();
  });

  it("trie les bailleurs du plus gros au plus petit, les illisibles en fin", () => {
    const l = (bailleur: string, contractuelGnf: string | null) => ({ bailleurId: null, bailleur, marches: 1, contractuelGnf, marchesAvecMontantGnf: contractuelGnf === null ? 0 : 1, decaisseGnf: null, marchesSansMontant: 0, marchesHorsGnf: 0 });
    expect(trierBailleurs([l("B", "10"), l("X", "illisible"), l("A", "9007199254740993")]).map((x) => x.bailleur)).toEqual(["A", "B", "X"]);
    // un montant inconnu (null) va en fin de liste, jamais compare comme 0
    expect(trierBailleurs([l("N", null), l("B", "10"), l("Z", "0")]).map((x) => x.bailleur)).toEqual(["B", "Z", "N"]);
  });
});

describe("lecture d'un indicateur REEL : l'etat decide, jamais un zero", () => {
  const avec = (code: string, p: Partial<KpiLu> = {}): KpiLu => ({ ...kpiReel(code), ...p });

  it("NON_DISPONIBLE n'affiche aucune valeur, meme si le serveur en joint une (y compris 0)", () => {
    for (const valeur of [null, 0, 123]) {
      const a = affichageKpi(avec("budget_engage_gnf", { valeur }));
      expect(a.valeur).toBeNull();
      expect(a.raison).toMatch(/source financière de référence non validée/);
    }
  });

  it("un montant GNF non representable (valeur null) montre la valeurTexte EXACTE, pas « indisponible »", () => {
    const k = kpiReel("budget_contractuel_gnf");
    expect(k.valeur).toBeNull();
    const a = affichageKpi(k);
    expect(a.raison).toBeNull();
    expect(nette(a.valeur ?? "")).toBe("9 007 199 254 740 993");
    expect(a.unite).toBe("GNF");
  });

  it("valeurTexte illisible : dit, jamais 0", () => {
    const a = affichageKpi(avec("budget_contractuel_gnf", { valeurTexte: "12abc" }));
    expect(a.valeur).toBeNull();
    expect(a.raison).toMatch(/illisible/);
  });

  it("une valeur absente d'un indicateur DISPONIBLE n'est pas 0", () => {
    const a = affichageKpi(avec("chantiers_en_cours", { valeur: null }));
    expect(a.valeur).toBeNull();
    expect(affichageKpi(avec("chantiers_en_cours", { valeur: Number.NaN })).valeur).toBeNull();
  });

  it("l'unite « part » (fraction 0..1) se montre en POURCENTAGE, jamais « 0 part »", () => {
    expect(nette(affichageKpi(kpiReel("couverture_etat_part")).valeur ?? "")).toBe("25");
    expect(affichageKpi(kpiReel("couverture_etat_part")).unite).toBe("%");
    const a = affichageKpi(avec("couverture_etat_part", { valeur: 0.5455 }));
    expect(nette(a.valeur ?? "")).toBe("54,55");
    expect(a.unite).toBe("%");
    expect(nette(affichageKpi(avec("couverture_etat_part", { valeur: 0.125 })).valeur ?? "")).toBe("12,5");
    // un zero REEL du serveur reste un zero
    expect(affichageKpi(avec("couverture_etat_part", { valeur: 0 })).valeur).toBe("0");
  });

  it("l'unite « nombre » n'est jamais imprimee (« 5 », pas « 5 nombre »), « éléments » reste lisible", () => {
    expect(affichageKpi(kpiReel("chantiers_en_cours"))).toMatchObject({ valeur: "5", unite: "" });
    expect(affichageKpi(kpiReel("marches_recenses"))).toMatchObject({ valeur: "4", unite: "" });
    expect(affichageKpi(kpiReel("donnees_a_confirmer"))).toMatchObject({ valeur: "13", unite: "éléments" });
    expect(affichageKpi(avec("donnees_a_confirmer", { unite: "elements" })).unite).toBe("éléments");
  });

  it("formate % et km avec une decimale, depuis les indicateurs reels", () => {
    expect(affichageKpi(kpiReel("reseau_degrade_pct"))).toMatchObject({ valeur: "25", unite: "%" });
    expect(nette(affichageKpi(avec("reseau_degrade_pct", { valeur: 12.34 })).valeur ?? "")).toBe("12,3");
    expect(nette(affichageKpi(kpiReel("longueur_geometrique_km")).valeur ?? "")).toBe("812,5");
  });

  it("un montant en flottant au-dela de 2^53 sans valeurTexte n'est pas affiche comme exact", () => {
    const a = affichageKpi(avec("budget_contractuel_gnf", { valeur: 2 ** 60, valeurTexte: undefined }));
    expect(a.valeur).toBeNull();
    expect(a.raison).toMatch(/précision/);
  });

  it("une raison par defaut existe pour chaque etat sans valeur", () => {
    expect(affichageKpi(avec("budget_engage_gnf", { avertissements: [] })).raison).toBe("source non disponible");
    expect(affichageKpi(avec("chantiers_en_cours", { etat: "DEFINITION_NON_VALIDEE", valeur: null, avertissements: [] })).raison).toBe("définition non validée");
  });

  it("dit une periode absente en mots et un instantane comme tel", () => {
    expect(textePeriode(null)).toBe("Période non précisée");
    expect(textePeriode({ depuis: null, jusqua: null })).toBe("Période non précisée");
    expect(textePeriode({ depuis: "2026-01-01", jusqua: "2026-02-01" })).toBe("Du 01/01/2026 au 01/02/2026");
    expect(textePeriode(kpiReel("reseau_degrade_pct").periode)).toBe("Instantané du 26/10/2026");
  });

  it("formate km et % ; l'absence se dit", () => {
    expect(nette(formaterKm(7933.4))).toBe("7 933,4 km");
    expect(formaterKm(null)).toBe("Non disponible");
    expect(nette(formaterPct(37.14))).toBe("37,1 %");
    expect(formaterPct(undefined)).toBe("Non disponible");
  });
});

describe("couverture : des phrases COHERENTES avec la definition du serveur (evalueKm = valide + non valide)", () => {
  it("decompose la longueur connue au lieu de comparer evalue a eligible", () => {
    // Couverture REELLE : evalueKm 700, eligibleKm 200, nonEvalueKm 100, etatNonValideKm 500.
    const c = kpiReel("reseau_degrade_pct").couverture!;
    expect(c.evalueKm).toBe(700);
    const t = nette(texteCouverture(c) ?? "");
    expect(t).toBe("200 km à état valide, 500 km à état non valide, 100 km non évalués, sur 800 km de longueur connue");
    expect(t).not.toMatch(/700 km évalués sur 200/);
    expect(t).not.toMatch(/évalués sur/);
  });

  it("une region : etat valide + non evalues, sans « non valide » quand il n'y a pas d'information", () => {
    expect(nette(texteCouverture({ eligibleKm: 100, nonEvalueKm: 100 }) ?? "")).toBe("100 km à état valide, 100 km non évalués, sur 200 km de longueur connue");
    expect(nette(texteCouverture({ eligibleKm: 100, nonEvalueKm: 0 }) ?? "")).toBe("100 km à état valide");
    expect(texteCouverture({ eligibleKm: null, nonEvalueKm: null })).toBeNull();
    expect(texteCouverture(null)).toBeNull();
  });
});

describe("fraicheur", () => {
  it("mesure l'age en jours entiers ; futur, absent et illisible donnent null", () => {
    expect(ageEnJours("2026-10-26T08:00:00.000Z", MAINTENANT_SYNTHETIQUE)).toBe(1);
    expect(ageEnJours("2026-12-01T00:00:00.000Z", MAINTENANT_SYNTHETIQUE)).toBeNull();
    expect(ageEnJours("", MAINTENANT_SYNTHETIQUE)).toBeNull();
    expect(ageEnJours("pas une date", MAINTENANT_SYNTHETIQUE)).toBeNull();
  });

  const fr = (surcharge: Record<string, unknown>) => {
    const f = lecture().fraicheur;
    if (!f.ok) throw new Error("fraicheur illisible");
    return { ...f.valeur, ...surcharge };
  };

  it("declare perime au-dela du seuil provisoire, sur l'age du calcul OU celui des donnees", () => {
    expect(evaluerFraicheur(fr({ ageJours: 2 }), MAINTENANT_SYNTHETIQUE).perime).toBe(false);
    expect(evaluerFraicheur(fr({ ageJours: 45 }), MAINTENANT_SYNTHETIQUE).perime).toBe(true);
    expect(evaluerFraicheur(fr({ calculeLe: "2026-01-01T00:00:00.000Z", ageJours: null }), MAINTENANT_SYNTHETIQUE).perime).toBe(true);
  });

  it("l'age de la reponse reelle (25 jours) n'est pas perime au seuil provisoire de 30 jours", () => {
    const ev = evaluerFraicheur(fr({}), MAINTENANT_SYNTHETIQUE);
    expect(ev.ageDonneesJours).toBe(25);
    expect(ev.perime).toBe(false);
    expect(ev.derniereEvaluationLe).toBe("2026-10-01T00:00:00.000Z");
  });

  it("un age de donnees inconnu reste inconnu (null, pas 0)", () => {
    expect(evaluerFraicheur(fr({ ageJours: null, derniereEvaluationLe: null }), MAINTENANT_SYNTHETIQUE).ageDonneesJours).toBeNull();
  });
});

describe("modeles de la zone de synthese, sur la repartition REELLE", () => {
  it("range les etats dans l'ordre du referentiel, puis « etat non valide », puis « non evalue » : deux tranches DISTINCTES et nommees", () => {
    const s = segmentsRepartition(repartitionReelle());
    expect(s.map((x) => x.libelle)).toEqual(["Bon", "Moyen", "Mauvais", "Critique", "État non valide", "Non évalué"]);
    expect(s.filter((x) => x.horsTaux).map((x) => x.type)).toEqual(["etatNonValide", "nonEvalue"]);
    expect(s[4]).toMatchObject({ km: 500, nbTroncons: 5, partPct: null, partPerimetrePct: 62.5, horsTaux: true });
    expect(s[5]).toMatchObject({ km: 100, nbTroncons: 10, partPerimetrePct: 12.5, nonEvalue: true });
    // les deux tranches a part ne se confondent ni par la couleur ni par la forme
    expect(s[4].couleur).not.toBe(s[5].couleur);
    expect(s[4].forme).not.toBe(s[5].forme);
  });

  it("les parts des classes viennent du serveur (rapportees aux etats valides) : 35, 40, 15, 10 = 100", () => {
    const s = segmentsRepartition(repartitionReelle()).filter((x) => !x.horsTaux);
    expect(s.map((x) => x.partPct)).toEqual([35, 40, 15, 10]);
    expect(s.reduce((t, x) => t + (x.partPct ?? 0), 0)).toBe(100);
  });

  it("ne trace pas d'arc pour un km inconnu ou nul, et les arcs couvrent exactement la circonference", () => {
    const rep = repartitionReelle();
    const s = segmentsRepartition({ ...rep, classes: [...rep.classes.slice(0, 3), { classe: "CRITIQUE", km: null, troncons: 2, partPct: null }] });
    const { arcs, circonference, totalKm } = arcsAnneau(s, 40);
    expect(arcs.map((a) => a.cle)).toEqual(["BON", "MOYEN", "MAUVAIS", "__ETAT_NON_VALIDE__", "__NON_EVALUE__"]);
    expect(totalKm).toBe(70 + 80 + 30 + 500 + 100);
    expect(arcs.reduce((t, a) => t + a.trace, 0)).toBeCloseTo(circonference, 6);
  });

  it("repartition vide (reponse reelle du perimetre vide) : aucun troncon du tout", () => {
    const vide = lecture("vide").repartitionEtat;
    expect(vide.ok && repartitionVide(vide.valeur)).toBe(true);
    expect(repartitionVide(repartitionReelle())).toBe(false);
  });

  it("trie les regions par part degradee decroissante, les non calculables en fin (jamais en tete a 0)", () => {
    const d = lecture().degradationParRegion;
    const regions = d.ok ? d.valeur.regions : [];
    const gamma = { ...regions[0], regionId: 3, regionNom: "Gamma", partDegradeePct: null, eligibleKm: 0 };
    expect(trierRegions([gamma, regions[1], regions[0]]).map((r) => r.regionNom)).toEqual(["Boké", "Kindia", "Gamma"]);
  });

  it("nomme une region : nom du serveur, « Non renseigné » a localiser, numero quand le nom manque", () => {
    expect(nomRegion({ regionId: 1, regionNom: "Boké", regionNonRenseignee: false })).toBe("Boké");
    expect(nomRegion({ regionId: 9, regionNom: null, regionNonRenseignee: false })).toBe("Région n° 9");
    expect(nomRegion({ regionId: 3, regionNom: "Non renseigné", regionNonRenseignee: true })).toMatch(/à localiser/);
  });
});
