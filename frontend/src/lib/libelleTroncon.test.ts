import { describe, expect, it } from "vitest";
import { libelleTroncon } from "./libelleTroncon";

/** Un libelle ne repete jamais le code : « RES-142 — RES-142 » devient « RES-142 ». */
describe("libelleTroncon", () => {
  it("donne « CODE — Nom » quand le nom apporte une information", () => {
    expect(libelleTroncon("RN1-03", "Kindia - Mamou")).toBe("RN1-03 — Kindia - Mamou");
  });

  it("ne repete pas un nom identique au code", () => {
    expect(libelleTroncon("RES-142", "RES-142")).toBe("RES-142");
  });

  it("ignore casse, accents, espaces et ponctuation pour decider que c'est une recopie", () => {
    expect(libelleTroncon("RES-142", "res 142")).toBe("RES-142");
    expect(libelleTroncon("GN N0001", "gn-n0001")).toBe("GN N0001");
    expect(libelleTroncon("Épée-1", "EPEE 1")).toBe("Épée-1");
  });

  it("un nom absent, vide ou blanc donne le code seul", () => {
    expect(libelleTroncon("RN4", null)).toBe("RN4");
    expect(libelleTroncon("RN4", undefined)).toBe("RN4");
    expect(libelleTroncon("RN4", "   ")).toBe("RN4");
  });

  it("un nom qui contient le code sans s'y reduire reste affiche", () => {
    expect(libelleTroncon("RN4", "RN4 Kankan - Kérouané")).toBe("RN4 — RN4 Kankan - Kérouané");
  });

  it("retire les blancs autour du code", () => {
    expect(libelleTroncon("  RN4 ", "Kankan")).toBe("RN4 — Kankan");
  });
});
