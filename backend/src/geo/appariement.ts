import { prisma } from "../lib/prisma";
import { clauseSqlReseauClasse } from "../lib/reseau";

/**
 * Appariement d'une position GPS sur le reseau routier, et PK.
 *
 * CE QUE LA MESURE IMPOSE
 *
 * Trois constats du 07/10/2026 sur la production decident de la forme de ce moteur.
 * Aucun n'est une precaution de principe.
 *
 * 1. LE PERIMETRE DOIT ETRE BORNE. Apparier 200 points contre le reseau classe
 *    (1 691 traces) prend 19 ms par point. Contre les 261 387 troncons : 2,5 s par
 *    point, soit 133 fois plus. Un moteur qui interroge le reseau national a chaque
 *    seconde de trajet est inutilisable. D'ou `emprise`, qui restreint les candidats.
 *
 * 2. IL DOIT SAVOIR REFUSER DE CONCLURE. A 5 m d'erreur GPS, 199 appariements sur 200
 *    sont corrects. A 15 m, les nationales et regionales tiennent (97 % et 99 %) mais
 *    l'urbain s'effondre : 0 sur 6. En ville, une erreur de 15 m fait changer de rue.
 *    Rendre une rue fausse avec assurance est pire que ne rien rendre : l'observation
 *    serait rattachee au mauvais objet, et plus personne ne saurait que c'est faux.
 *
 * 3. LE PK N'EXISTE PAS PARTOUT. 551 des 1 691 troncons du reseau classe portent des
 *    PK exploitables, soit 33 %. Zero sur les 1 029 regionales. Le moteur rend donc
 *    `pk: null` sur deux tiers du reseau, et le dit, plutot que de deriver un
 *    kilometrage depuis la geometrie en le faisant passer pour un PK officiel.
 *
 * CE QUE LE REFUS RAPPORTE, MESURE
 *
 * Le moteur a ete confronte aux donnees reelles, 15 m de bruit GPS, contre un
 * appariement naif qui rend toujours le plus proche :
 *
 *     120 points sur nationales    naif 110 bons, 10 FAUX, 0 refus
 *                                  moteur 100 bons,  2 FAUX, 18 refus
 *
 *     41 points en urbain          naif   0 bons, 41 FAUX, 0 refus
 *                                  moteur  0 bons,  3 FAUX, 38 refus
 *
 * En urbain, l'appariement naif se trompe sur la TOTALITE des points et les livre
 * sans le moindre signal. Le moteur ramene l'erreur silencieuse de 41 a 3.
 *
 * Il ne recupere aucun point juste pour autant : a 15 m dans un reseau dense, la
 * bonne reponse n'est pas recuperable depuis un point isole. C'est precisement ce
 * qu'il faut dire, et c'est pourquoi l'appariement d'une TRACE — qui exploite la
 * continuite du trajet — est l'etape suivante.
 *
 * Sur nationales, le refus coute 10 appariements justes pour en eviter 8 faux. Le
 * compromis est assume : dans un registre patrimonial, une valeur fausse se propage
 * et personne ne sait plus qu'elle l'est, tandis qu'une valeur absente se voit.
 *
 * CE QU'IL NE FAIT PAS
 *
 * Il n'apparie pas une TRACE, il apparie un POINT. Un vrai map matching exploite la
 * continuite du trajet — un vehicule qui roule ne saute pas d'une rue a l'autre — et
 * leve ainsi une grande partie des ambiguites urbaines. C'est l'etape suivante, et
 * elle se construit sur celle-ci.
 */

/** Position telle que l'appareil la rend, incertitude comprise. */
export interface PositionGps {
  lat: number;
  lon: number;
  /** Incertitude annoncee par l'appareil, en metres. */
  precisionM?: number | null;
}

export interface Candidat {
  tronconId: string;
  code: string;
  nom: string | null;
  classe: string;
  /** Distance du point au trace, en metres. */
  distanceM: number;
  /** Position le long du trace, de 0 a 1 (ST_LineLocatePoint). */
  fraction: number;
  pkDebut: number | null;
  pkFin: number | null;
}

