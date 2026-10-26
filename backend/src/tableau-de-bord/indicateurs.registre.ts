/**
 * Le registre des indicateurs du tableau de bord executif (paragraphe 7.12) et de la Control Tower.
 *
 * CHAQUE INDICATEUR DECLARE QUATRE CHOSES : son perimetre (affiche), sa requete de calcul, sa requete
 * de controle independante, et s'il se ventile par region. Le banc `tests-integration/tableau-de-bord`
 * insere des fixtures connues dans une base PostGIS reelle et exige, pour chacun, calcul = controle =
 * valeur attendue calculee a la main.
 *
 * TOUT PASSE PAR `$queryRaw` ETIQUETE. Pas d'ORM, pas de concatenation : les regions et les dates sont
 * des parametres lies. Le depot est injecte pour que le banc lise la base de rejeu, pas une autre.
 *
 * AUCUN CHIFFRE N'EST FABRIQUE. Pas de cible, pas de seuil, pas de taux « de realisation » : un
 * indicateur compte ou somme ce qui est dans une table, ou rend `null` quand il n'y a rien a mesurer.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import { PREFIXES_HORS_RESEAU_CLASSE, fragmentPerimetre } from "../lib/reseau";
import { couvertureReseau, cumuler } from "../reseau/couverture.reseau";
import { TOLERANCE_M, chevauchements, type Portion } from "../reseau/portions";
import { listerProgrammes } from "../exploitation/patrouilles.service";
import type { DefinitionIndicateur, PerimetreIndicateur, Portee, SourceIndicateur, Valeur } from "./indicateurs.noyau";

export type Depot = Pick<PrismaClient, "$queryRaw" | "programmePatrouille" | "mission">;
type Definition = DefinitionIndicateur<Depot>;

// ===================================================================================== perimetres

export const PERIMETRES = {
  RESEAU_CLASSE_SAISI: {
    code: "RESEAU_CLASSE_SAISI",
    libelle: "Réseau classé saisi",
    definition: "Tronçons non supprimés dont la référence de source n'est ni « voirie_locale: » ni « hors_territoire: » (lib/reseau.ts). Ce n'est pas le réseau national annoncé par les TDR de la BDR : la base en porte une fraction, et la voirie rattachée est comptée à part.",
  },
  OUVRAGES_INVENTAIRE: {
    code: "OUVRAGES_INVENTAIRE",
    libelle: "Inventaire des ouvrages d'art de référence",
    definition: "Ouvrages non supprimés, hors franchissements repris d'une source externe (« ouvrage_osm: »).",
  },
  POINTS_NOIRS_REGISTRE: { code: "POINTS_NOIRS_REGISTRE", libelle: "Points noirs au registre", definition: "Points noirs non supprimés." },
  POSTES_REGISTRE: { code: "POSTES_REGISTRE", libelle: "Péages et pesages au registre", definition: "Postes non supprimés." },
  DOCUMENTS_REGISTRE: { code: "DOCUMENTS_REGISTRE", libelle: "Base documentaire", definition: "Documents non supprimés." },
  CHANTIERS_REGISTRE: { code: "CHANTIERS_REGISTRE", libelle: "Chantiers au registre", definition: "Chantiers non supprimés, tous statuts." },
  PORTIONS_VALIDEES: {
    code: "PORTIONS_VALIDEES",
    libelle: "Portions homogènes validées",
    definition: "Portions au statut VALIDE, non remplacées, non supprimées : le même prédicat que la contrainte d'exclusion. C'est l'état constaté, par opposition aux états importés.",
  },
  PORTIONS_COURANTES: {
    code: "PORTIONS_COURANTES",
    libelle: "Portions courantes",
    definition: "Portions non remplacées et non supprimées, quel que soit leur statut de validation.",
  },
  VALEURS_QUALIFIEES: {
    code: "VALEURS_QUALIFIEES",
    libelle: "Valeurs qualifiées",
    definition: "Lignes de valeurs_qualite : un statut de connaissance (observé, importé non vérifié, dérivé, en conflit, inconnu) par champ de fiche qualifié. Les champs jamais qualifiés n'y figurent pas.",
  },
  MAIN_COURANTE_ACTIFS: {
    code: "MAIN_COURANTE_ACTIFS",
    libelle: "Événements de la main courante non clos",
    definition: "Événements dont le dernier statut n'est pas CLOS. Un événement sans tronçon rattaché a une région inconnue : il n'est pas communiqué à un compte régional.",
  },
  ESCALADE_REGLES: { code: "ESCALADE_REGLES", libelle: "Règles d'escalade actives", definition: "Règles d'escalade saisies par AGEROUTE et non désactivées. Aucune n'est semée." },
  PROGRAMMES_PATROUILLE: {
    code: "PROGRAMMES_PATROUILLE",
    libelle: "Programmes de patrouille",
    definition: "Programmes non supprimés. L'échéance se calcule au jour donné à partir du dernier passage réalisé (mission terminée), de la périodicité et des mois actifs. Un programme sans région n'est pas communiqué à un compte régional.",
  },
  PROPOSITIONS_TELEDETECTION: {
    code: "PROPOSITIONS_TELEDETECTION",
    libelle: "Propositions de télédétection",
    definition: "Propositions déposées par une méthode : des hypothèses à vérifier sur le terrain, jamais des faits. Une proposition non rattachée à un tronçon n'est pas communiquée à un compte régional.",
  },
  PREVISIONS_BUDGETAIRES: {
    code: "PREVISIONS_BUDGETAIRES",
    libelle: "Prévisions budgétaires saisies",
    definition: "Lignes de programmes_budgetaires non supprimées, posées à la main (source SAISIE). Une ligne sans tronçon n'a pas de région : elle n'est pas communiquée à un compte régional.",
  },
} as const satisfies Record<string, PerimetreIndicateur>;

// ===================================================================================== helpers SQL

const nombre = (v: unknown): number => Number(v ?? 0);
const arrondi = (v: number, d = 2): number => { const f = 10 ** d; return Math.round(v * f) / f; };
const rangee = async <T>(depot: Depot, q: Prisma.Sql): Promise<T | undefined> => (await depot.$queryRaw<T[]>(q))[0];
const compte = async (depot: Depot, q: Prisma.Sql): Promise<number> => nombre((await rangee<{ v: bigint | number }>(depot, q))?.v);
const texteGnf = async (depot: Depot, q: Prisma.Sql): Promise<string> => String((await rangee<{ v: string | null }>(depot, q))?.v ?? "0");

/** Les regions en parametres lies (texte puis entier : Prisma type un tableau d'apres son premier element). */
const regionsSql = (p: Portee): string[] | null => (p.regions === null ? null : p.regions.map(String));
/** Predicat de portee : toujours vrai en national, sinon la colonne doit etre dans les regions (NULL = region inconnue = exclu). */
const dans = (colonne: string, p: Portee): Prisma.Sql => {
  const r = regionsSql(p);
  return Prisma.sql`(${r}::text[] IS NULL OR ${Prisma.raw(colonne)} = ANY(${r}::text[]::int[]))`;
};
/** Instant en parametre lie, lu comme un instant UTC naif (les colonnes `timestamp(3)` de Prisma sont des UTC naifs). */
const instant = (p: Portee): Prisma.Sql => Prisma.sql`${p.maintenant.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;

/** Le perimetre « reseau classe » par la forme SQL du depot (LIKE), source unique du predicat. */
const classeCalcul = (col = 't."sourceReference"'): Prisma.Sql => fragmentPerimetre("reference", col);
/** Le MEME perimetre par une autre forme (starts_with sur la liste des prefixes) : un prefixe ajoute a la liste sans l'etre dans le fragment ferait diverger calcul et controle. */
const classeControle = (col = 't."sourceReference"'): Prisma.Sql => {
  const c = Prisma.raw(col);
  const tests = PREFIXES_HORS_RESEAU_CLASSE.map((p) => Prisma.sql`starts_with(COALESCE(${c}, ''), ${p})`);
  return Prisma.sql`AND NOT (${Prisma.join(tests, " OR ")})`;
};

// ===================================================================================== sources (« aucune donnee »)

const sourceVideDe = (table: string, filtre: (p: Portee) => Prisma.Sql = () => Prisma.sql`true`): SourceIndicateur<Depot>["vide"] =>
  async (depot, portee) => (await compte(depot, Prisma.sql`SELECT count(*)::int AS v FROM (SELECT 1 FROM ${Prisma.raw(table)} x WHERE ${filtre(portee)} LIMIT 1) s`)) === 0;

const SOURCES = {
  troncons: { cle: "troncons", libelle: "tronçons du réseau classé", vide: async (d, p) => (await compte(d, Prisma.sql`SELECT count(*)::int AS v FROM (SELECT 1 FROM troncons t WHERE t."deletedAt" IS NULL ${classeCalcul()} AND ${dans('t."regionId"', p)} LIMIT 1) s`)) === 0 },
  portions: { cle: "portions", libelle: "portions", vide: async (d, p) => (await compte(d, Prisma.sql`SELECT count(*)::int AS v FROM (SELECT 1 FROM portions po JOIN troncons t ON t.id = po."tronconId" WHERE po."deletedAt" IS NULL AND ${dans('t."regionId"', p)} LIMIT 1) s`)) === 0 },
  mainCourante: { cle: "main_courante", libelle: "main courante", vide: async (d, p) => (await compte(d, Prisma.sql`SELECT count(*)::int AS v FROM (SELECT 1 FROM evenements_exploitation e LEFT JOIN troncons t ON t.id = e."tronconId" WHERE ${dans('t."regionId"', p)} LIMIT 1) s`)) === 0 },
  reglesEscalade: { cle: "regles_escalade", libelle: "règles d'escalade", vide: sourceVideDe('"regles_escalade"') },
  programmesPatrouille: { cle: "programmes_patrouille", libelle: "programmes de patrouille", vide: async (d, p) => (await compte(d, Prisma.sql`SELECT count(*)::int AS v FROM (SELECT 1 FROM programmes_patrouille pp WHERE pp."deletedAt" IS NULL AND ${dans('pp."regionId"', p)} LIMIT 1) s`)) === 0 },
  propositions: { cle: "propositions_teledetection", libelle: "propositions de télédétection", vide: async (d, p) => (await compte(d, Prisma.sql`SELECT count(*)::int AS v FROM (SELECT 1 FROM propositions_teledetection pt LEFT JOIN troncons t ON t.id = pt."tronconId" WHERE NOT pt.synthetique AND ${dans('t."regionId"', p)} LIMIT 1) s`)) === 0 },
  previsions: { cle: "programmes_budgetaires", libelle: "prévisions budgétaires", vide: async (d, p) => (await compte(d, Prisma.sql`SELECT count(*)::int AS v FROM (SELECT 1 FROM programmes_budgetaires pb LEFT JOIN troncons t ON t.id = pb."tronconId" WHERE pb."deletedAt" IS NULL AND ${dans('t."regionId"', p)} LIMIT 1) s`)) === 0 },
  ouvrages: { cle: "ouvrages", libelle: "ouvrages d'art", vide: async (d, p) => (await compte(d, Prisma.sql`SELECT count(*)::int AS v FROM (SELECT 1 FROM ouvrages o WHERE o."deletedAt" IS NULL AND ${dans('o."regionId"', p)} LIMIT 1) s`)) === 0 },
  pointsNoirs: { cle: "points_noirs", libelle: "points noirs", vide: async (d, p) => (await compte(d, Prisma.sql`SELECT count(*)::int AS v FROM (SELECT 1 FROM points_noirs x WHERE x."deletedAt" IS NULL AND ${dans('x."regionId"', p)} LIMIT 1) s`)) === 0 },
  postes: { cle: "postes", libelle: "péages et pesages", vide: async (d, p) => (await compte(d, Prisma.sql`SELECT count(*)::int AS v FROM (SELECT 1 FROM postes x WHERE x."deletedAt" IS NULL AND ${dans('x."regionId"', p)} LIMIT 1) s`)) === 0 },
  documents: { cle: "documents", libelle: "documents", vide: sourceVideDe('"documents"', () => Prisma.sql`x."deletedAt" IS NULL`) },
  valeursQualite: { cle: "valeurs_qualite", libelle: "valeurs qualifiées", vide: sourceVideDe('"valeurs_qualite"') },
  chantiers: { cle: "chantiers", libelle: "chantiers", vide: async (d, p) => (await compte(d, Prisma.sql`SELECT count(*)::int AS v FROM (SELECT 1 FROM chantiers c WHERE c."deletedAt" IS NULL AND ${dans('c."regionId"', p)} LIMIT 1) s`)) === 0 },
} satisfies Record<string, SourceIndicateur<Depot>>;

// ===================================================================================== reseau

/** Longueurs et etats : chaque ligne d'un perimetre, lue une a une pour le controle (le reseau classe tient en quelques milliers de lignes). */
interface LigneTroncon { id: string; metres: number | null; km: number | null; derivee: boolean }

const lignesTroncons = (depot: Depot, p: Portee) => depot.$queryRaw<LigneTroncon[]>`
  SELECT t.id, ST_Length(t.geom::geography) AS metres, t."longueurKm" AS km,
         EXISTS (SELECT 1 FROM valeurs_qualite q WHERE q."entityType" = 'Troncon' AND q."entityId" = t.id
                   AND q.champ = 'longueurKm' AND q.statut = 'DERIVED') AS derivee
    FROM troncons t
   WHERE t."deletedAt" IS NULL ${classeControle()} AND ${dans('t."regionId"', p)}`;

const reseau: Definition[] = [
  {
    code: "troncons_classes", libelle: "Tronçons classés", groupe: "reseau", unite: "nombre", regionalisable: true,
    perimetre: PERIMETRES.RESEAU_CLASSE_SAISI, source: SOURCES.troncons,
    calcul: (d, p) => compte(d, Prisma.sql`SELECT count(*)::int AS v FROM troncons t WHERE t."deletedAt" IS NULL ${classeCalcul()} AND ${dans('t."regionId"', p)}`),
    // Autre chemin : tout le registre non supprime, moins ce que les prefixes excluent.
    controle: async (d, p) => {
      const r = await rangee<{ tout: bigint; hors: bigint }>(d, Prisma.sql`
        SELECT count(*) AS tout,
               count(*) FILTER (WHERE ${Prisma.join(PREFIXES_HORS_RESEAU_CLASSE.map((x) => Prisma.sql`starts_with(COALESCE(t."sourceReference", ''), ${x})`), " OR ")}) AS hors
          FROM troncons t WHERE t."deletedAt" IS NULL AND ${dans('t."regionId"', p)}`);
      return nombre(r?.tout) - nombre(r?.hors);
    },
  },
  {
    code: "longueur_geometrique_km", libelle: "Longueur géométrique du réseau classé saisi", groupe: "reseau", unite: "km", regionalisable: true,
    perimetre: PERIMETRES.RESEAU_CLASSE_SAISI, source: SOURCES.troncons,
    calcul: async (d, p) => arrondi(nombre((await rangee<{ v: number | null }>(d, Prisma.sql`
      SELECT COALESCE(SUM(ST_Length(t.geom::geography)) / 1000.0, 0) AS v FROM troncons t
       WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL ${classeCalcul()} AND ${dans('t."regionId"', p)}`))?.v)),
    // Autre chemin : une longueur par troncon, additionnee ici.
    controle: async (d, p) => arrondi((await lignesTroncons(d, p)).reduce((s, l) => s + (l.metres ?? 0), 0) / 1000),
  },
  {
    code: "longueur_metier_km", libelle: "Longueur saisie du réseau classé (hors valeurs dérivées)", groupe: "reseau", unite: "km", regionalisable: true,
    perimetre: PERIMETRES.RESEAU_CLASSE_SAISI, source: SOURCES.troncons,
    calcul: async (d, p) => arrondi(nombre((await rangee<{ v: number | null }>(d, Prisma.sql`
      SELECT COALESCE(SUM(t."longueurKm") FILTER (WHERE NOT EXISTS (
               SELECT 1 FROM valeurs_qualite q WHERE q."entityType" = 'Troncon' AND q."entityId" = t.id
                  AND q.champ = 'longueurKm' AND q.statut = 'DERIVED')), 0) AS v
        FROM troncons t WHERE t."deletedAt" IS NULL ${classeCalcul()} AND ${dans('t."regionId"', p)}`))?.v)),
    controle: async (d, p) => arrondi((await lignesTroncons(d, p)).filter((l) => !l.derivee).reduce((s, l) => s + (l.km ?? 0), 0)),
  },
  {
    code: "troncons_mauvais_critique", libelle: "Tronçons classés en état mauvais ou critique", groupe: "reseau", unite: "nombre", regionalisable: true,
    perimetre: PERIMETRES.RESEAU_CLASSE_SAISI, source: SOURCES.troncons,
    calcul: (d, p) => compte(d, Prisma.sql`SELECT count(*)::int AS v FROM troncons t WHERE t."deletedAt" IS NULL ${classeCalcul()} AND t.etat::text IN ('MAUVAIS', 'CRITIQUE') AND ${dans('t."regionId"', p)}`),
    controle: async (d, p) => {
      const lignes = await d.$queryRaw<{ etat: string; n: bigint }[]>`
        SELECT t.etat::text AS etat, count(*) AS n FROM troncons t
         WHERE t."deletedAt" IS NULL ${classeControle()} AND ${dans('t."regionId"', p)} GROUP BY t.etat`;
      return lignes.filter((l) => l.etat === "MAUVAIS" || l.etat === "CRITIQUE").reduce((s, l) => s + nombre(l.n), 0);
    },
  },
  {
    code: "ouvrages_inventories", libelle: "Ouvrages d'art inventoriés", groupe: "reseau", unite: "nombre", regionalisable: true,
    perimetre: PERIMETRES.OUVRAGES_INVENTAIRE, source: SOURCES.ouvrages,
    calcul: (d, p) => compte(d, Prisma.sql`SELECT count(*)::int AS v FROM ouvrages o WHERE o."deletedAt" IS NULL AND (o."sourceReference" IS NULL OR o."sourceReference" NOT LIKE 'ouvrage_osm:%') AND ${dans('o."regionId"', p)}`),
    controle: async (d, p) => {
      const r = await rangee<{ tout: bigint; repris: bigint }>(d, Prisma.sql`
        SELECT count(*) AS tout, count(*) FILTER (WHERE starts_with(COALESCE(o."sourceReference", ''), 'ouvrage_osm:')) AS repris
          FROM ouvrages o WHERE o."deletedAt" IS NULL AND ${dans('o."regionId"', p)}`);
      return nombre(r?.tout) - nombre(r?.repris);
    },
  },
  {
    code: "ouvrages_mauvais_critique", libelle: "Ouvrages inventoriés en état mauvais ou critique", groupe: "reseau", unite: "nombre", regionalisable: true,
    perimetre: PERIMETRES.OUVRAGES_INVENTAIRE, source: SOURCES.ouvrages,
    calcul: (d, p) => compte(d, Prisma.sql`SELECT count(*)::int AS v FROM ouvrages o WHERE o."deletedAt" IS NULL AND (o."sourceReference" IS NULL OR o."sourceReference" NOT LIKE 'ouvrage_osm:%') AND o.etat::text IN ('MAUVAIS', 'CRITIQUE') AND ${dans('o."regionId"', p)}`),
    controle: async (d, p) => {
      const lignes = await d.$queryRaw<{ etat: string; n: bigint }[]>`
        SELECT o.etat::text AS etat, count(*) AS n FROM ouvrages o
         WHERE o."deletedAt" IS NULL AND NOT starts_with(COALESCE(o."sourceReference", ''), 'ouvrage_osm:') AND ${dans('o."regionId"', p)}
         GROUP BY o.etat`;
      return lignes.filter((l) => l.etat === "MAUVAIS" || l.etat === "CRITIQUE").reduce((s, l) => s + nombre(l.n), 0);
    },
  },
  {
    code: "points_noirs", libelle: "Points noirs", groupe: "reseau", unite: "nombre", regionalisable: true,
    perimetre: PERIMETRES.POINTS_NOIRS_REGISTRE, source: SOURCES.pointsNoirs,
    calcul: (d, p) => compte(d, Prisma.sql`SELECT count(*)::int AS v FROM points_noirs x WHERE x."deletedAt" IS NULL AND ${dans('x."regionId"', p)}`),
    controle: async (d, p) => (await d.$queryRaw<{ id: string }[]>`SELECT x.id FROM points_noirs x WHERE x."deletedAt" IS NULL AND ${dans('x."regionId"', p)}`).length,
  },
  {
    code: "postes", libelle: "Péages et pesages", groupe: "reseau", unite: "nombre", regionalisable: true,
    perimetre: PERIMETRES.POSTES_REGISTRE, source: SOURCES.postes,
    calcul: (d, p) => compte(d, Prisma.sql`SELECT count(*)::int AS v FROM postes x WHERE x."deletedAt" IS NULL AND ${dans('x."regionId"', p)}`),
    controle: async (d, p) => (await d.$queryRaw<{ id: string }[]>`SELECT x.id FROM postes x WHERE x."deletedAt" IS NULL AND ${dans('x."regionId"', p)}`).length,
  },
  {
    // Un document se rattache a un troncon (facultatif), pas a une region : il n'a pas de ventilation regionale.
    code: "documents", libelle: "Documents", groupe: "reseau", unite: "nombre", regionalisable: false,
    perimetre: PERIMETRES.DOCUMENTS_REGISTRE, source: SOURCES.documents,
    calcul: (d) => compte(d, Prisma.sql`SELECT count(*)::int AS v FROM documents x WHERE x."deletedAt" IS NULL`),
    controle: async (d) => (await d.$queryRaw<{ id: string }[]>`SELECT x.id FROM documents x WHERE x."deletedAt" IS NULL`).length,
  },
  {
    code: "chantiers_en_cours", libelle: "Chantiers en cours", groupe: "reseau", unite: "nombre", regionalisable: true,
    perimetre: PERIMETRES.CHANTIERS_REGISTRE, source: SOURCES.chantiers,
    calcul: (d, p) => compte(d, Prisma.sql`SELECT count(*)::int AS v FROM chantiers c WHERE c."deletedAt" IS NULL AND c.statut::text = 'EN_COURS' AND ${dans('c."regionId"', p)}`),
    controle: async (d, p) => {
      const lignes = await d.$queryRaw<{ statut: string; n: bigint }[]>`
        SELECT c.statut::text AS statut, count(*) AS n FROM chantiers c WHERE c."deletedAt" IS NULL AND ${dans('c."regionId"', p)} GROUP BY c.statut`;
      return nombre(lignes.find((l) => l.statut === "EN_COURS")?.n);
    },
  },
];

// ===================================================================================== portions et qualite

/** Les portions courantes d'un perimetre, lues une a une : le controle de la couverture et des chevauchements. */
interface LignePortion { id: string; tronconId: string; debutM: number; finM: number; longueurM: number | null }

const portionsDuReseauClasse = (depot: Depot, p: Portee) => depot.$queryRaw<LignePortion[]>`
  SELECT po.id, po."tronconId", po."debutM", po."finM", ST_Length(t.geom::geography) AS "longueurM"
    FROM portions po JOIN troncons t ON t.id = po."tronconId"
   WHERE po."deletedAt" IS NULL AND po."remplaceeLe" IS NULL AND t.geom IS NOT NULL
     AND t."deletedAt" IS NULL ${classeControle()} AND ${dans('t."regionId"', p)}`;

/** Part couverte, par balayage des intervalles de chaque troncon : l'autre chemin que la requete de fusion SQL. */
export function couvertureParBalayage(
  troncons: ReadonlyMap<string, number>,
  portions: readonly { tronconId: string; debutM: number; finM: number }[],
): { longueurM: number; qualifieM: number } {
  const parTroncon = new Map<string, { d: number; f: number }[]>();
  for (const po of portions) {
    const longueur = troncons.get(po.tronconId);
    if (longueur === undefined) continue;
    const d = Math.max(po.debutM, 0), f = Math.min(po.finM, longueur);
    if (f > d) (parTroncon.get(po.tronconId) ?? parTroncon.set(po.tronconId, []).get(po.tronconId)!).push({ d, f });
  }
  let qualifieM = 0;
  for (const intervalles of parTroncon.values()) {
    intervalles.sort((a, b) => a.d - b.d || a.f - b.f);
    let [debut, fin] = [intervalles[0].d, intervalles[0].f];
    for (const iv of intervalles.slice(1)) {
      if (iv.d > fin + TOLERANCE_M) { qualifieM += fin - debut; [debut, fin] = [iv.d, iv.f]; } else fin = Math.max(fin, iv.f);
    }
    qualifieM += fin - debut;
  }
  return { longueurM: [...troncons.values()].reduce((s, v) => s + v, 0), qualifieM };
}

const portions: Definition[] = [
  {
    code: "portions_validees", libelle: "Portions validées (état constaté)", groupe: "portions", unite: "nombre", regionalisable: true,
    perimetre: PERIMETRES.PORTIONS_VALIDEES, source: SOURCES.portions,
    calcul: (d, p) => compte(d, Prisma.sql`SELECT count(*)::int AS v FROM portions po JOIN troncons t ON t.id = po."tronconId"
      WHERE po."statutValidation"::text = 'VALIDE' AND po."remplaceeLe" IS NULL AND po."deletedAt" IS NULL AND ${dans('t."regionId"', p)}`),
    controle: async (d, p) => {
      const lignes = await d.$queryRaw<{ statut: string; n: bigint }[]>`
        SELECT po."statutValidation"::text AS statut, count(*) AS n FROM portions po JOIN troncons t ON t.id = po."tronconId"
         WHERE po."remplaceeLe" IS NULL AND po."deletedAt" IS NULL AND ${dans('t."regionId"', p)} GROUP BY po."statutValidation"`;
      return nombre(lignes.find((l) => l.statut === "VALIDE")?.n);
    },
  },
  {
    code: "portions_validees_km", libelle: "Kilomètres d'état constaté (portions validées)", groupe: "portions", unite: "km", regionalisable: true,
    perimetre: PERIMETRES.PORTIONS_VALIDEES, source: SOURCES.portions,
    calcul: async (d, p) => arrondi(nombre((await rangee<{ v: number | null }>(d, Prisma.sql`
      SELECT COALESCE(SUM(po."finM" - po."debutM"), 0) / 1000.0 AS v FROM portions po JOIN troncons t ON t.id = po."tronconId"
       WHERE po."statutValidation"::text = 'VALIDE' AND po."remplaceeLe" IS NULL AND po."deletedAt" IS NULL AND ${dans('t."regionId"', p)}`))?.v), 1),
    // Autre chemin : les bornes sommees separement, la difference faite a la fin.
    controle: async (d, p) => {
      const r = await rangee<{ fins: number | null; debuts: number | null }>(d, Prisma.sql`
        SELECT SUM(po."finM") AS fins, SUM(po."debutM") AS debuts FROM portions po JOIN troncons t ON t.id = po."tronconId"
         WHERE po."statutValidation"::text = 'VALIDE' AND po."remplaceeLe" IS NULL AND po."deletedAt" IS NULL AND ${dans('t."regionId"', p)}`);
      return arrondi((nombre(r?.fins) - nombre(r?.debuts)) / 1000, 1);
    },
  },
  {
    code: "couverture_qualifiee_part", libelle: "Part du réseau classé couverte par au moins une portion", groupe: "portions", unite: "part", regionalisable: true,
    perimetre: PERIMETRES.RESEAU_CLASSE_SAISI, source: SOURCES.troncons,
    // Le module de couverture du reseau (fusion SQL des recouvrements), restreint aux regions en portee.
    calcul: async (d, p) => {
      const c = await couvertureReseau("reference", null, d);
      const lignes = p.regions === null ? c.parRegion : c.parRegion.filter((l) => l.regionId !== null && p.regions!.includes(l.regionId));
      return cumuler(lignes).part;
    },
    controle: async (d, p) => {
      const tronc = await d.$queryRaw<{ id: string; metres: number | null }[]>`
        SELECT t.id, ST_Length(t.geom::geography) AS metres FROM troncons t
         WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL ${classeControle()} AND ${dans('t."regionId"', p)}`;
      const longueurs = new Map(tronc.map((t) => [t.id, nombre(t.metres)]));
      const { longueurM, qualifieM } = couvertureParBalayage(longueurs, await portionsDuReseauClasse(d, p));
      return longueurM > 0 ? Math.round((qualifieM / longueurM) * 10000) / 10000 : null;
    },
  },
  {
    code: "portions_chevauchantes", libelle: "Paires de portions courantes qui se chevauchent", groupe: "qualite", unite: "nombre", regionalisable: true,
    perimetre: PERIMETRES.PORTIONS_COURANTES, source: SOURCES.portions,
    // Auto-jointure : deux portions courantes du meme troncon dont les metres communs depassent la tolerance de jointure.
    calcul: (d, p) => compte(d, Prisma.sql`
      SELECT count(*)::int AS v
        FROM portions a JOIN portions b ON b."tronconId" = a."tronconId" AND b.id > a.id
        JOIN troncons t ON t.id = a."tronconId"
       WHERE a."remplaceeLe" IS NULL AND a."deletedAt" IS NULL AND b."remplaceeLe" IS NULL AND b."deletedAt" IS NULL
         AND least(a."finM", b."finM") - greatest(a."debutM", b."debutM") > ${TOLERANCE_M}
         AND ${dans('t."regionId"', p)}`),
    // Autre chemin : la fonction de domaine `chevauchements()`, celle de la fiche 360, sur les portions lues.
    controle: async (d, p) => {
      const lignes = await d.$queryRaw<{ id: string; tronconId: string; debutM: number; finM: number }[]>`
        SELECT po.id, po."tronconId", po."debutM", po."finM" FROM portions po JOIN troncons t ON t.id = po."tronconId"
         WHERE po."remplaceeLe" IS NULL AND po."deletedAt" IS NULL AND ${dans('t."regionId"', p)}`;
      const parTroncon = new Map<string, Portion[]>();
      for (const l of lignes) {
        const liste = parTroncon.get(l.tronconId) ?? [];
        liste.push({ id: l.id, tronconId: l.tronconId, debutM: l.debutM, finM: l.finM, remplaceeLe: null, deletedAt: null } as Portion);
        parTroncon.set(l.tronconId, liste);
      }
      let total = 0;
      for (const liste of parTroncon.values()) total += chevauchements(liste).length;
      return total;
    },
  },
  {
    code: "troncons_geometrie_invalide", libelle: "Tronçons classés à géométrie invalide", groupe: "qualite", unite: "nombre", regionalisable: true,
    perimetre: PERIMETRES.RESEAU_CLASSE_SAISI, source: SOURCES.troncons,
    calcul: (d, p) => compte(d, Prisma.sql`SELECT count(*)::int AS v FROM troncons t
      WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL AND NOT ST_IsValid(t.geom) ${classeCalcul()} AND ${dans('t."regionId"', p)}`),
    controle: async (d, p) => (await d.$queryRaw<{ raison: string }[]>`
      SELECT ST_IsValidReason(t.geom) AS raison FROM troncons t
       WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL ${classeControle()} AND ${dans('t."regionId"', p)}`)
      .filter((l) => l.raison !== "Valid Geometry").length,
  },
  {
    // Les valeurs de qualite se rattachent a un nom de modele et un identifiant : pas de ventilation regionale directe.
    code: "valeurs_qualifiees", libelle: "Valeurs qualifiées", groupe: "qualite", unite: "nombre", regionalisable: false,
    perimetre: PERIMETRES.VALEURS_QUALIFIEES, source: SOURCES.valeursQualite,
    calcul: (d) => compte(d, Prisma.sql`SELECT count(*)::int AS v FROM valeurs_qualite`),
    controle: async (d) => (await d.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM valeurs_qualite GROUP BY statut`).reduce((s, l) => s + nombre(l.n), 0),
  },
  {
    code: "valeurs_observees", libelle: "Valeurs observées sur le terrain", groupe: "qualite", unite: "nombre", regionalisable: false,
    perimetre: PERIMETRES.VALEURS_QUALIFIEES, source: SOURCES.valeursQualite,
    calcul: (d) => compte(d, Prisma.sql`SELECT count(*)::int AS v FROM valeurs_qualite WHERE statut::text = 'OBSERVED'`),
    controle: async (d) => nombre((await d.$queryRaw<{ statut: string; n: bigint }[]>`SELECT statut::text AS statut, count(*) AS n FROM valeurs_qualite GROUP BY statut`).find((l) => l.statut === "OBSERVED")?.n),
  },
];

