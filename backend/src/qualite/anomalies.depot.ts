/**
 * Detecteurs SQL du moteur de qualite.
 *
 * TOUT EST BORNE, ET CE N'EST PAS UNE PRECAUTION DE PRINCIPE
 *
 * Mesure du 13/10/2026 sur la production : compter les troncons entierement hors du
 * territoire a pris 20 secondes. Pour 261 387 troncons contre 10 multipolygones, c'est
 * normal, et c'est acceptable pour un traitement de nuit. Ce n'est pas acceptable derriere
 * une route HTTP, ou dix appels simultanes occuperaient la base de production trois minutes.
 *
 * Chaque detecteur ci-dessous est donc SCOPE par region ou par troncon, et plafonne le
 * nombre de lignes rendues. Le balayage national appartient a un traitement par lots, qui
 * n'existe pas encore et dont l'absence est consignee plutot que contournee.
 *
 * ET UN DETECTEUR EST DELIBEREMENT ABSENT
 *
 * La distinction entre un vrai hors-territoire et le BRUIT DE PRECISION des limites
 * administratives demande, par troncon, la distance minimale a la frontiere. Lancee sur la
 * production, cette requete ne s'est pas terminee en dix minutes et j'ai du l'annuler.
 *
 * Elle exigerait une frontiere nationale pretabli et mise en tampon, c'est-a-dire une vue
 * materialisee, c'est-a-dire une ecriture. Je ne l'ai donc pas faite, et le rapport dit
 * « entierement hors des limites de niveau 1 » sans pretendre distinguer une route
 * etrangere d'un trace qui longe la frontiere a cinquante metres.
 */
import { prisma } from "../lib/prisma";
import type { Anomalie, FamilleAnomalie } from "./anomalies";

/**
 * Plafond de lignes par detecteur.
 *
 * Le moteur agrege : il a besoin d'un COMPTE exact et de quelques exemples, pas de la
 * liste. Charger 6 572 identifiants pour n'en montrer trois serait du transport pour rien.
 */
export const PLAFOND_EXEMPLES = 20;

export interface Portee {
  /** Limite l'examen a une region. `null` examine tout, et coute cher : voir l'en-tete. */
  regionId: number | null;
}

export interface ComptageFamille {
  famille: FamilleAnomalie;
  nombre: number;
  surTotal: number | null;
  exemples: Anomalie[];
  /**
   * Ventilation du compte par type d'entite, quand une famille s'etend a plusieurs tables
   * (GEOMETRIE_INVALIDE). Chaque type y figure, y compris a zero : « 0 chantier invalide » dit que
   * la table a ete examinee.
   */
  parTypeEntite?: { entityType: string; nombre: number }[];
}

/**
 * Troncons dont la geometrie ne touche AUCUNE limite de niveau 1.
 *
 * POURQUOI LA FORME A CHANGE LE 14/10/2026, ET CE QUE CELA A COUTE DE LE MESURER
 *
 * L'ancienne forme etait un `NOT EXISTS` correle, avec ce commentaire : « la forme correlee
 * utilise l'index GiST de `limites_admin`, l'union ne l'utiliserait pas ». C'etait VRAI, et
 * insuffisant : l'index de `limites_admin` sert bien, mais le plan balaie quand meme les
 * 261 387 troncons et teste chacun contre des polygones de 7 899 sommets au total.
 *
 *   forme correlee, planaire                      58 243 ms
 *   forme pilotee par les limites decoupees       14 196 ms
 *
 * Quatre fois plus rapide, et SANS nouvel index : le `JOIN` part des morceaux de territoire
 * et entre dans `troncons_geom_geography_idx`, qui existe deja. `ST_Subdivide` est ce qui
 * rend l'index utile — l'union en un seul morceau a une boite englobante couvrant tout le
 * pays, donc l'index ne filtrerait rien.
 *
 * J'avais d'abord cru qu'il fallait ajouter un index GiST planaire sur `troncons.geom`. La
 * mesure l'a dementi : le probleme n'etait pas l'index manquant, c'etait le SENS du
 * parcours.
 *
 * UN TRONCON CHANGE DE VERDICT, ET IL FAUT LE SAVOIR
 *
 *   ancienne forme (planaire, en degres)       6 572 hors territoire
 *   nouvelle forme (geodesique, en metres)     6 573
 *
 * L'ecart est UN seul objet : `GNL-OSM-w321375684`, un sentier de 55,8 m a 7,80357 N /
 * 8,83055 O. En planaire il touche la limite a 0,000000000000 degre ; en geodesique il en
 * est a 3,247 m. Une arete de frontiere est une droite en lon/lat et un arc de grand cercle
 * en metres : les deux divergent de quelques metres sur une longue arete.
 *
 * Les deux reponses sont donc defendables, et discuter de trois metres sur un polygone dont
 * la precision est kilometrique n'a pas de sens. La forme geodesique est retenue parce
 * qu'elle mesure en METRES, comme tout le reste de ce module, et parce qu'elle est quatre
 * fois plus rapide. Voir `docs/rai-v3/AUDIT_TRONCONS_HORS_TERRITOIRE.md`.
 *
 * MESURE DU 14/10/2026, SANS PORTEE : 6 573 troncons. 6 566 portent `voirie_locale:*` et
 * sont deja hors reseau classe ; SEPT seulement comptent dans les 21 156,6 km publies, pour
 * 72,0 km — six RN4 vers Gabu et une RN1 vers le Senegal.
 */
