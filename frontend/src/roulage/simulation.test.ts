import { describe, expect, it } from "vitest";
import { demarrerBanc, T0 } from "./aide-test";
import { construirePayload } from "./contrat";
import { distanceM } from "./geodesie";
import { abscissesChemin, positionSurChemin, prng, simuler } from "./simulation";

/**
 * RESULTATS DE SIMULATION. Le bruit est blanc et gaussien : ce n'est pas la loi d'erreur d'un recepteur
 * reel. Ces tests prouvent que le noyau tient une session de deux heures a 1 Hz (volume, ordre, absence
 * de doublon, determinisme), pas que le GNSS d'un telephone se comporte ainsi.
 */

const chemin = [
  { lat: 9.64, lon: -13.6 },
  { lat: 9.64, lon: -13.4 },
  { lat: 9.7, lon: -13.3 },
];

describe("simulation deterministe", () => {
  it("meme graine, memes echantillons ; graine differente, echantillons differents", () => {
    const p = { chemin, departMs: T0, dureeS: 60, vitesseKmH: () => 50, graine: 7, sigmaM: 4, precisionAnnonceeM: 8 };
    expect(simuler(p).echantillons).toEqual(simuler(p).echantillons);
    expect(simuler({ ...p, graine: 8 }).echantillons).not.toEqual(simuler(p).echantillons);
  });

  it("le PRNG est uniforme sur [0, 1[ et reproductible", () => {
    const a = prng(42);
    const b = prng(42);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it("le vehicule suit le chemin a la vitesse demandee et s'arrete en bout de chemin", () => {
    const cumul = abscissesChemin(chemin);
    const t = simuler({ chemin, departMs: T0, dureeS: 100_000, vitesseKmH: () => 36, graine: 1, sigmaM: 0, precisionAnnonceeM: 5 });
    expect(t.verite[10].sM).toBeCloseTo(100, 6);
    expect(t.verite.at(-1)!.sM).toBeCloseTo(cumul.at(-1)!, 6);
    const pos = positionSurChemin(chemin, cumul, 100);
    expect(distanceM(pos, t.verite[10])).toBeLessThan(1e-6);
    expect(t.verite.at(-1)!.vitesseMs).toBe(0);
  });

  it("l'ecart-type du bruit simule est celui demande (4 m par axe, a 15 % pres)", () => {
    const t = simuler({ chemin, departMs: T0, dureeS: 5000, vitesseKmH: () => 30, graine: 3, sigmaM: 4, precisionAnnonceeM: 8 });
    const ecarts = t.echantillons.map((e, i) => distanceM(e, t.verite[i]));
    const rms = Math.sqrt(ecarts.reduce((s, x) => s + x * x, 0) / ecarts.length);
    // Distance radiale d'un bruit 2D de sigma par axe : RMS = sigma * sqrt(2).
    expect(rms).toBeGreaterThan(4 * Math.SQRT2 * 0.85);
    expect(rms).toBeLessThan(4 * Math.SQRT2 * 1.15);
  });
});

describe("session de 2 h a 1 Hz dans le noyau (SIMULATION)", () => {
  it("7 200 echantillons : tous retenus, ordonnes, sans doublon, charge de moins de 1 Mo, deterministe", () => {
    const fabriquer = () => {
      const t = simuler({ chemin, departMs: T0, dureeS: 7199, vitesseKmH: (s) => 20 + 30 * Math.abs(Math.sin(s / 600)), graine: 11, sigmaM: 4, precisionAnnonceeM: 8 });
      const b = demarrerBanc();
      for (const e of t.echantillons) {
        b.horloge.fixer(e.tMs);
        expect(b.session.ajouterEchantillon(e).accepte).toBe(true);
      }
      b.session.arreter();
      const r = construirePayload(b.session.etat);
      if (!r.ok) throw new Error("payload");
      return { b, payload: r.payload };
    };
    const un = fabriquer();
    const deux = fabriquer();
    expect(un.payload.points).toHaveLength(7200);
    expect(un.b.session.resume()).toMatchObject({ echantillons: 7200, rejetsTotal: 0, trous: 0, segments: 1 });
    const temps = un.payload.points.map((x) => x[0]);
    expect(new Set(temps).size).toBe(7200);
    expect(temps.every((t, i) => i === 0 || t > temps[i - 1])).toBe(true);
    expect(JSON.stringify(un.payload).length).toBeLessThan(1_000_000);
    expect(JSON.stringify(un.payload.points)).toBe(JSON.stringify(deux.payload.points));
  });
});