// ===================================================================================== exploitation (Control Tower)

/** Les evenements non clos, reconstruits depuis le JOURNAL (main_courante) et non depuis la vue : l'autre chemin. */
const actifsDuJournal = (p: Portee): Prisma.Sql => Prisma.sql`
  actifs AS (
    SELECT dc."evenementId", dc."tronconId"
      FROM main_courante dc
      JOIN (SELECT DISTINCT ON (m."evenementId") m."evenementId", m.statut::text AS statut
              FROM main_courante m WHERE m.nature::text IN ('DECLARATION', 'STATUT')
             ORDER BY m."evenementId", m.rang DESC) dernier ON dernier."evenementId" = dc."evenementId"
      LEFT JOIN troncons t ON t.id = dc."tronconId"
     WHERE dc.nature::text = 'DECLARATION' AND dernier.statut <> 'CLOS' AND ${dans('t."regionId"', p)}
  )`;

const veille: Definition[] = [
  {
    code: "evenements_actifs", libelle: "Événements actifs de la main courante", groupe: "veille", unite: "nombre", regionalisable: true,
    perimetre: PERIMETRES.MAIN_COURANTE_ACTIFS, source: SOURCES.mainCourante,
    calcul: (d, p) => compte(d, Prisma.sql`SELECT count(*)::int AS v FROM evenements_exploitation e LEFT JOIN troncons t ON t.id = e."tronconId"
      WHERE e.statut::text <> 'CLOS' AND ${dans('t."regionId"', p)}`),
    controle: (d, p) => compte(d, Prisma.sql`WITH ${actifsDuJournal(p)} SELECT count(*)::int AS v FROM actifs`),
  },
  {
    code: "evenements_non_pris_en_compte", libelle: "Événements ouverts, non pris en compte", groupe: "veille", unite: "nombre", regionalisable: true,
    perimetre: PERIMETRES.MAIN_COURANTE_ACTIFS, source: SOURCES.mainCourante,
    calcul: (d, p) => compte(d, Prisma.sql`SELECT count(*)::int AS v FROM evenements_exploitation e LEFT JOIN troncons t ON t.id = e."tronconId"
      WHERE e.statut::text = 'OUVERT' AND ${dans('t."regionId"', p)}`),
    controle: (d, p) => compte(d, Prisma.sql`
      WITH ${actifsDuJournal(p)}
      SELECT count(*)::int AS v FROM actifs a
       WHERE (SELECT m.statut::text FROM main_courante m WHERE m."evenementId" = a."evenementId" AND m.nature::text IN ('DECLARATION', 'STATUT')
               ORDER BY m.rang DESC LIMIT 1) = 'OUVERT'`),
  },
  {
    code: "evenements_escalades", libelle: "Événements actifs escaladés", groupe: "veille", unite: "nombre", regionalisable: true,
    perimetre: PERIMETRES.MAIN_COURANTE_ACTIFS, source: SOURCES.mainCourante,
    calcul: (d, p) => compte(d, Prisma.sql`SELECT count(*)::int AS v FROM evenements_exploitation e LEFT JOIN troncons t ON t.id = e."tronconId"
      WHERE e.statut::text <> 'CLOS' AND EXISTS (SELECT 1 FROM escalades es WHERE es."evenementId" = e."evenementId") AND ${dans('t."regionId"', p)}`),
    controle: (d, p) => compte(d, Prisma.sql`WITH ${actifsDuJournal(p)}
      SELECT count(DISTINCT es."evenementId")::int AS v FROM escalades es JOIN actifs a ON a."evenementId" = es."evenementId"`),
  },
  {
    code: "trous_de_permanence", libelle: "Événements escaladés sans personne d'astreinte", groupe: "veille", unite: "nombre", regionalisable: true,
    perimetre: PERIMETRES.MAIN_COURANTE_ACTIFS, source: SOURCES.mainCourante,
    // Le dernier niveau d'escalade de l'evenement n'a pas de destinataire : un trou de permanence, montre tel quel par la vue murale.
    calcul: (d, p) => compte(d, Prisma.sql`SELECT count(*)::int AS v FROM evenements_exploitation e LEFT JOIN troncons t ON t.id = e."tronconId"
      JOIN LATERAL (SELECT es."destinataireId" FROM escalades es WHERE es."evenementId" = e."evenementId" ORDER BY es.niveau DESC LIMIT 1) h ON true
      WHERE e.statut::text <> 'CLOS' AND h."destinataireId" IS NULL AND ${dans('t."regionId"', p)}`),
    controle: (d, p) => compte(d, Prisma.sql`WITH ${actifsDuJournal(p)}
      SELECT count(*)::int AS v FROM escalades es JOIN actifs a ON a."evenementId" = es."evenementId"
       WHERE es."destinataireId" IS NULL
         AND NOT EXISTS (SELECT 1 FROM escalades h WHERE h."evenementId" = es."evenementId" AND h.niveau > es.niveau)`),
  },
  {
    // Une regle n'a pas de region : sans regle, rien ne monte, pour tout le pays.
    code: "regles_escalade_actives", libelle: "Règles d'escalade actives", groupe: "veille", unite: "nombre", regionalisable: false,
    perimetre: PERIMETRES.ESCALADE_REGLES, source: SOURCES.reglesEscalade,
    calcul: (d) => compte(d, Prisma.sql`SELECT count(*)::int AS v FROM regles_escalade WHERE actif`),
    controle: async (d) => nombre((await d.$queryRaw<{ actif: boolean; n: bigint }[]>`SELECT actif, count(*) AS n FROM regles_escalade GROUP BY actif`).find((l) => l.actif)?.n),
  },
];

