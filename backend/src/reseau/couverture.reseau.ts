/**
 * Couverture de qualification a l'echelle du reseau.
 *
 * POURQUOI CE MODULE EXISTE, ET POURQUOI IL EST EN SQL
 *
 * `reseau/portions.ts` porte `couverture()`, qui calcule la part qualifiee d'UN troncon et
 * NOMME ses trous. C'est la bonne fonction pour une fiche. Elle ne l'est pas pour le reseau :
 * repondre « quelle part du reseau classe est qualifiee » en la rappelant 1 691 fois
 * demanderait de charger toutes les portions de tous les troncons en memoire, et la meme
 * question sur le registre complet en demanderait 261 387.
 *
 * L'agregation reste donc en base, et ce module ne rend que des TOTAUX. Les trous ne sont pas
 * enumeres ici : a l'echelle du reseau ils se comptent par milliers, et une liste de milliers
 * d'intervalles n'envoie personne nulle part — c'est l'inverse exact de ce que `couverture()`
 * cherche a obtenir sur un troncon.
 *
 * LE PERIMETRE N'EST PAS UN DETAIL, C'EST LE COEUR
 *
 * Une couverture « nationale » calculee sur les 261 387 troncons serait vide de sens : 99,4 %
 * d'entre eux sont de la voirie locale reprise d'OpenStreetMap, que `lib/reseau.ts` exclut
 * deja du reseau classe. Le reseau qui porte les statistiques officielles en compte 1 691,
 * pour 21 156,6 km.
 *
 * J'ai commis deux fois la faute inverse le 13/10 — annoncer 3,26 % puis 2,6 % en divisant par
 * le registre entier — avant de la corriger. Ce module prend donc le perimetre en parametre et
 * n'a pas de valeur par defaut implicite : l'appelant DIT de quel reseau il parle.
 *
 * LA LONGUEUR DE REFERENCE EST GEOMETRIQUE, PAS DECLAREE
 *
 * `ST_Length(geom::geography)` et non `longueurKm`. Les abscisses des portions sont definies
 * par construction comme `ST_LineLocatePoint x ST_Length(geom::geography)` : mesurer la
 * couverture contre la longueur declaree comparerait des metres a une autre echelle, et une
 * portion couvrant tout un troncon rendrait une part differente de 1.
 *
 * ETAT AU 14/10/2026 : `portions` porte ZERO ligne. Ce module rend donc une couverture nulle
 * partout, et c'est le resultat juste. Il existe pour que le premier releve se voie.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { fragmentPerimetre, type PerimetreReseau } from "../lib/reseau";

/** Tolerance de jointure entre deux portions, en metres. Voir `portions.ts`. */
const TOLERANCE_M = 0.05;

export interface CouvertureAgregee {
  troncons: number;
  /** Troncons portant au moins une portion courante. */
  tronconsQualifies: number;
  longueurTotaleM: number;
  qualifieM: number;
  /** Part de 0 a 1, ou null quand le perimetre est vide. */
  part: number | null;
}

export interface CouvertureRegion extends CouvertureAgregee {
  regionId: number | null;
  region: string | null;
}

export interface CouvertureReseau {
  perimetre: PerimetreReseau;
  total: CouvertureAgregee;
  parRegion: CouvertureRegion[];
  calculeeA: string;
}


interface LigneBrute {
  regionId: number | null;
  region: string | null;
  troncons: bigint;
  tronconsQualifies: bigint;
  longueurTotaleM: number | null;
  qualifieM: number | null;
}

/**
 * Part du reseau couverte par au moins une portion courante.
 *
 * LA FUSION DES RECOUVREMENTS EST LE CŒUR DE LA REQUETE
 *
 * Deux portions qui se chevauchent ne couvrent pas la somme de leurs longueurs. Sommer
 * naivement `finM - debutM` sur-compterait la zone commune et pourrait rendre une part
 * superieure a 1, ce qui serait pire qu'inexact : ce serait invraisemblable sans etre
 * visiblement faux.
 *
 * La fusion suit le motif « gaps and islands » : les portions d'un troncon sont ordonnees par
 * abscisse, et une nouvelle ile commence quand le debut depasse le maximum des fins
 * precedentes, a la tolerance pres. Chaque ile est ensuite reduite a son enveloppe.
 *
 * C'est la transposition exacte du balayage de `couverture()`, et la TOLERANCE_M y joue le
 * meme role : deux portions jointives a 3 cm pres forment une seule ile, sinon le reseau
 * afficherait des milliers de trous de quelques centimetres.
 *
 * `chevauchements()` reste la fonction qui SIGNALE les recouvrements. Celle-ci les absorbe
 * pour compter, sans jamais prétendre qu'ils n'existent pas.
 */
