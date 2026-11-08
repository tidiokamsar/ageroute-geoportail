/**
 * ACCES SQL DES RESEAUX PHYSIQUES ET CIRCUITS LOGIQUES (PostGIS, lot B1). Toutes les requetes sont `$queryRaw` / `$executeRaw` ETIQUETEES :
 * les valeurs (identifiants, SRID, tolerances, tableaux) sont LIEES par le pilote, jamais concatenees (lib/sql-parametre.test.ts interdit la
 * forme non etiquetee). Les fragments communs sont des `Prisma.sql` composes.
 *
 * Les deux tables du lot (`reseau_objets_descripteurs`, `reseau_relations`) s'ecrivent et se lisent en SQL brut : le code ne depend donc pas
 * de la regeneration du client Prisma. Les identifiants d'objets sont des `bigint` rendus en TEXTE (jamais en nombre : au-dela de 2^53).
 *
 * Rien n'est ecrit par les fonctions de lecture : l'appelant ouvre une transaction `READ ONLY` quand le cout le justifie.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import { QUART_DE_CERCLE } from "../analyse.depot";
import type { NatureComptee, MesuresGroupe } from "./comptage.noyau";
import { groupeVide } from "./comptage.noyau";
import type { TableTolerances } from "./relations.noyau";
import { ID_OBJET } from "./types.noyau";

export type TxLecture = Pick<PrismaClient, "$queryRaw">;
export type TxEcriture = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;


// ------------------------------------------------------------------------------------------------
// Objets, avec leur jeu et leur descripteur eventuel
// ------------------------------------------------------------------------------------------------

export interface LigneObjet {
  objetId: string; jeuId: string; nom: string | null; typeGeom: "LIGNE" | "POINT" | "POLYGONE"; longueurM: number | null; ordre: number;
  projetId: string; role: string; statutJeu: string; versionJeu: number; nomFichier: string; confidentialite: string;
  natureJeu: string; typeReseau: string | null; classeJeu: string | null; precisionHJeu: number | null; precisionVJeu: number | null;
  methodeJeu: string | null; dateDonneesJeu: Date | null; dateConstatJeu: Date | null; concessionnaireId: string | null; concessionnaireNom: string | null;
  aDescripteur: boolean; dNature: string | null; dTypeObjet: string | null; dClasse: string | null; dPrecisionH: number | null; dPrecisionV: number | null;
  dMethode: string | null; dDateConstat: Date | null; dConfiance: string | null; dStatutQualite: string | null;
  dProfondeur: number | null; dAltitude: number | null; dReference: string | null; dJustification: string | null;
  dDeclareLe: Date | null; dUpdatedAt: Date | null; dDeclarePar: string | null; dModifiePar: string | null;
}

const SELECT_OBJET = Prisma.sql`
  o."id"::text AS "objetId", o."jeuId" AS "jeuId", o."nom" AS "nom", o."typeGeom"::text AS "typeGeom", o."longueurM" AS "longueurM", o."ordre" AS "ordre",
  j."projetId" AS "projetId", j."role"::text AS "role", j."statut"::text AS "statutJeu", j."version" AS "versionJeu", j."nomFichier" AS "nomFichier",
  j."confidentialite"::text AS "confidentialite", j."natureObjets"::text AS "natureJeu", j."typeReseau"::text AS "typeReseau",
  j."classePrecision"::text AS "classeJeu", j."precisionHorizontaleM"::float8 AS "precisionHJeu", j."precisionVerticaleM"::float8 AS "precisionVJeu",
  j."methode" AS "methodeJeu", j."dateDonnees" AS "dateDonneesJeu", j."dateConstat" AS "dateConstatJeu",
  j."concessionnaireId" AS "concessionnaireId", c."nom" AS "concessionnaireNom",
  (d."objetId" IS NOT NULL) AS "aDescripteur", d."nature"::text AS "dNature", d."typeObjet" AS "dTypeObjet", d."classePrecision"::text AS "dClasse",
  d."precisionHorizontaleM"::float8 AS "dPrecisionH", d."precisionVerticaleM"::float8 AS "dPrecisionV", d."methodeCollecte" AS "dMethode",
  d."dateConstat" AS "dDateConstat", d."niveauConfiance"::text AS "dConfiance", d."statutQualite"::text AS "dStatutQualite",
  d."profondeurM"::float8 AS "dProfondeur", d."altitudeM"::float8 AS "dAltitude", d."referenceVerticale" AS "dReference",
  d."justification" AS "dJustification", d."declareLe" AS "dDeclareLe", d."updatedAt" AS "dUpdatedAt", ud."nomComplet" AS "dDeclarePar", um."nomComplet" AS "dModifiePar"`;

const FROM_OBJET = Prisma.sql`
  FROM "projets_voirie_objets" o
  JOIN "projets_voirie_jeux" j ON j."id" = o."jeuId"
  LEFT JOIN "concessionnaires_reseau" c ON c."id" = j."concessionnaireId"
  LEFT JOIN "reseau_objets_descripteurs" d ON d."objetId" = o."id"
  LEFT JOIN "users" ud ON ud."id" = d."declareParId"
  LEFT JOIN "users" um ON um."id" = d."modifieParId"`;

/** Un objet du projet (le projet est verifie par la jointure : un objet d'un autre projet n'est jamais rendu). */
export async function lireObjet(tx: TxLecture, projetId: string, objetId: string): Promise<LigneObjet | null> {
  if (!ID_OBJET.test(objetId)) return null;
  const r = await tx.$queryRaw<LigneObjet[]>`
    SELECT ${SELECT_OBJET} ${FROM_OBJET}
     WHERE o."id" = ${objetId}::bigint AND j."projetId" = ${projetId}`;
  return r[0] ?? null;
}

