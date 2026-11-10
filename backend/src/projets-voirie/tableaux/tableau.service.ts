/**
 * TABLEAUX DE BORD NATIONAL ET PAR TERRITOIRE (lot X1 ; contrat docs/projets-voirie/CONTRAT-EXPORTS.md, section 6). AGREGATS SEULEMENT : aucune geometrie,
 * aucun nom d'objet, de fichier, de concessionnaire ni de document.
 *
 * PERIMETRE : projets non retires des regions du compte (national : tous) ; pour un territoire, ceux du territoire et de ses descendants (prefixe du chemin
 * materialise). LISIBILITE : un compte qui ne decide pas ne compte que les jeux AUTORISE, les dossiers dont chaque jeu lie est AUTORISE (reseau, plan
 * d'axes, jeu B d'une comparaison), et ne recoit ni pieces en cours ni referents (requetes non executees).
 * PROTECTIONS : une transaction READ ONLY, budget cote base partage par toutes les requetes (delai de la carte), limiteur (4), cadence par compte.
 * Ne reutilise pas la requete de GET /territoires/comptes (revue T1+S1, m1 : ni delai ni cadence, sous-requetes correlees) : agregation par projet, puis
 * regroupement en une passe (GROUPING SETS). SQL a valeurs liees seulement.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { Budget, estDelaiDepasse } from "../bd";
import { delaiCarteMs, delaiVerrouMs } from "../config";
import { estDecideur } from "../conflits/types.noyau";
import { STATUTS_PIECE_MANQUANTE } from "../documents/completude.noyau";
import { ErreurMetier, introuvable } from "../erreurs";
import type { Acteur, Portee } from "../projets.service";
import { ancetresDe } from "../territoires/territoires.service";
import { CadenceMemoire } from "../exports/cadence.noyau";
import { tableauCadenceFenetreS, tableauCadenceMax } from "../exports/config";
import { limiteurTableaux, sousLimiteur } from "../exports/limiteurs";
import { CLE_NON_VENTILES, CLE_TOTAL, agregatVide, ranger, type Agregat, type LignesTableau } from "./tableau.noyau";

export const ENFANTS_MAX = 500;
const cadence = new CadenceMemoire();
/** Tests : remet la cadence en memoire a zero. */
export const _viderCadenceTableaux = () => cadence.vider();

const tropLong = () => new ErreurMetier(504, "TABLEAU_DE_BORD_TROP_LONG", "Le calcul du tableau de bord a dépassé le délai : réessayez dans quelques instants.");

interface Regroupement { national: boolean; regions: number[]; prefixe: string | null; enfants: string[] | null }

/** Projets du perimetre, avec leur cle de regroupement : region (national) ou enfant du territoire (vide : rattache directement ; `~` : non ventile). */
function projetsDuPerimetre(r: Regroupement): Prisma.Sql {
  const cle = r.prefixe === null
    ? Prisma.sql`coalesce(pr."regionId"::text, '')`
    : Prisma.sql`CASE WHEN split_part(substr(t."chemin", ${r.prefixe.length + 1}::int), '/', 1) = '' THEN ''
                      WHEN split_part(substr(t."chemin", ${r.prefixe.length + 1}::int), '/', 1) = ANY(${r.enfants ?? []}::text[]) THEN split_part(substr(t."chemin", ${r.prefixe.length + 1}::int), '/', 1)
                      ELSE ${CLE_NON_VENTILES} END`;
  return Prisma.sql`
    SELECT pr."id", ${cle} AS "cle"
      FROM "projets_voirie" pr LEFT JOIN "territoires_voirie" t ON t."id" = pr."territoireId"
     WHERE pr."deletedAt" IS NULL AND (${r.national} OR pr."regionId" = ANY(${r.regions}::int[]))
       AND (${r.prefixe}::text IS NULL OR starts_with(t."chemin", ${r.prefixe}::text))`;
}

