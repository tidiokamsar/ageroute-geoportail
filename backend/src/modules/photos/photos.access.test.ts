import { describe, expect, it, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  otPhoto: { findFirst: vi.fn() },
  ouvrage: { findFirst: vi.fn() },
  inspection: { findFirst: vi.fn() },
  user: { findUnique: vi.fn() },
}));

vi.mock("../../lib/prisma", () => ({ prisma: db }));
// Coupe la chaine requireAuth -> jwt -> config/env (exit sans .env en CI).
vi.mock("../../middleware/auth.middleware", () => ({ requireAuth: vi.fn() }));

import { moduleProprietaire } from "./photos.routes";

describe("moduleProprietaire — résolution du propriétaire d'un fichier photo (P1-02)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.otPhoto.findFirst.mockResolvedValue(null);
    db.ouvrage.findFirst.mockResolvedValue(null);
    db.inspection.findFirst.mockResolvedValue(null);
  });

  it("une photo active d'OT appartient au module ordres-travaux", async () => {
    db.otPhoto.findFirst.mockResolvedValue({ id: "ph-1" });
    expect(await moduleProprietaire("a.jpg")).toBe("ordres-travaux");
  });

  it("une photo retirée logiquement d'OT n'a plus de propriétaire servi", async () => {
    // findFirst mocké null par défaut : le where { deletedAt: null } exclut la photo.
    expect(await moduleProprietaire("retiree.jpg")).toBeNull();
  });

  it("une photo d'ouvrage actif appartient au module ouvrages", async () => {
    db.ouvrage.findFirst.mockResolvedValue({ id: "ov-1" });
    expect(await moduleProprietaire("b.jpg")).toBe("ouvrages");
  });

  it("une photo d'inspection active appartient au module inspections", async () => {
    db.inspection.findFirst.mockResolvedValue({ id: "ins-1" });
    expect(await moduleProprietaire("c.jpg")).toBe("inspections");
  });

  it("un nom de fichier inconnu ne résout vers aucun module", async () => {
    expect(await moduleProprietaire("inconnu.jpg")).toBeNull();
  });
});
