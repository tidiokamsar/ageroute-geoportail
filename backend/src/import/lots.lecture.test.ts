import { describe, expect, it } from "vitest";
import { construireFiltres, echapperLike } from "./lots.lecture";

/** La construction des filtres de la liste : pure, donc eprouvee ici ; le SQL reel l'est par imports-api.integration.mts. */
describe("echapperLike", () => {
  it("neutralise les jokers de LIKE et l'echappement lui-meme", () => {
    expect(echapperLike("100%")).toBe("100\\%");
    expect(echapperLike("a_b")).toBe("a\\_b");
    expect(echapperLike("c:\\x")).toBe("c:\\\\x");
    expect(echapperLike("rien")).toBe("rien");
  });
});

describe("construireFiltres", () => {
  it("sans filtre, aucune condition", () => {
    expect(construireFiltres({})).toEqual([]);
  });

  it("chaque filtre ajoute SA condition : statut, source insensible a la casse, q sur trois champs echappes, du, au exclusif", () => {
    const du = new Date("2026-10-01T00:00:00Z"), au = new Date("2026-10-26T00:00:00Z");
    const f = construireFiltres({ statut: "REJETE", source: "ONR_BDR", q: "100%_", du, auExclusif: au });
    expect(f).toEqual([
      { statut: "REJETE" },
      { systemeSource: { equals: "ONR_BDR", mode: "insensitive" } },
      { OR: [
        { reference: { contains: "100\\%\\_", mode: "insensitive" } },
        { nomFichier: { contains: "100\\%\\_", mode: "insensitive" } },
        { systemeSource: { contains: "100\\%\\_", mode: "insensitive" } },
      ] },
      { importeLe: { gte: du } },
      { importeLe: { lt: au } },
    ]);
  });
});