async function agreger(r: Regroupement, decideur: boolean): Promise<Map<string, Agregat>> {
  const delai = delaiCarteMs();
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const b = new Budget(tx, delai, delaiVerrouMs(), tropLong);
      const p = projetsDuPerimetre(r);
      const lignes: LignesTableau = {
        projets: await b.etape(() => tx.$queryRaw`WITH p AS (${p})
          SELECT p."cle", GROUPING(p."cle")::int AS "g", count(*)::int AS "n" FROM p GROUP BY GROUPING SETS ((p."cle"), ())`, "projets"),
        jeux: await b.etape(() => tx.$queryRaw`WITH p AS (${p})
          SELECT p."cle", GROUPING(p."cle")::int AS "g", j."statut"::text AS "s", count(*)::int AS "n"
            FROM p JOIN "projets_voirie_jeux" j ON j."projetId" = p."id"
           WHERE j."statut"::text <> 'RETIRE' AND (${decideur} OR j."statut"::text = 'AUTORISE')
           GROUP BY GROUPING SETS ((p."cle", j."statut"), (j."statut"))`, "jeux"),
        conflits: await b.etape(() => tx.$queryRaw`WITH p AS (${p})
          SELECT p."cle", GROUPING(p."cle")::int AS "g", c."statut"::text AS "s", count(*)::int AS "n"
            FROM p JOIN "conflits_projet" c ON c."projetId" = p."id"
            LEFT JOIN "projets_voirie_jeux" jr ON jr."id" = c."jeuReseauId"
            LEFT JOIN "projets_voirie_jeux" ja ON ja."id" = c."jeuAxesId"
            LEFT JOIN "comparaisons_sources_projet" cs ON cs."id" = c."comparaisonId"
            LEFT JOIN "projets_voirie_jeux" jb ON jb."id" = cs."jeuBId"
           WHERE ${decideur}
              OR ((c."jeuReseauId" IS NULL OR jr."statut"::text = 'AUTORISE') AND (c."jeuAxesId" IS NULL OR ja."statut"::text = 'AUTORISE')
                  AND (c."comparaisonId" IS NULL OR jb."statut"::text = 'AUTORISE'))
           GROUP BY GROUPING SETS ((p."cle", c."statut"), (c."statut"))`, "conflits"),
        types: await b.etape(() => tx.$queryRaw`WITH p AS (${p}), t AS (
            SELECT "code", "parametres"->>'roleJeu' AS "role" FROM "referentiels_voirie"
             WHERE "domaine"::text = 'TYPE_DOCUMENT' AND "deletedAt" IS NULL AND "actif" AND ("parametres"->>'obligatoire') = 'true')
          SELECT p."cle", GROUPING(p."cle")::int AS "g", count(*)::int AS "n", count(DISTINCT p."id")::int AS "projets"
            FROM p CROSS JOIN t
           WHERE NOT EXISTS (SELECT 1 FROM "projets_voirie_jeux" j WHERE j."projetId" = p."id" AND j."statut"::text = 'AUTORISE' AND t."role" IS NOT NULL AND j."role"::text = t."role")
             AND NOT EXISTS (SELECT 1 FROM "documents_projet_voirie" d WHERE d."projetId" = p."id" AND d."deletedAt" IS NULL AND d."statut"::text = 'VALIDE' AND d."typeCode" = t."code")
           GROUP BY GROUPING SETS ((p."cle"), ())`, "types obligatoires"),
        // Pieces en cours et referents : jamais calcules pour un compte qui ne decide pas (ni la valeur, ni son existence).
        pieces: decideur ? await b.etape(() => tx.$queryRaw`WITH p AS (${p}), der AS (
            SELECT DISTINCT ON (d."ligneeId") d."projetId", d."statut"::text AS "statut" FROM "documents_projet_voirie" d JOIN p ON p."id" = d."projetId"
             WHERE d."deletedAt" IS NULL ORDER BY d."ligneeId", d."version" DESC)
          SELECT p."cle", GROUPING(p."cle")::int AS "g", der."statut" AS "s", count(*)::int AS "n"
            FROM der JOIN p ON p."id" = der."projetId" WHERE der."statut" = ANY(${[...STATUTS_PIECE_MANQUANTE]}::text[])
           GROUP BY GROUPING SETS ((p."cle", der."statut"), (der."statut"))`, "pieces") : null,
        referents: decideur ? await b.etape(() => tx.$queryRaw`WITH p AS (${p})
          SELECT p."cle", GROUPING(p."cle")::int AS "g", count(*)::int AS "rattachements", count(DISTINCT r."userId")::int AS "comptes"
            FROM p JOIN "referents_concessionnaire" r ON r."projetId" = p."id" JOIN "users" u ON u."id" = r."userId"
           WHERE r."revoqueLe" IS NULL AND u."actif" GROUP BY GROUPING SETS ((p."cle"), ())`, "referents") : null,
      };
      return ranger(lignes, decideur);
    }, { timeout: delai + 5_000, maxWait: 10_000 });
  } catch (e) {
    if (e instanceof ErreurMetier) throw e;
    if (estDelaiDepasse(e)) throw tropLong();
    throw e;
  }
}

function lisibilite(decideur: boolean) {
  return {
    jeux: decideur ? "TOUS_SAUF_RETIRE" : "AUTORISE_SEULEMENT",
    conflits: decideur ? "TOUS" : "DOSSIERS_VISIBLES",
    documentsEnCours: decideur, referents: decideur,
  };
}

const REGLE = "Agregats seulement, sur les projets non retires du perimetre du compte. Un compte qui ne decide pas ne compte que les jeux AUTORISE et les dossiers de conflit dont chaque jeu lie est AUTORISE ; il ne recoit ni pieces en cours ni referents.";