export async function horsTerritoire(p: Portee): Promise<ComptageFamille> {
  const [compte] = await prisma.$queryRaw<{ n: bigint; total: bigint }[]>`
    WITH pays AS MATERIALIZED (
      SELECT g AS geom
        FROM (SELECT ST_Union(geom) AS u FROM limites_admin WHERE niveau = 1) s,
             ST_Subdivide(s.u, 64) AS g
    ), dedans AS MATERIALIZED (
      SELECT DISTINCT t.id
        FROM pays pa JOIN troncons t
          ON ST_Intersects(t.geom::geography, pa.geom::geography)
       WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL
         AND (${p.regionId}::int IS NULL OR t."regionId" = ${p.regionId}::int)
    )
    SELECT count(*) FILTER (WHERE d.id IS NULL) AS n, count(*) AS total
      FROM troncons t LEFT JOIN dedans d ON d.id = t.id
     WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL
       AND (${p.regionId}::int IS NULL OR t."regionId" = ${p.regionId}::int)
  `;

  const exemples = await prisma.$queryRaw<{ id: string; code: string; km: number }[]>`
    WITH pays AS MATERIALIZED (
      SELECT g AS geom
        FROM (SELECT ST_Union(geom) AS u FROM limites_admin WHERE niveau = 1) s,
             ST_Subdivide(s.u, 64) AS g
    ), dedans AS MATERIALIZED (
      SELECT DISTINCT t.id
        FROM pays pa JOIN troncons t
          ON ST_Intersects(t.geom::geography, pa.geom::geography)
       WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL
         AND (${p.regionId}::int IS NULL OR t."regionId" = ${p.regionId}::int)
    )
    SELECT t.id, t.code, ST_Length(t.geom::geography) / 1000.0 AS km
      FROM troncons t LEFT JOIN dedans d ON d.id = t.id
     WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL AND d.id IS NULL
       AND (${p.regionId}::int IS NULL OR t."regionId" = ${p.regionId}::int)
     ORDER BY ST_Length(t.geom::geography) DESC
     LIMIT ${PLAFOND_EXEMPLES}
  `;

  return {
    famille: "HORS_TERRITOIRE",
    nombre: Number(compte?.n ?? 0),
    surTotal: Number(compte?.total ?? 0),
    exemples: exemples.map((e) => ({
      famille: "HORS_TERRITOIRE" as const,
      entityType: "Troncon",
      entityId: e.id,
      explication:
        `${e.code} : ${e.km.toFixed(2)} km entierement hors des limites administratives de`
        + " niveau 1. La precision de la couche de limites n'est pas verifiee a cette echelle.",
      mesure: Math.round(e.km * 100) / 100,
    })),
  };
}

