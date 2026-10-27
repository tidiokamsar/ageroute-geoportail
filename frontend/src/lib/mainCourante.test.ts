import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleOperation, duree, transitionsDepuis, TRANSITIONS } from "./mainCourante";

/**
 * Règles de la main courante côté écran : ce que ces tests défendent.
 *   - la table des transitions est EXACTEMENT celle du serveur (relue dans son fichier) ;
 *   - un événement clos ne propose aucun geste ;
 *   - une durée inconnue s'affiche « — », jamais « 0 » ;
 *   - deux envois ont deux clés d'idempotence distinctes.
 */
describe("transitions", () => {
  it("sont celles du noyau serveur", () => {
    const src = readFileSync(join(__dirname, "..", "..", "..", "backend", "src", "exploitation", "main-courante.noyau.ts"), "utf8");
    const bloc = src.slice(src.indexOf("TRANSITIONS_STATUT"), src.indexOf("};", src.indexOf("TRANSITIONS_STATUT")));
    const serveur: Record<string, string[]> = {};
    for (const m of bloc.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) serveur[m[1]] = [...m[2].matchAll(/"(\w+)"/g)].map((x) => x[1]);
    expect(Object.keys(serveur)).toHaveLength(4);
    expect(Object.fromEntries(Object.entries(TRANSITIONS).map(([k, v]) => [k, [...v]]))).toEqual(serveur);
  });
  it("un événement clos ou inconnu ne propose rien", () => {
    expect(transitionsDepuis("CLOS")).toEqual([]);
    expect(transitionsDepuis(null)).toEqual([]);
    expect(transitionsDepuis("OUVERT")).toEqual(["PRIS_EN_COMPTE", "CLOS"]);
  });
});

describe("duree", () => {
  it.each([
    [null, "—"], [undefined, "—"], [Number.NaN, "—"],
    [12, "12 s"], [59.6, "1 min"], [125, "2 min"], [3600 + 5 * 60, "1 h 05"], [3 * 86400 + 4 * 3600, "3 j 4 h"],
  ])("%s -> %s", (s, attendu) => {
    expect(duree(s as number | null | undefined)).toBe(attendu);
  });
});

describe("cleOperation", () => {
  it("rend deux clés distinctes d'au moins 8 caractères (contrainte du serveur)", () => {
    const a = cleOperation(), b = cleOperation();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(8);
  });
});
