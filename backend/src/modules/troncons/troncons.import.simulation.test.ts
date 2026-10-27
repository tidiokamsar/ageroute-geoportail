import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Import XLSX des tronçons, simulable et rejouable (BDRI, lot H) : ce que ces tests défendent.
 *   - la simulation classe chaque ligne (créer, mettre à jour avec ses changements, inchangée, erreur) et n'écrit RIEN ;
 *   - un code présent deux fois dans le fichier est refusé ; un nom déjà porté dans la région est signalé, sans bloquer ;
 *   - une ligne inchangée n'est jamais réécrite : rejouer le même fichier ne crée ni ne modifie rien ;
 *   - des mises à jour de tronçons existants exigent une confirmation explicite ; sans elle, rien n'est écrit ;
 *   - un code archivé n'est pas ressuscité ; créations et mises à jour sont comptées séparément.
 */
const h = vi.hoisted(() => ({
  lignes: [] as Record<string, unknown>[],
  existants: {} as Record<string, Record<string, unknown>>,
  homonymes: {} as Record<string, string>,
  ecritures: [] as { op: string; id?: string; data: Record<string, unknown> }[],
}));

vi.mock("../../lib/excel", () => ({
  parseImportBuffer: vi.fn(async () => h.lignes),
  buildExportBuffer: vi.fn(),
  formatImportError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("../../lib/regions", () => ({ resolveRegionId: vi.fn(async (nom: string) => (nom === "Kindia" ? 3 : null)) }));
vi.mock("../../lib/crud-factory", () => ({
  createCrudService: () => ({
    create: vi.fn(async (data: Record<string, unknown>) => { h.ecritures.push({ op: "create", data }); return { id: "nouveau", ...data }; }),
    update: vi.fn(async (id: string, data: Record<string, unknown>) => { h.ecritures.push({ op: "update", id, data }); return { id, ...data }; }),
  }),
}));
vi.mock("../../lib/prisma", () => ({
  prisma: {
    troncon: {
      findUnique: vi.fn(async ({ where }: { where: { code: string } }) => h.existants[where.code] ?? null),
      findFirst: vi.fn(async ({ where }: { where: { nom: { equals: string } } }) => (h.homonymes[where.nom.equals] ? { code: h.homonymes[where.nom.equals] } : null)),
    },
  },
}));

import { tronconsService } from "./troncons.service";

const ligne = (code: string, o: Record<string, unknown> = {}) => ({
  Code: code, Nom: `Route ${code}`, Classe: "RN", "Région": "Kindia", "Longueur (km)": 10, "Revêtement": "BITUME", "PK Début": 0, "PK Fin": 10, ...o,
});
const existant = (code: string, o: Record<string, unknown> = {}) => ({
  id: `id-${code}`, code, nom: `Route ${code}`, classe: "RN", regionId: 3, longueurKm: 10, revetement: "BITUME", etat: "NON_EVALUE", pkDebut: 0, pkFin: 10, traficMoyenJma: null, deletedAt: null, ...o,
});
const importer = (o: { simulation?: boolean; confirmer?: boolean } = {}) => tronconsService.importXlsx(Buffer.from(""), "u-1", o);

beforeEach(() => { h.lignes = []; h.existants = {}; h.homonymes = {}; h.ecritures.length = 0; });

describe("simulation", () => {
  it("classe chaque ligne et n'écrit rien", async () => {
    h.lignes = [ligne("A"), ligne("B", { "Longueur (km)": 12.5 }), ligne("C"), ligne("D", { "Région": "Atlantide" })];
    h.existants = { B: existant("B"), C: existant("C") };
    const r = await importer({ simulation: true });
    expect(r.lignes.map((l) => [l.code, l.action])).toEqual([["A", "CREER"], ["B", "METTRE_A_JOUR"], ["C", "INCHANGE"], ["D", "ERREUR"]]);
    expect(r.lignes[1].changements).toEqual([{ champ: "longueurKm", actuelle: 10, nouvelle: 12.5 }]);
    expect(r).toMatchObject({ simulation: true, created: 1, updated: 1, unchanged: 1 });
    expect(r.errors).toEqual([{ row: 5, message: 'Région "Atlantide" introuvable' }]);
    expect(h.ecritures).toEqual([]);
  });
  it("refuse un code présent deux fois dans le fichier ; signale un nom déjà porté sans bloquer", async () => {
    h.lignes = [ligne("A"), ligne("A", { Nom: "Autre" }), ligne("E", { Nom: "Coyah Kindia" })];
    h.homonymes = { "Coyah Kindia": "GN N0001" };
    const r = await importer({ simulation: true });
    expect(r.errors[0]).toMatchObject({ row: 3, message: expect.stringMatching(/déjà présent ligne 2/) });
    expect(r.avertissements).toEqual([{ row: 4, message: expect.stringMatching(/Doublon potentiel.*GN N0001/) }]);
    expect(r.lignes.find((l) => l.code === "E")?.action).toBe("CREER");
  });
  it("un code archivé n'est pas ressuscité par l'import", async () => {
    h.lignes = [ligne("Z")];
    h.existants = { Z: existant("Z", { deletedAt: new Date() }) };
    const r = await importer({ simulation: true });
    expect(r.lignes[0]).toMatchObject({ action: "ERREUR", message: expect.stringMatching(/archivé/) });
  });
});

describe("import réel", () => {
  it("les mises à jour exigent une confirmation : sans elle, rien n'est écrit, même les créations", async () => {
    h.lignes = [ligne("A"), ligne("B", { Nom: "Renommée" })];
    h.existants = { B: existant("B") };
    await expect(importer()).rejects.toMatchObject({ status: 409 });
    expect(h.ecritures).toEqual([]);
    const r = await importer({ confirmer: true });
    expect(r).toMatchObject({ simulation: false, created: 1, updated: 1, unchanged: 0 });
    expect(h.ecritures.map((e) => [e.op, e.id ?? e.data.code])).toEqual([["create", "A"], ["update", "id-B"]]);
  });
  it("rejouer un fichier déjà importé ne crée ni ne modifie rien, sans confirmation à donner", async () => {
    h.lignes = [ligne("B"), ligne("C")];
    h.existants = { B: existant("B"), C: existant("C") };
    const r = await importer();
    expect(r).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    expect(h.ecritures).toEqual([]);
  });
});
