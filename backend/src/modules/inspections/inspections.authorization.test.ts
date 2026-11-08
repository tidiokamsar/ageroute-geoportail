import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Response } from "express";

const db = vi.hoisted(() => ({ inspection: { findFirst: vi.fn() } }));
vi.mock("../../lib/prisma", () => ({ prisma: db }));

vi.mock("./inspections.service", () => ({
  inspectionsService: {
    update: vi.fn(async (_id: string, data: unknown) => data),
    addPhoto: vi.fn(async (_id: string, filename: string) => ({ filename })),
    removePhoto: vi.fn(async (_id: string, filename: string) => ({ filename })),
  },
}));
// Le corps n'est pas le sujet ici : il passe tel quel. Mais `manquesInspection` est la VRAIE
// regle, importee telle quelle, pour que les tests de la ligne fusionnee la mesurent.
vi.mock("./inspections.schema", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inspections.schema")>()),
  inspectionUpdateSchema: { parse: (x: unknown) => x },
}));

import { updateHandler, addPhotoHandler, removePhotoHandler } from "./inspections.controller";

function fakeReq(user: { id: string; role: string } | null, id = "ins-1") {
  return { params: { id }, body: { observations: "modif" }, user } as never;
}
const fakeRes = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() }) as unknown as Response;
const next = vi.fn();

describe("PUT /inspections/:id — propriété (P1-05)", () => {
  beforeEach(() => { vi.clearAllMocks(); next.mockReset(); });

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

  // CE TEST AFFIRMAIT « sans même la consulter au préalable ». Ce n'est plus vrai, et c'est
  // voulu (15/10/2026) : les regles d'une inspection POST_TRAVAUX se jugent sur la ligne
  // FUSIONNEE, qu'il faut donc lire pour tout role. Ce qui reste vrai, et que ce test defend :
  // un ADMIN modifie l'inspection d'un autre.
  it("un ADMIN modifie toute inspection, y compris celle d'un autre", async () => {
    db.inspection.findFirst.mockResolvedValue({ inspecteurId: "u-autre" });
    const res = fakeRes();
    await updateHandler(fakeReq({ id: "u-admin", role: "ADMIN" }), res, next);
    expect(res.json).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("une inspection inexistante reste un 404, même pour un INSPECTEUR -- et pour un ADMIN", async () => {
    db.inspection.findFirst.mockResolvedValue(null);
    await updateHandler(fakeReq({ id: "u-insp", role: "INSPECTEUR" }), fakeRes(), next);
    expect(next.mock.calls[0][0]).toMatchObject({ status: 404 });
    next.mockReset();
    await updateHandler(fakeReq({ id: "u-admin", role: "ADMIN" }), fakeRes(), next);
    expect(next.mock.calls[0][0]).toMatchObject({ status: 404 });
  });
});

describe("PUT /inspections/:id — regles post-travaux sur la ligne fusionnee", () => {
  beforeEach(() => { vi.clearAllMocks(); next.mockReset(); });

  const req = (body: Record<string, unknown>) =>
    ({ params: { id: "ins-1" }, body, user: { id: "u-gest", role: "GESTIONNAIRE" } }) as never;

  it("passer une inspection en POST_TRAVAUX sans reference ni photo : 400 qui nomme les manques, rien n'est ecrit", async () => {
    db.inspection.findFirst.mockResolvedValue({ inspecteurId: "u-insp", type: "GENERALE", interventionRef: null, photos: [], etatObserve: "BON", iriEstime: null, iriMethode: null });
    const res = fakeRes();
    await updateHandler(req({ type: "POST_TRAVAUX" }), res, next);
    const err = next.mock.calls[0][0];
    expect(err).toMatchObject({ status: 400 });
    expect(err.message).toMatch(/cite l'intervention/);
    expect(err.message).toMatch(/au moins une photo/);
    expect(res.json).not.toHaveBeenCalled();
  });

  it("la reference envoyee et la photo deja enregistree se completent : la ligne fusionnee passe", async () => {
    db.inspection.findFirst.mockResolvedValue({ inspecteurId: "u-insp", type: "GENERALE", interventionRef: null, photos: ["apres.jpg"], etatObserve: "BON", iriEstime: null, iriMethode: null });
    const res = fakeRes();
    await updateHandler(req({ type: "POST_TRAVAUX", interventionRef: "INT-2026-0007" }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalled();
  });

  it("une inspection post-travaux existante ne peut pas repasser en NON_EVALUE", async () => {
    db.inspection.findFirst.mockResolvedValue({ inspecteurId: "u-insp", type: "POST_TRAVAUX", interventionRef: "INT-1", photos: ["a.jpg"], etatObserve: "BON", iriEstime: null, iriMethode: null });
    await updateHandler(req({ etatObserve: "NON_EVALUE" }), fakeRes(), next);
    expect(next.mock.calls[0][0]).toMatchObject({ status: 400 });
    expect(next.mock.calls[0][0].message).toMatch(/se mesure/);
  });

  it("un IRI envoye seul alors que la methode est deja enregistree : accepte", async () => {
    db.inspection.findFirst.mockResolvedValue({ inspecteurId: "u-insp", type: "GENERALE", interventionRef: null, photos: [], etatObserve: "MOYEN", iriEstime: "3.10", iriMethode: "smartphone_experimental" });
    const res = fakeRes();
    await updateHandler(req({ iriEstime: 3.4 }), res, next);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("photos d'inspection — contrôle du propriétaire", () => {
  beforeEach(() => { vi.clearAllMocks(); next.mockReset(); });

  it("un INSPECTEUR ne peut pas joindre une photo à l'inspection d'un autre", async () => {
    db.inspection.findFirst.mockResolvedValue({ inspecteurId: "u-autre" });
    const req = { params: { id: "ins-1" }, user: { id: "u-insp", role: "INSPECTEUR" }, file: { filename: "preuve.jpg", path: "C:\\missing-proof.jpg" } } as never;

    await addPhotoHandler(req, fakeRes(), next);

    expect(next.mock.calls[0][0]).toMatchObject({ status: 404 });
    const { inspectionsService } = await import("./inspections.service");
    expect(inspectionsService.addPhoto).not.toHaveBeenCalled();
  });

  it("un INSPECTEUR ne peut pas retirer une photo de l'inspection d'un autre", async () => {
    db.inspection.findFirst.mockResolvedValue({ inspecteurId: "u-autre" });
    const req = { params: { id: "ins-1", filename: "preuve.jpg" }, user: { id: "u-insp", role: "INSPECTEUR" } } as never;

    await removePhotoHandler(req, fakeRes(), next);

    expect(next.mock.calls[0][0]).toMatchObject({ status: 404 });
    const { inspectionsService } = await import("./inspections.service");
    expect(inspectionsService.removePhoto).not.toHaveBeenCalled();
  });

  it("l'INSPECTEUR propriétaire peut joindre une photo", async () => {
    db.inspection.findFirst.mockResolvedValue({ inspecteurId: "u-insp" });
    const res = fakeRes();
    const req = { params: { id: "ins-1" }, user: { id: "u-insp", role: "INSPECTEUR" }, file: { filename: "preuve.jpg", path: "C:\\missing-proof.jpg" } } as never;

    await addPhotoHandler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(next).not.toHaveBeenCalled();
  });
});
