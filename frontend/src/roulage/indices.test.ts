import { describe, expect, it } from "vitest";
import { indiceIrregularite } from "./indices";

const ech = (tMs: number, zMs2: number) => ({ tMs, zMs2 });

describe("indiceIrregularite (phase 3 SMART FIELD)", () => {
  it("un appareil sans accéléromètre reçoit un résultat expliqué, jamais une erreur", () => {
    const r = indiceIrregularite([]);
    expect(r.capteurAbsent).toBe(true);
    expect(r.fenetres).toHaveLength(0);
    expect(r.avertissement).toContain("la collecte manuelle reste complète");
  });

  it("compte les pics au-dessus du seuil par fenêtres de 30 s, indice borné à 100", () => {
    const echantillons: ReturnType<typeof ech>[] = [];
    // Fenêtre 1 : 0-25 s, un pic à 1 s.
    echantillons.push(ech(0, 0.5), ech(1000, 15), ech(25_000, 0.3));
    // Fenêtre 2 : 30-55 s, douze pics -> indice saturé à 100.
    for (let i = 0; i < 12; i++) echantillons.push(ech(30_000 + i * 1000, i % 2 ? 14 : -13));
    echantillons.push(ech(56_000, 0.2));

    const r = indiceIrregularite(echantillons);
    expect(r.version).toBe("indice-irregularite-1");
    expect(r.totalPics).toBe(13);
    expect(r.fenetres[0]).toMatchObject({ pics: 1, indice: 10 });
    expect(r.fenetres[1].indice).toBe(100);
  });

  it("la version voyage avec le résultat : un indice sans sa version ne se rejoue pas", () => {
    const r = indiceIrregularite([ech(0, 20)], { seuilMs2: 10 });
    expect(r.seuilMs2).toBe(10);
    expect(r.avertissement).toContain("EXPÉRIMENTAL");
  });
});