// ===================================================================================== patrouilles

const patrouilles: Definition[] = [
  {
    code: "programmes_patrouille_actifs", libelle: "Programmes de patrouille actifs", groupe: "patrouilles", unite: "nombre", regionalisable: true,
    perimetre: PERIMETRES.PROGRAMMES_PATROUILLE, source: SOURCES.programmesPatrouille,
    calcul: (d, p) => compte(d, Prisma.sql`SELECT count(*)::int AS v FROM programmes_patrouille pp WHERE pp."deletedAt" IS NULL AND pp.actif AND ${dans('pp."regionId"', p)}`),
    controle: async (d, p) => nombre((await d.$queryRaw<{ actif: boolean; n: bigint }[]>`
      SELECT pp.actif, count(*) AS n FROM programmes_patrouille pp WHERE pp."deletedAt" IS NULL AND ${dans('pp."regionId"', p)} GROUP BY pp.actif`).find((l) => l.actif)?.n),
  },
  {
    code: "patrouilles_en_retard", libelle: "Patrouilles en retard", groupe: "patrouilles", unite: "nombre", regionalisable: true,
    perimetre: PERIMETRES.PROGRAMMES_PATROUILLE, source: SOURCES.programmesPatrouille,
    // Le noyau d'echeance (patrouilles.noyau.ts), applique au dernier passage realise de chaque programme.
    calcul: async (d, p) => (await listerProgrammes(d, p.maintenant))
      .filter((pr) => pr.echeance.statut === "EN_RETARD" && (p.regions === null || (pr.regionId !== null && p.regions.includes(pr.regionId)))).length,
    // Autre chemin : l'echeance recalculee en SQL (dernier passage + periodicite, plancher au debut de la saison en cours).
    controle: (d, p) => compte(d, Prisma.sql`
      WITH ctx AS (SELECT (${instant(p)})::date AS jour),
      prog AS (
        SELECT pp.id, pp."periodiciteJours" AS per, pp."moisActifs" AS mois
          FROM programmes_patrouille pp WHERE pp."deletedAt" IS NULL AND pp.actif AND ${dans('pp."regionId"', p)}
      ),
      dernier AS (
        SELECT m."programmeId" AS id, max(m."finReelle"::date) AS jour
          FROM missions m
         WHERE m."deletedAt" IS NULL AND m."finReelle" IS NOT NULL AND m."programmeId" IS NOT NULL
           AND m.statut::text IN ('TERMINEE', 'SYNC_EN_ATTENTE')
         GROUP BY m."programmeId"
      ),
      saison AS (
        SELECT pr.id, pr.per, pr.mois, dn.jour AS dernier,
               -- Nombre de mois actifs contigus qui precedent le mois courant (null si les douze sont actifs).
               (SELECT min(g) - 1 FROM generate_series(1, 12) g
                 WHERE NOT (extract(month FROM (date_trunc('month', ctx.jour) - g * interval '1 month'))::int = ANY(pr.mois))) AS k,
               ctx.jour AS aujourdhui
          FROM prog pr CROSS JOIN ctx LEFT JOIN dernier dn ON dn.id = pr.id
         WHERE cardinality(pr.mois) = 0 OR extract(month FROM ctx.jour)::int = ANY(pr.mois)
      )
      SELECT count(*)::int AS v FROM saison s
       WHERE s.dernier IS NOT NULL
         AND s.aujourdhui > greatest(
               s.dernier + s.per,
               CASE WHEN cardinality(s.mois) > 0 AND s.k IS NOT NULL
                    THEN (date_trunc('month', s.aujourdhui) - s.k * interval '1 month')::date
                    ELSE s.dernier + s.per END)`),
  },
];

