import { describe, expect, it } from "vitest";
import {
  PLAFOND_EXEMPLES, SEUILS_PROVISOIRES, agregerControles, analyserMarche, correspondAuxFiltres, evaluerFraicheur, evaluerRetard,
  montantsMasquesPourPerimetre, pireQualite, qualiteLienTroncon, raisonsPartielles, rattacherProgrammes, regionsNonRenseignees, synthetiser,
  territoireDuMarche, tronconsDuMarche, visibleDuPerimetre,
  type Analyse, type ContexteAnalyse, type MarcheEntree, type ProgrammeEntree,
} from "./contractuel.noyau";
import { T0, chantier, decompte, jours, lien, marche, troncon } from "./contractuel.testutil";

/**
 * Noyau du suivi contractuel : ce que ces tests defendent, ce sont les SEPARATIONS du cahier (8.2) et du contrat (principe 6).
 * Chaque grandeur a sa propre valeur, son propre etat, sa propre source ; aucune n'est deduite d'une autre. Les « mutations
 * de controle » (engage egal contractuel, constate copie du declare, actifs a la place de recenses) sont des tests nommes :
 * ils echouent si quelqu'un fait ce raccourci.
 */

const ctx = (o: Partial<ContexteAnalyse> = {}): ContexteAnalyse => ({
  maintenant: T0, droitFinancier: true, perimetre: null, regionsNonRenseignees: new Set(), programmes: { uniques: [], ambigus: 0 }, plafondListes: 20, ...o,
});
const analyser = (m: MarcheEntree, o: Partial<ContexteAnalyse> = {}) => analyserMarche(m, ctx(o));

