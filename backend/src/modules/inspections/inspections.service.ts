import { prisma } from "../../lib/prisma";
import { createCrudService, type ListParams } from "../../lib/crud-factory";
import { createPhotoService } from "../../lib/photos";
import { logAudit } from "../../utils/audit";

const base = createCrudService(prisma.inspection, "Inspection", { troncon: true, ouvrage: true, inspecteur: { select: { nomComplet: true } } });
const photos = createPhotoService(prisma.inspection, "Inspection");

interface InspectionListParams extends ListParams {
  tronconId?: string;
  ouvrageId?: string;
}

async function list(params: InspectionListParams) {
  const where: Record<string, unknown> = { ...params.where };
  if (params.tronconId) where.tronconId = params.tronconId;
  if (params.ouvrageId) where.ouvrageId = params.ouvrageId;
  return base.list({ ...params, where });
}

// Boucle metier centrale : une inspection EST le constat humain de l'etat reel d'un
// element. On propage donc l'etat observe a l'element inspecte (troncon ou ouvrage),
// ce qui maintient l'inventaire a jour au lieu de le laisser figer. NON_EVALUE n'est
// volontairement PAS propage : enregistrer "non evalue" lors d'une inspection ne doit
// pas effacer un etat deja connu. Chaque propagation est tracee dans l'audit.
async function propagateEtat(
  data: { tronconId?: string | null; ouvrageId?: string | null; etatObserve?: string; dateInspection?: Date | string },
  userId: string
) {
  if (!data.etatObserve || data.etatObserve === "NON_EVALUE") return;
  const etat = data.etatObserve as never;

  if (data.ouvrageId) {
    const before = await prisma.ouvrage.findUnique({ where: { id: data.ouvrageId }, select: { etat: true } });
    if (before) {
      await prisma.ouvrage.update({
        where: { id: data.ouvrageId },
        data: { etat, derniereInspectionDate: data.dateInspection ? new Date(data.dateInspection) : new Date() },
      });
      await logAudit({
        userId, action: "UPDATE", entityType: "Ouvrage", entityId: data.ouvrageId,
        before: { etat: before.etat }, after: { etat: data.etatObserve, source: "inspection" },
      });
    }
  } else if (data.tronconId) {
    const before = await prisma.troncon.findUnique({ where: { id: data.tronconId }, select: { etat: true } });
    if (before) {
      await prisma.troncon.update({ where: { id: data.tronconId }, data: { etat } });
      await logAudit({
        userId, action: "UPDATE", entityType: "Troncon", entityId: data.tronconId,
        before: { etat: before.etat }, after: { etat: data.etatObserve, source: "inspection" },
      });
    }
  }
}

async function create(data: Record<string, unknown>, userId: string) {
  const created = await base.create(data, userId);
  await propagateEtat(data as Parameters<typeof propagateEtat>[0], userId);
  return created;
}

async function update(id: string, data: Record<string, unknown>, userId: string) {
  const updated = await base.update(id, data, userId);
  // En edition partielle, l'etat observe (et la cible) peuvent ne pas etre dans le payload :
  // on retombe sur les valeurs persistees pour ne pas rater la propagation.
  const full = updated as { tronconId?: string | null; ouvrageId?: string | null; etatObserve?: string; dateInspection?: Date };
  await propagateEtat(
    {
      tronconId: (data.tronconId as string | undefined) ?? full.tronconId,
      ouvrageId: (data.ouvrageId as string | undefined) ?? full.ouvrageId,
      etatObserve: (data.etatObserve as string | undefined) ?? full.etatObserve,
      dateInspection: (data.dateInspection as Date | undefined) ?? full.dateInspection,
    },
    userId
  );
  return updated;
}

export const inspectionsService = { ...base, list, create, update, addPhoto: photos.addPhoto, removePhoto: photos.removePhoto };
