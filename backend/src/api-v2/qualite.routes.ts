import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { CORRECTION_PROPOSEE, GRAVITE_PAR_FAMILLE } from "../qualite/anomalies";
import {
  actifsSansValidation,
  donneesSansProvenance,
  doublonsDeGeometrie,
  geometriesInvalides,
  horsTerritoire,
  inspectionsPerimeesEnBase,
} from "../qualite/anomalies.depot";

/**
 * `/api/v2/qualite/anomalies` — le rapport de qualite des donnees.
 *
 * POURQUOI LA PORTEE NATIONALE EXIGE UN GESTE EXPLICITE
 *
 * Mesure du 13/10/2026 : le balayage hors-territoire sur les 261 387 troncons prend
 * 20 secondes. C'est acceptable une fois, pas a chaque rafraichissement d'un tableau de
 * bord : dix appels simultanes occuperaient la base de production trois minutes.
 *
 * `regionId` est donc demande par defaut, et la portee nationale exige `national=true`,
 * que seul un ADMIN peut poser. Ce n'est pas une question de confidentialite — le rapport
 * ne contient rien de sensible — c'est une question de COUT : il faut que celui qui lance
 * un balayage national l'ait voulu.
 *
 * POURQUOI RESERVE AUX GESTIONNAIRES ET ADMINISTRATEURS
 *
 * Un rapport qui nomme 6 572 troncons hors territoire et 42 doublons est une liste de
 * corrections a arbitrer, pas une information de terrain. L'ouvrir a tous n'aiderait
 * personne et donnerait a un agent l'impression qu'il doit y repondre.
 *
 * CE QUE CETTE ROUTE NE FAIT PAS
 *
 * Elle n'ecrit rien, ne corrige rien, ne supprime rien. Chaque famille porte sa correction
 * PROPOSEE, en texte, que quelqu'un applique par les routes normales et leur validation.
 * Le paragraphe 10 du cahier l'exige, et le patrimoine routier est une donnee d'archive.
 */
export const qualiteV2Router = Router();

const requete = z.object({
  regionId: z.coerce.number().int().positive().optional(),
  /** Portee nationale. Coute 20 s, d'ou le geste explicite et le role requis. */
  national: z.coerce.boolean().optional(),
  /**
   * Seuil de fraicheur des inspections, en jours.
   *
   * PARAMETRE ET NON CONSTANTE : le cahier ne dit pas a partir de quand une inspection est
   * trop ancienne. Le figer en ferait la norme d'AGEROUTE par defaut, meme regle que pour
   * les coefficients du RCI. L'appelant doit choisir.
   */
  fraicheurInspectionJours: z.coerce.number().int().min(1).max(10_000).default(365),
});

/**
 * @openapi
 * /api/v2/qualite/anomalies:
 *   get:
 *     summary: Rapport de qualite des donnees, agrege par famille
 *     description: >
 *       Rend un compte par famille, une part de la population examinee, et au plus vingt
 *       exemples. N'ecrit rien : chaque famille porte une correction proposee en texte.
 *       `regionId` est attendu ; la portee nationale exige `national=true` et le role ADMIN,
 *       parce qu'un balayage complet prend une vingtaine de secondes sur 261 387 troncons.
 *     tags: [Qualite v2]
 *     parameters:
 *       - in: query
 *         name: regionId
 *         schema: { type: integer }
 *       - in: query
 *         name: national
 *         description: Balayage complet. Reserve a ADMIN, et couteux.
 *         schema: { type: boolean }
 *       - in: query
 *         name: fraicheurInspectionJours
 *         description: Seuil au-dela duquel une inspection est perimee. Decision metier.
 *         schema: { type: integer, default: 365 }
 */
