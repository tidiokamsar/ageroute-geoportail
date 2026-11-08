/**
 * Emprise GPS d'un defaut : le branchement du metre geometrique (scenario A5, paragraphe 7.1).
 *
 * « Calculs metriques (longueurs, surfaces, distances, tampons) : projection en UTM 28N (EPSG:32628)
 * ou UTM 29N (EPSG:32629) selon la longitude. Jamais de calcul de longueur ou de surface en
 * degres. » Les fonctions SQL `epsg_utm` et `metre_utm` (migration 20261020010000) font ce calcul ;
 * `POST /api/v2/geo/metre` l'expose ; ce module le met au service de la SAISIE DU DEFAUT.
 *
 * COMMENT UN DEFAUT LINEAIRE OU SURFACIQUE ENTRE
 *
 * L'agent contourne le defaut au GPS (une ligne pour un ornierage ou une fissure longitudinale, un
 * polygone pour un faiencage ou un nid-de-poule) et envoie ce contour (`emprise`, GeoJSON 4326).
 * Le serveur le mesure dans son fuseau UTM, et la quantite du defaut en est tiree
 * (`defauts.regles.ts`, methode `EMPRISE_UTM`). Aucune mesure n'est faite en degres, et aucune
 * geometrie n'est reparee : une emprise invalide est refusee avec sa raison.
 *
 * POURQUOI L'ECRITURE SE FAIT EN SQL
 *
 * `defauts.emprise` est une colonne `geometry` que Prisma ne sait pas ecrire. La quantite, son
 * unite et sa methode sont ecrites dans le meme UPDATE : la ligne n'est jamais vue avec une emprise
 * et la quantite d'une autre voie. Ce choix evite aussi de dependre de la regeneration du client
 * Prisma pour la valeur d'enumeration `EMPRISE_UTM`.
 */
import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { MetreEmprise, MethodeQuantite, UniteDefaut } from "./defauts.regles";

/** Les methodes que Prisma ecrit seul : tout sauf `EMPRISE_UTM`, ecrite en SQL avec l'emprise. */
export type MethodeSansEmprise = Exclude<MethodeQuantite, "EMPRISE_UTM">;
export const sansEmprise = (m: MethodeQuantite): MethodeSansEmprise | null => (m === "EMPRISE_UTM" ? null : m);

type Db =Pick<PrismaClient, "$queryRaw" | "$executeRaw"> | Prisma.TransactionClient;

/** Plafond de positions : un contour de plusieurs milliers de points est une trace, pas un contour. */
export const POSITIONS_MAX = 20_000;

export const empriseSchema = z.object({
  type: z.enum(["LineString", "MultiLineString", "Polygon", "MultiPolygon"]),
  coordinates: z.array(z.unknown()).min(1),
}).strict();

export type EmpriseGeoJson = z.infer<typeof empriseSchema>;

/** Une emprise ligne ou surface, selon le type GeoJSON. */
export const typeEmprise = (g: EmpriseGeoJson): MetreEmprise["type"] =>
  g.type === "LineString" || g.type === "MultiLineString" ? "ligne" : "surface";

/**
 * Verifie la forme des coordonnees AVANT d'interroger PostGIS : des nombres finis, dans l'etendue
 * de WGS 84, en quantite raisonnable. Rend le motif, ou null si tout va bien.
 *
 * PostGIS lit `[7500000, 1100000]` sans protester ; c'est `ST_Transform` qui echoue ensuite, ou pire,
 * qui rend un fuseau absurde. Un contour qui n'est pas en degres n'est pas en 4326.
 */
export function motifCoordonneesInvalides(g: EmpriseGeoJson): string | null {
  let positions = 0;
  const visiter = (n: unknown): string | null => {
    if (!Array.isArray(n)) return "coordonnees non structurees";
    if (n.length >= 2 && n.length <= 3 && n.every((v) => typeof v === "number")) {
      positions += 1;
      if (positions > POSITIONS_MAX) return `plus de ${POSITIONS_MAX} positions`;
      const [lon, lat] = n as number[];
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return "coordonnee non finie";
      if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return `position hors de l'etendue WGS 84 (${lon}, ${lat}) : l'emprise n'est pas en SRID 4326`;
      return null;
    }
    for (const enfant of n) {
      const m = visiter(enfant);
      if (m) return m;
    }
    return n.length === 0 ? "liste de positions vide" : null;
  };
  return visiter(g.coordinates);
}

