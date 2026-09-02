import path from "path";
import { ApiError } from "../middleware/error.middleware";
import { logAudit } from "../utils/audit";
import { PHOTOS_UPLOAD_DIR } from "../middleware/upload-photo.middleware";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrismaDelegate = any;

/**
 * Ajout/retrait de photos partage par Ouvrage et Inspection (tous deux ont un champ
 * `photos String[]`) : evite de dupliquer la meme logique de tableau dans chaque service.
 *
 * P1-02 : chaque ajout et chaque retrait est desormais audite (regle 3 d'AGENTS.md) —
 * une photo retiree sans trace etait une disparition de preuve invisible.
 */
export function createPhotoService(model: PrismaDelegate, entityName: string) {
  async function addPhoto(id: string, filename: string, userId: string) {
    const item = await model.findFirst({ where: { id, deletedAt: null }, select: { photos: true } });
    if (!item) throw new ApiError(404, `${entityName} introuvable`);
    const updated = await model.update({ where: { id }, data: { photos: [...item.photos, filename] } });
    await logAudit({ userId, action: "CREATE", entityType: `${entityName}Photo`, entityId: id, after: { filename } });
    return updated;
  }

  async function removePhoto(id: string, filename: string, userId: string) {
    const item = await model.findFirst({ where: { id, deletedAt: null }, select: { photos: true } });
    if (!item) throw new ApiError(404, `${entityName} introuvable`);
    if (!item.photos.includes(filename)) throw new ApiError(404, "Photo introuvable");
    const updated = await model.update({ where: { id }, data: { photos: item.photos.filter((p: string) => p !== filename) } });
    await logAudit({ userId, action: "DELETE", entityType: `${entityName}Photo`, entityId: id, before: { filename } });
    return updated;
  }

  return { addPhoto, removePhoto };
}

export function photoAbsolutePath(filename: string): string {
  // Empeche la traversee de repertoire (ex: filename = "../../etc/passwd") : seul le nom
  // de base est conserve, peu importe ce que le client envoie.
  return path.join(PHOTOS_UPLOAD_DIR, path.basename(filename));
}
