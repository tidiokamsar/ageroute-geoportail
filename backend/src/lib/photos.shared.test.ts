import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../utils/audit", () => ({ logAudit: vi.fn() }));

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
