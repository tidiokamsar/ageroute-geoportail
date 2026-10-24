import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../utils/audit", () => {
  const logAudit = vi.fn();
  // Les chemins transactionnels delegent au MEME espion : les assertions existantes
  // observent donc le chemin reel sans changer de forme.
  return {
    logAudit,
    construireAudit: vi.fn((p: Record<string, unknown>) => {
      logAudit(p);
      return { __audit: p };
    }),
    logAuditTransactionnelle: vi.fn(async (_tx: unknown, p: Record<string, unknown>) => {
      logAudit(p);
    }),
  };
});
vi.mock("../../utils/password", () => ({ hashPassword: vi.fn(async (p: string) => `hashed:${p}`) }));
// users.service importe desormais revokeAllForUser depuis auth.service ; mocker
// ce module evite de charger la chaine jwt/config-env (process.exit sans .env en CI).
vi.mock("../auth/auth.service", () => ({ revokeAllForUser: vi.fn() }));

const userStore = new Map<string, Record<string, unknown>>();

vi.mock("../../lib/prisma", () => {
  const client: Record<string, unknown> = {
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
    // `users.service` ouvre desormais ses propres transactions : la creation et la
    // modification d'un compte partent avec leur trace, ou pas du tout.
    $transaction: vi.fn(async (arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(client)),
  };
  return { prisma: client };
});

import { usersService } from "./users.service";
import { logAudit } from "../../utils/audit";

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

describe("appliquerProfil — un prereglage, pas un chemin parallele", () => {
  /**
   * CE QUE CE BLOC DEFEND
   *
   * Appliquer un profil ecrit `role` et `modulesAutorises`. Les ecrire DIRECTEMENT aurait
   * ete plus court et aurait contourne tous les garde-fous de `update` — et appliquer un
   * profil « Auditeur » au dernier administrateur actif aurait alors suffi a rendre la
   * plateforme ingouvernable, sans que rien ne s'y oppose.
   *
   * `appliquerProfil` delegue donc a `update`. Ces tests verifient que la delegation tient,
   * parce que c'est exactement le genre de raccourci qu'une refonte reprendrait.
   */
  beforeEach(() => {
    // Le magasin ET les espions. Sans le second, `find` ramenait la trace d'un test
    // anterieur : le test passait seul et echouait dans la suite, ce qui est la pire
    // forme d'echec puisqu'elle fait douter du code plutot que du test.
    userStore.clear();
    vi.clearAllMocks();
  });

  it("REFUSE de degrader le dernier administrateur actif", async () => {
    seedUser("admin-1", "ADMIN");
    seedUser("gest-1", "GESTIONNAIRE");
    await expect(usersService.appliquerProfil("admin-1", "AUDITEUR", "gest-1")).rejects.toThrow(
      "Impossible de retirer le role du dernier administrateur actif"
    );
  });

  it("applique le role et les modules du profil", async () => {
    seedUser("u-1", "LECTEUR");
    seedUser("admin-1", "ADMIN");
    const maj = await usersService.appliquerProfil("u-1", "AGENT_TERRAIN", "admin-1");
    expect(maj.role).toBe("INSPECTEUR");
    expect(maj.modulesAutorises).toContain("inspections");
    expect(maj.modulesAutorises).toContain("geoportail");
  });

  it("refuse un code de profil inconnu", async () => {
    seedUser("u-1", "LECTEUR");
    seedUser("admin-1", "ADMIN");
    await expect(usersService.appliquerProfil("u-1", "CHEF_DE_SERVICE", "admin-1"))
      .rejects.toThrow(/Profil inconnu/);
  });

  it("INSCRIT LE PROFIL dans la trace, pas seulement le changement", async () => {
    // Sans le motif, l'audit dirait « le role est passe de LECTEUR a INSPECTEUR et voici
    // cinq modules » sans dire POURQUOI. Le motif voyage dans la MEME ligne : une seconde
    // ligne aurait separe l'acte de son intention, et permis que l'une survive sans
    // l'autre.
    seedUser("u-1", "LECTEUR");
    seedUser("admin-1", "ADMIN");
    await usersService.appliquerProfil("u-1", "AGENT_TERRAIN", "admin-1");

    const trace = vi.mocked(logAudit).mock.calls
      .map((c) => c[0] as unknown as Record<string, unknown>)
      .find((a) => a.entityType === "User" && a.action === "UPDATE");
    expect((trace?.after as Record<string, unknown>)?.motif).toBe("profil:AGENT_TERRAIN");
  });

  it("vide les modules d'un administrateur plateforme, qui n'en a pas besoin", async () => {
    // Son role ne connait aucune restriction : lui en lister laisserait croire qu'on peut
    // lui en retirer.
    seedUser("u-1", "LECTEUR");
    seedUser("admin-1", "ADMIN");
    const maj = await usersService.appliquerProfil("u-1", "ADMIN_PLATEFORME", "admin-1");
    expect(maj.role).toBe("ADMIN");
    expect(maj.modulesAutorises).toEqual([]);
  });
});
