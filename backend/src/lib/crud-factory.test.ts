import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../utils/audit", () => ({ logAudit: vi.fn() }));

import { createCrudService } from "./crud-factory";
import { logAudit } from "../utils/audit";

function matchesDeletedAt(row: Record<string, unknown>, deletedAt: unknown): boolean {
  if (deletedAt === null) return row.deletedAt == null;
  if (deletedAt && typeof deletedAt === "object" && "not" in deletedAt) return row.deletedAt != null;
  return true;
}

function makeFakeModel(initial: Record<string, unknown>[]) {
  const rows = [...initial];
  return {
    findMany: vi.fn(async ({ where, skip = 0, take = 20 }: { where: { deletedAt: unknown }; skip?: number; take?: number }) =>
      rows.filter((r) => matchesDeletedAt(r, where.deletedAt)).slice(skip, skip + take)
    ),
    count: vi.fn(async ({ where }: { where: { deletedAt: unknown } }) =>
      rows.filter((r) => matchesDeletedAt(r, where.deletedAt)).length
    ),
    findFirst: vi.fn(async ({ where }: { where: { id: string; deletedAt: null } }) =>
      rows.find((r) => r.id === where.id && r.deletedAt == null) ?? null
    ),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `id-${rows.length + 1}`, deletedAt: null, ...data };
      rows.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw new Error("not found");
      Object.assign(row, data);
      return row;
    }),
  };
}

describe("createCrudService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("excludes soft-deleted rows from list() and getById()", async () => {
    const model = makeFakeModel([
      { id: "a", nom: "Tronçon A", deletedAt: null },
      { id: "b", nom: "Tronçon B", deletedAt: new Date() },
    ]);
    const service = createCrudService(model, "Troncon");

    const result = await service.list({});
    expect(result.total).toBe(1);
    expect(result.data).toHaveLength(1);

    await expect(service.getById("b")).rejects.toThrow("Troncon introuvable");
  });

  it("remove() sets deletedAt instead of deleting the row, and logs an audit DELETE", async () => {
    const model = makeFakeModel([{ id: "a", nom: "Tronçon A", deletedAt: null }]);
    const service = createCrudService(model, "Troncon");

    await service.remove("a", "user-1");

    expect(model.update).toHaveBeenCalledWith({ where: { id: "a" }, data: { deletedAt: expect.any(Date) } });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", action: "DELETE", entityType: "Troncon", entityId: "a" })
    );

    const stillThere = await model.findUnique({ where: { id: "a" } });
    expect(stillThere).not.toBeNull();
  });

  it("create() logs an audit CREATE with the created entity", async () => {
    const model = makeFakeModel([]);
    const service = createCrudService(model, "Troncon");

    const created = await service.create({ nom: "Nouveau tronçon" }, "user-2");

    expect(created.nom).toBe("Nouveau tronçon");
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-2", action: "CREATE", entityType: "Troncon", entityId: created.id })
    );
  });

  it("list({ archived: true }) renvoie uniquement les lignes soft-deleted", async () => {
    const model = makeFakeModel([
      { id: "a", nom: "Tronçon A", deletedAt: null },
      { id: "b", nom: "Tronçon B", deletedAt: new Date() },
    ]);
    const service = createCrudService(model, "Troncon");

    const active = await service.list({});
    const archived = await service.list({ archived: true });

    expect(active.data).toHaveLength(1);
    expect(archived.data).toHaveLength(1);
    expect((archived.data[0] as { id: string }).id).toBe("b");
  });

  it("bulkRemove() traite chaque ligne independamment et rapporte les echecs sans interrompre le lot", async () => {
    const model = makeFakeModel([
      { id: "a", nom: "Tronçon A", deletedAt: null },
      { id: "b", nom: "Tronçon B", deletedAt: null },
    ]);
    const service = createCrudService(model, "Troncon");

    const result = await service.bulkRemove(["a", "b", "inexistant"], "user-3");

    expect(result.success).toBe(2);
    expect(result.failed).toEqual([{ id: "inexistant", message: "Troncon introuvable" }]);
    const stillThereA = await model.findUnique({ where: { id: "a" } });
    expect((stillThereA as { deletedAt: Date | null }).deletedAt).not.toBeNull();
  });

  it("bulkRestore() reactive plusieurs lignes archivees", async () => {
    const model = makeFakeModel([
      { id: "a", nom: "Tronçon A", deletedAt: new Date() },
      { id: "b", nom: "Tronçon B", deletedAt: new Date() },
    ]);
    const service = createCrudService(model, "Troncon");

    const result = await service.bulkRestore(["a", "b"], "user-4");

    expect(result.success).toBe(2);
    expect(result.failed).toHaveLength(0);
    const restored = await service.list({});
    expect(restored.data).toHaveLength(2);
  });
});
