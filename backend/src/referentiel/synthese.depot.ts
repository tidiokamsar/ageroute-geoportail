import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { clauseSqlReseauClasse } from "../lib/reseau";

/**
 * Synthese du referentiel des troncons pour le tableau de bord de la page « Tronçons routiers » (BDRI, lot B).
 *
 * PERIMETRE : le reseau classe (le referentiel publie), comme la liste par defaut et l'indicateur
 * `troncons_classes`. Le nombre de troncons est COMPTE en base, jamais ecrit dans le code.
 *
 * DEUX LONGUEURS, JAMAIS ADDITIONNEES : la longueur DECLAREE (`longueurKm`, saisie) et la longueur GEOMETRIQUE
 * (`ST_Length(geom::geography)`, geodesique, sur les seuls traces valides). Leur ecart est un constat du registre,
 * pas une correction.
 *
 * Les comptes d'anomalies viennent du REGISTRE (anomalies ouvertes et encore constatees) : ils valent ce que vaut
 * la derniere analyse, dont la date est rendue. Sans analyse, ils sont nuls et la synthese le dit.
 */

const reseau = Prisma.raw(clauseSqlReseauClasse('t."sourceReference"'));
const n = (v: unknown) => Number(v ?? 0);
const km = (v: unknown) => Math.round(Number(v ?? 0) * 10) / 10;

export interface Ventilation { cle: string; troncons: number; kmDeclares: number }

export interface Synthese {
  portee: { regionId: number | null };
  troncons: number;
  longueur: { declareeKm: number; geometriqueKm: number; methodeGeometrique: string; tronconsSansGeometrie: number };
  completude: { pkNonRenseignes: number; sansGeometrie: number; geometriesInvalides: number; classeNonRenseignee: number; revetementNonRenseigne: number; etatNonEvalue: number };
  validation: Ventilation[];
  parRegion: Ventilation[];
  parClasse: Ventilation[];
  parRevetement: Ventilation[];
  parEtat: Ventilation[];
  registre: { derniereAnalyse: string | null; ouvertes: number; doublonsPotentiels: number; parRegle: { regle: string; ouvertes: number }[] };
  activite: { inspections90j: number; chantiersEnCours: number };
}

export async function synthese(regionId: number | null): Promise<Synthese> {
  const region = Prisma.sql`(${regionId}::int IS NULL OR t."regionId" = ${regionId}::int)`;
  const [tot] = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT count(*) AS troncons,
           COALESCE(sum(t."longueurKm"), 0) AS declares,
           COALESCE(sum(ST_Length(t.geom::geography)) FILTER (WHERE t.geom IS NOT NULL AND ST_IsValid(t.geom)), 0) / 1000.0 AS geometriques,
           count(*) FILTER (WHERE t."pkDebut" = 0 AND t."pkFin" = 0) AS pk0,
           count(*) FILTER (WHERE t.geom IS NULL) AS sans_geom,
           count(*) FILTER (WHERE t.geom IS NOT NULL AND NOT ST_IsValid(t.geom)) AS invalides,
           count(*) FILTER (WHERE t.classe = 'NON_CLASSEE') AS classe_nr,
           count(*) FILTER (WHERE t.revetement = 'NON_RENSEIGNE') AS revetement_nr,
           count(*) FILTER (WHERE t.etat = 'NON_EVALUE') AS etat_ne
      FROM troncons t
     WHERE t."deletedAt" IS NULL AND ${reseau} AND ${region}
  `;
  const ventiler = async (colonne: Prisma.Sql, jointure = Prisma.empty): Promise<Ventilation[]> => {
    const lignes = await prisma.$queryRaw<{ cle: string | null; troncons: unknown; declares: unknown }[]>`
      SELECT ${colonne} AS cle, count(*) AS troncons, COALESCE(sum(t."longueurKm"), 0) AS declares
        FROM troncons t ${jointure}
       WHERE t."deletedAt" IS NULL AND ${reseau} AND ${region}
       GROUP BY 1 ORDER BY 2 DESC, 1
    `;
    return lignes.map((l) => ({ cle: l.cle ?? "NON_RENSEIGNE", troncons: n(l.troncons), kmDeclares: km(l.declares) }));
  };
  const [parRegion, parClasse, parRevetement, parEtat, validation] = await Promise.all([
    ventiler(Prisma.sql`r.nom`, Prisma.sql`LEFT JOIN regions r ON r.id = t."regionId"`),
    ventiler(Prisma.sql`t.classe::text`),
    ventiler(Prisma.sql`t.revetement::text`),
    ventiler(Prisma.sql`t.etat::text`),
    ventiler(Prisma.sql`COALESCE(t."statutValidation"::text, 'NON_RENSEIGNE')`),
  ]);

  const regReg = regionId === null ? {} : { regionId };
  const ouvertes = { statut: { in: ["A_EXAMINER", "CORRECTION_PROPOSEE", "VALIDEE"] }, disparueLe: null, ...regReg };
  const [parRegle, derniere] = await Promise.all([
    prisma.anomalieReferentiel.groupBy({ by: ["regle"], where: ouvertes, _count: { _all: true } }),
    prisma.anomalieReferentiel.aggregate({ where: regReg, _max: { derniereDetectionLe: true } }),
  ]);

  const [act] = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT
      (SELECT count(*) FROM inspections i JOIN troncons t ON t.id = i."tronconId"
        WHERE i."deletedAt" IS NULL AND t."deletedAt" IS NULL AND ${reseau} AND ${region}
          AND i."dateInspection" >= now() - interval '90 days') AS inspections,
      (SELECT count(*) FROM chantiers c JOIN troncons t ON t.id = c."tronconId"
        WHERE c."deletedAt" IS NULL AND t."deletedAt" IS NULL AND ${reseau} AND ${region}
          AND c.statut = 'EN_COURS') AS chantiers
  `;

  return {
    portee: { regionId },
    troncons: n(tot.troncons),
    longueur: { declareeKm: km(tot.declares), geometriqueKm: km(tot.geometriques), methodeGeometrique: "ST_Length(geom::geography), tracés valides seulement", tronconsSansGeometrie: n(tot.sans_geom) },
    completude: {
      pkNonRenseignes: n(tot.pk0), sansGeometrie: n(tot.sans_geom), geometriesInvalides: n(tot.invalides),
      classeNonRenseignee: n(tot.classe_nr), revetementNonRenseigne: n(tot.revetement_nr), etatNonEvalue: n(tot.etat_ne),
    },
    validation, parRegion, parClasse, parRevetement, parEtat,
    registre: {
      derniereAnalyse: derniere._max.derniereDetectionLe?.toISOString() ?? null,
      ouvertes: parRegle.reduce((s, r) => s + r._count._all, 0),
      doublonsPotentiels: parRegle.find((r) => r.regle === "DOUBLON_POTENTIEL")?._count._all ?? 0,
      parRegle: parRegle.map((r) => ({ regle: r.regle, ouvertes: r._count._all })).sort((a, b) => b.ouvertes - a.ouvertes),
    },
    activite: { inspections90j: n(act.inspections), chantiersEnCours: n(act.chantiers) },
  };
}
