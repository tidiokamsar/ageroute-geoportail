import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * L'analyse de trace AVEC le graphe du reseau : ce que ces tests defendent.
 *
 *   - le graphe n'est utilise que si l'appelant fournit la tolerance de fusion : AUCUNE valeur n'est
 *     supposee, comme pour la deviation ;
 *   - EPREUVE DECISIVE : une contre-allee parallele, reliee au reseau par ses seules extremites,
 *     attire le HMM sur quelques points bruites quand les changements de troncon ne sont pas
 *     verifies ; avec le graphe, le detour de plusieurs kilometres l'ecarte ;
 *   - un changement de troncon reel (jonction) est verifie, et le compte des « non verifies » tombe ;
 *   - ce que l'on demande et que l'on ne peut pas honorer est REFUSE, jamais degrade en silence ;
 *   - les parametres du graphe sont restitues : un resultat se lit avec la tolerance qui l'a produit.
 */

const h = vi.hoisted(() => ({
  appelsGraphe: [] as { emprise: { ouest: number; sud: number; est: number; nord: number }; tolerance: number }[],
  tropLarge: false,
}));

vi.mock("../lib/prisma", () => ({ prisma: {} }));

// Reseau reel en lon/lat : A (sud), B (au bout de A, vers le nord), C = contre-allee de A, a 36 m,
// reliee au reseau UNIQUEMENT par les deux extremites de A.
const A = { id: "t-A", coordonnees: [[-13.60, 9.64], [-13.58, 9.64]] as [number, number][] };
const B = { id: "t-B", coordonnees: [[-13.58, 9.64], [-13.58, 9.66]] as [number, number][] };
const C = { id: "t-C", coordonnees: [[-13.60, 9.64], [-13.5995, 9.64032], [-13.5805, 9.64032], [-13.58, 9.64]] as [number, number][] };

vi.mock("./graphe.depot", async () => {
  const { construireGraphe } = await import("./graphe.noyau");
  class EmpriseTropLarge extends Error {
    constructor(public nombre: number) { super(`Emprise trop large : ${nombre} troncons (plafond 20000)`); }
  }
  const longueur = (c: [number, number][]) => {
    let l = 0;
    for (let i = 1; i < c.length; i += 1) {
      const dx = (c[i][0] - c[i - 1][0]) * 111_320 * Math.cos((9.64 * Math.PI) / 180);
      const dy = (c[i][1] - c[i - 1][1]) * 111_320;
      l += Math.hypot(dx, dy);
    }
    return l;
  };
  return {
    EmpriseTropLarge,
    MAX_TRONCONS_GRAPHE: 20_000,
    chargerGraphe: async (_d: unknown, emprise: { ouest: number; sud: number; est: number; nord: number }, tolerance: number) => {
      h.appelsGraphe.push({ emprise, tolerance });
      if (h.tropLarge) throw new EmpriseTropLarge(25_000);
      const troncons = [A, B, C].map((t) => ({ id: t.id, longueurM: longueur(t.coordonnees), coordonnees: t.coordonnees }));
      return { graphe: construireGraphe(troncons, tolerance), nbTroncons: troncons.length };
    },
  };
});

import { analyserTrace, MARGE_GRAPHE_M, RefusTrace, type DepotTrace } from "./trace.service";
import type { PointBrut } from "./trace.import.noyau";

const M_PAR_DEG_LON = 111_320 * Math.cos((9.64 * Math.PI) / 180);
const LONG_A = 0.02 * M_PAR_DEG_LON;
const LONG_B = 0.02 * 111_320;
const LONG_C = 2 * 5 * 0 + (() => { // longueur de C, a la louche : A + les deux decrochages
  const dx = 0.0005 * M_PAR_DEG_LON, dy = 0.00032 * 111_320;
  return LONG_A - 2 * 0.0005 * M_PAR_DEG_LON + 2 * Math.hypot(dx, dy);
})();

interface Ligne { i: number; tronconId: string; code: string; nom: string | null; classe: string; distanceM: number; fraction: number; longueurM: number; pkDebut: number | null; pkFin: number | null }
const cand = (i: number, id: string, code: string, distanceM: number, fraction: number, longueurM: number): Ligne =>
  ({ i, tronconId: id, code, nom: null, classe: "RN", distanceM, fraction, longueurM, pkDebut: null, pkFin: null });

/** Depot simule : 1er appel = candidats, 2e = geometries des passages. */
function depot(lignes: Ligne[]) {
  let n = 0;
  return { $queryRaw: async () => (++n === 1 ? lignes : []) } as unknown as DepotTrace;
}

