import { describe, expect, it } from "vitest";
import { dureeEnMs, JETON_ACCES_REPLI_MS } from "./duree";

describe("dureeEnMs", () => {
  it("lit les formes que le depot emet : secondes, minutes, heures, jours", () => {
    expect(dureeEnMs("30s", 1)).toBe(30_000);
    expect(dureeEnMs("15m", 1)).toBe(900_000);
    expect(dureeEnMs("2h", 1)).toBe(7_200_000);
    expect(dureeEnMs("7d", 1)).toBe(604_800_000);
    expect(dureeEnMs(" 5 m ", 1)).toBe(300_000);
  });

  it("une valeur illisible, vide ou nulle rend le repli, jamais zero (la fenetre de refus ne tombe pas a zero en silence)", () => {
    for (const v of [undefined, "", "abc", "15", "1.5h", "15 minutes", "-5m", "0m", "0s"]) {
      expect(dureeEnMs(v, 42)).toBe(42);
    }
  });

  it("le repli du jeton d'acces est la valeur par defaut de l'environnement : 15 minutes", () => {
    expect(JETON_ACCES_REPLI_MS).toBe(15 * 60_000);
  });
});
