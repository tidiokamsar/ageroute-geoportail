import { describe, expect, it } from "vitest";
import {
  bornesPortion, FENETRE_RATTACHEMENT_MS, planifierEvenement, positionAuTemps, tronconAuTemps,
  type PointRattache, type PositionTrace,
} from "./rattachement.noyau";

const T0 = 1_790_000_000_000;
const pt = (s: number, tronconId: string | null, abscisseM: number | null, segment = 0): PointRattache => ({ tMs: T0 + s * 1000, segment, tronconId, abscisseM });

/** A de 0 a 200 m (points 0..20 s, 10 m/s), puis B de 0 a 100 m (points 21..30 s). */
function deuxTroncons(): PointRattache[] {
  const out: PointRattache[] = [];
  for (let s = 0; s <= 20; s += 1) out.push(pt(s, "A", s * 10));
  for (let s = 21; s <= 30; s += 1) out.push(pt(s, "B", (s - 21) * 10));
  return out;
}

describe("tronconAuTemps", () => {
  it("rend le troncon du point le plus proche dans le temps, et l'ecart", () => {
    const r = tronconAuTemps(T0 + 20_400, deuxTroncons());
    expect(r).toMatchObject({ tronconId: "A", ecartMs: 400 });
    expect(tronconAuTemps(T0 + 20_700, deuxTroncons())).toMatchObject({ tronconId: "B", ecartMs: 300 });
  });

  it("rien au-dela de la fenetre : on ne conclut pas", () => {
    expect(tronconAuTemps(T0 + 100_000, deuxTroncons())).toBeNull();
    expect(tronconAuTemps(T0 - 100_000, deuxTroncons())).toBeNull();
    expect(tronconAuTemps(T0, [])).toBeNull();
    expect(FENETRE_RATTACHEMENT_MS).toBe(10_000);
  });

  it("un point non rattache par le HMM (hors referentiel) n'est JAMAIS prete a un troncon voisin plus lointain", () => {
    const pts = [pt(0, "A", 0), pt(1, "A", 10), pt(2, null, null), pt(3, null, null), pt(4, "B", 0)];
    // A l'instant 2,4 s, les points encadrants sont (2, null) et (3, null) : hors reseau.
    expect(tronconAuTemps(T0 + 2400, pts)).toBeNull();
    // A 3,6 s : encadrants (3, null) et (4, B), B est le plus proche.
    expect(tronconAuTemps(T0 + 3600, pts)).toMatchObject({ tronconId: "B" });
  });
});

describe("positionAuTemps", () => {
  const brut: PositionTrace[] = [
    { tMs: T0, lat: 9.0, lon: -13.0, segment: 0 },
    { tMs: T0 + 1000, lat: 9.001, lon: -13.0, segment: 0 },
    { tMs: T0 + 2000, lat: 9.002, lon: -13.0, segment: 0 },
    { tMs: T0 + 60_000, lat: 9.1, lon: -13.0, segment: 1 },
  ];
  it("interpole entre les deux echantillons du meme segment qui encadrent l'instant", () => {
    const p = positionAuTemps(T0 + 1500, brut)!;
    expect(p.methode).toBe("INTERPOLATION");
    expect(p.lat).toBeCloseTo(9.0015, 9);
  });
  it("instant exact : la position de l'echantillon", () => {
    expect(positionAuTemps(T0 + 2000, brut)).toMatchObject({ lat: 9.002, methode: "INTERPOLATION" });
  });
  it("jamais d'interpolation a travers deux segments : l'echantillon le plus proche s'il est dans la fenetre, sinon rien", () => {
    expect(positionAuTemps(T0 + 30_000, brut)).toBeNull();
    expect(positionAuTemps(T0 + 56_000, brut)).toMatchObject({ lat: 9.1, methode: "PLUS_PROCHE" });
  });
  it("jamais d'extrapolation hors de la trace", () => {
    expect(positionAuTemps(T0 - 20_000, brut)).toBeNull();
    expect(positionAuTemps(T0 + 200_000, brut)).toBeNull();
    expect(positionAuTemps(T0, [])).toBeNull();
  });
});