const pasLon = 20 / M_PAR_DEG_LON;
const pasLat = 20 / 111_320;

/** Une trace le long de A, puis le long de B : 110 puis 110 points a 20 m. */
function traceAB(): { pts: PointBrut[]; nA: number; nB: number } {
  const nA = Math.floor(LONG_A / 20), nB = Math.floor(LONG_B / 20);
  const pts: PointBrut[] = [];
  for (let k = 0; k < nA; k += 1) pts.push({ lat: 9.64, lon: -13.60 + k * pasLon, tMs: k * 2000, precisionM: null });
  for (let k = 0; k < nB; k += 1) pts.push({ lat: 9.64 + (k + 1) * pasLat, lon: -13.58, tMs: (nA + k) * 2000, precisionM: null });
  return { pts, nA, nB };
}

beforeEach(() => { h.appelsGraphe.length = 0; h.tropLarge = false; });

describe("le graphe n'est utilise que si on le demande", () => {
  it("SANS tolerance : le graphe n'est pas charge, et le dit", async () => {
    const { pts, nA } = traceAB();
    const lignes = pts.map((_, i) => (i < nA
      ? cand(i, "t-A", "RN-A", 5, i / nA, LONG_A)
      : cand(i, "t-B", "RN-B", 5, (i - nA) / (pts.length - nA), LONG_B)));
    const a = await analyserTrace(depot(lignes), { points: pts });
    expect(h.appelsGraphe).toHaveLength(0);
    expect(a.parametres.graphe).toBeNull();
    expect(a.indicateurs.transitionsNonVerifiees).toBeGreaterThan(0);
    expect(a.avertissements.join(" ")).toMatch(/fournir la tolerance de fusion/);
  });

  it("AVEC tolerance : le graphe est charge avec CETTE tolerance, sur une emprise elargie de la marge", async () => {
    const { pts, nA } = traceAB();
    const lignes = pts.map((_, i) => (i < nA
      ? cand(i, "t-A", "RN-A", 5, i / nA, LONG_A)
      : cand(i, "t-B", "RN-B", 5, (i - nA) / (pts.length - nA), LONG_B)));
    await analyserTrace(depot(lignes), { points: pts }, { toleranceFusionM: 2.5, distanceMaxM: 50 });
    expect(h.appelsGraphe).toHaveLength(1);
    expect(h.appelsGraphe[0].tolerance).toBe(2.5);
    const e = h.appelsGraphe[0].emprise;
    const margeDeg = (50 + MARGE_GRAPHE_M) / 111_320;
    // L'emprise contient la trace ET la marge : un detour qui s'ecarte de la trace reste trouvable.
    expect(e.sud).toBeLessThanOrEqual(9.64 - margeDeg * 0.99);
    expect(e.nord).toBeGreaterThanOrEqual(9.66 + margeDeg * 0.99);
  });

  it("restitue les parametres du graphe : un resultat se lit avec la tolerance qui l'a produit", async () => {
    const { pts, nA } = traceAB();
    const lignes = pts.map((_, i) => (i < nA ? cand(i, "t-A", "RN-A", 5, i / nA, LONG_A) : cand(i, "t-B", "RN-B", 5, (i - nA) / (pts.length - nA), LONG_B)));
    const a = await analyserTrace(depot(lignes), { points: pts }, { toleranceFusionM: 2.5 });
    expect(a.parametres.graphe).toMatchObject({ toleranceFusionM: 2.5, margeM: MARGE_GRAPHE_M, nbTroncons: 3 });
    expect(a.parametres.graphe!.plafondReseauM).toBeGreaterThanOrEqual(2000);
  });
});

