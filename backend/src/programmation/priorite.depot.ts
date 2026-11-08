/**
 * ACCES SQL DE LA PRIORITE TECHNIQUE (lot AD-3). LECTURE SEULE : aucune ecriture dans ce fichier.
 *
 * Tout passe par `$queryRaw` ETIQUETE (valeurs liees par le pilote, jamais concatenees ; le garde-fou
 * `lib/sql-parametre.test.ts` interdit `$queryRawUnsafe`). Les memes tables que le moteur de programmation sont lues
 * par le meme canal ; aucune table n'est creee ni modifiee par ce lot.
 *
 * Aucune decision ici : ce fichier releve des FAITS (etat, trafic, points noirs, inspections, geometrie), le noyau
 * (priorite.noyau.ts) decide. En particulier, ce fichier ne dit JAMAIS « zero point noir » : il rend les trois comptes
 * (confirmes du troncon, non confirmes du troncon, confirmes du registre de la region) et le noyau applique la regle.
 */

import { Prisma } from "@prisma/client";
import { fragmentPerimetre } from "../lib/reseau";
import type { Db } from "./moteur.depot";
import type { ConstatDate, FaitsIntervention, ValiditeBareme } from "./priorite.noyau";

export interface FiltreFaits {
  /** Regions visibles du compte ; `null` = toutes (compte national). Un tableau vide ne voit rien. */
  regions: readonly number[] | null;
  regionId?: number;
  classe?: readonly string[];
  etat?: readonly string[];
  /** Bornes (incluses) sur la date du dernier constat, AAAA-MM-JJ. */
  depuis?: string;
  jusqua?: string;
  /** « Aujourd'hui » du calcul (AAAA-MM-JJ) : les constats posterieurs ne comptent pas. */
  dateReference: string;
  /** Plafond de lignes lues : on demande une ligne de plus que le maximum pour savoir si on le depasse. */
  limite: number;
  /** Emprise (ouest, sud, est, nord) : ajoute `dansBbox` a chaque ligne, sans restreindre la selection. */
  bbox?: readonly [number, number, number, number];
}

interface LigneFaits {
  id: string; code: string; nom: string | null; regionId: number | null; regionNom: string | null; classe: string | null; revetement: string | null; prefecture: string | null;
  etat: string | null; traficMoyenJma: number | null; traficDateComptage: string | null; criticiteStrategique: number | null; dateDerniereEvaluation: string | null;
  longueurKm: number | null; longueurGeometriqueM: number | null; longueurDerivee: boolean;
  pnConfirmes: number; pnNonConfirmes: number; pnRegistre: number;
  constats: { date: string; etat: string }[] | null;
  localisationMotif: string | null;
  qStatut: string | null; qSource: string | null; qObserveLe: string | null; qConfiance: string | null;
  sourceType: string | null; sourceConfiance: string | null;
  dansBbox: boolean | null;
}

export interface FaitsCharges { faits: FaitsIntervention[]; dansBbox: Set<string> }

/**
 * Les troncons candidats et leurs faits. MEME perimetre que `moteur.depot.chargerCandidats` (reseau classe de reference,
 * non supprimes, statut de validation nul ou VALIDE) ; les points noirs sont rendus en trois comptes, jamais en « zero ».
 *
 * Le point noir CONFIRME est celui dont le statut de validation est nul ou VALIDE ; A_VALIDER et A_CORRIGER sont comptes
 * a part (une alerte non confirmee reste distincte d'un risque valide), REJETE n'est compte nulle part.
 *
 * La longueur : la colonne metier et la longueur geometrique sont rendues separement, la premiere avec son drapeau
 * « derivee de la geometrie » (valeurs_qualite DERIVED), la seconde calculee sur le geoide (geography).
 */
