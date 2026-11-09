/**
 * TRACE DES CONSULTATIONS de jeux sensibles (revue de securite, M4).
 *
 * LIRE LA GEOMETRIE D'UN RESEAU DE TIERS FAIT PARTIE DE LA MISSION d'un compte qui a la cle de module `projets-voirie` : la carte et la
 * couche de conflits de l'analyse rendent des geometries a tout lecteur du module. Ce n'est pas un export de fichier, mais c'est une
 * capacite d'extraction ; elle est donc TRACEE, pas interdite.
 *
 * Pour chaque jeu de niveau CONFIDENTIEL_CONCESSIONNAIRE ou INFRASTRUCTURE_SENSIBLE renvoye par la carte ou par l'analyse, une ligne
 * d'audit `ConsultationJeuProjet` (action SECURITY_EVENT) est ecrite, au plus UNE par compte, par jeu et par fenetre de 15 minutes.
 * Elle ne porte NI geometrie NI contenu : la route, le nombre d'objets rendus, l'emprise demandee et le zoom. L'ecriture precede la
 * remise des donnees (echec d'audit = pas de donnees), comme pour l'export CSV.
 */

import { prisma } from "../lib/prisma";
import { logAuditTransactionnelle } from "../utils/audit";
import { FENETRE_CONSULTATION_MIN } from "./config";
import type { Acteur } from "./projets.service";

export const NIVEAUX_TRACES = ["CONFIDENTIEL_CONCESSIONNAIRE", "INFRASTRUCTURE_SENSIBLE"] as const;

export interface JeuConsulte { id: string; confidentialite: string; nbObjets: number }
export interface ContexteConsultation { route: "carte" | "analyse" | "conflits" | "reseau" | "sources"; bbox: number[] | null; zoom: number | null }

/** Ecrit les lignes d'audit manquantes ; rend le nombre de lignes ecrites. */
export async function tracerConsultation(acteur: Acteur, jeux: readonly JeuConsulte[], ctx: ContexteConsultation): Promise<number> {
  const sensibles = jeux.filter((j) => (NIVEAUX_TRACES as readonly string[]).includes(j.confidentialite));
  if (sensibles.length === 0) return 0;
  return prisma.$transaction(async (tx) => {
    let ecrites = 0;
    for (const j of sensibles) {
      // Verrou consultatif par (compte, jeu) : deux requetes simultanees n'ecrivent qu'une ligne par fenetre.
      await tx.$queryRaw`SELECT 1 AS "ok" FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`pv-consultation|${acteur.id}|${j.id}`}, 0))) v`;
      const deja = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS "n" FROM "audit_logs"
         WHERE "entityType" = 'ConsultationJeuProjet' AND "entityId" = ${j.id} AND "userId" = ${acteur.id}
           AND "createdAt" > ((now() AT TIME ZONE 'UTC') - make_interval(mins => ${FENETRE_CONSULTATION_MIN}::int))`;
      if (deja[0].n > 0) continue;
      await logAuditTransactionnelle(tx, {
        userId: acteur.id, action: "SECURITY_EVENT", entityType: "ConsultationJeuProjet", entityId: j.id,
        after: { route: ctx.route, nbObjets: j.nbObjets, bbox: ctx.bbox, zoom: ctx.zoom, confidentialite: j.confidentialite, fenetreMin: FENETRE_CONSULTATION_MIN },
        ipAddress: acteur.ip,
      });
      ecrites += 1;
    }
    return ecrites;
  });
}
