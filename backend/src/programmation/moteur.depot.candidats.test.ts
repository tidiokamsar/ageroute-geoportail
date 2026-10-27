import { describe, expect, it, vi } from "vitest";

/**
 * Chargement des candidats du simulateur et du moteur v2 (`moteur.depot.chargerCandidats`) : UNE SEULE REGLE avec la liste priorisee
 * (lot 3), pour les points noirs comme pour la longueur.
 *
 * LE DEFAUT (revue) : `chargerCandidats` gardait l'ancien chargement. `CASE WHEN EXISTS (registre non vide) ... ELSE NULL` donnait 0 a
 * TOUT troncon sans point noir des que le registre national n'etait pas vide : un troncon dont personne n'a jamais releve les points
 * noirs descendait en silence, et les alertes A_VALIDER ou rejetees etaient comptees. La liste de priorites applique la regle
 * `resoudreSecurite` (zero seulement si le registre de la region est exploite). Le simulateur et la liste donnaient donc, pour un
 * meme troncon, deux risques differents. Ici la base est simulee (lignes brutes) : le SQL est eprouve sur PostGIS par les bancs.
 */
vi.mock("../lib/reseau", () => ({ fragmentPerimetre: () => ({ strings: [""], values: [] }) }));
vi.mock("../lib/prisma", () => ({ prisma: {} }));

import { chargerCandidats } from "./moteur.depot";
import { classerInterventions, blocEffectif, type FaitsIntervention } from "./priorite.noyau";
import { parametresAmorcage } from "./parametres.noyau";
import { BAREMES, CATALOGUE, CONDITIONS, MATRICES } from "./scenario.fixtures";
import { construireScenario } from "./scenario.noyau";
import { entreesSimulation } from "./contraintes.fixtures";

interface Brute {
  id: string; code: string; nom: string | null; regionId: number | null; classe: string; revetement: string; etat: string;
  longueurKm: number | null; longueurGeometriqueM: number | null; longueurDerivee: boolean;
  traficMoyenJma: number | null; criticiteStrategique: number | null;
  pnConfirmes: number; pnNonConfirmes: number; pnRegistre: number;
}
const ligne = (id: string, o: Partial<Brute>): Brute => ({
  id, code: `T-${id}`, nom: null, regionId: 1, classe: "RN", revetement: "BITUME", etat: "MAUVAIS",
  longueurKm: 2, longueurGeometriqueM: 2000, longueurDerivee: false, traficMoyenJma: 1000, criticiteStrategique: null,
  pnConfirmes: 0, pnNonConfirmes: 0, pnRegistre: 0, ...o,
});
const dbDe = (rows: Brute[]) => ({ $queryRaw: vi.fn(async () => rows) }) as never;

/** Jeu MIXTE : un cas par branche de la regle des points noirs et de la regle de longueur. */
// c, d, e, f portent une criticite strategique : sans point noir connu leur risque reste CALCULABLE sur les autres facteurs (et se compare).
const MIXTE: Brute[] = [
  ligne("a", { regionId: 1, etat: "MAUVAIS", traficMoyenJma: 2500, pnConfirmes: 2, pnRegistre: 10, longueurKm: 4, longueurGeometriqueM: 4100 }), // points noirs confirmes
  ligne("b", { regionId: 1, etat: "CRITIQUE", traficMoyenJma: 600, pnConfirmes: 0, pnRegistre: 10, longueurKm: 1, longueurGeometriqueM: 1000 }), // zero : registre exploite
  ligne("c", { criticiteStrategique: 50, regionId: 2, etat: "MOYEN", traficMoyenJma: 100, revetement: "TERRE", pnRegistre: 3, longueurKm: null, longueurGeometriqueM: 10000 }), // registre trop petit, longueur GEOMETRIE
  ligne("d", { criticiteStrategique: 50, regionId: 2, etat: "MAUVAIS", traficMoyenJma: 2000, pnNonConfirmes: 2, pnRegistre: 3, longueurKm: 3, longueurGeometriqueM: 3000, longueurDerivee: true }), // alertes non confirmees, longueur derivee
  ligne("e", { criticiteStrategique: 50, regionId: 3, etat: "BON", traficMoyenJma: 50, pnRegistre: 0, longueurKm: 0, longueurGeometriqueM: 5000 }), // registre vide, longueurKm nulle
  ligne("f", { criticiteStrategique: 50, regionId: null, etat: "MAUVAIS", traficMoyenJma: 800, pnRegistre: 0, longueurKm: 2, longueurGeometriqueM: 2000 }), // sans region
  ligne("g", { regionId: 1, etat: "MOYEN", traficMoyenJma: 400, pnRegistre: 10, longueurKm: null, longueurGeometriqueM: null }), // aucune longueur
  ligne("h", { regionId: 1, etat: "CRITIQUE", traficMoyenJma: 4000, pnConfirmes: 1, pnRegistre: 10, longueurKm: 6, longueurGeometriqueM: 6000 }),
  ligne("i", { regionId: 1, etat: "MAUVAIS", traficMoyenJma: 300, pnConfirmes: 3, pnRegistre: 10, longueurKm: 2.5, longueurGeometriqueM: 2400 }),
];

