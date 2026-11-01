import { describe, expect, it, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  otPhoto: { findFirst: vi.fn() },
  ouvrage: { findFirst: vi.fn() },
  inspection: { findFirst: vi.fn() },
  mediaDefaut: { findFirst: vi.fn() },
  mediaObservation: { findFirst: vi.fn() },
  mission: { findMany: vi.fn(async () => []) },
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
    db.mediaDefaut.findFirst.mockResolvedValue(null);
    db.mediaObservation.findFirst.mockResolvedValue(null);
  });

  it("une photo active d'OT appartient au module ordres-travaux", async () => {
    db.otPhoto.findFirst.mockResolvedValue({ id: "ph-1" });
    expect(await moduleProprietaire("a.jpg", { id: "u1", role: "INSPECTEUR" })).toBe("ordres-travaux");
  });

  it("une photo retirée logiquement d'OT n'a plus de propriétaire servi", async () => {
    // findFirst mocké null par défaut : le where { deletedAt: null } exclut la photo.
    expect(await moduleProprietaire("retiree.jpg", { id: "u1", role: "INSPECTEUR" })).toBeNull();
  });

  it("une photo d'ouvrage actif appartient au module ouvrages", async () => {
    db.ouvrage.findFirst.mockResolvedValue({ id: "ov-1" });
    expect(await moduleProprietaire("b.jpg", { id: "u1", role: "INSPECTEUR" })).toBe("ouvrages");
  });

  it("une photo d'inspection active appartient au module inspections", async () => {
    db.inspection.findFirst.mockResolvedValue({ id: "ins-1" });
    expect(await moduleProprietaire("c.jpg", { id: "u1", role: "INSPECTEUR" })).toBe("inspections");
  });

  it("une preuve photo d'un défaut actif appartient au module inspections", async () => {
    db.mediaDefaut.findFirst.mockResolvedValue({ id: "media-1", defaut: { constateParId: "u1", missionId: null } });
    expect(await moduleProprietaire("defaut.jpg", { id: "u1", role: "INSPECTEUR" })).toBe("inspections");
  });

  it("ne sert pas une preuve de défaut hors du périmètre auteur ou mission", async () => {
    db.mediaDefaut.findFirst.mockResolvedValue({ id: "media-1", defaut: { constateParId: "u2", missionId: "m2" } });
    expect(await moduleProprietaire("defaut.jpg", { id: "u1", role: "INSPECTEUR" })).toBeNull();
  });

  it("permet au gestionnaire du module d'accéder à une preuve de défaut", async () => {
    db.mediaDefaut.findFirst.mockResolvedValue({ id: "media-1", defaut: { constateParId: "u2", missionId: "m2" } });
    expect(await moduleProprietaire("defaut.jpg", { id: "u1", role: "GESTIONNAIRE" })).toBe("inspections");
  });

  it("une preuve photo d'observation est servie à son auteur, au responsable et à une mission de l'agent, pas à un tiers", async () => {
    db.mediaObservation.findFirst.mockResolvedValue({ id: "m-1", observation: { agentId: "u1", missionId: null } });
    expect(await moduleProprietaire("obs.jpg", { id: "u1", role: "INSPECTEUR" })).toBe("inspections");
    db.mediaObservation.findFirst.mockResolvedValue({ id: "m-1", observation: { agentId: "u2", missionId: "m2" } });
    expect(await moduleProprietaire("obs.jpg", { id: "u1", role: "INSPECTEUR" })).toBeNull();
    expect(await moduleProprietaire("obs.jpg", { id: "u9", role: "GESTIONNAIRE" })).toBe("inspections");
  });

  it("une preuve photo d'observation dont l'observation est retiree n'est plus servie (le filtre est dans la requete)", async () => {
    // findFirst rend null : le `where` exclut l'observation supprimee logiquement.
    expect(await moduleProprietaire("obs-retiree.jpg", { id: "u1", role: "INSPECTEUR" })).toBeNull();
    expect(db.mediaObservation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { chemin: "obs-retiree.jpg", observation: { deletedAt: null } } }));
  });

  it("un nom de fichier inconnu ne résout vers aucun module", async () => {
    expect(await moduleProprietaire("inconnu.jpg", { id: "u1", role: "INSPECTEUR" })).toBeNull();
  });
});
