import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { prisma } from "../lib/prisma";
import { logAuditTransactionnelle } from "../utils/audit";
import { DOMAINES_TERRITORIAUX, perimetreEnVigueur } from "../governance/perimetre";

/**
 * `/api/v2/perimetres` -- les perimetres territoriaux d'ecriture des comptes (A10, D-11).
 *
 *   GET  /                  les perimetres, et combien de comptes actifs n'en ont aucun
 *   POST /                  attribuer une region a un compte (motif obligatoire)
 *   POST /:id/revocation    revoquer une attribution (conservee : elle a existe)
 *
 * ADMIN seulement, en lecture comme en ecriture : qui ecrit ou est une information
 * d'organisation. Personne ne s'attribue un territoire a soi-meme (refuse ici et en base).
 * Toute ecriture est auditee dans sa transaction. Aucun perimetre n'est seme.
 */
export const perimetresV2Router = Router();
perimetresV2Router.use(requireAuth, requireRole("ADMIN"));

perimetresV2Router.get("/", async (_req, res, next) => {
  try {
    const maintenant = new Date();
    const lignes = await prisma.perimetreTerritorial.findMany({
      orderBy: [{ userId: "asc" }, { regionId: "asc" }, { createdAt: "asc" }], take: 2000,
      include: { user: { select: { nomComplet: true, role: true } }, region: { select: { nom: true } } },
    });
    const restreints = new Set(lignes.filter((l) => perimetreEnVigueur(l, maintenant)).map((l) => l.userId));
    // Nom et role seulement, jamais le courriel : de quoi choisir un compte, rien de plus.
    const actifs = await prisma.user.findMany({ where: { actif: true }, select: { id: true, nomComplet: true, role: true }, orderBy: { nomComplet: "asc" } });
    res.json({
      regle: "Un compte sans perimetre en vigueur ecrit dans toutes les regions (regle provisoire, D-11). Des qu'il en a un, il n'ecrit que dans ses regions ; un objet de region inconnue lui est refuse.",
      domaines: DOMAINES_TERRITORIAUX,
      comptesActifs: actifs.length,
      comptesRestreints: actifs.filter((u) => restreints.has(u.id)).length,
      comptesSansPerimetre: actifs.filter((u) => !restreints.has(u.id)).length,
      comptes: actifs,
      perimetres: lignes.map((l) => ({ ...l, enVigueur: perimetreEnVigueur(l, maintenant) })),
    });
  } catch (err) { next(err); }
});

perimetresV2Router.post("/", async (req, res, next) => {
  const p = z.object({
    userId: z.string().min(1), regionId: z.number().int().positive(), motif: z.string().trim().min(3).max(1000),
    debutLe: z.coerce.date().optional(), finLe: z.coerce.date().nullish(),
  }).strict().safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "corps invalide", details: p.error.flatten().fieldErrors }); return; }
  const auteur = req.user!;
  if (p.data.userId === auteur.id) { res.status(403).json({ error: "Personne ne s'attribue un territoire à soi-même.", code: "SOI_MEME" }); return; }
  const debutLe = p.data.debutLe ?? new Date();
  if (p.data.finLe && p.data.finLe <= debutLe) { res.status(400).json({ error: "Le terme suit le début.", code: "PERIODE_INVERSEE" }); return; }
  try {
    const [compte, region] = await Promise.all([
      prisma.user.findUnique({ where: { id: p.data.userId }, select: { id: true } }),
      prisma.region.findUnique({ where: { id: p.data.regionId }, select: { id: true } }),
    ]);
    if (!compte) { res.status(404).json({ error: "Compte introuvable.", code: "COMPTE_INEXISTANT" }); return; }
    if (!region) { res.status(404).json({ error: "Région introuvable.", code: "REGION_INEXISTANTE" }); return; }
    const deja = await prisma.perimetreTerritorial.findFirst({ where: { userId: p.data.userId, regionId: p.data.regionId, revoqueLe: null }, select: { id: true } });
    if (deja) { res.status(409).json({ error: "Ce compte a déjà cette région (attribution non révoquée).", code: "DEJA_ATTRIBUEE" }); return; }
    const cree = await prisma.$transaction(async (tx) => {
      const l = await tx.perimetreTerritorial.create({
        data: { userId: p.data.userId, regionId: p.data.regionId, motif: p.data.motif, debutLe, finLe: p.data.finLe ?? null, attribueParId: auteur.id },
      });
      await logAuditTransactionnelle(tx, {
        userId: auteur.id, action: "CREATE", entityType: "PerimetreTerritorial", entityId: l.id,
        after: { userId: l.userId, regionId: l.regionId, debutLe: l.debutLe, finLe: l.finLe, motif: l.motif }, ipAddress: req.ip,
      });
      return l;
    });
    res.status(201).json(cree);
  } catch (err) { next(err); }
});

perimetresV2Router.post("/:id/revocation", async (req, res, next) => {
  const p = z.object({ motif: z.string().trim().min(3).max(1000) }).strict().safeParse(req.body ?? {});
  if (!p.success) { res.status(400).json({ error: "motif de révocation requis", details: p.error.flatten().fieldErrors }); return; }
  try {
    const r = await prisma.$transaction(async (tx) => {
      const l = await tx.perimetreTerritorial.findUnique({ where: { id: req.params.id } });
      if (!l) return { http: 404 as const, corps: { error: "Attribution introuvable.", code: "INEXISTANTE" } };
      if (l.revoqueLe) return { http: 409 as const, corps: { error: "Attribution déjà révoquée.", code: "DEJA_REVOQUEE" } };
      // Conditionnee a l'etat lu : deux revocations simultanees ne passent pas toutes les deux.
      const maj = await tx.perimetreTerritorial.updateMany({ where: { id: l.id, revoqueLe: null }, data: { revoqueLe: new Date() } });
      if (maj.count !== 1) return { http: 409 as const, corps: { error: "Attribution révoquée entre-temps.", code: "DEJA_REVOQUEE" } };
      await logAuditTransactionnelle(tx, {
        userId: req.user!.id, action: "UPDATE", entityType: "PerimetreTerritorial", entityId: l.id,
        before: { revoqueLe: null }, after: { revoqueLe: new Date(), motif: p.data.motif }, ipAddress: req.ip,
      });
      return { http: 200 as const, corps: await tx.perimetreTerritorial.findUniqueOrThrow({ where: { id: l.id } }) };
    });
    res.status(r.http).json(r.corps);
  } catch (err) { next(err); }
});