/**
 * Troncons portant une geometrie strictement identique a celle d'un autre.
 *
 * `ST_AsBinary` et non `ST_Equals` : l'egalite geometrique compare des formes a tolerance
 * et coute une comparaison par paire, soit un produit cartesien. L'egalite BINAIRE se
 * groupe, donc se calcule en un balayage, et ne rate que les doublons dont la
 * representation differe — qu'un `ST_Equals` sur les seuls candidats pourra chercher plus
 * tard, si quelqu'un en a besoin.
 *
 * MESURE DU 13/10/2026 : 42 groupes, 42 objets en trop, 18,4 km.
 *
 * CORRECTION DU 14/10/2026 : j'avais ecrit ici « toute statistique de lineaire compte donc
 * ces metres deux fois ». C'est FAUX pour le chiffre publie.
 *
 * Les 42 groupes sont tous des paires, et chaque paire a EXACTEMENT un membre dans le
 * reseau classe (`sourceReference` nul, cree le 29/06) et un membre de voirie locale
 * (`voirie_locale:*`, importe d'OSM le 03-04/09), que `lib/reseau.ts` exclut deja. Mesure :
 * 42 troncons du reseau classe ont un jumeau geometrique, soit un par groupe.
 *
 *   reseau classe, 21 156,6 km, le chiffre publie  ->  comptees UNE fois
 *   registre complet, 185 264,4 km                 ->  comptees deux fois, 18,4 km en trop
 *
 * L'ancienne formulation faisait croire a une erreur dans les 21 156,6 km alors qu'il n'y
 * en a pas. Le detail des 42 paires est dans `docs/rai-v3/AUDIT_DOUBLONS_GEOMETRIQUES.md`.
 */
export async function doublonsDeGeometrie(p: Portee): Promise<ComptageFamille> {
  const lignes = await prisma.$queryRaw<{ ids: string[]; codes: string[]; n: bigint; km: number }[]>`
    SELECT array_agg(t.id) AS ids, array_agg(t.code) AS codes, count(*) AS n,
           max(ST_Length(t.geom::geography)) / 1000.0 AS km
      FROM troncons t
     WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL
       AND (${p.regionId}::int IS NULL OR t."regionId" = ${p.regionId}::int)
     GROUP BY ST_AsBinary(t.geom)
    HAVING count(*) > 1
     ORDER BY max(ST_Length(t.geom::geography)) DESC
     LIMIT ${PLAFOND_EXEMPLES}
  `;

  // Le compte total se refait a part : le LIMIT ci-dessus plafonne les exemples, pas le
  // diagnostic. Rendre « 20 doublons » alors qu'il y en a 42 serait une erreur de lecture
  // bien plus couteuse qu'une seconde requete.
  const [total] = await prisma.$queryRaw<{ groupes: bigint; enTrop: bigint }[]>`
    SELECT count(*) AS groupes, coalesce(sum(n) - count(*), 0) AS "enTrop"
      FROM (SELECT count(*) AS n
              FROM troncons t
             WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL
               AND (${p.regionId}::int IS NULL OR t."regionId" = ${p.regionId}::int)
             GROUP BY ST_AsBinary(t.geom) HAVING count(*) > 1) d
  `;

  return {
    famille: "DOUBLON",
    nombre: Number(total?.groupes ?? 0),
    surTotal: null,
    exemples: lignes.map((l) => ({
      famille: "DOUBLON" as const,
      entityType: "Troncon",
      entityId: l.ids[0],
      explication:
        `${Number(l.n)} troncons de geometrie identique : ${l.codes.slice(0, 4).join(", ")}`
        + `${l.codes.length > 4 ? "…" : ""}. ${l.km.toFixed(2)} km comptes ${Number(l.n)} fois.`,
      mesure: Math.round(l.km * 100) / 100,
    })),
  };
}

