import { prisma } from "../../lib/prisma";
import { hashPassword } from "../../utils/password";
import { construireAudit, logAuditTransactionnelle } from "../../utils/audit";
import { ApiError } from "../../middleware/error.middleware";
import { revokeAllForUser } from "../auth/auth.service";
import type { ListParams } from "../../lib/crud-factory";
import type { UserCreateInput, UserUpdateInput } from "./users.schema";

const SAFE_SELECT = {
  id: true,
  email: true,
  nomComplet: true,
  role: true,
  actif: true,
  derniereConnexion: true,
  totpEnabled: true,
  modulesAutorises: true,
  createdAt: true,
  updatedAt: true,
} as const;

interface UserListParams extends ListParams {
  search?: string;
  role?: string;
  actif?: boolean;
}

async function list(params: UserListParams) {
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 20;
  const where: Record<string, unknown> = {};
  if (params.role) where.role = params.role;
  if (params.actif !== undefined) where.actif = params.actif;
  if (params.search) {
    where.OR = [
      { email: { contains: params.search, mode: "insensitive" } },
      { nomComplet: { contains: params.search, mode: "insensitive" } },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: SAFE_SELECT,
      orderBy: { [params.sortBy ?? "createdAt"]: params.sortDir ?? "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.user.count({ where }),
  ]);

  return { data, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

async function getById(id: string) {
  const user = await prisma.user.findUnique({ where: { id }, select: SAFE_SELECT });
  if (!user) throw new ApiError(404, "Utilisateur introuvable");
  return user;
}

async function create(data: UserCreateInput, actorId: string) {
  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  if (existing) throw new ApiError(409, "Un utilisateur avec cet e-mail existe deja");

  const passwordHash = await hashPassword(data.password);
  // Forme interactive : `after` doit etre la ligne rendue. `SAFE_SELECT` la limite deja
  // aux champs publiables — le hachage du mot de passe n'y figure pas, et n'a donc aucune
  // chance de se retrouver dans le journal.
  const created = await prisma.$transaction(async (tx) => {
    const ligne = await tx.user.create({
      data: { email: data.email, nomComplet: data.nomComplet, passwordHash, role: data.role },
      select: SAFE_SELECT,
    });
    await logAuditTransactionnelle(tx, {
      userId: actorId, action: "CREATE", entityType: "User", entityId: ligne.id, after: ligne,
    });
    return ligne;
  });
  return created;
}

async function update(id: string, data: UserUpdateInput, actorId: string) {
  const before = await getById(id);

  // Garde-fou : on ne peut pas se desactiver soi-meme, ni desactiver le dernier ADMIN actif.
  if (data.actif === false) {
    if (id === actorId) throw new ApiError(400, "Vous ne pouvez pas desactiver votre propre compte");
    if (before.role === "ADMIN") {
      const activeAdmins = await prisma.user.count({ where: { role: "ADMIN", actif: true } });
      if (activeAdmins <= 1) throw new ApiError(400, "Impossible de desactiver le dernier administrateur actif");
    }
  }
  if (data.role && data.role !== "ADMIN" && before.role === "ADMIN") {
    const activeAdmins = await prisma.user.count({ where: { role: "ADMIN", actif: true } });
    if (activeAdmins <= 1) throw new ApiError(400, "Impossible de retirer le role du dernier administrateur actif");
  }

  const updated = await prisma.$transaction(async (tx) => {
    const ligne = await tx.user.update({ where: { id }, data, select: SAFE_SELECT });
    await logAuditTransactionnelle(tx, {
      userId: actorId,
      action: "UPDATE",
      entityType: "User",
      entityId: id,
      before,
      after: ligne,
    });
    return ligne;
  });

  // P3-A : la désactivation d'un compte coupe immédiatement toutes ses sessions refresh —
  // avant, les tokens restaient valides jusqu'à leur expiration.
  //
  // CET APPEL RESTE HORS DE LA TRANSACTION, et il doit l'etre : `revokeAllForUser` ouvre
  // desormais la sienne, et Prisma n'imbrique pas les transactions — l'appeler depuis
  // l'interieur ecrirait en dehors, sans que rien ne le signale. Il passe donc apres le
  // commit, ce qui est aussi le bon ordre : le compte est desactive, puis ses sessions
  // sont coupees.
  if (data.actif === false) {
    await revokeAllForUser(id, "ACCOUNT_DEACTIVATED", actorId);
  }
  return updated;
}

async function resetPassword(id: string, password: string, actorId: string) {
  await getById(id);
  const passwordHash = await hashPassword(password);
  // Le nouveau hachage et sa trace partent ensemble. `after` ne porte qu'un marqueur :
  // un journal n'a aucune raison de contenir une empreinte de mot de passe, meme hachee.
  await prisma.$transaction([
    prisma.user.update({ where: { id }, data: { passwordHash } }),
    construireAudit({ userId: actorId, action: "UPDATE", entityType: "User", entityId: id, after: { passwordReset: true } }),
  ]);

  // P3-A : un changement de mot de passe révoque toutes les sessions refresh (politique
  // inchangée depuis l'origine). Hors transaction, pour la raison donnee dans `update`.
  await revokeAllForUser(id, "PASSWORD_RESET", actorId);
}

export const usersService = { list, getById, create, update, resetPassword };
