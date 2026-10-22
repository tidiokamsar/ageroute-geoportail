/**
 * Analyse d'une trace GPS de releve en vehicule (paragraphe 7.13, cote serveur).
 *
 * Lit un fichier GPX ou CSV, le nettoie, le rattache au reseau par le HMM de
 * `appariement.trace.ts`, et rend les passages par troncon, les suites hors referentiel et les
 * indicateurs de qualite. RIEN N'EST ECRIT : c'est une analyse, pas un enregistrement.
 *
 * CE QUE CETTE ANALYSE NE FAIT PAS, ET DIT
 *
 * - LE GRAPHE DU RESEAU N'EST UTILISE QUE SUR DEMANDE. Il est construit a partir des extremites
 *   des troncons, fusionnees a une tolerance que l'APPELANT fournit (`toleranceFusionM`) : aucune
 *   valeur n'est mesuree sur le referentiel reel, donc aucune n'est supposee. Sans elle, la
 *   distance entre deux troncons differents est inconnue et `transitionsNonVerifiees` compte les
 *   transitions que rien n'a confirmees. Avec elle, une transition sans chemin sur le reseau
 *   charge reste « non verifiee » -- jamais jugee impossible, et dite dans les avertissements.
 *   Un taux de rattachement ne se lit pas sans ce nombre.
 * - Elle ne cree aucune portion, aucun troncon, aucune observation. Les passages et les suites
 *   hors referentiel sont des PROPOSITIONS que l'agent valide ensuite par les ecrans existants.
 * - Elle ne mesure pas l'IRI ni l'etat de la chaussee : une trace GPS ne les contient pas.
 * - Cette premiere version n'a pas ete mesuree sur le reseau reel : le cout d'une requete par
 *   lot de points n'est connu que sur la base de developpement.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import { clauseSqlReseauClasse } from "../lib/reseau";
import { apparierTrace, type PointTrace, type PointApparie } from "./appariement.trace";
import { DISTANCE_MAX_PAR_DEFAUT_M, INCERTITUDE_PAR_DEFAUT_M, type CandidatNoyau } from "./appariement.noyau";
import { distanceReseauDepuis } from "./graphe.noyau";
import { chargerGraphe, EmpriseTropLarge } from "./graphe.depot";
import {
  distanceM, emprise, lireCsv, lireGpx, nettoyer, PAS_MIN_PAR_DEFAUT_M, POINTS_MAX,
  type Lecture, type PointBrut,
} from "./trace.import.noyau";

export type DepotTrace = Pick<PrismaClient, "$queryRaw">;

export class RefusTrace extends Error {
  constructor(public readonly code: string, message: string, public readonly http: 400 | 422 = 422) { super(message); }
}

/** Candidats gardes par point : meme valeur que l'appariement ponctuel (`appariement.ts`). */
const CANDIDATS_PAR_POINT = 5;

/** Seuil du drapeau `court`. Choix provisoire, non calibre sur des traces reelles d'AGEROUTE. */
export const PASSAGE_COURT_POINTS = 2;

/**
 * Marge, en metres, ajoutee a l'emprise de la trace pour charger le graphe. Un chemin entre deux
 * troncons peut s'ecarter de la trace (un contournement) : sans marge, il serait introuvable et la
 * transition resterait « non verifiee ». CHOIX PROVISOIRE, non calibre sur le reseau reel.
 */
export const MARGE_GRAPHE_M = 2_000;

/**
 * Plus petite borne de la distance sur le reseau acceptee entre deux positions consecutives, en
 * metres. La borne reelle est le plus grand ecart entre deux points retenus, multiplie par
 * `FACTEUR_DETOUR`. CHOIX PROVISOIRE : un detour au-dela est tenu pour « non verifie », jamais
 * pour impossible.
 */
export const PLAFOND_RESEAU_MIN_M = 2_000;
export const FACTEUR_DETOUR = 3;

