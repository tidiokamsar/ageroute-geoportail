import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { prisma } from "../lib/prisma";
import {
  RefusInfoRoute, genererEtArchiverBulletin, infoRouteCourante, journalEvenement, publier,
} from "../exploitation/info-route.service";
import { ACTIONS_PUBLICATION, CATEGORIES_INFO_ROUTE } from "../exploitation/info-route.noyau";

/**
 * `/api/v2/exploitation/info-route` -- Info Route et bulletin, cote exploitant (EX-05, EX-06).
 *
 *   GET  /courante                          etat public courant, vu de l'interieur
 *   GET  /evenements/:evenementId/journal   toutes les publications d'un evenement, auteurs compris
 *   POST /evenements/:evenementId/publications  PUBLICATION, MISE_A_JOUR ou RETRAIT
 *   POST /bulletins                         generer et archiver le bulletin de la situation presente
 *   GET  /bulletins                         les bulletins archives, du plus recent
 *   GET  /bulletins/:id/texte               le texte, en text/plain, tel qu'archive
 *
 * Publier et generer : ADMIN et GESTIONNAIRE. C'est leur geste qui fait d'une information une
 * information « validee par l'exploitant ». Lire : tout compte authentifie.
 *
 * Ni PUT, ni PATCH, ni DELETE : tout est en ajout seul, et le declencheur en base le tient aussi.
 * Le flux PUBLIC est servi a part, sous `/api/public/info-route`.
 */
export const infoRouteV2Router = Router();
infoRouteV2Router.use(requireAuth);

const ecriture = requireRole("ADMIN", "GESTIONNAIRE");

const corpsPublication = z.object({
  action: z.enum(ACTIONS_PUBLICATION),
  categorie: z.enum(CATEGORIES_INFO_ROUTE).nullish(),
  praticabiliteCode: z.string().min(1).max(16).nullish(),
  titre: z.string().max(120).nullish(),
  textePublic: z.string().max(1000).nullish(),
  localisationPublique: z.string().max(200).nullish(),
  deviation: z.string().max(500).nullish(),
  debutValidite: z.coerce.date().nullish(),
  finValidite: z.coerce.date().nullish(),
  clientOperationId: z.string().min(8).max(128).optional(),
});

function refus(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof RefusInfoRoute) { res.status(err.http).json({ error: err.message, code: err.code }); return; }
  next(err);
}

infoRouteV2Router.get("/courante", async (_req: Request, res: Response, next: NextFunction) => {
  try { res.json({ publications: await infoRouteCourante(prisma) }); } catch (err) { next(err); }
});

infoRouteV2Router.get("/evenements/:evenementId/journal", async (req: Request, res: Response, next: NextFunction) => {
  try { res.json({ publications: await journalEvenement(prisma, req.params.evenementId) }); } catch (err) { next(err); }
});

infoRouteV2Router.post("/evenements/:evenementId/publications", ecriture, async (req: Request, res: Response, next: NextFunction) => {
  const p = corpsPublication.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "corps invalide", details: p.error.flatten().fieldErrors }); return; }
  const { action, ...contenu } = p.data;
  try {
    const r = await publier(prisma, req.params.evenementId, action, contenu, { auteurId: req.user!.id, ipAddress: req.ip });
    res.status(r.dejaRecue ? 200 : 201).json(r);
  } catch (err) { refus(err, res, next); }
});

infoRouteV2Router.post("/bulletins", ecriture, async (req: Request, res: Response, next: NextFunction) => {
  try { res.status(201).json(await genererEtArchiverBulletin(prisma, { auteurId: req.user!.id, ipAddress: req.ip })); } catch (err) { next(err); }
});

infoRouteV2Router.get("/bulletins", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({
      bulletins: await prisma.bulletinRoutier.findMany({
        orderBy: { genereLe: "desc" }, take: 100,
        select: { id: true, numero: true, jour: true, situationA: true, genereLe: true, gabarit: true, empreinteSha256: true, publicationsIds: true },
      }),
    });
  } catch (err) { next(err); }
});

infoRouteV2Router.get("/bulletins/:id/texte", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = await prisma.bulletinRoutier.findUnique({ where: { id: req.params.id }, select: { numero: true, texte: true, empreinteSha256: true } });
    if (!b) { res.status(404).json({ error: "bulletin introuvable" }); return; }
    res.type("text/plain; charset=utf-8")
      .set("Content-Disposition", `attachment; filename="${b.numero}.txt"`)
      .set("X-Empreinte-SHA256", b.empreinteSha256)
      .send(b.texte);
  } catch (err) { next(err); }
});
