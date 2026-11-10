import { describe, expect, it } from "vitest";
import { CadenceParCompte } from "./limiteurs";

/** Correctifs T1+S1, m1 : cadence par compte de GET /territoires/comptes (fenetre glissante, jamais une file). */
describe("cadence par compte", () => {
  it("admet `max` appels par fenetre et par compte, puis donne le delai a attendre ; les autres comptes ne sont pas touches", () => {
    const c = new CadenceParCompte(() => 2, 60_000);
    const t0 = 1_000_000;
    expect(c.admettre("a", t0)).toBeNull();
    expect(c.admettre("a", t0 + 1_000)).toBeNull();
    expect(c.admettre("a", t0 + 2_000)).toBe(58);
    expect(c.admettre("b", t0 + 2_000)).toBeNull();
    expect(c.admettre("a", t0 + 60_001)).toBeNull();
  });
});
