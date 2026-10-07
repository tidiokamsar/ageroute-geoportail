import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { prisma } from "../lib/prisma";
import { logAudit } from "../utils/audit";
import { TRANSITIONS, transitionPermise, perimetre } from "../field/missions.regles";

/**
 * `/api/v2/missions` — l'unite de travail du terrain.
 *
 * POURQUOI UNE MISSION PLUTOT QU'UNE INSPECTION
 *
 * Une Inspection v1 est attachee a UN troncon ou UN ouvrage et saisie dans un
 * formulaire. Le terrain reel est un deplacement : une equipe part sur un axe et
 * constate ce qu'elle rencontre, y compris ce que personne n'avait prevu. La mission
 * porte ce cadre — qui, ou, quand, avec quel vehicule — et les observations s'y
 * rattachent au lieu de devoir choisir un objet a l'avance.
 *
 * LE CONTROLE DE PERIMETRE EST LE POINT DELICAT
 *
 * Section 16 : « protegees par RBAC et controle de perimetre ». Le role ne suffit
 * pas. Deux agents de terrain ont le meme role et ne doivent pas voir les missions
 * l'un de l'autre : la liste d'un agent est filtree sur ce qui le concerne, et cette
 * regle est testee a part parce qu'elle ne se voit pas en lisant une route.
 */

export const missionsV2Router = Router();

const creation = z.object({
  code: z.string().min(1).max(64),
  intitule: z.string().min(1).max(300),
  type: z.enum([
    "INSPECTION", "INVENTAIRE", "SURVEILLANCE", "CONTROLE_CHANTIER",
    "RECEPTION", "SECURITE", "URGENCE", "RELEVE_SIG",
  ]),
  assigneId: z.string().uuid().optional(),
  regionId: z.number().int().optional(),
  chantierId: z.string().uuid().optional(),
  vehicule: z.string().max(60).optional(),
  equipe: z.string().max(300).optional(),
  debutPrevu: z.string().datetime().optional(),
  finPrevue: z.string().datetime().optional(),
});

/**
 * @openapi
 * /api/v2/missions:
 *   get:
 *     summary: Liste les missions visibles par le compte authentifie
 *     tags: [Missions v2]
 */
missionsV2Router.get("/", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const q = z.object({
      statut: z.string().max(32).optional(),
      limite: z.number().int().min(1).max(200).optional(),
    }).parse({ ...req.query, limite: req.query.limite ? Number(req.query.limite) : undefined });

    const missions = await prisma.mission.findMany({
      where: { ...perimetre(req.user!), ...(q.statut ? { statut: q.statut as never } : {}) },
      orderBy: [{ debutPrevu: "desc" }, { createdAt: "desc" }],
      take: q.limite ?? 50,
    });
    return res.json(missions);
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/missions/{id}:
 *   get:
 *     summary: Detail d'une mission
 *     tags: [Missions v2]
 */
missionsV2Router.get("/:id", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    // Le perimetre s'applique AUSSI a l'acces direct. Filtrer la liste sans filtrer
    // la fiche laisserait tout voir a qui devine un identifiant — et un identifiant
    // se trouve dans n'importe quel lien partage.
    const mission = await prisma.mission.findFirst({
      where: { id: req.params.id, ...perimetre(req.user!) },
      include: { traces: { select: { id: true, debutA: true, finA: true, distanceKm: true } } },
    });
    if (!mission) return res.status(404).json({ message: "Mission introuvable" });
    return res.json(mission);
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/missions:
 *   post:
 *     summary: Cree une mission
 *     tags: [Missions v2]
 */
missionsV2Router.post(
  "/", requireAuth, requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("inspections"),
  async (req, res, next) => {
    try {
      const c = creation.parse(req.body);
      const user = req.user!;

      // Le code est unique au schema. Le dire ici donne un message utile plutot
      // qu'une violation de contrainte remontee brute.
      if (await prisma.mission.findUnique({ where: { code: c.code }, select: { id: true } })) {
        return res.status(409).json({ message: `Une mission porte déjà le code ${c.code}` });
      }

      const mission = await prisma.mission.create({
        data: {
          ...c,
          debutPrevu: c.debutPrevu ? new Date(c.debutPrevu) : null,
          finPrevue: c.finPrevue ? new Date(c.finPrevue) : null,
          createurId: user.id,
        },
      });
      await logAudit({
        userId: user.id, action: "CREATE", entityType: "Mission",
        entityId: mission.id, after: mission, ipAddress: req.ip,
      });
      return res.status(201).json(mission);
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * @openapi
 * /api/v2/missions/{id}/statut:
 *   post:
 *     summary: Fait avancer une mission dans son cycle de vie
 *     tags: [Missions v2]
 */
missionsV2Router.post("/:id/statut", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const { statut } = z.object({
      statut: z.enum([
        "BROUILLON", "PLANIFIEE", "TELECHARGEE", "EN_COURS",
        "SUSPENDUE", "TERMINEE", "SYNC_EN_ATTENTE", "ANNULEE",
      ]),
    }).parse(req.body);

    const user = req.user!;
    const mission = await prisma.mission.findFirst({ where: { id: req.params.id, ...perimetre(user) } });
    if (!mission) return res.status(404).json({ message: "Mission introuvable" });

    if (!transitionPermise(mission.statut, statut)) {
      return res.status(409).json({
        message: `Transition ${mission.statut} vers ${statut} non autorisée`,
        transitionsPossibles: TRANSITIONS[mission.statut] ?? [],
      });
    }

    // Les horodatages reels sont poses par la transition, pas fournis par l'appelant :
    // un debut de mission saisi a la main ne vaut rien pour reconstituer une journee.
    const horodatage =
      statut === "EN_COURS" && !mission.debutReel ? { debutReel: new Date() }
      : statut === "TERMINEE" ? { finReelle: new Date() }
      : {};

    const apres = await prisma.mission.update({
      where: { id: mission.id }, data: { statut, ...horodatage },
    });
    await logAudit({
      userId: user.id, action: "UPDATE", entityType: "Mission", entityId: mission.id,
      before: { statut: mission.statut }, after: { statut: apres.statut }, ipAddress: req.ip,
    });

    return res.json(apres);
  } catch (err) {
    return next(err);
  }
});