/** Garde commune : cadence par compte (memoire du processus), puis limiteur. */
async function proteger<T>(acteur: Acteur, travail: () => Promise<T>): Promise<T> {
  const v = cadence.tenter(acteur.id, new Date(), tableauCadenceFenetreS(), tableauCadenceMax());
  if (!v.ok) throw new ErreurMetier(429, "TABLEAU_DE_BORD_TROP_FREQUENT", `Trop de tableaux de bord demandés : réessayez dans ${v.retryAfterS} s.`, { retryAfterS: v.retryAfterS });
  return sousLimiteur(limiteurTableaux, "Le service calcule déjà d'autres tableaux de bord : réessayez dans quelques instants.", travail);
}

const perimetre = (portee: Portee) => ({ national: portee === null, regions: portee === null ? null : [...portee] });

export async function tableauNational(acteur: Acteur, portee: Portee) {
  return proteger(acteur, async () => {
    const decideur = estDecideur(acteur.role);
    const m = await agreger({ national: portee === null, regions: portee === null ? [] : [...portee], prefixe: null, enfants: null }, decideur);
    const ids = [...m.keys()].filter((k) => k !== CLE_TOTAL && k !== "").map(Number).filter(Number.isInteger);
    const regions = ids.length ? await prisma.region.findMany({ where: { id: { in: ids } }, select: { id: true, nom: true } }) : [];
    const parRegion = [...m.entries()].filter(([k]) => k !== CLE_TOTAL).map(([k, a]) => ({
      regionId: k === "" ? null : Number(k), region: k === "" ? null : regions.find((r) => r.id === Number(k))?.nom ?? null, ...a,
    })).sort((a, b) => (a.region ?? "~").localeCompare(b.region ?? "~"));
    return {
      portee: "NATIONAL" as const, perimetre: perimetre(portee), lisibilite: lisibilite(decideur),
      total: m.get(CLE_TOTAL) ?? agregatVide(decideur), parRegion, tronque: false, calculeLe: new Date(), regle: REGLE,
    };
  });
}

export async function tableauTerritoire(acteur: Acteur, portee: Portee, territoireId: string) {
  return proteger(acteur, async () => {
    const decideur = estDecideur(acteur.role);
    const regions = portee === null ? [] : [...portee];
    const t = await prisma.territoireVoirie.findFirst({
      where: { id: territoireId, deletedAt: null, ...(portee === null ? {} : { regionEffectiveId: { in: regions } }) },
      select: { id: true, code: true, nom: true, niveau: true, chemin: true },
    });
    // Inexistant, retire ou hors perimetre : la meme reponse (la garde de la route l'a deja dit pour un compte regional ; ici pour un national).
    if (!t) throw introuvable("Territoire", "TERRITOIRE_INTROUVABLE");
    const enfantsLus = await prisma.territoireVoirie.findMany({
      where: { parentId: t.id, deletedAt: null, ...(portee === null ? {} : { regionEffectiveId: { in: regions } }) },
      select: { id: true, code: true, nom: true, niveau: true }, orderBy: [{ code: "asc" }], take: ENFANTS_MAX + 1,
    });
    const tronque = enfantsLus.length > ENFANTS_MAX;
    const enfants = enfantsLus.slice(0, ENFANTS_MAX);
    const [m, ancetres] = await Promise.all([
      agreger({ national: portee === null, regions, prefixe: t.chemin, enfants: enfants.map((e) => e.id) }, decideur),
      ancetresDe(prisma, t.chemin),
    ]);
    // Les ancetres hors perimetre (la nation pour un compte regional) ne sont pas nommes.
    const idsVisibles = portee === null ? null
      : new Set((await prisma.territoireVoirie.findMany({ where: { id: { in: ancetres.map((a) => a.id) }, regionEffectiveId: { in: regions } }, select: { id: true } })).map((x) => x.id));
    const vide = agregatVide(decideur);
    return {
      portee: "TERRITOIRE" as const,
      territoire: { id: t.id, code: t.code, nom: t.nom, niveau: t.niveau, ancetres: idsVisibles === null ? ancetres : ancetres.filter((a) => idsVisibles.has(a.id)) },
      perimetre: perimetre(portee), lisibilite: lisibilite(decideur),
      total: m.get(CLE_TOTAL) ?? vide,
      rattachesDirectement: m.get("") ?? agregatVide(decideur),
      enfants: enfants.map((e) => ({ territoireId: e.id, code: e.code, nom: e.nom, niveau: e.niveau, ...(m.get(e.id) ?? agregatVide(decideur)) })),
      nonVentiles: m.get(CLE_NON_VENTILES) ?? agregatVide(decideur),
      tronque, calculeLe: new Date(), regle: REGLE,
    };
  });
}