/**
 * Geometries invalides au sens de PostGIS (§ 7.1), sur CINQ tables.
 *
 * MESURE DU 13/10/2026 : ZERO, sur 261 387 troncons et 1 172 ouvrages. Je m'attendais au
 * contraire apres une promotion OSM de cette ampleur. Le detecteur reste, parce que c'est
 * l'etat des donnees qui est bon, pas le risque qui a disparu : une correction geometrique
 * mal faite en introduirait.
 *
 * EXTENSION DU 26/10/2026 : le controle ne portait que sur les troncons. Il couvre maintenant
 *
 *   troncons            LineString     (existant)
 *   chantiers           LineString     chantiers.geom
 *   portions            LineString     portions.geom, portions COURANTES (ni remplacees ni supprimees)
 *   limites_admin       MultiPolygon   toutes les limites ; c'est la que l'invalidite est plausible
 *   earth_observation_products         emprise (Polygon) des produits de teledetection
 *   ouvrages            LineString     ouvrages.geomLigne (actifs lineaires)
 *
 * UNE SEULE FAMILLE, `GEOMETRIE_INVALIDE`, bloquante, avec le type d'entite sur chaque exemple et la
 * ventilation `parTypeEntite` : le rapport garde sa structure, et le meme plafond d'exemples. Une
 * famille par table aurait multiplie les lignes du rapport pour une seule correction proposee.
 *
 * LES GARANTIES SONT CELLES DU DETECTEUR DES TRONCONS, POUR CHAQUE TABLE
 *   - compte EXACT par `count(*) OVER ()` : le LIMIT plafonne les exemples, pas le diagnostic ;
 *   - exemples plafonnes a PLAFOND_EXEMPLES, tries par identifiant (stable) ;
 *   - perimetre par region (voir chaque detecteur), jamais d'examen national sans demande explicite ;
 *   - une requete bornee par table, jouees EN SERIE : cinq balayages simultanes se disputeraient le pool ;
 *   - les lignes supprimees logiquement ne comptent pas.
 *
 * CE QUI N'EST PAS CONTROLE, DIT ICI ET DANS LE RAPPORT (`nonCouvert`) : les geometries ponctuelles
 * (un point n'est invalide que s'il porte une coordonnee non finie), les traces et sessions de
 * roulage, la voirie locale, les emprises de defauts et de missions, les propositions de localisation
 * et de teledetection. Deux contraintes de la base les gardent deja pour partie : `eo_emprise_valide`
 * et `pt_geom_valide` (migration 20261020000000) refusent une emprise ou une detection invalide a
 * l'ecriture ; ce detecteur est la ceinture qui reste si la contrainte manque (la production a ete
 * construite par `db push`, voir descentes/README.md).
 */
interface LigneInvalide { id: string; libelle: string; raison: string; total: bigint }

export interface InvalidesParType {
  entityType: string;
  nombre: number;
  exemples: Anomalie[];
}

function enAnomalies(entityType: string, lignes: LigneInvalide[]): InvalidesParType {
  return {
    entityType,
    nombre: lignes.length > 0 ? Number(lignes[0].total) : 0,
    exemples: lignes.map((l) => ({
      famille: "GEOMETRIE_INVALIDE" as const,
      entityType,
      entityId: l.id,
      explication: `${l.libelle} : ${l.raison}`,
      mesure: null,
    })),
  };
}

export async function invalidesTroncons(p: Portee): Promise<InvalidesParType> {
  // Le COMPTE vient de count(*) OVER (), pas de la longueur de la liste : celle-ci est plafonnee a
  // PLAFOND_EXEMPLES, et `nombre: lignes.length` annoncait 20 pour 25 geometries invalides (ou pour
  // 5 000). Une seule passe : le cout est celui de l'ancienne requete quand il n'y a aucune invalide.
  const lignes = await prisma.$queryRaw<LigneInvalide[]>`
    SELECT t.id, t.code AS libelle, ST_IsValidReason(t.geom) AS raison, count(*) OVER () AS total
      FROM troncons t
     WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL
       AND (${p.regionId}::int IS NULL OR t."regionId" = ${p.regionId}::int)
       AND NOT ST_IsValid(t.geom)
     ORDER BY t.id
     LIMIT ${PLAFOND_EXEMPLES}
  `;
  return enAnomalies("Troncon", lignes);
}

export async function invalidesChantiers(p: Portee): Promise<InvalidesParType> {
  const lignes = await prisma.$queryRaw<LigneInvalide[]>`
    SELECT c.id, left(c.intitule, 80) AS libelle, ST_IsValidReason(c.geom) AS raison, count(*) OVER () AS total
      FROM chantiers c
     WHERE c."deletedAt" IS NULL AND c.geom IS NOT NULL
       AND (${p.regionId}::int IS NULL OR c."regionId" = ${p.regionId}::int)
       AND NOT ST_IsValid(c.geom)
     ORDER BY c.id
     LIMIT ${PLAFOND_EXEMPLES}
  `;
  return enAnomalies("Chantier", lignes);
}

