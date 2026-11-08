import { describe, expect, it } from "vitest";
import { calculerDelta } from "./delta.noyau";

describe("calculerDelta", () => {
  it("compte ajoutes, retires et identiques par empreinte", () => {
    expect(calculerDelta(["a", "b", "c"], new Map([["a", 1], ["b", 1], ["d", 1]]))).toEqual({ ajoutes: 1, retires: 1, identiques: 2 });
  });
  it("deux versions identiques : rien n'est ajoute ni retire", () => {
    expect(calculerDelta(["a", "b"], new Map([["a", 1], ["b", 1]]))).toEqual({ ajoutes: 0, retires: 0, identiques: 2 });
  });
  it("traite les doublons comme un multi-ensemble", () => {
    expect(calculerDelta(["a", "a", "a"], new Map([["a", 2]]))).toEqual({ ajoutes: 1, retires: 0, identiques: 2 });
    expect(calculerDelta(["a"], new Map([["a", 3]]))).toEqual({ ajoutes: 0, retires: 2, identiques: 1 });
  });
  it("une version vide retire tout, un ancien jeu vide ajoute tout", () => {
    expect(calculerDelta([], new Map([["a", 1]]))).toEqual({ ajoutes: 0, retires: 1, identiques: 0 });
    expect(calculerDelta(["a", "b"], new Map())).toEqual({ ajoutes: 2, retires: 0, identiques: 0 });
  });
});
