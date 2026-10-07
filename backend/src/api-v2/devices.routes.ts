import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { prisma } from "../lib/prisma";
import { logAudit } from "../utils/audit";

/**
 * `/api/v2/devices` — appareils autorises a remonter du terrain.
 *
 * POURQUOI CE DOMAINE AVANT LES AUTRES
 *
 * `sync/push` exige un `appareilId` et refuse tout appareil inconnu ou revoque. Sans
 * route pour en enregistrer un, le protocole de synchronisation etait inutilisable :
 * la chaine s'arretait avant de commencer.
 *
 * CE QU'UN APPAREIL AJOUTE A UN COMPTE
 *
 * La possibilite de couper UN telephone sans couper son porteur. Un agent qui perd
 * son appareil en mission doit pouvoir le signaler et continuer a travailler depuis
 * un autre ; revoquer son compte le priverait aussi de la console web, et personne ne
 * le signalerait donc avant le retour de mission. La revocation est irreversible par
 * construction : on n'annule pas une revocation, on enregistre un nouvel appareil.
 *
 * CE QUI N'EST PAS ICI
 *
 * Aucun secret d'appareil, aucun jeton propre. L'authentification reste celle du
 * compte, deja solide : JWT a rotation, Argon2id, cookie HttpOnly. Ajouter une
 * seconde voie d'authentification sans necessite, c'est ajouter une seconde voie a
 * compromettre.
 */

export const devicesV2Router = Router();

const enregistrement = z.object({
  nom: z.string().min(1).max(120).optional(),
  plateforme: z.enum(["android", "ios", "web"]),
  modele: z.string().max(120).optional(),
  versionOs: z.string().max(60).optional(),
  versionApp: z.string().max(60).optional(),
});

/**
 * Un meme porteur ne doit pas accumuler des appareils fantomes.
 *
 * Une application reinstallee enregistre un nouvel appareil ; sans plafond, un
 * telephone capricieux en creerait des dizaines, et la liste des appareils a
 * surveiller deviendrait illisible au moment ou elle sert, c'est-a-dire quand il faut
 * en revoquer un vite.
 */
export const APPAREILS_ACTIFS_MAX = 10;

/**
 * @openapi
 * /api/v2/devices:
 *   post:
 *     summary: Enregistre un appareil pour le compte authentifie
 *     tags: [Devices v2]
 */
devicesV2Router.post("/", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const c = enregistrement.parse(req.body);
    const user = req.user!;

    const actifs = await prisma.appareil.count({ where: { userId: user.id, revoqueA: null } });
    if (actifs >= APPAREILS_ACTIFS_MAX) {
      return res.status(409).json({
        message: `Limite de ${APPAREILS_ACTIFS_MAX} appareils actifs atteinte. Révoquez-en un avant d'en ajouter.`,
      });
    }

    const appareil = await prisma.appareil.create({
      data: { ...c, userId: user.id, dernierVuA: new Date() },
    });
    await logAudit({
      userId: user.id, action: "CREATE", entityType: "Appareil", entityId: appareil.id,
      after: { plateforme: appareil.plateforme, modele: appareil.modele },
      ipAddress: req.ip,
    });

    return res.status(201).json(appareil);
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/devices:
 *   get:
 *     summary: Liste les appareils — les siens, ou tous pour un ADMIN
 *     tags: [Devices v2]
 */
devicesV2Router.get("/", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const user = req.user!;
    // Controle de PERIMETRE, pas seulement de role : un agent voit ses appareils, pas
    // la flotte. Sans cela, n'importe quel porteur connaitrait les appareils de tous
    // et pourrait tenter d'en revoquer un.
    const where = user.role === "ADMIN" ? {} : { userId: user.id };
    return res.json(await prisma.appareil.findMany({ where, orderBy: { createdAt: "desc" } }));
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/devices/{id}/revoke:
 *   post:
 *     summary: Revoque un appareil, sans toucher au compte de son porteur
 *     tags: [Devices v2]
 */
devicesV2Router.post("/:id/revoke", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const user = req.user!;
    const appareil = await prisma.appareil.findUnique({ where: { id: req.params.id } });
    if (!appareil) return res.status(404).json({ message: "Appareil introuvable" });

    // Son porteur ou un ADMIN. Un agent doit pouvoir couper son propre telephone
    // perdu sans attendre que quelqu'un soit joignable.
    if (appareil.userId !== user.id && user.role !== "ADMIN") {
      return res.status(403).json({ message: "Appareil d'un autre utilisateur" });
    }
    if (appareil.revoqueA) {
      return res.status(409).json({ message: "Appareil déjà révoqué", revoqueA: appareil.revoqueA });
    }

    const revoque = await prisma.appareil.update({
      where: { id: appareil.id }, data: { revoqueA: new Date() },
    });
    // Un evenement de securite, pas une modification ordinaire : c'est ce qu'on relit
    // apres un incident.
    await logAudit({
      userId: user.id, action: "SECURITY_EVENT", entityType: "Appareil", entityId: appareil.id,
      before: { revoqueA: null }, after: { revoqueA: revoque.revoqueA, porteur: appareil.userId },
      ipAddress: req.ip,
    });

    return res.json(revoque);
  } catch (err) {
    return next(err);
  }
});
