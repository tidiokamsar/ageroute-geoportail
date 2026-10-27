import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { geoPropositions, listerPropositions, type DepotLecture } from "./api.lecture";

/**
 * Le SQL de lecture est parametre : ces tests regardent la requete envoyee (texte et valeurs), sans base. La preuve sur une base
 * reelle est celle du banc de bout en bout (`e2e-eo`, spec 01).
 */

/** Depot factice : enregistre chaque requete (texte SQL et valeurs liees) et rend des tableaux vides / un comptage a zero. */
function depotEnregistreur() {
  const requetes: { sql: string; valeurs: unknown[] }[] = [];
  const depot = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray | Prisma.Sql, ...valeurs: unknown[]) => {
      const q = Array.isArray(strings) ? Prisma.sql(strings as unknown as TemplateStringsArray, ...valeurs) : (strings as Prisma.Sql);
      requetes.push({ sql: q.sql, valeurs: q.values });
      return q.sql.includes("count(*)") ? [{ n: 0 }] : [];
    }),
  };
  return { depot: depot as unknown as DepotLecture, requetes };
}

const FILTRES = { limite: 25 } as const;

describe("listerPropositions : recherche libre `q` (E2E-EO-2)", () => {
  it("cherche aussi le nom de la region (la « zone » affichee dans la liste), dans la liste ET dans le comptage", async () => {
    const { depot, requetes } = depotEnregistreur();
    await listerPropositions(depot, { ...FILTRES, q: "Kankan" }, { regions: null });
    expect(requetes).toHaveLength(2);
    for (const r of requetes) {
      expect(r.sql).toContain(`r."nom" ILIKE`);
      expect(r.valeurs).toContain("%Kankan%");
    }
  });

  it("garde les recherches existantes : code et nom du troncon, methode, debut d'identifiant", async () => {
    const { depot, requetes } = depotEnregistreur();
    await listerPropositions(depot, { ...FILTRES, q: "N1" }, { regions: null });
    const sql = requetes[0].sql;
    expect(sql).toContain(`t."code" ILIKE`);
    expect(sql).toContain(`t."nom" ILIKE`);
    expect(sql).toContain(`pt."methode" ILIKE`);
    expect(sql).toContain(`pt."id" ILIKE`);
  });

  it("la region est lue par la jointure existante : aucune seconde jointure, aucun sous-select", async () => {
    const { depot, requetes } = depotEnregistreur();
    await listerPropositions(depot, { ...FILTRES, q: "Kankan" }, { regions: null });
    for (const r of requetes) {
      expect(r.sql.match(/LEFT JOIN "regions" r ON r\."id" = pt\."regionId"/g)).toHaveLength(1);
      expect(r.sql).not.toMatch(/SELECT[^;]*FROM "regions"/);
    }
  });

  it("ne desserre pas le perimetre : un compte regional garde `pt.regionId = ANY(...)` en plus de la recherche", async () => {
    const { depot, requetes } = depotEnregistreur();
    await listerPropositions(depot, { ...FILTRES, q: "Kankan" }, { regions: [7] });
    for (const r of requetes) {
      expect(r.sql).toContain(`pt."regionId" = ANY(`);
      expect(r.valeurs).toContainEqual([7]);
      // la recherche reste dans un groupe parenthese relie au perimetre par AND, jamais par OR
      expect(r.sql).toMatch(/AND \(t\."code" ILIKE[^)]*r\."nom" ILIKE/);
    }
  });

  it("le texte cherche est litteral : le pourcent, le soulignement et l'antislash n'ont pas de sens de motif", async () => {
    const { depot, requetes } = depotEnregistreur();
    await listerPropositions(depot, { ...FILTRES, q: "100%_x" }, { regions: null });
    expect(requetes[0].valeurs).toContain("%100\\%\\_x%");
  });

  it("sans `q`, la region n'est pas cherchee", async () => {
    const { depot, requetes } = depotEnregistreur();
    await listerPropositions(depot, { ...FILTRES }, { regions: null });
    expect(requetes[0].sql).not.toContain(`r."nom" ILIKE`);
  });
});

describe("geoPropositions : le perimetre territorial reste dans la requete", () => {
  it("un compte regional n'obtient que ses regions", async () => {
    const { depot, requetes } = depotEnregistreur();
    await geoPropositions(depot, { bbox: [-15, 7, -7, 13], limite: 10 } as never, { regions: [3] });
    expect(requetes[0].sql).toContain(`pt."regionId" = ANY(`);
  });
});