export type MesureEmprise =
  | { ok: true; metre: MetreEmprise; epsg: number; ecartLongueur: number | null; ecartSurface: number | null }
  | { ok: false; motif: "EMPRISE_ILLISIBLE" | "EMPRISE_INVALIDE"; raison: string };

/**
 * Mesure une emprise dans son fuseau UTM. N'ecrit rien.
 *
 * Une geometrie illisible ou invalide est refusee avec sa raison (`ST_IsValidReason`), jamais
 * reparee par `ST_MakeValid` : reparer changerait la surface mesuree sans le dire.
 */
export async function mesurerEmprise(db: Db, g: EmpriseGeoJson): Promise<MesureEmprise> {
  const forme = motifCoordonneesInvalides(g);
  if (forme) return { ok: false, motif: "EMPRISE_ILLISIBLE", raison: forme };
  const geojson = JSON.stringify(g);
  try {
    const v = await db.$queryRaw<{ valide: boolean; raison: string }[]>`
      SELECT ST_IsValid(g) AS "valide", ST_IsValidReason(g) AS "raison"
        FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326) AS g) s`;
    if (!v[0]?.valide) return { ok: false, motif: "EMPRISE_INVALIDE", raison: v[0]?.raison ?? "geometrie invalide" };
    const [m] = await db.$queryRaw<{
      epsg: number; longueurM: number; surfaceM2: number; ecartLongueur: number | null; ecartSurface: number | null;
    }[]>`SELECT "epsg", "longueurM", "surfaceM2", "ecartLongueur", "ecartSurface"
           FROM metre_utm(ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326))`;
    const type = typeEmprise(g);
    return {
      ok: true,
      epsg: Number(m.epsg),
      ecartLongueur: m.ecartLongueur === null ? null : Number(m.ecartLongueur),
      ecartSurface: m.ecartSurface === null ? null : Number(m.ecartSurface),
      metre: { type, longueurM: Number(m.longueurM), surfaceM2: type === "surface" ? Number(m.surfaceM2) : null },
    };
  } catch (err) {
    // PostGIS n'a pas su lire la geometrie (type ou imbrication). C'est une erreur de l'appelant.
    if (err instanceof Error && /GeoJSON|geometry|parse/i.test(err.message)) {
      return { ok: false, motif: "EMPRISE_ILLISIBLE", raison: "coordonnees GeoJSON non conformes" };
    }
    throw err;
  }
}

/** Ce qui est ecrit avec l'emprise quand elle a fourni la quantite. */
export interface QuantiteEmprise {
  valeur: number;
  unite: UniteDefaut;
  methode: "EMPRISE_UTM";
}

/**
 * Pose l'emprise du defaut, et, quand elle a fourni la quantite, la quantite avec son unite et sa
 * methode. Dans la transaction de l'appelant : le defaut et son emprise naissent ensemble ou pas.
 */
export async function ecrireEmprise(tx: Db, defautId: string, g: EmpriseGeoJson, quantite?: QuantiteEmprise): Promise<void> {
  const geojson = JSON.stringify(g);
  await tx.$executeRaw`UPDATE "defauts" SET "emprise" = ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326) WHERE "id" = ${defautId}`;
  if (quantite) await ecrireQuantiteEmprise(tx, defautId, quantite);
}

/** Ecrit la quantite tiree de l'emprise (valeur, unite, methode) sans toucher a la geometrie. */
export async function ecrireQuantiteEmprise(tx: Db, defautId: string, quantite: QuantiteEmprise): Promise<void> {
  await tx.$executeRaw`
    UPDATE "defauts"
       SET "quantite" = ${quantite.valeur}, "uniteQuantite" = ${quantite.unite}::"UniteDefaut",
           "methodeQuantite" = ${quantite.methode}::"MethodeQuantite"
     WHERE "id" = ${defautId}`;
}

/** L'emprise stockee d'un defaut, ou null. Sert aux recalculs (resoumission) : le contour ne se perd pas. */
export async function lireEmpriseStockee(db: Db, defautId: string): Promise<EmpriseGeoJson | null> {
  const lignes = await db.$queryRaw<{ g: string | null }[]>`SELECT ST_AsGeoJSON("emprise") AS "g" FROM "defauts" WHERE "id" = ${defautId} AND "emprise" IS NOT NULL`;
  if (!lignes[0]?.g) return null;
  const parse = empriseSchema.safeParse(JSON.parse(lignes[0].g));
  return parse.success ? parse.data : null;
}
