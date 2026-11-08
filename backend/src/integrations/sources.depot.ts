/**
 * LECTURE DES SOURCES EMISSIBLES. SQL ETIQUETE UNIQUEMENT, AUCUNE MODIFICATION.
 *
 * UNE SEULE REGLE D'ELIGIBILITE, DANS LA BASE
 *
 * Savoir si une source est emissible (VALIDE, non supprimee, non remplacee) est decide par la
 * fonction SQL `outbox_source_refus`, la MEME que le declencheur `outbox_garde` appelle a
 * l'insertion. Il n'existe pas de seconde implementation en TypeScript qui pourrait diverger : le
 * service et le filet de la base lisent la meme regle.
 *
 * Ces requetes passent par `$queryRaw` etiquete (valeurs liees par le pilote) parce que les
 * geometries ne sont pas gerees nativement par Prisma, et pour ne pas dependre d'un client genere
 * qui ne connaitrait pas encore les tables de l'outbox.
 */
import type { PrismaClient } from "@prisma/client";
import type { Destination, TypeSource } from "./types";
import { ROUTES } from "./types";
import {
  chargeBulletin, chargePivotOuvrage, chargePivotPortion, chargePivotTroncon,
  type Construction, type SnapshotBulletin, type SnapshotOuvrage, type SnapshotPortion, type SnapshotTroncon,
} from "./sources.noyau";

export type LectureSource =
  | { emissible: true; charge: unknown }
  | { emissible: false; code: "SOURCE_NON_EMISSIBLE" | "SOURCE_INCONNUE" | "CHARGE_NON_CONSTRUISIBLE"; motif: string };

/** Ce que le service demande a la base de lire. Remplacable par une memoire dans les tests. */
export interface LecteurSources {
  lire(destination: Destination, sourceType: TypeSource, sourceId: string): Promise<LectureSource>;
}

type ClientSql = Pick<PrismaClient, "$queryRaw">;

function jsonOuNul(texte: string | null): unknown {
  if (texte === null || texte === undefined) return null;
  try { return JSON.parse(texte); } catch { return null; }
}

export function lecteurSourcesSql(db: ClientSql): LecteurSources {
  async function refus(type: TypeSource, id: string): Promise<string | null> {
    const lignes = await db.$queryRaw<{ refus: string | null }[]>`SELECT outbox_source_refus(${type}, ${id}) AS refus`;
    return lignes[0]?.refus ?? null;
  }

  function enLecture(c: Construction<unknown>): LectureSource {
    return c.ok ? { emissible: true, charge: c.charge } : { emissible: false, code: "CHARGE_NON_CONSTRUISIBLE", motif: c.motif };
  }

  return {
    async lire(destination, sourceType, sourceId) {
      if (!ROUTES[destination].sources.includes(sourceType)) {
        return { emissible: false, code: "SOURCE_INCONNUE", motif: `la destination ${destination} ne recoit pas de source ${sourceType}` };
      }
      const motif = await refus(sourceType, sourceId);
      if (motif !== null) return { emissible: false, code: "SOURCE_NON_EMISSIBLE", motif };

      switch (sourceType) {
        case "Troncon": {
          const l = await db.$queryRaw<(Omit<SnapshotTroncon, "geometrie"> & { geometrie: string | null })[]>`
            SELECT t.id, t.code, t.nom, t.classe::text AS classe, t."longueurKm" AS "longueurKm",
                   t.revetement::text AS revetement, t.etat::text AS etat, r.nom AS "regionNom",
                   to_char(t."dateDerniereEvaluation", 'YYYY-MM-DD') AS "dateDerniereEvaluation",
                   ST_AsGeoJSON(t.geom)::text AS geometrie
              FROM troncons t LEFT JOIN regions r ON r.id = t."regionId"
             WHERE t.id = ${sourceId}`;
          if (!l[0]) return { emissible: false, code: "SOURCE_INCONNUE", motif: `troncon ${sourceId} introuvable` };
          return enLecture(chargePivotTroncon({ ...l[0], geometrie: jsonOuNul(l[0].geometrie) } as SnapshotTroncon));
        }
        case "Ouvrage": {
          const l = await db.$queryRaw<(Omit<SnapshotOuvrage, "geometrie"> & { geometrie: string | null })[]>`
            SELECT o.id, o.code, o.nom, o.type::text AS type, o.etat::text AS etat, o.pk,
                   t.code AS "tronconCode", ST_AsGeoJSON(o.geom)::text AS geometrie
              FROM ouvrages o LEFT JOIN troncons t ON t.id = o."tronconId"
             WHERE o.id = ${sourceId}`;
          if (!l[0]) return { emissible: false, code: "SOURCE_INCONNUE", motif: `ouvrage ${sourceId} introuvable` };
          return enLecture(chargePivotOuvrage({ ...l[0], geometrie: jsonOuNul(l[0].geometrie) } as SnapshotOuvrage));
        }
        case "Portion": {
          const l = await db.$queryRaw<(Omit<SnapshotPortion, "geometrie"> & { geometrie: string | null })[]>`
            SELECT p.id, p."tronconId" AS "tronconId", t.code AS "tronconCode", p."debutM" AS "debutM", p."finM" AS "finM",
                   p.etat, p.revetement, p.praticabilite,
                   to_char(p."valideDu", 'YYYY-MM-DD') AS "valideDu", to_char(p."valideAu", 'YYYY-MM-DD') AS "valideAu",
                   to_char(p."observeeLe", 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "observeeLe",
                   ST_AsGeoJSON(p.geom)::text AS geometrie
              FROM portions p JOIN troncons t ON t.id = p."tronconId"
             WHERE p.id = ${sourceId}`;
          if (!l[0]) return { emissible: false, code: "SOURCE_INCONNUE", motif: `portion ${sourceId} introuvable` };
          return enLecture(chargePivotPortion({ ...l[0], geometrie: jsonOuNul(l[0].geometrie) } as SnapshotPortion));
        }
        case "BulletinRoutier": {
          const l = await db.$queryRaw<SnapshotBulletin[]>`
            SELECT id, numero, to_char(jour, 'YYYY-MM-DD') AS jour, texte, "empreinteSha256" AS "empreinteSha256"
              FROM bulletins_routiers WHERE id = ${sourceId}`;
          if (!l[0]) return { emissible: false, code: "SOURCE_INCONNUE", motif: `bulletin ${sourceId} introuvable` };
          return enLecture(chargeBulletin(l[0]));
        }
        default:
          // FicheIntervention : outbox_source_refus a deja repondu (aucune table), on n'arrive pas ici.
          return { emissible: false, code: "SOURCE_INCONNUE", motif: `source ${sourceType} sans lecteur` };
      }
    },
  };
}