export async function chargerFaits(db: Db, f: FiltreFaits): Promise<FaitsCharges> {
  if (f.regions !== null && f.regions.length === 0) return { faits: [], dansBbox: new Set() };
  const region = f.regionId != null
    ? Prisma.sql`AND tr."regionId" = ${f.regionId}`
    : f.regions !== null ? Prisma.sql`AND tr."regionId" IN (${Prisma.join([...f.regions])})` : Prisma.empty;
  const classe = f.classe && f.classe.length > 0 ? Prisma.sql`AND tr."classe"::text IN (${Prisma.join([...f.classe])})` : Prisma.empty;
  const etat = f.etat && f.etat.length > 0 ? Prisma.sql`AND tr."etat"::text IN (${Prisma.join([...f.etat])})` : Prisma.empty;
  const depuis = f.depuis ? Prisma.sql`AND d."dc" >= ${f.depuis}::date` : Prisma.empty;
  const jusqua = f.jusqua ? Prisma.sql`AND d."dc" <= ${f.jusqua}::date` : Prisma.empty;
  const bbox = f.bbox
    ? Prisma.sql`COALESCE(ST_Intersects(tr."geom", ST_MakeEnvelope(${f.bbox[0]}::float8, ${f.bbox[1]}::float8, ${f.bbox[2]}::float8, ${f.bbox[3]}::float8, 4326)), false)`
    : Prisma.sql`NULL::boolean`;

  const lignes = await db.$queryRaw<LigneFaits[]>`
    WITH pn_troncon AS (
      SELECT "tronconId",
             count(*) FILTER (WHERE "statutValidation" IS NULL OR "statutValidation" = 'VALIDE')::int AS "confirmes",
             count(*) FILTER (WHERE "statutValidation" IN ('A_VALIDER', 'A_CORRIGER'))::int AS "nonConfirmes"
        FROM "points_noirs" WHERE "deletedAt" IS NULL AND "tronconId" IS NOT NULL GROUP BY "tronconId"
    ), pn_region AS (
      SELECT "regionId", count(*)::int AS "n"
        FROM "points_noirs" WHERE "deletedAt" IS NULL AND ("statutValidation" IS NULL OR "statutValidation" = 'VALIDE') GROUP BY "regionId"
    )
    SELECT tr."id", tr."code", tr."nom", tr."regionId", rg."nom" AS "regionNom", tr."classe"::text AS "classe", tr."revetement"::text AS "revetement", tr."prefecture",
           tr."etat"::text AS "etat", tr."traficMoyenJma", to_char(tr."traficDateComptage", 'YYYY-MM-DD') AS "traficDateComptage", tr."criticiteStrategique",
           to_char(tr."dateDerniereEvaluation", 'YYYY-MM-DD') AS "dateDerniereEvaluation",
           tr."longueurKm", g."lg" AS "longueurGeometriqueM",
           EXISTS (SELECT 1 FROM "valeurs_qualite" vl WHERE vl."entityType" = 'Troncon' AND vl."entityId" = tr."id" AND vl."champ" = 'longueurKm' AND vl."statut" = 'DERIVED') AS "longueurDerivee",
           COALESCE(pt."confirmes", 0) AS "pnConfirmes", COALESCE(pt."nonConfirmes", 0) AS "pnNonConfirmes", COALESCE(pr."n", 0) AS "pnRegistre",
           ins."constats" AS "constats",
           CASE WHEN tr."geom" IS NULL THEN 'GEOMETRIE_ABSENTE'
                WHEN ST_IsEmpty(tr."geom") THEN 'GEOMETRIE_VIDE'
                WHEN NOT ST_IsValid(tr."geom") THEN 'GEOMETRIE_INVALIDE'
                WHEN ST_NPoints(tr."geom") < 2 THEN 'GEOMETRIE_DEGENEREE'
                WHEN g."lg" < 0.01 THEN 'LONGUEUR_GEOMETRIQUE_NULLE'
                ELSE NULL END AS "localisationMotif",
           qe."statut"::text AS "qStatut", qe."source" AS "qSource", to_char(qe."observedAt", 'YYYY-MM-DD') AS "qObserveLe", qe."confiance"::text AS "qConfiance",
           tr."sourceType"::text AS "sourceType", tr."sourceConfidence"::text AS "sourceConfiance",
           ${bbox} AS "dansBbox"
      FROM "troncons" tr
      -- Une seule mesure de la longueur geodesique et un seul passage sur les inspections par troncon.
      JOIN LATERAL (SELECT ST_Length(tr."geom"::geography) AS "lg") g ON true
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object('date', to_char(i."dateInspection", 'YYYY-MM-DD'), 'etat', i."etatObserve"::text) ORDER BY i."dateInspection", i."id") AS "constats",
               max(i."dateInspection"::date) FILTER (WHERE i."dateInspection"::date <= ${f.dateReference}::date) AS "dmax"
          FROM "inspections" i WHERE i."tronconId" = tr."id" AND i."deletedAt" IS NULL
      ) ins ON true
      JOIN LATERAL (
        SELECT GREATEST(CASE WHEN tr."dateDerniereEvaluation"::date <= ${f.dateReference}::date THEN tr."dateDerniereEvaluation"::date END, ins."dmax") AS "dc"
      ) d ON true
      LEFT JOIN "regions" rg ON rg."id" = tr."regionId"
      LEFT JOIN pn_troncon pt ON pt."tronconId" = tr."id"
      LEFT JOIN pn_region pr ON pr."regionId" = tr."regionId"
      LEFT JOIN "valeurs_qualite" qe ON qe."entityType" = 'Troncon' AND qe."entityId" = tr."id" AND qe."champ" = 'etat'
     WHERE tr."deletedAt" IS NULL
       AND (tr."statutValidation" IS NULL OR tr."statutValidation" = 'VALIDE')
       ${fragmentPerimetre("reference", 'tr."sourceReference"')}
       ${region} ${classe} ${etat} ${depuis} ${jusqua}
     ORDER BY tr."id" ASC
     LIMIT ${f.limite}`;

  const dansBbox = new Set<string>();
  const faits = lignes.map((l): FaitsIntervention => {
    if (l.dansBbox === true) dansBbox.add(l.id);
    return {
      id: l.id, code: l.code, nom: l.nom, regionId: l.regionId, regionNom: l.regionNom, classe: l.classe, revetement: l.revetement, prefecture: l.prefecture,
      etat: l.etat, traficMoyenJma: l.traficMoyenJma, traficDateComptage: l.traficDateComptage, criticiteStrategique: l.criticiteStrategique,
      pointsNoirs: { confirmes: l.pnConfirmes, nonConfirmes: l.pnNonConfirmes, registreRegion: l.pnRegistre },
      constats: (l.constats ?? []) as ConstatDate[],
      dateDerniereEvaluation: l.dateDerniereEvaluation,
      longueurKm: l.longueurKm, longueurMetierDerivee: l.longueurKm !== null && l.longueurKm > 0 ? l.longueurDerivee : null, longueurGeometriqueM: l.longueurGeometriqueM,
      localisation: { valide: l.localisationMotif === null, motif: l.localisationMotif },
      qualiteEtat: l.qStatut ? { statut: l.qStatut, source: l.qSource, observeLe: l.qObserveLe, confiance: l.qConfiance } : null,
      sourceTroncon: { type: l.sourceType, confiance: l.sourceConfiance },
    };
  });
  return { faits, dansBbox };
}

