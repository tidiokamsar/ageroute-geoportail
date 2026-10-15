import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { prisma } from "../lib/prisma";
import { logAuditTransactionnelle } from "../utils/audit";
import { appliquer, statutAppareil, TYPES_ACCEPTES, OPERATIONS_ACCEPTEES } from "../field/sync.service";
import { preparerPayloadObservationSync } from "../field/observation-sync-payload";

/**
 * `/api/v2/sync` — remontee et redescente des donnees de terrain.
 *
 * Section 15 du cahier des charges : push, pull, resolve, status.
 *
 * POURQUOI LE LOT EST PLAFONNE, ENCORE
 *
 * Meme raison qu'a `/geo/match/batch`, et meme incident a l'origine : une requete
 * dimensionnee sans y penser avait occupe la base de production dix-sept minutes.
 * Ici chaque operation ouvre une transaction ; un lot de mille en tiendrait une
 * pendant des minutes et bloquerait les ecritures des autres.
 *
 * 100 operations, soit une mission ordinaire. Un appareil qui en a davantage decoupe,
 * ce qui lui rend la main entre deux lots et lui permet d'afficher une progression.
 */

export const syncV2Router = Router();

export const LOT_MAX_OPERATIONS = 100;
export const PULL_MAX = 500;

class ResolutionConflitConcurrente extends Error {}

const operation = z.object({
  operationId: z.string().uuid(),
  entityType: z.string().min(1).max(64),
  entityId: z.string().min(1).max(64),
  operation: z.enum(["CREATE", "UPDATE", "DELETE"]),
  baseVersion: z.number().int().min(0).nullable().optional(),
  payload: z.record(z.unknown()),
});

/**
 * @openapi
 * /api/v2/sync/push:
 *   post:
 *     summary: Remonte un lot d'operations produites hors ligne
 *     description: >
 *       Chaque operation porte un operationId genere par le client. Une operation deja
 *       traitee rend son resultat precedent sans rien ecrire. Un conflit de version
 *       n'ecrase jamais : les deux etats sont conserves pour arbitrage.
 *     tags: [Sync v2]
 */
