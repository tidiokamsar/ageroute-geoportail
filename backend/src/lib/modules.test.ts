import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MODULE_KEYS } from "./modules";

/**
 * Les cles de module du backend et du frontend doivent rester les memes : une cle connue d'un seul cote
 * donne soit un menu qui mene a un 403, soit une route que l'interface ne sait pas proposer. Aucun test ne
 * le verifiait ; ce test lit le fichier du frontend (texte) et compare les listes, sans importer de code
 * du frontend.
 */
describe("Cles de module : backend et frontend", () => {
  const chemin = join(__dirname, "../../../frontend/src/lib/modules.ts");
  const cles = [...readFileSync(chemin, "utf8").matchAll(/\{\s*key:\s*"([a-z-]+)"\s*,\s*label:/g)].map((m) => m[1]);

  it("trouve les cles du frontend (garde contre une lecture qui ne reconnait plus rien)", () => {
    expect(cles.length).toBeGreaterThan(10);
  });

  it("ont exactement les memes cles, dans le meme ensemble", () => {
    expect([...cles].sort()).toEqual([...MODULE_KEYS].sort());
  });

  it("porte la cle `teledetection` des deux cotes", () => {
    expect(MODULE_KEYS).toContain("teledetection");
    expect(cles).toContain("teledetection");
  });
});
