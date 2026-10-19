import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { prisma } from "../lib/prisma";
import {
  RefusVeille, creerAstreinte, creerRegle, declarerMode, desactiverRegle, evaluerEscalades, modeCourant, retirerAstreinte, tableauVeille,
} from "../exploitation/veille.service";

/**
 * `/api/v2/exploitation/veille` -- la cellule de veille (paragraphe 7.17, EX-04).
 *
 *   GET  /tableau                 tout ce que la vue murale affiche
 *   POST /escalades/evaluer       inscrit les escalades dues (idempotent ; appele par la vue murale)
 *   GET  /mode  POST /mode        mode de la cellule, declare et motive
 *   GET  /astreintes  POST /astreintes  POST /astreintes/:id/retrait
 *   GET  /regles  POST /regles  POST /regles/:id/desactivation
 *
 * Lire et evaluer : tout compte authentifie -- la vue murale peut tourner sous un compte de
 * consultation, et l'evaluation n'inscrit que ce que les regles imposent. Configurer (astreintes,
 * regles, mode) : ADMIN et GESTIONNAIRE.
 *
 * Aucun DELETE : une astreinte se retire logiquement, une regle se desactive, et les escalades et
 * les modes sont en ajout seul.
 */
export const veilleV2Router = Router();
veilleV2Router.use(requireAuth);

const config = requireRole("ADMIN", "GESTIONNAIRE");

function refus(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof RefusVeille) { res.status(err.http).json({ error: err.message, code: err.code }); return; }
  next(err);
}
const ctx = (req: Request) => ({ auteurId: req.user!.id, ipAddress: req.ip });

veilleV2Router.get("/tableau", async (_req, res, next) => {
  try { res.json(await tableauVeille(prisma)); } catch (err) { next(err); }
});

veilleV2Router.post("/escalades/evaluer", async (req, res, next) => {
  try { res.json(await evaluerEscalades(prisma, ctx(req))); } catch (err) { refus(err, res, next); }
});

veilleV2Router.get("/mode", async (_req, res, next) => {
  try { res.json(await modeCourant(prisma)); } catch (err) { next(err); }
});

veilleV2Router.post("/mode", config, async (req, res, next) => {
  const p = z.object({ mode: z.enum(["NORMAL", "SAISON_PLUIES"]), motif: z.string().min(1).max(500) }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "corps invalide", details: p.error.flatten().fieldErrors }); return; }
  try { res.status(201).json(await declarerMode(prisma, p.data.mode, p.data.motif, ctx(req))); } catch (err) { refus(err, res, next); }
});

veilleV2Router.get("/astreintes", async (_req, res, next) => {
  try {
    res.json({
      astreintes: await prisma.astreinte.findMany({
        where: { deletedAt: null, fin: { gt: new Date() } }, orderBy: [{ debut: "asc" }, { niveau: "asc" }],
        include: { user: { select: { id: true, nomComplet: true } }, region: { select: { id: true, nom: true } } },
      }),
    });
  } catch (err) { next(err); }
});

veilleV2Router.post("/astreintes", config, async (req, res, next) => {
  const p = z.object({
    userId: z.string().min(1), niveau: z.number().int(), regionId: z.number().int().positive().nullish(),
    debut: z.coerce.date(), fin: z.coerce.date(),
  }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "corps invalide", details: p.error.flatten().fieldErrors }); return; }
  try { res.status(201).json(await creerAstreinte(prisma, p.data, ctx(req))); } catch (err) { refus(err, res, next); }
});

veilleV2Router.post("/astreintes/:id/retrait", config, async (req, res, next) => {
  try { res.json(await retirerAstreinte(prisma, req.params.id, ctx(req))); } catch (err) { refus(err, res, next); }
});

veilleV2Router.get("/regles", async (_req, res, next) => {
  try { res.json({ regles: await prisma.regleEscalade.findMany({ orderBy: [{ actif: "desc" }, { niveau: "asc" }] }) }); } catch (err) { next(err); }
});

veilleV2Router.post("/regles", config, async (req, res, next) => {
  const p = z.object({
    typeCode: z.string().min(1).max(64).nullish(),
    mode: z.enum(["NORMAL", "SAISON_PLUIES", "TOUS"]),
    niveau: z.number().int().min(1).max(9),
    // Aucune valeur par defaut : le delai est saisi.
    delaiMinutes: z.number().int(),
  }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "corps invalide", details: p.error.flatten().fieldErrors }); return; }
  try { res.status(201).json(await creerRegle(prisma, p.data, ctx(req))); } catch (err) { refus(err, res, next); }
});

veilleV2Router.post("/regles/:id/desactivation", config, async (req, res, next) => {
  try { res.json(await desactiverRegle(prisma, req.params.id, ctx(req))); } catch (err) { refus(err, res, next); }
});
