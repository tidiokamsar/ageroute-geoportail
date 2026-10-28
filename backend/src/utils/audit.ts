import { prisma } from "../lib/prisma";
import type { AuditAction } from "@prisma/client";
import type { Prisma } from "@prisma/client";

interface LogParams {
  userId: string | null;
  action: AuditAction;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ipAddress?: string;
}

// P2-03 : l'echec d'audit ne doit jamais faire echouer la requete metier (regle
// d'origine conservee), mais il ne doit plus etre SILENCIEUX. Chaque echec est
// loggue avec son contexte (quelle action, quelle entite) et incremente un
// compteur consultable — un compteur qui monte signale des ecritures metier
// passees sans trace, et alimente la sonde /api/health.
let echecsAudit = 0;

export function echecsAuditDepuisDemarrage(): number {
  return echecsAudit;
}

/** Réservé aux tests : remet le compteur à zéro. */
export function _reinitialiserCompteurAudit(): void {
  echecsAudit = 0;
}

/**
 * Rend une valeur serialisable en JSON, en convertissant les BigInt.
 *
 * LE DEFAUT QU'ELLE FERME
 *
 * `JSON.stringify({ montantGnf: 12345n })` leve `TypeError: Do not know how to serialize
 * a BigInt`. Verifie, c'est un fait de langage et non une particularite de Prisma.
 *
 * `decomptes.service.ts` auditait `after: created`, et un decompte porte `montantGnf` en
 * BigInt. L'ecriture d'audit echouait donc vraisemblablement — et comme `logAudit` est
 * fail-soft, l'echec etait AVALE : la requete metier reussissait, le compteur
 * `echecsDepuisDemarrage` montait, et personne ne regardait `/api/health`.
 *
 * Je n'ai pas pu confirmer que l'echec se produit reellement : cela demande la base, et
 * le compteur de production que je ne peux pas lire. Mais la correction est juste dans
 * les deux cas, et elle devient NECESSAIRE : une fois l'audit dans la transaction, un
 * echec de serialisation ne serait plus avale, il casserait l'ecriture financiere.
 *
 * POURQUOI UNE CHAINE ET NON UN NOMBRE
 *
 * Un montant en francs guineens peut depasser `Number.MAX_SAFE_INTEGER` ; le modele le
 * declare en BigInt precisement pour cela. Convertir en nombre perdrait de la precision
 * en silence sur les gros montants — exactement ce qu'un journal financier ne doit pas
 * faire. La chaine est sans perte, et un lecteur voit tout de suite qu'il lit un entier
 * exact et non un flottant.
 *
 * PERIMETRE VOLONTAIREMENT ETROIT
 *
 * Seuls les BigInt sont convertis. Les dates, que `JSON.stringify` rend en ISO, et les
 * types que Prisma traite correctement sont laisses tels quels : un nettoyage profond
 * generique couterait a chaque ecriture et risquerait d'abimer ce qui marche.
 */
export function normaliserPourJson(valeur: unknown): unknown {
  if (typeof valeur === "bigint") return valeur.toString();
  if (Array.isArray(valeur)) return valeur.map(normaliserPourJson);
  if (valeur && typeof valeur === "object" && !(valeur instanceof Date)) {
    const sortie: Record<string, unknown> = {};
    for (const [cle, v] of Object.entries(valeur)) sortie[cle] = normaliserPourJson(v);
    return sortie;
  }
  return valeur;
}

/**
 * Ecrit la trace dans la transaction métier qui porte la mutation.
 * Une panne d'audit fait ainsi échouer et annuler cette transaction, contrairement
 * au helper historique destiné aux écritures déjà commitées.
 */
export async function logAuditTransactionnelle(
  tx: Pick<Prisma.TransactionClient, "auditLog">,
  params: LogParams,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      userId: params.userId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      before: normaliserPourJson(params.before) as never,
      after: normaliserPourJson(params.after) as never,
      ipAddress: params.ipAddress,
    },
  });
}

/**
 * Construit l'ecriture d'audit SANS l'executer, pour la forme tableau de
 * `$transaction`.
 *
 * POURQUOI UN CONSTRUCTEUR ET PAS `logAuditTransactionnelle`
 *
 * `logAuditTransactionnelle` demande un client de transaction, donc la forme
 * INTERACTIVE. La fabrique CRUD utilise la forme TABLEAU, et ce choix a une raison
 * documentee : le commit 4eb1525 a d'abord essaye la forme interactive, qui retrouvait
 * le modele par son nom derive de l'entite — cela compilait, fonctionnait, et
 * court-circuitait le delegue injecte dans la fabrique. `crud-factory.test.ts` s'est mis
 * a echouer parce qu'il ne voyait plus l'appel qu'il verifie. Le test avait raison.
 *
 * Ce constructeur suit donc le meme motif que `construireSaisies` pour la provenance :
 * on prepare l'ecriture, l'appelant la joint a sa transaction, et l'atomicite tient sans
 * rien court-circuiter.
 *
 * CE QUE CELA COUTE, ET IL FAUT LE DIRE
 *
 * Dans un tableau, les ecritures partent ENSEMBLE : la ligne retournee par la base n'est
 * pas connue au moment de construire l'audit. Le champ `after` ne peut donc pas etre la
 * ligne stockee ; c'est l'etat PROJETE, reconstruit depuis l'etat connu et la
 * modification appliquee. Les colonnes calculees par la base — `updatedAt` notamment —
 * n'y figurent pas.
 *
 * C'est une consequence que l'ADR 11 n'avait pas enregistree. Elle est acceptable pour
 * un journal, dont l'objet est de dire QUI a change QUOI, et elle doit etre connue avant
 * de migrer les huit services qui partagent cette fabrique.
 */
export function construireAudit(params: LogParams) {
  return prisma.auditLog.create({
    data: {
      userId: params.userId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      before: normaliserPourJson(params.before) as never,
      after: normaliserPourJson(params.after) as never,
      ipAddress: params.ipAddress,
    },
  });
}

export async function logAudit(params: LogParams): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: params.userId,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        before: normaliserPourJson(params.before) as never,
        after: normaliserPourJson(params.after) as never,
        ipAddress: params.ipAddress,
      },
    });
  } catch (err) {
    echecsAudit++;
    console.error("Echec ecriture audit_log", {
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      userId: params.userId,
      raison: err instanceof Error ? err.message : String(err),
    });
  }
}