// ===================================================================================== teledetection

const teledetection: Definition[] = [
  {
    code: "propositions_a_verifier", libelle: "Propositions de télédétection en attente de verdict", groupe: "teledetection", unite: "nombre", regionalisable: true,
    perimetre: PERIMETRES.PROPOSITIONS_TELEDETECTION, source: SOURCES.propositions,
    calcul: (d, p) => compte(d, Prisma.sql`SELECT count(*)::int AS v FROM propositions_teledetection pt LEFT JOIN troncons t ON t.id = pt."tronconId"
      WHERE pt.statut IN ('A_VERIFIER', 'EN_ATTENTE', 'NON_CONCLUANTE') AND NOT pt.synthetique AND ${dans('t."regionId"', p)}`),
    // Autre chemin : toutes les propositions reelles, moins celles qui ont recu un verdict (EO-API : une proposition en attente ou non
    // concluante attend aussi son verdict ; une donnee synthetique n'entre jamais dans un compteur de production).
    controle: async (d, p) => {
      const r = await rangee<{ tout: bigint; jugees: bigint }>(d, Prisma.sql`
        SELECT count(*) AS tout, count(*) FILTER (WHERE pt.statut IN ('CONFIRMEE', 'INFIRMEE')) AS jugees
          FROM propositions_teledetection pt LEFT JOIN troncons t ON t.id = pt."tronconId" WHERE NOT pt.synthetique AND ${dans('t."regionId"', p)}`);
      return nombre(r?.tout) - nombre(r?.jugees);
    },
  },
];

