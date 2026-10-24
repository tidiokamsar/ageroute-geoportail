import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { prisma } from "../lib/prisma";
import { queryBoolean } from "../lib/list-query";

/**
 * Relecture des sessions de roulage (paragraphe 7.13).
 *
 * Une session s'ECRIT par la synchronisation (`POST /api/v2/sync/push`, operation `SessionRoulage`,
 * creation seule) ; elle n'avait aucune route de lecture : l'agent qui l'envoyait ne pouvait plus
 * la revoir. Ces routes la relisent, rien d'autre : ni modification ni suppression, une session
 * envoyee est une donnee d'archive.
 *
 * QUI VOIT QUOI. Un agent voit ses sessions. Un administrateur peut demander toutes les sessions
 * (`tous=true`). Le perimetre territorial d'un gestionnaire ne s'applique pas encore aux sessions
 * (elles n'ont pas de troncon unique) : plutot que d'en inventer un, un gestionnaire voit les
 * siennes, comme un agent.
 *
 * Les points bruts ne sont pas rendus : le GPX reste sur le telephone et l'analyse suffit a relire.
 */
export const roulageV2Router = Router();

const RESUME = {
  id: true, userId: true, appareilId: true, missionId: true, debutA: true, finA: true, versionContrat: true,
  nbPoints: true, tauxRattachement: true, createdAt: true,
} as const;

async function missionsDe(ids: (string | null)[]) {
  const uniques = [...new Set(ids.filter((x): x is string => !!x))];
  if (uniques.length === 0) return new Map<string, { id: string; code: string; intitule: string }>();
  const missions = await prisma.mission.findMany({ where: { id: { in: uniques } }, select: { id: true, code: true, intitule: true } });
  return new Map(missions.map((m) => [m.id, m]));
}

/**
 * @openapi
 * /api/v2/roulage/sessions:
 *   get:
 *     summary: Les sessions de roulage du compte (toutes pour un administrateur qui le demande)
 *     tags: [Roulage v2]
 */
roulageV2Router.get("/sessions", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const q = z.object({
      tous: queryBoolean,
      missionId: z.string().uuid().optional(),
      limite: z.coerce.number().int().min(1).max(200).optional(),
      curseur: z.string().min(1).max(64).optional(),
    }).parse(req.query);
    const user = req.user!;
    if (q.tous === true && user.role !== "ADMIN") {
      return res.status(403).json({ message: "Seul un administrateur voit les sessions de tous les agents." });
    }
    const limite = q.limite ?? 50;
    const sessions = await prisma.sessionRoulage.findMany({
      where: { deletedAt: null, ...(q.tous === true ? {} : { userId: user.id }), ...(q.missionId ? { missionId: q.missionId } : {}) },
      orderBy: [{ debutA: "desc" }, { id: "desc" }],
      take: limite,
      ...(q.curseur ? { cursor: { id: q.curseur }, skip: 1 } : {}),
      select: RESUME,
    });
    const missions = await missionsDe(sessions.map((s) => s.missionId));
    return res.json({
      sessions: sessions.map((s) => ({ ...s, mission: s.missionId ? missions.get(s.missionId) ?? null : null })),
      curseurSuivant: sessions.length === limite ? sessions.at(-1)?.id ?? null : null,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/roulage/sessions/{id}:
 *   get:
 *     summary: Detail d'une session (analyse, compteurs, trous, pauses), sans les points bruts
 *     tags: [Roulage v2]
 */
roulageV2Router.get("/sessions/:id", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(req.params);
    const user = req.user!;
    const session = await prisma.sessionRoulage.findFirst({
      // Meme regle que la liste : l'acces direct par identifiant ne contourne pas le perimetre.
      where: { id, deletedAt: null, ...(user.role === "ADMIN" ? {} : { userId: user.id }) },
      select: { ...RESUME, provenanceParametres: true, parametres: true, trous: true, interruptions: true, pauses: true, compteurs: true, analyse: true },
    });
    if (!session) return res.status(404).json({ message: "Session introuvable" });
    const missions = await missionsDe([session.missionId]);
    return res.json({ ...session, mission: session.missionId ? missions.get(session.missionId) ?? null : null });
  } catch (err) {
    return next(err);
  }
});
