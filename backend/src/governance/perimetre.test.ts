import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOMAINES_TERRITORIAUX, perimetreEnVigueur, verdictTerritorial, type Perimetre } from "./perimetre";
import { DOMAINES_VALIDATION } from "./delegation";

/**
 * Perimetre territorial (A10) : ce que ces tests defendent.
 *   - sans perimetre en vigueur, un compte ecrit partout (regle provisoire, D-11) ;
 *   - avec un perimetre, il n'ecrit que dans ses regions, et jamais sur un objet de region inconnue ;
 *   - une ecriture qui touche deux regions exige les deux ;
 *   - un perimetre revoque, echu ou futur ne compte pas ;
 *   - les huit domaines sont ceux des delegations.
 */

const maintenant = new Date("2026-10-22T12:00:00Z");
const p = (regionId: number, o: Partial<Perimetre> = {}): Perimetre => ({ regionId, debutLe: new Date("2026-10-01"), finLe: null, revoqueLe: null, ...o });

describe("Le noyau ne depend de rien", () => {
  it("n'a aucun import", () => {
    const src = readFileSync(join(__dirname, "perimetre.ts"), "utf8");
    expect([...src.matchAll(/^import .*?from\s+["']/gm)]).toHaveLength(0);
  });
  it("couvre les huit domaines des delegations, ni plus ni moins", () => {
    expect([...DOMAINES_TERRITORIAUX].sort()).toEqual([...DOMAINES_VALIDATION].sort());
    expect(DOMAINES_TERRITORIAUX).toHaveLength(8);
  });
});

describe("perimetreEnVigueur", () => {
  it.each([
    [p(1), true],
    [p(1, { revoqueLe: new Date("2026-10-20") }), false],
    [p(1, { revoqueLe: new Date("2026-11-01") }), true],
    [p(1, { debutLe: new Date("2026-11-01") }), false],
    [p(1, { finLe: new Date("2026-10-21") }), false],
    [p(1, { finLe: new Date("2026-12-31") }), true],
  ])("%j -> %s", (x, attendu) => {
    expect(perimetreEnVigueur(x, maintenant)).toBe(attendu);
  });
});

describe("verdictTerritorial", () => {
  it("sans perimetre en vigueur : national, meme sur un objet de region inconnue", () => {
    expect(verdictTerritorial([], [null], maintenant)).toEqual({ permis: true, national: true });
    expect(verdictTerritorial([p(1, { revoqueLe: new Date("2026-10-02") })], [7], maintenant)).toEqual({ permis: true, national: true });
  });
  it("dans le perimetre : permis", () => {
    expect(verdictTerritorial([p(1), p(3)], [3], maintenant)).toEqual({ permis: true, national: false });
    expect(verdictTerritorial([p(1), p(3)], [1, 3], maintenant)).toEqual({ permis: true, national: false });
  });
  it("hors perimetre : refuse, en disant les regions autorisees", () => {
    expect(verdictTerritorial([p(3), p(1)], [2], maintenant)).toEqual({ permis: false, motif: "HORS_PERIMETRE", regionsAutorisees: [1, 3] });
  });
  it("deplacement d'une region a une autre : les deux sont exigees", () => {
    expect(verdictTerritorial([p(1)], [1, 2], maintenant)).toMatchObject({ permis: false, motif: "HORS_PERIMETRE" });
  });
  it("region inconnue, ou aucune region connue : refuse", () => {
    expect(verdictTerritorial([p(1)], [null], maintenant)).toMatchObject({ permis: false, motif: "REGION_INCONNUE" });
    expect(verdictTerritorial([p(1)], [1, null], maintenant)).toMatchObject({ permis: false, motif: "REGION_INCONNUE" });
    expect(verdictTerritorial([p(1)], [], maintenant)).toMatchObject({ permis: false, motif: "REGION_INCONNUE" });
  });
});
