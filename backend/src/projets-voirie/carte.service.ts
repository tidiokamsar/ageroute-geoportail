/**
 * Carte d'un projet (contrat v2, section 4.4) : objets des jeux AUTORISES (et, a la demande, des jeux en controle, marques
 * `nonAutorise`), filtres par emprise, simplifies selon le zoom, plafonnes par reponse.
 *
 * Ce n'est PAS un export : la reponse est une couche d'affichage bornee (emprise visible, plafond). Aucune route ne livre un jeu
 * entier sous forme de fichier GeoJSON ou KML.
 *
 * BORNES (revue de securite, M2 et M4) :
 *   - avec \`bbox\` : 20 000 objets par reponse ; SANS \`bbox\` : 5 000 objets et simplification d'une tuile de zoom 12 au plus fin,
 *     de sorte qu'une lecture « sans fenetre » ne reconstitue pas un reseau en une requete (\`plafond\` et \`tronque\` le disent) ;
 *   - \`statement_timeout\` de 10 s (PROJETS_VOIRIE_DELAI_CARTE_MS) : 504 CARTE_TROP_LONGUE au-dela, jamais un 500 ;
 *   - 6 cartes simultanees au plus (503 SERVICE_OCCUPE) ;
 *   - la consultation des jeux sensibles est TRACEE avant la remise (consultation.ts) : une ligne d'audit par compte, par jeu et par
 *     fenetre de 15 minutes, sans geometrie.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { Budget, avecErreurDelai } from "./bd";
import { delaiCarteMs, delaiVerrouMs } from "./config";
import { tracerConsultation } from "./consultation";
import { ErreurMetier, introuvable } from "./erreurs";
import { limiteurCartes } from "./limiteurs";
import type { Acteur } from "./projets.service";
import { classeEffective, natureEffective } from "./reseaux/types.noyau";
import { INCLURE_JEU } from "./vues";

export const PLAFOND_OBJETS = 20_000;
export const PLAFOND_OBJETS_SANS_BBOX = 5_000;
/** A partir de ce zoom la geometrie est rendue telle quelle. */
const ZOOM_SANS_SIMPLIFICATION = 17;
/** Zoom de simplification applique quand ni \`bbox\` ni \`zoom\` ne sont donnes. */
const ZOOM_PAR_DEFAUT_SANS_BBOX = 12;

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
  /** Compte qui consulte : sa consultation des jeux sensibles est tracee. */
  acteur?: Acteur;
}

interface LigneObjet {
  objetId: string; jeuId: string; nom: string | null; typeGeom: string; longueurM: number | null; attributs: unknown; geojson: string;
  /** Descripteur eventuel de l'objet (lot B1) : nature, classe de precision et type declares ; nuls si l'objet n'en a pas. */
  dNature: string | null; dClasse: string | null; dType: string | null;
}

