import { prisma } from "../../lib/prisma";
import { createCrudService, type ListParams } from "../../lib/crud-factory";
import { buildExportBuffer, parseImportBuffer, formatImportError, type ImportReport } from "../../lib/excel";
import { resolveRegionId } from "../../lib/regions";
import { ApiError } from "../../middleware/error.middleware";
import { tronconCreateSchema, type TronconCreateInput } from "./troncons.schema";

const base = createCrudService(prisma.troncon, "Troncon", { region: true });

async function setLineGeom(id: string, geom: { type: string; coordinates: number[][] }): Promise<void> {
  await prisma.$executeRaw`
    UPDATE troncons SET geom = ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geom)}), 4326)
    WHERE id = ${id}
  `;
}

export interface TronconListParams extends ListParams {
  search?: string;
  region?: string;
  etat?: string;
  classe?: string;
}

async function list(params: TronconListParams) {
  const where: Record<string, unknown> = { ...params.where };
  if (params.region) where.region = { nom: params.region };
  if (params.etat) where.etat = params.etat;
  if (params.classe) where.classe = params.classe;
  if (params.search) {
    where.OR = [
      { code: { contains: params.search, mode: "insensitive" } },
      { nom: { contains: params.search, mode: "insensitive" } },
    ];
  }
  return base.list({ ...params, where });
}

// Estimation "a vol d'oiseau" entre deux troncons (centroides de leurs traces), PAS un
// vrai calcul d'itineraire route par route (necessiterait un graphe topologique du reseau,
// non construit ici) : libelle explicitement comme une estimation cote frontend pour ne
// pas induire en erreur sur la precision. Liste aussi les regions traversees par simple
// test d'intersection avec un tampon autour du segment droit reliant les deux points.
async function itineraire(fromId: string, toId: string) {
  const rows = await prisma.$queryRaw<
    { distanceKm: number; fromNom: string; fromCode: string; toNom: string; toCode: string; regionsTraversees: string[] }[]
  >`
    WITH a AS (SELECT ST_Centroid(geom) AS g, code, nom FROM troncons WHERE id = ${fromId}),
         b AS (SELECT ST_Centroid(geom) AS g, code, nom FROM troncons WHERE id = ${toId}),
         ligne AS (SELECT ST_MakeLine((SELECT g FROM a), (SELECT g FROM b)) AS g)
    SELECT
      ST_Distance((SELECT g FROM a)::geography, (SELECT g FROM b)::geography) / 1000 AS "distanceKm",
      (SELECT nom FROM a) AS "fromNom", (SELECT code FROM a) AS "fromCode",
      (SELECT nom FROM b) AS "toNom", (SELECT code FROM b) AS "toCode",
      ARRAY(
        SELECT DISTINCT r.nom FROM regions r
        JOIN troncons t ON t."regionId" = r.id
        WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL
          AND ST_DWithin(t.geom::geography, (SELECT g FROM ligne)::geography, 20000)
      ) AS "regionsTraversees"
  `;
  const row = rows[0];
  if (!row || row.distanceKm == null) throw new ApiError(404, "Tronçon de départ ou d'arrivée introuvable");
  return row;
}