/** Actifs lineaires : `ouvrages.geomLigne` (l'emprise ponctuelle `geom` n'est pas examinee). */
export async function invalidesActifsLineaires(p: Portee): Promise<InvalidesParType> {
  const lignes = await prisma.$queryRaw<LigneInvalide[]>`
    SELECT o.id, left(coalesce(o.code, o.nom), 80) AS libelle, ST_IsValidReason(o."geomLigne") AS raison,
           count(*) OVER () AS total
      FROM ouvrages o
     WHERE o."deletedAt" IS NULL AND o."geomLigne" IS NOT NULL
       AND (${p.regionId}::int IS NULL OR o."regionId" = ${p.regionId}::int)
       AND NOT ST_IsValid(o."geomLigne")
     ORDER BY o.id
     LIMIT ${PLAFOND_EXEMPLES}
  `;
  return enAnomalies("Ouvrage", lignes);
}

/**
 * Portions courantes dont la geometrie derivee est invalide. La region est celle du troncon porteur.
 * Les versions remplacees (`remplaceeLe`) sont de l'historique : elles ne servent plus a rien.
 */
export async function invalidesPortions(p: Portee): Promise<InvalidesParType> {
  const lignes = await prisma.$queryRaw<LigneInvalide[]>`
    SELECT pt.id, 'portion de ' || t.code AS libelle, ST_IsValidReason(pt.geom) AS raison,
           count(*) OVER () AS total
      FROM portions pt
      JOIN troncons t ON t.id = pt."tronconId"
     WHERE pt."deletedAt" IS NULL AND pt."remplaceeLe" IS NULL AND pt.geom IS NOT NULL
       AND (${p.regionId}::int IS NULL OR t."regionId" = ${p.regionId}::int)
       AND NOT ST_IsValid(pt.geom)
     ORDER BY pt.id
     LIMIT ${PLAFOND_EXEMPLES}
  `;
  return enAnomalies("Portion", lignes);
}

/**
 * Limites administratives (polygones). Elles n'ont pas de `regionId` : une limite appartient a une
 * region quand elle EST la limite de niveau 1 qui porte son nom (jointure sans accents ni casse, comme
 * `modules/qualite/qualite.routes.ts` et `chantiers.service.ts`, d'ou la dependance a `unaccent`) ou
 * qu'elle en descend par `parentPcode`. La recursion exige un niveau STRICTEMENT croissant : un cycle de
 * `parentPcode` dans la donnee ne peut donc pas la faire boucler.
 */
export async function invalidesLimitesAdmin(p: Portee): Promise<InvalidesParType> {
  const lignes = await prisma.$queryRaw<LigneInvalide[]>`
    WITH RECURSIVE sous_la_region(pcode, niveau) AS (
      SELECT la.pcode, la.niveau
        FROM limites_admin la
        JOIN regions r ON r.id = ${p.regionId}::int
       WHERE la.niveau = 1 AND unaccent(lower(la.nom)) = unaccent(lower(r.nom))
      UNION ALL
      SELECT e.pcode, e.niveau
        FROM limites_admin e
        JOIN sous_la_region s ON e."parentPcode" = s.pcode
       WHERE e.niveau > s.niveau
    )
    SELECT la.pcode AS id, 'limite niveau ' || la.niveau || ' ' || la.nom AS libelle,
           ST_IsValidReason(la.geom) AS raison, count(*) OVER () AS total
      FROM limites_admin la
     WHERE la.geom IS NOT NULL
       AND (${p.regionId}::int IS NULL OR la.pcode IN (SELECT pcode FROM sous_la_region))
       AND NOT ST_IsValid(la.geom)
     ORDER BY la.pcode
     LIMIT ${PLAFOND_EXEMPLES}
  `;
  return enAnomalies("LimiteAdmin", lignes);
}

