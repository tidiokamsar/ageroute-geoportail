/**
 * DEPOT SQL des indicateurs de l'Aide a la decision (lot 2) : LECTURE SEULE, agregations COTE SERVEUR.
 *
 * Chaque fonction ne fait que des SELECT, recoit son client en parametre (un client de transaction READ ONLY
 * convient) et rend peu de lignes : les troncons sont regroupes par dimensions CATEGORIELLES (region, etat,
 * provenance, statut de validation, longueur connue ou non), jamais lus un a un. Le nombre de groupes est borne par
 * le produit de ces dimensions, pas par le nombre de troncons.
 *
 * LE PERIMETRE EST CELUI DU REGISTRE : `fragmentPerimetre("reference")` de `lib/reseau.ts` (reseau classe saisi,
 * voirie promue et hors territoire exclus), la source unique du predicat. Un troncon de voirie promue ne peut donc
 * ni entrer au numerateur ni au denominateur.
 *
 * AUCUN ECRITURE : un test lit ce fichier et refuse tout mot d'ecriture SQL.
 */
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { fragmentPerimetre } from "../lib/reseau";
import type { LigneEtat } from "./kpi.noyau";

export type Lecture = Pick<PrismaClient, "$queryRaw">;

/** `null` = toutes les regions (compte national sans filtre) ; sinon la liste des regions en portee. */
export type Regions = readonly number[] | null;

/** Les regions en parametres lies (texte : Prisma type un tableau d'apres son premier element). */
const regionsTexte = (r: Regions): string[] | null => (r === null ? null : r.map(String));

/** Predicat de portee sur une colonne de region. Une region nulle ne satisfait jamais la liste. */
const dans = (colonne: string, r: Regions): Prisma.Sql => {
  const t = regionsTexte(r);
  return Prisma.sql`(${t}::text[] IS NULL OR ${Prisma.raw(colonne)} = ANY(${t}::text[]::int[]))`;
};

// ===================================================================================== etat du reseau

/** Borne de securite sur le nombre de groupes rendus (region x etat x provenance x validation x longueur). */
export const PLAFOND_GROUPES = 20_000;

interface LigneBrute {
  regionId: number;
  etat: string | null;
  sv: string | null;
  prov: string;
  obs: boolean;
  lc: boolean;
  nb: number;
  km: number | null;
  derniere: Date | null;
  ancienne: Date | null;
}

/**
 * Groupes de troncons du reseau classe saisi, par region, etat, provenance de l'etat, statut de validation et
 * longueur connue. UNE requete, un seul passage : le numerateur et le denominateur des taux sortent des memes lignes.
 *
 * Longueur connue : `longueurKm` finie et strictement positive (NaN est « plus grand que tout » en PostgreSQL : il
 * faut l'ecarter explicitement) ET non marquee DERIVED dans `valeurs_qualite` (une longueur calculee sur la
 * geometrie n'est pas la longueur metier, voir `lib/reseau.ts`).
 *
 * `valeurs_qualite` porte l'unicite (entityType, entityId, champ) : la jointure gauche rend au plus une ligne par
 * troncon, par l'index unique `valeurs_qualite_entityType_entityId_champ_key`.
 */
