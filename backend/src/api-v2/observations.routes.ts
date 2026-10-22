import { requireTerritoire, surLObjet } from "../governance/perimetre.service";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { prisma } from "../lib/prisma";
import { logAuditTransactionnelle } from "../utils/audit";
import { enregistrerQualite } from "../lib/qualite";
import { validationPermise, EXPLICATIONS } from "../governance/validation";
import { verdictDelegation } from "../governance/delegation.service";

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

async function perimetreObservations(user: { id: string; role: string }) {
  if (user.role === "ADMIN" || user.role === "GESTIONNAIRE") return {};
  const missions = await prisma.mission.findMany({
    where: { deletedAt: null, OR: [{ assigneId: user.id }, { createurId: user.id }] },
    select: { id: true },
  });
  return {
    OR: [
      { agentId: user.id },
      ...(missions.length > 0 ? [{ missionId: { in: missions.map((mission) => mission.id) } }] : []),
    ],
  };
}

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

    const scope = await perimetreObservations(req.user!);
    const observations = await prisma.observation.findMany({
      where: {
        deletedAt: null,
        ...scope,
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
    const scope = await perimetreObservations(req.user!);
    const o = await prisma.observation.findFirst({
      where: { id: req.params.id, deletedAt: null, ...scope },
      include: { medias: true, mission: { select: { id: true, code: true, intitule: true } } },
    });
    if (!o) return res.status(404).json({ message: "Observation introuvable" });
    const validations = await prisma.validation.findMany({
      where: { entityType: "Observation", entityId: o.id },
      orderBy: { decideA: "asc" },
      include: { decidePar: { select: { id: true, nomComplet: true } } },
    });
    return res.json({ ...o, validations });
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
observationsV2Router.post("/:id/validate", requireAuth, requireModuleAccess("inspections"), requireTerritoire("OBSERVATION", surLObjet("OBSERVATION")), async (req, res, next) => {
  try {
    const c = z.object({
      decision: z.enum(["VALIDEE", "REJETEE"]),
      motif: z.string().max(2000).optional(),
    }).strict().parse(req.body);

    const user = req.user!;
    const o = await prisma.observation.findFirst({
      where: { id: req.params.id, deletedAt: null },
      // La region vient du troncon apparie, ou a defaut de la mission. Elle sert au
      // perimetre des delegations, et elle peut legitimement manquer : l'appariement rend
      // `null` plutot que de deviner.
      include: {
        troncon: { select: { regionId: true } },
        mission: { select: { regionId: true } },
      },
    });
    if (!o) return res.status(404).json({ message: "Observation introuvable" });

    /**
     * QUI EST DESIGNE POUR TRANCHER CE DOMAINE (paragraphe 35 du cahier).
     *
     * Deuxieme des sept domaines a consulter les delegations, apres les defauts. Les cinq
     * autres — troncon, ouvrage, point noir, poste, chantier — n'ont a ce jour AUCUNE
     * route de validation : y designer un validateur serait sans effet, et le rapport de
     * gouvernance le dit desormais.
     */
    const regionId = o.troncon?.regionId ?? o.mission?.regionId ?? null;
    const delegation = await verdictDelegation({
      domaine: "OBSERVATION", regionId, validateurId: user.id,
    });

    const decision = c.decision === "VALIDEE" ? "VALIDE" : "REJETE";
    const statutActuel = o.statut === "PROPOSEE" ? "A_VALIDER"
      : o.statut === "VALIDEE" ? "VALIDE"
        : o.statut === "REJETEE" ? "REJETE" : o.statut;
    const verdict = validationPermise({
      entityType: "Observation",
      statutActuel,
      auteurId: o.agentId,
      validateurId: user.id,
      validateurRole: user.role,
      decision,
      commentaire: c.motif,
      delegation,
    });

    if (!verdict.permis) {
      // 403 pour un droit, 409 pour un etat : un client doit pouvoir distinguer
      // « vous n'avez pas le droit » de « pas dans cet etat », la premiere ne se
      // corrigeant pas en reessayant.
      // 403 pour un defaut d'autorite — role, auto-validation, delegation — et 409 pour
      // un defaut d'etat : la premiere categorie ne se corrige pas en reessayant.
      const code = verdict.motif === "ROLE_INSUFFISANT"
        || verdict.motif === "AUTO_VALIDATION"
        || verdict.motif === "HORS_DELEGATION" ? 403 : 409;
      return res.status(code).json({ message: EXPLICATIONS[verdict.motif], motif: verdict.motif, statut: o.statut });
    }

    const apres = await prisma.$transaction(async (tx) => {
      const maj = await tx.observation.updateMany({
        where: { id: o.id, deletedAt: null, statut: o.statut, version: o.version },
        data: {
          statut: c.decision,
          valideeA: new Date(),
          validateurId: user.id,
          motifRejet: c.decision === "REJETEE" ? c.motif : null,
          // La version avance : un appareil parti avec l'ancienne verra un conflit
          // plutot que d'ecraser la decision.
          version: { increment: 1 },
        },
      });
      // Le contrôle compare-et-échange empêche deux validateurs qui ont lu la même
      // version de produire deux décisions contradictoires.
      if (maj.count !== 1) return null;
      const observationMiseAJour = await tx.observation.findUnique({ where: { id: o.id } });
      await tx.validation.create({
        data: {
          entityType: "Observation",
          entityId: o.id,
          statutAvant: statutActuel === "A_VALIDER" ? "A_VALIDER" : null,
          statutApres: decision,
          decideParId: user.id,
          auteurId: o.agentId,
          // L'autorite sur laquelle repose cette decision. « Personne n'est designe sur
          // ce domaine » et « vous etes designe » autorisent la meme action pour des
          // raisons opposees : sans cette mention, on ne saura pas dans un an sur
          // laquelle une validation reposait.
          source: `terrain:${delegation.motif}`,
          commentaire: c.motif ?? null,
        },
      });
      if (!observationMiseAJour) throw new Error("Observation absente après validation.");
      await logAuditTransactionnelle(tx, {
        userId: user.id,
        action: c.decision === "VALIDEE" ? "VALIDATE" : "REJECT",
        entityType: "Observation",
        entityId: o.id,
        before: { statut: o.statut, version: o.version },
        after: { statut: observationMiseAJour.statut, version: observationMiseAJour.version, motif: c.motif ?? null },
        ipAddress: req.ip,
      });
      return observationMiseAJour;
    }, { timeout: 60_000 });

    if (!apres) {
      return res.status(409).json({ message: "L'observation a changé pendant la décision. Rechargez la file avant de réessayer." });
    }

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

    return res.json(apres);
  } catch (err) {
    return next(err);
  }
});
