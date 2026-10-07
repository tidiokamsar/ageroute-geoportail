import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { apparier, INCERTITUDE_PAR_DEFAUT_M, type Appariement } from "../geo/appariement";

/**
 * `/api/v2/geo` — appariement d'une position GPS sur le reseau.
 *
 * Section 12 du cahier des charges : « Tout point terrain doit pouvoir etre associe a
 * une route et a un troncon LORSQUE LA QUALITE GPS LE PERMET », et « une association
 * douteuse doit etre signalee et non imposee ». C'est exactement le contrat du moteur
 * sous-jacent, et ces routes ne font que l'exposer.
 *
 * POURQUOI LE LOT EST PLAFONNE
 *
 * Ce n'est pas une precaution de principe. Mesure du 07/10/2026 : apparier un point
 * contre le reseau national coute 2,5 s. J'ai lance ce jour-la une requete de 200
 * points sans y penser, soit dix-sept minutes de calcul sur la base qui sert la carte
 * publique, et j'ai du l'interrompre. Un lot non borne expose depuis le reseau est la
 * meme erreur, offerte a n'importe quel appelant.
 *
 * Deux gardes, donc : un plafond sur la taille du lot, et une emprise vivement
 * recommandee. Une mission telechargee en fournit une ; sans elle, la recherche
 * balaie le pays.
 */

export const geoV2Router = Router();

/**
 * 200 points, soit environ trois minutes de trajet a 1 Hz. Au-dela, l'appelant doit
 * decouper : cela l'oblige a rendre la main entre deux lots, et empeche une requete
 * unique de monopoliser une connexion.
 */
export const LOT_MAX = 200;

const position = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  /** Incertitude annoncee par l'appareil. Absente, le moteur prend le pire cas. */
  precisionM: z.number().positive().max(10_000).optional(),
  /** Rendu tel quel dans la reponse, pour que l'appelant reapparie ses points. */
  ref: z.string().max(64).optional(),
});

const options = z.object({
  /**
   * Emprise de recherche en WKT. C'est elle qui rend l'appariement utilisable :
   * 19 ms par point contre le reseau classe, 2,5 s contre le reseau national.
   */
  emprise: z.string().max(100_000).optional(),
  reseau: z.enum(["reference", "tout"]).optional(),
  distanceMaxM: z.number().positive().max(500).optional(),
  confianceMinimale: z.number().min(0).max(1).optional(),
});

const corpsUnitaire = position.merge(options);
const corpsLot = z.object({ points: z.array(position).min(1).max(LOT_MAX) }).merge(options);

/**
 * Reponse uniforme, que l'appariement aboutisse ou non.
 *
 * `apparie: false` n'est pas une erreur : c'est une reponse, et c'est meme la bonne
 * la ou le reseau est dense. Un 404 ou un 422 pousserait l'appelant a traiter le
 * refus comme une panne, donc a reessayer, alors qu'il doit demander a l'agent.
 */
function reponse(a: Appariement | null, ref?: string) {
  return ref === undefined
    ? (a ? { apparie: true as const, ...a } : { apparie: false as const, motif: "AUCUN_CANDIDAT_SUR" as const })
    : (a ? { ref, apparie: true as const, ...a } : { ref, apparie: false as const, motif: "AUCUN_CANDIDAT_SUR" as const });
}

/**
 * @openapi
 * /api/v2/geo/match:
 *   post:
 *     summary: Apparie une position GPS sur le reseau routier et calcule son PK
 *     description: >
 *       Rend `apparie: false` lorsque la qualite GPS ou la densite du reseau ne
 *       permettent pas de conclure. Le PK vaut `null` sur les troncons qui n'en
 *       portent pas d'exploitable, soit deux tiers du reseau classe.
 *     tags: [Geo v2]
 */
geoV2Router.post("/match", requireAuth, requireModuleAccess("geoportail"), async (req, res, next) => {
  try {
    const c = corpsUnitaire.parse(req.body);
    const a = await apparier(
      { lat: c.lat, lon: c.lon, precisionM: c.precisionM },
      { emprise: c.emprise, reseau: c.reseau, distanceMaxM: c.distanceMaxM, confianceMinimale: c.confianceMinimale },
    );
    return res.json(reponse(a));
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/geo/match/batch:
 *   post:
 *     summary: Apparie un lot de positions GPS (200 au plus)
 *     tags: [Geo v2]
 */
geoV2Router.post("/match/batch", requireAuth, requireModuleAccess("geoportail"), async (req, res, next) => {
  try {
    const c = corpsLot.parse(req.body);
    const opts = {
      emprise: c.emprise, reseau: c.reseau,
      distanceMaxM: c.distanceMaxM, confianceMinimale: c.confianceMinimale,
    };

    /**
     * En SERIE et non en parallele.
     *
     * Un Promise.all de 200 appariements ouvrirait 200 requetes simultanees sur le
     * pool Prisma, que la carte publique partage. Le lot irait plus vite et tout le
     * reste attendrait — y compris les visiteurs du site public, souvent en 3G.
     */
    const resultats = [];
    for (const p of c.points) {
      const a = await apparier({ lat: p.lat, lon: p.lon, precisionM: p.precisionM }, opts);
      resultats.push(reponse(a, p.ref ?? ""));
    }

    return res.json({
      total: resultats.length,
      apparies: resultats.filter((r) => r.apparie).length,
      // Compte a part : c'est l'indicateur qui dit a un responsable que la couverture
      // GPS d'une mission etait mauvaise, ou que la zone est trop dense pour conclure.
      nonApparies: resultats.filter((r) => !r.apparie).length,
      incertitudeParDefautM: INCERTITUDE_PAR_DEFAUT_M,
      resultats,
    });
  } catch (err) {
    return next(err);
  }
});
