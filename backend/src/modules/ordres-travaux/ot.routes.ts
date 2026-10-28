import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireRole } from "../../middleware/rbac.middleware";
import { requireModuleAccess } from "../../middleware/module-access.middleware";
import { requireTerritoire, requireTerritoireMasque } from "../../middleware/territoire.middleware";
import { uploadPhoto } from "../../middleware/upload-photo.middleware";
import { plafondPhotos } from "../../middleware/quota-photos.middleware";
import { prisma } from "../../lib/prisma";
import {
  listHandler, getHandler, createHandler, updateHandler, assignHandler,
  changeStatutHandler, convertirHandler, addPhotoHandler, removePhotoHandler,
  deleteHandler, statsHandler, assignablesHandler,
} from "./ot.controller";
import { territoireConversionOt } from "../../territoire/territoire.v1";
import { regionsCorpsOt, regionsOt } from "../../territoire/territoire.lecture";

export const otRouter = Router();
otRouter.use(requireAuth, requireModuleAccess("ordres-travaux"));

/** Corps de la reponse « introuvable » : le MEME que celui du service pour un identifiant inconnu (`ot.service.ts`). */
const OT_INTROUVABLE = { error: "Ordre de travaux introuvable" };

/**
 * Controle territorial (A10) : un compte regional ne lit et n'ecrit que les OT de sa region. Un OT hors
 * perimetre (ou sans region) est INTROUVABLE pour lui, avec le MEME message que le service pour un OT
 * inconnu (voir `territoire.lecture.ts`). Un compte national passe sans lecture supplementaire.
 */
const horsPerimetre = requireTerritoireMasque((req) => regionsOt(req.params.id), { corps: OT_INTROUVABLE });
// Creation : la region explicite et celle du troncon sont toutes deux touchees ; aucune = region inconnue (refusee).
const creationDansPerimetre = requireTerritoire((req) => regionsCorpsOt(req.body, true));
// Modification : la region d'APRES (deplacement, nouveau troncon) doit aussi etre dans le perimetre.
const modificationDansPerimetre = requireTerritoire((req) => regionsCorpsOt(req.body, false));

/**
 * Un INSPECTEUR n'ecrit que sur les OT qui lui sont assignes ou qu'il a crees. C'est la regle des inspections
 * (P1-05) ; elle manquait a la modification et aux photos : un INSPECTEUR pouvait changer le cout reel ou l'entreprise de
 * n'importe quel OT, ou retirer la preuve photographique d'un OT qui n'etait pas le sien. ADMIN et GESTIONNAIRE ne sont
 * pas concernes.
 *
 * INDISCERNABLE D'UN OT INCONNU (D9, point 5) : un OT qui n'est pas le sien rend 404 avec le MEME corps qu'un
 * identifiant inconnu (avant : 403 pour l'un, 404 ou 400 pour l'autre selon le corps de la requete, ce qui disait a
 * l'INSPECTEUR quels identifiants existent). L'OT inexistant est donc refuse ICI, avant la validation du corps. Un
 * INSPECTEUR lit pourtant tous les OT de son perimetre (`GET /:id`) : ce n'est pas un secret de lecture, c'est la
 * coherence de la reponse d'ecriture. Les regles plus fines du service (changement de statut : assigne seulement)
 * restent en defense en profondeur et parlent a l'agent pour SES OT.
 */
async function inspecteurSurSonOt(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (req.user?.role !== "INSPECTEUR") { next(); return; }
    const ot = await prisma.ordreTravaux.findFirst({ where: { id: req.params.id, deletedAt: null }, select: { assigneAId: true, creeParId: true } });
    if (!ot || (ot.assigneAId !== req.user.id && ot.creeParId !== req.user.id)) {
      res.status(404).json(OT_INTROUVABLE);
      return;
    }
    next();
  } catch (err) { next(err); }
}

otRouter.get("/", listHandler);
otRouter.get("/stats", statsHandler);
otRouter.get("/assignables", assignablesHandler);
otRouter.get("/:id", horsPerimetre, getHandler);

// Création : ADMIN/GESTIONNAIRE créent prêts à assigner, INSPECTEUR crée en brouillon
otRouter.post("/", requireRole("ADMIN", "GESTIONNAIRE", "INSPECTEUR"), creationDansPerimetre, createHandler);
otRouter.put("/:id", requireRole("ADMIN", "GESTIONNAIRE", "INSPECTEUR"), horsPerimetre, inspecteurSurSonOt, modificationDansPerimetre, updateHandler);
otRouter.post("/:id/assigner", requireRole("ADMIN", "GESTIONNAIRE"), horsPerimetre, assignHandler);
otRouter.post("/:id/statut", requireRole("ADMIN", "GESTIONNAIRE", "INSPECTEUR"), horsPerimetre, inspecteurSurSonOt, changeStatutHandler);
otRouter.post("/:id/convertir-chantier", requireRole("ADMIN", "GESTIONNAIRE"), horsPerimetre, territoireConversionOt, convertirHandler);
otRouter.post(
  "/:id/photos",
  requireRole("ADMIN", "GESTIONNAIRE", "INSPECTEUR"),
  // Avant le televersement : un refus n'ecrit aucun fichier.
  horsPerimetre,
  inspecteurSurSonOt,
  // `OrdreTravaux.photos` est une relation : on compte sans charger les lignes.
  plafondPhotos(async (req) => {
    const ot = await prisma.ordreTravaux.findUnique({
      where: { id: req.params.id }, select: { _count: { select: { photos: true } } },
    });
    return ot ? ot._count.photos : null;
  }),
  uploadPhoto,
  addPhotoHandler,
);
otRouter.delete("/:id/photos/:photoId", requireRole("ADMIN", "GESTIONNAIRE", "INSPECTEUR"), horsPerimetre, inspecteurSurSonOt, removePhotoHandler);
otRouter.delete("/:id", requireRole("ADMIN", "GESTIONNAIRE"), horsPerimetre, deleteHandler);
