import { prisma } from "../../lib/prisma";
import { createCrudService, type ListParams } from "../../lib/crud-factory";
import { ApiError } from "../../middleware/error.middleware";
import { decomptesService } from "./decomptes.service";

const defaultInclude = {
  bailleur: true,
  chantiers: { include: { chantier: true, troncon: true } },
  avancements: { orderBy: { periode: "desc" as const }, take: 1 },
  _count: { select: { avancements: true } },
};

const base = createCrudService(prisma.marche, "Marche", defaultInclude);

interface MarcheListParams extends ListParams {
  search?: string;
  statut?: string;
  bailleurId?: number;
}

async function list(params: MarcheListParams) {
  const where: Record<string, unknown> = { ...params.where };
  if (params.search) where.intitule = { contains: params.search, mode: "insensitive" };
  if (params.statut) where.statut = params.statut;
  if (params.bailleurId) where.bailleurId = params.bailleurId;
  const result = await base.list({ ...params, where });
  const rows = result.data as { id: string }[];
  const decaisses = await decomptesService.sumByMarche(rows.map((r) => r.id));
  return {
    ...result,
    data: rows.map((r) => ({ ...r, montantDecaisse: (decaisses.get(r.id) ?? BigInt(0)).toString() })),
  };
}

async function getById(id: string) {
  const item = await base.getById(id) as { id: string };
  const decaisses = await decomptesService.sumByMarche([id]);
  return { ...item, montantDecaisse: (decaisses.get(id) ?? BigInt(0)).toString() };
}

// montantTotal est BigInt côté Prisma (précision GNF) mais number côté API/Zod.
function toDbPayload(data: Record<string, unknown>): Record<string, unknown> {
  const { montantTotal, ...rest } = data;
  return montantTotal !== undefined
    ? { ...rest, montantTotal: montantTotal === null ? null : BigInt(Math.round(Number(montantTotal))) }
    : rest;
}

async function create(data: Record<string, unknown>, userId: string) {
  return base.create(toDbPayload(data), userId);
}

async function update(id: string, data: Record<string, unknown>, userId: string) {
  return base.update(id, toDbPayload(data), userId);
}

async function attachChantier(marcheId: string, chantierId: string, tronconId: string | undefined, userId: string) {
  await base.getById(marcheId); // 404 si marché introuvable/archivé
  const chantier = await prisma.chantier.findFirst({ where: { id: chantierId, deletedAt: null } });
  if (!chantier) throw new ApiError(404, "Chantier introuvable");

  const link = await prisma.marcheChantier.upsert({
    where: { marcheId_chantierId: { marcheId, chantierId } },
    create: { marcheId, chantierId, tronconId: tronconId ?? chantier.tronconId },
    update: { tronconId: tronconId ?? chantier.tronconId },
  });
  const { logAudit } = await import("../../utils/audit");
  await logAudit({ userId, action: "UPDATE", entityType: "Marche", entityId: marcheId, after: { attachedChantier: chantierId } });
  return link;
}

async function detachChantier(marcheId: string, chantierId: string, userId: string) {
  await prisma.marcheChantier.delete({ where: { marcheId_chantierId: { marcheId, chantierId } } }).catch(() => {
    throw new ApiError(404, "Liaison introuvable");
  });
  const { logAudit } = await import("../../utils/audit");
  await logAudit({ userId, action: "UPDATE", entityType: "Marche", entityId: marcheId, after: { detachedChantier: chantierId } });
}

async function listAvancements(marcheId: string) {
  await base.getById(marcheId);
  return prisma.avancementMarche.findMany({ where: { marcheId }, orderBy: { periode: "asc" } });
}

async function upsertAvancement(marcheId: string, data: {
  periode: Date; avancementPhysiquePrevu: number; avancementPhysiqueReel: number;
  avancementFinancierPrevu: number; avancementFinancierReel: number;
}, userId: string) {
  await base.getById(marcheId);
  const periode = new Date(Date.UTC(data.periode.getUTCFullYear(), data.periode.getUTCMonth(), 1));
  const { periode: _omit, ...rest } = data;
  const saved = await prisma.avancementMarche.upsert({
    where: { marcheId_periode: { marcheId, periode } },
    create: { marcheId, periode, ...rest },
    update: { ...rest },
  });
  const { logAudit } = await import("../../utils/audit");
  await logAudit({ userId, action: "UPDATE", entityType: "Marche", entityId: marcheId, after: { avancementPeriode: periode.toISOString() } });
  return saved;
}

async function listBailleurs() {
  return prisma.bailleur.findMany({
    orderBy: { nom: "asc" },
    include: { _count: { select: { marches: true } } },
  });
}

async function createBailleur(data: { nom: string; type: string }) {
  return prisma.bailleur.create({ data });
}

async function updateBailleur(id: number, data: { nom?: string; type?: string }) {
  const existing = await prisma.bailleur.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "Bailleur introuvable");
  return prisma.bailleur.update({ where: { id }, data });
}

async function deleteBailleur(id: number) {
  const marcheCount = await prisma.marche.count({ where: { bailleurId: id } });
  if (marcheCount > 0) {
    throw new ApiError(409, `Impossible de supprimer : ${marcheCount} marché(s) rattaché(s) à ce bailleur.`);
  }
  await prisma.bailleur.delete({ where: { id } }).catch(() => {
    throw new ApiError(404, "Bailleur introuvable");
  });
}

export const marchesService = {
  ...base,
  list,
  getById,
  create,
  update,
  attachChantier,
  detachChantier,
  listAvancements,
  upsertAvancement,
  listBailleurs,
  createBailleur,
  updateBailleur,
  deleteBailleur,
};