/** Troncons dont le facteur « securite » est ABSENT (registre de la region non exploite) : ni la liste ni le simulateur ne leur invente un zero. */
const SANS_SECURITE = ["c", "d", "e", "f"];

describe("chargerCandidats : points noirs (regle du lot 3, plus l'ancien « 0 des que le registre n'est pas vide »)", () => {
  it("compte les points noirs CONFIRMES du troncon ; zero seulement si le registre de la REGION est exploite ; sinon ABSENT (null), jamais 0", async () => {
    const c = await chargerCandidats(dbDe(MIXTE), { limite: 100, registrePointsNoirsMinimum: 5 });
    const nb = Object.fromEntries(c.map((x) => [x.id, x.nbPointsNoirs]));
    expect(nb).toEqual({ a: 2, b: 0, c: null, d: null, e: null, f: null, g: 0, h: 1, i: 3 });
  });

  it("une alerte A_VALIDER / A_CORRIGER (comptee a part) ne devient ni un point noir ni un zero", async () => {
    const c = await chargerCandidats(dbDe([ligne("d", { pnNonConfirmes: 4, pnRegistre: 2 })]), { limite: 10, registrePointsNoirsMinimum: 5 });
    expect(c[0].nbPointsNoirs).toBeNull();
  });

  it("le minimum est celui de la VERSION de parametres : un registre de 3 points est exploite si le minimum est 3", async () => {
    const rows = [ligne("c", { pnRegistre: 3 })];
    expect((await chargerCandidats(dbDe(rows), { limite: 10, registrePointsNoirsMinimum: 3 }))[0].nbPointsNoirs).toBe(0);
    expect((await chargerCandidats(dbDe(rows), { limite: 10, registrePointsNoirsMinimum: 4 }))[0].nbPointsNoirs).toBeNull();
  });
});

describe("chargerCandidats : longueur (metier, geometrique, derivee : jamais confondues)", () => {
  it("longueur metier si positive (origine LONGUEUR_KM), sinon geometrie (origine GEOMETRIE), sinon aucune ; le drapeau « derivee » est conserve", async () => {
    const c = await chargerCandidats(dbDe(MIXTE), { limite: 100, registrePointsNoirsMinimum: 5 });
    const l = Object.fromEntries(c.map((x) => [x.id, [x.longueurM, x.longueurOrigine, x.longueurMetierDerivee]]));
    expect(l).toEqual({
      a: [4000, "LONGUEUR_KM", false], b: [1000, "LONGUEUR_KM", false], c: [10000, "GEOMETRIE", null],
      d: [3000, "LONGUEUR_KM", true], e: [5000, "GEOMETRIE", null], f: [2000, "LONGUEUR_KM", false], g: [null, null, null], h: [6000, "LONGUEUR_KM", false], i: [2500, "LONGUEUR_KM", false],
    });
  });
});