export interface FiltresObjets {
  projetId: string;
  /** Statuts de jeu lisibles par le compte (voir visibilite.noyau.ts) : un jeu RETIRE n'y figure jamais. */
  statuts: readonly string[];
  jeuId?: string;
  /** Nature EFFECTIVE (objet, sinon jeu) ; `INCONNUE` : ni l'objet ni le jeu ne la declarent. */
  nature?: string;
  typeObjet?: string;
  /** Texte cherche dans le nom de l'objet. */
  q?: string;
  /** Curseur : identifiant du dernier objet de la page precedente. */
  apres?: string;
  limite: number;
}

const NATURE_EFFECTIVE = Prisma.sql`COALESCE(d."nature", j."natureObjets")`;

/** Objets qualifiables (reseaux de tiers et jeux « autre ») du projet, tries par identifiant, `limite + 1` lignes (pour detecter la page suivante). */
export async function listerObjets(tx: TxLecture, f: FiltresObjets): Promise<LigneObjet[]> {
  const jeu = f.jeuId ? Prisma.sql`AND j."id" = ${f.jeuId}` : Prisma.empty;
  const nature = f.nature
    ? (f.nature === "INCONNUE"
      ? Prisma.sql`AND ${NATURE_EFFECTIVE}::text NOT IN ('ACTIF_PHYSIQUE', 'CIRCUIT_LOGIQUE', 'EQUIPEMENT')`
      : Prisma.sql`AND ${NATURE_EFFECTIVE}::text = ${f.nature}`)
    : Prisma.empty;
  const type = f.typeObjet ? Prisma.sql`AND d."typeObjet" = ${f.typeObjet}` : Prisma.empty;
  // `strpos` sur le nom en minuscules : aucun joker LIKE a echapper (revue RC-3, point 33).
  const q = f.q ? Prisma.sql`AND strpos(lower(coalesce(o."nom", '')), lower(${f.q})) > 0` : Prisma.empty;
  const apres = f.apres ? Prisma.sql`AND o."id" > ${f.apres}::bigint` : Prisma.empty;
  return tx.$queryRaw<LigneObjet[]>`
    SELECT ${SELECT_OBJET} ${FROM_OBJET}
     WHERE j."projetId" = ${f.projetId} AND j."role"::text IN ('RESEAU_TIERS', 'AUTRE') AND j."statut"::text = ANY(${[...f.statuts]}::text[])
       ${jeu} ${nature} ${type} ${q} ${apres}
     ORDER BY o."id" ASC
     LIMIT ${f.limite + 1}`;
}

// ------------------------------------------------------------------------------------------------
// Descripteurs
// ------------------------------------------------------------------------------------------------

export interface EntreeDescripteur {
  nature: string | null; typeObjet: string | null; classePrecision: string | null;
  precisionHorizontaleM: number | null; precisionVerticaleM: number | null; methodeCollecte: string | null; dateConstat: string | null;
  niveauConfiance: string | null; statutQualite: string; profondeurM: number | null; altitudeM: number | null; referenceVerticale: string | null;
  justification: string;
}

/**
 * Cree ou remplace le descripteur de l'objet. Les controles de coherence (role, nature, geometrie, type, relations) sont ceux du declencheur
 * de la base ; le service les rejoue avant pour rendre un message clair. `declareParId` n'est ecrit qu'a la creation (le declencheur le fige).
 */
export async function ecrireDescripteur(tx: TxEcriture, objetId: string, e: EntreeDescripteur, acteurId: string): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "reseau_objets_descripteurs" ("objetId", "jeuId", "nature", "typeObjet", "classePrecision", "precisionHorizontaleM", "precisionVerticaleM",
      "methodeCollecte", "dateConstat", "niveauConfiance", "statutQualite", "profondeurM", "altitudeM", "referenceVerticale", "justification", "declareParId", "modifieParId")
    VALUES (${objetId}::bigint, '', ${e.nature}::"NatureObjetReseau", ${e.typeObjet}, ${e.classePrecision}::"ClassePrecision",
      ${e.precisionHorizontaleM}::numeric, ${e.precisionVerticaleM}::numeric, ${e.methodeCollecte}, ${e.dateConstat}::date,
      ${e.niveauConfiance}::"NiveauConfianceObjet", ${e.statutQualite}::"StatutQualiteObjet", ${e.profondeurM}::numeric, ${e.altitudeM}::numeric,
      ${e.referenceVerticale}, ${e.justification}, ${acteurId}, NULL)
    ON CONFLICT ("objetId") DO UPDATE SET
      "nature" = EXCLUDED."nature", "typeObjet" = EXCLUDED."typeObjet", "classePrecision" = EXCLUDED."classePrecision",
      "precisionHorizontaleM" = EXCLUDED."precisionHorizontaleM", "precisionVerticaleM" = EXCLUDED."precisionVerticaleM",
      "methodeCollecte" = EXCLUDED."methodeCollecte", "dateConstat" = EXCLUDED."dateConstat", "niveauConfiance" = EXCLUDED."niveauConfiance",
      "statutQualite" = EXCLUDED."statutQualite", "profondeurM" = EXCLUDED."profondeurM", "altitudeM" = EXCLUDED."altitudeM",
      "referenceVerticale" = EXCLUDED."referenceVerticale", "justification" = EXCLUDED."justification",
      "modifieParId" = ${acteurId}, "updatedAt" = CURRENT_TIMESTAMP`;
}

/** Nombre de relations PROPOSEE ou VALIDEE qui touchent l'objet (a un bout ou a l'autre) : tant qu'il y en a, sa nature ne change pas. */
export async function nbRelationsActives(tx: TxLecture, objetId: string): Promise<number> {
  const r = await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS "n" FROM "reseau_relations"
     WHERE "statut" IN ('PROPOSEE', 'VALIDEE') AND ("sourceObjetId" = ${objetId}::bigint OR "cibleObjetId" = ${objetId}::bigint)`;
  return r[0]?.n ?? 0;
}

