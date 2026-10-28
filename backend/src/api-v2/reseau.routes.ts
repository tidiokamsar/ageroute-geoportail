/**
 * Indicateurs a l'echelle du reseau.
 *
 * POURQUOI LE PERIMETRE EST OBLIGATOIRE ET N'A PAS DE VALEUR PAR DEFAUT
 *
 * Une couverture « nationale » calculee sur les 261 387 troncons ne veut rien dire : 99,4 %
 * d'entre eux sont de la voirie locale reprise d'OpenStreetMap, que `lib/reseau.ts` exclut
 * deja du reseau classe. Le reseau qui porte les statistiques officielles en compte 1 691,
 * pour 21 156,6 km.
 *
 * Un defaut implicite ferait repondre a une question que l'appelant n'a pas posee, et c'est
 * exactement la faute que j'ai commise deux fois le 13/10 en divisant par le mauvais
 * perimetre. L'appelant DIT donc de quel reseau il parle.
 *
 * COUT MESURE LE 14/10/2026 EN PRODUCTION
 *
 *   perimetre reference, 1 691 troncons        212 ms
 *   perimetre tout, 261 387 troncons         3 286 ms
 *
 * Le critere d'acceptation etait « couverture par region en moins d'une seconde » : il est
 * tenu sur le reseau classe. Le registre complet coute quinze fois plus, d'ou le role requis.
 */
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { couvertureReseau } from "../reseau/couverture.reseau";

export const reseauV2Router = Router();

const requeteSchema = z.object({
  perimetre: z.enum(["reference", "voirie", "tout"]),
  regionId: z.coerce.number().int().positive().optional(),
}).strict();

/**
 * @openapi
 * /api/v2/reseau/couverture:
 *   get:
 *     summary: Part du reseau couverte par au moins une portion qualifiee
 *     description: >
 *       `perimetre` est OBLIGATOIRE : `reference` pour le reseau classe (1 691 troncons,
 *       21 156,6 km), `voirie` pour la voirie locale reprise d'OSM, `tout` pour le registre
 *       complet. Le perimetre `tout` exige le role ADMIN, car il coute quinze fois plus.
 *       Les trous ne sont pas enumeres ici : a l'echelle du reseau ils se comptent par
 *       milliers. La fiche d'un troncon les nomme un par un.
 *     tags: [Reseau]
 *     parameters:
 *       - in: query
 *         name: perimetre
 *         required: true
 *         schema: { type: string, enum: [reference, voirie, tout] }
 *       - in: query
 *         name: regionId
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Couverture totale et par region }
 *       400: { description: Perimetre absent ou invalide }
 *       403: { description: Perimetre `tout` sans le role ADMIN }
 */
reseauV2Router.get(
  "/couverture",
  requireAuth,
  requireModuleAccess("troncons"),
  async (req, res, next) => {
    try {
      const q = requeteSchema.safeParse(req.query);
      if (!q.success) {
        return res.status(400).json({
          code: "REQUETE_INVALIDE",
          message:
            "`perimetre` est obligatoire : reference (reseau classe), voirie (voirie locale)"
            + " ou tout (registre complet).",
          details: q.error.flatten(),
        });
      }

      // Le registre complet coute 3,3 s : il ne doit pas etre atteignable par inadvertance.
      if (q.data.perimetre === "tout" && req.user?.role !== "ADMIN") {
        return res.status(403).json({
          code: "PERIMETRE_RESERVE",
          message:
            "Le perimetre `tout` couvre les 261 387 troncons du registre et coute quinze fois"
            + " plus que le reseau classe. Il est reserve au role ADMIN.",
        });
      }

      const couverture = await couvertureReseau(q.data.perimetre, q.data.regionId ?? null);
      return res.json(couverture);
    } catch (err) {
      return next(err);
    }
  },
);
