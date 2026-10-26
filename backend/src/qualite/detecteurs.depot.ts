/**
 * Depot SQL des detecteurs de qualite : LECTURE SEULE.
 *
 * Chaque fonction ne fait que des SELECT. Aucune ne cree, ne modifie ni ne supprime : c'est verifie
 * trois fois (un test Vitest lit ce fichier et refuse tout mot d'ecriture ; un test mesure les
 * requetes emises ; le banc PostGIS rejoue le service dans une transaction READ ONLY et compare les
 * compteurs `pg_stat_xact_user_tables` avant et apres). Elles recoivent le client en parametre au
 * lieu de lire le client global : l'appelant peut donc leur donner un client de transaction deja
 * place en lecture seule (voir `detecteurs.service.ts`).
 *
 * Elles rendent des MESURES ; la decision (seuil, classification) est dans `detecteurs.noyau.ts`.
 *
 * COUT : le balayage est PAGINE par identifiant (`tailleLot` lignes par requete) pour ne pas charger
 * 261 387 troncons d'un coup, et SCOPE par region. La portee nationale reste possible mais couteuse
 * (le balayage hors-territoire seul a ete mesure a 14 a 20 secondes en production, voir
 * `anomalies.depot.ts`) : aucune duree n'est annoncee ici pour les autres detecteurs, elle n'a pas
 * ete mesuree sur la production.
 */
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { fragmentPerimetre, type PerimetreReseau } from "../lib/reseau";
import { REGION_NON_RENSEIGNEE } from "../lib/localisation";
import type {
  LignePkChaine, MesureRegion, MesureTroncon, PaireVoisine, PartLimite,
} from "./detecteurs.noyau";

/** Le seul pouvoir dont ce depot a besoin : lire. Un client de transaction Prisma convient. */
export type ClientLecture = Pick<PrismaClient, "$queryRaw">;

export interface PorteeDetecteurs {
  /** `null` examine tout le pays : couteux, a reserver a un traitement voulu. */
  regionId: number | null;
  /** Perimetre du registre examine (defaut « tout ») ; reutilise le predicat de `lib/reseau.ts`. */
  reseau?: PerimetreReseau;
}

const perimetre = (p: PorteeDetecteurs): Prisma.Sql => fragmentPerimetre(p.reseau ?? "tout", 't."sourceReference"');

/** Plafond de paires de voisins rendues par le detecteur de doublons : garde-fou contre une explosion. */
export const PLAFOND_PAIRES = 200_000;