/**
 * Emprises des produits de teledetection. Un produit n'a pas de region : en portee regionale, on retient
 * ceux dont la BOITE ENGLOBANTE recouvre la limite de niveau 1 de la region (`&&`). Ce n'est pas une
 * intersection exacte, et c'est voulu : `ST_Intersects` sur une geometrie INVALIDE peut lever une
 * exception de GEOS (TopologyException) et ferait echouer le controle precisement quand il y a quelque
 * chose a trouver. La boite englobante surestime le perimetre, jamais ne le sous-estime.
 */
export async function invalidesEmprisesTeledetection(p: Portee): Promise<InvalidesParType> {
  const lignes = await prisma.$queryRaw<LigneInvalide[]>`
    SELECT e.id, e.code AS libelle, ST_IsValidReason(e.emprise) AS raison, count(*) OVER () AS total
      FROM earth_observation_products e
     WHERE e."deletedAt" IS NULL AND e.emprise IS NOT NULL
       AND (${p.regionId}::int IS NULL OR EXISTS (
             SELECT 1
               FROM limites_admin la
               JOIN regions r ON r.id = ${p.regionId}::int
              WHERE la.niveau = 1 AND unaccent(lower(la.nom)) = unaccent(lower(r.nom))
                AND la.geom && e.emprise))
       AND NOT ST_IsValid(e.emprise)
     ORDER BY e.id
     LIMIT ${PLAFOND_EXEMPLES}
  `;
  return enAnomalies("EarthObservationProduct", lignes);
}

/**
 * Entrelace les exemples de plusieurs listes, un par liste a tour de role, jusqu'au plafond. Sans cela,
 * vingt troncons invalides masqueraient les chantiers et les limites : le rapport ne montre que les trois
 * premiers exemples, et ils seraient tous des troncons.
 */
export function entrelacer<T>(listes: readonly (readonly T[])[], plafond: number): T[] {
  const sortie: T[] = [];
  for (let i = 0; sortie.length < plafond; i++) {
    let reste = false;
    for (const l of listes) {
      if (i < l.length) {
        reste = true;
        if (sortie.length < plafond) sortie.push(l[i]);
      }
    }
    if (!reste) break;
  }
  return sortie;
}

export async function geometriesInvalides(p: Portee): Promise<ComptageFamille> {
  // En serie : voir l'en-tete. Chaque requete est bornee et son compte est exact.
  const types: InvalidesParType[] = [];
  for (const detecteur of [
    invalidesTroncons,
    invalidesChantiers,
    invalidesPortions,
    invalidesLimitesAdmin,
    invalidesEmprisesTeledetection,
    invalidesActifsLineaires,
  ]) {
    types.push(await detecteur(p));
  }
  return {
    famille: "GEOMETRIE_INVALIDE",
    nombre: types.reduce((somme, t) => somme + t.nombre, 0),
    surTotal: null,
    exemples: entrelacer(types.map((t) => t.exemples), PLAFOND_EXEMPLES),
    parTypeEntite: types.map((t) => ({ entityType: t.entityType, nombre: t.nombre })),
  };
}

/**
 * Ouvrages sans statut de validation.
 *
 * MESURE DU 13/10/2026 : les 1 172, soit TOUS. La colonne est neuve et la migration
 * additive n'ecrit rien, donc c'est attendu. La consequence tient quand meme : les
 * 81 ouvrages issus d'un PDF ne se distinguent d'aucune maniere de ceux qu'un agent aurait
 * constates sur place.
 */
export async function actifsSansValidation(p: Portee): Promise<ComptageFamille> {
  const where = p.regionId === null ? {} : { regionId: p.regionId };
  const [nombre, total, exemples] = await Promise.all([
    prisma.ouvrage.count({ where: { ...where, deletedAt: null, statutValidation: null } }),
    prisma.ouvrage.count({ where: { ...where, deletedAt: null } }),
    prisma.ouvrage.findMany({
      where: { ...where, deletedAt: null, statutValidation: null },
      select: { id: true, nom: true, type: true, sourceReference: true },
      take: PLAFOND_EXEMPLES,
    }),
  ]);
  return {
    famille: "ACTIF_SANS_VALIDATION",
    nombre,
    surTotal: total,
    exemples: exemples.map((o) => ({
      famille: "ACTIF_SANS_VALIDATION" as const,
      entityType: "Ouvrage",
      entityId: o.id,
      explication:
        `${o.type} « ${o.nom} » sans statut de validation`
        + `${o.sourceReference ? `, importe de ${o.sourceReference}` : ""}.`,
      mesure: null,
    })),
  };
}

