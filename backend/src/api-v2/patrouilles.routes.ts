import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { prisma } from "../lib/prisma";
import {
  RefusPatrouille, couvertureMission, creerProgramme, depecherVerification, engendrerMission, listerProgrammes,
} from "../exploitation/patrouilles.service";

/**
 * `/api/v2/exploitation/patrouilles` -- les patrouilles programmees (paragraphe 7.17, EX-03).
 *
 *   GET  /programmes                              programmes vivants, dernier passage, echeance
 *   POST /programmes                              creer un programme (itineraire obligatoire)
 *   POST /programmes/:id/missions                 engendrer le passage d'un jour (mission BROUILLON)
 *   GET  /missions/:missionId/couverture          couverture troncon par troncon, ecart hors itineraire
 *   POST /signalements/:signalementId/verification  depecher une patrouille de verification
 *
 * Lire est ouvert a tout compte authentifie. Ecrire -- creer un programme, engendrer, depecher --
 * est reserve a ADMIN et GESTIONNAIRE, comme la creation de mission qu'elles produisent.
 *
 * Il n'y a pas de DELETE : un programme se desactive ou se retire par `deletedAt`, jamais ne
 * s'efface, et ce geste n'est pas encore expose.
 */
export const patrouillesV2Router = Router();
patrouillesV2Router.use(requireAuth);

const ecriture = requireRole("ADMIN", "GESTIONNAIRE");

const CLASSES = ["RN", "RR", "RU", "PISTE", "NON_CLASSEE"] as const;

const corpsProgramme = z.object({
  code: z.string().trim().min(1).max(64),
  libelle: z.string().trim().min(1).max(200),
  classeAxe: z.enum(CLASSES).nullish(),
  regionId: z.number().int().positive().nullish(),
  // Aucune valeur par defaut : la periodicite et les mois sont saisis, jamais supposes.
  periodiciteJours: z.number().int(),
  moisActifs: z.array(z.number().int()).max(12),
  responsableId: z.string().min(1),
  troncons: z.array(z.string().min(1)).max(500),
});

const corpsPassage = z.object({ debutPrevu: z.coerce.date(), assigneId: z.string().min(1).nullish() });
const corpsVerification = z.object({ debutPrevu: z.coerce.date().nullish(), assigneId: z.string().min(1).nullish() });

function refus(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof RefusPatrouille) { res.status(err.http).json({ error: err.message, code: err.code }); return; }
  next(err);
}

patrouillesV2Router.get("/programmes", async (_req: Request, res: Response, next: NextFunction) => {
  try { res.json({ programmes: await listerProgrammes(prisma, new Date()) }); } catch (err) { next(err); }
});

patrouillesV2Router.post("/programmes", ecriture, async (req: Request, res: Response, next: NextFunction) => {
  const p = corpsProgramme.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "corps invalide", details: p.error.flatten().fieldErrors }); return; }
  try {
    res.status(201).json(await creerProgramme(prisma, p.data, { auteurId: req.user!.id, ipAddress: req.ip }));
  } catch (err) { refus(err, res, next); }
});

patrouillesV2Router.post("/programmes/:id/missions", ecriture, async (req: Request, res: Response, next: NextFunction) => {
  const p = corpsPassage.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "corps invalide", details: p.error.flatten().fieldErrors }); return; }
  try {
    res.status(201).json(await engendrerMission(prisma, req.params.id, p.data, { auteurId: req.user!.id, ipAddress: req.ip }));
  } catch (err) { refus(err, res, next); }
});

patrouillesV2Router.get("/missions/:missionId/couverture", async (req: Request, res: Response, next: NextFunction) => {
  // 30 m par defaut : le rayon minimal du paragraphe 7.3. Parametrable, borne pour rester un rayon
  // de rattachement et non une zone.
  const brut = req.query.tolerance;
  const tolerance = brut === undefined ? 30 : Number(brut);
  if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 500) {
    res.status(400).json({ error: "tolerance invalide : un nombre de metres, strictement positif, au plus 500" }); return;
  }
  try { res.json(await couvertureMission(prisma, req.params.missionId, tolerance)); } catch (err) { refus(err, res, next); }
});

patrouillesV2Router.post("/signalements/:signalementId/verification", ecriture, async (req: Request, res: Response, next: NextFunction) => {
  const p = corpsVerification.safeParse(req.body ?? {});
  if (!p.success) { res.status(400).json({ error: "corps invalide", details: p.error.flatten().fieldErrors }); return; }
  try {
    res.status(201).json(await depecherVerification(prisma, req.params.signalementId, p.data, { auteurId: req.user!.id, ipAddress: req.ip }));
  } catch (err) { refus(err, res, next); }
});