/**
 * Geometrie LineString exposee en GeoJSON (Prisma ne lit pas les colonnes
 * "Unsupported(geometry...)" nativement).
 *
 * LE RESEAU DE REFERENCE, ET POURQUOI IL EST LE DEFAUT
 *
 * La promotion de la voirie porte cette table a environ 264 000 lignes. Les cartes
 * qui appellent cette fonction ne demandent aucune emprise : elles peignent tout.
 *
 * Mesure du 03/09/2026 : 2 040 troncons pesent 3,0 Mo bruts ; les 262 306 voies
 * restantes representent 132 Mo de GeoJSON. Servies ici, elles rendraient la carte
 * publique inutilisable, d'abord sur les connexions mobiles.
 *
 * Le defaut exclut donc les troncons issus de la voirie locale. Ce n'est pas un
 * masquage : ils sont au registre, dans les exports, et peuvent porter des chantiers.
 * Ils sont aussi DEJA affiches — par la couche voirie, cadree par emprise au-dela du
 * zoom 12, ou chacun s'ouvre en fiche et renvoie a son troncon. Les servir une
 * seconde fois, sans emprise, n'ajouterait rien et couterait 132 Mo.
 *
 * `tout: true` leve l'exclusion, pour un appelant qui sait ce qu'il demande.
 *
 * `simplification` : TOLERANCE EN DEGRES, ET CE QU'ELLE COUTE
 *
 * Le poids de cette reponse vient de la geometrie, pas du nombre d'objets. Mesure du
 * 04/09/2026 sur le reseau de reference :
 *
 *     brut          2 366 ko   106 856 sommets   21 156 km
 *     0,0001 deg    1 075 ko    46 989 sommets   21 142 km   (-14 km, 0,07 %)
 *     0,0005 deg      603 ko    25 106 sommets   21 071 km   (-85 km, 0,40 %)
 *     0,002  deg      307 ko    11 422 sommets   20 784 km   (-372 km, 1,76 %)
 *
 * A l'echelle du pays, 220 m est inferieur au pixel : transporter 106 856 sommets
 * pour en dessiner 11 000 de visibles est du gaspillage pur, paye par le visiteur sur
 * une connexion mobile guineenne.
 *
 * ST_SimplifyPreserveTopology et non ST_Simplify : le second peut rendre une ligne
 * vide ou auto-secante sur un trace court, ce qui casserait l'affichage sans
 * prevenir.
 *
 * Zero signifie « aucune simplification » — a ce niveau de zoom, c'est la forme
 * exacte qu'on regarde.
 */
async function listGeo({ tout = false, simplification = 0 }: { tout?: boolean; simplification?: number } = {}) {
  return prisma.$queryRaw`
    SELECT t.id, t.code, t.nom, t.classe, t.etat, t."longueurKm", r.nom AS region,
           t.revetement, t."pkDebut", t."pkFin", t."traficMoyenJma",
           -- Un etat DECLARE n'est pas un etat CONSTATE. La carte affiche la meme
           -- pastille verte dans les deux cas ; sans ce drapeau, un « bon etat »
           -- annonce par un gestionnaire serait indiscernable d'une inspection.
           --
           -- Vrai UNIQUEMENT si valeurs_qualite porte la mention explicite. L'absence
           -- de ligne ne vaut pas verification : elle ne dit rien, et on ne fait donc
           -- rien dire aux 1 690 troncons anterieurs.
           EXISTS (
             SELECT 1 FROM valeurs_qualite q
              WHERE q."entityType" = 'Troncon' AND q."entityId" = t.id
                AND q.champ = 'etat' AND q.statut = 'IMPORTED_UNVERIFIED'
           ) AS "etatDeclare",
           ST_AsGeoJSON(
             CASE WHEN ${simplification}::float8 > 0
                  THEN ST_SimplifyPreserveTopology(t.geom, ${simplification}::float8)
                  ELSE t.geom END
           ) AS geometry
    FROM troncons t
    LEFT JOIN regions r ON r.id = t."regionId"
    WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL
      AND (
        ${tout}::boolean
        OR t."sourceReference" IS NULL
        OR t."sourceReference" NOT LIKE 'voirie_locale:%'
      )
  `;
}

const EXPORT_COLUMNS = [
  { key: "code", header: "Code" },
  { key: "nom", header: "Nom" },
  { key: "classe", header: "Classe" },
  { key: "region", header: "Région" },
  { key: "longueurKm", header: "Longueur (km)" },
  { key: "revetement", header: "Revêtement" },
  { key: "etat", header: "État" },
  { key: "pkDebut", header: "PK Début" },
  { key: "pkFin", header: "PK Fin" },
  { key: "traficMoyenJma", header: "Trafic moyen (jma)" },
];