export interface OptionsTrace {
  /** `reference` = reseau classe (defaut) ; `tout` = tout le referentiel, plus lent et plus ambigu. */
  reseau?: "reference" | "tout";
  distanceMaxM?: number;
  pasMinM?: number;
  /**
   * Tolerance de fusion des extremites des troncons, en metres, pour construire le graphe qui
   * VERIFIE les changements de troncon. FOURNIE PAR L'APPELANT, JAMAIS SUPPOSEE : comme pour la
   * deviation, aucune valeur n'est mesuree sur le referentiel reel. Absente, le graphe n'est pas
   * utilise et les changements de troncon sont comptes « non verifies ».
   */
  toleranceFusionM?: number;
}

interface LigneCandidat {
  i: number; tronconId: string; code: string; nom: string | null; classe: string;
  distanceM: number; fraction: number; longueurM: number; pkDebut: number | null; pkFin: number | null;
}

export interface PassageAnalyse {
  tronconId: string;
  code: string;
  nom: string | null;
  indexDebut: number;
  indexFin: number;
  nombrePoints: number;
  /** Abscisses locales (metres depuis le debut du troncon) du premier et du dernier point rattache. */
  deM: number | null;
  aM: number | null;
  longueurM: number | null;
  sens: "CROISSANT" | "DECROISSANT" | "INDETERMINE";
  /**
   * Passage de PASSAGE_COURT_POINTS points ou moins : le plus souvent un carrefour ou une voie
   * parallele, rarement un vrai parcours. Signale pour verification, jamais supprime.
   */
  court: boolean;
  /** Portion parcourue, pour la carte. Null si la geometrie n'a pas pu etre extraite. */
  geojson: unknown | null;
}

export interface SuiteHorsReferentiel {
  indexDebut: number;
  indexFin: number;
  nombrePoints: number;
  longueurM: number;
  /** Coordonnees [lon, lat] de la suite, pour la carte et pour proposer un nouveau troncon. */
  coordonnees: [number, number][];
}

export interface AnalyseTrace {
  parametres: {
    reseau: "reference" | "tout";
    distanceMaxM: number;
    pasMinM: number;
    incertitudeParDefautM: number;
    pointsMax: number;
    /** Le graphe qui a verifie les changements de troncon, ou `null` quand il n'a pas ete demande. */
    graphe: { toleranceFusionM: number; margeM: number; nbTroncons: number; plafondReseauM: number } | null;
  };
  indicateurs: {
    pointsLus: number;
    pointsIgnores: number;
    pointsRetenus: number;
    retiresParPas: number;
    pointsRattaches: number;
    tauxRattachement: number;
    pointsPrecisionInsuffisante: number;
    transitionsNonVerifiees: number;
    chaines: number;
    distanceParcourueM: number;
    dureeS: number | null;
    vitesseMoyenneKmH: number | null;
    longueurSurReseauM: number;
  };
  passages: PassageAnalyse[];
  horsReferentiel: SuiteHorsReferentiel[];
  /** Trace retenue, [lon, lat], pour la carte. */
  trace: [number, number][];
  /** Un indicateur par point retenu : vrai si rattache au reseau. Meme ordre que `trace`. */
  rattache: boolean[];
  avertissements: string[];
}

/** Lit un contenu GPX ou CSV. Les refus de lecture deviennent des refus HTTP 400. */
export function lireTrace(format: "gpx" | "csv", contenu: string): Extract<Lecture, { refus: null }> {
  const l = format === "gpx" ? lireGpx(contenu) : lireCsv(contenu);
  if (l.refus !== null) throw new RefusTrace(l.refus, l.message, 400);
  return l;
}

