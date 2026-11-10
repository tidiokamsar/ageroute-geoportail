import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Correctifs T1+S1, M1 : la comparaison entre sources calcule dans le CRS metrique du projet, choisi comme pour l'analyse 2D, les conflits et
 * les associations (`contexteSpatialDuProjet`) ; aucun CRS ni aucune regle de bandes codes en dur dans le lot S1. Test STATIQUE : il lit le code
 * (le banc sources-comparaison prouve le CRS impose par un territoire contre PostGIS).
 */
const DOSSIER = __dirname;
const FICHIERS = ["comparaison.service.ts", "comparaison.depot.ts", "classification-sources.noyau.ts", "regle-rapprochement.noyau.ts", "sources.service.ts"];
const sansCommentaires = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("M1 : aucun CRS code en dur dans la comparaison entre sources", () => {
  it("ni code EPSG UTM litteral, ni epsgPourLongitude (constante du socle)", () => {
    for (const f of FICHIERS) {
      const code = sansCommentaires(readFileSync(join(DOSSIER, f), "utf8"));
      expect(code, f).not.toMatch(/\b326\d\d\b|\b327\d\d\b/);
      expect(code, f).not.toMatch(/epsgPourLongitude\b/);
    }
  });
  it("le service lit le contexte spatial du projet et persiste le CRS retenu avec son origine", () => {
    const code = sansCommentaires(readFileSync(join(DOSSIER, "comparaison.service.ts"), "utf8"));
    expect(code).toMatch(/contexteSpatialDuProjet\(projetId\)/);
    expect(code).toMatch(/spatial\.epsgPour\(/);
    expect(code).toMatch(/source: spatial\.crsImpose !== null \? "TERRITOIRE"/);
  });
});
