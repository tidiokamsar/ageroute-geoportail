import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireRole } from "../../middleware/rbac.middleware";
import { requireModuleAccess } from "../../middleware/module-access.middleware";
import { deriveChantierGeom } from "../../lib/geo";

export const propositionsRouter = Router();

/**
 * Propositions de localisation de chantiers (T5).
 *
 * LA REGLE
 *
 * Une proposition n'est pas une localisation. `chantiers.geom` n'est ecrit qu'ici, a
 * la validation, par un agent identifie. Aucun script, aucun import, aucune deduction
 * automatique ne pose de geometrie.
 *
 * POURQUOI CETTE PRUDENCE N'EST PAS EXCESSIVE
 *
 * Mesure du 02/09/2026 : sur les 14 emprises extraites des intitules, AUCUNE ne
 * trouve un troncon qui la couvre. Les emprises font 40 a 55 km, les troncons
 * quelques kilometres, et les PK ne forment pas un kilometrage continu par route —
 * 24 designations sur 42 ont des PK de depart dupliques.
 *
 * Une extraction correcte ne suffit donc pas : le texte est clair, la cible ne l'est
 * pas. C'est a un agent de choisir le troncon, et la proposition lui donne de quoi le
 * faire — l'intitule d'origine, les PK lus, la longueur citee, et le motif.
 */

const decisionSchema = z.object({
  // Un agent peut corriger la cible : la proposition est un point de depart, pas un
  // verdict. Sans tronconId, la validation ne peut poser aucune geometrie.
  tronconId: z.string().min(1).optional(),
  pkDebut: z.number().finite().optional(),
  pkFin: z.number().finite().optional(),
  motif: z.string().max(500).optional(),
});

/** File d'attente : ce qu'un agent doit trancher. */
propositionsRouter.get("/", requireAuth, requireModuleAccess("chantiers"), async (req, res, next) => {
  try {
    const statut = typeof req.query.statut === "string" ? req.query.statut : "PROPOSED";
    if (!["PROPOSED", "VALIDATED", "REJECTED"].includes(statut)) {
      return res.status(400).json({ message: "Statut inconnu" });
    }

    const lignes = await prisma.propositionLocalisation.findMany({
      where: { statut: statut as never },
      include: {
        chantier: { select: { id: true, intitule: true, region: { select: { nom: true } } } },
        troncon: { select: { id: true, code: true, nom: true, pkDebut: true, pkFin: true } },
      },
      orderBy: [{ confiance: "asc" }, { createdAt: "desc" }],
      take: 200,
    });

    return res.json(
      lignes.map((p) => ({
        id: p.id,
        chantierId: p.chantierId,
        intitule: p.chantier.intitule,
        region: p.chantier.region?.nom ?? null,
        statut: p.statut,
        methode: p.methode,
        confiance: p.confiance,
        // L'intitule d'origine est rendu tel quel : l'agent juge sur piece, pas sur
        // une interpretation.
        sourceTexte: p.sourceTexte,
        pkDebut: p.pkDebut,
        pkFin: p.pkFin,
        longueurCiteeKm: p.longueurCiteeKm,
        longueurCalculeeKm: p.longueurCalculeeKm,
        ecartPct: p.ecartPct,
        troncon: p.troncon,
        createdAt: p.createdAt,
      }))
    );
  } catch (err) {
    return next(err);
  }
});

/**
 * Valide une proposition : c'est le SEUL chemin par lequel une geometrie deduite d'un
 * intitule entre en base.
 */
propositionsRouter.post(
  "/:id/valider",
  requireAuth,
  requireRole("ADMIN", "GESTIONNAIRE"),
  requireModuleAccess("chantiers"),
  async (req, res, next) => {
    try {
      const parsed = decisionSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ message: "Requête invalide", errors: parsed.error.flatten().fieldErrors });
      }

      const proposition = await prisma.propositionLocalisation.findUnique({ where: { id: req.params.id } });
      if (!proposition) return res.status(404).json({ message: "Proposition introuvable" });
      if (proposition.statut !== "PROPOSED") {
        return res.status(409).json({ message: "Proposition déjà tranchée" });
      }

      // L'agent peut corriger ce que l'extraction a lu.
      const tronconId = parsed.data.tronconId ?? proposition.tronconId;
      const pkDebut = parsed.data.pkDebut ?? proposition.pkDebut;
      const pkFin = parsed.data.pkFin ?? proposition.pkFin;

      // Sans troncon ni PK, il n'y a rien a poser. Valider une proposition vide
      // marquerait le chantier comme localise sans qu'il le soit.
      if (!tronconId || pkDebut == null || pkFin == null) {
        return res.status(422).json({
          message:
            "Un tronçon et deux PK sont nécessaires pour poser une emprise. Renseignez-les ou rejetez la proposition.",
        });
      }

      const pose = await deriveChantierGeom(proposition.chantierId, tronconId, pkDebut, pkFin);
      if (!pose) {
        return res.status(422).json({
          message: "Aucune emprise n'a pu être dérivée : tronçon sans géométrie, ou PK hors de son étendue.",
        });
      }

      const userId = (req.user as { id: string }).id;
      await prisma.$transaction([
        prisma.propositionLocalisation.update({
          where: { id: proposition.id },
          data: { statut: "VALIDATED", tronconId, pkDebut, pkFin, decidedAt: new Date(), decidedById: userId },
        }),
        // Le chantier porte desormais une emprise reelle : son niveau devient PRECISE.
        prisma.chantier.update({
          where: { id: proposition.chantierId },
          data: { tronconId, pkDebut, pkFin, statutLocalisation: "PRECISE" },
        }),
        prisma.auditLog.create({
          data: {
            userId,
            action: "UPDATE",
            entityType: "Chantier",
            entityId: proposition.chantierId,
            after: {
              localisation: "validée depuis une proposition",
              propositionId: proposition.id,
              methode: proposition.methode,
              tronconId,
              pkDebut,
              pkFin,
            },
          },
        }),
      ]);

      return res.json({ statut: "VALIDATED", chantierId: proposition.chantierId });
    } catch (err) {
      return next(err);
    }
  }
);

/** Rejette une proposition. Le chantier reste sans localisation, ce qui est honnete. */
propositionsRouter.post(
  "/:id/rejeter",
  requireAuth,
  requireRole("ADMIN", "GESTIONNAIRE"),
  requireModuleAccess("chantiers"),
  async (req, res, next) => {
    try {
      const parsed = decisionSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ message: "Requête invalide" });

      const proposition = await prisma.propositionLocalisation.findUnique({ where: { id: req.params.id } });
      if (!proposition) return res.status(404).json({ message: "Proposition introuvable" });
      if (proposition.statut !== "PROPOSED") {
        return res.status(409).json({ message: "Proposition déjà tranchée" });
      }

      await prisma.propositionLocalisation.update({
        where: { id: proposition.id },
        data: {
          statut: "REJECTED",
          decidedAt: new Date(),
          decidedById: (req.user as { id: string }).id,
          motifRejet: parsed.data.motif ?? null,
        },
      });

      return res.json({ statut: "REJECTED" });
    } catch (err) {
      return next(err);
    }
  }
);
