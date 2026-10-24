/**
 * Service de la correspondance d'identifiants (A23). Les regles sont dans `correspondances.noyau.ts` et, tenues
 * une seconde fois, en base (migration 20261026410000). Acces par SQL parametre : la table est declaree dans
 * `schema.prisma` mais le client n'a pas a etre regenere pour la lire.
 *
 * TOUTE ECRITURE EST UNE NOUVELLE VERSION de la table, dans UNE transaction avec son audit. Une ligne ne se
 * modifie jamais : corriger, confirmer ou clore = fermer la ligne (`versionFermeture`) et en ouvrir une autre.
 * Les versions sont numerotees sans trou : un verrou consultatif serialise leur creation, et une transaction qui
 * echoue n'en laisse aucune.
 *
 * AUCUNE CORRESPONDANCE N'EST SEMEE NI DEVINEE : ce service n'ecrit que ce qu'une personne lui donne.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { logAuditTransactionnelle } from "../utils/audit";
import {
  verifierConfirmation, verifierProposition, versCsv,
  type LigneExport, type Proposition, type StatutCorrespondance, type Verdict,
} from "./correspondances.noyau";

export class RefusCorrespondance extends Error {
  constructor(public readonly code: string, message: string, public readonly http: 400 | 403 | 404 | 409 = 409) { super(message); }
}

type Db = Pick<PrismaClient, "$queryRaw" | "$transaction">;
type Tx = Pick<PrismaClient, "$queryRaw" | "auditLog">;

export interface Ligne {
  id: string;
  systemeSource: string;
  typeObjet: string;
  identifiantSource: string;
  identifiantCible: string;
  methode: string;
  score: string;
  tolerancesM: unknown;
  attributsCorroborants: unknown;
  statut: StatutCorrespondance;
  proposeParId: string;
  decisionReviseurId: string | null;
  decisionLe: Date | null;
  decisionMotif: string | null;
  valideDu: string;
  valideAu: string | null;
  versionOuverture: number;
  versionFermeture: number | null;
  lotImportId: string | null;
  commentaire: string | null;
}

interface Contexte { auteurId: string; ipAddress?: string }

const SELECTION = `c."id", c."systemeSource", c."typeObjet", c."identifiantSource", c."identifiantCible", c."methode", c."score"::text AS "score",
  c."tolerancesM", c."attributsCorroborants", c."statut", c."proposeParId", c."decisionReviseurId", c."decisionLe", c."decisionMotif",
  to_char(c."valideDu", 'YYYY-MM-DD') AS "valideDu", to_char(c."valideAu", 'YYYY-MM-DD') AS "valideAu",
  c."versionOuverture", c."versionFermeture", c."lotImportId", c."commentaire"`;

function exiger(v: Verdict): void {
  if (!v.ok) throw new RefusCorrespondance(v.code, v.motif, v.http);
}

/** Traduit une violation de contrainte de la base en refus clair ; toute autre erreur est relancee. */
function traduire(err: unknown): never {
  const e = err as { meta?: { code?: string; message?: string } } | null;
  const pg = e?.meta?.code;
  const msg = String(e?.meta?.message ?? "");
  if (pg === "23P01") throw new RefusCorrespondance("SOURCE_DEJA_CORRESPONDUE", "Cet identifiant source pointe deja une autre cible sur cette periode : fermez ou corrigez la correspondance en vigueur.", 409);
  if (pg === "23503" && /cible/.test(msg)) throw new RefusCorrespondance("CIBLE_INTROUVABLE", "La cible n'existe pas dans le Geoportail pour ce type d'objet.", 404);
  if (pg === "23503") throw new RefusCorrespondance("REFERENCE_INCONNUE", "Une reference (compte, lot d'import) n'existe pas.", 400);
  if (pg === "23514") throw new RefusCorrespondance("CONTRAINTE_VIOLEE", `Contrainte de la base violee : ${msg}`, 400);
  throw err;
}

export async function versionCourante(db: Pick<Db, "$queryRaw">): Promise<number> {
  const r = await db.$queryRaw<{ v: number }[]>`SELECT coalesce(max("version"), 0)::int AS v FROM "versions_correspondance"`;
  return Number(r[0].v);
}

export async function historiqueVersions(db: Pick<Db, "$queryRaw">, limite = 100) {
  return db.$queryRaw<{ version: number; creeLe: Date; auteurId: string; motif: string }[]>`
    SELECT "version", "creeLe", "auteurId", "motif" FROM "versions_correspondance" ORDER BY "version" DESC LIMIT ${Math.min(Math.max(limite, 1), 500)}`;
}

