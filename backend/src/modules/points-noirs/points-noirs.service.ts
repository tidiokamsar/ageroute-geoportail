import { prisma } from "../../lib/prisma";
import { createCrudService, type ListParams } from "../../lib/crud-factory";
import { buildExportBuffer, parseImportBuffer, formatImportError, type ImportReport } from "../../lib/excel";
import { resolveRegionId } from "../../lib/regions";
import { setPointGeom, getPointLatLon, deriveGeomFromTroncon } from "../../lib/geo";
import { ApiError } from "../../middleware/error.middleware";
import { pointNoirCreateSchema } from "./points-noirs.schema";

const base = createCrudService(prisma.pointNoir, "PointNoir", { region: true, troncon: true });

function extractLatLon(data: { lat?: number; lon?: number } & Record<string, unknown>) {
  const { lat, lon, ...rest } = data;
  return { lat, lon, rest };
}

async function getById(id: string) {
  const item = await base.getById(id);
  const point = await getPointLatLon("points_noirs", id);
  return { ...item, lat: point?.lat ?? null, lon: point?.lon ?? null };
}

async function create(data: { lat?: number; lon?: number } & Record<string, unknown>, userId: string) {
  const { lat, lon, rest } = extractLatLon(data);
  const created = await base.create(rest, userId);
  if (lat != null && lon != null) await setPointGeom("points_noirs", created.id, lat, lon);
  return created;
}

async function update(id: string, data: { lat?: number; lon?: number } & Record<string, unknown>, userId: string) {
  const { lat, lon, rest } = extractLatLon(data);
  const updated = await base.update(id, rest, userId);
  if (lat != null && lon != null) await setPointGeom("points_noirs", id, lat, lon);
  return updated;
}

async function geolocateFromTroncon(id: string) {
  const item = await base.getById(id) as { tronconId?: string | null; pk?: number | null };
  if (!item.tronconId || item.pk == null) {
    throw new ApiError(400, "Ce point noir doit avoir un tronçon rattaché et un PK pour être géolocalisé automatiquement.");
  }
  const ok = await deriveGeomFromTroncon("points_noirs", id, item.tronconId, item.pk);
  if (!ok) throw new ApiError(400, "Géolocalisation impossible : tracé du tronçon indisponible.");
  return getPointLatLon("points_noirs", id);
}

interface PointNoirListParams extends ListParams {
  search?: string;
  region?: string;
}

async function list(params: PointNoirListParams) {
  const where: Record<string, unknown> = { ...params.where };
  if (params.region) where.region = { nom: params.region };
  if (params.search) where.description = { contains: params.search, mode: "insensitive" };
  return base.list({ ...params, where });
}

async function listGeo() {
  return prisma.$queryRaw`
    SELECT p.id, p.description, p.gravite, r.nom AS region,
           ST_Y(p.geom) AS lat, ST_X(p.geom) AS lon
    FROM points_noirs p
    LEFT JOIN regions r ON r.id = p."regionId"
    WHERE p."deletedAt" IS NULL AND p.geom IS NOT NULL
  `;
}

const EXPORT_COLUMNS = [
  { key: "description", header: "Description" },
  { key: "region", header: "Région" },
  { key: "tronconCode", header: "Code tronçon" },
  { key: "pk", header: "PK" },
  { key: "gravite", header: "Gravité" },
  { key: "nbAccidents", header: "Nb accidents" },
  { key: "causes", header: "Causes" },
  { key: "mesuresCorrectives", header: "Mesures correctives" },
];

async function exportXlsx(): Promise<Buffer> {
  const rows = await prisma.pointNoir.findMany({
    where: { deletedAt: null },
    include: { region: true, troncon: true },
    orderBy: { createdAt: "desc" },
  });
  const mapped = rows.map((r: { region: { nom: string } | null; troncon: { code: string } | null } & Record<string, unknown>) => ({
    ...r,
    region: r.region?.nom ?? "",
    tronconCode: r.troncon?.code ?? "",
  }));
  return buildExportBuffer(mapped, EXPORT_COLUMNS);
}

async function importXlsx(buffer: Buffer, userId: string): Promise<ImportReport> {
  const rows = parseImportBuffer(buffer);
  const report: ImportReport = { created: 0, errors: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Record<string, unknown>;
    const rowNum = i + 2;
    try {
      const regionId = await resolveRegionId(String(row["Région"] ?? ""));
      if (!regionId) throw new Error(`Région "${row["Région"]}" introuvable`);

      let tronconId: string | undefined;
      const code = row["Code tronçon"] ? String(row["Code tronçon"]).trim() : "";
      if (code) {
        const troncon = await prisma.troncon.findUnique({ where: { code } });
        if (!troncon) throw new Error(`Tronçon "${code}" introuvable`);
        tronconId = troncon.id;
      }

      const payload = pointNoirCreateSchema.parse({
        description: String(row["Description"] ?? "").trim(),
        regionId,
        tronconId,
        pk: row["PK"] !== undefined && row["PK"] !== "" && !isNaN(Number(row["PK"])) ? Number(row["PK"]) : undefined,
        gravite: String(row["Gravité"] ?? "").trim(),
        nbAccidents: Number(row["Nb accidents"] ?? 0) || 0,
        causes: row["Causes"] ? String(row["Causes"]).trim() : undefined,
        mesuresCorrectives: row["Mesures correctives"] ? String(row["Mesures correctives"]).trim() : undefined,
      });

      await base.create(payload, userId);
      report.created++;
    } catch (err) {
      report.errors.push({ row: rowNum, message: formatImportError(err) });
    }
  }
  return report;
}

export const pointsNoirsService = { ...base, list, listGeo, exportXlsx, importXlsx, getById, create, update, geolocateFromTroncon };
