/**
 * Service de l'observation de la Terre (partie E) : registre des produits, depot des propositions,
 * verdict du terrain, mission de verification.
 *
 * IL NE TELECHARGE RIEN ET NE TRAITE AUCUNE IMAGE. Le moteur de changement est hors de ce depot ;
 * ce service recoit ce qu'il produit -- des geometries avec un type, une methode et un score --
 * et les tient pour des PROPOSITIONS. Aucune n'ecrit dans le referentiel.
 *
 * LE RATTACHEMENT A UN TRONCON n'est fait que si l'appelant donne une tolerance, en metres : le
 * troncon vivant le plus proche dans ce rayon. Aucune tolerance n'est supposee ; sans elle, la
 * proposition reste non rattachee, et c'est dit.
 *
 * Toute ecriture est auditee dans la meme transaction.
 */

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { logAuditTransactionnelle } from "../utils/audit";
import {
  codeMissionTeledetection, verifierDepecheVerification, verifierProduit, verifierVerdict,
  type ProduitSaisi, type StatutProposition, type TypeProposition,
} from "./teledetection.noyau";

export type DepotTeledetection = Pick<PrismaClient, "$transaction" | "$queryRaw" | "$executeRaw" | "earthObservationProduct" | "propositionTeledetection" | "mission">;

export class RefusTeledetection extends Error {
  constructor(public readonly code: string, message: string, public readonly http: 400 | 404 | 409 = 409) { super(message); }
}

interface Contexte { auteurId: string; ipAddress?: string }

/**
 * GeoJSON minimal : le service n'en juge que le type. Des coordonnees absentes ou fausses font
 * echouer `ST_GeomFromGeoJSON`, puis la contrainte `ST_IsValid` : c'est la base qui tranche.
 */
export interface GeometrieGeoJson { type: string; coordinates?: unknown }

export async function enregistrerProduit(
  depot: DepotTeledetection, p: ProduitSaisi & { code: string; emprise: GeometrieGeoJson }, ctx: Contexte,
) {
  const v = verifierProduit(p);
  if (!v.ok) throw new RefusTeledetection(v.code, v.motif, 400);
  if (p.emprise?.type !== "Polygon") throw new RefusTeledetection("EMPRISE_INVALIDE", "L'emprise est un Polygon GeoJSON en EPSG:4326.", 400);
  if (await depot.earthObservationProduct.findUnique({ where: { code: p.code } })) {
    throw new RefusTeledetection("CODE_EXISTANT", `Le code ${p.code} est deja pris.`, 409);
  }
  const id = randomUUID();
  return depot.$transaction(async (tx) => {
    // La geometrie n'est pas geree par Prisma : une seule insertion parametree, emprise comprise.
    await tx.$executeRaw`INSERT INTO "earth_observation_products"
      ("id", "code", "palier", "source", "nature", "dateAcquisition", "dateFin", "resolutionM", "couvertureNuagesPct",
       "incertitude", "provenance", "licence", "versionTraitement", "autorisationDepenseRef", "emprise", "enregistreParId")
      VALUES (${id}, ${p.code}, ${p.palier}, ${p.source.trim()}, ${p.nature}, ${p.dateAcquisition}, ${p.dateFin ?? null}, ${p.resolutionM},
              ${p.couvertureNuagesPct ?? null}, ${p.incertitude.trim()}, ${p.provenance.trim()}, ${p.licence.trim()}, ${p.versionTraitement.trim()},
              ${p.autorisationDepenseRef?.trim() || null}, ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(p.emprise)}), 4326), ${ctx.auteurId})`;
    const produit = await tx.earthObservationProduct.findUniqueOrThrow({ where: { id } });
    await logAuditTransactionnelle(tx, {
      userId: ctx.auteurId, action: "CREATE", entityType: "EarthObservationProduct", entityId: id,
      after: { code: p.code, palier: p.palier, source: p.source, nature: p.nature, licence: p.licence, provenance: p.provenance },
      ipAddress: ctx.ipAddress,
    });
    return produit;
  });
}

export interface PropositionDeposee {
  type: TypeProposition;
  geometrie: GeometrieGeoJson;
  score?: number | null;
}

/**
 * Depose un lot de propositions issues d'une meme methode sur un meme produit. Rattachement au
 * troncon le plus proche seulement si `toleranceRattachementM` est donnee.
 */