/** Natures et classes EFFECTIVES d'une liste d'objets (pour les listes d'autres modules) ; un objet sans descripteur herite de son jeu. */
export async function descripteursDesObjets(tx: TxLecture, objetIds: readonly string[]): Promise<Map<string, { nature: string | null; classe: string | null; typeObjet: string | null; natureJeu: string; classeJeu: string | null }>> {
  const ids = [...new Set(objetIds.filter((i) => ID_OBJET.test(i)))];
  if (ids.length === 0) return new Map();
  const r = await tx.$queryRaw<{ id: string; nature: string | null; classe: string | null; type: string | null; natureJeu: string; classeJeu: string | null }[]>`
    SELECT o."id"::text AS "id", d."nature"::text AS "nature", d."classePrecision"::text AS "classe", d."typeObjet" AS "type",
           j."natureObjets"::text AS "natureJeu", j."classePrecision"::text AS "classeJeu"
      FROM "projets_voirie_objets" o
      JOIN "projets_voirie_jeux" j ON j."id" = o."jeuId"
      LEFT JOIN "reseau_objets_descripteurs" d ON d."objetId" = o."id"
     WHERE o."id" = ANY(${ids}::bigint[])`;
  return new Map(r.map((x) => [x.id, { nature: x.nature, classe: x.classe, typeObjet: x.type, natureJeu: x.natureJeu, classeJeu: x.classeJeu }]));
}

// ------------------------------------------------------------------------------------------------
// Relations
// ------------------------------------------------------------------------------------------------

export interface LigneRelation {
  id: string; projetId: string; typeRelation: string; statut: string; origine: string; proposition: unknown;
  decideLe: Date | null; justificationDecision: string | null; decidePar: string | null; creePar: string | null; createdAt: Date; updatedAt: Date;
  sourceObjetId: string; sourceNom: string | null; sourceJeuId: string; sourceStatutJeu: string; sourceConfidentialite: string; sourceGeom: string; sourceNature: string; sourceType: string | null;
  cibleObjetId: string; cibleNom: string | null; cibleJeuId: string; cibleStatutJeu: string; cibleConfidentialite: string; cibleGeom: string; cibleNature: string; cibleType: string | null;
}

const SELECT_RELATION = Prisma.sql`
  r."id" AS "id", r."projetId" AS "projetId", r."typeRelation"::text AS "typeRelation", r."statut"::text AS "statut", r."origine"::text AS "origine",
  r."proposition" AS "proposition", r."decideLe" AS "decideLe", r."justificationDecision" AS "justificationDecision", ud."nomComplet" AS "decidePar", uc."nomComplet" AS "creePar",
  r."createdAt" AS "createdAt", r."updatedAt" AS "updatedAt",
  r."sourceObjetId"::text AS "sourceObjetId", os."nom" AS "sourceNom", os."jeuId" AS "sourceJeuId", js."statut"::text AS "sourceStatutJeu", js."confidentialite"::text AS "sourceConfidentialite", os."typeGeom"::text AS "sourceGeom",
  COALESCE(ds."nature", js."natureObjets")::text AS "sourceNature", ds."typeObjet" AS "sourceType",
  r."cibleObjetId"::text AS "cibleObjetId", oc."nom" AS "cibleNom", oc."jeuId" AS "cibleJeuId", jc."statut"::text AS "cibleStatutJeu", jc."confidentialite"::text AS "cibleConfidentialite", oc."typeGeom"::text AS "cibleGeom",
  COALESCE(dc."nature", jc."natureObjets")::text AS "cibleNature", dc."typeObjet" AS "cibleType"`;

const FROM_RELATION = Prisma.sql`
  FROM "reseau_relations" r
  JOIN "projets_voirie_objets" os ON os."id" = r."sourceObjetId"
  JOIN "projets_voirie_jeux" js ON js."id" = os."jeuId"
  LEFT JOIN "reseau_objets_descripteurs" ds ON ds."objetId" = os."id"
  JOIN "projets_voirie_objets" oc ON oc."id" = r."cibleObjetId"
  JOIN "projets_voirie_jeux" jc ON jc."id" = oc."jeuId"
  LEFT JOIN "reseau_objets_descripteurs" dc ON dc."objetId" = oc."id"
  LEFT JOIN "users" ud ON ud."id" = r."decideParId"
  LEFT JOIN "users" uc ON uc."id" = r."creeParId"`;

export interface FiltresRelations {
  projetId: string;
  statutsJeu: readonly string[];
  statuts?: readonly string[];
  type?: string;
  /** Relations dont l'un des deux bouts est cet objet. */
  objetId?: string;
  origine?: string;
  curseur?: { t: Date; i: string };
  limite: number;
}