/** Ouvre la version suivante. Le verrou consultatif serialise les ecritures : serie sans trou. */
async function ouvrirVersion(tx: Pick<Tx, "$queryRaw">, auteurId: string, motif: string): Promise<number> {
  await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtext('correspondances_identifiants_version'))) AS verrou`;
  const r = await tx.$queryRaw<{ v: number }[]>`SELECT (coalesce(max("version"), 0) + 1)::int AS v FROM "versions_correspondance"`;
  const version = Number(r[0].v);
  await tx.$queryRaw`INSERT INTO "versions_correspondance" ("version", "auteurId", "motif") VALUES (${version}, ${auteurId}, ${motif}) RETURNING "version"`;
  return version;
}

interface Insertion {
  p: Proposition;
  statut: StatutCorrespondance;
  proposeParId: string;
  decisionReviseurId?: string | null;
  decisionMotif?: string | null;
  lotImportId?: string | null;
  commentaire?: string | null;
}

async function insererLigne(tx: Pick<Tx, "$queryRaw">, i: Insertion, version: number): Promise<Ligne> {
  const { p } = i;
  const tolerances = p.tolerancesM === undefined || p.tolerancesM === null ? null : JSON.stringify(p.tolerancesM);
  const attributs = p.attributsCorroborants === undefined || p.attributsCorroborants === null ? null : JSON.stringify(p.attributsCorroborants);
  const decide = i.statut === "CONFIRMEE";
  try {
    const lignes = await tx.$queryRaw<Ligne[]>`
      INSERT INTO "correspondances_identifiants"
        ("systemeSource", "typeObjet", "identifiantSource", "identifiantCible", "methode", "score", "tolerancesM", "attributsCorroborants",
         "statut", "proposeParId", "decisionReviseurId", "decisionLe", "decisionMotif", "valideDu", "valideAu",
         "versionOuverture", "lotImportId", "commentaire")
      VALUES (${p.systemeSource}, ${p.typeObjet}, ${p.identifiantSource}, ${p.identifiantCible}, ${p.methode}, ${p.score}::numeric,
              ${tolerances}::jsonb, ${attributs}::jsonb,
              ${i.statut}, ${i.proposeParId}, ${decide ? i.decisionReviseurId ?? null : null}, ${decide ? new Date() : null}, ${decide ? i.decisionMotif ?? null : null},
              ${p.valideDu}::date, ${p.valideAu ?? null}::date,
              ${version}, ${i.lotImportId ?? null}, ${i.commentaire ?? null})
      RETURNING "id", "systemeSource", "typeObjet", "identifiantSource", "identifiantCible", "methode", "score"::text AS "score",
        "tolerancesM", "attributsCorroborants", "statut", "proposeParId", "decisionReviseurId", "decisionLe", "decisionMotif",
        to_char("valideDu", 'YYYY-MM-DD') AS "valideDu", to_char("valideAu", 'YYYY-MM-DD') AS "valideAu",
        "versionOuverture", "versionFermeture", "lotImportId", "commentaire"`;
    return lignes[0];
  } catch (err) { return traduire(err); }
}

async function fermer(tx: Pick<Tx, "$queryRaw">, id: string, version: number): Promise<void> {
  await tx.$queryRaw`UPDATE "correspondances_identifiants" SET "versionFermeture" = ${version} WHERE "id" = ${id} AND "versionFermeture" IS NULL RETURNING "id"`;
}

async function lireVerrouillee(tx: Pick<Tx, "$queryRaw">, id: string): Promise<Ligne> {
  const r = await tx.$queryRaw<Ligne[]>`SELECT ${rawSelection()} FROM "correspondances_identifiants" c WHERE c."id" = ${id} FOR UPDATE`;
  if (!r[0]) throw new RefusCorrespondance("INTROUVABLE", "Correspondance introuvable.", 404);
  return r[0];
}

// Le gabarit etiquete n'accepte pas un fragment texte : la selection (constante ci-dessus) est rendue par Prisma.raw.
function rawSelection() { return Prisma.raw(SELECTION); }

const enProposition = (l: Ligne): Proposition => ({
  systemeSource: l.systemeSource, typeObjet: l.typeObjet, identifiantSource: l.identifiantSource, identifiantCible: l.identifiantCible,
  methode: l.methode, score: Number(l.score), tolerancesM: l.tolerancesM, attributsCorroborants: l.attributsCorroborants,
  valideDu: l.valideDu, valideAu: l.valideAu,
});

export interface EntreeProposition extends Proposition {
  lotImportId?: string | null;
  commentaire?: string | null;
}

/** Propose une correspondance (A_CONFIRMER), ou la decide d'emblee quand la methode est REVUE_HUMAINE. */
export async function proposer(db: Db, e: EntreeProposition, ctx: Contexte): Promise<{ ligne: Ligne; version: number }> {
  exiger(verifierProposition(e));
  const revue = e.methode === "REVUE_HUMAINE";
  return db.$transaction(async (tx) => {
    const version = await ouvrirVersion(tx, ctx.auteurId, `Proposition ${e.systemeSource}/${e.typeObjet}/${e.identifiantSource}`);
    const ligne = await insererLigne(tx, {
      p: e, statut: revue ? "CONFIRMEE" : "A_CONFIRMER", proposeParId: ctx.auteurId,
      decisionReviseurId: revue ? ctx.auteurId : null, decisionMotif: revue ? e.decisionMotif ?? null : null,
      lotImportId: e.lotImportId, commentaire: e.commentaire,
    }, version);
    await logAuditTransactionnelle(tx, {
      userId: ctx.auteurId, action: "CREATE", entityType: "CorrespondanceIdentifiant", entityId: ligne.id,
      after: { version, systemeSource: ligne.systemeSource, typeObjet: ligne.typeObjet, identifiantSource: ligne.identifiantSource, identifiantCible: ligne.identifiantCible, methode: ligne.methode, statut: ligne.statut },
      ipAddress: ctx.ipAddress,
    });
    return { ligne, version };
  }, { timeout: 15_000 });
}

/** Confirme une correspondance : decision nominative d'une AUTRE personne, nouvelle version. */
export async function confirmer(db: Db, id: string, motif: string | null | undefined, ctx: Contexte): Promise<{ ligne: Ligne; version: number }> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtext('correspondances_identifiants_version'))) AS verrou`;
    const avant = await lireVerrouillee(tx, id);
    exiger(verifierConfirmation(avant, ctx.auteurId, motif));
    const version = await ouvrirVersion(tx, ctx.auteurId, `Confirmation ${avant.systemeSource}/${avant.typeObjet}/${avant.identifiantSource}`);
    await fermer(tx, id, version);
    const ligne = await insererLigne(tx, {
      p: enProposition(avant), statut: "CONFIRMEE", proposeParId: avant.proposeParId,
      decisionReviseurId: ctx.auteurId, decisionMotif: motif!.trim(), lotImportId: avant.lotImportId, commentaire: avant.commentaire,
    }, version);
    await logAuditTransactionnelle(tx, {
      userId: ctx.auteurId, action: "UPDATE", entityType: "CorrespondanceIdentifiant", entityId: id,
      before: { statut: avant.statut, versionFermeture: null }, after: { statut: "CONFIRMEE", versionFermeture: version, remplaceePar: ligne.id },
      ipAddress: ctx.ipAddress,
    });
    return { ligne, version };
  }, { timeout: 15_000 });
}

