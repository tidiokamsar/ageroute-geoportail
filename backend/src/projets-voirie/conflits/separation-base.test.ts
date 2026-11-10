import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("../../lib/prisma", () => ({ prisma: {} }));

import { separationRefuseeParLaBase } from "./dossiers.service";
import { ErreurMetier } from "../erreurs";

/** Observation O-5 du lot C1 : le refus de la contrainte cpd_separation de la base doit rendre 409, jamais 500. */
describe("separation des taches controlee par la base (defense en profondeur)", () => {
  it("le refus de la contrainte cpd_separation devient 409 SEPARATION_DES_TACHES", () => {
    const e = new Prisma.PrismaClientUnknownRequestError('new row for relation "conflits_projet_decisions" violates check constraint "cpd_separation"', { clientVersion: "5" });
    const r = separationRefuseeParLaBase(e);
    expect(r).toBeInstanceOf(ErreurMetier);
    expect(r).toMatchObject({ status: 409, code: "SEPARATION_DES_TACHES" });
  });

  it("toute autre erreur reste inchangee (null : relancee telle quelle)", () => {
    expect(separationRefuseeParLaBase(new Error("violates check constraint \"autre_contrainte\""))).toBeNull();
    expect(separationRefuseeParLaBase(new Error("connexion refusee"))).toBeNull();
    expect(separationRefuseeParLaBase("chaine")).toBeNull();
  });
});
