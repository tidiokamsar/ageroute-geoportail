import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { apparier, INCERTITUDE_PAR_DEFAUT_M, type Appariement } from "../geo/appariement";
import { prisma } from "../lib/prisma";
import { RefusDeviationHttp, calculerDeviation } from "../geo/deviation.service";
import { EmpriseTropLarge } from "../geo/graphe.depot";
import { analyserTrace, lireTrace, RefusTrace } from "../geo/trace.service";
import { contourPays } from "../geo/contour.service";

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

/**
 * @openapi
 * /api/v2/geo/metre:
 *   post:
 *     summary: Longueur et surface d'une geometrie en projection UTM (paragraphe 7.1, scenario A5)
 *     tags: [Geo v2]
 *
 * La geometrie (GeoJSON, EPSG:4326) est mesuree dans SON fuseau UTM -- 28N a l'ouest de 12 deg O,
 * 29N au-dela -- jamais en degres. La reponse rend aussi les grandeurs geodesiques et l'ecart
 * relatif : le scenario A5 le borne a 1 %, et le banc `metre_utm.test.sql` le mesure. Rien n'est
 * ecrit en base.
 */
const corpsMetre = z.object({
  geometrie: z.object({
    type: z.enum(["LineString", "MultiLineString", "Polygon", "MultiPolygon"]),
    coordinates: z.array(z.unknown()).min(1),
  }),
});

geoV2Router.post("/metre", requireAuth, requireModuleAccess("geoportail"), async (req, res, next) => {
  const p = corpsMetre.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "geometrie invalide : LineString, MultiLineString, Polygon ou MultiPolygon en GeoJSON", details: p.error.flatten().fieldErrors });
  const geojson = JSON.stringify(p.data.geometrie);
  let valide: { valide: boolean; raison: string }[];
  try {
    valide = await prisma.$queryRaw<{ valide: boolean; raison: string }[]>`
      SELECT ST_IsValid(g) AS "valide", ST_IsValidReason(g) AS "raison" FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326) AS g) s`;
  } catch {
    // Coordonnees que PostGIS ne sait pas lire : c'est une erreur de l'appelant, pas du serveur.
    return res.status(400).json({ error: "geometrie illisible : coordonnees GeoJSON non conformes" });
  }
  try {
    // Une geometrie invalide est refusee avec sa raison : la reparer en silence (ST_MakeValid)
    // changerait la surface mesuree sans le dire (paragraphe 7.1).
    if (!valide[0]?.valide) return res.status(400).json({ error: `geometrie invalide : ${valide[0]?.raison ?? "inconnue"}` });
    const [m] = await prisma.$queryRaw<Record<string, number>[]>`SELECT * FROM metre_utm(ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326))`;
    return res.json({ ...m, methode: "projection UTM du fuseau du point interieur ; controle geodesique (geography)" });
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/geo/deviation:
 *   post:
 *     summary: Deviation routee autour d'une coupure de troncon (paragraphe 7.14, R-01)
 *     tags: [Geo v2]
 *
 * Le plus court chemin d'un bord de la coupure a l'autre sans l'emprunter. La tolerance de fusion
 * des extremites et la borne de recherche sont EXIGEES : aucune n'est supposee. Rien n'est ecrit.
 * Reseau non oriente, praticabilite non prise en compte : la reponse le dit.
 */
const corpsDeviation = z.object({
  tronconId: z.string().min(1),
  debutM: z.number().min(0).nullish(),
  finM: z.number().min(0).nullish(),
  distanceMaxM: z.number().positive().max(200_000),
  toleranceFusionM: z.number().positive().max(50),
});

geoV2Router.post("/deviation", requireAuth, requireModuleAccess("geoportail"), async (req, res, next) => {
  const p = corpsDeviation.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "corps invalide : tronconId, distanceMaxM (m, <= 200 000) et toleranceFusionM (m, <= 50) sont exiges", details: p.error.flatten().fieldErrors });
  try {
    return res.json(await calculerDeviation(prisma, p.data));
  } catch (err) {
    if (err instanceof RefusDeviationHttp) return res.status(err.http).json({ error: err.message, code: err.code });
    if (err instanceof EmpriseTropLarge) return res.status(422).json({ error: err.message, code: "EMPRISE_TROP_LARGE" });
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/geo/trace:
 *   post:
 *     summary: Analyse d'une trace GPS de releve en vehicule, GPX ou CSV (paragraphe 7.13)
 *     tags: [Geo v2]
 *
 * La trace est nettoyee, rattachee au reseau par un modele de Markov cache, et rendue sous forme de
 * passages par troncon, de suites hors referentiel et d'indicateurs de qualite. Rien n'est ecrit :
 * c'est une analyse. Les changements de troncon non verifies sur le reseau sont comptes dans la
 * reponse, et le taux de rattachement ne se lit pas sans eux.
 */
const corpsTrace = z.object({
  format: z.enum(["gpx", "csv"]),
  contenu: z.string().min(1).max(4_500_000),
  reseau: z.enum(["reference", "tout"]).optional(),
  distanceMaxM: z.number().positive().max(200).optional(),
  pasMinM: z.number().min(5).max(500).optional(),
  /** Tolerance de fusion des extremites pour verifier les changements de troncon sur le graphe. Facultative, jamais supposee. */
  toleranceFusionM: z.number().positive().max(50).optional(),
});

geoV2Router.post("/trace", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  const p = corpsTrace.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "corps invalide : format (gpx ou csv) et contenu sont exiges", details: p.error.flatten().fieldErrors });
  try {
    const lecture = lireTrace(p.data.format, p.data.contenu);
    return res.json(await analyserTrace(prisma, lecture, { reseau: p.data.reseau, distanceMaxM: p.data.distanceMaxM, pasMinM: p.data.pasMinM, toleranceFusionM: p.data.toleranceFusionM }));
  } catch (err) {
    if (err instanceof RefusTrace) return res.status(err.http).json({ error: err.message, code: err.code });
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/geo/contour:
 *   get:
 *     summary: Contour du pays (frontiere exterieure des 8 regions de la source OCHA COD-AB), simplifie
 *     tags: [Geo v2]
 *
 * Fond de repere du geoportail, pas une frontiere officielle : la reponse porte sa source, sa date et
 * un avertissement. 404 si la base ne porte aucune limite de niveau 1 (aucun trace de repli invente).
 */
geoV2Router.get("/contour", requireAuth, requireModuleAccess("geoportail"), async (_req, res, next) => {
  try {
    const contour = await contourPays(prisma);
    if (!contour) return res.status(404).json({ error: "Aucune limite administrative de niveau 1 en base.", code: "LIMITES_ABSENTES" });
    res.set("Cache-Control", "private, max-age=3600");
    return res.json(contour);
  } catch (err) {
    return next(err);
  }
});