export type Correction = Partial<Pick<Proposition, "identifiantCible" | "methode" | "score" | "tolerancesM" | "attributsCorroborants" | "decisionMotif" | "valideDu" | "valideAu">> & { commentaire?: string | null };

/** Corrige une correspondance : la ligne est fermee, une nouvelle A_CONFIRMER est ouverte (la correction doit etre reconfirmee). */
export async function corriger(db: Db, id: string, c: Correction, ctx: Contexte): Promise<{ ligne: Ligne; version: number }> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtext('correspondances_identifiants_version'))) AS verrou`;
    const avant = await lireVerrouillee(tx, id);
    if (avant.versionFermeture !== null) throw new RefusCorrespondance("CORRESPONDANCE_FERMEE", "Cette correspondance est fermee : elle ne se corrige plus.", 409);
    const fusion: Proposition = { ...enProposition(avant), ...Object.fromEntries(Object.entries(c).filter(([k, v]) => v !== undefined && k !== "commentaire")) } as Proposition;
    exiger(verifierProposition(fusion));
    const revue = fusion.methode === "REVUE_HUMAINE";
    const version = await ouvrirVersion(tx, ctx.auteurId, `Correction ${avant.systemeSource}/${avant.typeObjet}/${avant.identifiantSource}`);
    await fermer(tx, id, version);
    const ligne = await insererLigne(tx, {
      p: fusion, statut: revue ? "CONFIRMEE" : "A_CONFIRMER", proposeParId: ctx.auteurId,
      decisionReviseurId: revue ? ctx.auteurId : null, decisionMotif: revue ? fusion.decisionMotif ?? null : null,
      lotImportId: avant.lotImportId, commentaire: c.commentaire === undefined ? avant.commentaire : c.commentaire,
    }, version);
    await logAuditTransactionnelle(tx, {
      userId: ctx.auteurId, action: "UPDATE", entityType: "CorrespondanceIdentifiant", entityId: id,
      before: { identifiantCible: avant.identifiantCible, methode: avant.methode, score: avant.score, statut: avant.statut },
      after: { versionFermeture: version, remplaceePar: ligne.id, identifiantCible: ligne.identifiantCible, methode: ligne.methode, score: ligne.score, statut: ligne.statut },
      ipAddress: ctx.ipAddress,
    });
    return { ligne, version };
  }, { timeout: 15_000 });
}

/** Clot une correspondance sans la remplacer. La ligne reste lisible aux versions ou elle etait en vigueur. */
export async function clore(db: Db, id: string, motif: string | null | undefined, ctx: Contexte): Promise<{ version: number }> {
  if (typeof motif !== "string" || motif.trim() === "") throw new RefusCorrespondance("MOTIF_REQUIS", "La cloture porte son motif.", 400);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtext('correspondances_identifiants_version'))) AS verrou`;
    const avant = await lireVerrouillee(tx, id);
    if (avant.versionFermeture !== null) throw new RefusCorrespondance("CORRESPONDANCE_FERMEE", "Cette correspondance est deja fermee.", 409);
    const version = await ouvrirVersion(tx, ctx.auteurId, `Cloture ${avant.systemeSource}/${avant.typeObjet}/${avant.identifiantSource} : ${motif.trim().slice(0, 200)}`);
    await fermer(tx, id, version);
    await logAuditTransactionnelle(tx, {
      userId: ctx.auteurId, action: "UPDATE", entityType: "CorrespondanceIdentifiant", entityId: id,
      before: { versionFermeture: null }, after: { versionFermeture: version, motif: motif.trim() }, ipAddress: ctx.ipAddress,
    });
    return { version };
  }, { timeout: 15_000 });
}

