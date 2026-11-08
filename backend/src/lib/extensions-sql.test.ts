import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import {
  EXTENSIONS_CONNUES,
  emploisExtensions,
  extensionsCreees,
  extensionsDuSchemaPrisma,
  sansCommentaires,
  verifierExtensions,
} from "./extensions-sql";

/**
 * Garde : tout ce que le code emploie comme extension PostgreSQL doit etre cree par une migration.
 * Voir le commentaire de `extensions-sql.ts` pour l'origine (unaccent, 22/10/2026).
 *
 * Deux parties :
 *   1. le balayage est eprouve sur des sources FABRIQUEES, dont la contre-epreuve (le defaut qu'il
 *      doit attraper) ;
 *   2. il est applique au depot reel.
 */

describe("balayage des extensions : sources fabriquees", () => {
  const mig = (nom: string, sql: string) => ({ nom, sql });
  const baseOk = [mig("20260101000000_init", 'CREATE EXTENSION IF NOT EXISTS "postgis";')];

  it("accepte un code dont toutes les extensions sont creees par une migration", () => {
    const v = verifierExtensions(
      [...baseOk, mig("20260102000000_u", "CREATE EXTENSION IF NOT EXISTS unaccent;")],
      [{ chemin: "src/a.ts", contenu: "SELECT unaccent(lower(nom)), ST_Length(geom) FROM x" }],
      "",
    );
    expect(v).toEqual([]);
  });

  it("CONTRE-EPREUVE : refuse unaccent employe dans le code sans migration (le defaut du 22/10)", () => {
    const v = verifierExtensions(baseOk, [{ chemin: "src/chantiers.service.ts", contenu: "ON unaccent(lower(la.nom)) = unaccent(lower(r.nom))" }], "");
    expect(v).toHaveLength(1);
    expect(v[0].type).toBe("EXTENSION_NON_CREEE");
    expect(v[0].detail).toContain("unaccent");
    expect(v[0].detail).toContain("src/chantiers.service.ts");
  });

  it("CONTRE-EPREUVE : une creation dans un banc ou un script ne tient pas lieu de migration", () => {
    const v = verifierExtensions(
      baseOk,
      [
        { chemin: "src/a.ts", contenu: "SELECT unaccent(x)" },
        { chemin: "tests-integration/perf/lib/charger.ts", contenu: "await client.query(`CREATE EXTENSION IF NOT EXISTS unaccent`)" },
      ],
      "",
    );
    expect(v.map((x) => x.type)).toEqual(["EXTENSION_NON_CREEE"]);
  });

  it("refuse une extension creee APRES l'emploi par une migration (rejeu depuis une base vide)", () => {
    const v = verifierExtensions(
      [
        mig("20260101000000_init", 'CREATE EXTENSION IF NOT EXISTS "postgis";'),
        mig("20260102000000_emploi", "SELECT unaccent('x');"),
        mig("20260103000000_creation", "CREATE EXTENSION IF NOT EXISTS unaccent;"),
      ],
      [],
      "",
    );
    expect(v.map((x) => x.type)).toEqual(["EXTENSION_CREEE_APRES_EMPLOI"]);
  });

  it("accepte la creation puis l'emploi dans le meme fichier, refuse l'ordre inverse", () => {
    expect(
      verifierExtensions([mig("20260101000000_a", "CREATE EXTENSION pg_trgm;\nCREATE INDEX i ON t USING GIN (c gin_trgm_ops);")], [], ""),
    ).toEqual([]);
    expect(
      verifierExtensions([mig("20260101000000_a", "CREATE INDEX i ON t USING GIN (c gin_trgm_ops);\nCREATE EXTENSION pg_trgm;")], [], "").map((x) => x.type),
    ).toEqual(["EXTENSION_CREEE_APRES_EMPLOI"]);
  });

  it("refuse une extension absente de la liste connue, a l'emploi comme a la creation", () => {
    const v1 = verifierExtensions(baseOk, [{ chemin: "src/b.ts", contenu: "SELECT uuid_generate_v4()" }], "");
    expect(v1.map((x) => x.type)).toEqual(["EXTENSION_INCONNUE"]);
    const v2 = verifierExtensions([...baseOk, mig("20260102000000_x", "CREATE EXTENSION IF NOT EXISTS hstore;")], [], "");
    expect(v2.map((x) => x.type)).toEqual(["CREATION_INCONNUE"]);
  });

  it("refuse une extension declaree par schema.prisma sans migration", () => {
    const schema = 'datasource db {\n  provider = "postgresql"\n  extensions = [postgis, pg_trgm]\n}';
    const v = verifierExtensions(baseOk, [], schema);
    expect(v).toHaveLength(1);
    expect(v[0].detail).toContain("pg_trgm");
  });

  it("ignore les commentaires (SQL, TypeScript) et ne confond pas un mot avec un appel", () => {
    expect(emploisExtensions("-- unaccent(x) n'est pas garanti\n// unaccent(y)\n/* unaccent(z) */ SELECT 1").connus).toEqual([]);
    expect(emploisExtensions("const sansAccent = 1; // la fonction unaccent() est absente").connus).toEqual([]);
    expect(emploisExtensions("const sansAccent = unaccentuer(x)").connus).toEqual([]);
    expect(emploisExtensions("SELECT unaccent (nom)").connus.map((e) => e.extension)).toEqual(["unaccent"]);
  });

  it("reconnait les formes de CREATE EXTENSION du depot", () => {
    expect(extensionsCreees('CREATE EXTENSION IF NOT EXISTS "postgis";\nCREATE EXTENSION btree_gist;\n  create extension if not exists pg_trgm;').map((e) => e.nom)).toEqual([
      "postgis",
      "btree_gist",
      "pg_trgm",
    ]);
    expect(extensionsCreees("-- CREATE EXTENSION unaccent;")).toEqual([]);
    expect(extensionsDuSchemaPrisma("extensions = [postgis]")).toEqual(["postgis"]);
    expect(sansCommentaires("a -- b\nc")).toBe("a\nc");
  });

  it("la liste connue est celle que le mandat annonce", () => {
    expect([...EXTENSIONS_CONNUES].sort()).toEqual(["btree_gist", "pg_trgm", "postgis", "unaccent"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Application au depot reel
// ---------------------------------------------------------------------------------------------

const BACKEND = join(__dirname, "..", "..");
const SAUTE = new Set(["node_modules", "dist", ".git", "migrations"]);
const GARDE_ELLE_MEME = new Set(["src/lib/extensions-sql.ts", "src/lib/extensions-sql.test.ts"]);

function fichiers(repertoire: string, extensions: string[], acc: string[] = []): string[] {
  if (!existsSync(repertoire)) return acc;
  for (const entree of readdirSync(repertoire)) {
    if (SAUTE.has(entree)) continue;
    const chemin = join(repertoire, entree);
    if (statSync(chemin).isDirectory()) fichiers(chemin, extensions, acc);
    else if (extensions.some((e) => entree.endsWith(e))) acc.push(chemin);
  }
  return acc;
}

function migrationsDuDepot() {
  const dossier = join(BACKEND, "prisma", "migrations");
  return readdirSync(dossier)
    .filter((d) => /^\d{14}_/.test(d))
    .map((d) => ({ nom: d, sql: readFileSync(join(dossier, d, "migration.sql"), "utf8") }));
}

function sourcesDuDepot() {
  const dossiers = ["src", "scripts", "tests-integration", join("prisma", "tests"), join("prisma", "descentes")];
  const liste = dossiers.flatMap((d) => fichiers(join(BACKEND, d), [".ts", ".mts", ".sql"]));
  liste.push(join(BACKEND, "prisma", "seed.ts"));
  return liste
    .map((chemin) => ({ chemin: relative(BACKEND, chemin).replace(/\\/g, "/"), contenu: readFileSync(chemin, "utf8") }))
    .filter((s) => !GARDE_ELLE_MEME.has(s.chemin));
}

describe("extensions PostgreSQL du depot reel", () => {
  const migrations = migrationsDuDepot();
  const sources = sourcesDuDepot();
  const schema = readFileSync(join(BACKEND, "prisma", "schema.prisma"), "utf8");

  it("le balayage lit bien le depot (garde contre un balayage vide)", () => {
    expect(migrations.length).toBeGreaterThan(60);
    expect(sources.length).toBeGreaterThan(100);
    // les quatre extensions connues sont toutes employees quelque part (code, bancs ou migrations) :
    // les signatures ne sont pas decoratives
    const textes = [...sources.map((s) => s.contenu), ...migrations.map((m) => m.sql)];
    const employees = new Set(textes.flatMap((t) => emploisExtensions(t).connus.map((e) => e.extension)));
    for (const ext of EXTENSIONS_CONNUES) expect(employees.has(ext), `${ext} n'est employee nulle part`).toBe(true);
  });

  it("chaque extension employee est creee par une migration, avant son premier emploi en migration", () => {
    const v = verifierExtensions(migrations, sources, schema);
    expect(v.map((x) => `${x.type} : ${x.detail}`)).toEqual([]);
  });

  it("les quatre extensions connues sont creees par la chaine de migrations", () => {
    const creees = new Set(migrations.flatMap((m) => extensionsCreees(m.sql).map((e) => e.nom)));
    for (const ext of EXTENSIONS_CONNUES) expect(creees.has(ext), `${ext} n'est creee par aucune migration`).toBe(true);
  });
});
