import { prisma } from "../../lib/prisma";
import { localisationDe, REGION_NON_RENSEIGNEE } from "../../lib/localisation";
import { createCrudService, type ListParams } from "../../lib/crud-factory";
import { buildExportBuffer, parseImportBuffer, formatImportError, type ImportReport } from "../../lib/excel";
import { resolveRegionId } from "../../lib/regions";
import { deriveChantierGeom } from "../../lib/geo";
import { ApiError } from "../../middleware/error.middleware";
import { chantierCreateSchema } from "./chantiers.schema";

const base = createCrudService(prisma.chantier, "Chantier", { region: true, troncon: true });

// Si le chantier reference un troncon + un PK debut/fin, sa geometrie est extraite du trace
// reel du troncon (referencement lineaire) au lieu d'etre dessinee a la main.
async function applyLinearGeom(id: string, data: { tronconId?: string; pkDebut?: number; pkFin?: number }) {
  if (data.tronconId && data.pkDebut != null && data.pkFin != null) {
    await deriveChantierGeom(id, data.tronconId, data.pkDebut, data.pkFin);
  }
}

// Si aucune regionId n'est fournie mais qu'un troncon est rattache (cas du bouton rapide
// "Signaler des travaux" depuis la fiche carte, qui ne demande pas la region a l'utilisateur
// puisqu'elle decoule naturellement du troncon), on la deduit du troncon plutot que d'echouer.
async function resolveCreateRegion(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (data.regionId != null) return data;
  const tronconId = data.tronconId as string | undefined;
  if (!tronconId) throw new ApiError(400, "regionId ou tronconId requis");
  const troncon = await prisma.troncon.findUnique({ where: { id: tronconId }, select: { regionId: true } });
  if (!troncon) throw new ApiError(404, "Tronçon introuvable");
  return { ...data, regionId: troncon.regionId };
}

async function create(data: Record<string, unknown>, userId: string) {
  const withRegion = await resolveCreateRegion(data);
  const created = await base.create(withRegion, userId);
  await applyLinearGeom(created.id, withRegion as { tronconId?: string; pkDebut?: number; pkFin?: number });
  return created;
}

async function update(id: string, data: Record<string, unknown>, userId: string) {
  const updated = await base.update(id, data, userId);
  // tronconId peut ne pas etre renvoye dans une mise a jour partielle (ex: edition du seul PK) :
  // on retombe sur la valeur deja en base pour ne pas laisser la geometrie desynchronisee en silence.
  const tronconId = (data.tronconId as string | undefined) ?? (updated as { tronconId?: string }).tronconId;
  await applyLinearGeom(id, { ...(data as { pkDebut?: number; pkFin?: number }), tronconId });
  return updated;
}

interface ChantierListParams extends ListParams {
  search?: string;
  region?: string;
  etat?: string;
}

async function list(params: ChantierListParams) {
  const where: Record<string, unknown> = { ...params.where };
  if (params.region) where.region = { nom: params.region };
  if (params.etat === "EN_RETARD") {
    where.statut = "EN_COURS";
    where.dateFinPrevue = { lt: new Date() };
  } else if (params.etat) {
    where.statut = params.etat;
  }
  if (params.search) where.intitule = { contains: params.search, mode: "insensitive" };
  return base.list({ ...params, where });
}

// Tous statuts confondus (pas seulement EN_COURS) : les chantiers termines doivent rester
// visibles sur la carte (historique des travaux realises), distingues par couleur/style
// cote frontend plutot que d'etre purement et simplement masques.
// Centroides approximatifs des regions (capitales regionales) : la plupart des 484
// chantiers importes depuis le tableau de contrats n'ont qu'une "zone" (region/prefecture),
// pas de troncon/PK precis -> impossible de tracer un trajet reel. Plutot que de les
// laisser invisibles sur la carte, on les positionne au centre approximatif de leur region
// (point, pas une ligne), avec un flag "approximate" pour que le frontend les distingue
// clairement des chantiers a tracé reel.
const REGION_CENTROIDS: Record<string, [number, number]> = {
  Conakry: [9.6412, -13.5784],
  Boké: [10.9333, -14.3],
  Kindia: [10.05, -12.85],
  Mamou: [10.3833, -12.0833],
  Labé: [11.3167, -12.2833],
  Faranah: [10.0333, -10.75],
  Kankan: [10.3833, -9.3],
  Nzérékoré: [7.75, -8.8167],
};

