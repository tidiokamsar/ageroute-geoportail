import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { prisma } from "../lib/prisma";
import {
  RefusTeledetection, deposerPropositions, depecherVerificationTeledetection, enregistrerProduit, poserVerdict, precision,
} from "../teledetection/teledetection.service";
import { NATURES_PRODUIT, TYPES_PROPOSITION } from "../teledetection/teledetection.noyau";

/**
 * `/api/v2/teledetection` -- l'observation de la Terre (partie E).
 *
 *   GET  /produits                          le registre (sans les emprises)
 *   POST /produits                          enregistrer un produit (licence, provenance... obligatoires)
 *   POST /propositions                      deposer un lot de propositions d'une methode
 *   GET  /propositions?statut=A_VERIFIER    les propositions, a verifier d'abord
 *   POST /propositions/:id/verdict          le terrain confirme ou infirme, une fois
 *   POST /propositions/:id/verification     depecher une mission de verification (EX-03)
 *   GET  /precision                         ce que le terrain a dit, par type et par methode
 *
 * Ecrire : ADMIN et GESTIONNAIRE. Lire : tout compte authentifie. Aucune route ne telecharge,
 * ne traite d'image, ni ne modifie le referentiel.
 */
export const teledetectionV2Router = Router();
teledetectionV2Router.use(requireAuth);
const ecriture = requireRole("ADMIN", "GESTIONNAIRE");

const geometrie = z.object({ type: z.string().min(1), coordinates: z.unknown() });

function refus(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof RefusTeledetection) { res.status(err.http).json({ error: err.message, code: err.code }); return; }
  next(err);
}
const ctx = (req: Request) => ({ auteurId: req.user!.id, ipAddress: req.ip });

teledetectionV2Router.get("/produits", async (_req, res, next) => {
  try {
    res.json({
      produits: await prisma.earthObservationProduct.findMany({
        where: { deletedAt: null }, orderBy: { dateAcquisition: "desc" }, take: 200,
        select: { id: true, code: true, palier: true, source: true, nature: true, dateAcquisition: true, dateFin: true, resolutionM: true,
          couvertureNuagesPct: true, incertitude: true, provenance: true, licence: true, versionTraitement: true, autorisationDepenseRef: true },
      }),
    });
  } catch (err) { next(err); }
});

teledetectionV2Router.post("/produits", ecriture, async (req, res, next) => {
  const p = z.object({
    code: z.string().trim().min(1).max(64), palier: z.number().int(), source: z.string().max(200), nature: z.enum(NATURES_PRODUIT),
    dateAcquisition: z.coerce.date(), dateFin: z.coerce.date().nullish(), resolutionM: z.number(),
    couvertureNuagesPct: z.number().nullish(), incertitude: z.string().max(1000), provenance: z.string().max(1000),
    licence: z.string().max(500), versionTraitement: z.string().max(200), autorisationDepenseRef: z.string().max(200).nullish(),
    emprise: geometrie,
  }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "corps invalide", details: p.error.flatten().fieldErrors }); return; }
  try { res.status(201).json(await enregistrerProduit(prisma, p.data, ctx(req))); } catch (err) { refus(err, res, next); }
});

teledetectionV2Router.post("/propositions", ecriture, async (req, res, next) => {
  const p = z.object({
    produitId: z.string().min(1), produitReferenceId: z.string().min(1).nullish(), methode: z.string().max(200),
    // Aucune tolerance par defaut : sans elle, aucune proposition n'est rattachee a un troncon.
    toleranceRattachementM: z.number().nullish(),
    propositions: z.array(z.object({ type: z.enum(TYPES_PROPOSITION), geometrie, score: z.number().min(0).max(1).nullish() })).max(5000),
  }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "corps invalide", details: p.error.flatten().fieldErrors }); return; }
  try { res.status(201).json(await deposerPropositions(prisma, p.data, ctx(req))); } catch (err) { refus(err, res, next); }
});

teledetectionV2Router.get("/propositions", async (req, res, next) => {
  const statut = typeof req.query.statut === "string" ? req.query.statut : undefined;
  if (statut && !["A_VERIFIER", "CONFIRMEE", "INFIRMEE"].includes(statut)) { res.status(400).json({ error: "statut invalide" }); return; }
  try {
    res.json({
      propositions: await prisma.propositionTeledetection.findMany({
        where: statut ? { statut } : undefined, orderBy: [{ createdAt: "desc" }], take: 500,
        include: { produit: { select: { code: true, source: true, dateAcquisition: true } }, troncon: { select: { code: true, nom: true } } },
      }),
    });
  } catch (err) { next(err); }
});

teledetectionV2Router.post("/propositions/:id/verdict", ecriture, async (req, res, next) => {
  const p = z.object({ statut: z.string(), motif: z.string().max(1000), constatRef: z.string().max(200) }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "corps invalide", details: p.error.flatten().fieldErrors }); return; }
  try { res.json(await poserVerdict(prisma, req.params.id, p.data, ctx(req))); } catch (err) { refus(err, res, next); }
});

teledetectionV2Router.post("/propositions/:id/verification", ecriture, async (req, res, next) => {
  const p = z.object({ assigneId: z.string().min(1).nullish(), debutPrevu: z.coerce.date().nullish() }).safeParse(req.body ?? {});
  if (!p.success) { res.status(400).json({ error: "corps invalide", details: p.error.flatten().fieldErrors }); return; }
  try { res.status(201).json(await depecherVerificationTeledetection(prisma, req.params.id, p.data, ctx(req))); } catch (err) { refus(err, res, next); }
});

teledetectionV2Router.get("/precision", async (_req, res, next) => {
  try { res.json({ methode: "precision = confirmees / (confirmees + infirmees) ; nulle sans verdict", lignes: await precision(prisma) }); } catch (err) { next(err); }
});