export async function deposerPropositions(
  depot: DepotTeledetection,
  d: { produitId: string; produitReferenceId?: string | null; methode: string; toleranceRattachementM?: number | null; propositions: PropositionDeposee[] },
  ctx: Contexte,
) {
  if (!d.methode.trim()) throw new RefusTeledetection("METHODE_REQUISE", "La methode (nom et version) est obligatoire : la precision se mesure par methode.", 400);
  if (d.propositions.length === 0) throw new RefusTeledetection("LOT_VIDE", "Aucune proposition dans le lot.", 400);
  const tol = d.toleranceRattachementM ?? null;
  if (tol !== null && !(tol > 0 && tol <= 5000)) throw new RefusTeledetection("TOLERANCE_INVALIDE", "Tolerance de rattachement : metres, strictement positive, au plus 5 000.", 400);
  const produit = await depot.earthObservationProduct.findFirst({ where: { id: d.produitId, deletedAt: null } });
  if (!produit) throw new RefusTeledetection("PRODUIT_INEXISTANT", "Produit introuvable au registre.", 404);

  return depot.$transaction(async (tx) => {
    const ids: string[] = [];
    for (const p of d.propositions) {
      const id = randomUUID();
      const geojson = JSON.stringify(p.geometrie);
      // Le troncon vivant le plus proche dans le rayon, en geography (metres). Sans tolerance,
      // aucun rattachement : les deux colonnes restent nulles ensemble (contrainte pt_rattachement).
      await tx.$executeRaw`
        WITH g AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326) AS geom),
        proche AS (
          SELECT t."id", ST_Distance(t."geom"::geography, g.geom::geography) AS d
            FROM "troncons" t, g
           WHERE ${tol}::double precision IS NOT NULL AND t."deletedAt" IS NULL AND t."geom" IS NOT NULL
             AND ST_DWithin(t."geom"::geography, g.geom::geography, ${tol}::double precision)
           ORDER BY d ASC, t."id" ASC LIMIT 1
        )
        INSERT INTO "propositions_teledetection"
          ("id", "produitId", "produitReferenceId", "type", "methode", "score", "geom", "tronconId", "distanceTronconM", "creeParId")
        SELECT ${id}, ${d.produitId}, ${d.produitReferenceId ?? null}, ${p.type}, ${d.methode.trim()}, ${p.score ?? null}::double precision, g.geom,
               (SELECT "id" FROM proche), (SELECT d FROM proche), ${ctx.auteurId}
          FROM g`;
      ids.push(id);
    }
    const rattachees = await tx.propositionTeledetection.count({ where: { id: { in: ids }, tronconId: { not: null } } });
    await logAuditTransactionnelle(tx, {
      userId: ctx.auteurId, action: "CREATE", entityType: "PropositionTeledetection", entityId: d.produitId,
      after: { produitId: d.produitId, methode: d.methode, nombre: ids.length, rattachees, toleranceRattachementM: tol },
      ipAddress: ctx.ipAddress,
    });
    return { deposees: ids.length, rattachees, nonRattachees: ids.length - rattachees, ids, toleranceRattachementM: tol };
  });
}

export async function poserVerdict(
  depot: DepotTeledetection, id: string, v: { statut: string; motif: string; constatRef: string }, ctx: Contexte,
) {
  return depot.$transaction(async (tx) => {
    const p = await tx.propositionTeledetection.findUnique({ where: { id }, select: { statut: true } });
    if (!p) throw new RefusTeledetection("PROPOSITION_INEXISTANTE", "Proposition introuvable.", 404);
    const verdict = verifierVerdict(p.statut as StatutProposition, v);
    if (!verdict.ok) throw new RefusTeledetection(verdict.code, verdict.motif, verdict.code === "VERDICT_DEJA_RENDU" ? 409 : 400);
    // Mise a jour conditionnee au statut lu : deux verdicts simultanes ne passent pas tous les deux.
    const maj = await tx.propositionTeledetection.updateMany({
      where: { id, statut: "A_VERIFIER" },
      data: { statut: v.statut, verifieeParId: ctx.auteurId, verifieeLe: new Date(), motifVerdict: v.motif.trim(), constatRef: v.constatRef.trim() },
    });
    if (maj.count !== 1) throw new RefusTeledetection("VERDICT_DEJA_RENDU", "Un verdict a ete rendu entre-temps.", 409);
    await logAuditTransactionnelle(tx, {
      userId: ctx.auteurId, action: v.statut === "CONFIRMEE" ? "VALIDATE" : "REJECT", entityType: "PropositionTeledetection", entityId: id,
      before: { statut: "A_VERIFIER" }, after: { statut: v.statut, motif: v.motif, constatRef: v.constatRef },
      ipAddress: ctx.ipAddress,
    });
    return tx.propositionTeledetection.findUniqueOrThrow({ where: { id } });
  });
}

/** Depeche une mission SURVEILLANCE de verification sur la proposition (export vers EX-03). */
export async function depecherVerificationTeledetection(
  depot: DepotTeledetection, id: string, d: { assigneId?: string | null; debutPrevu?: Date | null }, ctx: Contexte,
) {
  return depot.$transaction(async (tx) => {
    const p = await tx.propositionTeledetection.findUnique({ where: { id }, select: { statut: true, missionId: true, type: true } });
    if (!p) throw new RefusTeledetection("PROPOSITION_INEXISTANTE", "Proposition introuvable.", 404);
    const v = verifierDepecheVerification({ statut: p.statut as StatutProposition, missionId: p.missionId });
    if (!v.ok) throw new RefusTeledetection(v.code, v.motif, 409);
    const racine = codeMissionTeledetection(id);
    const pris = new Set((await tx.mission.findMany({ where: { code: { startsWith: racine } }, select: { code: true } })).map((m) => m.code));
    let code = racine;
    for (let n = 2; pris.has(code); n++) code = `${racine}-${n}`;
    const mission = await tx.mission.create({
      data: {
        code, intitule: `Verification d'une proposition de teledetection (${p.type})`, type: "SURVEILLANCE",
        createurId: ctx.auteurId, assigneId: d.assigneId ?? null, debutPrevu: d.debutPrevu ?? null,
      },
    });
    await tx.propositionTeledetection.update({ where: { id }, data: { missionId: mission.id } });
    await logAuditTransactionnelle(tx, {
      userId: ctx.auteurId, action: "CREATE", entityType: "Mission", entityId: mission.id,
      after: { code, type: "SURVEILLANCE", statut: mission.statut, propositionTeledetectionId: id }, ipAddress: ctx.ipAddress,
    });
    return mission;
  });
}

export interface LignePrecision { type: string; methode: string; total: number; aVerifier: number; confirmees: number; infirmees: number; precision: number | null }

export async function precision(depot: Pick<DepotTeledetection, "$queryRaw">) {
  return depot.$queryRaw<LignePrecision[]>`SELECT * FROM "precision_teledetection" ORDER BY "type", "methode"`;
}
