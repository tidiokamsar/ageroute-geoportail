/**
 * Carte d'un projet (contrat v2, section 4.4) : objets des jeux AUTORISES (et, a la demande, des jeux en controle, marques
 * `nonAutorise`), filtres par emprise, simplifies selon le zoom, plafonnes a 20 000 objets par reponse.
 *
 * Ce n'est PAS un export : la reponse est une couche d'affichage bornee (emprise visible, plafond). Aucune route ne livre un jeu
 * entier sous forme de fichier GeoJSON ou KML.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { introuvable } from "./erreurs";
import { INCLURE_JEU } from "./vues";

export const PLAFOND_OBJETS = 20_000;
/** A partir de ce zoom la geometrie est rendue telle quelle. */
const ZOOM_SANS_SIMPLIFICATION = 17;

/** Tolerance de simplification, en degres : un demi-pixel de tuile 256 px au zoom donne. */
export function toleranceDuZoom(zoom: number | undefined): number {
  if (zoom === undefined || zoom >= ZOOM_SANS_SIMPLIFICATION) return 0;
  return 360 / (256 * 2 ** zoom) / 2;
}

export interface DemandeCarte {
  projetId: string;
  jeuxIds?: string[];
  bbox?: [number, number, number, number];
  zoom?: number;
  inclureNonAutorises: boolean;
}

interface LigneObjet { objetId: string; jeuId: string; nom: string | null; typeGeom: string; longueurM: number | null; attributs: unknown; geojson: string }

export async function carte(d: DemandeCarte) {
  const projet = await prisma.projetVoirie.findFirst({ where: { id: d.projetId, deletedAt: null }, select: { id: true } });
  if (!projet) throw introuvable("Projet", "PROJET_INTROUVABLE");
  const statuts = d.inclureNonAutorises ? (["AUTORISE", "CONTROLE", "RECU"] as const) : (["AUTORISE"] as const);
  const jeux = await prisma.jeuDonneesProjet.findMany({
    where: { projetId: d.projetId, statut: { in: [...statuts] }, ...(d.jeuxIds ? { id: { in: d.jeuxIds } } : {}) },
    include: INCLURE_JEU,
    orderBy: [{ role: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });

  const tol = toleranceDuZoom(d.zoom);
  const filtreEmprise = d.bbox ? Prisma.sql`AND o."geom" && ST_MakeEnvelope(${d.bbox[0]}::float8, ${d.bbox[1]}::float8, ${d.bbox[2]}::float8, ${d.bbox[3]}::float8, 4326)` : Prisma.empty;
  const geom = tol > 0 ? Prisma.sql`ST_SimplifyPreserveTopology(o."geom", ${tol}::float8)` : Prisma.sql`o."geom"`;

  let restant = PLAFOND_OBJETS;
  let tronque = false;
  const couches = [];
  for (const j of jeux) {
    const lignes = restant > 0
      ? await prisma.$queryRaw<LigneObjet[]>`
          SELECT o."id"::text AS "objetId", o."jeuId" AS "jeuId", o."nom" AS "nom", o."typeGeom"::text AS "typeGeom", o."longueurM" AS "longueurM",
                 o."attributs" AS "attributs", ST_AsGeoJSON(${geom}, 6) AS "geojson"
            FROM "projets_voirie_objets" o
           WHERE o."jeuId" = ${j.id} ${filtreEmprise}
           ORDER BY o."ordre", o."id"
           LIMIT ${restant + 1}`
      : [];
    // Plafond deja atteint par les jeux precedents : on compte seulement, pour dire que cette couche est tronquee.
    let jeuTronque = lignes.length > restant;
    const gardees = jeuTronque ? lignes.slice(0, restant) : lignes;
    let total = gardees.length;
    if (jeuTronque || restant <= 0) {
      const t = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS "n" FROM "projets_voirie_objets" o WHERE o."jeuId" = ${j.id} ${filtreEmprise}`;
      total = t[0].n;
      jeuTronque = total > gardees.length;
    }
    restant -= gardees.length;
    if (jeuTronque) tronque = true;
    couches.push({
      type: "FeatureCollection" as const,
      jeuId: j.id,
      role: j.role,
      concessionnaire: j.concessionnaire ? { id: j.concessionnaire.id, nom: j.concessionnaire.nom } : null,
      typeReseau: j.typeReseau,
      statut: j.statut,
      nonAutorise: j.statut !== "AUTORISE",
      version: j.version,
      confidentialite: j.confidentialite,
      natureObjets: j.natureObjets,
      classePrecision: j.classePrecision,
      nbFeatures: gardees.length,
      total,
      tronque: jeuTronque,
      features: gardees.map((l) => ({
        type: "Feature" as const,
        id: l.objetId,
        geometry: JSON.parse(l.geojson) as unknown,
        properties: { objetId: l.objetId, jeuId: l.jeuId, nom: l.nom, typeGeom: l.typeGeom, longueurM: l.longueurM === null ? null : Math.round(l.longueurM * 100) / 100, attributs: l.attributs },
      })),
    });
  }
  return { projetId: d.projetId, zoom: d.zoom ?? null, bbox: d.bbox ?? null, plafond: PLAFOND_OBJETS, tronque, jeux: couches };
}
