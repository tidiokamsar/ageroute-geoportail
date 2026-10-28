import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { prisma } from "../lib/prisma";
import { logAuditTransactionnelle } from "../utils/audit";

/**
 * Perimetres territoriaux des comptes (A10) : lecture et rattachement, reserves a ADMIN.
 *
 * `comptesNationauxParDefaut` dit combien de comptes non ADMIN n'ont encore aucune region : tant
 * qu'il ne descend pas, le controle territorial ne restreint personne. C'est voulu (rattacher les
 * comptes est une donnee d'organisation d'AGEROUTE, D-11), et c'est affiche pour se lire.
 */
export const perimetresV2Router = Router();
perimetresV2Router.use(requireAuth, requireRole("ADMIN"));

/**
 * @openapi
 * /api/v2/perimetres:
 *   get:
 *     summary: Perimetres territoriaux des comptes, et nombre de comptes encore nationaux par defaut
 *     tags: [Gouvernance v2]
 */
perimetresV2Router.get("/", async (_req, res, next) => {
  try {
    const comptes = await prisma.user.findMany({
      where: { actif: true }, select: { id: true, email: true, nomComplet: true, role: true }, orderBy: { email: "asc" },
    });
    const lignes = await prisma.$queryRaw<{ userId: string; regionId: number; nom: string }[]>`
      SELECT p."userId", p."regionId", r."nom" FROM "perimetres_comptes" p JOIN "regions" r ON r."id" = p."regionId" ORDER BY r."nom"`;
    const parCompte = new Map<string, { id: number; nom: string }[]>();
    for (const l of lignes) {
      const liste = parCompte.get(l.userId) ?? [];
      liste.push({ id: Number(l.regionId), nom: l.nom });
      parCompte.set(l.userId, liste);
    }
    const resultat = comptes.map((c) => {
      const regions = parCompte.get(c.id) ?? [];
      const national = c.role === "ADMIN" || regions.length === 0;
      return { ...c, regions, perimetre: national ? "NATIONAL" : "REGIONAL", nationalParDefaut: c.role !== "ADMIN" && regions.length === 0 };
    });
    res.json({ comptes: resultat, comptesNationauxParDefaut: resultat.filter((c) => c.nationalParDefaut).length });
  } catch (err) { next(err); }
});

/**
 * @openapi
 * /api/v2/perimetres/{userId}:
 *   put:
 *     summary: Remplace les regions d'un compte (liste vide = perimetre national)
 *     tags: [Gouvernance v2]
 */
perimetresV2Router.put("/:userId", async (req, res, next) => {
  try {
    const corps = z.object({ regionIds: z.array(z.number().int().positive()).max(50) }).parse(req.body);
    const regionIds = [...new Set(corps.regionIds)].sort((a, b) => a - b);
    const compte = await prisma.user.findUnique({ where: { id: req.params.userId }, select: { id: true, role: true } });
    if (!compte) return res.status(404).json({ message: "Compte introuvable" });
    if (compte.role === "ADMIN" && regionIds.length > 0) {
      return res.status(400).json({ message: "Un administrateur reste national : son perimetre ne se restreint pas.", code: "ADMIN_NATIONAL" });
    }
    const connues = await prisma.region.count({ where: { id: { in: regionIds } } });
    if (connues !== regionIds.length) return res.status(400).json({ message: "Region inconnue dans la liste.", code: "REGION_INCONNUE" });

    const auteurId = req.user!.id;
    await prisma.$transaction(async (tx) => {
      const avant = await tx.$queryRaw<{ regionId: number }[]>`SELECT "regionId" FROM "perimetres_comptes" WHERE "userId" = ${compte.id} ORDER BY "regionId"`;
      await tx.$executeRaw`DELETE FROM "perimetres_comptes" WHERE "userId" = ${compte.id}`;
      for (const regionId of regionIds) {
        await tx.$executeRaw`INSERT INTO "perimetres_comptes" ("userId", "regionId", "accordeParId") VALUES (${compte.id}, ${regionId}, ${auteurId})`;
      }
      await logAuditTransactionnelle(tx, {
        userId: auteurId, action: "UPDATE", entityType: "PerimetreCompte", entityId: compte.id,
        before: { regionIds: avant.map((l) => Number(l.regionId)) }, after: { regionIds },
      });
    });
    return res.json({ userId: compte.id, regionIds, perimetre: regionIds.length === 0 ? "NATIONAL" : "REGIONAL" });
  } catch (err) { return next(err); }
});