/** Relations dont les DEUX bouts sont lisibles par le compte (statuts de jeu), les plus recentes d'abord, `limite + 1` lignes. */
export async function listerRelations(tx: TxLecture, f: FiltresRelations): Promise<LigneRelation[]> {
  const statut = f.statuts?.length ? Prisma.sql`AND r."statut"::text = ANY(${[...f.statuts]}::text[])` : Prisma.empty;
  const type = f.type ? Prisma.sql`AND r."typeRelation"::text = ${f.type}` : Prisma.empty;
  const origine = f.origine ? Prisma.sql`AND r."origine"::text = ${f.origine}` : Prisma.empty;
  const objet = f.objetId ? Prisma.sql`AND (r."sourceObjetId" = ${f.objetId}::bigint OR r."cibleObjetId" = ${f.objetId}::bigint)` : Prisma.empty;
  const curseur = f.curseur ? Prisma.sql`AND (r."createdAt" < ${f.curseur.t} OR (r."createdAt" = ${f.curseur.t} AND r."id" < ${f.curseur.i}))` : Prisma.empty;
  return tx.$queryRaw<LigneRelation[]>`
    SELECT ${SELECT_RELATION} ${FROM_RELATION}
     WHERE r."projetId" = ${f.projetId} AND js."statut"::text = ANY(${[...f.statutsJeu]}::text[]) AND jc."statut"::text = ANY(${[...f.statutsJeu]}::text[])
       ${statut} ${type} ${origine} ${objet} ${curseur}
     ORDER BY r."createdAt" DESC, r."id" DESC
     LIMIT ${f.limite + 1}`;
}

/** Une relation du projet, sans filtre de lisibilite (le service l'applique). */
export async function lireRelation(tx: TxLecture, projetId: string, relId: string): Promise<LigneRelation | null> {
  const r = await tx.$queryRaw<LigneRelation[]>`
    SELECT ${SELECT_RELATION} ${FROM_RELATION} WHERE r."id" = ${relId} AND r."projetId" = ${projetId}`;
  return r[0] ?? null;
}

/** Relation existante pour ce couple, quel que soit son statut (l'index unique l'impose). */
export async function relationDuCouple(tx: TxLecture, type: string, source: string, cible: string): Promise<{ id: string; statut: string } | null> {
  const r = await tx.$queryRaw<{ id: string; statut: string }[]>`
    SELECT "id", "statut"::text AS "statut" FROM "reseau_relations"
     WHERE "typeRelation" = ${type}::"TypeRelationReseau" AND "sourceObjetId" = ${source}::bigint AND "cibleObjetId" = ${cible}::bigint`;
  return r[0] ?? null;
}

/** Declaration MANUELLE : une decision humaine, donc deja VALIDEE, avec son auteur et sa justification. */
export async function insererRelationManuelle(
  tx: TxEcriture, e: { id: string; projetId: string; type: string; source: string; cible: string; justification: string; acteurId: string },
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "reseau_relations" ("id", "projetId", "typeRelation", "sourceObjetId", "cibleObjetId", "statut", "origine", "decideParId", "decideLe", "justificationDecision", "creeParId")
    VALUES (${e.id}, ${e.projetId}, ${e.type}::"TypeRelationReseau", ${e.source}::bigint, ${e.cible}::bigint, 'VALIDEE', 'MANUELLE', ${e.acteurId}, CURRENT_TIMESTAMP, ${e.justification}, ${e.acteurId})`;
}

export async function changerStatutRelation(tx: TxEcriture, relId: string, vers: string, acteurId: string, justification: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE "reseau_relations"
       SET "statut" = ${vers}::"StatutRelationReseau", "decideParId" = ${acteurId}, "decideLe" = CURRENT_TIMESTAMP,
           "justificationDecision" = ${justification}, "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = ${relId}`;
}

/** Verrou de la ligne d'une relation (les transitions sont serialisees) ; rend son statut courant. */
export async function verrouillerRelation(tx: TxEcriture, projetId: string, relId: string): Promise<{ statut: string } | null> {
  const r = await tx.$queryRaw<{ statut: string }[]>`
    SELECT "statut"::text AS "statut" FROM "reseau_relations" WHERE "id" = ${relId} AND "projetId" = ${projetId} FOR UPDATE`;
  return r[0] ?? null;
}

// ------------------------------------------------------------------------------------------------
// Comptage par nature
// ------------------------------------------------------------------------------------------------

export interface DemandeComptage { projetId: string; jeuxIds: readonly string[] }

const BASE_COMPTAGE = (d: DemandeComptage) => Prisma.sql`
  base AS MATERIALIZED (
    SELECT o."id" AS "id", o."typeGeom" AS "typeGeom", o."longueurM" AS "longueurM", o."geom" AS "geom",
           CASE WHEN COALESCE(dd."nature", j."natureObjets")::text IN ('ACTIF_PHYSIQUE', 'CIRCUIT_LOGIQUE', 'EQUIPEMENT')
                THEN COALESCE(dd."nature", j."natureObjets")::text ELSE 'INCONNUE' END AS "nature",
           COALESCE(dd."typeObjet", 'INCONNU') AS "type"
      FROM "projets_voirie_objets" o
      JOIN "projets_voirie_jeux" j ON j."id" = o."jeuId"
      LEFT JOIN "reseau_objets_descripteurs" dd ON dd."objetId" = o."id"
     WHERE j."projetId" = ${d.projetId} AND j."id" = ANY(${[...d.jeuxIds]}::text[]) AND j."role"::text IN ('RESEAU_TIERS', 'AUTRE'))`;

