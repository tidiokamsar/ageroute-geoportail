import { describe, expect, it } from "vitest";
import { parseListQuery } from "./list-query";

function reqWith(query: Record<string, string>) {
  return { query } as never;
}

describe("parseListQuery — colonne de tri contrôlée (P2-02)", () => {
  it("accepte un identifiant simple", () => {
    expect(parseListQuery(reqWith({ sortBy: "createdAt" })).sortBy).toBe("createdAt");
    expect(parseListQuery(reqWith({ sortBy: "longueurKm" })).sortBy).toBe("longueurKm");
  });

  it("accepte l'absence de tri", () => {
    expect(parseListQuery(reqWith({})).sortBy).toBeUndefined();
  });

  it("rejette les tentatives d'injection et les caractères non identifiant", () => {
    for (const mauvais of ["a; DROP TABLE troncons", "a b", "a-b", "(select)", "a.b", "1abc", ""]) {
      expect(() => parseListQuery(reqWith({ sortBy: mauvais }))).toThrow();
    }
  });

  it("rejette un identifiant trop long (65+)", () => {
    expect(() => parseListQuery(reqWith({ sortBy: "a".repeat(65) }))).toThrow();
  });
});
