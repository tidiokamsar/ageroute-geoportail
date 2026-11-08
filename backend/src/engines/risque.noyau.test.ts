import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { calculerRisque, type EntreesRisque } from "./risque.noyau";
import { parametresAmorcage, type ParametresProgrammation } from "../programmation/parametres.noyau";

/**
 * Ce que ces tests defendent :
 *   - une absence n'est JAMAIS un zero : le facteur sort du calcul avec son motif ;
 *   - l'etat est obligatoire, et un etat NON_EVALUE n'est pas un etat bon ;
 *   - sous le minimum de facteurs ou la couverture, le moteur REFUSE (il ne devine pas) ;
 *   - le resultat porte l'etiquette PROVISOIRE tant que les parametres ne sont pas approuves ;
 *   - les calculs sont verifies contre des valeurs rationnelles posees a la main.
 */
describe("Le noyau ne depend d'aucune base", () => {
  it("n'importe que le noyau des parametres", () => {
    const src = readFileSync(join(__dirname, "risque.noyau.ts"), "utf8");
    const imports = [...src.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports).toEqual(["../programmation/parametres.noyau"]);
  });
});

const vide: EntreesRisque = { etat: "MAUVAIS", traficMoyenJma: null, criticiteStrategique: null, nbPointsNoirs: null, vulnerabiliteClimatique: null, populationDesservie: null };
const P = (): ParametresProgrammation => parametresAmorcage();

describe("calculerRisque : calcul", () => {
  it("somme ponderee renormalisee : (40x65 + 25x50 + 15x200/3) / 80 = 60,625", () => {
    const r = calculerRisque({ ...vide, traficMoyenJma: 2500, nbPointsNoirs: 2 }, P());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.score).toBe(60.625);
      expect(r.scoreMicro).toBe(606250);
      expect(r.facteursDisponibles).toBe(3);
      expect(r.facteursPonderes).toBe(5);
      expect(r.couverture).toBe(0.8);
      expect(r.etiquette).toBe("PROVISOIRE, non approuvé");
      expect(r.formule).toMatch(/somme\(poids x valeur\)/);
    }
  });

  it("les cinq facteurs : valeur bornee a 100, aucune renormalisation", () => {
    const r = calculerRisque({ etat: "CRITIQUE", traficMoyenJma: 10000, criticiteStrategique: null, nbPointsNoirs: 9, vulnerabiliteClimatique: 80, populationDesservie: 50000 }, P());
    expect(r.ok).toBe(true);
    // (40x90 + 25x100 + 15x100 + 10x80 + 10x50) / 100 = 3600+2500+1500+800+500 = 8900 / 100 = 89
    if (r.ok) { expect(r.score).toBe(89); expect(r.couverture).toBe(1); }
  });

  it("sans trafic, la criticite strategique tient lieu d'importance, et la source est nommee", () => {
    const r = calculerRisque({ ...vide, criticiteStrategique: 80, nbPointsNoirs: 3 }, P());
    expect(r.ok).toBe(true);
    if (r.ok) {
      const f = r.facteurs.find((x) => x.facteur === "TRAFIC_IMPORTANCE")!;
      expect(f.origine).toBe("troncons.criticiteStrategique");
      expect(f.valeur).toBe(80);
      // (40x65 + 25x80 + 15x100) / 80 = (2600+2000+1500)/80 = 76,25
      expect(r.score).toBe(76.25);
    }
  });

  it("le trafic prime sur la criticite quand les deux existent", () => {
    const r = calculerRisque({ ...vide, traficMoyenJma: 1000, criticiteStrategique: 90, nbPointsNoirs: 0 }, P());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.facteurs.find((x) => x.facteur === "TRAFIC_IMPORTANCE")!.origine).toBe("troncons.traficMoyenJma");
  });

  it("une criticite hors de 0 a 100 n'est pas lue (echelle inconnue), elle est dite hors echelle", () => {
    const r = calculerRisque({ ...vide, criticiteStrategique: 450, nbPointsNoirs: 1, vulnerabiliteClimatique: 10 }, P());
    expect(r.ok).toBe(true);
    if (r.ok) {
      const f = r.facteurs.find((x) => x.facteur === "TRAFIC_IMPORTANCE")!;
      expect(f.disponible).toBe(false);
      expect(f.note).toMatch(/hors de l'echelle/);
    }
  });
});