/**
 * Ouvrages dont l'inspection est perimee ou absente.
 *
 * `fraicheurMaxJours` est un PARAMETRE : le cahier ne dit pas a partir de quand une
 * inspection est trop ancienne, et le figer ici en ferait la norme d'AGEROUTE par defaut.
 *
 * MESURE DU 13/10/2026 : les 1 172 ouvrages n'ont AUCUNE date d'inspection. Un indicateur
 * « ouvrages a inspecter » rend donc aujourd'hui la totalite du parc, ce qui est exact et
 * inutilisable tant que les inspections ne sont pas saisies.
 */
export async function inspectionsPerimeesEnBase(
  p: Portee,
  fraicheurMaxJours: number,
  maintenant: Date = new Date(),
): Promise<ComptageFamille> {
  const limite = new Date(maintenant.getTime() - fraicheurMaxJours * 24 * 60 * 60 * 1000);
  const where = p.regionId === null ? {} : { regionId: p.regionId };
  // Une date ABSENTE est perimee, pas fraiche : un ouvrage dont on ignore la date
  // d'inspection n'a pas ete inspecte recemment, il n'a pas ete documente.
  const critere = {
    ...where,
    deletedAt: null,
    OR: [{ derniereInspectionDate: null }, { derniereInspectionDate: { lt: limite } }],
  };
  const [nombre, total, exemples] = await Promise.all([
    prisma.ouvrage.count({ where: critere }),
    prisma.ouvrage.count({ where: { ...where, deletedAt: null } }),
    prisma.ouvrage.findMany({
      where: critere,
      select: { id: true, nom: true, type: true, derniereInspectionDate: true },
      orderBy: { derniereInspectionDate: { sort: "asc", nulls: "first" } },
      take: PLAFOND_EXEMPLES,
    }),
  ]);
  return {
    famille: "INSPECTION_PERIMEE",
    nombre,
    surTotal: total,
    exemples: exemples.map((o) => ({
      famille: "INSPECTION_PERIMEE" as const,
      entityType: "Ouvrage",
      entityId: o.id,
      explication: o.derniereInspectionDate === null
        ? `${o.type} « ${o.nom} » sans aucune date d'inspection enregistree.`
        : `${o.type} « ${o.nom} » inspecte le ${o.derniereInspectionDate.toISOString().slice(0, 10)},`
          + ` au-dela du seuil de ${fraicheurMaxJours} jours.`,
      mesure: null,
    })),
  };
}

/**
 * Troncons sans provenance declaree.
 *
 * MESURE DU 13/10/2026 : 1 691 sur 261 387, et ce sont exactement les troncons du reseau
 * classe d'origine. La voirie promue, elle, documente sa source. Le referentiel le plus
 * ancien est donc le moins trace, ce qui est l'inverse de l'intuition.
 */
export async function donneesSansProvenance(p: Portee): Promise<ComptageFamille> {
  const where = p.regionId === null ? {} : { regionId: p.regionId };
  const [nombre, total, exemples] = await Promise.all([
    prisma.troncon.count({ where: { ...where, deletedAt: null, sourceType: null } }),
    prisma.troncon.count({ where: { ...where, deletedAt: null } }),
    prisma.troncon.findMany({
      where: { ...where, deletedAt: null, sourceType: null },
      select: { id: true, code: true, classe: true },
      take: PLAFOND_EXEMPLES,
    }),
  ]);
  return {
    famille: "DONNEE_SANS_PROVENANCE",
    nombre,
    surTotal: total,
    exemples: exemples.map((t) => ({
      famille: "DONNEE_SANS_PROVENANCE" as const,
      entityType: "Troncon",
      entityId: t.id,
      explication: `${t.code} (${t.classe}) sans sourceType : on ne sait pas d'ou vient cet enregistrement.`,
      mesure: null,
    })),
  };
}
