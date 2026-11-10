import { describe, expect, it, vi } from "vitest";

const appels: string[] = [];
vi.mock("../../lib/prisma", () => ({ prisma: new Proxy({}, { get: (_t, k: string) => { appels.push(k); return new Proxy({}, { get: () => async () => null }); } }) }));

import { ecrireConfiguration } from "./configuration.service";

/** Decision de l'architecte (10/11/2026) : PUT /configuration/:cle exige une justification de 10 caracteres au moins (422 JUSTIFICATION_REQUISE), avant toute lecture. */
describe("configuration : justification obligatoire", () => {
  const admin = { id: "u-a", role: "ADMIN" };
  it("absente, vide ou trop courte : 422 JUSTIFICATION_REQUISE, aucune lecture de la base", async () => {
    for (const j of [undefined, "", "   ", "court"]) {
      await expect(ecrireConfiguration(admin, "PROTECTIONS", {}, j)).rejects.toMatchObject({ status: 422, code: "JUSTIFICATION_REQUISE" });
    }
    expect(appels).toEqual([]);
  });
  it("une cle inconnue reste 404 CLE_INCONNUE (avant la justification)", async () => {
    await expect(ecrireConfiguration(admin, "VILLES", {}, undefined)).rejects.toMatchObject({ status: 404, code: "CLE_INCONNUE" });
  });
});
