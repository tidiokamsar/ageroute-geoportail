import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Le noyau de roulage doit tourner a l'identique dans la PWA, dans une coque Capacitor et sous Node :
 * il ne doit donc toucher ni le DOM, ni le stockage, ni le reseau, ni l'horloge globale. Ce test lit les
 * sources et echoue si l'une de ces dependances y apparait.
 */
const DOSSIER = __dirname;
const sources = readdirSync(DOSSIER).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "aide-test.ts");

const retirerCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("noyau pur", () => {
  it("le dossier n'est pas vide", () => {
    expect(sources.length).toBeGreaterThanOrEqual(10);
  });

  for (const f of sources) {
    const code = retirerCommentaires(readFileSync(join(DOSSIER, f), "utf8"));

    it(`${f} n'importe que des fichiers du noyau`, () => {
      const imports = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
      expect(imports.filter((i) => !i.startsWith("./"))).toEqual([]);
    });

    it(`${f} n'utilise ni DOM, ni stockage, ni reseau, ni horloge globale`, () => {
      const interdits = /\b(document|window|localStorage|sessionStorage|indexedDB|navigator|fetch|XMLHttpRequest|axios|setTimeout|setInterval|Math\.random)\b|Date\.now\(|new Date\(\)/;
      // `horloge.ts` est le SEUL fichier autorise a lire l'horloge reelle (`horlogeSysteme`), derriere l'interface injectee.
      const autorise = f === "horloge.ts" ? /Date\.now\(|performance/ : null;
      const texte = autorise ? code.replace(/Date\.now\(\)/g, "").replace(/performance\.now\(\)/g, "") : code;
      expect(texte.match(interdits)).toBeNull();
    });
  }

  it("seul simulation.ts a le droit d'utiliser un generateur pseudo-aleatoire, et il est deterministe", () => {
    const code = retirerCommentaires(readFileSync(join(DOSSIER, "simulation.ts"), "utf8"));
    expect(code).not.toMatch(/Math\.random/);
  });
});
