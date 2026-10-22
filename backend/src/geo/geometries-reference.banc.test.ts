import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GEOMETRIES_REFERENCE } from "./geometries-reference";

/**
 * Le banc SQL `prisma/tests/metre_reference.test.sql` est ENGENDRE depuis
 * `geometries-reference.ts` : les deux implementations du metre (PostGIS et TypeScript) sont ainsi
 * eprouvees sur les memes coordonnees, et une geometrie ajoutee d'un cote ne peut pas manquer de
 * l'autre. Ce test echoue si le banc n'est plus a jour.
 *
 *   REGENERER_BANC_METRE=1 npx vitest run src/geo/geometries-reference.banc.test.ts
 */

const CHEMIN = join(__dirname, "..", "..", "prisma", "tests", "metre_reference.test.sql");

function engendrer(): string {
  const lignes = GEOMETRIES_REFERENCE.map((r) => {
    const tol = r.postgis.epsg === r.epsgDefinition ? "1e-6" : "0.01";
    const gj = JSON.stringify(r.geometrie).replace(/'/g, "''");
    return `  ('${r.code}', ${r.epsgDefinition}, ${r.postgis.epsg}, ${r.surfaceDefinitionM2}, ${r.longueurDefinitionM}, ${tol}, '${gj}')`;
  });
  return `-- BANC ENGENDRE depuis backend/src/geo/geometries-reference.ts : NE PAS MODIFIER A LA MAIN.
--   REGENERER_BANC_METRE=1 npx vitest run src/geo/geometries-reference.banc.test.ts
--
-- Ce qu'il prouve (paragraphe 7.1, scenario A5) : sur chaque geometrie de reference, \`metre_utm\`
-- choisit le fuseau attendu et retrouve la surface et la longueur de DEFINITION au millionieme
-- (a 1 % pour une geometrie calculee dans le fuseau voisin de celui ou elle est definie, ce qui
-- est l'exigence de A5). Le noyau TypeScript \`utm.noyau.ts\` est eprouve sur les memes
-- coordonnees par \`utm.noyau.test.ts\`.
--
--   docker exec -i bdri-dev-db psql -U bdri_dev -d <base> -v ON_ERROR_STOP=1 -f - < backend/prisma/tests/metre_reference.test.sql

DO $t$
DECLARE r RECORD; m RECORD; n integer := 0;
BEGIN
  FOR r IN SELECT * FROM (VALUES
${lignes.join(",\n")}
  ) AS v(code, epsg_definition, epsg_attendu, surface, longueur, tolerance, gj) LOOP
    SELECT * INTO m FROM metre_utm(ST_SetSRID(ST_GeomFromGeoJSON(r.gj), 4326));
    IF m.epsg <> r.epsg_attendu THEN
      RAISE EXCEPTION '% : fuseau % attendu, % rendu', r.code, r.epsg_attendu, m.epsg;
    END IF;
    IF r.surface > 0 AND abs(m."surfaceM2" - r.surface) / r.surface > r.tolerance THEN
      RAISE EXCEPTION '% : surface % m2 attendue (tolerance %), % rendue', r.code, r.surface, r.tolerance, m."surfaceM2";
    END IF;
    IF abs(m."longueurM" - r.longueur) / r.longueur > r.tolerance THEN
      RAISE EXCEPTION '% : longueur % m attendue (tolerance %), % rendue', r.code, r.longueur, r.tolerance, m."longueurM";
    END IF;
    RAISE NOTICE '% : EPSG %, % m2, % m (ecart a l''ellipsoide %)', r.code, m.epsg, round(m."surfaceM2"::numeric, 3),
      round(m."longueurM"::numeric, 3), round(coalesce(m."ecartSurface", m."ecartLongueur")::numeric, 5);
    n := n + 1;
  END LOOP;
  IF n <> ${GEOMETRIES_REFERENCE.length} THEN RAISE EXCEPTION 'Geometries eprouvees : ${GEOMETRIES_REFERENCE.length} attendues, %', n; END IF;
  RAISE NOTICE '--- TOUTES LES ASSERTIONS PASSENT (% geometries) ---', n;
END;
$t$;
`;
}

describe("Banc SQL des geometries de reference", () => {
  it("est a jour avec geometries-reference.ts", () => {
    const attendu = engendrer();
    if (process.env.REGENERER_BANC_METRE === "1") writeFileSync(CHEMIN, attendu, "utf8");
    expect(readFileSync(CHEMIN, "utf8").replace(/\r\n/g, "\n")).toBe(attendu);
  });
});
