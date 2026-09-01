import { prisma } from "../../lib/prisma";
import { ApiError } from "../../middleware/error.middleware";
import { logAudit } from "../../utils/audit";

async function ensureMarcheExists(marcheId: string) {
  const marche = await prisma.marche.findFirst({ where: { id: marcheId, deletedAt: null } });
  if (!marche) throw new ApiError(404, "Marché introuvable");
}

async function list(marcheId: string) {
  await ensureMarcheExists(marcheId);
  return prisma.decompte.findMany({ where: { marcheId }, orderBy: { numero: "asc" } });
}

async function create(marcheId: string, data: {
  numero: number; type: string; montantGnf: number; dateEmission?: Date;
  datePaiement?: Date; statut: string; observations?: string;
}, userId: string) {
  await ensureMarcheExists(marcheId);
  const created = await prisma.decompte.create({
    data: {
      marcheId,
      numero: data.numero,
      type: data.type as "AVANCE" | "DECOMPTE" | "RETENUE_GARANTIE" | "SOLDE",
      montantGnf: BigInt(Math.round(data.montantGnf)),
      dateEmission: data.dateEmission,
      datePaiement: data.datePaiement,
      statut: data.statut as "EMIS" | "PAYE" | "REJETE",
      observations: data.observations,
    },
  });
  await logAudit({ userId, action: "CREATE", entityType: "Decompte", entityId: created.id, after: created });
  return created;
}

async function update(id: string, data: Partial<{
  numero: number; type: string; montantGnf: number; dateEmission?: Date;
  datePaiement?: Date; statut: string; observations?: string;
}>, userId: string) {
  const before = await prisma.decompte.findUnique({ where: { id } });
  if (!before) throw new ApiError(404, "Décompte introuvable");

  const payload: Record<string, unknown> = { ...data };
  if (data.montantGnf !== undefined) payload.montantGnf = BigInt(Math.round(data.montantGnf));

  const updated = await prisma.decompte.update({ where: { id }, data: payload });
  await logAudit({ userId, action: "UPDATE", entityType: "Decompte", entityId: id, before, after: updated });
  return updated;
}

async function remove(id: string, userId: string) {
  const before = await prisma.decompte.findUnique({ where: { id } });
  if (!before) throw new ApiError(404, "Décompte introuvable");
  await prisma.decompte.delete({ where: { id } });
  await logAudit({ userId, action: "DELETE", entityType: "Decompte", entityId: id, before });
}

// Agrégat décaissé (statut PAYE) par marché — utilisé pour enrichir la liste/detail des marchés
async function sumByMarche(marcheIds: string[]): Promise<Map<string, bigint>> {
  if (marcheIds.length === 0) return new Map();
  const rows = await prisma.decompte.groupBy({
    by: ["marcheId"],
    where: { marcheId: { in: marcheIds }, statut: "PAYE" },
    _sum: { montantGnf: true },
  });
  return new Map(rows.map((r) => [r.marcheId, r._sum.montantGnf ?? BigInt(0)]));
}

// Agrégat engagé/décaissé par bailleur — alimente le tableau de bord exécutif
async function sumByBailleur(): Promise<{ bailleurId: number | null; bailleurNom: string; engage: bigint; decaisse: bigint }[]> {
  const marches = await prisma.marche.findMany({
    where: { deletedAt: null },
    select: { id: true, bailleurId: true, montantTotal: true, bailleur: { select: { nom: true } } },
  });
  const decaisses = await sumByMarche(marches.map((m) => m.id));

  const byBailleur = new Map<number | string, { bailleurId: number | null; bailleurNom: string; engage: bigint; decaisse: bigint }>();
  for (const m of marches) {
    const key = m.bailleurId ?? "none";
    const entry = byBailleur.get(key) ?? { bailleurId: m.bailleurId, bailleurNom: m.bailleur?.nom ?? "Non renseigné", engage: BigInt(0), decaisse: BigInt(0) };
    entry.engage += m.montantTotal ?? BigInt(0);
    entry.decaisse += decaisses.get(m.id) ?? BigInt(0);
    byBailleur.set(key, entry);
  }
  return Array.from(byBailleur.values());
}

export const decomptesService = { list, create, update, remove, sumByMarche, sumByBailleur };
