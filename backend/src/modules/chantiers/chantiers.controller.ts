import type { Request, Response, NextFunction } from "express";
import { chantiersService } from "./chantiers.service";
import { chantierCreateSchema, chantierUpdateSchema } from "./chantiers.schema";
import { parseListQuery } from "../../lib/list-query";
import { ApiError } from "../../middleware/error.middleware";
import { modulesAutorisesDe } from "../../lib/access";
import { filtreRegion, regionsVisibles } from "../../territoire/territoire.lecture";
import { droitMontantsContractuels, masquerFinancesChantiers } from "./chantiers.confidentialite";

/**
 * LECTURES DE CHANTIERS : PERIMETRE ET CONFIDENTIALITE (lot AD-7, constats 3 et 4, D-C1-1).
 *
 *  - un compte REGIONAL ne lit que les chantiers de ses regions (les comptes nationaux ne changent en rien) ;
 *  - un compte SANS le droit sur les montants contractuels (ni ADMIN, ni le module `chantiers`, ni `marches` : regle unique
 *    `droitMontantsContractuels`, PROVISOIRE) lit les chantiers mais les champs financiers (montant, bailleur, numero de contrat,
 *    entreprise) valent `null` : voir chantiers.confidentialite.ts. `decision` ou `programmation` seuls ne suffisent pas.
 *    Les lectures restent ouvertes : la carte et le selecteur de chantiers n'ont pas besoin de ces champs.
 */
async function sansDroitFinancier(req: Request): Promise<boolean> {
  return !droitMontantsContractuels(await modulesAutorisesDe(req.user!));
}

export async function listHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const q = parseListQuery(req);
    const page = await chantiersService.list({
      page: q.page, pageSize: q.pageSize, sortBy: q.sortBy, sortDir: q.sortDir, search: q.search, region: q.region, etat: q.etat, archived: q.archived,
      where: await filtreRegion(req.user!),
    });
    res.json((await sansDroitFinancier(req)) ? { ...page, data: masquerFinancesChantiers(page.data as object[]) } : page);
  } catch (err) { next(err); }
}
export async function getHandler(req: Request, res: Response, next: NextFunction) {
  try { res.json(await chantiersService.getById(req.params.id)); } catch (err) { next(err); }
}
export async function listGeoHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const lignes = await chantiersService.listGeo(await regionsVisibles(req.user!));
    res.json((await sansDroitFinancier(req)) ? masquerFinancesChantiers(lignes) : lignes);
  } catch (err) { next(err); }
}
export async function listSansLocalisationHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const lignes = await chantiersService.listSansLocalisation(await regionsVisibles(req.user!));
    res.json((await sansDroitFinancier(req)) ? masquerFinancesChantiers(lignes) : lignes);
  } catch (err) { next(err); }
}
export async function exportHandler(req: Request, res: Response, next: NextFunction) {
  try {
    // Le module `chantiers` est exige par la route (l'export est un telechargement de TOUTES les colonnes financieres) ;
    // le perimetre regional s'applique en plus.
    const buffer = await chantiersService.exportXlsx(await regionsVisibles(req.user!));
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=chantiers.xlsx");
    res.send(buffer);
  } catch (err) { next(err); }
}
export async function importHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    if (!req.file) throw new ApiError(400, "Fichier manquant");
    res.json(await chantiersService.importXlsx(req.file.buffer, req.user.id));
  } catch (err) { next(err); }
}
export async function createHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    res.status(201).json(await chantiersService.create(chantierCreateSchema.parse(req.body), req.user.id));
  } catch (err) { next(err); }
}
export async function updateHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    res.json(await chantiersService.update(req.params.id, chantierUpdateSchema.parse(req.body), req.user.id));
  } catch (err) { next(err); }
}
export async function deleteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    await chantiersService.remove(req.params.id, req.user.id);
    res.status(204).send();
  } catch (err) { next(err); }
}