syncV2Router.post("/push", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const corps = z.object({
      appareilId: z.string().uuid(),
      operations: z.array(operation).min(1).max(LOT_MAX_OPERATIONS),
    }).parse(req.body);

    // L'appareil doit exister ET ne pas etre revoque. Un telephone perdu dont on a
    // revoque l'acces ne doit pas pouvoir vider sa file dans le referentiel.
    const user = req.user!;
    const appareil = await prisma.appareil.findFirst({
      where: { id: corps.appareilId, revoqueA: null },
      select: { id: true, userId: true },
    });
    // Un UUID d'appareil ne constitue pas une autorisation. Sans cette comparaison,
    // un compte du module terrain qui connaît l'ID d'un autre appareil pourrait faire
    // attribuer ses opérations au propriétaire de cet appareil.
    if (!appareil || appareil.userId !== user.id) {
      return res.status(403).json({ message: "Appareil inconnu, révoqué ou non autorisé" });
    }

    /**
     * EN SERIE, et c'est structurel ici.
     *
     * Deux operations du meme lot peuvent porter sur la meme entite : la seconde doit
     * voir le resultat de la premiere, sinon elle partirait d'une version perimee et
     * serait mise en conflit avec son propre predecesseur.
     */
    const resultats = [];
    for (const op of corps.operations) {
      resultats.push(await appliquer(op, { appareilId: appareil.id, userId: user.id }));
    }

    await prisma.appareil.update({ where: { id: appareil.id }, data: { dernierVuA: new Date() } });

    return res.json({
      total: resultats.length,
      synchronisees: resultats.filter((r) => r.statut === "SYNCHRONISE").length,
      rejouees: resultats.filter((r) => r.statut === "REJOUEE").length,
      // Compte a part des rejets : un conflit attend une decision humaine, pas un
      // reessai. Les confondre ferait boucler un client a vide.
      conflits: resultats.filter((r) => r.statut === "CONFLIT").length,
      rejetees: resultats.filter((r) => r.statut === "REJETE").length,
      resultats,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/sync/pull:
 *   post:
 *     summary: Redescend les observations ou défauts modifiés depuis un horodatage
 *     description: >
 *       `entityType` accepte `Observation` ou `Defaut`. Son absence conserve le
 *       comportement historique et renvoie les observations. Les tombstones sont
 *       inclus afin que les appareils répercutent les suppressions logiques.
 *     tags: [Sync v2]
 */
syncV2Router.post("/pull", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const corps = z.object({
      depuis: z.string().datetime().optional(),
      missionId: z.string().uuid().optional(),
      entityType: z.enum(["Observation", "Defaut"]).optional(),
      limite: z.number().int().min(1).max(PULL_MAX).optional(),
    }).parse(req.body);

    const depuis = corps.depuis ? new Date(corps.depuis) : new Date(0);
    const limite = corps.limite ?? PULL_MAX;
    const entityType = corps.entityType ?? "Observation";
    const user = req.user!;

    let scope: Record<string, unknown> = {};
    if (user.role !== "ADMIN" && user.role !== "GESTIONNAIRE") {
      const missions = await prisma.mission.findMany({
        where: { deletedAt: null, OR: [{ assigneId: user.id }, { createurId: user.id }] },
        select: { id: true },
      });
      const missionIds = missions.map((mission) => mission.id);
      if (corps.missionId && !missionIds.includes(corps.missionId)) {
        return res.json({
          entityType,
          ...(entityType === "Observation" ? { observations: [] } : { defauts: [] }),
          jusqua: depuis.toISOString(),
          complet: true,
        });
      }
      scope = {
        OR: [
          entityType === "Observation" ? { agentId: user.id } : { constateParId: user.id },
          ...(missionIds.length > 0 ? [{ missionId: { in: missionIds } }] : []),
        ],
      };
    }

    const where = {
      updatedAt: { gt: depuis },
      ...scope,
      ...(corps.missionId ? { missionId: corps.missionId } : {}),
    };
    const entites = entityType === "Observation"
      ? await prisma.observation.findMany({
          where,
          orderBy: { updatedAt: "asc" },
          take: limite,
        })
      : await prisma.defaut.findMany({
          // Les lignes supprimées logiquement sont des tombstones nécessaires aux
          // appareils : ne pas les filtrer les laisserait réafficher un défaut archivé.
          where,
          orderBy: { updatedAt: "asc" },
          take: limite,
        });

    /**
     * L'horodatage rendu est celui de la DERNIERE ligne, pas l'heure du serveur.
     *
     * Prendre l'heure du serveur ferait sauter toute ligne modifiee entre la requete
     * et la reponse : le client croirait etre a jour et ne la redemanderait jamais.
     * Avec la derniere valeur vue, au pire il relit une ligne, ce qui est sans
     * consequence puisque la redescente est idempotente par nature.
     */
    const dernier = entites.at(-1)?.updatedAt ?? depuis;

    return res.json({
      entityType,
      ...(entityType === "Observation" ? { observations: entites } : { defauts: entites }),
      jusqua: dernier.toISOString(),
      // Dit au client s'il doit redemander tout de suite, au lieu de le lui faire
      // deviner en comparant des longueurs.
      complet: entites.length < limite,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/sync/resolve:
 *   post:
 *     summary: Tranche un conflit de synchronisation
 *     tags: [Sync v2]
 */
syncV2Router.post("/resolve", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const corps = z.object({
      conflitId: z.string().uuid(),
      // Pas de « fusion automatique ». Un humain choisit une version, et ce choix est
      // trace. Une fusion silencieuse produirait un troisieme etat que personne n'a vu.
      resolution: z.enum(["LOCAL", "SERVEUR"]),
    }).parse(req.body);

    const conflit = await prisma.conflitSync.findUnique({ where: { id: corps.conflitId } });
    if (!conflit) return res.status(404).json({ message: "Conflit introuvable" });
    if (conflit.resolution) return res.status(409).json({ message: "Conflit déjà tranché", resolution: conflit.resolution });

    const user = req.user!;
    const operation = await prisma.operationSync.findUnique({
      where: { operationId: conflit.operationId },
      select: { userId: true, operation: true, entityType: true, entityId: true },
    });
    const responsable = user.role === "ADMIN" || user.role === "GESTIONNAIRE";
    if (!operation || (!responsable && operation.userId !== user.id)) {
      return res.status(404).json({ message: "Conflit introuvable" });
    }
    if (
      (conflit.entityType !== "Observation" && conflit.entityType !== "Defaut")
      || operation.entityType !== conflit.entityType
      || operation.entityId !== conflit.entityId
    ) {
      return res.status(409).json({ message: `Type de conflit non pris en charge : ${conflit.entityType}` });
    }
    if (conflit.entityType === "Defaut" && !["ADMIN", "GESTIONNAIRE"].includes(user.role)) {
      return res.status(403).json({ message: "Seul un gestionnaire ou un administrateur peut arbitrer un conflit de défaut." });
    }
    if (conflit.entityType === "Defaut" && corps.resolution === "LOCAL") {
      return res.status(409).json({
        message: "La version locale d'un défaut en conflit doit être représentée avec un nouvel identifiant avant arbitrage.",
        motif: "NOUVEL_IDENTIFIANT_REQUIS",
      });
    }

    // Un conflit de création ne doit jamais remplacer une ligne qui existe déjà.
    // La branche LOCAL ne s'applique qu'aux modifications/suppressions d'observations.
    if (corps.resolution === "LOCAL" && operation.operation === "CREATE") {
      return res.status(409).json({
        message: "Une création en conflit doit être représentée avec un nouvel identifiant avant arbitrage.",
        motif: "NOUVEL_IDENTIFIANT_REQUIS",
      });
    }
    if (corps.resolution === "LOCAL" && !["UPDATE", "DELETE"].includes(operation.operation)) {
      return res.status(409).json({ message: "Opération locale non prise en charge." });
    }

    const payloadLocal = conflit.payloadLocal;
    const preparationLocale = corps.resolution === "LOCAL" && conflit.entityType === "Observation"
      ? preparerPayloadObservationSync(
          operation.operation as "UPDATE" | "DELETE",
          typeof payloadLocal === "object" && payloadLocal !== null && !Array.isArray(payloadLocal)
            ? payloadLocal as Record<string, unknown>
            : {},
        )
      : null;
    if (preparationLocale && !preparationLocale.ok) {
      return res.status(409).json({ message: "Le contenu local du conflit n'est plus valide.", motif: "PAYLOAD_LOCAL_INVALIDE" });
    }

    const resolu = await prisma.$transaction(async (tx) => {
      const revendication = await tx.conflitSync.updateMany({
        where: { id: conflit.id, resolution: null },
        data: { resolution: corps.resolution, resoluParId: user.id, resoluA: new Date() },
      });
      if (revendication.count !== 1) return false;

      if (corps.resolution === "LOCAL") {
        const actuel = await tx.observation.findUnique({ where: { id: conflit.entityId } });
        const instantane = typeof conflit.payloadServeur === "object" && conflit.payloadServeur !== null && !Array.isArray(conflit.payloadServeur)
          ? conflit.payloadServeur as Record<string, unknown>
          : {};
        if (
          !actuel || actuel.deletedAt || actuel.agentId !== operation.userId
          || !["BROUILLON", "PROPOSEE"].includes(actuel.statut)
          || typeof instantane.version !== "number" || actuel.version !== instantane.version
        ) {
          throw new ResolutionConflitConcurrente("L'observation a changé depuis la création du conflit.");
        }

        const missionId = preparationLocale?.ok && Object.hasOwn(preparationLocale.payload, "missionId")
          ? preparationLocale.payload.missionId
          : actuel.missionId;
        if (typeof missionId === "string") {
          const mission = await tx.mission.findFirst({
            where: {
              id: missionId,
              deletedAt: null,
              OR: [{ assigneId: operation.userId }, { createurId: operation.userId }],
            },
            select: { id: true },
          });
          if (!mission) throw new ResolutionConflitConcurrente("La mission de l'observation n'est plus accessible.");
        }

        const donnees = operation.operation === "DELETE"
          ? { deletedAt: new Date(), version: { increment: 1 } }
          : { ...preparationLocale!.payload, version: { increment: 1 } };
        const maj = await tx.observation.updateMany({
          where: {
            id: actuel.id,
            version: actuel.version,
            agentId: operation.userId,
            deletedAt: null,
            statut: { in: ["BROUILLON", "PROPOSEE"] },
          },
          data: donnees as never,
        });
        if (maj.count !== 1) throw new ResolutionConflitConcurrente("L'observation a changé pendant l'arbitrage.");
      }
      await tx.operationSync.updateMany({
        where: { operationId: conflit.operationId },
        data: {
          statut: corps.resolution === "LOCAL" ? "SYNCHRONISE" : "REJETE",
          derniereErreur: corps.resolution === "LOCAL" ? null : "CONFLIT_RESOLU_VERSION_SERVEUR",
          traiteeA: new Date(),
        },
      });
      await logAuditTransactionnelle(tx, {
        userId: user.id,
        action: "UPDATE",
        entityType: "ConflitSync",
        entityId: conflit.id,
        after: { resolution: corps.resolution, entityType: conflit.entityType, entityId: conflit.entityId },
        ipAddress: req.ip,
      });
      return true;
    }, { timeout: 60_000 });

    if (!resolu) return res.status(409).json({ message: "Le conflit a déjà été tranché par une autre requête." });

    return res.json({ conflitId: conflit.id, resolution: corps.resolution, entityType: conflit.entityType, entityId: conflit.entityId });
  } catch (err) {
    if (err instanceof ResolutionConflitConcurrente) {
      return res.status(409).json({ message: err.message });
    }
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/sync/status:
 *   get:
 *     summary: Etat de synchronisation d'un appareil
 *     tags: [Sync v2]
 */
syncV2Router.get("/status", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const { appareilId } = z.object({ appareilId: z.string().uuid() }).parse(req.query);
    const user = req.user!;
    const appareil = await prisma.appareil.findUnique({
      where: { id: appareilId },
      select: { id: true, userId: true },
    });
    if (!appareil || (appareil.userId !== user.id && user.role !== "ADMIN")) {
      return res.status(404).json({ message: "Appareil introuvable" });
    }
    return res.json({
      ...(await statutAppareil(appareilId)),
      typesAcceptes: [...TYPES_ACCEPTES],
      operationsAcceptees: OPERATIONS_ACCEPTEES,
    });
  } catch (err) {
    return next(err);
  }
});
