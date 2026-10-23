import { Router } from "express";
import { z } from "zod";
import { AuditAction } from "@prisma/client";
import { requireRole } from "../middleware/rbac.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { prisma } from "../lib/prisma";
import { logAuditTransactionnelle } from "../utils/audit";

/**
 * `POST /api/v2/troncons-recherche/bulk-etat` — changer l'état d'un CORRIDOR entier
 * en une décision auditable.
 *
 * LE BESOIN VÉCU (23/10) : « je veux sélectionner une route d'une ville à une autre et
 * changer son état ; de Coyah à Kindia il y a beaucoup de tronçons — comment faire en
 * une fois ? » Le client résout le corridor (Mamou → Faranah) avec sa liste locale de
 * chefs-lieux, envoie les identifiants des tronçons du corridor, et LE SERVEUR tranche
 * en une transaction unique : un seul état, un seul auteur, un seul motif, une ligne
 * d'audit par tronçon.
 *
 * LES LIMITES SONT DES DONNÉES, PAS DES PARAMÈTRES : chaque tronçon garde sa valeur
 * d'avant dans l'audit (before), et la réponse rend les écarts — un tronçon déjà dans
 * l'état demandé ne compte pas comme modifié. Aucune écriture silencieuse : le motif
 * (campagne de reconnaissance, décision régionale…) est EXIGÉ et part dans chaque
 * ligne d'audit. Suppression logique intouchée : on n'archive rien ici.
 *
 * PLAFOND 500 : un corridor de tout le pays n'est pas une édition, c'est un import —
 * il a sa porte (les lots d'import, avec échantillon approuvé).
 */

export const bulkEtatV2Router = Router();
bulkEtatV2Router.use(requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("troncons"));

const corps = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
  etat: z.enum(["BON", "MOYEN", "MAUVAIS", "CRITIQUE", "NON_EVALUE"]),
  motif: z.string().trim().min(5).max(500),
}).strict();

bulkEtatV2Router.post("/bulk-etat", async (req, res, next) => {
  try {
    const p = corps.safeParse(req.body);
    if (!p.success) {
      res.status(400).json({
        error: "corps invalide : ids (1 à 500), etat (BON|MOYEN|MAUVAIS|CRITIQUE|NON_EVALUE) et motif (5 caractères minimum) sont exigés",
        details: p.error.flatten().fieldErrors,
      });
      return;
    }
    const { ids, etat, motif } = p.data;
    const distincts = [...new Set(ids)];

    const resultat = await prisma.$transaction(async (tx) => {
      const troncons = await tx.troncon.findMany({
        where: { id: { in: distincts }, deletedAt: null },
        select: { id: true, code: true, etat: true },
      });
      const introuvables = distincts.filter((id) => !troncons.some((t) => t.id === id));
      const aModifier = troncons.filter((t) => t.etat !== etat);

      for (const t of aModifier) {
        await tx.troncon.update({ where: { id: t.id }, data: { etat } });
        await logAuditTransactionnelle(tx, {
          userId: req.user!.id, action: AuditAction.UPDATE, entityType: "Troncon",
          entityId: t.id,
          before: { etat: t.etat },
          after: { etat, motif },
          ipAddress: req.ip,
        });
      }
      return {
        modifie: aModifier.length,
        inchanges: troncons.length - aModifier.length,
        introuvables,
        codes: aModifier.map((t) => t.code),
      };
    });

    res.json({ ...resultat, etat, motif });
  } catch (err) { next(err); }
});
