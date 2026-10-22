import { describe, expect, it } from "vitest";
import { percentile, resumer } from "./stats";

describe("percentile par rang le plus proche", () => {
  const cent = Array.from({ length: 100 }, (_, i) => i + 1);
  it("p50, p95, p99 de 1..100 valent 50, 95, 99", () => {
    expect(percentile(cent, 50)).toBe(50);
    expect(percentile(cent, 95)).toBe(95);
    expect(percentile(cent, 99)).toBe(99);
  });
  it("rend une valeur observee, jamais une interpolation", () => {
    expect(percentile([10, 20, 30], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
  });
  it("une seule mesure : tous les percentiles valent cette mesure", () => {
    expect(percentile([7], 99)).toBe(7);
  });
  it("resumer ne depend pas de l'ordre d'entree", () => {
    const r = resumer([30, 10, 20]);
    expect(r).toMatchObject({ n: 3, minMs: 10, p50Ms: 20, maxMs: 30, moyenneMs: 20 });
  });
});