describe("separation des montants", () => {
  it("contractuel, engage, decaisse et previsionnel sont quatre grandeurs distinctes, chacune avec son etat", () => {
    const m = marche({
      decomptes: [decompte({ id: "d1", numero: 1, statut: "PAYE", montantGnf: BigInt(300_000) }), decompte({ id: "d2", numero: 2, statut: "EMIS", montantGnf: BigInt(200_000) })],
    });
    const prog: ProgrammeEntree = { id: "p1", annee: 2026, intitule: "Programme", tronconId: "t1", montantPrevuGnf: BigInt(700_000), statut: "RETENU" };
    const { vue } = analyser(m, { programmes: { uniques: [prog], ambigus: 0 } });
    expect(vue.montants.contractuel).toMatchObject({ etat: "DISPONIBLE", valeurGnf: "1000000" });
    expect(vue.montants.decaisse).toMatchObject({ etat: "DISPONIBLE", valeurGnf: "300000" });
    expect(vue.montants.previsionnel).toMatchObject({ etat: "PARTIEL", valeurGnf: "700000" });
    expect(vue.montants.engage).toMatchObject({ etat: "NON_DISPONIBLE", valeurGnf: null, motif: "SOURCE_NON_VALIDEE" });
    // chacune porte sa source et un avertissement, jamais la meme chaine
    const sources = new Set(Object.values(vue.montants).map((x) => x.source));
    expect(sources.size).toBe(4);
  });

  it("MUTATION DE CONTROLE : l'engage n'est JAMAIS egal au contractuel, ni a la somme des decomptes, ni a celle des chantiers", () => {
    const m = marche({ montantTotal: BigInt(5_000), decomptes: [decompte({ statut: "PAYE", montantGnf: BigInt(5_000) })] });
    const { vue } = analyser(m);
    expect(vue.montants.engage.valeurGnf).toBeNull();
    expect(vue.montants.engage.valeurGnf).not.toBe(vue.montants.contractuel.valeurGnf);
    expect(vue.montants.engage.avertissement).toMatch(/jamais d[eé]duit/i);
  });

  it("le decaisse ne compte QUE les decomptes PAYE : EMIS et REJETE sont exclus, et on dit lesquels sont comptes", () => {
    const m = marche({
      decomptes: [
        decompte({ id: "a", numero: 1, statut: "PAYE", montantGnf: BigInt(10) }),
        decompte({ id: "b", numero: 2, statut: "PAYE", montantGnf: BigInt(20), type: "AVANCE", datePaiement: jours(-3) }),
        decompte({ id: "c", numero: 3, statut: "EMIS", montantGnf: BigInt(1000) }),
        decompte({ id: "d", numero: 4, statut: "REJETE", montantGnf: BigInt(1000) }),
      ],
    });
    const { vue } = analyser(m);
    expect(vue.montants.decaisse.valeurGnf).toBe("30");
    expect(vue.decomptes.parStatut).toEqual({ EMIS: 1, PAYE: 2, REJETE: 1 });
    expect(vue.decomptes.payes.map((d) => d.numero)).toEqual([1, 2]);
    expect(vue.montants.decaisse.avertissement).toMatch(/1 d[eé]compte\(s\) pay[eé]\(s\) sans date/);
  });

  it("aucun decompte : le decaisse est NON_DISPONIBLE, pas 0 ; des decomptes dont aucun n'est paye : 0 reel", () => {
    expect(analyser(marche({ decomptes: [] })).vue.montants.decaisse).toMatchObject({ etat: "NON_DISPONIBLE", valeurGnf: null, motif: "AUCUN_DECOMPTE" });
    expect(analyser(marche({ decomptes: [decompte({ statut: "EMIS" })] })).vue.montants.decaisse).toMatchObject({ etat: "DISPONIBLE", valeurGnf: "0" });
  });

  it("un montant contractuel absent est NON_DISPONIBLE (MONTANT_ABSENT), jamais 0", () => {
    const { vue } = analyser(marche({ montantTotal: null }));
    expect(vue.montants.contractuel).toMatchObject({ etat: "NON_DISPONIBLE", valeurGnf: null, motif: "MONTANT_ABSENT" });
  });

  it("les montants restent des chaines exactes au-dela de 2^53", () => {
    const grand = BigInt("9007199254740993"); // 2^53 + 1
    const { vue } = analyser(marche({ montantTotal: grand, decomptes: [decompte({ statut: "PAYE", montantGnf: grand })] }));
    expect(vue.montants.contractuel.valeurGnf).toBe("9007199254740993");
    expect(vue.montants.decaisse.valeurGnf).toBe("9007199254740993");
    expect(Number("9007199254740993").toString()).not.toBe("9007199254740993"); // le nombre aurait menti
  });

  it("un marche en devise etrangere n'est pas converti : valeurGnf nulle, montant d'origine conserve, exclu du total GNF", () => {
    const usd = analyser(marche({ id: "m-usd", devise: "USD", montantTotal: BigInt(2_000) }));
    expect(usd.vue.montants.contractuel).toMatchObject({ etat: "NON_DISPONIBLE", valeurGnf: null, motif: "DEVISE_NON_GNF", valeurOrigine: { montant: "2000", devise: "USD" } });
    const gnf = analyser(marche({ id: "m-gnf", montantTotal: BigInt(1_000) }));
    const s = synthetiser([usd, gnf], true);
    expect(s.financier.contractuel).toMatchObject({ etat: "PARTIEL", valeurGnf: "1000", couverture: { pris: 1, total: 2 } });
    expect(s.totauxParBailleur[0].autresDevises).toEqual([{ devise: "USD", montant: "2000", nombre: 1 }]);
  });

  it("le previsionnel ambigu n'est impute a aucun marche (LIEN_AMBIGU) ; sans programme : AUCUN_LIEN", () => {
    expect(analyser(marche(), { programmes: { uniques: [], ambigus: 2 } }).vue.montants.previsionnel).toMatchObject({ valeurGnf: null, motif: "LIEN_AMBIGU" });
    expect(analyser(marche()).vue.montants.previsionnel).toMatchObject({ valeurGnf: null, motif: "AUCUN_LIEN" });
  });

  it("sans droit financier, AUCUN montant ne sort, y compris dans les agregats et la liste des decomptes payes", () => {
    const m = marche({ decomptes: [decompte({ statut: "PAYE", montantGnf: BigInt(77) })] });
    const a = analyser(m, { droitFinancier: false });
    for (const x of Object.values(a.vue.montants)) expect(x).toMatchObject({ etat: "NON_DISPONIBLE", valeurGnf: null, motif: "DROIT_FINANCIER" });
    expect(a.vue.decomptes.payes).toEqual([]);
    const s = synthetiser([a], false);
    for (const x of Object.values(s.financier)) expect(x.valeurGnf).toBeNull();
    expect(s.totauxParBailleur[0].contractuel.valeurGnf).toBeNull();
    expect(JSON.stringify([a.vue, s])).not.toMatch(/1000000|"77"/);
  });
});

describe("avancement declare et constate", () => {
  const av = (o = {}) => ({ periode: new Date("2026-09-01T00:00:00Z"), physiquePrevu: 60, physiqueReel: 55, financierPrevu: 50, financierReel: 30, createdAt: jours(-20), ...o });

  it("MUTATION DE CONTROLE : le constate n'est jamais une copie du declare", () => {
    const { vue } = analyser(marche({ avancements: [av({ physiqueReel: 80 })] }));
    expect(vue.avancement.declare).toMatchObject({ etat: "DISPONIBLE", physiqueReelPct: 80 });
    expect(vue.avancement.constate).toMatchObject({ etat: "NON_DISPONIBLE", valeurPct: null, motif: "AUCUNE_SOURCE_DE_CONSTAT" });
    expect(JSON.stringify(vue.avancement.constate)).not.toContain("80");
  });

  it("l'avancement financier declare est distinct du physique ET du decaisse calcule", () => {
    const { vue } = analyser(marche({ avancements: [av()], decomptes: [decompte({ statut: "PAYE", montantGnf: BigInt(999_999) })] }));
    expect(vue.avancement.declare.physiqueReelPct).toBe(55);
    expect(vue.avancement.financier.reelPct).toBe(30);
    expect(vue.montants.decaisse.valeurGnf).toBe("999999");
    expect(vue.avancement.financier.avertissement).toMatch(/distinct/);
  });

  it("aucune periode saisie : le declare est NON_DISPONIBLE (pas 0 %)", () => {
    const { vue } = analyser(marche({ avancements: [] }));
    expect(vue.avancement.declare).toMatchObject({ etat: "NON_DISPONIBLE", physiqueReelPct: null });
    expect(vue.avancement.financier).toMatchObject({ etat: "NON_DISPONIBLE", reelPct: null });
  });

  it("l'avancement declare d'un chantier est liste a part, etiquete declare", () => {
    const { vue } = analyser(marche({ liens: [lien({ chantier: chantier({ avancementPct: 65 }) })] }));
    expect(vue.liens.chantiers.liste[0].avancementDeclarePct).toBe(65);
  });
});