export async function carte(d: DemandeCarte) {
  const projet = await prisma.projetVoirie.findFirst({ where: { id: d.projetId, deletedAt: null }, select: { id: true } });
  if (!projet) throw introuvable("Projet", "PROJET_INTROUVABLE");
  const statuts = d.inclureNonAutorises ? (["AUTORISE", "CONTROLE", "RECU"] as const) : (["AUTORISE"] as const);
  const jeux = await prisma.jeuDonneesProjet.findMany({
    where: { projetId: d.projetId, statut: { in: [...statuts] }, ...(d.jeuxIds ? { id: { in: d.jeuxIds } } : {}) },
    include: INCLURE_JEU,
    orderBy: [{ role: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });

  const plafond = d.bbox ? PLAFOND_OBJETS : PLAFOND_OBJETS_SANS_BBOX;
  const zoom = d.zoom ?? (d.bbox ? undefined : ZOOM_PAR_DEFAUT_SANS_BBOX);
  const tol = toleranceDuZoom(zoom);
  const filtreEmprise = d.bbox ? Prisma.sql`AND o."geom" && ST_MakeEnvelope(${d.bbox[0]}::float8, ${d.bbox[1]}::float8, ${d.bbox[2]}::float8, ${d.bbox[3]}::float8, 4326)` : Prisma.empty;
  const geom = tol > 0 ? Prisma.sql`ST_SimplifyPreserveTopology(o."geom", ${tol}::float8)` : Prisma.sql`o."geom"`;

  const delai = delaiCarteMs();
  const trop = () => new ErreurMetier(504, "CARTE_TROP_LONGUE", `La carte a depasse ${Math.round(delai / 1000)} s : reduisez la fenetre (bbox) ou le nombre de couches.`);

  const resultat = await limiteurCartes.executer(() => avecErreurDelai("CARTE_TROP_LONGUE", trop().message, () => prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const budget = new Budget(tx, delai, delaiVerrouMs(), trop);
    let restant = plafond;
    let tronque = false;
    const couches = [];
    for (const j of jeux) {
      const lignes = restant > 0
        ? await budget.etape(() => tx.$queryRaw<LigneObjet[]>`
            SELECT o."id"::text AS "objetId", o."jeuId" AS "jeuId", o."nom" AS "nom", o."typeGeom"::text AS "typeGeom", o."longueurM" AS "longueurM",
                   o."attributs" AS "attributs", ST_AsGeoJSON(${geom}, 6) AS "geojson",
                   d."nature"::text AS "dNature", d."classePrecision"::text AS "dClasse", d."typeObjet" AS "dType"
              FROM "projets_voirie_objets" o
              LEFT JOIN "reseau_objets_descripteurs" d ON d."objetId" = o."id"
             WHERE o."jeuId" = ${j.id} ${filtreEmprise}
             ORDER BY o."ordre", o."id"
             LIMIT ${restant + 1}`)
        : [];
      // Plafond deja atteint par les jeux precedents : on compte seulement, pour dire que cette couche est tronquee.
      let jeuTronque = lignes.length > restant;
      const gardees = jeuTronque ? lignes.slice(0, restant) : lignes;
      let total = gardees.length;
      if (jeuTronque || restant <= 0) {
        const t = await budget.etape(() => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS "n" FROM "projets_voirie_objets" o WHERE o."jeuId" = ${j.id} ${filtreEmprise}`);
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
        features: gardees.map((l) => {
          // Lot B1 : nature et classe EFFECTIVES de l'objet (descripteur, sinon jeu, sinon inconnue) pour styler circuits, infrastructures et equipements.
          const nature = natureEffective(l.dNature, j.natureObjets);
          const classe = classeEffective(l.dClasse, j.classePrecision);
          return {
            type: "Feature" as const,
            id: l.objetId,
            geometry: JSON.parse(l.geojson) as unknown,
            properties: {
              objetId: l.objetId, jeuId: l.jeuId, nom: l.nom, typeGeom: l.typeGeom, longueurM: l.longueurM === null ? null : Math.round(l.longueurM * 100) / 100, attributs: l.attributs,
              nature: nature.nature, origineNature: nature.origine, typeObjet: l.dType, classePrecision: classe.classe, origineClasse: classe.origine,
            },
          };
        }),
      });
    }
    return { couches, tronque };
  }, { timeout: delai + 15_000, maxWait: 10_000 })));

  // Trace de la consultation AVANT la remise : pas de donnees sans trace.
  if (d.acteur) {
    await tracerConsultation(
      d.acteur,
      resultat.couches.map((c) => ({ id: c.jeuId, confidentialite: c.confidentialite, nbObjets: c.nbFeatures })),
      { route: "carte", bbox: d.bbox ?? null, zoom: d.zoom ?? null },
    );
  }
  return { projetId: d.projetId, zoom: d.zoom ?? null, bbox: d.bbox ?? null, plafond, tronque: resultat.tronque, jeux: resultat.couches };
}
