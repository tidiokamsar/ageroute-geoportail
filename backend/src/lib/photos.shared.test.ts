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
 * `createPhotoService` ecrit desormais la liste ET sa trace dans une meme transaction :
 * son option `auditTransactionnel` a disparu, la branche fail-soft etant devenue du code
 * mort. La forme TABLEAU suffit ici — l'audit n'enregistre qu'un nom de fichier, pas une
 * ligne de base, donc il n'y a aucune fidelite a restaurer.
 */
vi.mock("./prisma", () => ({
  prisma: {
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
  },
}));

import { createPhotoService } from "./photos";
import { logAudit } from "../utils/audit";

function makeModel(photos: string[]) {
  const state = { photos: [...photos] };
  return {
    state,
    findFirst: vi.fn(async () => ({ photos: state.photos })),
    update: vi.fn(async ({ data }: { data: { photos: string[] } }) => {
      state.photos = data.photos;
      return { photos: state.photos };
    }),
  };
}

describe("createPhotoService — audit des ajouts et retraits (P1-02)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("addPhoto() journalise l'ajout avec son acteur", async () => {
    const model = makeModel(["a.jpg"]);
    const svc = createPhotoService(model as never, "Ouvrage");
    await svc.addPhoto("ov-1", "b.jpg", "user-7");
    expect(model.state.photos).toEqual(["a.jpg", "b.jpg"]);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "CREATE", entityType: "OuvragePhoto", entityId: "ov-1", userId: "user-7",
    }));
  });

  it("removePhoto() journalise le retrait — plus de disparition de preuve invisible", async () => {
    const model = makeModel(["a.jpg", "b.jpg"]);
    const svc = createPhotoService(model as never, "Inspection");
    await svc.removePhoto("ins-1", "a.jpg", "user-7");
    expect(model.state.photos).toEqual(["b.jpg"]);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "DELETE", entityType: "InspectionPhoto", entityId: "ins-1", userId: "user-7",
    }));
  });

  it("removePhoto() d'un nom absent → 404, sans écriture ni audit", async () => {
    const model = makeModel(["a.jpg"]);
    const svc = createPhotoService(model as never, "Ouvrage");
    await expect(svc.removePhoto("ov-1", "intru.jpg", "user-7")).rejects.toMatchObject({ status: 404 });
    expect(model.update).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });
});
