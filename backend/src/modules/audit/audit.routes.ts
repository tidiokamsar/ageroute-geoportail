import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/auth.middleware";
import { MODULE_PAR_ENTITE, modulesAutorisesDe, moduleAutorise } from "../../lib/access";

export const auditRouter = Router();

const querySchema = z.object({
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

/**
 * Historique des operations sur une entite (qui/quoi/quand), lu depuis audit_logs.
 *
 * L'acces est aligne sur le module dont releve l'entite consultee, et non reserve au
 * seul ADMIN : cette route alimente l'historique affiche dans les fiches (voir
 * AuditHistoryModal et geoportail/DetailPanel), qu'un gestionnaire doit pouvoir lire
 * sur une entite a laquelle il a deja droit. Le reserver a ADMIN aurait casse cette
 * fonctionnalite pour tous les autres roles.
 *
 * Une fois ce controle pose, les champs before/after n'ajoutent aucune fuite : ils ne
 * contiennent que les champs de l'entite, que l'appelant peut deja lire via l'API du
 * module. C'est precisement ce qui n'etait pas vrai avant (P0-SEC-02), ou un compte
 * LECTEUR obtenait les montants et statuts contractuels des marches sans avoir le
 * module Marches.
 *
 * Les types d'entite inconnus de MODULE_PAR_ENTITE sont refuses : on echoue ferme,
 * pour qu'un nouveau type journalise ne soit pas expose par oubli.
 */
auditRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const q = querySchema.parse(req.query);

    // `in` traverse la chaine de prototypes : « constructor », « toString » et
    // « __proto__ » la franchissaient, et la table rendait alors une fonction — donc
    // ni undefined ni null — ce qui menait a la branche « module » au lieu du refus.
    // L'echec ferme annonce plus haut n'en etait pas un.
    if (!Object.prototype.hasOwnProperty.call(MODULE_PAR_ENTITE, q.entityType)) {
      res.status(403).json({ error: "Type d'entité non autorisé" });
      return;
    }
    const moduleRequis = MODULE_PAR_ENTITE[q.entityType];
    if (moduleRequis === null) {
      // Comptes utilisateurs et parametres applicatifs : strictement ADMIN.
      if (req.user!.role !== "ADMIN") {
        res.status(403).json({ error: "Accès réservé aux administrateurs" });
        return;
      }
    } else {
      const modules = await modulesAutorisesDe(req.user!);
      if (!moduleAutorise(modules, moduleRequis)) {
        res.status(403).json({ error: "Accès à ce module non autorisé pour votre compte" });
        return;
      }
    }

    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;
    const where = { entityType: q.entityType, entityId: q.entityId };

    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: { user: { select: { nomComplet: true, email: true } } },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      data: rows.map((r) => ({
        id: r.id,
        action: r.action,
        auteur: r.user?.nomComplet ?? "Système",
        createdAt: r.createdAt,
        before: r.before,
        after: r.after,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) {
    next(err);
  }
});
