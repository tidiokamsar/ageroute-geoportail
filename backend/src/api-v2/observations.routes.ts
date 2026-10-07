import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { prisma } from "../lib/prisma";
import { logAudit } from "../utils/audit";
import { enregistrerQualite } from "../lib/qualite";
import { validationPermise, EXPLICATIONS } from "../field/observations.regles";

/**
 * `/api/v2/observations` — consultation et VALIDATION.
 *
 * La validation est la porte que toute la chaine attendait. Le systeme savait
 * produire des observations, les remonter du terrain sans doublon et conserver les
 * conflits ; sans cette route, tout restait au statut PROPOSEE et n'alimentait rien.
 *
 * LA CREATION N'EST PAS ICI
 *
 * Une observation nait d'une mission, hors ligne, et remonte par `/sync/push` avec sa
 * cle d'idempotence. Ouvrir un POST direct offrirait un second chemin de creation
 * sans cette garantie, et c'est par la que reviendraient les doublons que le
 * protocole existe pour empecher.
 */

export const observationsV2Router = Router();

/**
 * @openapi
 * /api/v2/observations:
 *   get:
 *     summary: Liste les observations, filtrables par statut et par mission
 *     tags: [Observations v2]
 */
observationsV2Router.get("/", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const q = z.object({
      statut: z.enum(["BROUILLON", "PROPOSEE", "VALIDEE", "REJETEE", "CONVERTIE"]).optional(),
      missionId: z.string().uuid().optional(),
      tronconId: z.string().optional(),
      limite: z.coerce.number().int().min(1).max(200).optional(),
      curseur: z.string().uuid().optional(),
    }).parse(req.query);

    const observations = await prisma.observation.findMany({
      where: {
        deletedAt: null,
        ...(q.statut ? { statut: q.statut } : {}),
        ...(q.missionId ? { missionId: q.missionId } : {}),
        ...(q.tronconId ? { tronconId: q.tronconId } : {}),
      },
      // Pagination par CURSEUR et non par offset : une liste qui s'allonge pendant
      // qu'on la parcourt ferait sauter des lignes avec un offset, et c'est
      // precisement ce qui arrive quand une mission remonte sa file.
      orderBy: { createdAt: "desc" },
      take: q.limite ?? 50,
      ...(q.curseur ? { cursor: { id: q.curseur }, skip: 1 } : {}),
      include: { medias: { select: { id: true, type: true, cheminVignette: true } } },
    });

    return res.json({
      observations,
      curseurSuivant: observations.length === (q.limite ?? 50) ? observations.at(-1)?.id : null,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/observations/{id}:
 *   get:
 *     summary: Detail d'une observation
 *     tags: [Observations v2]
 */
observationsV2Router.get("/:id", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const o = await prisma.observation.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: { medias: true, mission: { select: { id: true, code: true, intitule: true } } },
    });
    if (!o) return res.status(404).json({ message: "Observation introuvable" });
    return res.json(o);
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/observations/{id}/validate:
 *   post:
 *     summary: Valide ou rejette une observation de terrain
 *     description: >
 *       Une observation ne peut pas etre validee par la personne qui l'a produite, et
 *       un rejet doit porter son motif. La decision est auditee sous VALIDATE ou
 *       REJECT, et tracee dans valeurs_qualite.
 *     tags: [Observations v2]
 */
observationsV2Router.post("/:id/validate", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const c = z.object({
      decision: z.enum(["VALIDEE", "REJETEE"]),
      motif: z.string().max(2000).optional(),
    }).parse(req.body);

    const user = req.user!;
    const o = await prisma.observation.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!o) return res.status(404).json({ message: "Observation introuvable" });

    const verdict = validationPermise({
      statutActuel: o.statut,
      agentId: o.agentId,
      validateurId: user.id,
      validateurRole: user.role,
      decision: c.decision,
      motif: c.motif,
    });

    if (!verdict.permis) {
      // 403 pour un droit, 409 pour un etat : un client doit pouvoir distinguer
      // « vous n'avez pas le droit » de « pas dans cet etat », la premiere ne se
      // corrigeant pas en reessayant.
      const code = verdict.motif === "ROLE_INSUFFISANT" || verdict.motif === "AUTO_VALIDATION" ? 403 : 409;
      return res.status(code).json({ message: EXPLICATIONS[verdict.motif], motif: verdict.motif, statut: o.statut });
    }

    const apres = await prisma.$transaction(async (tx) => {
      const maj = await tx.observation.update({
        where: { id: o.id },
        data: {
          statut: c.decision,
          valideeA: new Date(),
          validateurId: user.id,
          motifRejet: c.decision === "REJETEE" ? c.motif : null,
          // La version avance : un appareil parti avec l'ancienne verra un conflit
          // plutot que d'ecraser la decision.
          version: o.version + 1,
        },
      });
      return maj;
    }, { timeout: 60_000 });

    /**
     * La provenance dit QUI a rendu cette donnee officielle.
     *
     * Une observation validee cesse d'etre une proposition : elle alimentera des
     * defauts, des etats, des couts. Sans cette trace, personne ne pourra dire,
     * dans deux ans, sur quelle autorite un chiffre repose.
     */
    await enregistrerQualite({
      entityType: "Observation",
      entityId: o.id,
      champ: "statut",
      statut: c.decision === "VALIDEE" ? "OBSERVED" : "UNKNOWN",
      source: `Validation par ${user.role}`,
      methode: "VALIDATION_HUMAINE",
      observedAt: new Date(),
      confiance: c.decision === "VALIDEE" ? "HIGH" : "LOW",
      note: c.decision === "VALIDEE"
        ? `Observation validée : elle devient une donnée officielle.`
        : `Observation rejetée. Motif : ${c.motif}`,
    });

    await logAudit({
      userId: user.id,
      action: c.decision === "VALIDEE" ? "VALIDATE" : "REJECT",
      entityType: "Observation",
      entityId: o.id,
      before: { statut: o.statut, version: o.version },
      after: { statut: apres.statut, version: apres.version, motif: c.motif ?? null },
      ipAddress: req.ip,
    });

    return res.json(apres);
  } catch (err) {
    return next(err);
  }
});
