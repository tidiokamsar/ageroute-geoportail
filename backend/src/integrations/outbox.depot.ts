/**
 * DEPOT DE L'OUTBOX : le port que le service utilise, et son implementation SQL.
 *
 * POURQUOI DU SQL ETIQUETE ET PAS LE CLIENT PRISMA GENERE
 *
 * Les tables `outbox_evenements` et `outbox_tentatives` sont posees par une migration SQL ecrite a
 * la main (declencheurs, contraintes de coherence). Le code ne depend donc pas d'un client genere
 * qui connaitrait ou non ces tables : il ecrit des requetes `$queryRaw` etiquetees, valeurs liees
 * par le pilote, jamais concatenees (lib/sql-parametre.test.ts). Les heures sont passees en ISO et
 * ramenees en UTC par la base (`timestamptz AT TIME ZONE 'UTC'`) : le resultat ne depend pas du
 * fuseau de session du serveur.
 *
 * L'ATOMICITE DES TRANSITIONS EST CELLE D'UN SEUL UPDATE
 *
 * `reclamer` est un UPDATE conditionnel : sous PostgreSQL (READ COMMITTED) deux travailleurs qui
 * visent le meme evenement se serialisent sur la ligne, le second relit la condition et ne la
 * trouve plus vraie. C'est le verrou anti-double-envoi, et il ne demande ni `SELECT ... FOR UPDATE`
 * ni verrou applicatif.
 *
 * AUCUN APPEL RESEAU NE SE FAIT DANS UNE TRANSACTION : le service reclame (transaction courte),
 * emet (hors transaction), puis conclut (transaction courte).
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { logAuditTransactionnelle } from "../utils/audit";
import type { Destination, EvenementOutbox, IssueEmission, StatutOutbox, TypeEvenement, TypeSource } from "./types";
import { STATUTS_OUTBOX } from "./types";

export class CleDejaPresente extends Error {
  constructor() { super("cle d'idempotence deja inscrite"); this.name = "CleDejaPresente"; }
}

export class RefusBase extends Error {
  constructor(public readonly sqlState: string, message: string) { super(message); this.name = "RefusBase"; }
}

export interface NouvelEvenement {
  destination: Destination;
  typeEvenement: TypeEvenement;
  sourceType: TypeSource;
  sourceId: string;
  cleIdempotence: string;
  chargeCanonique: string;
  empreinteCharge: string;
  tentativesMax: number;
  creeParId: string;
  maintenant: Date;
}

export interface ConclusionTentative {
  id: string;
  travailleur: string;
  maintenant: Date;
  statut: "ENVOYE" | "ECHEC" | "ABANDONNE";
  tentatives: number;
  prochaineTentativeLe: Date | null;
  code: string | null;
  message: string | null;
  accuseReference: string | null;
  motifAbandon: string | null;
}

export interface TentativeAInscrire {
  evenementId: string;
  debutLe: Date;
  finLe: Date;
  issue: IssueEmission;
  codeHttp: number | null;
  codeErreur: string | null;
  message: string | null;
  accuseReference: string | null;
  travailleur: string;
}

export interface TentativeLue extends TentativeAInscrire {
  id: string;
  numero: number;
}

export interface EntreeAudit {
  userId: string | null;
  action: "CREATE" | "UPDATE";
  entityId: string;
  before?: unknown;
  after?: unknown;
  ipAddress?: string;
}

export interface LigneAudit {
  id: string;
  userId: string | null;
  action: string;
  before: unknown;
  after: unknown;
  createdAt: Date;
}

export interface FiltreListe {
  statut?: StatutOutbox;
  destination?: Destination;
  limite: number;
  decalage: number;
}

export interface PortOutbox {
  trouverParCle(destination: Destination, cle: string): Promise<EvenementOutbox | null>;
  inserer(n: NouvelEvenement): Promise<EvenementOutbox>;
  lire(id: string): Promise<EvenementOutbox | null>;
  /** Identifiants des evenements dont l'echeance est passee (ou le verrou expire), les plus anciens d'abord. */
  evenementsDus(maintenant: Date, destinations: readonly Destination[], limite: number): Promise<string[]>;
  reclamer(p: { id: string; travailleur: string; maintenant: Date; verrouJusqua: Date; ignorerEcheance: boolean }): Promise<EvenementOutbox | null>;
  conclure(c: ConclusionTentative): Promise<EvenementOutbox | null>;
  relancer(p: { id: string; maintenant: Date }): Promise<EvenementOutbox | null>;
  abandonnerManuellement(p: { id: string; maintenant: Date; motif: string }): Promise<EvenementOutbox | null>;
  inscrireTentative(t: TentativeAInscrire): Promise<void>;
  lister(f: FiltreListe): Promise<{ evenements: EvenementOutbox[]; total: number }>;
  compter(): Promise<Record<StatutOutbox, number>>;
  tentativesDe(evenementId: string): Promise<TentativeLue[]>;
  journalDe(evenementId: string): Promise<LigneAudit[]>;
  auditer(e: EntreeAudit): Promise<void>;
}