describe("EQUIVALENCE liste / simulateur sur un jeu mixte : meme risque, meme longueur, meme ordre d'arbitrage pour un troncon", () => {
  const parametres = parametresAmorcage();
  const minimum = blocEffectif(parametres).bloc.registrePointsNoirsMinimum;

  /** Les memes lignes brutes lues comme FAITS par la liste priorisee (lot 3). */
  const faits = (rows: Brute[]): FaitsIntervention[] => rows.map((r) => ({
    id: r.id, code: r.code, nom: r.nom, regionId: r.regionId, regionNom: null, classe: r.classe, revetement: r.revetement, prefecture: null,
    etat: r.etat, traficMoyenJma: r.traficMoyenJma, traficDateComptage: null, criticiteStrategique: r.criticiteStrategique,
    pointsNoirs: { confirmes: r.pnConfirmes, nonConfirmes: r.pnNonConfirmes, registreRegion: r.pnRegistre },
    constats: [], dateDerniereEvaluation: null,
    longueurKm: r.longueurKm, longueurMetierDerivee: r.longueurKm !== null && r.longueurKm > 0 ? r.longueurDerivee : null, longueurGeometriqueM: r.longueurGeometriqueM,
    localisation: { valide: true, motif: null }, qualiteEtat: null, sourceTroncon: { type: null, confiance: null },
  }));

  it("risque courant, risque attendu, longueur utilisee et origine : identiques troncon par troncon", async () => {
    const candidats = await chargerCandidats(dbDe(MIXTE), { limite: 100, registrePointsNoirsMinimum: minimum });
    const simulateur = construireScenario(entreesSimulation({ candidats, parametres, budgetGnf: 1_000_000_000_000n }));
    if (!simulateur.ok) throw new Error(simulateur.erreurs.join(" ; "));
    const liste = classerInterventions({ dateReference: "2026-10-27", parametres, candidats: faits(MIXTE), baremes: BAREMES, catalogue: CATALOGUE, conditions: CONDITIONS, matrices: MATRICES });
    if (!liste.ok) throw new Error(liste.erreurs.join(" ; "));

    let compares = 0;
    for (const s of simulateur.scenario.lignes) {
      const l = liste.resultat.lignes.find((x) => x.id === s.troncon.id)!;
      expect(l.longueur.utiliseeM, `${s.troncon.id} longueur`).toBe(s.troncon.longueurM);
      expect(l.longueur.longueurOrigine, `${s.troncon.id} origine`).toBe(s.troncon.longueurOrigine);
      if (s.risque.ok) {
        expect(l.ordreArbitrage.risqueCourant, `${s.troncon.id} risque`).toBe(s.risque.score);
        expect(l.ordreArbitrage.risqueAttendu, `${s.troncon.id} risque attendu`).toBe(s.risqueAttendu?.score ?? null);
        compares += 1;
      } else {
        // Risque non calculable pour le simulateur : la liste ne le classe pas non plus (rang d'arbitrage nul, motif donne).
        expect(l.ordreArbitrage.rang, `${s.troncon.id} rang`).toBeNull();
        expect(l.ordreArbitrage.risqueCourant, `${s.troncon.id} risque`).toBeNull();
        expect(l.ordreArbitrage.motifAbsence, `${s.troncon.id} motif`).not.toBeNull();
      }
    }
    expect(compares).toBe(5); // a, b, g, h, i
  });

  it("les troncons au registre non exploite sont non calculables des DEUX cotes (aucun zero invente), avec la meme raison", async () => {
    const candidats = await chargerCandidats(dbDe(MIXTE), { limite: 100, registrePointsNoirsMinimum: minimum });
    const sim = construireScenario(entreesSimulation({ candidats, parametres, budgetGnf: 1_000_000_000_000n }));
    if (!sim.ok) throw new Error("refus");
    for (const id of SANS_SECURITE) {
      const l = sim.scenario.lignes.find((x) => x.troncon.id === id)!;
      expect(l.risque.ok, id).toBe(false);
      expect(l.motifExclusion?.code, id).toBe("RISQUE_NON_CALCULABLE");
      expect(l.motifExclusion?.detail, id).toMatch(/SECURITE/);
    }
  });

  it("l'ordre d'arbitrage de la liste est celui du simulateur (logique ratio cout / impact) pour les troncons que les deux classent", async () => {
    const candidats = await chargerCandidats(dbDe(MIXTE), { limite: 100, registrePointsNoirsMinimum: minimum });
    const sim = construireScenario(entreesSimulation({ candidats, parametres, budgetGnf: 1_000_000_000_000n }));
    const liste = classerInterventions({ dateReference: "2026-10-27", parametres, candidats: faits(MIXTE), baremes: BAREMES, catalogue: CATALOGUE, conditions: CONDITIONS, matrices: MATRICES });
    if (!sim.ok || !liste.ok) throw new Error("refus");
    const ordreSimulateur = sim.scenario.lignes.filter((l) => l.simulation?.ordreArbitrage != null).sort((a, b) => (a.simulation!.ordreArbitrage as number) - (b.simulation!.ordreArbitrage as number)).map((l) => l.troncon.id);
    const ordreListe = liste.resultat.lignes.filter((l) => l.ordreArbitrage.rang != null).sort((a, b) => (a.ordreArbitrage.rang as number) - (b.ordreArbitrage.rang as number)).map((l) => l.id);
    expect(ordreSimulateur).toHaveLength(4); // g n a aucune longueur : cout non estimable, non classe des deux cotes
    expect(ordreListe).toEqual(ordreSimulateur);
  });

  it("AVANT le correctif, ces troncons recevaient un zero : contre-epreuve, le zero invente les rend calculables et change leur classement", async () => {
    const candidats = await chargerCandidats(dbDe(MIXTE), { limite: 100, registrePointsNoirsMinimum: minimum });
    const ancien = candidats.map((c) => (SANS_SECURITE.includes(c.id) ? { ...c, nbPointsNoirs: 0 } : c)); // l'ancien CASE WHEN EXISTS(registre non vide)
    const sim = construireScenario(entreesSimulation({ candidats: ancien, parametres, budgetGnf: 1_000_000_000_000n }));
    if (!sim.ok) throw new Error("refus");
    expect(sim.scenario.lignes.filter((l) => SANS_SECURITE.includes(l.troncon.id) && l.risque.ok)).toHaveLength(SANS_SECURITE.length);
  });
});