describe("relations marche, chantier, troncon", () => {
  it("DIRECT : le tronçon est porté par le lien ; PAR_CHANTIER : par le seul chantier ; MANQUANT : aucun", () => {
    const t = troncon();
    expect(qualiteLienTroncon(lien({ tronconId: "t1", troncon: t, chantier: chantier({ tronconId: null, troncon: null }) }))).toBe("DIRECT");
    expect(qualiteLienTroncon(lien({ tronconId: null, troncon: null, chantier: chantier() }))).toBe("PAR_CHANTIER");
    expect(qualiteLienTroncon(lien({ chantier: chantier({ tronconId: null, troncon: null }) }))).toBe("MANQUANT");
  });

  it("AMBIGU : le tronçon du lien diffère de celui du chantier", () => {
    const l = lien({ tronconId: "t2", troncon: troncon({ id: "t2", code: "RN2-1" }), chantier: chantier() });
    expect(qualiteLienTroncon(l)).toBe("AMBIGU");
    const a = analyser(marche({ liens: [l] }));
    expect(a.constats.map((c) => c.code)).toContain("ASSOCIATION_AMBIGUE");
    expect(a.vue.liens.troncons.qualite).toBe("AMBIGU");
    expect(a.vue.liens.troncons.liste.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
  });

  it("un tronçon archivé ne compte pas comme un lien", () => {
    const l = lien({ chantier: chantier({ troncon: troncon({ archive: true }) }) });
    expect(qualiteLienTroncon(l)).toBe("MANQUANT");
  });

  it("marché sans chantier : qualité MANQUANT, constat, et territoire non établi", () => {
    const a = analyser(marche({ liens: [] }));
    expect(a.vue.liens.chantiers.qualite).toBe("MANQUANT");
    expect(a.vue.liens.troncons.qualite).toBe("MANQUANT");
    expect(a.constats.map((c) => c.code)).toContain("MARCHE_SANS_CHANTIER");
    expect(a.vue.territoire.etabli).toBe(false);
    expect(a.vue.avertissements.join(" ")).toMatch(/Territoire du marché impossible/);
  });

  it("un chantier archivé est ignoré, compté, et le marché est dit sans chantier actif", () => {
    const a = analyser(marche({ liens: [lien({ chantier: chantier({ archive: true }) })] }));
    expect(a.vue.liens.chantiers).toMatchObject({ total: 0, archivesIgnores: 1, qualite: "MANQUANT" });
    expect(a.constats.find((c) => c.code === "MARCHE_SANS_CHANTIER")?.detail).toMatch(/archiv/);
  });

  it("chantier sans tronçon : constat nommé, avec le chantier", () => {
    const a = analyser(marche({ liens: [lien({ chantier: chantier({ id: "cx", intitule: "Sans route", tronconId: null, troncon: null }) })] }));
    const c = a.constats.find((x) => x.code === "CHANTIER_SANS_TRONCON");
    expect(c).toMatchObject({ chantierId: "cx" });
    expect(c?.detail).toContain("Sans route");
  });

  it("chantier partagé entre plusieurs marchés : qualité des chantiers AMBIGU, constat d'ambiguïté", () => {
    const a = analyser(marche({ liens: [lien({ chantier: chantier({ nbMarches: 2 }) })] }));
    expect(a.vue.liens.chantiers.qualite).toBe("AMBIGU");
    expect(a.vue.liens.chantiers.liste[0].partageEntreMarches).toBe(true);
    expect(a.constats.some((c) => c.code === "ASSOCIATION_AMBIGUE")).toBe(true);
  });

  it("la qualité d'un marché est la plus faible de ses liens", () => {
    expect(pireQualite([])).toBe("MANQUANT");
    expect(pireQualite(["DIRECT", "PAR_CHANTIER"])).toBe("PAR_CHANTIER");
    expect(pireQualite(["DIRECT", "MANQUANT", "PAR_CHANTIER"])).toBe("MANQUANT");
    expect(pireQualite(["MANQUANT", "AMBIGU"])).toBe("AMBIGU");
  });

  it("entreprise et référence viennent des chantiers ; les lots, avenants, pièces sont NON_DISPONIBLES et le disent", () => {
    const a = analyser(marche({ liens: [lien({ chantier: chantier({ entreprise: "SOGEA", numContrat: "C-12" }) })] }));
    expect(a.vue.entreprises).toMatchObject({ etat: "DISPONIBLE", valeur: ["SOGEA"] });
    expect(a.vue.reference).toMatchObject({ etat: "DISPONIBLE", valeur: ["C-12"] });
    expect(a.vue.lots).toMatchObject({ etat: "NON_DISPONIBLE", valeur: null });
    expect(a.vue.delais.avenants.etat).toBe("NON_DISPONIBLE");
    expect(a.vue.delais.suspensions.etat).toBe("NON_DISPONIBLE");
    expect(a.vue.pieces.etat).toBe("NON_DISPONIBLE");
    expect(analyser(marche({ liens: [lien()] })).vue.reference).toMatchObject({ etat: "NON_DISPONIBLE", valeur: null });
  });

  it("références de contrat divergentes entre chantiers du même marché", () => {
    const a = analyser(marche({ liens: [lien({ chantier: chantier({ id: "a", numContrat: "C-1" }) }), lien({ chantier: chantier({ id: "b", numContrat: "C-2" }) })] }));
    expect(a.constats.map((c) => c.code)).toContain("REFERENCES_DIVERGENTES");
    expect(a.vue.reference.etat).toBe("PARTIEL");
  });

  it("tronçons d'un marché (pour les programmes) : lien et chantier, hors archivés", () => {
    const m = marche({ liens: [lien({ tronconId: "t9", troncon: troncon({ id: "t9" }) }), lien({ chantier: chantier({ id: "z", tronconId: "t5", troncon: troncon({ id: "t5", archive: true }) }) })] });
    expect([...tronconsDuMarche(m)].sort()).toEqual(["t1", "t9"]);
  });
});

describe("retard", () => {
  const av = (prevu: number, reel: number) => ({ periode: new Date("2026-09-01T00:00:00Z"), physiquePrevu: prevu, physiqueReel: reel, financierPrevu: 0, financierReel: 0, createdAt: jours(-20) });

  it("retard calendaire : date de fin prévue passée sur un marché ouvert, en jours", () => {
    const r = evaluerRetard(marche({ dateFinPrevue: jours(-12) }), T0);
    expect(r).toMatchObject({ etat: "EN_RETARD", joursRetardCalendaire: 12 });
    expect(r.regles).toContain("CALENDAIRE");
  });

  it("le jour même de la fin prévue n'est pas un retard", () => {
    expect(evaluerRetard(marche({ dateFinPrevue: new Date("2026-10-26T00:00:00Z") }), T0)).toMatchObject({ etat: "A_JOUR", joursRetardCalendaire: null });
  });

  it("sans date de fin ni avancement : NON_EVALUABLE avec l'avertissement, jamais « à jour »", () => {
    const r = evaluerRetard(marche({ dateFinPrevue: null, avancements: [] }), T0);
    expect(r.etat).toBe("NON_EVALUABLE");
    expect(r.avertissements.join(" ")).toMatch(/Date de fin prévue absente/);
    expect(r.avertissements.join(" ")).toMatch(/Aucun avancement/);
  });

  it("marché terminé ou soldé : retard non évalué (TERMINE), aucune alerte", () => {
    for (const statut of ["TERMINE", "SOLDE"] as const) {
      const r = evaluerRetard(marche({ statut, dateFinPrevue: jours(-400) }), T0);
      expect(r).toMatchObject({ etat: "TERMINE", joursRetardCalendaire: null });
      expect(r.alertes).toEqual([]);
    }
  });

  it("seuils physiques : 10 pile n'est pas un retard, 10,01 est moyen, 25 pile est moyen, 25,01 est haut", () => {
    const g = (prevu: number, reel: number) => evaluerRetard(marche({ avancements: [av(prevu, reel)] }), T0).gravite;
    expect(g(50, 40)).toBeNull();
    expect(g(50.01, 40)).toBe("moyenne");
    expect(g(65, 40)).toBe("moyenne");
    expect(g(65.01, 40)).toBe("haute");
    expect(SEUILS_PROVISOIRES.ecartPhysiqueMoyenPoints).toBe(10);
    expect(SEUILS_PROVISOIRES.ecartPhysiqueHautPoints).toBe(25);
  });

  it("les avenants et suspensions ignorés sont dits dans CHAQUE évaluation ; un marché suspendu l'est en plus", () => {
    const r = evaluerRetard(marche({ statut: "SUSPENDU", dateFinPrevue: jours(-5) }), T0);
    expect(r.avertissements.join(" ")).toMatch(/Avenants et suspensions ignorés/);
    expect(r.avertissements.join(" ")).toMatch(/suspendu/);
    expect(evaluerRetard(marche({ statut: "TERMINE" }), T0).avertissements.join(" ")).toMatch(/Avenants et suspensions ignorés/);
  });

  it("réception provisoire dépassée et garantie proche de l'expiration sont des alertes à part", () => {
    const r = evaluerRetard(marche({ dateReceptionProvisoire: jours(-3), garantieBonneExecutionExp: jours(20) }), T0);
    expect(r.alertes.map((a) => a.code).sort()).toEqual(["GARANTIE_PROCHE_EXPIRATION", "RECEPTION_DEPASSEE"]);
    expect(r.etat).toBe("EN_RETARD");
    expect(r.alertes.find((a) => a.code === "RECEPTION_DEPASSEE")?.message).toMatch(/pénalité non estimée/);
  });
});

describe("controles de coherence", () => {
  const ctrl = (a: Analyse[], code: string) => agregerControles(a, null).find((c) => c.code === code)!;

  it("montant de décompte supérieur au marché : un décompte seul, puis le cumul ; les REJETE sont exclus", () => {
    const seul = analyser(marche({ id: "s", montantTotal: BigInt(100), decomptes: [decompte({ numero: 3, montantGnf: BigInt(101) })] }));
    const cumul = analyser(marche({ id: "c", montantTotal: BigInt(100), decomptes: [decompte({ id: "x", numero: 1, montantGnf: BigInt(60) }), decompte({ id: "y", numero: 2, montantGnf: BigInt(60) })] }));
    const rejete = analyser(marche({ id: "r", montantTotal: BigInt(100), decomptes: [decompte({ statut: "REJETE", montantGnf: BigInt(500) })] }));
    const ok = analyser(marche({ id: "o", montantTotal: BigInt(100), decomptes: [decompte({ montantGnf: BigInt(100) })] }));
    expect(seul.constats.find((c) => c.code === "DECOMPTE_SUPERIEUR_MARCHE")?.detail).toMatch(/n° 3/);
    expect(cumul.constats.find((c) => c.code === "DECOMPTE_SUPERIEUR_MARCHE")?.detail).toMatch(/cumul/);
    expect(rejete.constats).toEqual([]);
    expect(ok.constats).toEqual([]);
    expect(ctrl([seul, cumul, rejete, ok], "DECOMPTE_SUPERIEUR_MARCHE")).toMatchObject({ nombre: 2, surTotal: 4, nonVerifiables: 0 });
  });

  it("aucun montant de décompte ne figure dans le détail d'un contrôle (le détail ne fuit pas un montant masqué)", () => {
    const a = analyser(marche({ montantTotal: BigInt(123_456), decomptes: [decompte({ montantGnf: BigInt(987_654) })] }));
    expect(JSON.stringify(agregerControles([a], null))).not.toMatch(/123456|987654|123 456|987 654/);
  });

  it("décomptes d'un marché en USD ou sans montant : NON vérifiable (ni conforme, ni anomalie)", () => {
    const usd = analyser(marche({ id: "u", devise: "USD", montantTotal: BigInt(10), decomptes: [decompte({ montantGnf: BigInt(1_000) })] }));
    const sans = analyser(marche({ id: "n", montantTotal: null, decomptes: [decompte({ montantGnf: BigInt(1_000) })] }));
    expect(ctrl([usd, sans], "DECOMPTE_SUPERIEUR_MARCHE")).toMatchObject({ nombre: 0, nonVerifiables: 2 });
  });

  it("dates incohérentes : fin avant début, paiement avant émission, chantier à l'envers", () => {
    const a = analyser(marche({
      dateDebutPrevue: new Date("2026-05-01"), dateFinPrevue: new Date("2026-01-01"),
      liens: [lien({ chantier: chantier({ intitule: "Inversé", dateDebutPrevue: new Date("2026-06-01"), dateFinPrevue: new Date("2026-02-01") }) })],
      decomptes: [decompte({ numero: 7, dateEmission: new Date("2026-03-01"), datePaiement: new Date("2026-02-01") })],
    }));
    const details = a.constats.filter((c) => c.code === "DATES_INCOHERENTES").map((c) => c.detail).join(" | ");
    expect(details).toMatch(/fin prévue précède/);
    expect(details).toMatch(/Inversé/);
    expect(details).toMatch(/n° 7/);
    expect(analyser(marche({ dateDebutPrevue: new Date("2026-01-01"), dateFinPrevue: new Date("2026-05-01") })).constats).toEqual([]);
  });

  it("avancement supérieur à 100 % ou négatif : marché (toutes périodes) et chantier", () => {
    const a = analyser(marche({
      avancements: [{ periode: new Date("2026-09-01"), physiquePrevu: 50, physiqueReel: 120, financierPrevu: 0, financierReel: 0, createdAt: jours(-1) }],
      liens: [lien({ chantier: chantier({ avancementPct: -5 }) })],
    }));
    const n = a.constats.filter((c) => c.code === "AVANCEMENT_HORS_BORNES");
    expect(n).toHaveLength(2);
    expect(analyser(marche({ avancements: [{ periode: new Date("2026-09-01"), physiquePrevu: 100, physiqueReel: 100, financierPrevu: 0, financierReel: 0, createdAt: jours(-1) }] })).constats).toEqual([]);
  });

  it("bailleur incohérent : la casse, les accents et les espaces ne comptent pas ; une vraie différence, si", () => {
    const meme = analyser(marche({ bailleurNom: "Banque Africaine de Développement", liens: [lien({ chantier: chantier({ bailleur: "  banque africaine de developpement " }) })] }));
    const autre = analyser(marche({ bailleurNom: "BAD", liens: [lien({ chantier: chantier({ bailleur: "Banque mondiale" }) })] }));
    expect(meme.constats).toEqual([]);
    expect(autre.constats.map((c) => c.code)).toEqual(["BAILLEUR_INCOHERENT"]);
  });

  it("bailleur du marché absent alors qu'un chantier en porte un : non vérifiable, pas incohérent", () => {
    const a = analyser(marche({ bailleurNom: null, bailleurId: null, liens: [lien({ chantier: chantier({ bailleur: "BAD" }) })] }));
    expect(a.constats).toEqual([]);
    expect(a.nonVerifiables).toContain("BAILLEUR_INCOHERENT");
    expect(ctrl([a], "BAILLEUR_INCOHERENT")).toMatchObject({ nombre: 0, nonVerifiables: 1 });
  });

  it("les contrôles à zéro sont conservés (« zéro » est une information) et portent leur population", () => {
    const c = agregerControles([analyser(marche())], null);
    expect(c.map((x) => x.code)).toContain("MARCHE_SANS_CHANTIER");
    expect(c.find((x) => x.code === "MARCHE_SANS_CHANTIER")).toMatchObject({ nombre: 0, surTotal: 1, statutDefinition: "PROVISOIRE" });
  });

  it("les exemples sont bornés", () => {
    const analyses = Array.from({ length: 12 }, (_, i) => analyser(marche({ id: `m${i}`, liens: [] })));
    const c = ctrl(analyses, "MARCHE_SANS_CHANTIER");
    expect(c.nombre).toBe(12);
    expect(c.exemples).toHaveLength(PLAFOND_EXEMPLES);
  });

  it("chantiers sans marché : fournis par le dépôt, comptés en chantiers, exemples bornés", () => {
    const c = agregerControles([], { nombre: 9, surTotal: 40, exemples: Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, intitule: `C${i}` })) }).find((x) => x.code === "CHANTIER_SANS_MARCHE")!;
    expect(c).toMatchObject({ nombre: 9, surTotal: 40, unite: "chantiers" });
    expect(c.exemples).toHaveLength(PLAFOND_EXEMPLES);
  });
});