export interface MesuresComptage {
  parNature: Record<NatureComptee, MesuresGroupe>;
  supports: { circuits: number; avecSupportValide: number; avecPropositionSeulement: number };
}

/**
 * Mesures des quatre natures sur les jeux donnes : nombre d'objets, nombre de lineaires, SOMME des longueurs (geographie, metres), longueur de
 * l'UNION des traces (`ST_UnaryUnion`, qui fusionne aussi les recouvrements partiels), repartition par type, groupes de trace strictement
 * identique (sens de lecture indifferent), et support physique des circuits (relations dont la cible est lisible).
 */
export async function mesurerComptage(tx: TxLecture, d: DemandeComptage): Promise<MesuresComptage> {
  const parNature = { ACTIF_PHYSIQUE: groupeVide(), CIRCUIT_LOGIQUE: groupeVide(), EQUIPEMENT: groupeVide(), INCONNUE: groupeVide() } as Record<NatureComptee, MesuresGroupe>;
  if (d.jeuxIds.length === 0) return { parNature, supports: { circuits: 0, avecSupportValide: 0, avecPropositionSeulement: 0 } };

  const g = await tx.$queryRaw<{ nature: string; nb: number; nbl: number; somme: number; fusionne: number }[]>`
    WITH ${BASE_COMPTAGE(d)}
    SELECT b."nature" AS "nature", count(*)::int AS "nb", (count(*) FILTER (WHERE b."typeGeom" = 'LIGNE'))::int AS "nbl",
           COALESCE(sum(b."longueurM") FILTER (WHERE b."typeGeom" = 'LIGNE'), 0)::float8 AS "somme",
           COALESCE(ST_Length(ST_UnaryUnion(ST_Collect(b."geom") FILTER (WHERE b."typeGeom" = 'LIGNE'))::geography), 0)::float8 AS "fusionne"
      FROM base b GROUP BY b."nature"`;
  for (const x of g) {
    const m = parNature[x.nature as NatureComptee];
    m.nb = Number(x.nb); m.nbLineaires = Number(x.nbl); m.sommeM = Number(x.somme); m.fusionneM = Number(x.fusionne);
  }
  const t = await tx.$queryRaw<{ nature: string; type: string; n: number }[]>`
    WITH ${BASE_COMPTAGE(d)}
    SELECT b."nature" AS "nature", b."type" AS "type", count(*)::int AS "n" FROM base b GROUP BY b."nature", b."type"`;
  for (const x of t) parNature[x.nature as NatureComptee].parType[x.type] = Number(x.n);
  const p = await tx.$queryRaw<{ nature: string; groupes: number; objets: number }[]>`
    WITH ${BASE_COMPTAGE(d)},
    traces AS (
      SELECT b."nature" AS "nature", count(*) AS "n"
        FROM base b WHERE b."typeGeom" = 'LIGNE'
       GROUP BY b."nature", ST_AsBinary(ST_Normalize(ST_SnapToGrid(b."geom", 0.00000001::float8))))
    SELECT t."nature" AS "nature", count(*)::int AS "groupes", sum(t."n")::int AS "objets" FROM traces t WHERE t."n" >= 2 GROUP BY t."nature"`;
  for (const x of p) parNature[x.nature as NatureComptee].tracesPartagees = { nbGroupes: Number(x.groupes), nbObjets: Number(x.objets) };

  const s = await tx.$queryRaw<{ circuits: number; valide: number; propose: number }[]>`
    WITH ${BASE_COMPTAGE(d)},
    liens AS (
      SELECT r."sourceObjetId" AS "src", bool_or(r."statut" = 'VALIDEE') AS "valide", bool_or(r."statut" = 'PROPOSEE') AS "propose"
        FROM "reseau_relations" r
        JOIN "projets_voirie_objets" oc ON oc."id" = r."cibleObjetId"
        JOIN "projets_voirie_jeux" jc ON jc."id" = oc."jeuId"
       WHERE r."projetId" = ${d.projetId} AND r."typeRelation" = 'PORTE_PAR' AND jc."statut"::text = 'AUTORISE'
         AND r."sourceObjetId" IN (SELECT b."id" FROM base b WHERE b."nature" = 'CIRCUIT_LOGIQUE')
       GROUP BY r."sourceObjetId")
    SELECT (SELECT count(*) FROM base b WHERE b."nature" = 'CIRCUIT_LOGIQUE')::int AS "circuits",
           (SELECT count(*) FROM liens l WHERE l."valide")::int AS "valide",
           (SELECT count(*) FROM liens l WHERE NOT l."valide" AND l."propose")::int AS "propose"`;
  return { parNature, supports: { circuits: Number(s[0]?.circuits ?? 0), avecSupportValide: Number(s[0]?.valide ?? 0), avecPropositionSeulement: Number(s[0]?.propose ?? 0) } };
}

export interface QualiteComptee {
  parClasse: Record<string, number>;
  sansProfondeur: number; sansAltitude: number; avecDonneesVerticales: number; objets: number;
}

