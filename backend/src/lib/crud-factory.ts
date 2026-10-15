import { randomUUID } from "crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { logAuditTransactionnelle } from "../utils/audit";
import { prisma } from "./prisma";
import { construireSaisies } from "./provenance";
import { ApiError } from "../middleware/error.middleware";

export interface ListParams {
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  where?: Record<string, unknown>;
  archived?: boolean;
}

export interface BulkResult {
  success: number;
  failed: { id: string; message: string }[];
}

export interface ListResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// Delegate Prisma assoupli en "any" : chaque modele (Troncon, Ouvrage, ...) a une signature
// d'arguments distincte (TronconFindManyArgs, OuvrageFindManyArgs, ...) incompatible avec une
// interface generique stricte. Les modules appelants restent types via leurs schemas Zod.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrismaDelegate = any;

/**
 * Fabrique un service CRUD standard (pagination/tri/filtre serveur + soft delete + audit)
 * pour toute entite patrimoniale possedant les champs id/deletedAt/createdAt.
 */
/**
 * Options de montage.
 *
 * TOUTE ECRITURE DE CETTE FABRIQUE EST TRACEE, SANS EXCEPTION POSSIBLE.
 *
 * Huit services la partagent — chantiers, documents, inspections, marches, ouvrages,
 * points noirs, postes, troncons — et la mutation part desormais avec sa ligne d'audit
 * dans une seule transaction : les deux reussissent, ou les deux sont annulees.
 *
 * Une panne sur `audit_logs` fait donc ECHOUER l'ecriture metier, au lieu de la laisser
 * passer sans trace. C'est la garantie que veut la regle 3 d'AGENTS.md, et c'est un
 * changement de comportement assume : voir l'ADR 11, qui l'expose comme son option 3.
 *
 * Il n'y a plus d'echappatoire, et c'est voulu. Elle a existe le temps de migrer les huit
 * services un par un ; une fois tous migres, elle n'etait plus qu'un code mort dans lequel
 * on pouvait retomber par omission.
 */
export interface OptionsCrud {
  /** Relations chargees par defaut sur les lectures. */
  include?: Record<string, unknown>;

  /**
   * Resout le delegue du modele DANS une transaction interactive. OBLIGATOIRE.
   *
   * POURQUOI LA FORME INTERACTIVE
   *
   * La fidelite du champ `after` l'exige : dans la forme tableau, la ligne retournee par
   * la base n'est pas connue au moment de construire la trace, et l'audit ne pouvait
   * enregistrer qu'un etat projete, sans les colonnes calculees.
   *
   * POURQUOI L'APPELANT LE FOURNIT
   *
   * Le commit 4eb1525 avait essaye l'interactif en retrouvant le modele par son nom
   * DERIVE de l'entite. Cela compilait, fonctionnait, et court-circuitait le delegue
   * injecte dans la fabrique : `crud-factory.test.ts` s'est mis a echouer parce qu'il ne
   * voyait plus l'appel qu'il verifie. Le test avait raison, et la cause etait la
   * derivation du nom.
   *
   * Ici l'appelant ecrit `(tx) => tx.inspection`. Aucun nom n'est devine, le delegue
   * reste celui que l'appelant designe, et un test peut injecter le sien.
   *
   * POURQUOI IL EST OBLIGATOIRE DEPUIS LE 13/10/2026
   *
   * Il a d'abord ete facultatif, avec une option `auditTransactionnel` : l'ADR 11 prevoit
   * une migration module par module, et il fallait pouvoir migrer les huit services sans
   * basculer d'un coup tout le chemin d'ecriture patrimonial.
   *
   * Les huit sont migres. La branche fail-soft etait donc devenue du CODE MORT, et un
   * code mort de cette nature est un piege : il suffisait d'instancier la fabrique sans
   * l'option pour retrouver un audit perdable en silence, sans qu'aucun test ne tombe.
   *
   * Rendre le delegue obligatoire transforme la garantie en propriete verifiee par le
   * COMPILATEUR. On ne peut plus construire un service dont les ecritures ne sont pas
   * tracees — ce n'est plus une configuration a ne pas oublier.
   */
  delegueTransactionnel: (tx: unknown) => PrismaDelegate;
}

