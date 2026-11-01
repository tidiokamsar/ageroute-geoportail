import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { contexteTerrain, RAYON_ACTIFS_M } from "../field/contexte";
import { sourcesPrisma } from "../field/contexte.prisma";

/**
 * `/api/v2/field` — ce que l'agent voit la ou il se trouve.
 *
 * UNE SEULE ROUTE, ET EN LECTURE SEULE
 *
 * Elle repond a « ou suis-je et que sait-on d'ici », qui est la premiere question du mode
 * terrain. L'ECRITURE des portions viendra avec son propre jeu de routes et son workflow
 * de validation : melanger la lecture de contexte et la qualification dans un meme appel
 * aurait fait d'une consultation un acte, ce qui est exactement ce que la separation des
 * roles interdit.
 *
 * POURQUOI UN GET AVEC DES PARAMETRES DE REQUETE
 *
 * Le contexte est une lecture, idempotente et cachable par le client hors ligne. Un POST
 * aurait suggere un effet de bord qu'il n'y a pas.
 *
 * La position n'est pas une donnee personnelle au sens ou l'entendrait un portail public :
 * c'est la position d'un agent en mission, deja tracee par `traces`. Elle passe donc en
 * clair dans l'URL comme pour tout appel cartographique.
 */
export const fieldV2Router = Router();

const requete = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  /** Incertitude annoncee par l'appareil. Absente, le moteur prend le pire cas. */
  precisionM: z.coerce.number().positive().max(10_000).optional(),
  /**
   * Emprise de recherche en WKT. Sans elle, l'appariement balaie le reseau national :
   * 2,5 s par point contre 19 ms. Une mission telechargee en fournit une.
   */
  emprise: z.string().max(100_000).optional(),
  reseau: z.enum(["reference", "tout"]).optional(),
  /** Rayon de recherche des actifs. Borne a 2 km : au-dela ce n'est plus du terrain. */
  rayonActifsM: z.coerce.number().positive().max(2_000).optional(),
});

/**
 * @openapi
 * /api/v2/field/current-context:
 *   get:
 *     summary: Troncon actif, portion active, couverture et actifs a proximite
 *     description: >
 *       Rend `troncon: null` avec `motifSansTroncon` lorsque le GPS ou la densite du
 *       reseau ne permettent pas de conclure, et `portion: null` avec un motif qui
 *       distingue un troncon jamais inventorie d'un trou dans un inventaire commence.
 *       Les deux absences appellent des gestes differents. Les actifs sont cherches
 *       autour de la position et restent rendus meme quand l'appariement echoue.
 *     tags: [Field v2]
 *     parameters:
 *       - in: query
 *         name: lat
 *         required: true
 *         schema: { type: number }
 *       - in: query
 *         name: lon
 *         required: true
 *         schema: { type: number }
 *       - in: query
 *         name: precisionM
 *         schema: { type: number }
 *       - in: query
 *         name: emprise
 *         description: Emprise WKT. Fortement recommandee, voir la description.
 *         schema: { type: string }
 *       - in: query
 *         name: rayonActifsM
 *         schema: { type: number, default: 150 }
 *     responses:
 *       200:
 *         description: Contexte, y compris lorsque rien n'a pu etre apparie
 */
fieldV2Router.get(
  "/current-context",
  requireAuth,
  requireModuleAccess("geoportail"),
  async (req, res, next) => {
    try {
      const q = requete.parse(req.query);
      const contexte = await contexteTerrain(
        { lat: q.lat, lon: q.lon, precisionM: q.precisionM },
        sourcesPrisma,
        {
          appariement: { emprise: q.emprise, reseau: q.reseau },
          rayonActifsM: q.rayonActifsM ?? RAYON_ACTIFS_M,
        },
      );
      return res.json(contexte);
    } catch (err) {
      return next(err);
    }
  },
);
