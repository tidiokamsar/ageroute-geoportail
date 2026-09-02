import { describe, expect, it } from "vitest";
import { evaluerCriteres, calculerScore, type Ponderation, type DonneesTroncon } from "./priorisation";

/**
 * Le score ne doit jamais paraitre plus fonde qu'il ne l'est.
 *
 * Etat des criteres en production au 01/09/2026 : etat renseigne sur 647 troncons
 * (1 043 valent NON_EVALUE, aucun n'est date), trafic 0/1 690, criticite 0/1 690,
 * cout 0/1 690.
 *
 * La version precedente ne s'arretait pas pour autant : elle fabriquait la criticite
 * depuis la classe de route et le cout depuis longueur x tarif, puis les presentait
 * comme des criteres au meme titre que l'etat.
 */

const POIDS_DEFAUT: Ponderation = { etat: 35, trafic: 25, criticite: 20, cout: 20 };

const troncon = (p: Partial<DonneesTroncon> = {}): DonneesTroncon => ({
  etat: "MAUVAIS",
  traficMoyenJma: null,
  criticiteStrategique: null,
  coutRehabEstime: null,
  dateDerniereEvaluation: null,
  ...p,
});

const evalue = (t: DonneesTroncon, poids = POIDS_DEFAUT) =>
  calculerScore(evaluerCriteres(t, poids, { traficMax: 5000, coutMax: 1000 }));

describe("Score de priorisation", () => {
  it("REFUSE de rendre un score quand un critère pondéré manque", () => {
    // Le cas de production : trafic, criticite et cout sont vides.
    const r = evalue(troncon());
    expect(r.calculable).toBe(false);
    expect(r.score).toBeNull();
    expect(r.criteresManquants).toEqual(["trafic", "criticite", "cout"]);
  });

  it("ne rend jamais 0 à la place d'un score absent", () => {
    // 0 serait un classement : le troncon paraitrait le moins prioritaire.
    expect(evalue(troncon()).score).toBeNull();
  });

  it("ne fabrique plus la criticité depuis la classe de route", () => {
    const criteres = evaluerCriteres(troncon(), POIDS_DEFAUT);
    const crit = criteres.find((c) => c.critere === "criticite")!;
    expect(crit.valeur).toBeNull();
    expect(crit.disponibilite).toBe("ABSENTE");
    expect(crit.commentaire).toMatch(/aucun critère de criticité/i);
  });

  it("ne fabrique plus le coût depuis longueur × tarif", () => {
    const cout = evaluerCriteres(troncon(), POIDS_DEFAUT).find((c) => c.critere === "cout")!;
    expect(cout.valeur).toBeNull();
    expect(cout.disponibilite).toBe("ABSENTE");
  });

  it("calcule quand tous les critères pondérés sont là", () => {
    const r = evalue(
      troncon({ traficMoyenJma: 2500, criticiteStrategique: 60, coutRehabEstime: 500 })
    );
    expect(r.calculable).toBe(true);
    expect(r.score).toBeGreaterThan(0);
    expect(r.criteresManquants).toEqual([]);
  });

  it("redevient calculable si l'on met à zéro le poids des critères absents", () => {
    // Le choix devient explicite et assume, au lieu d'etre masque par un repli.
    const r = evalue(troncon(), { etat: 100, trafic: 0, criticite: 0, cout: 0 });
    expect(r.calculable).toBe(true);
    expect(r.score).toBe(80); // MAUVAIS
    expect(r.explication).toMatch(/1 critère/);
  });

  it("ne classe pas un tronçon jamais évalué", () => {
    // NON_EVALUE est une absence d'information, pas un bon etat.
    const r = evalue(troncon({ etat: "NON_EVALUE" }), { etat: 100, trafic: 0, criticite: 0, cout: 0 });
    expect(r.calculable).toBe(false);
    expect(r.criteresManquants).toContain("etat");
  });

  it("signale un état renseigné mais non daté", () => {
    const etat = evaluerCriteres(troncon(), POIDS_DEFAUT).find((c) => c.critere === "etat")!;
    expect(etat.date).toBeNull();
    expect(etat.commentaire).toMatch(/non daté/);
  });

  it("porte la date du constat quand elle existe", () => {
    const etat = evaluerCriteres(
      troncon({ dateDerniereEvaluation: new Date("2026-08-15") }),
      POIDS_DEFAUT
    ).find((c) => c.critere === "etat")!;
    expect(etat.date).toBe("2026-08-15");
    expect(etat.commentaire).toBe("Constaté");
  });

  it("rend toujours les quatre critères, même absents", () => {
    // Une absence doit se voir, pas disparaitre du tableau.
    const criteres = evaluerCriteres(troncon(), POIDS_DEFAUT);
    expect(criteres).toHaveLength(4);
    for (const c of criteres) {
      expect(c.libelle.length).toBeGreaterThan(4);
      expect(c.commentaire.length).toBeGreaterThan(8);
    }
  });

  it("expose la valeur brute, pas seulement la valeur normalisée", () => {
    const criteres = evaluerCriteres(troncon({ traficMoyenJma: 2500 }), POIDS_DEFAUT, {
      traficMax: 5000,
      coutMax: 1000,
    });
    const trafic = criteres.find((c) => c.critere === "trafic")!;
    expect(trafic.valeurBrute).toBe(2500);
    expect(trafic.valeur).toBe(50);
  });

  it("explique pourquoi le score n'est pas calculable", () => {
    const r = evalue(troncon());
    expect(r.explication).toMatch(/Score non calculable/);
    expect(r.explication).toMatch(/poids à zéro/);
  });

  it("ne classe rien quand aucun critère n'est pondéré", () => {
    const r = evalue(troncon(), { etat: 0, trafic: 0, criticite: 0, cout: 0 });
    expect(r.calculable).toBe(false);
    expect(r.explication).toMatch(/rien à classer/);
  });

  it("couvre les cas demandés : aucun, un, deux, tous les critères", () => {
    const complet = troncon({ traficMoyenJma: 2500, criticiteStrategique: 60, coutRehabEstime: 500 });
    expect(evalue(troncon(), { etat: 0, trafic: 0, criticite: 0, cout: 0 }).calculable).toBe(false);
    expect(evalue(troncon(), { etat: 100, trafic: 0, criticite: 0, cout: 0 }).calculable).toBe(true);
    expect(evalue(complet, { etat: 50, trafic: 50, criticite: 0, cout: 0 }).calculable).toBe(true);
    expect(evalue(complet, POIDS_DEFAUT).calculable).toBe(true);
  });
});
