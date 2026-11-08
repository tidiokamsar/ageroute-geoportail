import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normaliserItemStac } from "./normalisation";
import * as syn from "./__fixtures__/synthetiques";

/**
 * Le moteur de catalogue n'ecrit rien en base, ne lit aucun secret, et n'ouvre de connexion que par
 * le client HTTP injectable.
 */

function sources(dir = __dirname): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const chemin = join(dir, e.name);
    if (e.isDirectory()) return e.name === "__fixtures__" ? [] : sources(chemin);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && e.name !== "essais.support.ts" ? [chemin] : [];
  });
}

describe("perimetre du moteur de catalogue", () => {
  const fichiers = sources();
  it("il y a bien du code a verifier", () => {
    expect(fichiers.length).toBeGreaterThanOrEqual(12);
  });

  it("aucun acces base : ni Prisma, ni pg, ni module d'acces de l'application", () => {
    for (const f of fichiers) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/from\s+["'](@prisma\/client|pg|\.\.\/(\.\.\/)*lib\/prisma|\.\.\/(\.\.\/)*config\/env)["']/);
      expect(src, f).not.toMatch(/\$queryRaw|\$executeRaw|prisma\./);
    }
  });

  it("aucun secret lu : la seule variable d'environnement lue est la version de l'application", () => {
    for (const f of fichiers) {
      const lues = [...readFileSync(f, "utf8").matchAll(/process\.env\.(\w+)/g)].map((m) => m[1]);
      for (const v of lues) expect(["AGEROUTE_VERSION", "npm_package_version"], `${f} lit ${v}`).toContain(v);
    }
  });

  it("le reseau n'est atteint que par http.ts (fetch) et par la verification reelle, opt-in", () => {
    const avecFetch = fichiers.filter((f) => /\bfetch\(/.test(readFileSync(f, "utf8"))).map((f) => f.replace(__dirname, "").replace(/\\/g, "/"));
    expect(avecFetch.sort()).toEqual(["/http.ts", "/verification-reelle.ts"]);
  });

  it("la verification reelle n'est pas un test et exige --oui", () => {
    const src = readFileSync(join(__dirname, "verification-reelle.ts"), "utf8");
    expect(src).toMatch(/process\.argv\.includes\("--oui"\)/);
    expect(src).toMatch(/BUDGET_REQUETES = 20/);
    expect(src).not.toMatch(/Authorization|Bearer|client_secret/);
  });
});

describe("une date absente se replie sur start_datetime (STAC l'autorise)", () => {
  it("datetime null + start_datetime valide : la date est lue, sinon le produit est ecarte", () => {
    const a = syn.itemCdseReel();
    a.properties.datetime = null;
    const r = normaliserItemStac(a, { source: "cdse-stac", fournisseur: "CDSE", collection: "sentinel-2-l2a" });
    expect(r.ok && r.produit.dateAcquisition).toBe("2026-10-25T11:21:41.025Z");
    delete a.properties.start_datetime;
    expect(normaliserItemStac(a, { source: "cdse-stac", fournisseur: "CDSE", collection: "sentinel-2-l2a" }).ok).toBe(false);
  });
});
