import { prisma } from "../../lib/prisma";
import { createCrudService, type ListParams } from "../../lib/crud-factory";
import { buildExportBuffer, parseImportBuffer, formatImportError, type ImportReport } from "../../lib/excel";
import { resolveRegionId } from "../../lib/regions";
import { setPointGeom, getPointLatLon, deriveGeomFromTroncon } from "../../lib/geo";
import { ApiError } from "../../middleware/error.middleware";
import { createPhotoService } from "../../lib/photos";
import { ouvrageCreateSchema } from "./ouvrages.schema";

const base = createCrudService(prisma.ouvrage, "Ouvrage", { region: true, troncon: true });
const photos = createPhotoService(prisma.ouvrage, "Ouvrage");

function extractLatLon<T extends { lat?: number; lon?: number }>(data: T) {
  const { lat, lon, ...rest } = data;
  return { lat, lon, rest };
}

async function getById(id: string) {
  const item = await base.getById(id);
  const point = await getPointLatLon("ouvrages", id);
  return { ...item, lat: point?.lat ?? null, lon: point?.lon ?? null };
}

async function create(data: Parameters<typeof ouvrageCreateSchema.parse>[0] & { lat?: number; lon?: number }, userId: string) {
  const { lat, lon, rest } = extractLatLon(data as { lat?: number; lon?: number } & Record<string, unknown>);
  const created = await base.create(rest, userId);
  if (lat != null && lon != null) await setPointGeom("ouvrages", created.id, lat, lon);
  return created;
}

async function update(id: string, data: { lat?: number; lon?: number } & Record<string, unknown>, userId: string) {
  const { lat, lon, rest } = extractLatLon(data);
  const updated = await base.update(id, rest, userId);
  if (lat != null && lon != null) await setPointGeom("ouvrages", id, lat, lon);
  return updated;
}

async function geolocateFromTroncon(id: string) {
  const item = await base.getById(id) as { tronconId?: string | null; pk?: number | null };
  if (!item.tronconId || item.pk == null) {
    throw new ApiError(400, "Cet ouvrage doit avoir un tronçon rattaché et un PK pour être géolocalisé automatiquement.");
  }
  const ok = await deriveGeomFromTroncon("ouvrages", id, item.tronconId, item.pk);
  if (!ok) throw new ApiError(400, "Géolocalisation impossible : tracé du tronçon indisponible.");
  return getPointLatLon("ouvrages", id);
}

interface OuvrageListParams extends ListParams {
  search?: string;
  region?: string;
  etat?: string;
  type?: string;
}

async function list(params: OuvrageListParams) {
  const where: Record<string, unknown> = { ...params.where };
  if (params.region) where.region = { nom: params.region };
  if (params.etat) where.etat = params.etat;
  if (params.type) where.type = params.type;
  if (params.search) where.nom = { contains: params.search, mode: "insensitive" };
  return base.list({ ...params, where });
}

// Prisma ne lit pas nativement les colonnes "Unsupported(geometry...)" : requete brute
// pour exposer lat/lon (ST_Y/ST_X) au Geoportail, sur le modele de l'ancienne vue v_ouvrages.
async function listGeo() {
  return prisma.$queryRaw`
    SELECT o.id, o.nom, o.type, o.etat, r.nom AS region,
           ST_Y(o.geom) AS lat, ST_X(o.geom) AS lon,
           o.pk, o."ficheNumero", o.code, t.code AS "tronconCode", t.nom AS "tronconNom",
           o."longueurM", o."largeurM", o."hauteurM", o."nbTravees", o."longueurTravee",
           o."materiauAppuis", o."materiauTablier", o."materiauPiles", o."materiauAutre",
           o."anneeConstruction", o."gabaritT", o.remarques, o."travauxAPrevoir"
    FROM ouvrages o
    LEFT JOIN regions r ON r.id = o."regionId"
    LEFT JOIN troncons t ON t.id = o."tronconId"
    WHERE o."deletedAt" IS NULL AND o.geom IS NOT NULL
  `;
}