interface LigneValidite { id: number; version: number | null; source: string | null; validDe: string | null; validA: string | null }

/** Fenetre de validite des lignes de bareme actives (pour afficher « valable de ... a ... » a cote d'un cout). */
export async function chargerValiditesBaremes(db: Db): Promise<Record<string, ValiditeBareme>> {
  const l = await db.$queryRaw<LigneValidite[]>`
    SELECT "id", "version", "source", to_char("validDe", 'YYYY-MM-DD') AS "validDe", to_char("validA", 'YYYY-MM-DD') AS "validA"
      FROM "baremes_intervention" WHERE "actif"`;
  return Object.fromEntries(l.map((b) => [String(b.id), { version: b.version, source: b.source, validDe: b.validDe, validA: b.validA }]));
}

/**
 * Geometries a servir en GeoJSON pour une liste d'identifiants, SIMPLIFIEES a la tolerance demandee (degres) en conservant
 * la topologie, 6 decimales (environ 0,1 m). Seuls les troncons dont la geometrie a ete jugee exploitable sont demandes.
 */
export async function chargerGeometries(db: Db, ids: readonly string[], toleranceDeg: number): Promise<Map<string, unknown>> {
  if (ids.length === 0) return new Map();
  const l = await db.$queryRaw<{ id: string; g: string | null }[]>`
    SELECT tr."id", ST_AsGeoJSON(ST_SimplifyPreserveTopology(tr."geom", ${toleranceDeg}::float8), 6) AS "g"
      FROM "troncons" tr WHERE tr."id" IN (${Prisma.join([...ids])})`;
  const m = new Map<string, unknown>();
  for (const x of l) if (x.g) m.set(x.id, JSON.parse(x.g));
  return m;
}

// ---------------------------------------------------------------------------------------------
// Decisions humaines : les fiches d'intervention figees qui citent le troncon
// ---------------------------------------------------------------------------------------------

export interface FicheDuTroncon {
  id: string; reference: string; scenarioId: string; annee: number; parametresVersion: string; statut: string; rangStatut: number;
  statutDepuis: Date; figeLe: Date; figeParId: string;
}
export interface StatutDeFiche { ficheId: string; rang: number; de: string | null; vers: string; origine: string; motif: string | null; auteurId: string | null; enregistreLe: Date }

export async function fichesDuTroncon(db: Db, tronconId: string): Promise<{ fiches: FicheDuTroncon[]; statuts: StatutDeFiche[] }> {
  const fiches = await db.$queryRaw<FicheDuTroncon[]>`
    SELECT c."id", c."reference", c."scenarioId", c."annee", c."parametresVersion", c."statut", c."rangStatut", c."statutDepuis", c."figeLe", c."figeParId"
      FROM "fiches_intervention_courantes" c WHERE c."tronconId" = ${tronconId}
     ORDER BY c."figeLe" DESC, c."id" ASC LIMIT 50`;
  if (fiches.length === 0) return { fiches, statuts: [] };
  const statuts = await db.$queryRaw<StatutDeFiche[]>`
    SELECT "ficheId", "rang", "de", "vers", "origine", "motif", "auteurId", "enregistreLe"
      FROM "fiches_intervention_statuts" WHERE "ficheId" IN (${Prisma.join(fiches.map((x) => x.id))}) ORDER BY "ficheId" ASC, "rang" ASC`;
  return { fiches, statuts };
}
