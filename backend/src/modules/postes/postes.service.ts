import { prisma } from "../../lib/prisma";
import { createCrudService, type ListParams } from "../../lib/crud-factory";
import { buildExportBuffer, parseImportBuffer, formatImportError, type ImportReport } from "../../lib/excel";
import { resolveRegionId } from "../../lib/regions";
import { setPointGeom, getPointLatLon, deriveGeomFromTroncon } from "../../lib/geo";
import { ApiError } from "../../middleware/error.middleware";
import { posteCreateSchema } from "./postes.schema";

const base = createCrudService(prisma.poste, "Poste", { region: true, troncon: true });

function extractLatLon(data: { lat?: number; lon?: number } & Record<string, unknown>) {
  const { lat, lon, ...rest } = data;
  return { lat, lon, rest };
}

async function getById(id: string) {
  const item = await base.getById(id);
  const point = await getPointLatLon("postes", id);
  return { ...item, lat: point?.lat ?? null, lon: point?.lon ?? null };
}

async function create(data: { lat?: number; lon?: number } & Record<string, unknown>, userId: string) {
  const { lat, lon, rest } = extractLatLon(data);
  const created = await base.create(rest, userId);
  if (lat != null && lon != null) await setPointGeom("postes", created.id, lat, lon);
  return created;
}

async function update(id: string, data: { lat?: number; lon?: number } & Record<string, unknown>, userId: string) {
  const { lat, lon, rest } = extractLatLon(data);
  const updated = await base.update(id, rest, userId);
  if (lat != null && lon != null) await setPointGeom("postes", id, lat, lon);
  return updated;
}

async function geolocateFromTroncon(id: string) {
  const item = (await base.getById(id)) as { tronconId?: string | null; pk?: number | null };
  if (!item.tronconId || item.pk == null) {
    throw new ApiError(400, "Ce poste doit avoir un tronçon rattaché et un PK pour être géolocalisé automatiquement.");
  }
  const ok = await deriveGeomFromTroncon("postes", id, item.tronconId, item.pk);
  if (!ok) throw new ApiError(400, "Géolocalisation impossible : tracé du tronçon indisponible.");
  return getPointLatLon("postes", id);
}

interface PosteListParams extends ListParams {
  search?: string;
  region?: string;
  type?: string;
}

async function list(params: PosteListParams) {
  const where: Record<string, unknown> = { ...params.where };
  if (params.region) where.region = { nom: params.region };
  if (params.type) where.type = params.type;
  if (params.search) where.nom = { contains: params.search, mode: "insensitive" };
  return base.list({ ...params, where });
}

async function listGeo() {
  return prisma.$queryRaw`
    SELECT p.id, p.nom, p.type, p.statut, r.nom AS region,
           ST_Y(p.geom) AS lat, ST_X(p.geom) AS lon
    FROM postes p
    LEFT JOIN regions r ON r.id = p."regionId"
    WHERE p."deletedAt" IS NULL AND p.geom IS NOT NULL
  `;
}

const EXPORT_COLUMNS = [
  { key: "nom", header: "Nom" },
  { key: "type", header: "Type" },
  { key: "region", header: "Région" },
  { key: "tronconCode", header: "Code tronçon" },
  { key: "pk", header: "PK" },
  { key: "statut", header: "Statut" },
  { key: "traficJma", header: "Trafic (jma)" },
  { key: "recettesMensuellesGnf", header: "Recettes mensuelles (GNF)" },
];

async function exportXlsx(): Promise<Buffer> {
  const rows = await prisma.poste.findMany({
    where: { deletedAt: null },
    include: { region: true, troncon: true },
    orderBy: { nom: "asc" },
  });
  const mapped = rows.map((r: { region: { nom: string } | null; troncon: { code: string } | null; recettesMensuellesGnf: bigint | null } & Record<string, unknown>) => ({
    ...r,
    region: r.region?.nom ?? "",
    tronconCode: r.troncon?.code ?? "",
    recettesMensuellesGnf: r.recettesMensuellesGnf != null ? Number(r.recettesMensuellesGnf) : "",
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

      const recettes = row["Recettes mensuelles (GNF)"];
      const payload = posteCreateSchema.parse({
        nom: String(row["Nom"] ?? "").trim(),
        type: String(row["Type"] ?? "").trim(),
        regionId,
        tronconId,
        pk: row["PK"] !== undefined && row["PK"] !== "" && !isNaN(Number(row["PK"])) ? Number(row["PK"]) : undefined,
        statut: row["Statut"] ? String(row["Statut"]).trim() : undefined,
        traficJma: row["Trafic (jma)"] ? Number(row["Trafic (jma)"]) : undefined,
        recettesMensuellesGnf: recettes !== null && recettes !== undefined && recettes !== "" ? Number(recettes) : undefined,
      });

      await base.create(payload, userId);
      report.created++;
    } catch (err) {
      report.errors.push({ row: rowNum, message: formatImportError(err) });
    }
  }
  return report;
}

export const postesService = { ...base, list, listGeo, exportXlsx, importXlsx, getById, create, update, geolocateFromTroncon };