export interface Appariement {
  tronconId: string;
  code: string;
  nom: string | null;
  classe: string;
  distanceM: number;
  /** PK calcule, ou null quand le troncon n'en porte pas d'exploitable. */
  pk: number | null;
  /** Dit POURQUOI le PK vaut ce qu'il vaut, au lieu de laisser interpreter un null. */
  pkMotif: "CALCULE" | "TRONCON_SANS_PK";
  /** De 0 a 1. Combine l'ecart au trace et la separation d'avec le second candidat. */
  confiance: number;
  /** Vrai quand un autre troncon est a portee de l'incertitude GPS. */
  ambigu: boolean;
}

/**
 * Incertitude retenue quand l'appareil n'en annonce pas.
 *
 * 15 m est le point ou l'appariement urbain s'effondre dans la mesure. Prendre cette
 * valeur par defaut revient a traiter une position sans precision comme le pire cas
 * plausible, et non comme une position exacte.
 */
export const INCERTITUDE_PAR_DEFAUT_M = 15;

/** Plancher : aucun GPS grand public ne fait mieux, et diviser par zero n'a pas de sens. */
export const INCERTITUDE_MINIMALE_M = 3;

/** Au-dela, le point n'est sur aucune route connue : on ne rattache pas. */
export const DISTANCE_MAX_PAR_DEFAUT_M = 50;

/** En deca, le moteur se tait. Voir `confiance` pour ce que ce nombre recouvre. */
export const CONFIANCE_MINIMALE = 0.35;

/** Nombre de candidats examines. Au-dela, on ne departage plus rien d'utile. */
const CANDIDATS = 5;

export interface OptionsAppariement {
  /**
   * Emprise de recherche, en WKT ou GeoJSON. C'est elle qui rend le moteur
   * utilisable : sans elle, la requete balaie le reseau national (2,5 s par point).
   * Une mission telechargee en fournit une.
   */
  emprise?: string | null;
  /** Reseau classe seul par defaut ; `tout` inclut la voirie promue. */
  reseau?: "reference" | "tout";
  distanceMaxM?: number;
  confianceMinimale?: number;
}

/**
 * Confiance d'un appariement, entre 0 et 1.
 *
 * Deux facteurs, multiplies parce qu'ils doivent tous deux tenir :
 *
 * L'ECART AU TRACE. Un point a moins d'une incertitude du trace est coherent avec
 * lui ; a trois incertitudes, il ne l'est plus. La decroissance est lineaire entre
 * les deux.
 *
 * LA SEPARATION. C'est le facteur qui manque aux implementations naives, et celui que
 * la mesure urbaine reclame. Si le deuxieme candidat est a la meme distance que le
 * premier, choisir le premier revient a tirer a pile ou face : la separation vaut 0 et
 * la confiance s'annule, quelle que soit la proximite du trace. C'est exactement le cas
 * des 6 points urbains rates a 15 m — le trace etait proche, mais celui d'a cote aussi.
 */
export function confiance(
  distanceM: number,
  distanceSecondM: number | null,
  incertitudeM: number,
): number {
  const u = Math.max(incertitudeM, INCERTITUDE_MINIMALE_M);
  const ecart = borner(1 - (distanceM - u) / (2 * u));
  // Pas de second candidat : rien ne concurrence le premier, la separation est totale.
  const separation = distanceSecondM === null ? 1 : borner((distanceSecondM - distanceM) / u);
  return Math.round(ecart * separation * 100) / 100;
}