export interface DepotOutbox {
  /** Une transaction courte. Aucun appel reseau ne doit s'y faire. */
  transaction<T>(f: (p: PortOutbox) => Promise<T>): Promise<T>;
  /** Lectures hors transaction. */
  lecture: PortOutbox;
}

/* ============================== Implementation SQL ============================== */

type ClientSql = Pick<PrismaClient, "$queryRaw" | "auditLog">;

/** Heure UTC sans fuseau, a partir d'un instant : independante du fuseau de session. */
function ts(d: Date | null): Prisma.Sql {
  return d === null ? Prisma.sql`NULL::timestamp` : Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

type Ligne = Omit<EvenementOutbox, never>;

function versEvenement(l: Ligne): EvenementOutbox {
  return { ...l };
}

function traduire(err: unknown): never {
  const e = err as { code?: string; meta?: { code?: string; message?: string }; message?: string };
  const sqlState = e?.meta?.code;
  if (e?.code === "P2010" && sqlState === "23505") throw new CleDejaPresente();
  if (e?.code === "P2010" && typeof sqlState === "string") {
    throw new RefusBase(sqlState, (e.meta?.message ?? e.message ?? "refus de la base").slice(0, 400));
  }
  throw err;
}

export function portSql(db: ClientSql): PortOutbox {
  const un = async (req: Promise<Ligne[]>): Promise<EvenementOutbox | null> => {
    try { const l = await req; return l[0] ? versEvenement(l[0]) : null; } catch (err) { return traduire(err); }
  };

  return {
    trouverParCle: (destination, cle) => un(db.$queryRaw<Ligne[]>`
      SELECT * FROM outbox_evenements WHERE "destination" = ${destination} AND "cleIdempotence" = ${cle}`),

    async inserer(n) {
      const l = await un(db.$queryRaw<Ligne[]>`
        INSERT INTO outbox_evenements ("destination", "typeEvenement", "sourceType", "sourceId", "cleIdempotence",
                                       "chargeCanonique", "empreinteCharge", "tentativesMax", "prochaineTentativeLe",
                                       "creeParId", "createdAt", "updatedAt")
        VALUES (${n.destination}, ${n.typeEvenement}, ${n.sourceType}, ${n.sourceId}, ${n.cleIdempotence},
                ${n.chargeCanonique}, ${n.empreinteCharge}, ${n.tentativesMax}, ${ts(n.maintenant)},
                ${n.creeParId}, ${ts(n.maintenant)}, ${ts(n.maintenant)})
        RETURNING *`);
      if (!l) throw new Error("insertion sans ligne retournee");
      return l;
    },

    lire: (id) => un(db.$queryRaw<Ligne[]>`SELECT * FROM outbox_evenements WHERE "id" = ${id}`),

    async evenementsDus(maintenant, destinations, limite) {
      if (destinations.length === 0) return [];
      const lignes = await db.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM outbox_evenements
         WHERE "destination" IN (${Prisma.join([...destinations])})
           AND (("statut" IN ('EN_ATTENTE', 'ECHEC') AND "prochaineTentativeLe" <= ${ts(maintenant)})
             OR ("statut" = 'EN_COURS' AND "verrouJusqua" < ${ts(maintenant)}))
         ORDER BY "prochaineTentativeLe" ASC, "createdAt" ASC
         LIMIT ${limite}`;
      return lignes.map((l) => l.id);
    },

    // LE VERROU ANTI-DOUBLE-ENVOI : un seul UPDATE conditionnel. Deux appels simultanes : un seul
    // trouve la condition vraie, l'autre recoit zero ligne.
    reclamer: (p) => un(db.$queryRaw<Ligne[]>`
      UPDATE outbox_evenements
         SET "statut" = 'EN_COURS', "verrouPar" = ${p.travailleur}, "verrouJusqua" = ${ts(p.verrouJusqua)},
             "updatedAt" = ${ts(p.maintenant)}
       WHERE "id" = ${p.id}
         AND (("statut" IN ('EN_ATTENTE', 'ECHEC') AND ("prochaineTentativeLe" <= ${ts(p.maintenant)} OR ${p.ignorerEcheance}))
           OR ("statut" = 'EN_COURS' AND "verrouJusqua" < ${ts(p.maintenant)}))
      RETURNING *`),

    conclure: (c) => un(db.$queryRaw<Ligne[]>`
      UPDATE outbox_evenements
         SET "statut" = ${c.statut},
             "tentatives" = ${c.tentatives},
             "prochaineTentativeLe" = COALESCE(${ts(c.prochaineTentativeLe)}, "prochaineTentativeLe"),
             "verrouPar" = NULL, "verrouJusqua" = NULL,
             "dernierCode" = ${c.code}, "dernierMessage" = ${c.message},
             "accuseReference" = ${c.accuseReference},
             "envoyeLe" = ${ts(c.statut === "ENVOYE" ? c.maintenant : null)},
             "abandonneLe" = ${ts(c.statut === "ABANDONNE" ? c.maintenant : null)},
             "motifAbandon" = ${c.motifAbandon},
             "updatedAt" = ${ts(c.maintenant)}
       WHERE "id" = ${c.id} AND "statut" = 'EN_COURS' AND "verrouPar" = ${c.travailleur}
      RETURNING *`),

    relancer: (p) => un(db.$queryRaw<Ligne[]>`
      UPDATE outbox_evenements
         SET "statut" = 'EN_ATTENTE', "tentatives" = 0, "relances" = "relances" + 1,
             "prochaineTentativeLe" = ${ts(p.maintenant)}, "abandonneLe" = NULL, "motifAbandon" = NULL,
             "updatedAt" = ${ts(p.maintenant)}
       WHERE "id" = ${p.id} AND "statut" IN ('ECHEC', 'ABANDONNE')
      RETURNING *`),

    abandonnerManuellement: (p) => un(db.$queryRaw<Ligne[]>`
      UPDATE outbox_evenements
         SET "statut" = 'ABANDONNE', "abandonneLe" = ${ts(p.maintenant)}, "motifAbandon" = ${p.motif},
             "verrouPar" = NULL, "verrouJusqua" = NULL, "updatedAt" = ${ts(p.maintenant)}
       WHERE "id" = ${p.id}
         AND ("statut" IN ('EN_ATTENTE', 'ECHEC') OR ("statut" = 'EN_COURS' AND "verrouJusqua" < ${ts(p.maintenant)}))
      RETURNING *`),

    async inscrireTentative(t) {
      await db.$queryRaw`
        INSERT INTO outbox_tentatives ("evenementId", "numero", "debutLe", "finLe", "issue", "codeHttp", "codeErreur",
                                       "message", "accuseReference", "travailleur")
        VALUES (${t.evenementId},
                (SELECT COALESCE(MAX("numero"), 0) + 1 FROM outbox_tentatives WHERE "evenementId" = ${t.evenementId}),
                ${ts(t.debutLe)}, ${ts(t.finLe)}, ${t.issue}, ${t.codeHttp}, ${t.codeErreur}, ${t.message},
                ${t.accuseReference}, ${t.travailleur})
        RETURNING "id"`;
    },

    async lister(f) {
      const conditions: Prisma.Sql[] = [];
      if (f.statut) conditions.push(Prisma.sql`"statut" = ${f.statut}`);
      if (f.destination) conditions.push(Prisma.sql`"destination" = ${f.destination}`);
      const ou = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}` : Prisma.empty;
      const [evenements, total] = await Promise.all([
        db.$queryRaw<Ligne[]>`SELECT * FROM outbox_evenements ${ou} ORDER BY "createdAt" DESC, "id" ASC LIMIT ${f.limite} OFFSET ${f.decalage}`,
        db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox_evenements ${ou}`,
      ]);
      return { evenements: evenements.map(versEvenement), total: Number(total[0]?.n ?? 0) };
    },

    async compter() {
      const lignes = await db.$queryRaw<{ statut: StatutOutbox; n: bigint }[]>`
        SELECT "statut", count(*) AS n FROM outbox_evenements GROUP BY 1`;
      const sortie = Object.fromEntries(STATUTS_OUTBOX.map((s) => [s, 0])) as Record<StatutOutbox, number>;
      for (const l of lignes) sortie[l.statut] = Number(l.n);
      return sortie;
    },

    async tentativesDe(evenementId) {
      return db.$queryRaw<TentativeLue[]>`
        SELECT "id", "evenementId", "numero", "debutLe", "finLe", "issue", "codeHttp", "codeErreur", "message",
               "accuseReference", "travailleur"
          FROM outbox_tentatives WHERE "evenementId" = ${evenementId} ORDER BY "numero" ASC`;
    },

    async journalDe(evenementId) {
      return db.$queryRaw<LigneAudit[]>`
        SELECT "id", "userId", "action"::text AS "action", "before", "after", "createdAt"
          FROM audit_logs WHERE "entityType" = 'OutboxEvenement' AND "entityId" = ${evenementId}
         ORDER BY "createdAt" ASC, "id" ASC`;
    },

    async auditer(e) {
      await logAuditTransactionnelle(db, {
        userId: e.userId, action: e.action, entityType: "OutboxEvenement", entityId: e.entityId,
        before: e.before, after: e.after, ipAddress: e.ipAddress,
      });
    },
  };
}

export function depotSql(prisma: Pick<PrismaClient, "$transaction" | "$queryRaw" | "auditLog">): DepotOutbox {
  return {
    lecture: portSql(prisma),
    transaction: (f) => prisma.$transaction(async (tx) => f(portSql(tx)), { timeout: 20_000, maxWait: 10_000 }),
  };
}
