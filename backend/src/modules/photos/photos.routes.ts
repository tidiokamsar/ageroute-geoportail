import { Router } from "express";
import { existsSync } from "fs";
import { requireAuth } from "../../middleware/auth.middleware";
import { prisma } from "../../lib/prisma";
import { photoAbsolutePath } from "../../lib/photos";
import { modulesAutorisesDe, moduleAutorise } from "../../lib/access";
import type { ModuleKey } from "../../lib/modules";
import { ApiError } from "../../middleware/error.middleware";

// P1-02 — Chaîne d'autorisation du service de fichiers photo.
//
// Avant : tout utilisateur authentifié pouvait obtenir n'importe quel fichier
// photo en connaissant son nom. Connaître un identifiant ne doit pas suffire :
// le fichier n'est servi que si l'utilisateur a accès au MODULE de l'objet auquel
// la photo appartient (OT, ouvrage ou inspection).
//
// Utilisateur → authentification → objet propriétaire → module → permission → fichier.
//
// Comportement uniforme : photo inconnue, photo retirée logiquement, photo d'un
// objet supprimé et photo d'un module interdit reçoivent toutes le même 404 —
// la réponse ne révèle pas l'existence d'une ressource protégée.
export const photosRouter = Router();
photosRouter.use(requireAuth);

// Exportée pour les tests d'autorisation (P1-06) : la résolution propriétaire→module
// est la pièce à non-régression du endpoint.
export async function moduleProprietaire(filename: string): Promise<ModuleKey | null> {
  const [ot, ouvrage, inspection] = await Promise.all([
    prisma.otPhoto.findFirst({ where: { fileName: filename, deletedAt: null }, select: { id: true } }),
    prisma.ouvrage.findFirst({ where: { photos: { has: filename }, deletedAt: null }, select: { id: true } }),
    prisma.inspection.findFirst({ where: { photos: { has: filename }, deletedAt: null }, select: { id: true } }),
  ]);
  if (ot) return "ordres-travaux";
  if (ouvrage) return "ouvrages";
  if (inspection) return "inspections";
  return null;
}

photosRouter.get("/:filename", async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    // basename dans photoAbsolutePath : le paramètre ne désigne qu'un nom de fichier.
    const absolute = photoAbsolutePath(req.params.filename);
    const module = await moduleProprietaire(req.params.filename);
    if (!module) throw new ApiError(404, "Photo introuvable");
    const modules = await modulesAutorisesDe(req.user);
    if (!moduleAutorise(modules, module)) throw new ApiError(404, "Photo introuvable");
    if (!existsSync(absolute)) throw new ApiError(404, "Photo introuvable");
    res.sendFile(absolute);
  } catch (err) { next(err); }
});
