import { describe, expect, it } from "vitest";
import { estimerPourDecision } from "./decision.estimation";
import { familleCoutDeTroncon } from "./famille-cout";
import type { LigneBareme } from "./cout.noyau";

/**
 * L'ecran de decision ne porte plus de bareme invente : ce que ces tests defendent.
 *
 * - un troncon CRITIQUE bitume est chiffre sur le bareme de la base (3,5 Md/km), pas sur les
 *   800 M/km codes en dur qui le contredisaient ;
 * - un troncon qu'aucune ligne ne couvre -- BON, NON_EVALUE, revetement non renseigne -- rend
 *   un montant NUL et son motif, jamais un chiffre plausible ;
 * - la criticite est nulle, faute de toute source, et le client le sait ;
 * - le cout n'est jamais presente comme un critere reel.
 */

const BAREMES: LigneBareme[] = [
  { id: 1, code: "BITUME.MOYEN.ENTRETIEN_PERIODIQUE", familleRevetement: "bitume", etatDepart: "MOYEN", typeIntervention: "entretien_periodique", coutKmGnf: 350_000_000n, uniteCout: "KM", devise: "GNF" },
  { id: 2, code: "BITUME.MAUVAIS.REHABILITATION", familleRevetement: "bitume", etatDepart: "MAUVAIS", typeIntervention: "rehabilitation", coutKmGnf: 1_100_000_000n, uniteCout: "KM", devise: "GNF" },
  { id: 3, code: "BITUME.CRITIQUE.RECONSTRUCTION", familleRevetement: "bitume", etatDepart: "CRITIQUE", typeIntervention: "reconstruction", coutKmGnf: 3_500_000_000n, uniteCout: "KM", devise: "GNF" },
  { id: 6, code: "TERRE_LATERITE.CRITIQUE.RECONSTRUCTION", familleRevetement: "terre_laterite", etatDepart: "CRITIQUE", typeIntervention: "reconstruction", coutKmGnf: 700_000_000n, uniteCout: "KM", devise: "GNF" },
];

describe("La famille de cout d'un troncon", () => {
  it("suit la correspondance des baremes, et NON_RENSEIGNE n'en a pas", () => {
    expect(familleCoutDeTroncon("BITUME")).toBe("bitume");
    expect(familleCoutDeTroncon("TERRE")).toBe("terre_laterite");
    expect(familleCoutDeTroncon("LATERITE")).toBe("terre_laterite");
    expect(familleCoutDeTroncon("PAVE")).toBe("pave");
    expect(familleCoutDeTroncon("NON_RENSEIGNE")).toBeNull();
    expect(familleCoutDeTroncon(null)).toBeNull();
    expect(familleCoutDeTroncon("BETON")).toBeNull();
  });
});

describe("Le montant vient du bareme de la base, pas d'un tarif code en dur", () => {
  it("12,4 km de bitume CRITIQUE : 43,4 Md GNF sur le bareme, la ou l'ancien tarif disait 9,92", () => {
    const r = estimerPourDecision({ etat: "CRITIQUE", revetement: "BITUME", longueurKm: 12.4, traficMoyenJma: null }, BAREMES);
    expect(r.montantRehabEstimeMd).toBe(43.4);
    expect(r.estimationCout.ok).toBe(true);
    expect(r.estimationCout.bareme?.code).toBe("BITUME.CRITIQUE.RECONSTRUCTION");
    expect(r.estimationCout.classePrecision).toBe("RESEAU_30");
    // Ancien calcul : 12,4 km x 800 M/km = 9,92 Md. Un facteur 4,4 d'ecart, servi comme une estimation.
    expect(r.montantRehabEstimeMd).not.toBe(9.92);
  });

  it("est PROVISOIRE sur les baremes d'origine, et dit ce qui manque", () => {
    const r = estimerPourDecision({ etat: "MAUVAIS", revetement: "BITUME", longueurKm: 5, traficMoyenJma: 1200 }, BAREMES);
    expect(r.estimationCout.provisoire).toBe(true);
    expect(r.estimationCout.hypothesesManquantes).toEqual(["ligne de bareme non approuvee", "millesime du prix inconnu", "largeur de chaussee de reference inconnue"]);
    expect(r.estimations.cout).toMatch(/provisoire.*millesime du prix inconnu/);
  });
});

describe("Quand il ne sait pas, il rend null et le dit", () => {
  it.each([
    ["BON", "BITUME", /aucune ligne de bareme/i],
    ["NON_EVALUE", "BITUME", /aucune ligne de bareme/i],
    ["CRITIQUE", "NON_RENSEIGNE", /aucune famille de cout/],
    ["MAUVAIS", "TERRE", /aucune ligne de bareme/i],
  ])("etat %s, revetement %s : montant nul, motif present", (etat, revetement, motif) => {
    const r = estimerPourDecision({ etat, revetement, longueurKm: 3, traficMoyenJma: null }, BAREMES);
    expect(r.montantRehabEstimeMd).toBeNull();
    expect(r.estimationCout.ok).toBe(false);
    expect(r.estimationCout.refus?.motif).toMatch(motif);
    expect(r.estimations.cout).toMatch(/^non estimé/);
  });

  it("l'ancien tarif rendait 200 M/km pour NON_EVALUE : un chiffre pour « on ne sait pas »", () => {
    const r = estimerPourDecision({ etat: "NON_EVALUE", revetement: "LATERITE", longueurKm: 10, traficMoyenJma: null }, BAREMES);
    expect(r.montantRehabEstimeMd).toBeNull();
  });
});

describe("La criticite et les criteres reels", () => {
  it("la criticite est nulle, et le client sait qu'elle n'est pas un critere reel", () => {
    const r = estimerPourDecision({ etat: "CRITIQUE", revetement: "BITUME", longueurKm: 1, traficMoyenJma: 500 }, BAREMES);
    expect(r.criticiteEstimee).toBeNull();
    expect(r.criteresReels.criticite).toBe(false);
    expect(r.estimations.criticite).toMatch(/aucune source/);
  });

  it("le cout n'est jamais un critere reel, meme quand il est estime", () => {
    const r = estimerPourDecision({ etat: "CRITIQUE", revetement: "BITUME", longueurKm: 1, traficMoyenJma: 500 }, BAREMES);
    expect(r.estimationCout.ok).toBe(true);
    expect(r.criteresReels.cout).toBe(false);
  });

  it("etat et trafic restent des criteres reels quand ils sont renseignes", () => {
    const avec = estimerPourDecision({ etat: "MAUVAIS", revetement: "BITUME", longueurKm: 1, traficMoyenJma: 500 }, BAREMES);
    expect(avec.criteresReels).toEqual({ etat: true, trafic: true, criticite: false, cout: false });
    const sans = estimerPourDecision({ etat: "NON_EVALUE", revetement: "BITUME", longueurKm: 1, traficMoyenJma: null }, BAREMES);
    expect(sans.criteresReels).toEqual({ etat: false, trafic: false, criticite: false, cout: false });
  });
});