export function createCrudService(
  model: PrismaDelegate,
  entityName: string,
  options: OptionsCrud,
) {
  const { include: defaultInclude, delegueTransactionnel: delegueTx } = options;

  async function list(params: ListParams = {}): Promise<ListResult<unknown>> {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, params.pageSize ?? 20));
    const sortBy = params.sortBy ?? "createdAt";
    const sortDir = params.sortDir ?? "desc";
    const where = { ...(params.where ?? {}), deletedAt: params.archived ? { not: null } : null };

    const [data, total] = await Promise.all([
      model.findMany({ where, include: defaultInclude, orderBy: { [sortBy]: sortDir }, skip: (page - 1) * pageSize, take: pageSize }),
      model.count({ where }),
    ]);

    return { data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async function getById(id: string) {
    const item = await model.findFirst({ where: { id, deletedAt: null }, include: defaultInclude });
    if (!item) throw new ApiError(404, `${entityName} introuvable`);
    return item;
  }

  async function create(data: Record<string, unknown>, userId: string) {
    /**
     * La creation trace sa provenance, comme la mise a jour.
     *
     * L'asymetrie constatee le 05/09/2026 : un troncon cree depuis l'application
     * n'avait AUCUNE ligne de qualite, alors qu'une simple modification en produisait.
     * C'est l'inverse de ce qu'il faut — a la creation, TOUS les champs de decision
     * recoivent leur premiere valeur, et aucune ne disait d'ou elle venait.
     *
     * UN SEUL TEMPS (correction du 05/09/2026)
     *
     * La version precedente ecrivait l'entite, puis sa provenance dans une SECONDE
     * transaction, en invoquant que « l'identifiant n'existe pas avant l'insertion ».
     * C'etait faux : rien n'oblige a laisser la base tirer l'identifiant. Toutes les
     * cles de ce schema sont des `@default(uuid())` ; en le tirant ici, la provenance
     * connait sa cible avant meme l'insertion et rejoint la meme transaction.
     *
     * L'argument etait faux, et sa consequence reelle : une coupure entre les deux
     * ecritures laissait une entite SANS provenance, sur le seul geste ou tous les
     * champs de decision recoivent leur premiere valeur. Rien ne le rejouait, rien ne
     * le signalait. `update` etait deja atomique : les deux chemins ne donnaient pas
     * la meme garantie sur le meme invariant.
     */
    const id = (data.id as string | undefined) ?? randomUUID();

    // Forme INTERACTIVE : `after` est la ligne telle que la base l'a rendue, defauts de
    // colonne et champs calcules compris.
    return prisma.$transaction(async (tx) => {
      const cree = await delegueTx(tx).create({ data: { ...data, id } });
      // La provenance recoit `tx` : sans cela elle partirait sur le client de base et
      // cesserait silencieusement de faire partie de la transaction.
      await Promise.all(construireSaisies(entityName, id, data, userId, tx as never) as Promise<unknown>[]);
      await logAuditTransactionnelle(tx, {
        userId, action: "CREATE", entityType: entityName, entityId: cree.id, after: cree,
      });
      return cree;
    });
  }

  async function update(id: string, data: Record<string, unknown>, userId: string) {
    // P2-01 : une entite archivee n'est plus modifiable — cohérent avec getById.
    // Avant, findUnique trouvait l'entité archivée et l'update passait : une donnée
    // retirée des listes opérationnelles restait modifiable par identifiant.
    const before = await model.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw new ApiError(404, `${entityName} introuvable`);

    /**
     * La valeur et sa provenance changent ENSEMBLE, ou pas du tout.
     *
     * Avant cette transaction, une correction faite depuis l'interface laissait sa
     * ligne de `valeurs_qualite` intacte : la base continuait d'affirmer « absent de
     * la source » pour une valeur qu'un agent venait de taper. Constate le
     * 04/09/2026 sur « 2e Boulevard », et systemique — les scripts entretenaient la
     * tracabilite, l'application non.
     *
     * Ecrire les deux hors transaction aurait seulement deplace le probleme : un
     * echec entre les deux laisserait une valeur sans provenance, ou une provenance
     * sans valeur, et rien ne permettrait de savoir laquelle croire.
     */
    return prisma.$transaction(async (tx) => {
      const maj = await delegueTx(tx).update({ where: { id }, data });
      await Promise.all(construireSaisies(entityName, id, data, userId, tx as never) as Promise<unknown>[]);
      await logAuditTransactionnelle(tx, {
        userId, action: "UPDATE", entityType: entityName, entityId: id, before, after: maj,
      });
      return maj;
    });
  }

  // Suppression logique uniquement : la donnee reste en base (deletedAt renseigne)
  async function remove(id: string, userId: string) {
    const before = await model.findUnique({ where: { id } });
    if (!before) throw new ApiError(404, `${entityName} introuvable`);
    const maintenant = new Date();
    // Une archive sans trace est une disparition silencieuse : c'est le geste ou
    // l'atomicite compte le plus, puisque la donnee quitte les listes operationnelles.
    return prisma.$transaction(async (tx) => {
      const archive = await delegueTx(tx).update({ where: { id }, data: { deletedAt: maintenant } });
      await logAuditTransactionnelle(tx, {
        userId, action: "DELETE", entityType: entityName, entityId: id, before, after: archive,
      });
      return archive;
    });
  }

  async function restore(id: string, userId: string) {
    return prisma.$transaction(async (tx) => {
      const remis = await delegueTx(tx).update({ where: { id }, data: { deletedAt: null } });
      await logAuditTransactionnelle(tx, {
        userId, action: "RESTORE", entityType: entityName, entityId: id, after: remis,
      });
      return remis;
    });
  }

  // Actions groupees : chaque ligne est traitee independamment, un echec individuel
  // n'annule pas le reste du lot (rapport detaille retourne au client).
  async function bulkRemove(ids: string[], userId: string): Promise<BulkResult> {
    const result: BulkResult = { success: 0, failed: [] };
    for (const id of ids) {
      try {
        await remove(id, userId);
        result.success++;
      } catch (err) {
        result.failed.push({ id, message: err instanceof Error ? err.message : "Erreur inconnue" });
      }
    }
    return result;
  }

  async function bulkRestore(ids: string[], userId: string): Promise<BulkResult> {
    const result: BulkResult = { success: 0, failed: [] };
    for (const id of ids) {
      try {
        await restore(id, userId);
        result.success++;
      } catch (err) {
        result.failed.push({ id, message: err instanceof Error ? err.message : "Erreur inconnue" });
      }
    }
    return result;
  }

  return { list, getById, create, update, remove, restore, bulkRemove, bulkRestore };
}

const bulkIdsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });

type BulkCapableService = {
  bulkRemove: (ids: string[], userId: string) => Promise<BulkResult>;
  bulkRestore: (ids: string[], userId: string) => Promise<BulkResult>;
};

/**
 * Monte /bulk-archive et /bulk-restore sur un service issu de createCrudService.
 * A appeler dans le router du module : router.use(createBulkRouter(tronconsService)).
 */
export function createBulkRouter(service: BulkCapableService): Router {
  const router = Router();

  router.post("/bulk-archive", async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new ApiError(401, "Authentification requise");
      const { ids } = bulkIdsSchema.parse(req.body);
      res.json(await service.bulkRemove(ids, req.user.id));
    } catch (err) { next(err); }
  });

  router.post("/bulk-restore", async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new ApiError(401, "Authentification requise");
      const { ids } = bulkIdsSchema.parse(req.body);
      res.json(await service.bulkRestore(ids, req.user.id));
    } catch (err) { next(err); }
  });

  return router;
}