/** Repartition de la qualite EFFECTIVE des objets (classe declaree ou « inconnue ») et manque de donnees verticales : un rapport, jamais une conclusion. */
export async function mesurerQualite(tx: TxLecture, d: DemandeComptage): Promise<QualiteComptee> {
  const vide: QualiteComptee = { parClasse: { A: 0, B: 0, C: 0, D: 0, E: 0, inconnue: 0 }, sansProfondeur: 0, sansAltitude: 0, avecDonneesVerticales: 0, objets: 0 };
  if (d.jeuxIds.length === 0) return vide;
  const r = await tx.$queryRaw<{ classe: string; n: number; sp: number; sa: number; av: number }[]>`
    SELECT COALESCE(COALESCE(dd."classePrecision", j."classePrecision")::text, 'inconnue') AS "classe", count(*)::int AS "n",
           (count(*) FILTER (WHERE dd."profondeurM" IS NULL))::int AS "sp", (count(*) FILTER (WHERE dd."altitudeM" IS NULL))::int AS "sa",
           (count(*) FILTER (WHERE dd."profondeurM" IS NOT NULL OR dd."altitudeM" IS NOT NULL))::int AS "av"
      FROM "projets_voirie_objets" o
      JOIN "projets_voirie_jeux" j ON j."id" = o."jeuId"
      LEFT JOIN "reseau_objets_descripteurs" dd ON dd."objetId" = o."id"
     WHERE j."projetId" = ${d.projetId} AND j."id" = ANY(${[...d.jeuxIds]}::text[]) AND j."role"::text IN ('RESEAU_TIERS', 'AUTRE')
     GROUP BY 1`;
  for (const x of r) {
    vide.parClasse[x.classe] = Number(x.n); vide.objets += Number(x.n);
    vide.sansProfondeur += Number(x.sp); vide.sansAltitude += Number(x.sa); vide.avecDonneesVerticales += Number(x.av);
  }
  return vide;
}

// ------------------------------------------------------------------------------------------------
// Proposition d'association par superposition geometrique
// ------------------------------------------------------------------------------------------------

export interface DemandeCandidats {
  /** Jeux (AUTORISE) dont les circuits logiques sont examines. */
  jeuxCircuits: readonly string[];
  /** Jeux (AUTORISE) dont les infrastructures physiques sont candidates. */
  jeuxInfra: readonly string[];
  epsg: number;
  tolerances: TableTolerances;
  couvertureMin: number;
  parCircuitMax: number;
  limite: number;
}

export interface Candidat {
  circuitId: string; infraId: string; couverture: number; toleranceM: number; longueurCircuitM: number; longueurDansToleranceM: number;
  classeCircuit: string | null; classeInfra: string | null; precisionCircuitM: number | null; precisionInfraM: number | null;
}

/** Circuits logiques et infrastructures physiques LINEAIRES qui peuvent donner lieu a une proposition, hors classe E (exclue : pas de faux trace). */
export async function compterEligibles(tx: TxLecture, d: Pick<DemandeCandidats, "jeuxCircuits" | "jeuxInfra">): Promise<{ circuits: number; infrastructures: number; circuitsClasseE: number; infrastructuresClasseE: number }> {
  if (d.jeuxCircuits.length === 0 && d.jeuxInfra.length === 0) return { circuits: 0, infrastructures: 0, circuitsClasseE: 0, infrastructuresClasseE: 0 };
  const r = await tx.$queryRaw<{ nature: string; classe: string | null; n: number }[]>`
    SELECT COALESCE(dd."nature", j."natureObjets")::text AS "nature", COALESCE(dd."classePrecision", j."classePrecision")::text AS "classe", count(*)::int AS "n"
      FROM "projets_voirie_objets" o
      JOIN "projets_voirie_jeux" j ON j."id" = o."jeuId"
      LEFT JOIN "reseau_objets_descripteurs" dd ON dd."objetId" = o."id"
     WHERE o."typeGeom" = 'LIGNE'
       AND ((j."id" = ANY(${[...d.jeuxCircuits]}::text[]) AND COALESCE(dd."nature", j."natureObjets") = 'CIRCUIT_LOGIQUE')
         OR (j."id" = ANY(${[...d.jeuxInfra]}::text[]) AND COALESCE(dd."nature", j."natureObjets") = 'ACTIF_PHYSIQUE'))
     GROUP BY 1, 2`;
  const sortie = { circuits: 0, infrastructures: 0, circuitsClasseE: 0, infrastructuresClasseE: 0 };
  for (const x of r) {
    const e = x.classe === "E";
    if (x.nature === "CIRCUIT_LOGIQUE") { if (e) sortie.circuitsClasseE += x.n; else sortie.circuits += x.n; }
    else if (e) sortie.infrastructuresClasseE += x.n; else sortie.infrastructures += x.n;
  }
  return sortie;
}

/**
 * Candidats d'association : pour chaque circuit logique lineaire, les infrastructures physiques lineaires de meme type de reseau dont une part
 * au moins `couvertureMin` de la longueur du circuit est a moins de la tolerance de l'infrastructure (UTM, ST_Buffer a 8 segments par quart
 * de cercle). Tolerance du couple : MAXIMUM de la tolerance de la classe de chaque objet et de leurs precisions horizontales declarees (jamais
 * leur somme). Au plus `parCircuitMax` candidats par circuit, les mieux couverts. L'index GiST de `projets_voirie_objets` borne la recherche.
 */
