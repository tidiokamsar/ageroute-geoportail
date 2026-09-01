import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/auth.middleware";
import { modulesAutorisesDe, moduleAutorise } from "../../lib/access";
import type { ModuleKey } from "../../lib/modules";

export const searchRouter = Router();

const querySchema = z.object({ q: z.string().min(1) });

/**
 * Recherche globale multi-entites (code/nom/description/intitule). 5 resultats max
 * par type.
 *
 * Le controle d'acces ne peut pas passer par requireModuleAccess, qui garde UNE cle
 * de module par router : cette route interroge cinq types d'entites relevant de cinq
 * modules differents. Chaque type est donc interroge uniquement si le compte a droit
 * au module correspondant — sans quoi un compte restreint aux troncons obtenait par
 * cette route les ouvrages, postes et chantiers (P0-SEC-01).
 */
searchRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const { q } = querySchema.parse(req.query);
    const contains = { contains: q, mode: "insensitive" as const };
    const take = 5;
    const notDeleted = { deletedAt: null };

    const modules = await modulesAutorisesDe(req.user!);
    const autorise = (cle: ModuleKey) => moduleAutorise(modules, cle);

    const [troncons, ouvrages, pointsNoirs, postes, chantiers] = await Promise.all([
      autorise("troncons")
        ? prisma.troncon.findMany({
            where: { ...notDeleted, OR: [{ code: contains }, { nom: contains }] },
            select: { id: true, code: true, nom: true },
            take,
          })
        : [],
      autorise("ouvrages")
        ? prisma.ouvrage.findMany({ where: { ...notDeleted, nom: contains }, select: { id: true, nom: true }, take })
        : [],
      autorise("points-noirs")
        ? prisma.pointNoir.findMany({
            where: { ...notDeleted, description: contains },
            select: { id: true, description: true },
            take,
          })
        : [],
      autorise("postes")
        ? prisma.poste.findMany({ where: { ...notDeleted, nom: contains }, select: { id: true, nom: true }, take })
        : [],
      autorise("chantiers")
        ? prisma.chantier.findMany({
            where: { ...notDeleted, intitule: contains },
            select: { id: true, intitule: true },
            take,
          })
        : [],
    ]);

    res.json([
      ...troncons.map((t) => ({ type: "troncon", module: "troncons", id: t.id, label: `${t.code} — ${t.nom}` })),
      ...ouvrages.map((o) => ({ type: "ouvrage", module: "ouvrages", id: o.id, label: o.nom })),
      ...pointsNoirs.map((p) => ({ type: "pointNoir", module: "points-noirs", id: p.id, label: p.description })),
      ...postes.map((p) => ({ type: "poste", module: "postes", id: p.id, label: p.nom })),
      ...chantiers.map((c) => ({ type: "chantier", module: "chantiers", id: c.id, label: c.intitule })),
    ]);
  } catch (err) {
    next(err);
  }
});
