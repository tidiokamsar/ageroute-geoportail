import { prisma } from "../../lib/prisma";
import { createCrudService, type ListParams } from "../../lib/crud-factory";
import { construireAudit, logAuditTransactionnelle } from "../../utils/audit";
import { ApiError } from "../../middleware/error.middleware";
import { decomptesService } from "./decomptes.service";

const defaultInclude = {
  bailleur: true,
  chantiers: { include: { chantier: true, troncon: true } },
  avancements: { orderBy: { periode: "desc" as const }, take: 1 },
  _count: { select: { avancements: true } },
};

/**
 * Migre a l'audit transactionnel (ADR 11). La mutation et sa trace reussissent ou sont
 * annulees ensemble.
 */
const base = createCrudService(prisma.marche, "Marche", defaultInclude, {
  auditTransactionnel: true,
  delegueTransactionnel: (tx) => (tx as typeof prisma).marche,
});

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

  const [link] = await prisma.$transaction([
    prisma.marcheChantier.upsert({
      where: { marcheId_chantierId: { marcheId, chantierId } },
      create: { marcheId, chantierId, tronconId: tronconId ?? chantier.tronconId },
      update: { tronconId: tronconId ?? chantier.tronconId },
    }),
    // L'audit rejoint la liaison : une liaison contractuelle creee sans trace est un
    // rattachement dont personne ne repond.
    construireAudit({ userId, action: "UPDATE", entityType: "Marche", entityId: marcheId, after: { attachedChantier: chantierId } }),
  ]);

  return link;
}

async function detachChantier(marcheId: string, chantierId: string, userId: string) {
  // L'existence est verifiee DANS la transaction, au lieu de convertir l'erreur du
  // delete. Englober la transaction dans un `catch` transformerait aussi un echec
  // d'audit en « liaison introuvable », ce qui enverrait chercher au mauvais endroit.
  await prisma.$transaction(async (tx) => {
    const liaison = await tx.marcheChantier.findUnique({
      where: { marcheId_chantierId: { marcheId, chantierId } },
    });
    if (!liaison) throw new ApiError(404, "Liaison introuvable");
    await tx.marcheChantier.delete({ where: { marcheId_chantierId: { marcheId, chantierId } } });
    await logAuditTransactionnelle(tx, {
      userId, action: "UPDATE", entityType: "Marche", entityId: marcheId,
      after: { detachedChantier: chantierId },
    });
  });
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
  const [saved] = await prisma.$transaction([
    prisma.avancementMarche.upsert({
      where: { marcheId_periode: { marcheId, periode } },
      create: { marcheId, periode, ...rest },
      update: { ...rest },
    }),
    // Un avancement est la base d'un decompte : le tracer importe autant que lui.
    construireAudit({ userId, action: "UPDATE", entityType: "Marche", entityId: marcheId, after: { avancementPeriode: periode.toISOString() } }),
  ]);

  return saved;
}

async function listBailleurs() {
  // Liste opérationnelle (alimente les sélecteurs) : les bailleurs retirés
  // logiquement n'y figurent plus, mais restent joints aux marchés historiques.
  return prisma.bailleur.findMany({
    where: { deletedAt: null },
    orderBy: { nom: "asc" },
    include: { _count: { select: { marches: true } } },
  });
}

async function createBailleur(data: { nom: string; type: string }, userId: string) {
  // Forme interactive : `after` doit etre la ligne que la base a rendue, identifiant
  // auto-incremente compris — il n'existe pas avant l'insertion.
  const created = await prisma.$transaction(async (tx) => {
    const ligne = await tx.bailleur.create({ data });
    await logAuditTransactionnelle(tx, {
      userId, action: "CREATE", entityType: "Bailleur", entityId: String(ligne.id), after: ligne,
    });
    return ligne;
  });
  return created;
}

async function updateBailleur(id: number, data: { nom?: string; type?: string }, userId: string) {
  const before = await prisma.bailleur.findFirst({ where: { id, deletedAt: null } });
  if (!before) throw new ApiError(404, "Bailleur introuvable");
  const updated = await prisma.$transaction(async (tx) => {
    const ligne = await tx.bailleur.update({ where: { id }, data });
    await logAuditTransactionnelle(tx, {
      userId, action: "UPDATE", entityType: "Bailleur", entityId: String(id), before, after: ligne,
    });
    return ligne;
  });
  return updated;
}

async function deleteBailleur(id: number, userId: string) {
  // Le garde-fou compte TOUS les marchés rattachés, archivés compris : un
  // bailleur cité par l'historique financier ne sort jamais du référentiel.
  const marcheCount = await prisma.marche.count({ where: { bailleurId: id } });
  if (marcheCount > 0) {
    throw new ApiError(409, `Impossible de supprimer : ${marcheCount} marché(s) rattaché(s) à ce bailleur.`);
  }
  const before = await prisma.bailleur.findFirst({ where: { id, deletedAt: null } });
  if (!before) throw new ApiError(404, "Bailleur introuvable");
  // Suppression logique uniquement : donnée de référence du patrimoine financier.
  await prisma.$transaction([
    prisma.bailleur.update({ where: { id }, data: { deletedAt: new Date() } }),
    construireAudit({ userId, action: "DELETE", entityType: "Bailleur", entityId: String(id), before }),
  ]);
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
