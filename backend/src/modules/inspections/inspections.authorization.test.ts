import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Response } from "express";

const db = vi.hoisted(() => ({ inspection: { findFirst: vi.fn() } }));
vi.mock("../../lib/prisma", () => ({ prisma: db }));

vi.mock("./inspections.service", () => ({
  inspectionsService: { update: vi.fn(async (_id: string, data: unknown) => data) },
}));
vi.mock("./inspections.schema", () => ({
  inspectionUpdateSchema: { parse: (x: unknown) => x },
}));

import { updateHandler } from "./inspections.controller";

function fakeReq(user: { id: string; role: string } | null, id = "ins-1") {
  return { params: { id }, body: { observations: "modif" }, user } as never;
}
const fakeRes = () => ({ json: vi.fn() }) as unknown as Response;
const next = vi.fn();

describe("PUT /inspections/:id — propriété (P1-05)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("un INSPECTEUR modifie SON inspection", async () => {
    db.inspection.findFirst.mockResolvedValue({ inspecteurId: "u-insp" });
    const res = fakeRes();
    await updateHandler(fakeReq({ id: "u-insp", role: "INSPECTEUR" }), res, next);
    expect(res.json).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("un INSPECTEUR ne peut pas modifier l'inspection d'un autre (403)", async () => {
    db.inspection.findFirst.mockResolvedValue({ inspecteurId: "u-autre" });
    await updateHandler(fakeReq({ id: "u-insp", role: "INSPECTEUR" }), fakeRes(), next);
    const err = next.mock.calls[0][0];
    expect(err).toMatchObject({ status: 403 });
  });

  it("un GESTIONNAIRE modifie toute inspection", async () => {
    db.inspection.findFirst.mockResolvedValue({ inspecteurId: "u-autre" });
    const res = fakeRes();
    await updateHandler(fakeReq({ id: "u-gest", role: "GESTIONNAIRE" }), res, next);
    expect(res.json).toHaveBeenCalled();
  });

  it("un ADMIN modifie toute inspection, sans même la consulter au préalable", async () => {
    const res = fakeRes();
    await updateHandler(fakeReq({ id: "u-admin", role: "ADMIN" }), res, next);
    expect(db.inspection.findFirst).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalled();
  });

  it("une inspection inexistante reste un 404, même pour un INSPECTEUR", async () => {
    db.inspection.findFirst.mockResolvedValue(null);
    await updateHandler(fakeReq({ id: "u-insp", role: "INSPECTEUR" }), fakeRes(), next);
    expect(next.mock.calls[0][0]).toMatchObject({ status: 404 });
  });
});
