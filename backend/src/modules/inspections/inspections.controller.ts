import type { Request, Response, NextFunction } from "express";
import { supprimerTeleversementNonEnregistre } from "../../lib/photos";
import { inspectionsService } from "./inspections.service";
import { inspectionCreateSchema, inspectionUpdateSchema, manquesInspection } from "./inspections.schema";
import { parseListQuery } from "../../lib/list-query";
import { ApiError } from "../../middleware/error.middleware";
import { prisma } from "../../lib/prisma";

export async function listHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const q = parseListQuery(req);
    res.json(await inspectionsService.list({
      page: q.page, pageSize: q.pageSize, sortBy: q.sortBy, sortDir: q.sortDir,
      tronconId: req.query.tronconId as string | undefined,
      ouvrageId: req.query.ouvrageId as string | undefined,
      archived: q.archived,
      where: req.user?.role === "INSPECTEUR" ? { inspecteurId: req.user.id } : {},
    }));
  } catch (err) { next(err); }
}
export async function getHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    if (req.user.role === "INSPECTEUR") {
      const cible = await prisma.inspection.findFirst({
        where: { id: req.params.id, deletedAt: null, inspecteurId: req.user.id },
        select: { id: true },
      });
      if (!cible) throw new ApiError(404, "Inspection introuvable");
    }
    res.json(await inspectionsService.getById(req.params.id));
  } catch (err) { next(err); }
}
export async function createHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    const data = inspectionCreateSchema.parse(req.body);

    // Idempotence (T7). Une inspection deja enregistree sous ce meme identifiant
    // client est RENVOYEE, pas recreee. Le defaut corrige : une coupure pendant
    // l'envoi d'une photo faisait recommencer toute la synchronisation, et chaque
    // reprise fabriquait un doublon sur le module cense produire la donnee du reseau.
    //
    // Le code 200, distinct du 201, dit au client que rien n'a ete cree — il peut
    // reprendre a l'etape des photos sans s'inquieter.
    if (data.clientInspectionId) {
      const existante = await prisma.inspection.findUnique({
        where: { clientInspectionId: data.clientInspectionId },
      });
      if (existante) return res.status(200).json(existante);
    }

    return res.status(201).json(await inspectionsService.create({ ...data, inspecteurId: req.user.id }, req.user.id));
  } catch (err) { return next(err); }
}
export async function updateHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    const data = inspectionUpdateSchema.parse(req.body);
    const cible = await prisma.inspection.findFirst({
      where: { id: req.params.id },
      select: { inspecteurId: true, type: true, interventionRef: true, photos: true, etatObserve: true, iriEstime: true, iriMethode: true },
    });
    if (!cible) throw new ApiError(404, "Inspection introuvable");
    // P1-05 : un INSPECTEUR ne modifie que ses propres inspections. ADMIN et
    // GESTIONNAIRE conservent l'édition sur tout le module.
    if (req.user.role === "INSPECTEUR" && cible.inspecteurId !== req.user.id) {
      throw new ApiError(403, "Seule l'inspection vous appartenant est modifiable");
    }
    // Les regles d'une inspection POST_TRAVAUX se jugent sur la ligne FUSIONNEE : sinon la
    // contrainte en base refuserait en 500, sans dire quoi corriger.
    const manques = manquesInspection({
      type: data.type ?? cible.type,
      interventionRef: data.interventionRef ?? cible.interventionRef,
      photos: data.photos ?? cible.photos,
      etatObserve: data.etatObserve ?? cible.etatObserve,
      // `== null` et non `=== null` : une valeur absente ne doit pas devenir Number(undefined),
      // c'est-a-dire NaN, que la regle prendrait pour un IRI renseigne sans methode.
      iriEstime: data.iriEstime ?? (cible.iriEstime == null ? null : Number(cible.iriEstime)),
      iriMethode: data.iriMethode ?? cible.iriMethode,
    });
    if (manques.length > 0) {
      throw new ApiError(400, manques.map((m) => m.message).join(" "));
    }
    res.json(await inspectionsService.update(req.params.id, data, req.user.id));
  } catch (err) { next(err); }
}
export async function deleteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    await inspectionsService.remove(req.params.id, req.user.id);
    res.status(204).send();
  } catch (err) { next(err); }
}
export async function addPhotoHandler(req: Request, res: Response, next: NextFunction) {
  // Distingue « jamais enregistree » de « enregistree puis probleme ailleurs » :
  // seule la premiere justifie de supprimer le fichier televerse.
  let enregistree = false;
  try {
    if (!req.file) throw new ApiError(400, "Photo manquante");
    if (!req.user) throw new ApiError(401, "Authentification requise");
    if (req.user.role === "INSPECTEUR") {
      const cible = await prisma.inspection.findFirst({
        where: { id: req.params.id, deletedAt: null },
        select: { inspecteurId: true },
      });
      if (!cible || cible.inspecteurId !== req.user.id) {
        throw new ApiError(404, "Inspection introuvable");
      }
    }
    const ajoutee = await inspectionsService.addPhoto(req.params.id, req.file.filename, req.user.id);
    enregistree = true;
    res.status(201).json(ajoutee);
  } catch (err) {
    // Le nettoyage couvre desormais TOUT echec, et plus seulement le 404 de propriete :
    // depuis que l'audit rejoint la transaction, une panne de journalisation fait lever
    // ici. Voir `supprimerTeleversementNonEnregistre`.
    await supprimerTeleversementNonEnregistre(enregistree, req.file);
    next(err);
  }
}
export async function removePhotoHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    if (req.user.role === "INSPECTEUR") {
      const cible = await prisma.inspection.findFirst({
        where: { id: req.params.id, deletedAt: null },
        select: { inspecteurId: true },
      });
      if (!cible || cible.inspecteurId !== req.user.id) throw new ApiError(404, "Inspection introuvable");
    }
    res.json(await inspectionsService.removePhoto(req.params.id, req.params.filename, req.user.id));
  } catch (err) { next(err); }
}