qualiteV2Router.get(
  "/anomalies",
  requireAuth,
  // `dashboard` et non un module « qualite » : il n'en existe pas dans `lib/modules.ts`, et
  // la route de qualite v1 utilise deja `dashboard`. En inventer un ici le rendrait absent
  // de l'ecran d'administration des droits, donc impossible a retirer a quelqu'un.
  requireModuleAccess("dashboard"),
  requireRole("ADMIN", "GESTIONNAIRE"),
  async (req, res, next) => {
    try {
      const q = requete.parse(req.query);
      const user = (req as unknown as { user: { role: string } }).user;

      if (q.national !== true && q.regionId === undefined) {
        return res.status(400).json({
          motif: "PORTEE_REQUISE",
          message:
            "Precisez regionId, ou national=true. Un balayage national coute une vingtaine "
            + "de secondes sur 261 387 troncons : il doit etre voulu.",
        });
      }
      if (q.national === true && user.role !== "ADMIN") {
        return res.status(403).json({
          motif: "NATIONAL_RESERVE_ADMIN",
          message: "Le balayage national est reserve aux administrateurs, pour son cout.",
        });
      }

      const portee = { regionId: q.national === true ? null : (q.regionId ?? null) };

      // En serie et non en parallele : six requetes spatiales simultanees sur la base de
      // production se disputeraient le meme pool de connexions, et le balayage
      // hors-territoire a lui seul tient 20 secondes. Le rapport n'est pas interactif.
      const familles = [
        await geometriesInvalides(portee),
        await doublonsDeGeometrie(portee),
        await horsTerritoire(portee),
        await actifsSansValidation(portee),
        await donneesSansProvenance(portee),
        await inspectionsPerimeesEnBase(portee, q.fraicheurInspectionJours),
      ];

      const rapport = familles
        .map((f) => ({
          famille: f.famille,
          gravite: GRAVITE_PAR_FAMILLE[f.famille],
          nombre: f.nombre,
          surTotal: f.surTotal,
          part: f.surTotal !== null && f.surTotal > 0
            ? Math.round((f.nombre / f.surTotal) * 10_000) / 10_000
            : null,
          correctionProposee: CORRECTION_PROPOSEE[f.famille],
          exemples: f.exemples.slice(0, 3),
          // Ventilation par type d'entite quand la famille couvre plusieurs tables (GEOMETRIE_INVALIDE).
          ...(f.parTypeEntite ? { parTypeEntite: f.parTypeEntite } : {}),
        }))
        // Les familles a zero sont CONSERVEES : « zero geometrie invalide » est une
        // information, et la masquer laisserait croire que le controle n'a pas tourne.
        .sort((a, b) => rang(a.gravite) - rang(b.gravite) || b.nombre - a.nombre);

      return res.json({
        portee: q.national === true ? "NATIONALE" : `REGION_${q.regionId}`,
        fraicheurInspectionJours: q.fraicheurInspectionJours,
        familles: rapport,
        /**
         * Ce que ce rapport ne couvre PAS, dit dans le rapport lui-meme.
         *
         * Un rapport de qualite qui taira ses propres trous est le pire des rapports : on
         * le lit comme exhaustif.
         */
        nonCouvert: [
          "La precision de la couche de limites administratives n'est pas verifiee : un trace"
          + " longeant la frontiere a cinquante metres compte comme hors territoire.",
          "Les chevauchements et ruptures de portions ne sont pas balayes ici : ils sont"
          + " calcules par troncon dans reseau/portions.ts, et l'agregation nationale"
          + " demande une vue materialisee qui n'existe pas.",
          "Les doublons sont detectes sur l'egalite BINAIRE des geometries : deux traces"
          + " identiques de representation differente ne sont pas vus.",
          "La validite des geometries est controlee sur les troncons, les chantiers, les portions"
          + " courantes, les limites administratives, les emprises de teledetection et les actifs"
          + " lineaires (ouvrages.geomLigne). Les points, la voirie locale, les traces et sessions"
          + " de roulage, les emprises de defauts et de missions ne le sont pas.",
        ],
      });
    } catch (err) {
      return next(err);
    }
  },
);

function rang(g: string): number {
  return g === "BLOQUANTE" ? 0 : g === "A_TRAITER" ? 1 : 2;
}