// ===================================================================================== programmation et budget

interface LignePrevision { statut: string; montant: string }
const previsionsDuPerimetre = (depot: Depot, p: Portee) => depot.$queryRaw<LignePrevision[]>`
  SELECT pb.statut, pb."montantPrevuGnf"::text AS montant FROM programmes_budgetaires pb LEFT JOIN troncons t ON t.id = pb."tronconId"
   WHERE pb."deletedAt" IS NULL AND ${dans('t."regionId"', p)}`;
const sommeGnf = (lignes: readonly { montant: string }[]): string => lignes.reduce((s, l) => s + BigInt(l.montant), 0n).toString();

const previsionsCalculNb = (statut: string) => (d: Depot, p: Portee) => compte(d, Prisma.sql`
  SELECT count(*)::int AS v FROM programmes_budgetaires pb LEFT JOIN troncons t ON t.id = pb."tronconId"
   WHERE pb."deletedAt" IS NULL AND pb.statut = ${statut} AND ${dans('t."regionId"', p)}`);
const previsionsCalculGnf = (statut: string) => (d: Depot, p: Portee) => texteGnf(d, Prisma.sql`
  SELECT COALESCE(SUM(pb."montantPrevuGnf"), 0)::text AS v FROM programmes_budgetaires pb LEFT JOIN troncons t ON t.id = pb."tronconId"
   WHERE pb."deletedAt" IS NULL AND pb.statut = ${statut} AND ${dans('t."regionId"', p)}`);

