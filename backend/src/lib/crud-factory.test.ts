import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../utils/audit", () => {
  const logAudit = vi.fn();
  // `logAuditTransactionnelle` delegue au MEME espion : les assertions de ce fichier
  // continuent d'observer exactement les memes parametres, desormais sur le seul chemin
  // qui existe. La branche fail-soft a ete supprimee le 13/10/2026 — elle etait devenue
  // du code mort, et un code mort de cette nature est un piege.
  return {
    logAudit,
    construireAudit: vi.fn((p: Record<string, unknown>) => {
      logAudit(p);
      return { __audit: p };
    }),
    logAuditTransactionnelle: vi.fn(async (_tx: unknown, p: Record<string, unknown>) => {
      logAudit(p);
    }),
  };
});

/**
 * La valeur, sa provenance et sa trace partent dans une MEME transaction : l'une sans
 * les autres laisserait la base dans un etat qu'on ne saurait plus expliquer.
 *
 * Depuis que la fabrique exige un delegue transactionnel, elle utilise la forme
 * INTERACTIVE — c'est ce qui permet au champ `after` de porter la ligne telle que la base
 * l'a rendue. Le `tx` fourni ici expose le MODELE INJECTE par le test, sous la cle que
 * `delegueTransactionnel` ira chercher : c'est lui qu'on verifie, et le court-circuiter
 * serait precisement l'erreur que 4eb1525 avait commise.
 */
const etatTx = vi.hoisted(() => ({ modele: null as unknown }));

vi.mock("./prisma", () => {
  const client = {
    valeurQualite: { upsert: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg === "function") {
        return (arg as (tx: unknown) => Promise<unknown>)({
          modele: etatTx.modele,
          valeurQualite: client.valeurQualite,
        });
      }
      return Promise.all(arg as Promise<unknown>[]);
    }),
  };
  return { prisma: client };
});

import { createCrudService } from "./crud-factory";
import { logAudit } from "../utils/audit";
import { prisma } from "./prisma";

/**
 * Monte un service en declarant le delegue transactionnel.
 *
 * Le delegue est OBLIGATOIRE depuis le 13/10/2026 : on ne peut plus construire un service
 * dont les ecritures ne sont pas tracees, et c'est le compilateur qui l'empeche.
 */
