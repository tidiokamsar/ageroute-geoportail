import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Garde de purete des fichiers de session qui doivent rester testables sans navigateur et rejouables a
 * volonte : le noyau (transitions et temps), la politique de deconnexion et le nommage par compte.
 * Meme principe que `src/roulage/noyau.garde.test.ts` : le test lit les SOURCES et echoue si le DOM, le
 * stockage, le reseau, une minuterie ou l'horloge globale y apparaissent.
 *
 * `coffreSession.ts` n'est pas dans cette liste : il parle a WebCrypto et a IndexedDB par construction. On
 * verifie seulement qu'il ne lit jamais l'horloge globale (le temps lui est passe en argument) et qu'il
 * n'importe que le noyau.
 */
const DOSSIER = __dirname;
const PURS = ["noyauSession.ts", "politiqueDeconnexion.ts", "compteLocal.ts"];

const retirerCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const lire = (f: string) => retirerCommentaires(readFileSync(join(DOSSIER, f), "utf8"));
const importsDe = (code: string) => [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);

describe("fichiers purs de la session locale", () => {
  const interdits = /\b(document|window|localStorage|sessionStorage|indexedDB|navigator|fetch|XMLHttpRequest|axios|setTimeout|setInterval|crypto|Math\.random|performance)\b|Date\.now\(|new Date\(/;

  for (const f of PURS) {
    const code = lire(f);

    it(`${f} n'importe que des fichiers voisins`, () => {
      expect(importsDe(code).filter((i) => !i.startsWith("./"))).toEqual([]);
    });

    it(`${f} n'utilise ni DOM, ni stockage, ni reseau, ni minuterie, ni horloge, ni hasard, ni WebCrypto`, () => {
      expect(code.match(interdits)).toBeNull();
    });
  }

  it("le noyau n'importe rien du tout", () => {
    expect(importsDe(lire("noyauSession.ts"))).toEqual([]);
  });

  it("la politique de deconnexion n'importe rien du tout", () => {
    expect(importsDe(lire("politiqueDeconnexion.ts"))).toEqual([]);
  });
});

describe("coffreSession.ts", () => {
  const code = lire("coffreSession.ts");

  it("ne lit jamais l'horloge civile : le temps arrive en argument", () => {
    expect(code.match(/Date\.now\(|new Date\(/)).toBeNull();
  });

  it("n'importe que le noyau et le type du port SHA-256", () => {
    expect(importsDe(code).sort()).toEqual(["./compteLocal", "./noyauSession"]);
  });

  it("n'appelle jamais la console (le PIN et la cle ne doivent pas pouvoir fuir dans un journal)", () => {
    expect(code.match(/\bconsole\b/)).toBeNull();
  });

  it("n'ecrit jamais dans localStorage ni sessionStorage, et ne parle pas du reseau", () => {
    expect(code.match(/\b(localStorage|sessionStorage|fetch|XMLHttpRequest|axios)\b/)).toBeNull();
  });
});
