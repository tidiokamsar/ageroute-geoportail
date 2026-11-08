/**
 * Le curseur temporel, cote base : les portions vraies a une date, et la chronologie qui borne le
 * curseur. Lecture seule : rien n'est ecrit.
 *
 * LE SQL RETRECIT, LES REGLES DECIDENT
 *
 * La requete ne garde que des CANDIDATES (une borne de terrain, une borne d'enregistrement, une
 * emprise). Ce qui est vrai a la date, tel que connu a la date, et avec quel statut, c'est
 * `curseur.noyau.ts` qui le decide. Dupliquer cette logique en SQL ferait deux definitions de
 * « vrai a cette date » qui divergeraient au premier changement de regle.
 *
 * Le pre-filtre est donc un SUR-ENSEMBLE de ce que les regles retiennent :
 *   - axe terrain seul : `valideDu <= date` ET (`valideAu` nul OU `valideAu > date`) ;
 *   - avec axe systeme : `createdAt <= connuLe`, SANS condition sur `valideAu`, puisque
 *     `telQuEnregistreA` peut rouvrir une version dont le remplacement n'etait pas connu.
 *
 * CE QUE CE SERVICE NE FAIT PAS : il ne cherche pas les portions sans date d'effet (elles ne
 * sont placees a aucune date, `chronologie` les compte) et ne pretend pas lire le futur.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import {
  selectionner,
  type DecisionValidation,
  type PortionDatee,
  type ResultatSelection,
  type StatutValidation,
} from "./curseur.noyau";

export type DepotCurseur = Pick<PrismaClient, "$queryRaw">;

/** Au-dela, la reponse est tronquee et le dit. Un choix de protection, non mesure sur le reseau reel. */
export const PLAFOND_PORTIONS = 5_000;

/** Cote maximale d'une emprise, en degres (environ 550 km). Choix de protection, non mesure. */
export const COTE_MAX_EMPRISE_DEG = 5;

export class RefusCurseur extends Error {
  constructor(public readonly code: string, message: string, public readonly http: 400 | 422 = 400) {
    super(message);
  }
}

export interface Emprise { ouest: number; sud: number; est: number; nord: number }

export interface DemandeCurseur {
  /** Jour de terrain, minuit UTC. */
  dateTerrain: Date;
  /** Axe systeme : instant (fin de journee) ou `null` pour « aujourd'hui ». */
  connuLe: Date | null;
  inclureAValider: boolean;
  /** Exactement l'un des deux : une emprise, ou un troncon. */
  emprise?: Emprise;
  tronconId?: string;
}

function verifierEmprise(e: Emprise): void {
  const vals = [e.ouest, e.sud, e.est, e.nord];
  if (!vals.every(Number.isFinite)) throw new RefusCurseur("EMPRISE_INVALIDE", "L'emprise doit etre quatre nombres.");
  if (e.ouest >= e.est || e.sud >= e.nord) throw new RefusCurseur("EMPRISE_INVALIDE", "L'emprise est inversee ou vide.");
  if (e.sud < -90 || e.nord > 90 || e.ouest < -180 || e.est > 180) throw new RefusCurseur("EMPRISE_INVALIDE", "L'emprise sort du globe.");
  if (e.est - e.ouest > COTE_MAX_EMPRISE_DEG || e.nord - e.sud > COTE_MAX_EMPRISE_DEG) {
    throw new RefusCurseur("EMPRISE_TROP_LARGE", `L'emprise depasse ${COTE_MAX_EMPRISE_DEG} degres de cote : zoomer ou cadrer un troncon.`, 422);
  }
}

interface LignePortion extends PortionDatee {
  tronconCode: string;
  tronconNom: string;
  revetement: string | null;
  etat: string | null;
  etatLibelle: string | null;
  praticabilite: string | null;
  largeurM: number | null;
  source: string | null;
  observeeLe: Date | null;
  confiance: string | null;
  geometry: string | null;
}

export interface PortionALaDate {
  id: string;
  tronconId: string;
  tronconCode: string;
  tronconNom: string;
  debutM: number;
  finM: number;
  longueurM: number;
  revetement: string | null;
  etat: string | null;
  etatLibelle: string | null;
  praticabilite: string | null;
  largeurM: number | null;
  source: string | null;
  confiance: string | null;
  observeeLe: string | null;
  valideDu: string | null;
  valideAu: string | null;
  enregistreLe: string;
  /** Statut tel que connu a la date demandee. */
  statut: StatutValidation;
  ambigue: boolean;
  /** GeoJSON (texte), ou nul : une portion sans trace exploitable reste dans la liste. */
  geometry: string | null;
}

