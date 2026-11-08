import { describe, expect, it } from "vitest";
import { evaluerCompletude } from "./completude";

/** Deux points à ~1,11 km de latitude (0,01°), même segment. */
const pt = (tMs: number, lat: number, lon = -13.6, segment = 1, precisionM = 5) => ({
  tMs, lat, lon, precisionM, segment,
});

describe("evaluerCompletude (phase 5 SMART FIELD)", () => {
  it("une trace continue, sans trou ni interruption : tout le temps utile a du signal", () => {
    const p = evaluerCompletude({
      echantillons: [pt(0, 9.64), pt(30_000, 9.65), pt(60_000, 9.66)],
      trous: [], interruptions: [], pauses: [],
      maintenantMs: 600_000, debutMs: 0, finMs: 60_000, precisionFiableM: 10,
    });
    expect(p.traceKm).toBeGreaterThan(2.2);
    expect(p.partTempsAvecSignal).toBe(1);
    expect(p.fiables).toBe(3);
    expect(p.segmentOuvert).toBe(false);
  });

  it("la part de temps avec signal ne depend PAS de la vitesse : un vehicule lent n'est pas « moins couvert »", () => {
    const lent = evaluerCompletude({
      echantillons: [pt(0, 9.64), pt(30_000, 9.6401), pt(60_000, 9.6402)],
      trous: [], interruptions: [], pauses: [],
      maintenantMs: 600_000, debutMs: 0, finMs: 60_000, precisionFiableM: 10,
    });
    expect(lent.partTempsAvecSignal).toBe(1);
  });

  it("un trou de 30 s sur 60 s : la moitie du temps seulement a du signal", () => {
    const p = evaluerCompletude({
      echantillons: [pt(0, 9.64), pt(60_000, 9.65)],
      trous: [{ debutMs: 10_000, finMs: 40_000, dureeMs: 30_000, coupeSegment: false }], interruptions: [], pauses: [],
      maintenantMs: 600_000, debutMs: 0, finMs: 60_000, precisionFiableM: 10,
    });
    expect(p.partTempsAvecSignal).toBe(0.5);
  });

  it("un trou et l'interruption qui l'a cause ne se comptent qu'une fois", () => {
    const p = evaluerCompletude({
      echantillons: [pt(0, 9.64), pt(60_000, 9.65)],
      trous: [{ debutMs: 10_000, finMs: 40_000, dureeMs: 30_000, coupeSegment: false }],
      interruptions: [{ debutMs: 10_000, finMs: 40_000, cause: "GNSS_PERDU" }], pauses: [],
      maintenantMs: 600_000, debutMs: 0, finMs: 60_000, precisionFiableM: 10,
    });
    expect(p.partTempsAvecSignal).toBe(0.5);
  });

  it("une pause n'est pas une perte : ni dans la duree utile, ni dans le temps sans signal", () => {
    const p = evaluerCompletude({
      echantillons: [pt(0, 9.64), pt(100_000, 9.65)],
      trous: [{ debutMs: 40_000, finMs: 60_000, dureeMs: 20_000, coupeSegment: false }], interruptions: [],
      pauses: [{ debutMs: 40_000, finMs: 60_000 }],
      maintenantMs: 600_000, debutMs: 0, finMs: 100_000, precisionFiableM: 10,
    });
    expect(p.dureeUtileMin).toBeCloseTo(80 / 60, 1);
    expect(p.partTempsAvecSignal).toBe(1);
  });

  it("un trou coupe la trace : les deux rives ne sont jamais reliées", () => {
    const p = evaluerCompletude({
      echantillons: [pt(0, 9.64, -13.6, 1), pt(60_000, 9.65, -13.6, 1), pt(600_000, 9.66, -13.6, 2)],
      trous: [{ debutMs: 61_000, finMs: 599_000, dureeMs: 538_000, coupeSegment: true }],
      interruptions: [], pauses: [],
      maintenantMs: 600_000, debutMs: 0, finMs: 600_000, precisionFiableM: 10,
    });
    // Sans le trou, la ligne 9.65 -> 9.66 ferait ~1,1 km de plus : elle n'est pas comptée.
    expect(p.traceKm).toBeLessThan(3.5);
    expect(p.trous).toBe(1);
    expect(p.segments).toBe(2);
  });

  it("une interruption ouverte est dite, et la durée s'arrête à la dernière donnée", () => {
    const p = evaluerCompletude({
      echantillons: [pt(0, 9.64), pt(30_000, 9.641)],
      trous: [], pauses: [],
      interruptions: [{ debutMs: 31_000, finMs: null, cause: "VEILLE" }],
      maintenantMs: 600_000, debutMs: 0, finMs: null, precisionFiableM: 10,
    });
    expect(p.segmentOuvert).toBe(true);
    expect(p.avertissements.some((a) => a.includes("trou de signal"))).toBe(true);
    expect(p.avertissements.some((a) => a.includes("pas un verdict d'inspection"))).toBe(true);
  });

  it("les positions hors précision de campagne sont comptées et dites", () => {
    const p = evaluerCompletude({
      echantillons: [pt(0, 9.64, -13.6, 1, 4), pt(30_000, 9.65, -13.6, 1, 250)],
      trous: [], interruptions: [], pauses: [],
      maintenantMs: 600_000, debutMs: 0, finMs: 30_000, precisionFiableM: 10,
    });
    expect(p.fiables).toBe(1);
    expect(p.avertissements.some((a) => a.includes("hors précision"))).toBe(true);
  });

  it("moins de deux positions : pas de trace exploitable", () => {
    const p = evaluerCompletude({
      echantillons: [pt(0, 9.64)],
      trous: [], interruptions: [], pauses: [],
      maintenantMs: 600_000, debutMs: 0, finMs: 5_000, precisionFiableM: 10,
    });
    expect(p.avertissements.some((a) => a.includes("pas de trace exploitable"))).toBe(true);
    expect(p.traceKm).toBe(0);
  });
});
