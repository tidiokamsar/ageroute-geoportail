import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { prisma } from "../lib/prisma";
import { logAudit } from "../utils/audit";
import { appliquer, statutAppareil, TYPES_ACCEPTES } from "../field/sync.service";

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
    const appareil = await prisma.appareil.findFirst({
      where: { id: corps.appareilId, revoqueA: null },
      select: { id: true, userId: true },
    });
    if (!appareil) return res.status(403).json({ message: "Appareil inconnu ou révoqué" });

    /**
     * EN SERIE, et c'est structurel ici.
     *
     * Deux operations du meme lot peuvent porter sur la meme entite : la seconde doit
     * voir le resultat de la premiere, sinon elle partirait d'une version perimee et
     * serait mise en conflit avec son propre predecesseur.
     */
    const resultats = [];
    for (const op of corps.operations) {
      resultats.push(await appliquer(op, { appareilId: appareil.id, userId: appareil.userId }));
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
 *     summary: Redescend ce qui a change depuis un horodatage
 *     tags: [Sync v2]
 */
syncV2Router.post("/pull", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const corps = z.object({
      depuis: z.string().datetime().optional(),
      missionId: z.string().uuid().optional(),
      limite: z.number().int().min(1).max(PULL_MAX).optional(),
    }).parse(req.body);

    const depuis = corps.depuis ? new Date(corps.depuis) : new Date(0);
    const limite = corps.limite ?? PULL_MAX;

    const observations = await prisma.observation.findMany({
      where: {
        updatedAt: { gt: depuis },
        ...(corps.missionId ? { missionId: corps.missionId } : {}),
      },
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
    const dernier = observations.at(-1)?.updatedAt ?? depuis;

    return res.json({
      observations,
      jusqua: dernier.toISOString(),
      // Dit au client s'il doit redemander tout de suite, au lieu de le lui faire
      // deviner en comparant des longueurs.
      complet: observations.length < limite,
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
    await prisma.$transaction(async (tx) => {
      if (corps.resolution === "LOCAL") {
        // On retient la version de l'appareil. La version serveur est incrementee :
        // les autres appareils verront que la valeur a change et redescendront.
        const actuel = await tx.observation.findUnique({ where: { id: conflit.entityId } });
        await tx.observation.update({
          where: { id: conflit.entityId },
          data: { ...(conflit.payloadLocal as object), version: (actuel?.version ?? 0) + 1 } as never,
        });
      }
      await tx.conflitSync.update({
        where: { id: conflit.id },
        data: { resolution: corps.resolution, resoluParId: user.id, resoluA: new Date() },
      });
    }, { timeout: 60_000 });

    await logAudit({
      userId: user.id, action: "UPDATE", entityType: "ConflitSync", entityId: conflit.id,
      after: { resolution: corps.resolution, entityType: conflit.entityType, entityId: conflit.entityId },
    });

    return res.json({ conflitId: conflit.id, resolution: corps.resolution });
  } catch (err) {
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
    return res.json({ ...(await statutAppareil(appareilId)), typesAcceptes: [...TYPES_ACCEPTES] });
  } catch (err) {
    return next(err);
  }
});
