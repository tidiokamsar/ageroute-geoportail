import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Filtres de la liste des tronçons (BDRI, lot B) : ce que ces tests défendent.
 *   - les nouveaux filtres partent au serveur (revêtement, PK non renseignés, présence d'un tracé) ;
 *   - un PK tapé dans la recherche trouve le tronçon qui le contient, sans perdre la recherche texte ;
 *   - le réseau classé reste le périmètre par défaut, ajouté en ET ;
 *   - chaque ligne dit si elle a un tracé et sa longueur géométrique, sans écraser la longueur déclarée ;
 *   - l'export reçoit EXACTEMENT les filtres de la liste (ce qu'on exporte est ce qu'on voit) ;
 *   - une valeur de filtre inconnue est refusée, pas ignorée.
 */
const h = vi.hoisted(() => ({ wheres: [] as Record<string, unknown>[], exports: [] as Record<string, unknown>[], raw: [] as string[] }));

vi.mock("../../lib/crud-factory", () => ({
  createCrudService: () => ({
    list: vi.fn(async (p: { where: Record<string, unknown> }) => { h.wheres.push(p.where); return { data: [{ id: "t1", longueurKm: 12 }, { id: "t2", longueurKm: 3 }], total: 2, page: 1, pageSize: 20, totalPages: 1 }; }),
  }),
}));
vi.mock("../../lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const q = strings.join("?");
      h.raw.push(q);
      if (q.includes("geom IS NULL LIMIT")) return [{ id: "sans-1" }, { id: "sans-2" }];
      return [{ id: "t1", a: true, km: 11.9876 }, { id: "t2", a: false, km: null }];
    }),
    troncon: { count: vi.fn(async () => 1), findMany: vi.fn(async (args: { where: Record<string, unknown> }) => { h.exports.push(args.where); return []; }) },
  },
}));
vi.mock("../../lib/excel", () => ({ buildExportBuffer: () => Buffer.from(""), parseImportBuffer: vi.fn(), formatImportError: vi.fn() }));

import { pkCherche, tronconsService } from "./troncons.service";
import { exportHandler, listHandler } from "./troncons.controller";

const appeler = async (handler: typeof listHandler, query: Record<string, string>) => {
  const res = { json: vi.fn(), setHeader: vi.fn(), send: vi.fn() };
  const next = vi.fn();
  await handler({ query } as never, res as never, next);
  return { res, next };
};
const et = (w: Record<string, unknown>) => (w.AND as unknown[]) ?? [];

beforeEach(() => { h.wheres.length = 0; h.exports.length = 0; h.raw.length = 0; });

describe("pkCherche", () => {
  it.each([["12,5", 12.5], ["120", 120], ["GN N0001", null], ["12,5 km", null], ["", null]])("%j -> %s", (s, v) => {
    expect(pkCherche(s)).toBe(v);
  });
});

describe("liste", () => {
  it("revêtement, PK non renseignés et réseau classé par défaut", async () => {
    await appeler(listHandler, { revetement: "TERRE", pk: "non_renseigne" });
    const w = h.wheres[0];
    expect(w.revetement).toBe("TERRE");
    expect(et(w)).toContainEqual({ pkDebut: 0, pkFin: 0 });
    expect(JSON.stringify(et(w))).toMatch(/sourceReference/);
  });
  it("un PK cherché trouve le tronçon qui le contient, et la recherche texte reste", async () => {
    await tronconsService.list({ search: "12,5" });
    expect(h.wheres[0].OR).toEqual([
      { code: { contains: "12,5", mode: "insensitive" } },
      { nom: { contains: "12,5", mode: "insensitive" } },
      { AND: [{ pkDebut: { lte: 12.5 } }, { pkFin: { gte: 12.5 } }] },
    ]);
  });
  it("« sans tracé » filtre sur les identifiants lus en SQL ; « avec tracé » les exclut", async () => {
    await tronconsService.list({ geometrie: "absente" });
    expect(et(h.wheres[0])).toContainEqual({ id: { in: ["sans-1", "sans-2"] } });
    await tronconsService.list({ geometrie: "presente" });
    expect(et(h.wheres[1])).toContainEqual({ id: { notIn: ["sans-1", "sans-2"] } });
  });
  it("chaque ligne dit si elle a un tracé et sa longueur géométrique ; la longueur déclarée est intacte", async () => {
    const r = await tronconsService.list({});
    expect(r.data).toEqual([
      { id: "t1", longueurKm: 12, aGeometrie: true, longueurGeometriqueKm: 11.988 },
      { id: "t2", longueurKm: 3, aGeometrie: false, longueurGeometriqueKm: null },
    ]);
  });
  it("une valeur de filtre inconnue est refusée", async () => {
    const { next } = await appeler(listHandler, { geometrie: "partielle" });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ name: "ZodError" }));
    expect(h.wheres).toHaveLength(0);
  });
});

describe("export", () => {
  it("reçoit exactement les filtres de la liste, sans pagination", async () => {
    await appeler(listHandler, { search: "Kindia", revetement: "BITUME", etat: "BON", pk: "renseigne", page: "3" });
    await appeler(exportHandler, { search: "Kindia", revetement: "BITUME", etat: "BON", pk: "renseigne", page: "3" });
    const { deletedAt, ...exporte } = h.exports[0] as Record<string, unknown>;
    expect(deletedAt).toBeNull();
    expect(exporte).toEqual(h.wheres[0]);
  });
});