const EXPORT_COLUMNS = [
  { key: "nom", header: "Nom" },
  { key: "type", header: "Type" },
  { key: "etat", header: "État" },
  { key: "region", header: "Région" },
  { key: "tronconCode", header: "Code tronçon" },
  { key: "pk", header: "PK" },
  { key: "longueurM", header: "Longueur (m)" },
  { key: "gabaritT", header: "Gabarit (t)" },
  { key: "anneeConstruction", header: "Année construction" },
  { key: "materiau", header: "Matériau" },
  { key: "ficheNumero", header: "N° fiche" },
  { key: "code", header: "Code" },
  { key: "largeurM", header: "Largeur (m)" },
  { key: "hauteurM", header: "Hauteur (m)" },
  { key: "nbTravees", header: "Nb travées" },
  { key: "longueurTravee", header: "Longueur travée (m)" },
  { key: "materiauAppuis", header: "Matériau appuis/murs" },
  { key: "materiauTablier", header: "Matériau tablier" },
  { key: "materiauPiles", header: "Matériau piles" },
  { key: "materiauAutre", header: "Matériau autre" },
  { key: "remarques", header: "Remarques particulières" },
  { key: "travauxAPrevoir", header: "Travaux / réparations à prévoir" },
];

async function exportXlsx(): Promise<Buffer> {
  const rows = await prisma.ouvrage.findMany({
    where: { deletedAt: null },
    include: { region: true, troncon: true },
    orderBy: { nom: "asc" },
  });
  const mapped = rows.map((r: { region: { nom: string } | null; troncon: { code: string } | null } & Record<string, unknown>) => ({
    ...r,
    region: r.region?.nom ?? "",
    tronconCode: r.troncon?.code ?? "",
  }));
  return buildExportBuffer(mapped, EXPORT_COLUMNS);
}

function toNumber(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return isNaN(n) ? undefined : n;
}

async function importXlsx(buffer: Buffer, userId: string): Promise<{ created: number; errors: { row: number; message: string }[] }> {
  const rows = await parseImportBuffer(buffer);
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

      const payload = ouvrageCreateSchema.parse({
        nom: String(row["Nom"] ?? "").trim(),
        type: String(row["Type"] ?? "").trim(),
        etat: row["État"] ? String(row["État"]).trim() : undefined,
        regionId,
        tronconId,
        pk: toNumber(row["PK"]),
        longueurM: toNumber(row["Longueur (m)"]),
        gabaritT: toNumber(row["Gabarit (t)"]),
        anneeConstruction: toNumber(row["Année construction"]),
        materiau: row["Matériau"] ? String(row["Matériau"]).trim() : undefined,
        ficheNumero: row["N° fiche"] ? String(row["N° fiche"]).trim() : undefined,
        code: row["Code"] ? String(row["Code"]).trim() : undefined,
        largeurM: toNumber(row["Largeur (m)"]),
        hauteurM: toNumber(row["Hauteur (m)"]),
        nbTravees: toNumber(row["Nb travées"]),
        longueurTravee: toNumber(row["Longueur travée (m)"]),
        materiauAppuis: row["Matériau appuis/murs"] ? String(row["Matériau appuis/murs"]).trim() : undefined,
        materiauTablier: row["Matériau tablier"] ? String(row["Matériau tablier"]).trim() : undefined,
        materiauPiles: row["Matériau piles"] ? String(row["Matériau piles"]).trim() : undefined,
        materiauAutre: row["Matériau autre"] ? String(row["Matériau autre"]).trim() : undefined,
        remarques: row["Remarques particulières"] ? String(row["Remarques particulières"]).trim() : undefined,
        travauxAPrevoir: row["Travaux / réparations à prévoir"] ? String(row["Travaux / réparations à prévoir"]).trim() : undefined,
      });

      await base.create(payload, userId);
      report.created++;
    } catch (err) {
      report.errors.push({ row: rowNum, message: formatImportError(err) });
    }
  }
  return report;
}

export const ouvragesService = {
  ...base, list, listGeo, exportXlsx, importXlsx, getById, create, update, geolocateFromTroncon,
  addPhoto: photos.addPhoto, removePhoto: photos.removePhoto,
};