async function exportXlsx(): Promise<Buffer> {
  const rows = await prisma.troncon.findMany({
    where: { deletedAt: null },
    include: { region: true },
    orderBy: { code: "asc" },
  });
  const mapped = rows.map((r: { region: { nom: string } | null } & Record<string, unknown>) => ({
    ...r,
    region: r.region?.nom ?? "",
  }));
  return buildExportBuffer(mapped, EXPORT_COLUMNS);
}

function toNumber(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return isNaN(n) ? undefined : n;
}

async function importXlsx(buffer: Buffer, userId: string): Promise<ImportReport> {
  const rows = await parseImportBuffer(buffer);
  const report: ImportReport = { created: 0, errors: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Record<string, unknown>;
    const rowNum = i + 2; // ligne Excel reelle (entete = ligne 1)
    try {
      const regionId = await resolveRegionId(String(row["Région"] ?? ""));
      if (!regionId) throw new Error(`Région "${row["Région"]}" introuvable`);

      const payload = tronconCreateSchema.parse({
        code: String(row["Code"] ?? "").trim(),
        nom: String(row["Nom"] ?? "").trim(),
        classe: String(row["Classe"] ?? "").trim(),
        regionId,
        longueurKm: toNumber(row["Longueur (km)"]),
        revetement: String(row["Revêtement"] ?? "").trim(),
        etat: row["État"] ? String(row["État"]).trim() : undefined,
        pkDebut: toNumber(row["PK Début"]) ?? 0,
        pkFin: toNumber(row["PK Fin"]) ?? 0,
        traficMoyenJma: toNumber(row["Trafic moyen (jma)"]),
      });

      const existing = await prisma.troncon.findUnique({ where: { code: payload.code } });
      if (existing) await base.update(existing.id, payload, userId);
      else await base.create(payload, userId);
      report.created++;
    } catch (err) {
      report.errors.push({ row: rowNum, message: formatImportError(err) });
    }
  }
  return report;
}

// Fiche consolidee : le troncon + tout ce qui lui est rattache (vue patrimoniale).
async function fiche(id: string) {
  const troncon = await base.getById(id);
  const notDeleted = { tronconId: id, deletedAt: null };
  const [ouvrages, pointsNoirs, postes, chantiers, inspections] = await Promise.all([
    prisma.ouvrage.findMany({ where: notDeleted, orderBy: { nom: "asc" } }),
    prisma.pointNoir.findMany({ where: notDeleted, orderBy: { createdAt: "desc" } }),
    prisma.poste.findMany({ where: notDeleted, orderBy: { nom: "asc" } }),
    prisma.chantier.findMany({ where: notDeleted, orderBy: { createdAt: "desc" } }),
    prisma.inspection.findMany({
      where: { tronconId: id, deletedAt: null },
      include: { inspecteur: { select: { nomComplet: true } } },
      orderBy: { dateInspection: "desc" },
    }),
  ]);
  return { troncon, ouvrages, pointsNoirs, postes, chantiers, inspections };
}

async function createWithGeom(data: TronconCreateInput & { geom?: { type: string; coordinates: number[][] } }, userId: string) {
  const { geom, ...rest } = data;
  const record = await base.create(rest, userId);
  if (geom) await setLineGeom(record.id as string, geom);
  return record;
}

async function updateWithGeom(id: string, data: Partial<TronconCreateInput & { geom?: { type: string; coordinates: number[][] } }>, userId: string) {
  const { geom, ...rest } = data;
  const record = await base.update(id, rest, userId);
  if (geom) await setLineGeom(id, geom);
  return record;
}

async function updateGeomOnly(id: string, geom: { type: string; coordinates: number[][] }): Promise<void> {
  await setLineGeom(id, geom);
}

export const tronconsService = { ...base, list, listGeo, exportXlsx, importXlsx, fiche, itineraire, createWithGeom, updateWithGeom, updateGeomOnly };
