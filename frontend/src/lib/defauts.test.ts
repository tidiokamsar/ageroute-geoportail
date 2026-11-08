import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { corpsResoumission, TRANSITIONS_ETAT, transitionsEtat } from "./defauts";

/**
 * Règles des défauts côté écran : ce que ces tests défendent.
 *   - la table des transitions d'état est EXACTEMENT celle du serveur (relue dans son fichier) ;
 *   - une resoumission n'envoie que les mesures saisies, refuse zéro et le vide d'une mesure requise ;
 *   - la gravité est bornée par le type.
 */
const vide = { nombre: "", longueurM: "", largeurM: "", profondeurM: "", quantiteSaisie: "" };

describe("transitions d'état", () => {
  it("sont celles du serveur", () => {
    const src = readFileSync(join(__dirname, "..", "..", "..", "backend", "src", "field", "defauts.regles.ts"), "utf8");
    const debut = src.indexOf("TRANSITIONS_ETAT:");
    const bloc = src.slice(debut, src.indexOf("};", debut));
    const serveur: Record<string, string[]> = {};
    for (const m of bloc.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) serveur[m[1]] = [...m[2].matchAll(/"(\w+)"/g)].map((x) => x[1]);
    expect(Object.keys(serveur)).toHaveLength(3);
    expect(Object.fromEntries(Object.entries(TRANSITIONS_ETAT).map(([k, v]) => [k, [...v]]))).toEqual(serveur);
  });
  it("un état inconnu ne propose rien", () => {
    expect(transitionsEtat(null)).toEqual([]);
    expect(transitionsEtat("X")).toEqual([]);
  });
});

describe("corpsResoumission", () => {
  it("n'envoie que les mesures saisies, virgule décimale acceptée", () => {
    const r = corpsResoumission({ mesures: { ...vide, longueurM: "2,5" }, gravite: "2", etendue: "LOCALISE", commentaire: " repris " }, ["LONGUEUR"], 4);
    expect(r).toEqual({ corps: { mesures: { longueurM: 2.5 }, gravite: 2, etendue: "LOCALISE", commentaire: "repris" }, erreurs: [] });
  });
  it("refuse zéro, un nombre non entier et le vide d'une mesure requise", () => {
    const r = corpsResoumission({ mesures: { ...vide, nombre: "1.5", largeurM: "0" }, gravite: "", etendue: "", commentaire: "" }, ["PROFONDEUR"], 4);
    expect(r.erreurs).toEqual([expect.stringMatching(/^Nombre/), expect.stringMatching(/^Largeur/), expect.stringMatching(/^Profondeur.*requise/)]);
  });
  it("borne la gravité au maximum du type", () => {
    expect(corpsResoumission({ mesures: vide, gravite: "5", etendue: "", commentaire: "" }, [], 4).erreurs[0]).toMatch(/Gravité/);
    expect(corpsResoumission({ mesures: vide, gravite: "5", etendue: "", commentaire: "" }, [], null).erreurs).toEqual([]);
  });
});
