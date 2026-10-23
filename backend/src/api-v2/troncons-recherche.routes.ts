import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { prisma } from "../lib/prisma";

/**
 * `/api/v2/troncons/recherche` — trouver un tronçon SANS connaître son nom.
 *
 * LE PROBLÈME VÉCU (22/10) : « pour chercher un tronçon il faut connaître nettement son
 * nom, c'est beaucoup ». L'agent terrain connaît une ROUTE (« RN1 », « Kindia »), un axe,
 * rarement le code « GN N0142 3-1216 ». Cette recherche accepte :
 *   - `q`      : un fragment de code OU de nom (Kindia, RN1, N0142…) ;
 *   - `region` : l'identifiant de région ;
 *   - `lat+lon`: une position — les plus PROCHES d'abord, distance au tronçon en mètres.
 *
 * La ville n'est pas un paramètre serveur : la liste des chefs-lieux reste un helper de
 * recherche LOCAL au client (décision D4 — jamais écrit en base). Le client résout
 * « Kindia » → lat/lon avec la même liste, puis appelle cette route : un seul mécanisme,
 * la ville n'est qu'un cas particulier du GPS.
 *
 * LA POSITION ORDONNE, ELLE NE CONFIRME RIEN : le rattachement fiable reste l'appariement
 * (`POST /api/v2/geo/match`, avec score et confiance). Ici on aide à CHOISIR.
 *
 * Performance : la distance géodésique n'est calculée que sur les tronçons retenus par
 * les filtres texte/région (limités avant calcul) ; à GPS seul, une boîte englobante
 * de ~60 km protège le parcours. Lecture seule, aucun paramètre interpolé.
 */

export const rechercheV2Router = Router();
rechercheV2Router.use(requireAuth, requireModuleAccess("geoportail"));

const params = z.object({
  q: z.string().trim().max(120).optional(),
  region: z.coerce.number().int().positive().optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  limite: z.coerce.number().int().min(1).max(50).optional(),
}).strict();

rechercheV2Router.get("/", async (req, res, next) => {
  try {
    const p = params.safeParse(req.query);
    if (!p.success) {
      res.status(400).json({ error: "paramètres invalides : q, region, lat+lon, limite (1-50)", details: p.error.flatten().fieldErrors });
      return;
    }
    const { q, region, lat, lon } = p.data;
    const limite = p.data.limite ?? 15;
    const avecGps = lat !== undefined && lon !== undefined;
    if (!q && !region && !avecGps) {
      res.status(400).json({ error: "fournissez au moins un critère : q (code ou nom), region, ou lat+lon" });
      return;
    }

    type Ligne = {
      id: string; code: string; nom: string; region: string; longueurKm: number;
      distanceM: number | null;
    };
    const lignes = await prisma.$queryRaw<Ligne[]>`
      WITH retenus AS (
        SELECT t.id, t.code, t.nom, r.nom AS region, t."longueurKm", t.geom
        FROM troncons t
        JOIN regions r ON r.id = t."regionId"
        WHERE t."deletedAt" IS NULL
          AND (${q ? prisma.$queryRaw`(t.code ILIKE ${"%" + q + "%"} OR t.nom ILIKE ${"%" + q + "%"})` : prisma.$queryRaw`TRUE`})
          AND (${region ? prisma.$queryRaw`t."regionId" = ${region}` : prisma.$queryRaw`TRUE`})
        LIMIT 500
      )
      SELECT id::text AS id, code, nom, region, "longueurKm" AS "longueurKm",
        CASE WHEN ${avecGps} AND geom IS NOT NULL THEN
          round(ST_Distance(geom::geography,
            ST_SetSRID(ST_MakePoint(${lon ?? 0}::float8, ${lat ?? 0}::float8), 4326)::geography)::numeric, 0)::int
        END AS "distanceM"
      FROM retenus
      ORDER BY
        CASE WHEN ${avecGps} AND geom IS NOT NULL THEN
          ST_Distance(geom::geography,
            ST_SetSRID(ST_MakePoint(${lon ?? 0}::float8, ${lat ?? 0}::float8), 4326)::geography)
        END ASC NULLS LAST,
        code ASC
      LIMIT ${limite}
    `;
    res.json({ data: lignes });
  } catch (err) { next(err); }
});
