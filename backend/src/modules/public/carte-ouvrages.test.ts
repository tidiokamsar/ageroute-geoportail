import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

/**
 * La carte PUBLIQUE ne montre que l'inventaire d'AGEROUTE.
 *
 * CE QUE CE TEST DEFEND
 *
 * Le 05/09/2026, 963 ponts ont ete repris d'une source cartographique externe. Ils
 * portent tous `etat = NON_EVALUE` : personne ne les a visites. La requete de la carte
 * publique n'avait aucun cadrage — non par negligence, mais parce que jusqu'a cet
 * import `ouvrages` ne contenait que du verifie, et qu'il n'y avait rien a exclure.
 *
 * L'import a donc suffi, seul, a faire passer la carte officielle du domaine public de
 * 126 a 1 089 ouvrages d'art. Aucune ligne de code n'avait change. C'est la forme la
 * plus discrete de ce defaut : une requete juste le devient fausse quand la table
 * change de contenu sous elle.
 *
 * Le meme piege existe partout ou une requete dit « tous les ouvrages » en pensant
 * « ceux qu'AGEROUTE a visites ». Ce test fixe la distinction sur la surface publique,
 * la seule que l'agence ne controle pas apres coup.
 */

const requetes: string[] = [];

vi.mock("../../lib/prisma", () => ({
  prisma: {
    $queryRaw: (fragments: TemplateStringsArray) => {
      requetes.push(fragments.join(" ? "));
      return Promise.resolve([]);
    },
  },
}));

vi.mock("../troncons/troncons.service", () => ({ tronconsService: { listGeo: async () => [] } }));
vi.mock("../points-noirs/points-noirs.service", () => ({ pointsNoirsService: { listGeo: async () => [] } }));
vi.mock("../chantiers/chantiers.service", () => ({ chantiersService: { listGeo: async () => [] } }));

import { carteGeoHandler } from "./public.controller";

function reponse() {
  return { json: vi.fn() } as unknown as Response;
}

async function requeteOuvrages(): Promise<string> {
  requetes.length = 0;
  await carteGeoHandler({ query: {} } as unknown as Request, reponse(), vi.fn());
  const sql = requetes.find((r) => r.includes("FROM ouvrages"));
  expect(sql, "aucune requete sur les ouvrages n'a ete emise").toBeDefined();
  return sql!;
}

beforeEach(() => { requetes.length = 0; });

describe("La carte publique cadre les ouvrages sur l'inventaire de reference", () => {
  it("ecarte les ouvrages repris d'une source externe", async () => {
    expect(await requeteOuvrages()).toContain("NOT LIKE 'ouvrage_osm:%'");
  });

  it("garde les 126 ouvrages inventories, dont la provenance est nulle", async () => {
    // Sans le IS NULL, la carte publique serait VIDE : en SQL, NULL NOT LIKE '...'
    // vaut NULL, donc faux, et les ouvrages d'AGEROUTE n'ont pas de sourceReference.
    // Le meme oubli a deja fait disparaitre 1 690 troncons ailleurs.
    const sql = await requeteOuvrages();
    expect(sql).toContain('"sourceReference" IS NULL');
    const posIsNull = sql.indexOf('"sourceReference" IS NULL');
    const posNotLike = sql.indexOf("NOT LIKE 'ouvrage_osm:%'");
    expect(sql.slice(posIsNull, posNotLike)).toContain("OR");
  });

  it("ne sert que ce qui a une position", async () => {
    expect(await requeteOuvrages()).toContain("geom IS NOT NULL");
  });

  it("ne sert pas ce qui est archive", async () => {
    expect(await requeteOuvrages()).toContain('"deletedAt" IS NULL');
  });
});
