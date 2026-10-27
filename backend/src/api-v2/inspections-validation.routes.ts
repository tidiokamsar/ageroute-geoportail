import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { territoireInspection } from "../territoire/territoire.v1";
import { prisma } from "../lib/prisma";
import { logAuditTransactionnelle } from "../utils/audit";
import { jugerAvis } from "../modules/inspections/inspections.validation";

/**
 * Avis d'un responsable sur une inspection (BDRI, lot F) : `POST /api/v2/inspections/:id/validation`.
 *
 * Memes regles que la validation du patrimoine (`governance/validation.ts`) : seul un ADMIN ou un GESTIONNAIRE
 * tranche, nul ne valide sa propre inspection, VALIDE et REJETE sont terminaux, A_CORRIGER renvoie a l'inspecteur,
 * et un refus se motive. Chaque decision est ecrite dans `validations` (historique complet) et dans `audit_logs`.
 *
 * CE QUI N'EST PAS FAIT, ET POURQUOI : l'inspection n'a pas de DOMAINE de delegation (on ne peut pas y designer un
 * validateur par region). L'ajouter exige une valeur de plus dans l'enumeration `DomaineValidation`, ce qu'un
 * `ALTER TYPE ... ADD VALUE` fait de facon IRREVERSIBLE : c'est une decision a prendre, pas un detail d'execution.
 * L'avis ne bloque pas non plus la propagation de l'etat observe au troncon, comportement existant conserve.
 */
export const inspectionsValidationV2Router = Router();

const corps = z.object({
  decision: z.enum(["VALIDE", "REJETE", "A_CORRIGER"]),
  commentaire: z.string().max(2000).nullish(),
}).strict();

inspectionsValidationV2Router.post("/:id/validation", requireAuth, requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("inspections"), territoireInspection, async (req, res, next) => {
  try {
    const c = corps.parse(req.body);
    const user = req.user!;
    const i = await prisma.inspection.findFirst({ where: { id: req.params.id, deletedAt: null }, select: { id: true, inspecteurId: true, statutValidation: true } });
    if (!i) return res.status(404).json({ error: "Inspection introuvable", code: "INTROUVABLE" });
    const j = jugerAvis({ statutActuel: i.statutValidation, inspecteurId: i.inspecteurId, validateurId: user.id, validateurRole: user.role, decision: c.decision, commentaire: c.commentaire });
    if (!j.ok) return res.status(j.http).json({ error: j.message, code: j.code });
    const apres = await prisma.$transaction(async (tx) => {
      const maj = await tx.inspection.updateMany({ where: { id: i.id, statutValidation: i.statutValidation }, data: { statutValidation: c.decision } });
      if (maj.count !== 1) return null;
      await tx.validation.create({ data: { entityType: "Inspection", entityId: i.id, statutAvant: i.statutValidation, statutApres: c.decision, decideParId: user.id, auteurId: i.inspecteurId, source: "avis-responsable", commentaire: c.commentaire?.trim() || null } });
      await logAuditTransactionnelle(tx, {
        userId: user.id, action: c.decision === "VALIDE" ? "VALIDATE" : c.decision === "REJETE" ? "REJECT" : "UPDATE",
        entityType: "Inspection", entityId: i.id, before: { statutValidation: i.statutValidation }, after: { statutValidation: c.decision, commentaire: c.commentaire ?? null }, ipAddress: req.ip,
      });
      return tx.inspection.findUnique({ where: { id: i.id }, select: { id: true, statutValidation: true } });
    });
    if (!apres) return res.status(409).json({ error: "L'inspection a changé pendant la décision : recharger.", code: "CONCURRENCE" });
    return res.json(apres);
  } catch (err) { return next(err); }
});

inspectionsValidationV2Router.get("/:id/validations", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const lignes = await prisma.validation.findMany({ where: { entityType: "Inspection", entityId: req.params.id }, orderBy: { decideA: "asc" }, include: { decidePar: { select: { nomComplet: true } } } });
    res.json({ validations: lignes });
  } catch (err) { next(err); }
});