describe("territoire et perimetre", () => {
  const P1 = new Set([1]);

  it("un marché n'a pas de région propre : elle se déduit des chantiers et des tronçons", () => {
    const m = marche({ liens: [lien({ chantier: chantier({ regionId: 1, tronconId: "t1", troncon: troncon({ regionId: 3 }) }) })] });
    expect([...territoireDuMarche(m, new Set()).regions].sort()).toEqual([1, 3]);
  });

  it("compte national : tout est visible, rien n'est masqué", () => {
    const t = territoireDuMarche(marche({ liens: [] }), new Set());
    expect(visibleDuPerimetre(t, null)).toBe(true);
    expect(montantsMasquesPourPerimetre(t, null)).toBe(false);
  });

  it("compte régional : un marché sans territoire établi n'est visible que d'un compte national", () => {
    const t = territoireDuMarche(marche({ liens: [] }), new Set());
    expect(visibleDuPerimetre(t, P1)).toBe(false);
  });

  it("compte régional : visible si une région est dans le périmètre ; hors périmètre, invisible", () => {
    const dedans = territoireDuMarche(marche(), new Set());
    const dehors = territoireDuMarche(marche({ liens: [lien({ chantier: chantier({ regionId: 2, troncon: troncon({ regionId: 2 }) }) })] }), new Set());
    expect(visibleDuPerimetre(dedans, P1)).toBe(true);
    expect(visibleDuPerimetre(dehors, P1)).toBe(false);
  });

  it("marché multi-régional vu d'un compte régional : visible, montants MASQUÉS, chantiers des autres régions absents", () => {
    const m = marche({
      decomptes: [decompte({ statut: "PAYE", montantGnf: BigInt(555) })],
      liens: [
        lien({ chantier: chantier({ id: "c1", intitule: "Chez moi", regionId: 1, troncon: troncon({ regionId: 1 }) }) }),
        lien({ chantier: chantier({ id: "c2", intitule: "Ailleurs", regionId: 2, tronconId: "t2", troncon: troncon({ id: "t2", code: "RN9", regionId: 2 }) }) }),
      ],
    });
    const a = analyser(m, { perimetre: P1 });
    expect(a.vue.territoire).toMatchObject({ montantsMasques: true, multiRegions: true, regionIds: [1] });
    expect(a.vue.montants.contractuel).toMatchObject({ valeurGnf: null, motif: "TERRITOIRE" });
    expect(a.vue.montants.decaisse.valeurGnf).toBeNull();
    expect(a.vue.liens.chantiers.liste.map((c) => c.intitule)).toEqual(["Chez moi"]);
    expect(a.vue.liens.chantiers.autresRegionsMasquees).toBe(true);
    expect(a.vue.liens.troncons.liste.map((t) => t.id)).toEqual(["t1"]);
    expect(JSON.stringify(a.vue)).not.toMatch(/Ailleurs|RN9|1000000|555/);
  });

  it("marché entièrement dans le périmètre : montants rendus, aucune fuite d'une autre région", () => {
    const a = analyser(marche(), { perimetre: P1 });
    expect(a.vue.territoire.montantsMasques).toBe(false);
    expect(a.vue.montants.contractuel.valeurGnf).toBe("1000000");
  });

  it("chantier rattaché à « Non renseigné » : territoire incertain, montants masqués pour un compte régional", () => {
    const nr = regionsNonRenseignees([{ id: 1, nom: "Conakry" }, { id: 99, nom: "Non renseigné" }, { id: 98, nom: "NON RENSEIGNE" }]);
    expect([...nr].sort()).toEqual([98, 99]);
    const m = marche({ liens: [lien(), lien({ chantier: chantier({ id: "c9", regionId: 99, tronconId: null, troncon: null }) })] });
    const t = territoireDuMarche(m, nr);
    expect(t.incertain).toBe(true);
    expect([...t.regions]).toEqual([1]);
    expect(montantsMasquesPourPerimetre(t, P1)).toBe(true);
  });

  it("une région « Non renseigné » ne rend jamais un marché visible d'un compte qui n'a que cette région", () => {
    const nr = new Set([99]);
    const m = marche({ liens: [lien({ chantier: chantier({ regionId: 99, tronconId: null, troncon: null }) })] });
    expect(visibleDuPerimetre(territoireDuMarche(m, nr), new Set([99]))).toBe(false);
  });
});

