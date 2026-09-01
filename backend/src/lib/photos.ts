import path from "path";
import { ApiError } from "../middleware/error.middleware";
import { PHOTOS_UPLOAD_DIR } from "../middleware/upload-photo.middleware";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrismaDelegate = any;

/**
 * Ajout/retrait de photos partage par Ouvrage et Inspection (tous deux ont un champ
 * `photos String[]`) : evite de dupliquer la meme logique de tableau dans chaque service.
 */
export function createPhotoService(model: PrismaDelegate, entityName: string) {
  async function addPhoto(id: string, filename: string) {
    const item = await model.findFirst({ where: { id, deletedAt: null }, select: { photos: true } });
    if (!item) throw new ApiError(404, `${entityName} introuvable`);
    return model.update({ where: { id }, data: { photos: [...item.photos, filename] } });
  }

  async function removePhoto(id: string, filename: string) {
    const item = await model.findFirst({ where: { id, deletedAt: null }, select: { photos: true } });
    if (!item) throw new ApiError(404, `${entityName} introuvable`);
    return model.update({ where: { id }, data: { photos: item.photos.filter((p: string) => p !== filename) } });
  }

  return { addPhoto, removePhoto };
}

export function photoAbsolutePath(filename: string): string {
  // Empeche la traversee de repertoire (ex: filename = "../../etc/passwd") : seul le nom
  // de base est conserve, peu importe ce que le client envoie.
  return path.join(PHOTOS_UPLOAD_DIR, path.basename(filename));
}
