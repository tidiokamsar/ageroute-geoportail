import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { prisma } from "../lib/prisma";
import {
  RefusCorrespondance, clore, confirmer, corriger, exporter, historiqueVersions, lister, proposer, versionCourante,
} from "../correspondances/correspondances.service";
import { METHODES, TYPES_OBJET } from "../correspondances/correspondances.noyau";

/**
 * `/api/v2/correspondances` -- la correspondance EDITABLE entre identifiants externes (ONR / BDR, ANASUR
 * Collect, L2R...) et objets du Geoportail (A23, BDR_ID_CROSSWALK_SPEC.md).
 *
 *   GET  /                      les correspondances en vigueur a une version (courante par defaut), filtrables
 *   GET  /versions              le journal des versions
 *   GET  /export                CSV de la table a une version, avec son empreinte SHA-256 (critere B12)
 *   POST /                      proposer une correspondance (A_CONFIRMER)
 *   POST /:id/confirmer         la confirmer (decision d'une AUTRE personne)
 *   POST /:id/corriger          la corriger (ligne fermee, nouvelle A_CONFIRMER)
 *   POST /:id/clore             la clore sans remplacement
 *
 * Ni PUT, ni PATCH, ni DELETE : une ligne ne se modifie jamais, et la base le tient (declencheur). La table est
 * VIDE tant que personne n'a rien saisi : aucun code externe n'est seme ni devine. Ecrire : ADMIN et GESTIONNAIRE.
 * Lire : tout compte authentifie.
 */
export const correspondancesV2Router = Router();
correspondancesV2Router.use(requireAuth);

const ecriture = requireRole("ADMIN", "GESTIONNAIRE");

function refus(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof RefusCorrespondance) { res.status(err.http).json({ error: err.message, code: err.code }); return; }
  next(err);
}

const ctx = (req: Request) => ({ auteurId: req.user!.id, ipAddress: req.ip });

const dateIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const corpsProposition = z.object({
  systemeSource: z.string().min(1).max(60),
  typeObjet: z.string().min(1).max(30),
  identifiantSource: z.string().min(1).max(200),
  identifiantCible: z.string().min(1).max(200),
  methode: z.string().min(1).max(40),
  score: z.number(),
  tolerancesM: z.record(z.unknown()).nullish(),
  attributsCorroborants: z.record(z.unknown()).nullish(),
  decisionMotif: z.string().max(1000).nullish(),
  valideDu: dateIso,
  valideAu: dateIso.nullish(),
  lotImportId: z.string().min(1).max(64).nullish(),
  commentaire: z.string().max(1000).nullish(),
}).strict();

const corpsCorrection = corpsProposition.pick({
  identifiantCible: true, methode: true, score: true, tolerancesM: true, attributsCorroborants: true, decisionMotif: true, valideDu: true, valideAu: true, commentaire: true,
}).partial().strict();

const corpsMotif = z.object({ motif: z.string().min(1).max(1000) }).strict();

const filtres = z.object({
  version: z.coerce.number().int().min(0).optional(),
  systemeSource: z.string().max(60).optional(),
  typeObjet: z.enum(TYPES_OBJET).optional(),
  identifiantSource: z.string().max(200).optional(),
  identifiantCible: z.string().max(200).optional(),
  statut: z.enum(["A_CONFIRMER", "CONFIRMEE"]).optional(),
});

function corps<T>(schema: z.ZodType<T>, req: Request, res: Response): T | null {
  const p = schema.safeParse(req.body);
  if (p.success) return p.data;
  res.status(400).json({ error: "corps invalide", details: p.error.flatten() });
  return null;
}

correspondancesV2Router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  const q = filtres.safeParse(req.query);
  if (!q.success) { res.status(400).json({ error: "filtres invalides", details: q.error.flatten() }); return; }
  try {
    const courante = await versionCourante(prisma);
    if (q.data.version !== undefined && q.data.version > courante) { res.status(404).json({ error: `La version ${q.data.version} n'existe pas (courante : ${courante}).`, code: "VERSION_INCONNUE" }); return; }
    const r = await lister(prisma, q.data);
    res.json({ versionCourante: courante, version: r.version, methodes: METHODES, correspondances: r.lignes });
  } catch (err) { refus(err, res, next); }
});

correspondancesV2Router.get("/versions", async (_req: Request, res: Response, next: NextFunction) => {
  try { res.json({ versionCourante: await versionCourante(prisma), versions: await historiqueVersions(prisma) }); } catch (err) { next(err); }
});

correspondancesV2Router.get("/export", async (req: Request, res: Response, next: NextFunction) => {
  const q = z.object({ version: z.coerce.number().int().min(0).optional() }).safeParse(req.query);
  if (!q.success) { res.status(400).json({ error: "version invalide" }); return; }
  try {
    const e = await exporter(prisma, q.data.version);
    res.type("text/csv; charset=utf-8").set("X-Version-Table", String(e.version)).set("X-Empreinte-SHA256", e.empreinteSha256).set("X-Lignes", String(e.lignes)).send(e.texte);
  } catch (err) { refus(err, res, next); }
});

correspondancesV2Router.post("/", ecriture, async (req: Request, res: Response, next: NextFunction) => {
  const c = corps(corpsProposition, req, res);
  if (!c) return;
  try { res.status(201).json(await proposer(prisma, c, ctx(req))); } catch (err) { refus(err, res, next); }
});

correspondancesV2Router.post("/:id/confirmer", ecriture, async (req: Request, res: Response, next: NextFunction) => {
  const c = corps(corpsMotif, req, res);
  if (!c) return;
  try { res.json(await confirmer(prisma, req.params.id, c.motif, ctx(req))); } catch (err) { refus(err, res, next); }
});

correspondancesV2Router.post("/:id/corriger", ecriture, async (req: Request, res: Response, next: NextFunction) => {
  const c = corps(corpsCorrection, req, res);
  if (!c) return;
  try { res.json(await corriger(prisma, req.params.id, c, ctx(req))); } catch (err) { refus(err, res, next); }
});

correspondancesV2Router.post("/:id/clore", ecriture, async (req: Request, res: Response, next: NextFunction) => {
  const c = corps(corpsMotif, req, res);
  if (!c) return;
  try { res.json(await clore(prisma, req.params.id, c.motif, ctx(req))); } catch (err) { refus(err, res, next); }
});
