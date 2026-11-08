/**
 * Orchestrations d'ecriture de l'API d'observation de la Terre (chantier EO-API). Chaque fonction compose les fonctions du
 * service d'EO-DB (qui ecrivent le metier ET leur audit dans UNE transaction) avec ce que l'API ajoute, DANS LA MEME
 * transaction : le journal des identifiants d'un lot, le commentaire d'une demande de verification, les droits propres a
 * l'inspecteur. Rien ici ne touche `troncons`, `portions` ni `ouvrages`.
 */

import type { PrismaClient } from "@prisma/client";
import { logAuditTransactionnelle } from "../utils/audit";
import {
  ajouterPreuves, deposerPropositions, dispatcherVerification,
  type DepotPropositions, type DepotTeledetection,
} from "./teledetection.service";
import { AUDIT_IDS_PAR_LIGNE } from "./api.noyau";
import { RefusApi } from "./api.erreurs";
import type { PropositionVisible } from "./api.lecture";
import type { PerimetreEo } from "./teledetection.noyau";

type Depot = DepotTeledetection & { $transaction?: PrismaClient["$transaction"] };
interface Contexte { auteurId: string; ipAddress?: string; perimetre?: PerimetreEo }

async function enTransaction<T>(depot: Depot, f: (tx: DepotTeledetection) => Promise<T>, lot = false): Promise<T> {
  return depot.$transaction
    ? depot.$transaction((tx) => f(tx as unknown as DepotTeledetection), lot ? { timeout: 120_000, maxWait: 10_000 } : undefined)
    : f(depot);
}

/**
 * Depot d'un lot de propositions. Le service audite un resume (produit, methode, nombre, rattachees) ; ce resume ne disait pas
 * QUELLES propositions ont ete creees. On ajoute, dans la meme transaction, les identifiants (par lots de 500 par ligne de journal) :
 * un lot contestable se retrouve proposition par proposition.
 */
export async function deposerLot(depot: Depot, d: DepotPropositions, ctx: Contexte) {
  return enTransaction(depot, async (tx) => {
    const r = await deposerPropositions(tx, d, ctx);
    const parties = Math.ceil(r.ids.length / AUDIT_IDS_PAR_LIGNE);
    for (let i = 0; i < parties; i++) {
      await logAuditTransactionnelle(tx, {
        userId: ctx.auteurId, action: "CREATE", entityType: "PropositionTeledetection", entityId: d.produitId, ipAddress: ctx.ipAddress,
        after: { operation: "DEPOT_LOT_IDENTIFIANTS", produitId: d.produitId, partie: i + 1, parties, ids: r.ids.slice(i * AUDIT_IDS_PAR_LIGNE, (i + 1) * AUDIT_IDS_PAR_LIGNE) },
      });
    }
    return r;
  }, true);
}

/** Mission de verification. Le commentaire (<= 500) est journalise avec la creation : le service n'a pas de colonne pour lui. */
export async function demanderVerification(
  depot: Depot, propositionId: string, d: { assigneId?: string | null; debutPrevu?: Date | null; commentaire?: string }, ctx: Contexte,
) {
  return enTransaction(depot, async (tx) => {
    const mission = await dispatcherVerification(tx, propositionId, { assigneId: d.assigneId, debutPrevu: d.debutPrevu }, ctx);
    if (d.commentaire) {
      await logAuditTransactionnelle(tx, {
        userId: ctx.auteurId, action: "UPDATE", entityType: "PropositionTeledetection", entityId: propositionId, ipAddress: ctx.ipAddress,
        after: { operation: "DEMANDE_VERIFICATION", missionId: mission.id, commentaire: d.commentaire },
      });
    }
    return mission;
  });
}

/**
 * Preuves de terrain. ADMIN et GESTIONNAIRE citent toute observation existante ; l'INSPECTEUR (decision : lecture + preuves, sans decider) ne le
 * fait que sur une proposition LIEE A UNE MISSION QUI LUI EST AFFECTEE, et ne cite que SES observations. Il ne voit une proposition que dans
 * son perimetre (controle fait avant, en 404) ; la mission affectee est la condition en plus : sans elle, le droit de lire n'est pas un droit
 * d'ecrire au dossier d'un autre.
 */
export async function ajouterPreuvesApi(
  depot: Depot, p: PropositionVisible, observationIds: string[], utilisateur: { id: string; role: string }, ctx: Contexte,
) {
  if (utilisateur.role === "INSPECTEUR") {
    if (!p.missionId) throw new RefusApi(403, "MISSION_NON_AFFECTEE", "Un inspecteur n'ajoute des preuves que sur une proposition liee a une mission qui lui est affectee.");
    const m = await depot.$queryRaw<{ assigneId: string | null }[]>`SELECT "assigneId" FROM "missions" WHERE "id" = ${p.missionId} AND "deletedAt" IS NULL`;
    if (!m[0] || m[0].assigneId !== utilisateur.id) {
      throw new RefusApi(403, "MISSION_NON_AFFECTEE", "Un inspecteur n'ajoute des preuves que sur une proposition liee a une mission qui lui est affectee.");
    }
    const siennes = await depot.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "observations" WHERE "id" = ANY(${observationIds}::text[]) AND "agentId" = ${utilisateur.id} AND "deletedAt" IS NULL`;
    if (siennes.length !== new Set(observationIds).size) {
      throw new RefusApi(403, "OBSERVATION_NON_AUTEUR", "Un inspecteur ne cite que ses propres observations.");
    }
  }
  return ajouterPreuves(depot, { propositionId: p.id, observationIds, auteur: ctx.auteurId, perimetre: ctx.perimetre, ipAddress: ctx.ipAddress });
}