export async function lireEtatReseau(db: Lecture, regions: Regions, classes: readonly string[] | null): Promise<LigneEtat[]> {
  const filtreClasse = classes === null ? Prisma.empty : Prisma.sql`AND t.classe::text = ANY(${[...classes]}::text[])`;
  const lignes = await db.$queryRaw<LigneBrute[]>(Prisma.sql`
    WITH base AS (
      SELECT t."regionId" AS region, t.etat::text AS etat, t."statutValidation"::text AS sv,
             COALESCE(q.statut::text, 'SANS_LIGNE') AS prov, (q."observedAt" IS NOT NULL) AS obs,
             (t."longueurKm" > 0 AND t."longueurKm" <> 'NaN'::float8 AND t."longueurKm" < 'Infinity'::float8
              AND NOT EXISTS (SELECT 1 FROM valeurs_qualite ql
                               WHERE ql."entityType" = 'Troncon' AND ql."entityId" = t.id
                                 AND ql.champ = 'longueurKm' AND ql.statut = 'DERIVED')) AS lc,
             t."longueurKm" AS longueur, t."dateDerniereEvaluation" AS dde
        FROM troncons t
        LEFT JOIN valeurs_qualite q ON q."entityType" = 'Troncon' AND q."entityId" = t.id AND q.champ = 'etat'
       WHERE t."deletedAt" IS NULL
         ${fragmentPerimetre("reference", 't."sourceReference"')}
         AND ${dans('t."regionId"', regions)}
         ${filtreClasse}
    )
    SELECT region AS "regionId", etat, sv, prov, obs, lc,
           count(*)::int AS nb,
           COALESCE(SUM(longueur) FILTER (WHERE lc), 0)::float8 AS km,
           max(dde) AS derniere, min(dde) AS ancienne
      FROM base
     GROUP BY region, etat, sv, prov, obs, lc
     ORDER BY region, etat, sv, prov, obs, lc
     LIMIT ${PLAFOND_GROUPES}::int`);
  // Les dimensions sont categorielles : atteindre le plafond serait anormal, et tronquer en silence fausserait tous les taux.
  if (lignes.length >= PLAFOND_GROUPES) throw new Error(`lireEtatReseau : plus de ${PLAFOND_GROUPES} groupes, agregation refusee`);
  return lignes.map((l) => ({
    regionId: Number(l.regionId),
    etat: l.etat,
    provenance: l.prov,
    observeDate: l.obs === true,
    statutValidation: l.sv,
    longueurConnue: l.lc === true,
    nb: Number(l.nb),
    km: l.km === null ? 0 : Number(l.km),
    derniereEvaluation: l.derniere === null ? null : new Date(l.derniere),
    plusAncienneEvaluation: l.ancienne === null ? null : new Date(l.ancienne),
  }));
}

// ===================================================================================== marches

/**
 * Les marches dans la portee.
 *
 *  - Compte national : tous les marches non supprimes.
 *  - Compte regional (ou filtre de region) : un marche n'a PAS de region propre. Il est communique seulement s'il est
 *    rattache a au moins un chantier non supprime ET que TOUS ses chantiers sont dans la portee. Un marche sans
 *    chantier, ou a cheval sur une region hors portee, n'est pas communique : le lui rendre ferait fuiter un montant
 *    d'une autre region ou un total national. Voir `docs/aide-decision/DICTIONNAIRE-KPI.md`.
 *
 * Les index servent : `marches_deletedAt_idx`, la cle primaire (marcheId, chantierId) de `marches_chantiers`.
 */
function marchesDansLaPortee(regions: Regions): Prisma.Sql {
  const portee = regions === null
    ? Prisma.sql`true`
    : Prisma.sql`(
        EXISTS (SELECT 1 FROM marches_chantiers mc JOIN chantiers c ON c.id = mc."chantierId" AND c."deletedAt" IS NULL
                 WHERE mc."marcheId" = m.id)
        AND NOT EXISTS (SELECT 1 FROM marches_chantiers mx JOIN chantiers cx ON cx.id = mx."chantierId" AND cx."deletedAt" IS NULL
                         WHERE mx."marcheId" = m.id AND NOT (cx."regionId" = ANY(${regionsTexte(regions)}::text[]::int[]))))`;
  return Prisma.sql`SELECT m.id, m."bailleurId", m.devise::text AS devise, m."montantTotal" AS montant
                      FROM marches m WHERE m."deletedAt" IS NULL AND ${portee}`;
}

export interface ResumeMarches {
  /** Nombre de marches (lignes de `marches`) dans la portee. */
  marches: number;
  /** Marches dont le montant n'est pas saisi (jamais comptes comme 0). */
  sansMontant: number;
  /** Marches en devise etrangere : exclus de la somme GNF, aucun taux de change n'est valide. */
  horsGnf: number;
  /** Marches GNF avec montant saisi. */
  gnfAvecMontant: number;
  /** Somme des `montantTotal` des marches GNF, en chaine. */
  contractuelGnf: string;
}