export async function candidatsAssociation(tx: TxLecture, d: DemandeCandidats): Promise<Candidat[]> {
  if (d.jeuxCircuits.length === 0 || d.jeuxInfra.length === 0) return [];
  const t = d.tolerances;
  // Tolerance de la CLASSE d'un objet, en expression (jamais une jointure : une jointure sur une petite table donne des estimations fausses a
  // l'optimiseur et un produit cartesien filtre trop tard). La classe E n'a pas de tolerance : elle est exclue par un filtre explicite.
  const tolClasse = (classe: Prisma.Sql) => Prisma.sql`CASE COALESCE(${classe}::text, 'INCONNUE') WHEN 'A' THEN ${t.A}::float8 WHEN 'B' THEN ${t.B}::float8
    WHEN 'C' THEN ${t.C}::float8 WHEN 'D' THEN ${t.D}::float8 WHEN 'INCONNUE' THEN ${t.INCONNUE}::float8 END`;
  const classeCirc = Prisma.sql`COALESCE(dd."classePrecision", j."classePrecision")`;
  const precCirc = Prisma.sql`COALESCE(dd."precisionHorizontaleM", j."precisionHorizontaleM")::float8`;
  const classeInfra = Prisma.sql`COALESCE(di."classePrecision", ji."classePrecision")`;
  const precInfra = Prisma.sql`COALESCE(di."precisionHorizontaleM", ji."precisionHorizontaleM")::float8`;
  const r = await tx.$queryRaw<{
    cid: string; iid: string; couv: number; tol: number; lc: number; ld: number; cc: string | null; ci: string | null; pc: number | null; pi: number | null;
  }[]>`
    WITH circ AS MATERIALIZED (
      SELECT o."id" AS "id", o."geom" AS "geom", ST_Transform(o."geom", ${d.epsg}::int) AS "g", j."typeReseau" AS "tr",
             ${classeCirc}::text AS "classe", ${precCirc} AS "prec",
             GREATEST(${tolClasse(classeCirc)}, COALESCE(${precCirc}, 0)) AS "tolo"
        FROM "projets_voirie_objets" o
        JOIN "projets_voirie_jeux" j ON j."id" = o."jeuId"
        LEFT JOIN "reseau_objets_descripteurs" dd ON dd."objetId" = o."id"
       WHERE j."id" = ANY(${[...d.jeuxCircuits]}::text[]) AND o."typeGeom" = 'LIGNE' AND COALESCE(dd."nature", j."natureObjets") = 'CIRCUIT_LOGIQUE'
         AND ${classeCirc} IS DISTINCT FROM 'E'),
    params AS MATERIALIZED (
      -- Plus grande tolerance d'une infrastructure candidate : borne du rayon de recherche (la tolerance d'un couple est le MAXIMUM des deux).
      SELECT COALESCE(max(GREATEST(${tolClasse(classeInfra)}, COALESCE(${precInfra}, 0))), 0) AS "maxinfra"
        FROM "projets_voirie_objets" oi
        JOIN "projets_voirie_jeux" ji ON ji."id" = oi."jeuId"
        LEFT JOIN "reseau_objets_descripteurs" di ON di."objetId" = oi."id"
       WHERE ji."id" = ANY(${[...d.jeuxInfra]}::text[]) AND oi."typeGeom" = 'LIGNE' AND COALESCE(di."nature", ji."natureObjets") = 'ACTIF_PHYSIQUE'
         AND ${classeInfra} IS DISTINCT FROM 'E'),
    paires AS MATERIALIZED (
      SELECT c."id" AS "cid", i."id" AS "iid", c."g" AS "cg", i."ig" AS "ig", GREATEST(c."tolo", i."tolo") AS "tol",
             c."classe" AS "cc", i."classe" AS "ci", c."prec" AS "pc", i."prec" AS "pi"
        FROM circ c CROSS JOIN params p
        JOIN LATERAL (
          SELECT oi."id" AS "id", ST_Transform(oi."geom", ${d.epsg}::int) AS "ig", ${classeInfra}::text AS "classe", ${precInfra} AS "prec",
                 GREATEST(${tolClasse(classeInfra)}, COALESCE(${precInfra}, 0)) AS "tolo"
            FROM "projets_voirie_objets" oi
            JOIN "projets_voirie_jeux" ji ON ji."id" = oi."jeuId"
            LEFT JOIN "reseau_objets_descripteurs" di ON di."objetId" = oi."id"
           WHERE oi."geom" && ST_Expand(c."geom", GREATEST(c."tolo", p."maxinfra") / 100000.0)
             AND ji."id" = ANY(${[...d.jeuxInfra]}::text[]) AND oi."typeGeom" = 'LIGNE' AND COALESCE(di."nature", ji."natureObjets") = 'ACTIF_PHYSIQUE'
             AND ${classeInfra} IS DISTINCT FROM 'E' AND ji."typeReseau" IS NOT DISTINCT FROM c."tr") i ON TRUE
       WHERE ST_DWithin(c."g", i."ig", GREATEST(c."tolo", i."tolo"))),
    mesures AS (
      SELECT p."cid", p."iid", p."tol", p."cc", p."ci", p."pc", p."pi", ST_Length(p."cg") AS "lc",
             ST_Length(ST_Intersection(p."cg", ST_Buffer(p."ig", p."tol", ${QUART_DE_CERCLE}))) AS "ld"
        FROM paires p),
    classees AS (
      SELECT m.*, LEAST(1.0, m."ld" / NULLIF(m."lc", 0)) AS "couv",
             row_number() OVER (PARTITION BY m."cid" ORDER BY LEAST(1.0, m."ld" / NULLIF(m."lc", 0)) DESC, m."iid" ASC) AS "rang"
        FROM mesures m WHERE m."lc" > 0 AND m."ld" / m."lc" >= ${d.couvertureMin}::float8)
    SELECT k."cid"::text AS "cid", k."iid"::text AS "iid", k."couv"::float8 AS "couv", k."tol"::float8 AS "tol", k."lc"::float8 AS "lc", k."ld"::float8 AS "ld",
           k."cc" AS "cc", k."ci" AS "ci", k."pc"::float8 AS "pc", k."pi"::float8 AS "pi"
      FROM classees k WHERE k."rang" <= ${d.parCircuitMax}::int
     ORDER BY k."cid", k."rang"
     LIMIT ${d.limite}`;
  return r.map((x) => ({
    circuitId: x.cid, infraId: x.iid, couverture: Number(x.couv), toleranceM: Number(x.tol), longueurCircuitM: Number(x.lc), longueurDansToleranceM: Number(x.ld),
    classeCircuit: x.cc, classeInfra: x.ci, precisionCircuitM: x.pc === null ? null : Number(x.pc), precisionInfraM: x.pi === null ? null : Number(x.pi),
  }));
}