function borner(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * PK d'un point le long d'un troncon.
 *
 * `null` quand le troncon ne porte pas d'intervalle PK exploitable, ce qui est le cas
 * de 1 140 des 1 691 troncons du reseau classe. On ne substitue PAS un kilometrage
 * geometrique : il repondrait a une autre question que celle posee, et un PK derive
 * presente comme un PK officiel est une valeur inventee.
 */
export function pkDeFraction(
  fraction: number,
  pkDebut: number | null,
  pkFin: number | null,
): { pk: number | null; motif: Appariement["pkMotif"] } {
  if (pkDebut == null || pkFin == null || pkFin <= pkDebut) {
    return { pk: null, motif: "TRONCON_SANS_PK" };
  }
  const pk = pkDebut + borner(fraction) * (pkFin - pkDebut);
  return { pk: Math.round(pk * 1000) / 1000, motif: "CALCULE" };
}

/**
 * Choisit parmi les candidats, ou ne choisit pas.
 *
 * Isole de la base pour etre testable : c'est ici que se joue la decision, et une
 * decision qui ne se teste qu'avec PostGIS allume ne se teste pas.
 */
export function choisir(
  candidats: Candidat[],
  incertitudeM: number,
  distanceMaxM: number,
  confianceMinimale: number,
): Appariement | null {
  const [premier, second] = candidats;
  if (!premier || premier.distanceM > distanceMaxM) return null;

  const u = Math.max(incertitudeM, INCERTITUDE_MINIMALE_M);
  const c = confiance(premier.distanceM, second ? second.distanceM : null, u);
  if (c < confianceMinimale) return null;

  const { pk, motif } = pkDeFraction(premier.fraction, premier.pkDebut, premier.pkFin);
  return {
    tronconId: premier.tronconId,
    code: premier.code,
    nom: premier.nom,
    classe: premier.classe,
    distanceM: Math.round(premier.distanceM * 10) / 10,
    pk,
    pkMotif: motif,
    confiance: c,
    // L'ambiguite se dit meme quand la confiance passe : un appelant peut vouloir
    // demander confirmation a l'agent plutot que de refuser tout net.
    ambigu: second ? second.distanceM - premier.distanceM < u : false,
  };
}

/** Candidats les plus proches, bornes a l'emprise quand elle est fournie. */
export async function candidats(
  position: PositionGps,
  options: OptionsAppariement = {},
): Promise<Candidat[]> {
  const point = `ST_SetSRID(ST_MakePoint($1, $2), 4326)`;
  const perimetre = options.reseau === "tout" ? "" : `AND ${clauseSqlReseauClasse('t."sourceReference"')}`;
  // `&&` sur l'emprise AVANT l'operateur de proximite : c'est le filtre qui fait
  // passer la requete de 2,5 s a quelques millisecondes.
  const borne = options.emprise ? `AND t.geom && ST_GeomFromText($3, 4326)` : "";

  const parametres: unknown[] = [position.lon, position.lat];
  if (options.emprise) parametres.push(options.emprise);

  return prisma.$queryRawUnsafe<Candidat[]>(
    `SELECT t.id AS "tronconId", t.code, t.nom, t.classe::text AS classe,
            ST_Distance(t.geom::geography, ${point}::geography) AS "distanceM",
            ST_LineLocatePoint(t.geom, ${point}) AS fraction,
            t."pkDebut", t."pkFin"
       FROM troncons t
      WHERE t."deletedAt" IS NULL
        AND t.geom IS NOT NULL
        AND ST_GeometryType(t.geom) = 'ST_LineString'
        ${perimetre}
        ${borne}
      ORDER BY t.geom <-> ${point}
      LIMIT ${CANDIDATS}`,
    ...parametres,
  );
}

/** Apparie une position, ou rend `null` quand le moteur ne sait pas conclure. */
export async function apparier(
  position: PositionGps,
  options: OptionsAppariement = {},
): Promise<Appariement | null> {
  const liste = await candidats(position, options);
  return choisir(
    liste,
    position.precisionM ?? INCERTITUDE_PAR_DEFAUT_M,
    options.distanceMaxM ?? DISTANCE_MAX_PAR_DEFAUT_M,
    options.confianceMinimale ?? CONFIANCE_MINIMALE,
  );
}