export async function lireMarches(db: Lecture, regions: Regions): Promise<ResumeMarches> {
  const [r] = await db.$queryRaw<{ nb: number; sans: number; hors: number; gnf: number; total: string }[]>(Prisma.sql`
    WITH s AS (${marchesDansLaPortee(regions)})
    SELECT count(*)::int AS nb,
           count(*) FILTER (WHERE montant IS NULL)::int AS sans,
           count(*) FILTER (WHERE devise <> 'GNF')::int AS hors,
           count(*) FILTER (WHERE devise = 'GNF' AND montant IS NOT NULL)::int AS gnf,
           COALESCE(SUM(montant) FILTER (WHERE devise = 'GNF'), 0)::text AS total
      FROM s`);
  return {
    marches: Number(r?.nb ?? 0), sansMontant: Number(r?.sans ?? 0), horsGnf: Number(r?.hors ?? 0),
    gnfAvecMontant: Number(r?.gnf ?? 0), contractuelGnf: String(r?.total ?? "0"),
  };
}

export interface ResumeDecaisse {
  /** Decomptes au statut PAYE (non supprimes) des marches de la portee. */
  payes: number;
  /** Somme de `decomptes.montantGnf` des decomptes PAYE, en chaine. */
  payeGnf: string;
  /** Decomptes PAYE sans date de paiement. */
  payesSansDate: number;
  /** Decomptes PAYE de type RETENUE_GARANTIE (inclus, comme dans `/api/decaissements`). */
  payesRetenueGarantie: number;
  /** Decomptes EMIS, non payes : jamais comptes dans le decaisse. */
  emis: number;
}

export async function lireDecaisse(db: Lecture, regions: Regions): Promise<ResumeDecaisse> {
  const [r] = await db.$queryRaw<{ payes: number; total: string; sans: number; ret: number; emis: number }[]>(Prisma.sql`
    WITH s AS (${marchesDansLaPortee(regions)})
    SELECT count(*) FILTER (WHERE d.statut = 'PAYE')::int AS payes,
           COALESCE(SUM(d."montantGnf") FILTER (WHERE d.statut = 'PAYE'), 0)::text AS total,
           count(*) FILTER (WHERE d.statut = 'PAYE' AND d."datePaiement" IS NULL)::int AS sans,
           count(*) FILTER (WHERE d.statut = 'PAYE' AND d.type = 'RETENUE_GARANTIE')::int AS ret,
           count(*) FILTER (WHERE d.statut = 'EMIS')::int AS emis
      FROM decomptes d JOIN s ON s.id = d."marcheId"
     WHERE d."deletedAt" IS NULL`);
  return {
    payes: Number(r?.payes ?? 0), payeGnf: String(r?.total ?? "0"), payesSansDate: Number(r?.sans ?? 0),
    payesRetenueGarantie: Number(r?.ret ?? 0), emis: Number(r?.emis ?? 0),
  };
}

export interface LigneBailleur {
  /** `null` : marches sans bailleur renseigne (`marches.bailleurId` nul). */
  bailleurId: number | null;
  nom: string | null;
  marches: number;
  sansMontant: number;
  horsGnf: number;
  /** Marches GNF dont le montant est saisi : si 0, le contractuel de ce bailleur est INCONNU (`contractuelGnf` nul), pas zero. */
  avecMontantGnf: number;
  /** Somme GNF des marches du bailleur ; `null` quand aucun n'a de montant GNF (sans montant ou en devise etrangere). */
  contractuelGnf: string | null;
  /** `null` : aucun decompte PAYE pour ce bailleur (inconnu, pas zero). */
  decaisseGnf: string | null;
}

export interface VentilationBailleurs {
  lignes: LigneBailleur[];
  /** Nombre de bailleurs distincts dans la portee (le groupe « sans bailleur » compte pour un). */
  totalBailleurs: number;
}