export async function analyserTrace(
  depot: DepotTrace,
  lecture: { points: PointBrut[]; ignores?: number; avertissements?: string[] },
  options: OptionsTrace = {},
): Promise<AnalyseTrace> {
  const reseau = options.reseau ?? "reference";
  const distanceMaxM = options.distanceMaxM ?? DISTANCE_MAX_PAR_DEFAUT_M;
  const pasMinM = options.pasMinM ?? PAS_MIN_PAR_DEFAUT_M;

  const net = nettoyer(lecture.points, pasMinM);
  const pts = net.points;
  if (pts.length < 2) {
    throw new RefusTrace("TRACE_TROP_COURTE", "La trace compte moins de deux points distincts : rien a rattacher.");
  }
  if (pts.length > POINTS_MAX) {
    throw new RefusTrace(
      "TROP_DE_POINTS",
      `${pts.length} points apres nettoyage, pour un maximum de ${POINTS_MAX}. Augmenter le pas minimal (actuellement ${pasMinM} m) ou decouper la trace en plusieurs fichiers.`,
    );
  }

  // Une seule requete pour tous les points : le rayon de recherche est l'emprise de la trace
  // elargie de la distance maximale, et l'index de proximite classe les candidats.
  const e = emprise(pts, distanceMaxM);
  const filtreReseau = reseau === "tout" ? Prisma.empty : Prisma.sql`AND ${Prisma.raw(clauseSqlReseauClasse('t."sourceReference"'))}`;
  const lignes = await depot.$queryRaw<LigneCandidat[]>(Prisma.sql`
    WITH p AS (
      SELECT x.lat, x.lon, x.i
        FROM unnest(${pts.map((q) => String(q.lat))}::text[]::float8[], ${pts.map((q) => String(q.lon))}::text[]::float8[]) WITH ORDINALITY AS x(lat, lon, i)
    )
    SELECT (p.i - 1)::int AS "i", c."tronconId", c."code", c."nom", c."classe", c."distanceM", c."fraction",
           c."longueurM", c."pkDebut", c."pkFin"
      FROM p
      CROSS JOIN LATERAL (
        SELECT t."id" AS "tronconId", t."code", t."nom", t."classe"::text AS "classe",
               ST_Distance(t."geom"::geography, ST_SetSRID(ST_MakePoint(p.lon, p.lat), 4326)::geography) AS "distanceM",
               ST_LineLocatePoint(t."geom", ST_SetSRID(ST_MakePoint(p.lon, p.lat), 4326)) AS "fraction",
               ST_Length(t."geom"::geography) AS "longueurM", t."pkDebut", t."pkFin"
          FROM "troncons" t
         WHERE t."deletedAt" IS NULL AND t."geom" IS NOT NULL AND ST_GeometryType(t."geom") = 'ST_LineString'
           AND t."geom" && ST_MakeEnvelope(${e.ouest}::float8, ${e.sud}::float8, ${e.est}::float8, ${e.nord}::float8, 4326)
           ${filtreReseau}
         ORDER BY t."geom" <-> ST_SetSRID(ST_MakePoint(p.lon, p.lat), 4326)
         LIMIT ${CANDIDATS_PAR_POINT}
      ) c
     ORDER BY p.i`);

  const parPoint: CandidatNoyau[][] = pts.map(() => []);
  const noms = new Map<string, string | null>();
  for (const l of lignes) {
    if (l.i < 0 || l.i >= pts.length) continue;
    noms.set(l.tronconId, l.nom);
    parPoint[l.i].push({
      tronconId: l.tronconId, code: l.code, nom: l.nom, classe: l.classe,
      distanceM: Number(l.distanceM), fraction: Number(l.fraction), longueurM: Number(l.longueurM),
      pkDebut: l.pkDebut, pkFin: l.pkFin,
      // Orientation locale non fournie : le noyau reste neutre plutot que de la deviner.
      capTronconDeg: null,
    });
  }

  const trace: PointTrace[] = pts.map((q, i) => ({
    horodatageMs: q.tMs ?? i * 1000,
    position: { lat: q.lat, lon: q.lon, precisionM: q.precisionM },
    candidats: parPoint[i],
  }));
  // LE GRAPHE : verifie qu'un changement de troncon est un chemin reel sur le reseau. Sans lui, deux
  // candidats de troncons differents ne sont departages que par leur distance au point.
  let graphe: AnalyseTrace["parametres"]["graphe"] = null;
  let distanceReseauM: ReturnType<typeof distanceReseauDepuis> | undefined;
  if (options.toleranceFusionM !== undefined) {
    let ecartMaxM = 0;
    for (let i = 1; i < pts.length; i += 1) ecartMaxM = Math.max(ecartMaxM, distanceM(pts[i - 1], pts[i]));
    const plafondReseauM = Math.max(PLAFOND_RESEAU_MIN_M, Math.round(FACTEUR_DETOUR * ecartMaxM));
    let charge: Awaited<ReturnType<typeof chargerGraphe>>;
    try {
      charge = await chargerGraphe(depot, emprise(pts, distanceMaxM + MARGE_GRAPHE_M), options.toleranceFusionM);
    } catch (err) {
      // Refuser plutot que se degrader en silence : l'appelant a demande la verification.
      if (err instanceof EmpriseTropLarge) {
        throw new RefusTrace("GRAPHE_TROP_GRAND", `${err.message}. Retirer la verification sur le reseau, ou decouper la trace.`);
      }
      throw err;
    }
    distanceReseauM = distanceReseauDepuis(charge.graphe, { distanceMaxM: plafondReseauM });
    graphe = { toleranceFusionM: options.toleranceFusionM, margeM: MARGE_GRAPHE_M, nbTroncons: charge.nbTroncons, plafondReseauM };
  }
  const r = apparierTrace(trace, { distanceMaxM, ...(distanceReseauM ? { distanceReseauM } : {}) });

  const passages = await enrichirPassages(depot, r.passages, r.points, noms);

  const horsReferentiel: SuiteHorsReferentiel[] = r.horsReferentiel.map((s) => ({
    ...s,
    coordonnees: pts.slice(s.indexDebut, s.indexFin + 1).map((q) => [q.lon, q.lat] as [number, number]),
  }));

  let distanceParcourueM = 0;
  for (let i = 1; i < pts.length; i += 1) distanceParcourueM += distanceM(pts[i - 1], pts[i]);
  const t0 = pts[0].tMs, t1 = pts[pts.length - 1].tMs;
  const dureeS = t0 !== null && t1 !== null && t1 > t0 ? Math.round((t1 - t0) / 1000) : null;
  const vitesseMoyenneKmH = dureeS ? Math.round((distanceParcourueM / dureeS) * 3.6 * 10) / 10 : null;
  const longueurSurReseauM = Math.round(passages.reduce((s, p) => s + (p.longueurM ?? 0), 0));
  const taux = r.pointsTotal > 0 ? r.pointsRattaches / r.pointsTotal : 0;

  const avertissements = [...(lecture.avertissements ?? []), ...net.avertissements];
  if (pts.every((q) => q.precisionM === null)) {
    avertissements.push(`Aucune precision annoncee par le fichier : l'incertitude par defaut de ${INCERTITUDE_PAR_DEFAUT_M} m est appliquee a chaque point.`);
  }
  if (r.transitionsNonVerifiees > 0) {
    if (graphe === null) {
      avertissements.push(`${r.transitionsNonVerifiees} changement(s) de troncon ne sont pas verifies sur le reseau (le graphe n'est pas utilise) : fournir la tolerance de fusion des extremites pour les verifier, et lire le taux de rattachement avec cette reserve.`);
    } else {
      avertissements.push(`${r.transitionsNonVerifiees} changement(s) de troncon restent non verifies malgre le graphe (${graphe.nbTroncons} troncons charges, tolerance ${graphe.toleranceFusionM} m) : aucun chemin de moins de ${graphe.plafondReseauM} m n'a ete trouve. Causes possibles : troncon hors de l'emprise chargee, extremites non reliees a cette tolerance, ou detour plus long que le plafond.`);
    }
  }
  if (taux < 0.5) {
    avertissements.push("Moins de la moitie des points sont expliques par le reseau choisi : verifier le reseau (classe ou complet), la zone et la distance maximale.");
  }
  const nbCourts = passages.filter((p) => p.court).length;
  if (nbCourts > 0) {
    avertissements.push(`${nbCourts} passage(s) tres court(s) (${PASSAGE_COURT_POINTS} points ou moins) : souvent un carrefour ou une voie parallele, a verifier avant de s'y fier.`);
  }
  if (r.chaines > 1) {
    avertissements.push(`La trace est coupee en ${r.chaines} parties que le parcours n'a pas pu relier.`);
  }

  return {
    parametres: { reseau, distanceMaxM, pasMinM, incertitudeParDefautM: INCERTITUDE_PAR_DEFAUT_M, pointsMax: POINTS_MAX, graphe },
    indicateurs: {
      pointsLus: lecture.points.length + (lecture.ignores ?? 0),
      pointsIgnores: lecture.ignores ?? 0,
      pointsRetenus: pts.length,
      retiresParPas: net.retiresParPas,
      pointsRattaches: r.pointsRattaches,
      tauxRattachement: Math.round(taux * 1000) / 1000,
      pointsPrecisionInsuffisante: r.points.filter((p) => p.precisionInsuffisante).length,
      transitionsNonVerifiees: r.transitionsNonVerifiees,
      chaines: r.chaines,
      distanceParcourueM: Math.round(distanceParcourueM),
      dureeS,
      vitesseMoyenneKmH,
      longueurSurReseauM,
    },
    passages,
    horsReferentiel,
    trace: pts.map((q) => [q.lon, q.lat] as [number, number]),
    rattache: r.points.map((p) => p.tronconId !== null),
    avertissements,
  };
}