export interface Filtres {
  /** Version a relire ; absente = la version courante. 0 = la table avant toute saisie (vide). */
  version?: number;
  systemeSource?: string;
  typeObjet?: string;
  identifiantSource?: string;
  identifiantCible?: string;
  statut?: StatutCorrespondance;
}

/** Les lignes EN VIGUEUR a une version : ouvertes a n ou avant, non fermees a n ou avant. */
export async function lister(db: Pick<Db, "$queryRaw">, f: Filtres = {}, plafond = 5000): Promise<{ version: number; lignes: Ligne[] }> {
  const version = f.version ?? await versionCourante(db);
  const lignes = await db.$queryRaw<Ligne[]>`
    SELECT ${rawSelection()}
      FROM "correspondances_identifiants" c
     WHERE c."versionOuverture" <= ${version} AND (c."versionFermeture" IS NULL OR c."versionFermeture" > ${version})
       AND (${f.systemeSource ?? null}::text IS NULL OR c."systemeSource" = ${f.systemeSource ?? null})
       AND (${f.typeObjet ?? null}::text IS NULL OR c."typeObjet" = ${f.typeObjet ?? null})
       AND (${f.identifiantSource ?? null}::text IS NULL OR c."identifiantSource" = ${f.identifiantSource ?? null})
       AND (${f.identifiantCible ?? null}::text IS NULL OR c."identifiantCible" = ${f.identifiantCible ?? null})
       AND (${f.statut ?? null}::text IS NULL OR c."statut" = ${f.statut ?? null})
     ORDER BY c."systemeSource", c."typeObjet", c."identifiantSource", c."valideDu", c."id"
     LIMIT ${plafond}`;
  return { version, lignes };
}

/** Export CSV de la table en vigueur a une version (la courante par defaut), avec son empreinte SHA-256. */
export async function exporter(db: Pick<Db, "$queryRaw">, version?: number): Promise<{ version: number; texte: string; empreinteSha256: string; lignes: number }> {
  const courante = await versionCourante(db);
  const v = version ?? courante;
  if (v < 0 || v > courante) throw new RefusCorrespondance("VERSION_INCONNUE", `La version ${v} n'existe pas (courante : ${courante}).`, 404);
  const { lignes } = await lister(db, { version: v }, 1_000_000);
  const csv = versCsv(lignes.map<LigneExport>((l) => ({
    systemeSource: l.systemeSource, typeObjet: l.typeObjet, identifiantSource: l.identifiantSource, identifiantCible: l.identifiantCible,
    methode: l.methode, score: l.score, statut: l.statut, valideDu: l.valideDu, valideAu: l.valideAu, versionOuverture: l.versionOuverture,
  })), v);
  return { version: v, lignes: lignes.length, ...csv };
}