async function listGeo() {
  const rows = await prisma.$queryRaw<
    {
      id: string; intitule: string; statut: string; avancementPct: number; region: string | null;
      entreprise: string | null; bailleur: string | null; montantGnf: string | null;
      numContrat: string | null; observations: string | null;
      tronconId: string | null; pkDebut: number | null; pkFin: number | null;
      geometry: string | null;
    }[]
  >`
    SELECT c.id, c.intitule, c.statut, c."avancementPct", r.nom AS region,
           c.entreprise, c.bailleur, c."montantGnf"::text AS "montantGnf", c."numContrat", c.observations,
           c."tronconId", c."pkDebut", c."pkFin",
           ST_AsGeoJSON(c.geom) AS geometry
    FROM chantiers c
    LEFT JOIN regions r ON r.id = c."regionId"
    WHERE c."deletedAt" IS NULL
  `;
  return rows
    .map((r) => {
      const loc = localisationDe({
        aGeometrie: !!r.geometry,
        tronconId: r.tronconId ?? null,
        pkDebut: r.pkDebut ?? null,
        pkFin: r.pkFin ?? null,
        regionNom: r.region,
      });

      // Un chantier sans localisation ne va PAS sur la carte.
      //
      // La version precedente le repliait sur le centroide de Conakry, au motif de le
      // garder visible et cliquable, en le marquant « approximate ». Mais aucune
      // etiquette ne rend honnete une epingle a Conakry pour un chantier peut-etre
      // situe a Nzerekore : 50 chantiers sont rattaches a l'entree « Non renseigne »,
      // qui n'est pas une region. C'est une position inventee, et le §17 du cahier des
      // charges l'interdit.
      //
      // Ils restent accessibles par la liste « chantiers sans localisation », qui les
      // rend visibles SANS leur preter une position.
      if (!loc.cartographiable) return null;

      if (r.geometry) {
        return { ...r, approximate: false, lat: null, lon: null, localisation: loc.statut, localisationLibelle: loc.libelle };
      }

      const centroid = (r.region && REGION_CENTROIDS[r.region]) || REGION_CENTROIDS.Conakry;
      // Dispersion deterministe (hash de l'id) autour du centroide : sans ca, des dizaines
      // de chantiers de la meme region se superposeraient exactement au meme pixel.
      let hash = 0;
      for (let i = 0; i < r.id.length; i++) hash = (hash * 31 + r.id.charCodeAt(i)) % 100000;
      const jitterLat = ((hash % 200) - 100) / 100 / 6; // +/- ~0.17°
      const jitterLon = (((hash / 200) % 200) - 100) / 100 / 6;
      return {
        ...r,
        approximate: true,
        lat: centroid[0] + jitterLat,
        lon: centroid[1] + jitterLon,
        localisation: loc.statut,
        localisationLibelle: loc.libelle,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
}

/**
 * Les chantiers qu'aucune position ne permet de placer.
 *
 * Ils ne disparaissent pas : ils cessent d'etre montres a un endroit faux. Cette
 * liste est le pendant necessaire de leur retrait de la carte — sans elle, retirer
 * les 50 reviendrait a les effacer.
 */
async function listSansLocalisation() {
  const rows = await prisma.$queryRaw<
    { id: string; intitule: string; statut: string; entreprise: string | null; region: string | null }[]
  >`
    SELECT c.id, c.intitule, c.statut, c.entreprise, r.nom AS region
    FROM chantiers c
    LEFT JOIN regions r ON r.id = c."regionId"
    WHERE c."deletedAt" IS NULL
      AND c.geom IS NULL
      AND c."tronconId" IS NULL
      AND (r.nom IS NULL OR r.nom = ${REGION_NON_RENSEIGNEE})
    ORDER BY c.intitule
  `;
  return rows.map((r) => ({ ...r, motif: "Aucune région exploitable — position inconnue" }));
}

const EXPORT_COLUMNS = [
  { key: "intitule", header: "Intitulé" },
  { key: "entreprise", header: "Entreprise" },
  { key: "bailleur", header: "Bailleur" },
  { key: "region", header: "Région" },
  { key: "tronconCode", header: "Code tronçon" },
  { key: "statut", header: "Statut" },
  { key: "avancementPct", header: "Avancement (%)" },
  { key: "dateDebutPrevue", header: "Date début prévue" },
  { key: "dateFinPrevue", header: "Date fin prévue" },
  { key: "montantGnf", header: "Montant (GNF)" },
  { key: "numContrat", header: "N° contrat" },
  { key: "observations", header: "Observations" },
];

async function exportXlsx(): Promise<Buffer> {
  const rows = await prisma.chantier.findMany({
    where: { deletedAt: null },
    include: { region: true, troncon: true },
    orderBy: { createdAt: "desc" },
  });
  const mapped = rows.map((r: { region: { nom: string } | null; troncon: { code: string } | null; montantGnf: bigint | null } & Record<string, unknown>) => ({
    ...r,
    region: r.region?.nom ?? "",
    tronconCode: r.troncon?.code ?? "",
    montantGnf: r.montantGnf != null ? Number(r.montantGnf) : "",
  }));
  return buildExportBuffer(mapped, EXPORT_COLUMNS);
}

async function importXlsx(buffer: Buffer, userId: string): Promise<ImportReport> {
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

      const montant = row["Montant (GNF)"];
      const payload = chantierCreateSchema.parse({
        intitule: String(row["Intitulé"] ?? "").trim(),
        entreprise: String(row["Entreprise"] ?? "").trim(),
        bailleur: row["Bailleur"] ? String(row["Bailleur"]).trim() : undefined,
        regionId,
        tronconId,
        statut: row["Statut"] ? String(row["Statut"]).trim() : undefined,
        avancementPct: row["Avancement (%)"] ? Number(row["Avancement (%)"]) : undefined,
        dateDebutPrevue: row["Date début prévue"] ? new Date(String(row["Date début prévue"])) : undefined,
        dateFinPrevue: row["Date fin prévue"] ? new Date(String(row["Date fin prévue"])) : undefined,
        montantGnf: montant !== null && montant !== undefined && montant !== "" ? Number(montant) : undefined,
      });

      await base.create(payload, userId);
      report.created++;
    } catch (err) {
      report.errors.push({ row: rowNum, message: formatImportError(err) });
    }
  }
  return report;
}

export const chantiersService = { ...base, list, listGeo, listSansLocalisation, exportXlsx, importXlsx, create, update };
