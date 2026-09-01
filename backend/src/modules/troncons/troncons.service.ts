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

// Geometrie LineString exposee en GeoJSON pour le Geoportail (Prisma ne lit pas les
// colonnes "Unsupported(geometry...)" nativement).
async function listGeo() {
  return prisma.$queryRaw`
    SELECT t.id, t.code, t.nom, t.classe, t.etat, t."longueurKm", r.nom AS region,
           t.revetement, t."pkDebut", t."pkFin", t."traficMoyenJma",
           ST_AsGeoJSON(t.geom) AS geometry
    FROM troncons t
    LEFT JOIN regions r ON r.id = t."regionId"
    WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL
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
