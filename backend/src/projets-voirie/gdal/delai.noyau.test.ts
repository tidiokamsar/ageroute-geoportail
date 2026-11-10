import { describe, expect, it } from "vitest";
import { BudgetTour, ErreurDelai, avecDelai } from "./delai.noyau";

/** Garde de delai du sondage (lot V2, M1) : un acces au spool qui ne repond jamais ne bloque pas le tour. */

describe("avecDelai", () => {
  it("rend la valeur d'une promesse qui se resout a temps", async () => {
    expect(await avecDelai(Promise.resolve(42), 1000, "lecture")).toBe(42);
  });

  it("rejette ErreurDelai pour une promesse qui ne se resout JAMAIS (descripteur bloquant simule), sans chemin dans le message", async () => {
    const jamais = new Promise<string>(() => { /* un open() sur un tube nomme sans ecrivain : ne revient pas */ });
    const debut = Date.now();
    await expect(avecDelai(jamais, 30, "lecture du statut")).rejects.toBeInstanceOf(ErreurDelai);
    expect(Date.now() - debut).toBeLessThan(2000);
    try { await avecDelai(jamais, 10, "lecture du statut"); } catch (e) {
      expect(e).toMatchObject({ code: "DELAI_SONDAGE_DEPASSE", contexte: "lecture du statut", ms: 10 });
      expect(String((e as Error).message)).not.toMatch(/[\\/]/);
    }
  });

  it("propage le rejet d'origine quand la promesse echoue avant le delai", async () => {
    await expect(avecDelai(Promise.reject(new Error("panne")), 1000, "x")).rejects.toThrow("panne");
  });

  it("un budget nul ou negatif rejette tout de suite (tour epuise)", async () => {
    await expect(avecDelai(Promise.resolve(1), 0, "x")).rejects.toBeInstanceOf(ErreurDelai);
    await expect(avecDelai(Promise.resolve(1), -5, "x")).rejects.toBeInstanceOf(ErreurDelai);
  });
});

describe("BudgetTour", () => {
  it("un acces court est borne par le plafond par operation ET par ce qui reste du tour ; un acces long par le reste du tour", () => {
    const b = BudgetTour.depuis(1_000, 60_000, 10_000);
    expect(b.court(1_000)).toBe(10_000);
    expect(b.long(1_000)).toBe(60_000);
    expect(b.court(55_000)).toBe(6_000);
    expect(b.long(55_000)).toBe(6_000);
    expect(b.court(70_000)).toBe(0);
    expect(b.epuise(60_999)).toBe(false);
    expect(b.epuise(61_000)).toBe(true);
  });
});