async function enrichirPassages(
  depot: DepotTrace,
  passages: { tronconId: string; code: string; indexDebut: number; indexFin: number; nombrePoints: number }[],
  points: readonly PointApparie[],
  noms: ReadonlyMap<string, string | null>,
): Promise<PassageAnalyse[]> {
  const base: PassageAnalyse[] = passages.map((p) => {
    // Premier et dernier point effectivement rattaches de ce passage, pour l'abscisse.
    const dans = points.filter((q) => q.index >= p.indexDebut && q.index <= p.indexFin && q.abscisseM !== null);
    const deM = dans.length ? dans[0].abscisseM : null;
    const aM = dans.length ? dans[dans.length - 1].abscisseM : null;
    const longueurM = deM !== null && aM !== null ? Math.round(Math.abs(aM - deM) * 10) / 10 : null;
    const sens = deM === null || aM === null || deM === aM ? "INDETERMINE" : aM > deM ? "CROISSANT" : "DECROISSANT";
    return { ...p, nom: noms.get(p.tronconId) ?? null, deM, aM, longueurM, sens, court: p.nombrePoints <= PASSAGE_COURT_POINTS, geojson: null };
  });

  const avecGeom = base.map((p, k) => ({ p, k })).filter(({ p }) => p.deM !== null && p.aM !== null && p.longueurM !== null && p.longueurM > 0);
  if (avecGeom.length === 0) return base;

  const ids = avecGeom.map(({ p }) => p.tronconId);
  // Les nombres partent en TEXTE, convertis cote SQL : pour un tableau de nombres, Prisma devine le type
  // d'apres le PREMIER element. [0, 19.87] partait en int8[] et 19.87 etait refuse (22P03).
  const de = avecGeom.map(({ p }) => p.deM as number);
  const a = avecGeom.map(({ p }) => p.aM as number);
  const geoms = await depot.$queryRaw<{ ordre: number; geojson: string | null }[]>`
    WITH s AS (SELECT * FROM unnest(${ids}::text[], ${de.map(String)}::text[]::float8[], ${a.map(String)}::text[]::float8[]) WITH ORDINALITY AS x(id, de, a, ordre)),
         m AS (SELECT s.ordre, t."geom", ST_Length(t."geom"::geography) AS l, s.de, s.a FROM s JOIN "troncons" t ON t."id" = s.id)
    SELECT m.ordre::int AS "ordre",
           ST_AsGeoJSON(CASE WHEN m.a >= m.de
             THEN ST_LineSubstring(m."geom", LEAST(1, m.de / m.l), LEAST(1, m.a / m.l))
             ELSE ST_Reverse(ST_LineSubstring(m."geom", LEAST(1, m.a / m.l), LEAST(1, m.de / m.l))) END) AS "geojson"
      FROM m ORDER BY m.ordre`;
  for (const g of geoms) {
    const cible = avecGeom[g.ordre - 1];
    if (cible && g.geojson) cible.p.geojson = JSON.parse(g.geojson);
  }
  return base;
}