function monter(model: unknown, entityName = "Troncon") {
  etatTx.modele = model;
  return createCrudService(model as never, entityName, {
    delegueTransactionnel: (tx) => (tx as { modele: unknown }).modele as never,
  });
}

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
    findFirst: vi.fn(async ({ where }: { where: { id: string; deletedAt?: unknown } }) =>
      rows.find((r) =>
        r.id === where.id &&
        matchesDeletedAt(r, where.deletedAt === undefined ? null : where.deletedAt)
      ) ?? null
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
    const service = monter(model, "Troncon");

    const result = await service.list({});
    expect(result.total).toBe(1);
    expect(result.data).toHaveLength(1);

    await expect(service.getById("b")).rejects.toThrow("Troncon introuvable");
  });

  it("remove() sets deletedAt instead of deleting the row, and logs an audit DELETE", async () => {
    const model = makeFakeModel([{ id: "a", nom: "Tronçon A", deletedAt: null }]);
    const service = monter(model, "Troncon");

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
    const service = monter(model, "Troncon");

    const created = await service.create({ nom: "Nouveau tronçon" }, "user-2");

    expect(created.nom).toBe("Nouveau tronçon");
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-2", action: "CREATE", entityType: "Troncon", entityId: created.id })
    );
  });

  it("create() enregistre la provenance des champs saisis", async () => {
    // L'asymetrie constatee le 05/09 : une modification tracait sa provenance, une
    // creation non — alors que c'est a la creation que TOUS les champs de decision
    // recoivent leur premiere valeur.
    const model = makeFakeModel([]);
    const service = monter(model, "Troncon");

    await service.create({ nom: "RN99", etat: "BON", revetement: "TERRE" }, "user-4");

    expect(prisma.valeurQualite.upsert).toHaveBeenCalledTimes(3);
    expect(prisma.valeurQualite.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ statut: "OBSERVED", observedById: "user-4" }),
      }),
    );
  });

  it("create() n'ecrit aucune provenance pour une entite hors perimetre", async () => {
    const model = makeFakeModel([]);
    const service = monter(model, "Marche");

    await service.create({ statut: "PLANIFIE" }, "user-4");

    expect(prisma.valeurQualite.upsert).not.toHaveBeenCalled();
  });

  it("list({ archived: true }) renvoie uniquement les lignes soft-deleted", async () => {
    const model = makeFakeModel([
      { id: "a", nom: "Tronçon A", deletedAt: null },
      { id: "b", nom: "Tronçon B", deletedAt: new Date() },
    ]);
    const service = monter(model, "Troncon");

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
    const service = monter(model, "Troncon");

    const result = await service.bulkRemove(["a", "b", "inexistant"], "user-3");

    expect(result.success).toBe(2);
    expect(result.failed).toEqual([{ id: "inexistant", message: "Troncon introuvable" }]);
    const stillThereA = await model.findUnique({ where: { id: "a" } });
    expect((stillThereA as { deletedAt: Date | null }).deletedAt).not.toBeNull();
  });

  it("update() refuse une entite archivee — donnee retirée, donnee figée (P2-01)", async () => {
    const model = makeFakeModel([
      { id: "a", nom: "Tronçon A", deletedAt: new Date() },
    ]);
    const service = monter(model, "Troncon");

    await expect(service.update("a", { nom: "X" }, "user-1")).rejects.toMatchObject({ status: 404 });
    expect(model.update).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("update() accepte une entite active et audite", async () => {
    const model = makeFakeModel([
      { id: "a", nom: "Tronçon A", deletedAt: null },
    ]);
    const service = monter(model, "Troncon");

    const updated = await service.update("a", { nom: "B" }, "user-1");
    expect((updated as { nom: string }).nom).toBe("B");
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "UPDATE" }));
  });

  it("update() enregistre la provenance des champs saisis", async () => {
    // Le defaut d'origine : une correction faite depuis l'interface laissait sa ligne
    // de qualite intacte, et la base affirmait « absent de la source » pour une
    // valeur qu'un agent venait de taper.
    const model = makeFakeModel([{ id: "a", etat: "MOYEN", deletedAt: null }]);
    const service = monter(model, "Troncon");

    await service.update("a", { etat: "BON" }, "user-7");

    expect(prisma.valeurQualite.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { entityType_entityId_champ: { entityType: "Troncon", entityId: "a", champ: "etat" } },
        create: expect.objectContaining({ statut: "OBSERVED", observedById: "user-7" }),
      }),
    );
  });

  it("update() n'invente aucune provenance pour un champ non suivi", async () => {
    const model = makeFakeModel([{ id: "a", observations: "x", deletedAt: null }]);
    const service = monter(model, "Troncon");

    await service.update("a", { observations: "y" }, "user-7");

    expect(prisma.valeurQualite.upsert).not.toHaveBeenCalled();
  });

  it("update() ne suit rien sur une entite hors perimetre", async () => {
    const model = makeFakeModel([{ id: "m", statut: "X", deletedAt: null }]);
    const service = monter(model, "Marche");

    await service.update("m", { statut: "Y" }, "user-7");

    expect(prisma.valeurQualite.upsert).not.toHaveBeenCalled();
  });

  it("bulkRestore() reactive plusieurs lignes archivees", async () => {
    const model = makeFakeModel([
      { id: "a", nom: "Tronçon A", deletedAt: new Date() },
      { id: "b", nom: "Tronçon B", deletedAt: new Date() },
    ]);
    const service = monter(model, "Troncon");

    const result = await service.bulkRestore(["a", "b"], "user-4");

    expect(result.success).toBe(2);
    expect(result.failed).toHaveLength(0);
    const restored = await service.list({});
    expect(restored.data).toHaveLength(2);
  });
});
