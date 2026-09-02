import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../utils/audit", () => ({ logAudit: vi.fn() }));
vi.mock("../../utils/password", () => ({ hashPassword: vi.fn(async (p: string) => `hashed:${p}`) }));
// users.service importe desormais revokeAllForUser depuis auth.service ; mocker
// ce module evite de charger la chaine jwt/config-env (process.exit sans .env en CI).
vi.mock("../auth/auth.service", () => ({ revokeAllForUser: vi.fn() }));

const userStore = new Map<string, Record<string, unknown>>();

vi.mock("../../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; email?: string } }) => {
        if (where.id) return userStore.get(where.id) ?? null;
        return [...userStore.values()].find((u) => u.email === where.email) ?? null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const user = userStore.get(where.id);
        if (!user) throw new Error("not found");
        Object.assign(user, data);
        return user;
      }),
      count: vi.fn(async ({ where }: { where: { role?: string; actif?: boolean } }) =>
        [...userStore.values()].filter(
          (u) => (where.role ? u.role === where.role : true) && (where.actif !== undefined ? u.actif === where.actif : true)
        ).length
      ),
    },
    refreshToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
  },
}));

import { usersService } from "./users.service";

function seedUser(id: string, role: string, actif = true) {
  userStore.set(id, { id, email: `${id}@ageroute.gov.gn`, nomComplet: id, role, actif, createdAt: new Date(), updatedAt: new Date() });
}

describe("usersService - regles metier critiques", () => {
  beforeEach(() => {
    userStore.clear();
  });

  it("empeche un utilisateur de desactiver son propre compte", async () => {
    seedUser("admin-1", "ADMIN");
    seedUser("admin-2", "ADMIN");
    await expect(usersService.update("admin-1", { actif: false }, "admin-1")).rejects.toThrow(
      "Vous ne pouvez pas desactiver votre propre compte"
    );
  });

  it("empeche de desactiver le dernier administrateur actif", async () => {
    seedUser("admin-1", "ADMIN");
    seedUser("gest-1", "GESTIONNAIRE");
    await expect(usersService.update("admin-1", { actif: false }, "gest-1")).rejects.toThrow(
      "Impossible de desactiver le dernier administrateur actif"
    );
  });

  it("autorise la desactivation d'un admin s'il en reste un autre actif", async () => {
    seedUser("admin-1", "ADMIN");
    seedUser("admin-2", "ADMIN");
    const updated = await usersService.update("admin-1", { actif: false }, "admin-2");
    expect(updated.actif).toBe(false);
  });

  it("empeche de retirer le role ADMIN du dernier administrateur", async () => {
    seedUser("admin-1", "ADMIN");
    seedUser("gest-1", "GESTIONNAIRE");
    await expect(usersService.update("admin-1", { role: "LECTEUR" }, "gest-1")).rejects.toThrow(
      "Impossible de retirer le role du dernier administrateur actif"
    );
  });
});