/**
 * Ventilation par `marches.bailleurId` -> `bailleurs.id`, JAMAIS par le texte libre de `chantiers.bailleur`. Bornee a
 * `limite` lignes (les plus gros contractuels d'abord, puis l'identifiant : ordre deterministe) ; le nombre total de
 * bailleurs est rendu pour que l'appelant dise ce qui est tronque.
 */
export async function lireParBailleur(db: Lecture, regions: Regions, limite: number): Promise<VentilationBailleurs> {
  const bornes = Math.max(1, Math.min(200, Math.trunc(limite)));
  const lignes = await db.$queryRaw<{ id: number | null; nom: string | null; nb: number; sans: number; hors: number; gnf: number; total: string }[]>(Prisma.sql`
    WITH s AS (${marchesDansLaPortee(regions)})
    SELECT s."bailleurId" AS id, b.nom AS nom, count(*)::int AS nb,
           count(*) FILTER (WHERE s.montant IS NULL)::int AS sans,
           count(*) FILTER (WHERE s.devise <> 'GNF')::int AS hors,
           count(*) FILTER (WHERE s.devise = 'GNF' AND s.montant IS NOT NULL)::int AS gnf,
           COALESCE(SUM(s.montant) FILTER (WHERE s.devise = 'GNF'), 0)::text AS total
      FROM s LEFT JOIN bailleurs b ON b.id = s."bailleurId"
     GROUP BY s."bailleurId", b.nom
     ORDER BY COALESCE(SUM(s.montant) FILTER (WHERE s.devise = 'GNF'), 0) DESC, s."bailleurId" NULLS LAST
     LIMIT ${bornes}`);
  const [t] = await db.$queryRaw<{ n: number }[]>(Prisma.sql`
    WITH s AS (${marchesDansLaPortee(regions)})
    SELECT count(*)::int AS n FROM (SELECT 1 FROM s GROUP BY s."bailleurId") g`);
  const paye = await db.$queryRaw<{ id: number | null; total: string }[]>(Prisma.sql`
    WITH s AS (${marchesDansLaPortee(regions)})
    SELECT s."bailleurId" AS id, COALESCE(SUM(d."montantGnf"), 0)::text AS total
      FROM decomptes d JOIN s ON s.id = d."marcheId"
     WHERE d."deletedAt" IS NULL AND d.statut = 'PAYE'
     GROUP BY s."bailleurId"
     LIMIT 1000`);
  const decaisse = new Map(paye.map((p) => [p.id === null ? "null" : String(p.id), String(p.total)]));
  return {
    totalBailleurs: Number(t?.n ?? 0),
    lignes: lignes.map((l) => ({
      bailleurId: l.id === null ? null : Number(l.id),
      nom: l.nom,
      marches: Number(l.nb), sansMontant: Number(l.sans), horsGnf: Number(l.hors),
      avecMontantGnf: Number(l.gnf ?? 0),
      // Aucun marche avec un montant GNF : la somme n'est pas « 0 », elle est inconnue (comme le total global, NON_DISPONIBLE).
      contractuelGnf: Number(l.gnf ?? 0) > 0 ? String(l.total) : null,
      decaisseGnf: decaisse.get(l.id === null ? "null" : String(l.id)) ?? null,
    })),
  };
}

// ===================================================================================== chantiers

/**
 * Chantiers EN_COURS sans date de fin prevue : le retard ne peut pas etre juge, ils ne sont donc ni en retard ni a
 * l'heure. Compte rendu en avertissement de `chantiers_en_retard`.
 */
export async function compterChantiersSansEcheance(db: Lecture, regions: Regions): Promise<number> {
  const [r] = await db.$queryRaw<{ n: number }[]>(Prisma.sql`
    SELECT count(*)::int AS n FROM chantiers c
     WHERE c."deletedAt" IS NULL AND c.statut::text = 'EN_COURS' AND c."dateFinPrevue" IS NULL AND ${dans('c."regionId"', regions)}`);
  return Number(r?.n ?? 0);
}