export interface ReponseCurseur {
  dateTerrain: string;
  connuLe: string | null;
  inclureAValider: boolean;
  tronque: boolean;
  plafond: number;
  comptes: ResultatSelection<LignePortion>["comptes"];
  longueurCouverteM: number;
  portions: PortionALaDate[];
}

const jour = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));
/** Un instant sans fuseau, tel que la colonne `timestamp(3)` le stocke (UTC naif). */
const horodatageNaif = (d: Date): string => d.toISOString().replace("Z", "");

export async function lirePortionsALaDate(depot: DepotCurseur, d: DemandeCurseur): Promise<ReponseCurseur> {
  if ((d.emprise === undefined) === (d.tronconId === undefined)) {
    throw new RefusCurseur("PERIMETRE_REQUIS", "Indiquer une emprise OU un troncon, pas les deux, pas aucun.");
  }
  if (d.emprise) verifierEmprise(d.emprise);

  const jourTerrain = jour(d.dateTerrain) as string;
  const e = d.emprise;
  const filtreEmprise = e
    ? Prisma.sql`AND t."geom"::geography && ST_MakeEnvelope(${e.ouest}::float8, ${e.sud}::float8, ${e.est}::float8, ${e.nord}::float8, 4326)::geography`
    : Prisma.empty;
  const filtreTroncon = d.tronconId ? Prisma.sql`AND p."tronconId" = ${d.tronconId}::text` : Prisma.empty;
  // Sans axe systeme, le statut est celui d'aujourd'hui : on peut ecarter en SQL les rejets et
  // les « a corriger ». Les PROPOSITIONS sont toujours chargees, meme non demandees : ce sont les
  // regles qui les ecartent, et qui peuvent ainsi COMPTER celles qu'on ne montre pas. Les filtrer
  // en SQL rendrait ce compte toujours nul, et l'agent croirait que rien n'attend validation.
  // Avec l'axe systeme, il faut le journal : on charge tous les statuts et les regles tranchent.
  const statuts = ["VALIDE", "A_VALIDER"];
  const filtreStatut = d.connuLe === null ? Prisma.sql`AND p."statutValidation"::text = ANY(${statuts}::text[])` : Prisma.empty;
  const filtreSysteme = d.connuLe === null
    ? Prisma.sql`AND (p."valideAu" IS NULL OR p."valideAu" > ${jourTerrain}::date)`
    : Prisma.sql`AND p."createdAt" <= ${horodatageNaif(d.connuLe)}::timestamp`;

  const lignes = await depot.$queryRaw<LignePortion[]>(Prisma.sql`
    SELECT p."id", p."tronconId", t."code" AS "tronconCode", t."nom" AS "tronconNom",
           p."debutM", p."finM", p."revetement", p."etat", er."libelle" AS "etatLibelle",
           p."praticabilite", p."largeurM", p."source", p."observeeLe", p."confiance"::text AS "confiance",
           p."statutValidation"::text AS "statutValidation",
           p."valideDu", p."valideAu", p."createdAt" AS "enregistreLe", p."remplaceeLe", p."deletedAt",
           ST_AsGeoJSON(COALESCE(
             p."geom",
             CASE WHEN t."geom" IS NOT NULL AND ST_Length(t."geom"::geography) > 0
                  THEN ST_LineSubstring(t."geom",
                         LEAST(1, p."debutM" / ST_Length(t."geom"::geography)),
                         LEAST(1, p."finM"   / ST_Length(t."geom"::geography)))
             END)) AS "geometry"
      FROM "portions" p
      JOIN "troncons" t ON t."id" = p."tronconId"
      LEFT JOIN "referentiel_etats_chaussee" er ON er."code" = p."etat"
     WHERE p."deletedAt" IS NULL
       AND p."valideDu" IS NOT NULL
       AND p."valideDu" <= ${jourTerrain}::date
       ${filtreSysteme}
       ${filtreStatut}
       ${filtreTroncon}
       ${filtreEmprise}
     ORDER BY p."tronconId", p."debutM", p."id"
     LIMIT ${PLAFOND_PORTIONS + 1}`);

  const tronque = lignes.length > PLAFOND_PORTIONS;
  const candidates = tronque ? lignes.slice(0, PLAFOND_PORTIONS) : lignes;

  let decisions: DecisionValidation[] = [];
  if (d.connuLe !== null && candidates.length > 0) {
    const brutes = await depot.$queryRaw<{ portionId: string; statut: string | null; decideLe: Date }[]>(Prisma.sql`
      SELECT "entityId" AS "portionId", ("after"->>'statutValidation') AS "statut", "createdAt" AS "decideLe"
        FROM "audit_logs"
       WHERE "entityType" = 'Portion'
         AND "action"::text IN ('VALIDATE', 'REJECT')
         AND "entityId" = ANY(${candidates.map((c) => c.id)}::text[])
         AND "createdAt" <= ${horodatageNaif(d.connuLe)}::timestamp
       ORDER BY "createdAt", "id"`);
    decisions = brutes
      .filter((b): b is { portionId: string; statut: StatutValidation; decideLe: Date } =>
        b.statut === "VALIDE" || b.statut === "REJETE" || b.statut === "A_CORRIGER" || b.statut === "A_VALIDER")
      .map((b) => ({ portionId: b.portionId, statut: b.statut, decideLe: b.decideLe }));
  }

  const sel = selectionner(candidates, decisions, {
    dateTerrain: d.dateTerrain,
    connuLe: d.connuLe,
    inclureAValider: d.inclureAValider,
  });

  return {
    dateTerrain: jourTerrain,
    connuLe: jour(d.connuLe),
    inclureAValider: d.inclureAValider,
    tronque,
    plafond: PLAFOND_PORTIONS,
    comptes: sel.comptes,
    longueurCouverteM: sel.longueurCouverteM,
    portions: sel.retenues.map((r) => ({
      id: r.id,
      tronconId: r.tronconId,
      tronconCode: r.tronconCode,
      tronconNom: r.tronconNom,
      debutM: r.debutM,
      finM: r.finM,
      longueurM: Math.round((r.finM - r.debutM) * 10) / 10,
      revetement: r.revetement,
      etat: r.etat,
      etatLibelle: r.etatLibelle,
      praticabilite: r.praticabilite,
      largeurM: r.largeurM,
      source: r.source,
      confiance: r.confiance,
      observeeLe: jour(r.observeeLe),
      valideDu: jour(r.valideDu),
      valideAu: jour(r.valideAu),
      enregistreLe: r.enregistreLe.toISOString(),
      statut: r.statutConnu,
      ambigue: r.ambigue,
      geometry: r.geometry,
    })),
  };
}