export async function compterTronconsActifs(db: ClientLecture, p: PorteeDetecteurs): Promise<number> {
  const [r] = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n
      FROM troncons t
     WHERE t."deletedAt" IS NULL
       AND (${p.regionId}::int IS NULL OR t."regionId" = ${p.regionId}::int)
       ${perimetre(p)}
  `;
  return Number(r?.n ?? 0);
}

export async function nomsDesRegions(db: ClientLecture): Promise<Map<number, string>> {
  const lignes = await db.$queryRaw<{ id: number; nom: string }[]>`SELECT id, nom FROM regions ORDER BY id`;
  return new Map(lignes.map((l) => [l.id, l.nom]));
}

export interface EtatLimites {
  /** Limites de niveau 1 avec geometrie. */
  utilisables: number;
  /** Parmi elles, celles qui sont invalides (ignorees par la mesure des regions). */
  invalides: number;
}

export async function etatDesLimites(db: ClientLecture): Promise<EtatLimites> {
  const [r] = await db.$queryRaw<{ n: bigint; invalides: bigint }[]>`
    SELECT count(*) AS n, count(*) FILTER (WHERE NOT ST_IsValid(geom)) AS invalides
      FROM limites_admin
     WHERE niveau = 1 AND geom IS NOT NULL
  `;
  return { utilisables: Number(r?.n ?? 0), invalides: Number(r?.invalides ?? 0) };
}

interface LigneMesure {
  id: string;
  code: string;
  regionId: number | null;
  regionNom: string | null;
  longueurKm: number | null;
  pkDebut: number | null;
  pkFin: number | null;
  etat: string | null;
  dateDerniereEvaluation: Date | null;
  geomPresente: boolean;
  geomVide: boolean | null;
  geomValide: boolean | null;
  raisonInvalide: string | null;
  geomType: string | null;
  geomSrid: number | null;
  longueurGeomM: number | null;
}

/**
 * Une page de mesures de troncons actifs, apres `curseur` (identifiant), triee par identifiant.
 * Rend moins de `taille` lignes seulement a la derniere page.
 */
export async function mesurerTroncons(
  db: ClientLecture, p: PorteeDetecteurs, curseur: string | null, taille: number,
): Promise<MesureTroncon[]> {
  const lignes = await db.$queryRaw<LigneMesure[]>`
    SELECT t.id, t.code, t."regionId", r.nom AS "regionNom",
           t."longueurKm", t."pkDebut", t."pkFin", t.etat::text AS etat, t."dateDerniereEvaluation",
           (t.geom IS NOT NULL) AS "geomPresente",
           CASE WHEN t.geom IS NULL THEN NULL ELSE ST_IsEmpty(t.geom) END AS "geomVide",
           g.v AS "geomValide",
           CASE WHEN g.v IS FALSE THEN ST_IsValidReason(t.geom) END AS "raisonInvalide",
           CASE WHEN t.geom IS NULL THEN NULL ELSE ST_GeometryType(t.geom) END AS "geomType",
           CASE WHEN t.geom IS NULL THEN NULL ELSE ST_SRID(t.geom) END AS "geomSrid",
           CASE WHEN t.geom IS NULL OR ST_IsEmpty(t.geom) OR ST_SRID(t.geom) <> 4326 THEN NULL
                ELSE ST_Length(t.geom::geography) END AS "longueurGeomM"
      FROM (
        SELECT t.* FROM troncons t
         WHERE t."deletedAt" IS NULL
           AND (${p.regionId}::int IS NULL OR t."regionId" = ${p.regionId}::int)
           ${perimetre(p)}
           AND (${curseur}::text IS NULL OR t.id > ${curseur}::text)
         ORDER BY t.id
         LIMIT ${taille}::int
      ) t
      LEFT JOIN regions r ON r.id = t."regionId"
      LEFT JOIN LATERAL (
        SELECT CASE WHEN t.geom IS NULL OR ST_IsEmpty(t.geom) THEN NULL ELSE ST_IsValid(t.geom) END AS v
      ) g ON true
     ORDER BY t.id
  `;
  return lignes.map((l) => ({ ...l }));
}

interface LigneRegion {
  id: string;
  code: string;
  regionId: number | null;
  regionNom: string | null;
  regionCle: string | null;
  regionNonRenseignee: boolean;
  regionALimite: boolean;
  perimetre: string | null;
  parts: PartLimite[];
}

/**
 * Une page de mesures de region : pour chaque troncon valide, non vide et de longueur non nulle, la
 * part de sa longueur dans chaque limite de niveau 1 qu'il touche.
 *
 * Les limites invalides sont ECARTEES (ST_Intersection sur une geometrie invalide peut lever une
 * TopologyException et faire echouer tout le controle) ; le service signale leur nombre. Les troncons
 * invalides sont ecartes pour la meme raison : ils sont signales par GEOM_INVALIDE.
 */
export async function mesurerRegions(
  db: ClientLecture, p: PorteeDetecteurs, curseur: string | null, taille: number,
): Promise<MesureRegion[]> {
  const lignes = await db.$queryRaw<LigneRegion[]>`
    WITH lim AS MATERIALIZED (
      SELECT unaccent(lower(nom)) AS cle, nom, geom
        FROM limites_admin
       WHERE niveau = 1 AND geom IS NOT NULL AND ST_IsValid(geom)
    ), page AS (
      SELECT t.id, t.code, t."regionId", t.perimetre::text AS perimetre, t.geom,
             r.nom AS "regionNom", unaccent(lower(r.nom)) AS "regionCle",
             (r.nom = ${REGION_NON_RENSEIGNEE}) AS "regionNonRenseignee"
        FROM troncons t LEFT JOIN regions r ON r.id = t."regionId"
       WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL AND NOT ST_IsEmpty(t.geom)
         AND ST_IsValid(t.geom) AND ST_SRID(t.geom) = 4326 AND ST_Length(t.geom::geography) > 0
         AND (${p.regionId}::int IS NULL OR t."regionId" = ${p.regionId}::int)
         ${perimetre(p)}
         AND (${curseur}::text IS NULL OR t.id > ${curseur}::text)
       ORDER BY t.id
       LIMIT ${taille}::int
    )
    SELECT p.id, p.code, p."regionId", p."regionNom", p."regionCle", p."regionNonRenseignee", p.perimetre,
           EXISTS (SELECT 1 FROM lim WHERE lim.cle = p."regionCle") AS "regionALimite",
           coalesce((
             SELECT jsonb_agg(jsonb_build_object('cle', x.cle, 'nom', x.nom, 'part', x.part))
               FROM (
                 SELECT lim.cle, lim.nom,
                        -- Un trace ENTIEREMENT dans la limite vaut 1 sans passer par ST_Intersection : c'est le cas
                        -- le plus courant (donc le plus rapide), et GEOS 3.9.0 (celui de la base de rejeu locale)
                        -- rend un resultat VIDE pour un trace horizontal ou vertical inclus dans un polygone rectangulaire
                        -- (constate le 26/10/2026 : LINESTRING(1 5, 2 5) dans POLYGON((0 0,10 0,10 10,0 10,0 0))).
                        CASE WHEN ST_Covers(lim.geom, p.geom) THEN 1.0
                             ELSE ST_Length(ST_Intersection(p.geom, lim.geom)::geography)
                                    / ST_Length(p.geom::geography) END AS part
                   FROM lim
                  WHERE ST_Intersects(p.geom, lim.geom)
               ) x
           ), '[]'::jsonb) AS parts
      FROM page p
     ORDER BY p.id
  `;
  return lignes.map((l) => ({ ...l, parts: Array.isArray(l.parts) ? l.parts : [] }));
}

interface LignePk {
  id: string;
  code: string;
  nom: string;
  sectionPk: string;
  regionId: number | null;
  pkDebut: number | null;
  pkFin: number | null;
}

/**
 * Les troncons actifs qui portent une section de referencement, pour chaque (route, section) dont au
 * moins un membre est dans la portee. Ils sont peu nombreux (de l'ordre de 550 d'apres le script
 * `extraire-section-pk.ts`), d'ou l'absence de pagination. Le perimetre de reseau ne s'applique pas :
 * le chainage concerne la route, pas le registre.
 */
export async function chargerChainesPk(db: ClientLecture, p: PorteeDetecteurs): Promise<LignePkChaine[]> {
  return db.$queryRaw<LignePk[]>`
    SELECT t.id, t.code, t.nom, t."sectionPk", t."regionId", t."pkDebut", t."pkFin"
      FROM troncons t
     WHERE t."deletedAt" IS NULL AND t."sectionPk" IS NOT NULL
       AND (${p.regionId}::int IS NULL OR EXISTS (
             SELECT 1 FROM troncons s
              WHERE s.nom = t.nom AND s."sectionPk" = t."sectionPk"
                AND s."deletedAt" IS NULL AND s."regionId" = ${p.regionId}::int))
     ORDER BY t.nom, t."sectionPk", t."pkDebut", t.id
  `;
}

interface LignePaire {
  id: string;
  code: string;
  regionId: number | null;
  partenaireId: string;
  partenaireCode: string;
  partenaireRegionId: number | null;
  partenaireSourceReference: string | null;
  binaireIdentique: boolean;
  inverseIdentique: boolean;
  hausdorffDeg: number | null;
}

/**
 * Pour chaque troncon examine, ses voisins actifs dont l'emprise (boite englobante) est la meme a
 * `toleranceDeg` pres, dans les deux sens : deux traces quasi identiques ont des emprises quasi
 * identiques, et le filtre passe par l'index GiST `troncons_geom_gist`. Les geometries invalides ou
 * vides sont ecartees (signalees par ailleurs). Le partenaire peut etre HORS portee : un doublon
 * entre deux regions est un fait a voir.
 *
 * Hausdorff n'est calcule que si les binaires different. Le resultat est borne a PLAFOND_PAIRES.
 */
export async function chargerPairesVoisines(
  db: ClientLecture, p: PorteeDetecteurs, toleranceDeg: number,
): Promise<PaireVoisine[]> {
  return db.$queryRaw<LignePaire[]>`
    SELECT t.id, t.code, t."regionId",
           u.id AS "partenaireId", u.code AS "partenaireCode", u."regionId" AS "partenaireRegionId",
           u."sourceReference" AS "partenaireSourceReference",
           (ST_AsBinary(t.geom) = ST_AsBinary(u.geom)) AS "binaireIdentique",
           (ST_AsBinary(t.geom) = ST_AsBinary(ST_Reverse(u.geom))) AS "inverseIdentique",
           CASE WHEN ST_AsBinary(t.geom) = ST_AsBinary(u.geom) THEN NULL
                ELSE ST_HausdorffDistance(t.geom, u.geom) END AS "hausdorffDeg"
      FROM troncons t
      JOIN troncons u
        ON u.id <> t.id AND u."deletedAt" IS NULL AND u.geom IS NOT NULL
       AND u.geom && ST_Expand(t.geom, ${toleranceDeg}::float8)
       AND t.geom && ST_Expand(u.geom, ${toleranceDeg}::float8)
     WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL
       AND (${p.regionId}::int IS NULL OR t."regionId" = ${p.regionId}::int)
       ${perimetre(p)}
       AND NOT ST_IsEmpty(t.geom) AND NOT ST_IsEmpty(u.geom)
       AND ST_IsValid(t.geom) AND ST_IsValid(u.geom)
     ORDER BY t.id, u.id
     LIMIT ${PLAFOND_PAIRES}::int
  `;
}
