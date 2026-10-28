import { describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import { Prisma } from "@prisma/client";
import { errorHandler, ApiError } from "./error.middleware";

function fakeRes() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { status, json } as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

describe("errorHandler — mapping des erreurs (P2-02)", () => {
  it("PrismaClientValidationError devient 400, pas 500", () => {
    const res = fakeRes();
    const err = new Prisma.PrismaClientValidationError("Unknown argument `sortBy`", { clientVersion: "5.22" });
    errorHandler(err, {} as never, res, vi.fn() as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining("Paramètre") }));
  });

  it("ApiError garde son statut et son message", () => {
    const res = fakeRes();
    errorHandler(new ApiError(409, "conflit"), {} as never, res, vi.fn() as never);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: "conflit" });
  });

  it("une erreur inconnue reste un 500 générique sans fuite de détail", () => {
    const res = fakeRes();
    errorHandler(new Error("détail interne sensible"), {} as never, res, vi.fn() as never);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Erreur interne du serveur" });
  });

  it("JSON mal forme (body-parser) devient 400 avec un code, pas 500", () => {
    const res = fakeRes();
    const err = Object.assign(new SyntaxError("Unexpected token"), { status: 400, type: "entity.parse.failed", expose: true });
    errorHandler(err, {} as never, res, vi.fn() as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "JSON_INVALIDE" }));
  });

  it("corps trop gros devient 413 avec un code", () => {
    const res = fakeRes();
    const err = Object.assign(new Error("request entity too large"), { status: 413, type: "entity.too.large", expose: true });
    errorHandler(err, {} as never, res, vi.fn() as never);
    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "CORPS_TROP_GROS" }));
  });

  it("une erreur 4xx non exposee reste un 500 generique", () => {
    const res = fakeRes();
    const err = Object.assign(new Error("interne"), { status: 400, expose: false });
    errorHandler(err, {} as never, res, vi.fn() as never);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