describe("un changement de troncon reel est verifie", () => {
  it("A puis B, relies a la jonction : les changements non verifies tombent a zero", async () => {
    const { pts, nA } = traceAB();
    const lignes = pts.map((_, i) => (i < nA
      ? cand(i, "t-A", "RN-A", 5, i / nA, LONG_A)
      : cand(i, "t-B", "RN-B", 5, (i - nA) / (pts.length - nA), LONG_B)));
    const sans = await analyserTrace(depot(lignes), { points: pts });
    const avec = await analyserTrace(depot(lignes), { points: pts }, { toleranceFusionM: 2.5 });
    expect(sans.indicateurs.transitionsNonVerifiees).toBeGreaterThan(0);
    expect(avec.indicateurs.transitionsNonVerifiees).toBe(0);
    expect(avec.passages.map((p) => p.code)).toEqual(["RN-A", "RN-B"]);
    expect(avec.avertissements.join(" ")).not.toMatch(/ne sont pas verifies|restent non verifies/);
  });

  it("une tolerance trop fine ne relie pas les extremites : la transition reste NON VERIFIEE, et c'est dit avec ses causes", async () => {
    // A et B se touchent EXACTEMENT ici : on decale B de 30 m pour que 2,5 m ne suffise pas.
    const decale = pasLat * 0 + 30 / 111_320;
    B.coordonnees = [[-13.58, 9.64 + decale], [-13.58, 9.66 + decale]];
    try {
      const { pts, nA } = traceAB();
      const lignes = pts.map((_, i) => (i < nA
        ? cand(i, "t-A", "RN-A", 5, i / nA, LONG_A)
        : cand(i, "t-B", "RN-B", 5, (i - nA) / (pts.length - nA), LONG_B)));
      const a = await analyserTrace(depot(lignes), { points: pts }, { toleranceFusionM: 2.5 });
      expect(a.indicateurs.transitionsNonVerifiees).toBeGreaterThan(0);
      const texte = a.avertissements.join(" ");
      expect(texte).toMatch(/restent non verifies malgre le graphe/);
      expect(texte).toMatch(/extremites non reliees a cette tolerance/);
    } finally {
      B.coordonnees = [[-13.58, 9.64], [-13.58, 9.66]];
    }
  });
});

describe("EPREUVE DECISIVE : la contre-allee parallele", () => {
  /**
   * Trace le long de A. Aux points 40 a 46, le bruit rapproche la trace de C (3 m) et l'eloigne de
   * A (14 m). C est a 36 m de A et ne lui est reliee que par ses extremites : passer de A a C
   * demande de redescendre jusqu'a l'extremite, soit pres d'un kilometre de detour.
   */
  function scenario() {
    const nA = Math.floor(LONG_A / 20);
    const pts: PointBrut[] = [];
    for (let k = 0; k < nA; k += 1) pts.push({ lat: 9.64, lon: -13.60 + k * pasLon, tMs: k * 2000, precisionM: null });
    const lignes: Ligne[] = [];
    for (let i = 0; i < nA; i += 1) {
      const bruite = i >= 40 && i <= 46;
      lignes.push(cand(i, "t-A", "RN-A", bruite ? 14 : 5, i / nA, LONG_A));
      lignes.push(cand(i, "t-C", "RN-C", bruite ? 3 : 31, i / nA, LONG_C));
    }
    return { pts, lignes };
  }

  it("SANS graphe, le bruit attire le HMM sur la contre-allee : la trace saute de A a C", async () => {
    const { pts, lignes } = scenario();
    const a = await analyserTrace(depot(lignes), { points: pts });
    expect(a.passages.map((p) => p.code)).toContain("RN-C");
  });

  it("AVEC le graphe, la contre-allee est ECARTEE : la trace reste sur A de bout en bout", async () => {
    const { pts, lignes } = scenario();
    const a = await analyserTrace(depot(lignes), { points: pts }, { toleranceFusionM: 2.5 });
    expect(a.passages.map((p) => p.code)).toEqual(["RN-A"]);
    expect(a.indicateurs.tauxRattachement).toBe(1);
    expect(a.passages.every((p) => !p.court)).toBe(true);
  });
});

describe("ce que l'on demande et que l'on ne peut pas honorer est refuse", () => {
  it("emprise trop large pour le graphe : REFUS 422 avec la conduite a tenir, jamais un repli silencieux", async () => {
    h.tropLarge = true;
    const { pts, nA } = traceAB();
    const lignes = pts.map((_, i) => cand(i, "t-A", "RN-A", 5, Math.min(1, i / nA), LONG_A));
    const e = await analyserTrace(depot(lignes), { points: pts }, { toleranceFusionM: 2.5 }).catch((x) => x);
    expect(e).toBeInstanceOf(RefusTrace);
    expect(e).toMatchObject({ code: "GRAPHE_TROP_GRAND", http: 422 });
    expect(e.message).toMatch(/Retirer la verification sur le reseau, ou decouper la trace/);
  });

  it("une autre erreur du chargement remonte telle quelle", async () => {
    const mauvais = { $queryRaw: async () => { throw new Error("base indisponible"); } } as unknown as DepotTrace;
    const { pts } = traceAB();
    await expect(analyserTrace(mauvais, { points: pts }, { toleranceFusionM: 2.5 })).rejects.toThrow(/base indisponible/);
  });
});