export interface Chronologie {
  /** Portions non rejetees, non supprimees. */
  total: number;
  avecDateEffet: number;
  /** Placees a AUCUNE date du curseur. */
  sansDateEffet: number;
  /** Premiere et derniere date d'effet connues (jours), ou nulles. */
  premiere: string | null;
  derniere: string | null;
  /** Nombre de debuts et de fins de validite par mois, pour graduer le curseur. */
  parMois: { mois: string; n: number }[];
}

/**
 * Ce que le curseur peut montrer, en bornes et en volumes.
 *
 * Sert d'abord a dire la verite quand il n'y a RIEN a montrer : « 0 portion avec date d'effet »
 * est une information, et un curseur vide sans explication se lirait comme « le reseau etait
 * vide a cette date ».
 */
export async function chronologie(depot: DepotCurseur): Promise<Chronologie> {
  const [g] = await depot.$queryRaw<{ total: number; avecDateEffet: number; premiere: Date | null; derniere: Date | null }[]>(Prisma.sql`
    SELECT count(*)::int AS "total",
           count(*) FILTER (WHERE "valideDu" IS NOT NULL)::int AS "avecDateEffet",
           min("valideDu") AS "premiere",
           max(GREATEST("valideDu", COALESCE("valideAu", "valideDu"))) AS "derniere"
      FROM "portions"
     WHERE "deletedAt" IS NULL AND "statutValidation"::text IN ('VALIDE', 'A_VALIDER')`);

  const mois = await depot.$queryRaw<{ mois: string; n: number }[]>(Prisma.sql`
    SELECT to_char(date_trunc('month', x."d"), 'YYYY-MM') AS "mois", count(*)::int AS "n"
      FROM (
        SELECT "valideDu" AS "d" FROM "portions"
         WHERE "deletedAt" IS NULL AND "statutValidation"::text IN ('VALIDE', 'A_VALIDER') AND "valideDu" IS NOT NULL
        UNION ALL
        SELECT "valideAu" FROM "portions"
         WHERE "deletedAt" IS NULL AND "statutValidation"::text IN ('VALIDE', 'A_VALIDER') AND "valideAu" IS NOT NULL
      ) x
     GROUP BY 1 ORDER BY 1 LIMIT 600`);

  const total = g?.total ?? 0;
  const avec = g?.avecDateEffet ?? 0;
  return {
    total,
    avecDateEffet: avec,
    sansDateEffet: total - avec,
    premiere: jour(g?.premiere ?? null),
    derniere: jour(g?.derniere ?? null),
    parMois: mois,
  };
}