describe("synthese", () => {
  it("MUTATION DE CONTROLE : « recensés » compte des marchés (pas des chantiers) et ne dit jamais « actifs »", () => {
    const trois = marche({ id: "m1", liens: [lien({ chantier: chantier({ id: "a" }) }), lien({ chantier: chantier({ id: "b" }) }), lien({ chantier: chantier({ id: "c" }) })] });
    const s = synthetiser([analyser(trois)], true);
    expect(s.marchesRecenses.nombre).toBe(1);
    expect(s.marchesRecenses.libelle).toBe("Marchés recensés");
    expect(s.marchesRecenses.libelle).not.toMatch(/actif/i);
    expect(s.marchesRecenses.definition).toMatch(/Ce n'est pas un nombre de marchés actifs/);
    expect(Object.keys(s)).not.toContain("actifs");
  });

  it("répartition par statut SAISI ; aucun total « actifs » n'est calculé", () => {
    const s = synthetiser([analyser(marche({ id: "a", statut: "EN_COURS" })), analyser(marche({ id: "b", statut: "EN_COURS" })), analyser(marche({ id: "c", statut: "SOLDE" }))], true);
    expect(s.parStatut).toEqual({ PLANIFIE: 0, EN_COURS: 2, SUSPENDU: 0, TERMINE: 0, SOLDE: 1 });
  });

  it("totaux par bailleur : contractuel étiqueté, marchés sans montant exclus et comptés, jamais comptés comme nuls", () => {
    const s = synthetiser([
      analyser(marche({ id: "a", montantTotal: BigInt(100) })),
      analyser(marche({ id: "b", montantTotal: BigInt(250) })),
      analyser(marche({ id: "c", montantTotal: null })),
      analyser(marche({ id: "d", bailleurId: null, bailleurNom: null, montantTotal: BigInt(7) })),
    ], true);
    const bad = s.totauxParBailleur.find((t) => t.bailleurId === 1)!;
    expect(bad).toMatchObject({ nom: "BAD", nombreMarches: 3, sansMontant: 1 });
    expect(bad.contractuel).toMatchObject({ etat: "PARTIEL", valeurGnf: "350", couverture: { pris: 2, total: 3 } });
    expect(bad.contractuel.avertissement).toMatch(/non compt[eé]s comme nuls/);
    const aucun = s.totauxParBailleur.find((t) => t.bailleurId === null)!;
    expect(aucun.nom).toBeNull();
    expect(aucun.contractuel.valeurGnf).toBe("7");
    expect(s.financier.engage).toMatchObject({ etat: "NON_DISPONIBLE", valeurGnf: null });
  });

  it("aucun marché : les agrégats sont NON_DISPONIBLES (AUCUN_MARCHE), pas 0", () => {
    const s = synthetiser([], true);
    expect(s.financier.contractuel).toMatchObject({ etat: "NON_DISPONIBLE", valeurGnf: null, motif: "AUCUN_MARCHE" });
    expect(s.marchesRecenses.nombre).toBe(0);
  });

  it("le décaissé agrégé ne somme que les marchés avec décomptes, et le dit", () => {
    const a = analyser(marche({ id: "a", decomptes: [decompte({ statut: "PAYE", montantGnf: BigInt(40) })] }));
    const b = analyser(marche({ id: "b", decomptes: [] }));
    expect(synthetiser([a, b], true).financier.decaisse).toMatchObject({ etat: "PARTIEL", valeurGnf: "40", couverture: { pris: 1, total: 2 } });
  });

  it("retards comptés sur la règle documentée, avec la règle et son statut PROVISOIRE", () => {
    const s = synthetiser([analyser(marche({ id: "a", dateFinPrevue: jours(-3) })), analyser(marche({ id: "b", dateFinPrevue: jours(30) })), analyser(marche({ id: "c" })), analyser(marche({ id: "d", statut: "TERMINE" }))], true);
    expect(s.retard).toMatchObject({ enRetard: 1, aJour: 1, nonEvaluables: 1, termines: 1, statutDefinition: "PROVISOIRE" });
    expect(s.retard.regle).toMatch(/avenants et les suspensions ne sont pas mod/);
  });
});

describe("fraicheur et donnees partielles", () => {
  it("la copie est toujours dite gelée ; au-delà du seuil provisoire elle est PERIMEE", () => {
    const ancienne = analyser(marche({ updatedAt: jours(-200) }));
    const f = evaluerFraicheur([ancienne], T0);
    expect(f).toMatchObject({ gelee: true, derniereSynchronisation: null, perime: true, statutSeuil: "PROVISOIRE" });
    expect(f.ageJours).toBeGreaterThan(SEUILS_PROVISOIRES.peremptionJours);
    expect(evaluerFraicheur([analyser(marche({ updatedAt: jours(-1) }))], T0).perime).toBe(false);
    expect(evaluerFraicheur([], T0)).toMatchObject({ derniereMiseAJour: null, ageJours: null, perime: false });
  });

  it("les données sont TOUJOURS partielles tant que DigitalRoad n'est pas intégré, avec les raisons mesurées", () => {
    const analyses = [analyser(marche({ id: "a", montantTotal: null })), analyser(marche({ id: "b", liens: [] })), analyser(marche({ id: "c", devise: "EUR" }))];
    const p = raisonsPartielles(analyses, { tronque: true, plafond: 2000 });
    expect(p.partiel).toBe(true);
    expect(p.message).toMatch(/source de vérité externe non intégrée \(DigitalRoad\)/);
    const txt = p.raisons.join("\n");
    expect(txt).toMatch(/1 marché\(s\) sans montant contractuel/);
    expect(txt).toMatch(/1 marché\(s\) sans chantier lié/);
    expect(txt).toMatch(/1 marché\(s\) en devise étrangère/);
    expect(txt).toMatch(/Plus de 2000 marchés/);
    expect(raisonsPartielles([], { tronque: false, plafond: 2000 }).partiel).toBe(true);
  });
});

describe("programmes budgetaires", () => {
  const prog = (id: string, tronconId: string | null, statut = "RETENU"): ProgrammeEntree => ({ id, annee: 2026, intitule: id, tronconId, montantPrevuGnf: BigInt(10), statut });

  it("lié par troncon commun si un seul marché le porte ; ambigu s'il est partagé ; ignoré s'il n'est pas retenu", () => {
    const parTroncon = new Map<string, Set<string>>([["t1", new Set(["m1"])], ["t2", new Set(["m1", "m2"])]]);
    const r = rattacherProgrammes(new Set(["t1", "t2", "t3"]), [prog("p1", "t1"), prog("p2", "t2"), prog("p3", "t3", "PROPOSE"), prog("p4", "t9"), prog("p5", null)], parTroncon);
    expect(r.uniques.map((p) => p.id)).toEqual(["p1"]);
    expect(r.ambigus).toBe(1);
  });
});

describe("filtres", () => {
  const t = (m: MarcheEntree) => territoireDuMarche(m, new Set());

  it("statut de marché, bailleur, région, statut de chantier, classe et état de tronçon se lisent « au moins un lié »", () => {
    const m = marche({ bailleurId: 4, statut: "EN_COURS", liens: [lien({ chantier: chantier({ statut: "SUSPENDU", regionId: 2, troncon: troncon({ regionId: 2, classe: "RR", etat: "MAUVAIS" }) }) })] });
    expect(correspondAuxFiltres(m, t(m), { statutMarche: ["EN_COURS"], bailleurId: 4, regionId: 2, statutChantier: ["SUSPENDU"], classe: ["RR"], etat: ["MAUVAIS"] })).toBe(true);
    expect(correspondAuxFiltres(m, t(m), { statutMarche: ["SOLDE"] })).toBe(false);
    expect(correspondAuxFiltres(m, t(m), { bailleurId: 5 })).toBe(false);
    expect(correspondAuxFiltres(m, t(m), { regionId: 1 })).toBe(false);
    expect(correspondAuxFiltres(m, t(m), { statutChantier: ["TERMINE"] })).toBe(false);
    expect(correspondAuxFiltres(m, t(m), { classe: ["RN"] })).toBe(false);
    expect(correspondAuxFiltres(m, t(m), { etat: ["BON"] })).toBe(false);
  });

  it("période : chevauchement avec la période contractuelle ; un marché sans aucune date est EXCLU", () => {
    const m = marche({ dateDebutPrevue: new Date("2026-03-01"), dateFinPrevue: new Date("2026-06-30") });
    expect(correspondAuxFiltres(m, t(m), { depuis: "2026-06-30" })).toBe(true);
    expect(correspondAuxFiltres(m, t(m), { depuis: "2026-07-01" })).toBe(false);
    expect(correspondAuxFiltres(m, t(m), { jusqua: "2026-03-01" })).toBe(true);
    expect(correspondAuxFiltres(m, t(m), { jusqua: "2026-02-28" })).toBe(false);
    const sans = marche();
    expect(correspondAuxFiltres(sans, t(sans), {})).toBe(true);
    expect(correspondAuxFiltres(sans, t(sans), { depuis: "2000-01-01" })).toBe(false);
  });
});