describe("planifierEvenement", () => {
  it("un evenement sur un seul troncon : un passage qui porte le debut ET la fin", () => {
    const r = planifierEvenement(T0 + 5000, T0 + 15_000, deuxTroncons());
    expect(r.refus).toBeNull();
    if (r.refus !== null) return;
    expect(r.passages).toHaveLength(1);
    expect(r.passages[0]).toMatchObject({ tronconId: "A", entreeM: 50, sortieM: 150, porteLeDebut: true, porteLaFin: true });
  });

  it("un evenement a cheval sur deux troncons : deux passages, bornes tirees des points rattaches", () => {
    const r = planifierEvenement(T0 + 10_000, T0 + 25_000, deuxTroncons());
    if (r.refus !== null) throw new Error("plan");
    expect(r.passages.map((p) => p.tronconId)).toEqual(["A", "B"]);
    expect(r.passages[0]).toMatchObject({ entreeM: 100, sortieM: 200, porteLeDebut: true, porteLaFin: false });
    expect(r.passages[1]).toMatchObject({ entreeM: 0, sortieM: 40, porteLeDebut: false, porteLaFin: true });
  });

  it("un passage parasite de deux points ou moins entre deux passages du MEME troncon est absorbe", () => {
    const pts: PointRattache[] = [];
    for (let s = 0; s <= 9; s += 1) pts.push(pt(s, "A", s * 10));
    pts.push(pt(10, "P", 5), pt(11, "P", 15));
    for (let s = 12; s <= 20; s += 1) pts.push(pt(s, "A", s * 10));
    const r = planifierEvenement(T0, T0 + 20_000, pts);
    if (r.refus !== null) throw new Error("plan");
    expect(r.passages).toHaveLength(1);
    expect(r.passages[0]).toMatchObject({ tronconId: "A", entreeM: 0, sortieM: 200 });
    expect(r.absorbes).toBe(1);
  });

  it("un vrai troncon intermediaire (plus de deux points) n'est PAS absorbe", () => {
    const pts: PointRattache[] = [];
    for (let s = 0; s <= 5; s += 1) pts.push(pt(s, "A", s * 10));
    for (let s = 6; s <= 10; s += 1) pts.push(pt(s, "P", (s - 6) * 10));
    for (let s = 11; s <= 16; s += 1) pts.push(pt(s, "A", s * 10));
    const r = planifierEvenement(T0, T0 + 16_000, pts);
    if (r.refus !== null) throw new Error("plan");
    expect(r.passages.map((p) => p.tronconId)).toEqual(["A", "P", "A"]);
  });

  it("sens decroissant : l'entree est superieure a la sortie, et les bornes sont ordonnees", () => {
    const pts = Array.from({ length: 11 }, (_, s) => pt(s, "A", 100 - s * 10));
    const r = planifierEvenement(T0 + 2000, T0 + 8000, pts);
    if (r.refus !== null) throw new Error("plan");
    expect(r.passages[0]).toMatchObject({ entreeM: 80, sortieM: 20 });
    expect(bornesPortion(80, 20)).toEqual({ debutM: 20, finM: 80, sens: "DECROISSANT" });
    expect(bornesPortion(20, 80)).toEqual({ debutM: 20, finM: 80, sens: "CROISSANT" });
  });

  it("debut ou fin hors du reseau (aucun point rattache a proximite) : refus nomme, aucune portion devinee", () => {
    const pts = [pt(0, "A", 0), pt(1, "A", 10), pt(2, "A", 20), pt(3, null, null), pt(4, null, null), pt(5, null, null)];
    expect(planifierEvenement(T0 + 3500, T0 + 4500, pts)).toEqual({ refus: "AUCUN_POINT_RATTACHE_AU_DEBUT" });
    expect(planifierEvenement(T0 + 1000, T0 + 4500, pts)).toEqual({ refus: "AUCUN_POINT_RATTACHE_A_LA_FIN" });
    expect(planifierEvenement(T0 + 1000, T0 + 1000, pts)).toEqual({ refus: "FIN_AVANT_DEBUT" });
    expect(planifierEvenement(T0 + 2000, T0 + 1000, pts)).toEqual({ refus: "FIN_AVANT_DEBUT" });
  });

  it("traverse un trou de rattachement a l'interieur de l'evenement sans le compter comme un troncon", () => {
    const pts: PointRattache[] = [];
    for (let s = 0; s <= 5; s += 1) pts.push(pt(s, "A", s * 10));
    pts.push(pt(6, null, null), pt(7, null, null));
    for (let s = 8; s <= 12; s += 1) pts.push(pt(s, "A", s * 10));
    const r = planifierEvenement(T0, T0 + 12_000, pts);
    if (r.refus !== null) throw new Error("plan");
    expect(r.passages).toHaveLength(1);
    expect(r.passages[0]).toMatchObject({ entreeM: 0, sortieM: 120 });
  });
});