export interface PropositionAEcrire { id: string; source: string; cible: string; proposition: string }

/** Ecrit les propositions (statut PROPOSEE, origine AUTOMATIQUE) ; un couple deja connu, quel que soit son statut, n'est PAS reecrit. Rend les identifiants crees. */
export async function insererPropositions(tx: TxEcriture, projetId: string, acteurId: string, lot: readonly PropositionAEcrire[]): Promise<string[]> {
  if (lot.length === 0) return [];
  const r = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "reseau_relations" ("id", "projetId", "typeRelation", "sourceObjetId", "cibleObjetId", "statut", "origine", "proposition", "creeParId")
    SELECT t."id", ${projetId}, 'PORTE_PAR'::"TypeRelationReseau", t."s"::bigint, t."c"::bigint, 'PROPOSEE'::"StatutRelationReseau", 'AUTOMATIQUE'::"OrigineRelationReseau", t."prop"::jsonb, ${acteurId}
      FROM unnest(${lot.map((x) => x.id)}::text[], ${lot.map((x) => x.source)}::text[], ${lot.map((x) => x.cible)}::text[], ${lot.map((x) => x.proposition)}::text[]) AS t("id", "s", "c", "prop")
    ON CONFLICT ("typeRelation", "sourceObjetId", "cibleObjetId") DO NOTHING
    RETURNING "id"`;
  return r.map((x) => x.id);
}

// ------------------------------------------------------------------------------------------------
// Cible d'un conflit (extension RC-3)
// ------------------------------------------------------------------------------------------------

export interface LigneCible { objetId: string; nature: string | null; natureJeu: string; valides: number; proposes: number }

/**
 * Nature effective et supports physiques des objets d'une liste de dossiers : nombre de relations PORTE_PAR VALIDEES et PROPOSEES dont la
 * CIBLE appartient a un jeu AUTORISE, POUR TOUS LES ROLES (revue de la vague 1, m3) : un support d'un jeu en controle, rejete, remplace ou retire n'est
 * jamais compte, que le compte soit lecteur ou decideur (un meme dossier ne donne pas deux chiffres selon le role).
 */
export async function cibles(tx: TxLecture, objetIds: readonly string[]): Promise<LigneCible[]> {
  const ids = [...new Set(objetIds.filter((i) => ID_OBJET.test(i)))];
  if (ids.length === 0) return [];
  return tx.$queryRaw<LigneCible[]>`
    SELECT o."id"::text AS "objetId", d."nature"::text AS "nature", j."natureObjets"::text AS "natureJeu",
           (SELECT count(*) FROM "reseau_relations" r JOIN "projets_voirie_objets" oc ON oc."id" = r."cibleObjetId" JOIN "projets_voirie_jeux" jc ON jc."id" = oc."jeuId"
             WHERE r."sourceObjetId" = o."id" AND r."typeRelation" = 'PORTE_PAR' AND r."statut" = 'VALIDEE' AND jc."statut"::text = 'AUTORISE')::int AS "valides",
           (SELECT count(*) FROM "reseau_relations" r JOIN "projets_voirie_objets" oc ON oc."id" = r."cibleObjetId" JOIN "projets_voirie_jeux" jc ON jc."id" = oc."jeuId"
             WHERE r."sourceObjetId" = o."id" AND r."typeRelation" = 'PORTE_PAR' AND r."statut" = 'PROPOSEE' AND jc."statut"::text = 'AUTORISE')::int AS "proposes"
      FROM "projets_voirie_objets" o
      JOIN "projets_voirie_jeux" j ON j."id" = o."jeuId"
      LEFT JOIN "reseau_objets_descripteurs" d ON d."objetId" = o."id"
     WHERE o."id" = ANY(${ids}::bigint[])`;
}

/** Nombre d'AUTRES objets du meme jeu dont la trace est strictement identique a celle de l'objet (circuits superposes ; sens de lecture indifferent). */
export async function tracePartagee(tx: TxLecture, objetId: string): Promise<number> {
  if (!ID_OBJET.test(objetId)) return 0;
  const r = await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS "n"
      FROM "projets_voirie_objets" o
      JOIN "projets_voirie_objets" a ON a."jeuId" = o."jeuId" AND a."id" <> o."id" AND a."typeGeom" = 'LIGNE' AND a."geom" && o."geom"
     WHERE o."id" = ${objetId}::bigint AND o."typeGeom" = 'LIGNE'
       AND ST_AsBinary(ST_Normalize(ST_SnapToGrid(a."geom", 0.00000001::float8))) = ST_AsBinary(ST_Normalize(ST_SnapToGrid(o."geom", 0.00000001::float8)))`;
  return r[0]?.n ?? 0;
}
