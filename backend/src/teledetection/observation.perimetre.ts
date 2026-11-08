/**
 * Region d'une observation de terrain, pour decider si un compte REGIONAL peut la citer en preuve ou la lire (constat EO-FIX-BACK 2).
 *
 * UNE OBSERVATION NE PORTE PAS DE REGION : elle herite de celle de ce a quoi elle se rattache. La derivation est celle du reste de
 * l'application (`territoire/territoire.v2.ts`, `regionObservation`) : le PREMIER lien renseigne parmi troncon, ouvrage, chantier, puis la
 * mission de l'observation. Une observation sans aucun de ces liens, ou dont le lien n'a pas de region, a une region INCONNUE : elle n'est
 * visible que d'un compte national (en deduire une region de l'absence de localisation serait la faute que `territoire.noyau.ts` evite).
 *
 * Fragments SQL purs (aucune base ici) : le service d'ecriture et la lecture du detail les posent dans leurs requetes, pour que le
 * perimetre soit dans la requete et non applique apres coup.
 */

import { Prisma } from "@prisma/client";

/** Alias SQL de la table `observations` : une lettre ou un mot sans guillemet, fixe par le code appelant (jamais une entree). */
const ALIAS = /^[a-z][a-z0-9_]{0,15}$/;

/** Region de l'observation d'alias `alias` ; NULL si elle est inconnue. */
export function regionObservationSql(alias: string): Prisma.Sql {
  if (!ALIAS.test(alias)) throw new Error(`alias SQL refuse : ${alias}`);
  const o = (colonne: string) => `${alias}."${colonne}"`;
  return Prisma.raw(`CASE
    WHEN ${o("tronconId")} IS NOT NULL THEN (SELECT x."regionId" FROM "troncons" x WHERE x."id" = ${o("tronconId")})
    WHEN ${o("ouvrageId")} IS NOT NULL THEN (SELECT x."regionId" FROM "ouvrages" x WHERE x."id" = ${o("ouvrageId")})
    WHEN ${o("chantierId")} IS NOT NULL THEN (SELECT x."regionId" FROM "chantiers" x WHERE x."id" = ${o("chantierId")})
    ELSE (SELECT x."regionId" FROM "missions" x WHERE x."id" = ${o("missionId")})
  END`);
}

/** Condition « l'observation est dans ces regions » ; une region inconnue (NULL) n'y est jamais. `null` = compte national : aucune restriction. */
export function observationDansPortee(alias: string, regions: readonly number[] | null): Prisma.Sql {
  if (regions === null) return Prisma.sql`TRUE`;
  return Prisma.sql`COALESCE((${regionObservationSql(alias)}) = ANY(${[...regions]}::int[]), FALSE)`;
}
