import { Router } from "express";
import rateLimit from "express-rate-limit";
import { createHash } from "node:crypto";
import { prisma } from "../lib/prisma";
import { CACHE_TUILE, COUCHES, ZOOM_MAX, ZOOM_MIN, lireTuile } from "./tuiles.noyau";
import { tuileReseau } from "./tuiles.service";

/**
 * `/api/public/tuiles` -- tuiles vectorielles du reseau (paragraphe 7.14), PUBLIQUES.
 *
 *   GET /                    description : couches, zooms, gabarit d'adresse (TileJSON reduit)
 *   GET /:z/:x/:y.mvt        la tuile (application/vnd.mapbox-vector-tile) ; 204 si vide
 *
 * Sans authentification, comme le reste de `/api/public`, mais avec son propre plafond de debit :
 * un ecran de carte demande une vingtaine de tuiles a chaque deplacement, la ou le plafond de
 * 60 requetes par minute de `/api/public` vise des appels uniques. Ne publie que ce que la carte
 * publique montre deja (reseau classe, voirie locale), avec les memes proprietes.
 */
export const tuilesRouter = Router();
tuilesRouter.use(rateLimit({ windowMs: 60 * 1000, max: 600 }));

tuilesRouter.get("/", (_req, res) => {
  res.json({
    format: "pbf (Mapbox Vector Tile 2.1)",
    schema: "xyz",
    gabarit: "/api/public/tuiles/{z}/{x}/{y}.mvt",
    minzoom: ZOOM_MIN,
    maxzoom: ZOOM_MAX,
    couches: COUCHES.map((c) => ({ id: c.nom, zoomMin: c.zoomMin, proprietes: c.proprietes })),
    systeme: "EPSG:3857 (Web Mercator), coordonnees de tuile sur 4096",
  });
});

tuilesRouter.get("/:z/:x/:y.mvt", async (req, res, next) => {
  const t = lireTuile(req.params.z, req.params.x, req.params.y);
  if (!t) { res.status(400).json({ error: `tuile invalide : z entier de ${ZOOM_MIN} a ${ZOOM_MAX}, x et y dans le pavage du zoom` }); return; }
  try {
    const mvt = await tuileReseau(prisma, t);
    res.setHeader("Cache-Control", CACHE_TUILE);
    if (mvt.length === 0) { res.status(204).end(); return; }
    const etag = `"${createHash("sha256").update(mvt).digest("base64url").slice(0, 27)}"`;
    res.setHeader("ETag", etag);
    if (req.headers["if-none-match"] === etag) { res.status(304).end(); return; }
    res.type("application/vnd.mapbox-vector-tile").send(mvt);
  } catch (err) { next(err); }
});