describe("calculerRisque : refus", () => {
  it("ETAT_NON_EVALUE : un etat inconnu n'est pas un etat bon", () => {
    for (const etat of ["NON_EVALUE", null, "BIZARRE"]) {
      const r = calculerRisque({ ...vide, etat, traficMoyenJma: 2000, nbPointsNoirs: 1, vulnerabiliteClimatique: 50 }, P());
      expect(r.ok, String(etat)).toBe(false);
      if (!r.ok) expect(r.code).toBe("ETAT_NON_EVALUE");
    }
  });

  it("FACTEURS_INSUFFISANTS : deux facteurs sur trois requis, et le motif nomme ce qui manque", () => {
    const r = calculerRisque({ ...vide, nbPointsNoirs: 2 }, P());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("FACTEURS_INSUFFISANTS");
      expect(r.motif).toMatch(/2 facteur\(s\) disponible\(s\) sur 5 ponderes, minimum 3/);
      expect(r.motif).toMatch(/TRAFIC_IMPORTANCE/);
      expect(r.facteurs).toHaveLength(5);
    }
  });

  it("abaisser le minimum est un choix de parametre visible, pas un repli", () => {
    const p = P();
    p.valeurs.facteursMinimum = 2;
    const r = calculerRisque({ ...vide, nbPointsNoirs: 2 }, p);
    // couverture (40+15)/100 = 0,55 >= 0,5
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.couverture).toBe(0.55); expect(r.score).toBe(calculerScoreAttendu()); }
  });

  it("COUVERTURE_INSUFFISANTE : assez de facteurs, mais trop peu du poids", () => {
    const p = P();
    p.valeurs.poidsRisque = { ETAT: 10, TRAFIC_IMPORTANCE: 10, SECURITE: 10, CLIMAT: 35, POPULATION: 35 };
    const r = calculerRisque({ ...vide, traficMoyenJma: 1000, nbPointsNoirs: 1 }, p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("COUVERTURE_INSUFFISANTE");
  });

  it("un poids nul exclut explicitement le facteur du calcul et du minimum", () => {
    const p = P();
    p.valeurs.poidsRisque = { ETAT: 50, TRAFIC_IMPORTANCE: 50, SECURITE: 0, CLIMAT: 0, POPULATION: 0 };
    p.valeurs.facteursMinimum = 2;
    const r = calculerRisque({ ...vide, traficMoyenJma: 5000 }, p);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.facteursPonderes).toBe(2);
      expect(r.couverture).toBe(1);
      expect(r.score).toBe(82.5); // (50x65 + 50x100) / 100
    }
  });

  it("AUCUN_FACTEUR_PONDERE : tous les poids a zero", () => {
    const p = P();
    p.valeurs.poidsRisque = { ETAT: 0, TRAFIC_IMPORTANCE: 0, SECURITE: 0, CLIMAT: 0, POPULATION: 0 };
    const r = calculerRisque(vide, p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("AUCUN_FACTEUR_PONDERE");
  });

  it("le refus aussi porte l'etiquette ; approuve, elle change", () => {
    const refus = calculerRisque({ ...vide, etat: null }, P());
    expect(refus.etiquette).toBe("PROVISOIRE, non approuvé");
    const appr = { ...P(), approuveeLe: "2026-10-23T00:00:00.000Z", approuveeParId: "u1" };
    const ok = calculerRisque({ ...vide, traficMoyenJma: 1000, nbPointsNoirs: 1 }, appr);
    expect(ok.etiquette).toBe("paramètres approuvés");
  });
});

describe("calculerRisque : determinisme", () => {
  it("memes entrees, memes sorties, a l'arrondi pres sur les chaines", () => {
    const e = { ...vide, traficMoyenJma: 777, nbPointsNoirs: 1, vulnerabiliteClimatique: 33.3333 };
    expect(JSON.stringify(calculerRisque(e, P()))).toBe(JSON.stringify(calculerRisque({ ...e }, P())));
  });
});

/** Oracle pour le cas a deux facteurs, depuis les valeurs affichees (le facteur securite vaut 66,6667, arrondi avant agregation) : (40x65 + 15x66,6667) / 55. */
function calculerScoreAttendu(): number {
  return Math.round(((40 * 65 + 15 * 66.6667) / 55) * 10000) / 10000;
}