export async function couvertureReseau(
  perimetre: PerimetreReseau,
  regionId?: number | null,
  // Le depot par defaut est le client applicatif. Le registre d'indicateurs (tableau-de-bord/) passe
  // le sien, pour que le banc d'integration lise la base de rejeu et non une autre.
  depot: Pick<PrismaClient, "$queryRaw"> = prisma,
): Promise<CouvertureReseau> {
  // PARAMETRE, PAS CONCATENE. Le paragraphe 7.1 du mandat v2.1 l'exige : « requetes
  // spatiales en SQL parametre, jamais de concatenation de chaines ».
  //
  // La premiere version de ce module ecrivait `AND t."regionId" = ${regionId}` dans le texte
  // de la requete, via `$queryRawUnsafe`. La route valide bien `regionId` par un schema Zod,
  // mais la fonction est appelable d'ailleurs : la validation vivait au mauvais endroit.
  // `Prisma.sql` lie la valeur, donc la garantie ne depend plus de l'appelant.
  //
  // Le PERIMETRE, lui, est une structure et non une valeur : il vient d'un ensemble ferme de
  // trois fragments definis dans `lib/reseau.ts`, source unique du predicat.
  const filtreRegion = typeof regionId === "number"
    ? Prisma.sql`AND t."regionId" = ${regionId}`
    : Prisma.empty;

  const lignes = await depot.$queryRaw<LigneBrute[]>`
    WITH base AS (
      SELECT t.id, t."regionId", ST_Length(t.geom::geography) AS longueur_m
        FROM troncons t
       WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL
         ${fragmentPerimetre(perimetre, 't."sourceReference"')}
         ${filtreRegion}
    ), bornees AS (
      -- Les portions COURANTES, bornees au troncon. Une portion qui depasse la geometrie
      -- ne peut pas couvrir plus que celle-ci ; et remplaceeLe comme deletedAt sortent du
      -- calcul, exactement comme dans courantes(). Pas d'accent grave dans cette requete :
      -- elle vit dans un litteral gabarit, ou un accent grave la terminerait.
      SELECT po."tronconId",
             greatest(po."debutM", 0) AS d,
             least(po."finM", b.longueur_m) AS f
        FROM portions po
        JOIN base b ON b.id = po."tronconId"
       WHERE po."deletedAt" IS NULL AND po."remplaceeLe" IS NULL
         AND least(po."finM", b.longueur_m) > greatest(po."debutM", 0)
    ), avec_precedent AS (
      SELECT "tronconId", d, f,
             max(f) OVER (
               PARTITION BY "tronconId" ORDER BY d, f
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
             ) AS fin_max_precedente
        FROM bornees
    ), iles AS (
      SELECT "tronconId", d, f,
             sum(CASE WHEN fin_max_precedente IS NULL
                        OR d > fin_max_precedente + ${TOLERANCE_M}
                      THEN 1 ELSE 0 END)
               OVER (PARTITION BY "tronconId" ORDER BY d, f) AS ile
        FROM avec_precedent
    ), fusionnees AS (
      SELECT "tronconId", min(d) AS d, max(f) AS f
        FROM iles GROUP BY "tronconId", ile
    ), par_troncon AS (
      SELECT b.id, b."regionId", b.longueur_m,
             coalesce(sum(fu.f - fu.d), 0) AS qualifie_m
        FROM base b LEFT JOIN fusionnees fu ON fu."tronconId" = b.id
       GROUP BY b.id, b."regionId", b.longueur_m
    )
    SELECT pt."regionId",
           r.nom AS region,
           count(*) AS troncons,
           count(*) FILTER (WHERE pt.qualifie_m > 0) AS "tronconsQualifies",
           sum(pt.longueur_m) AS "longueurTotaleM",
           sum(pt.qualifie_m) AS "qualifieM"
      FROM par_troncon pt LEFT JOIN regions r ON r.id = pt."regionId"
     GROUP BY pt."regionId", r.nom
     ORDER BY sum(pt.longueur_m) DESC NULLS LAST
  `;

  const parRegion = lignes.map((l) => lire(l));
  return {
    perimetre,
    total: cumuler(parRegion),
    parRegion,
    calculeeA: new Date().toISOString(),
  };
}

function lire(l: LigneBrute): CouvertureRegion {
  const longueurTotaleM = arrondir(Number(l.longueurTotaleM ?? 0));
  const qualifieM = arrondir(Number(l.qualifieM ?? 0));
  return {
    regionId: l.regionId,
    region: l.region,
    troncons: Number(l.troncons),
    tronconsQualifies: Number(l.tronconsQualifies),
    longueurTotaleM,
    qualifieM,
    part: part(qualifieM, longueurTotaleM),
  };
}

/**
 * Cumul des regions.
 *
 * La part du total se RECALCULE sur les totaux, elle ne moyenne pas les parts regionales.
 * Moyenner donnerait le meme poids a Conakry, 0,6 km de regional, et a Kankan, 2 603 km :
 * une moyenne de pourcentages n'est pas un pourcentage.
 */
export function cumuler(lignes: readonly CouvertureRegion[]): CouvertureAgregee {
  const longueurTotaleM = arrondir(lignes.reduce((s, l) => s + l.longueurTotaleM, 0));
  const qualifieM = arrondir(lignes.reduce((s, l) => s + l.qualifieM, 0));
  return {
    troncons: lignes.reduce((s, l) => s + l.troncons, 0),
    tronconsQualifies: lignes.reduce((s, l) => s + l.tronconsQualifies, 0),
    longueurTotaleM,
    qualifieM,
    part: part(qualifieM, longueurTotaleM),
  };
}

/**
 * Part, ou `null` quand il n'y a rien a diviser.
 *
 * Rendre 0 pour un perimetre vide confondrait « rien n'est qualifie » avec « il n'y a rien a
 * qualifier ». Le premier est un constat sur le terrain, le second sur le filtre.
 */
export function part(qualifieM: number, longueurTotaleM: number): number | null {
  if (longueurTotaleM <= 0) return null;
  return Math.round((qualifieM / longueurTotaleM) * 10000) / 10000;
}

function arrondir(v: number): number {
  return Math.round(v * 100) / 100;
}