const programmation: Definition[] = [
  {
    code: "previsions_retenues_nb", libelle: "Prévisions retenues au programme", groupe: "programmation", unite: "nombre", regionalisable: true,
    perimetre: PERIMETRES.PREVISIONS_BUDGETAIRES, source: SOURCES.previsions,
    calcul: previsionsCalculNb("RETENU"),
    controle: async (d, p) => (await previsionsDuPerimetre(d, p)).filter((l) => l.statut === "RETENU").length,
  },
  {
    code: "previsions_retenues_gnf", libelle: "Montant des prévisions retenues (GNF)", groupe: "programmation", unite: "GNF", regionalisable: true,
    perimetre: PERIMETRES.PREVISIONS_BUDGETAIRES, source: SOURCES.previsions,
    calcul: previsionsCalculGnf("RETENU"),
    controle: async (d, p) => sommeGnf((await previsionsDuPerimetre(d, p)).filter((l) => l.statut === "RETENU")),
  },
  {
    code: "previsions_realisees_nb", libelle: "Prévisions réalisées", groupe: "programmation", unite: "nombre", regionalisable: true,
    perimetre: PERIMETRES.PREVISIONS_BUDGETAIRES, source: SOURCES.previsions,
    calcul: previsionsCalculNb("REALISE"),
    controle: async (d, p) => (await previsionsDuPerimetre(d, p)).filter((l) => l.statut === "REALISE").length,
  },
  {
    code: "previsions_realisees_gnf", libelle: "Montant des prévisions réalisées (GNF)", groupe: "programmation", unite: "GNF", regionalisable: true,
    perimetre: PERIMETRES.PREVISIONS_BUDGETAIRES, source: SOURCES.previsions,
    calcul: previsionsCalculGnf("REALISE"),
    controle: async (d, p) => sommeGnf((await previsionsDuPerimetre(d, p)).filter((l) => l.statut === "REALISE")),
  },
  {
    code: "chantiers_en_retard", libelle: "Chantiers en cours au-delà de leur date de fin prévue", groupe: "programmation", unite: "nombre", regionalisable: true,
    perimetre: PERIMETRES.CHANTIERS_REGISTRE, source: SOURCES.chantiers,
    calcul: (d, p) => compte(d, Prisma.sql`SELECT count(*)::int AS v FROM chantiers c
      WHERE c."deletedAt" IS NULL AND c.statut::text = 'EN_COURS' AND c."dateFinPrevue" < ${instant(p)} AND ${dans('c."regionId"', p)}`),
    controle: async (d, p) => {
      const lignes = await d.$queryRaw<{ fin: Date | null }[]>`
        SELECT c."dateFinPrevue" AS fin FROM chantiers c
         WHERE c."deletedAt" IS NULL AND c.statut::text = 'EN_COURS' AND ${dans('c."regionId"', p)}`;
      return lignes.filter((l) => l.fin !== null && new Date(l.fin).getTime() < p.maintenant.getTime()).length;
    },
  },
  {
    code: "chantiers_montant_gnf", libelle: "Montant de marché des chantiers (GNF)", groupe: "programmation", unite: "GNF", regionalisable: true,
    perimetre: PERIMETRES.CHANTIERS_REGISTRE, source: SOURCES.chantiers,
    calcul: (d, p) => texteGnf(d, Prisma.sql`SELECT COALESCE(SUM(c."montantGnf"), 0)::text AS v FROM chantiers c WHERE c."deletedAt" IS NULL AND ${dans('c."regionId"', p)}`),
    controle: async (d, p) => sommeGnf((await d.$queryRaw<{ montant: string }[]>`
      SELECT c."montantGnf"::text AS montant FROM chantiers c WHERE c."deletedAt" IS NULL AND c."montantGnf" IS NOT NULL AND ${dans('c."regionId"', p)}`)),
  },
];

/** Le registre, dans l'ordre d'affichage. Un indicateur ajoute ici doit declarer son perimetre et son controle (garde par un test). */
export const REGISTRE: readonly Definition[] = [...reseau, ...portions, ...veille, ...patrouilles, ...teledetection, ...programmation];

export type { Valeur };
