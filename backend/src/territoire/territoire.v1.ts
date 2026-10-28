/**
 * Gardes territoriales (A10) des routes v1 qui ecrivent HORS de la fabrique CRUD : geometrie d'un
 * troncon, geolocalisation, photos d'ouvrage, propagation de l'etat par une inspection,
 * localisation d'un chantier, conversion d'un ordre de travaux en chantier. Les creations,
 * modifications, archivages, restaurations et imports passent par `createCrudService` et y sont
 * controles (`controleTerritorial`).
 */

import type { Request } from "express";
import { prisma } from "../lib/prisma";
import { requireTerritoire } from "../middleware/territoire.middleware";
import { regionDuTroncon, regionsFiche, type EntiteRegionale } from "./territoire.service";

const texte = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/** La fiche designee par `:id` : son ecriture touche sa region. */
export const territoireFiche = (entite: EntiteRegionale) => requireTerritoire((req: Request) => regionsFiche(entite, req.params.id));

/**
 * Une inspection propage son etat observe a l'ouvrage ou au troncon inspecte : ce sont eux qui
 * sont ecrits. Cible du corps, sinon (modification sans changement de cible) celle de l'inspection.
 */
export const territoireInspection = requireTerritoire(async (req: Request) => {
  let ouvrageId = texte(req.body?.ouvrageId);
  let tronconId = texte(req.body?.tronconId);
  if (!ouvrageId && !tronconId && req.params.id) {
    const i = await prisma.inspection.findUnique({ where: { id: req.params.id }, select: { ouvrageId: true, tronconId: true } });
    ouvrageId = i?.ouvrageId ?? null; tronconId = i?.tronconId ?? null;
  }
  if (ouvrageId) return regionsFiche("ouvrage", ouvrageId);
  if (tronconId) return [await regionDuTroncon(tronconId)];
  return [];
});

/** Valider une localisation ecrit le chantier ; le troncon de pose doit etre dans le perimetre aussi. */
export const territoirePropositionLocalisation = requireTerritoire(async (req: Request) => {
  const p = await prisma.propositionLocalisation.findUnique({ where: { id: req.params.id }, select: { chantierId: true, tronconId: true } });
  if (!p) return [];
  const regions = await regionsFiche("chantier", p.chantierId);
  const tronconId = texte(req.body?.tronconId) ?? p.tronconId;
  return tronconId ? [...regions, await regionDuTroncon(tronconId)] : regions;
});

/** Le chantier cree par conversion prend la region de l'ordre de travaux. */
export const territoireConversionOt = requireTerritoire(async (req: Request) => {
  const ot = await prisma.ordreTravaux.findUnique({ where: { id: req.params.id }, select: { regionId: true } });
  return ot ? [ot.regionId] : [];
});
