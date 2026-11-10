import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma", () => ({ prisma: {} }));

import { estFormeMethodeAcquisition } from "../config";
import { exigerMethodeAcquisition } from "../import.service";
import { proposerChampsJeu } from "./mapping.noyau";

/**
 * Correctifs T1+S1, M2 : une seule source de verite pour la methode d'acquisition, le referentiel METHODE_ACQUISITION (lot T1). Le code ne connait
 * que la forme d'un code ; la valeur est verifiee contre le referentiel au depot (valeur ACTIVE et non retiree), et par la base (non retiree).
 */
describe("M2 : methode d'acquisition validee contre le referentiel, pas contre une liste du code", () => {
  it("le mapping propose un code bien forme, meme absent de l'ancienne liste du lot S1 (LIDAR, GNSS) ; une forme invalide n'est jamais proposee", () => {
    const prop = (brut: string) => proposerChampsJeu({ methodeAcquisition: "m" }, new Map([["methodeAcquisition", new Map([[brut, 1]])]])).propositions.methodeAcquisition?.valeur ?? null;
    expect(prop("lidar")).toBe("LIDAR");
    expect(prop("GNSS")).toBe("GNSS");
    expect(prop("LEVE_TOPOGRAPHIQUE")).toBe("LEVE_TOPOGRAPHIQUE");
    expect(prop("x-y")).toBeNull();
    expect(prop("9ABC")).toBeNull();
    expect(estFormeMethodeAcquisition("A".repeat(41))).toBe(false);
  });

  it("depot : une valeur absente, retiree ou inactive du referentiel : 422 METHODE_ACQUISITION_INCONNUE ; une valeur active passe", async () => {
    const actives = new Set(["GNSS", "LIDAR"]);
    const requetes: unknown[] = [];
    const tx = { referentielVoirie: { findFirst: async (a: { where: { domaine: string; code: string; deletedAt: null; actif: boolean } }) => { requetes.push(a.where); return actives.has(a.where.code) ? { id: "x" } : null; } } };
    await expect(exigerMethodeAcquisition(tx as never, "GNSS")).resolves.toBeUndefined();
    await expect(exigerMethodeAcquisition(tx as never, "GEORADAR")).rejects.toMatchObject({ status: 422, code: "METHODE_ACQUISITION_INCONNUE" });
    expect(requetes[0]).toEqual({ domaine: "METHODE_ACQUISITION", code: "GNSS", deletedAt: null, actif: true });
    // Decision de l'architecte (10/11/2026) : un code mal forme est aussi un code absent du referentiel : 422, sans requete.
    const avant = requetes.length;
    await expect(exigerMethodeAcquisition(tx as never, "GNSS-RTK")).rejects.toMatchObject({ status: 422, code: "METHODE_ACQUISITION_INCONNUE" });
    expect(requetes.length).toBe(avant);
  });
});
