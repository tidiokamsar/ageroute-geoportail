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
/**
 * L'ancre regionale se CALCULE, elle n'est plus codee.
 *
 * POURQUOI CE CHANGEMENT
 *
 * Une table de huit couples codes en dur (`REGION_CENTROIDS`) portait la position de
 * repli des chantiers connus a la region pres. Deux consequences :
 *
 * D'ABORD, toute reforme administrative devenait une modification de code. Le decret
 * du 05/09/2026 cree les regions de Siguiri et de Beyla, et promeut onze
 * sous-prefectures en prefectures. Avec la table codee, leurs chantiers seraient
 * tombes hors carte tant que personne n'aurait edite ce fichier.
 *
 * ENSUITE, la table etait muette sur ce qu'elle contenait vraiment : les chefs-lieux
 * regionaux, pas des centres de region. L'ecart mesure entre les deux va de 3,5 km
 * (Conakry) a 71,4 km (Nzerekore). Ce n'etait pas faux — les deux points tombent bien
 * dans leur region — mais un chantier « en region de Nzerekore, position inconnue »
 * epingle sur la ville de Nzerekore laisse croire qu'il s'y trouve.
 *
 * CE QU'ON CALCULE, ET POURQUOI PAS LE CENTROIDE
 *
 * `ST_PointOnSurface` et non `ST_Centroid` : le centroide d'une region concave tombe
 * hors de la region. Sur une carte, une epingle posee dans le pays voisin est pire
 * qu'une absence d'epingle. `ST_PointOnSurface` garantit un point INTERIEUR.
 *
 * Une region sans limite chargee n'a pas d'ancre : ses chantiers sortent de la carte
 * et rejoignent la liste « sans localisation ». C'est le comportement voulu — mieux
 * vaut une absence qu'une position inventee.
 */

async function listGeo() {
  const rows = await prisma.$queryRaw<
    {
      id: string; intitule: string; statut: string; avancementPct: number; region: string | null;
      entreprise: string | null; bailleur: string | null; montantGnf: string | null;
      numContrat: string | null; observations: string | null;
      tronconId: string | null; pkDebut: number | null; pkFin: number | null;
      geometry: string | null;
      ancreLat: number | null; ancreLon: number | null;
    }[]
  >`
    SELECT c.id, c.intitule, c.statut, c."avancementPct", r.nom AS region,
           c.entreprise, c.bailleur, c."montantGnf"::text AS "montantGnf", c."numContrat", c.observations,
           c."tronconId", c."pkDebut", c."pkFin",
           ST_AsGeoJSON(c.geom) AS geometry,
           -- Ancre calculee sur la limite officielle de la region. Jointure sans
           -- accents ni casse : la source COD-AB ecrit « Boke » et « Nzerekore »
           -- la ou le referentiel ecrit « Boké » et « Nzérékoré ».
           ST_Y(ST_PointOnSurface(la.geom)) AS "ancreLat",
           ST_X(ST_PointOnSurface(la.geom)) AS "ancreLon"
    FROM chantiers c
    LEFT JOIN regions r ON r.id = c."regionId"
    LEFT JOIN limites_admin la
      ON la.niveau = 1 AND unaccent(lower(la.nom)) = unaccent(lower(r.nom))
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

      /**
       * Pas de limite chargee pour cette region : pas d'ancre, donc pas d'epingle.
       *
       * Le code precedent repliait sur Conakry (`|| REGION_CENTROIDS.Conakry`) tout en
       * affichant « Position regionale, non localisee · region Nzerekore » : l'epingle
       * et l'etiquette se contredisaient. Une absence assumee vaut mieux.
       *
       * Le chantier n'est pas perdu pour autant : `listSansLocalisation` le recueille,
       * par le meme critere — c'est ce qui empeche qu'un retrait de la carte devienne
       * un effacement.
       */
      if (r.ancreLat == null || r.ancreLon == null) return null;
      const centroid: [number, number] = [r.ancreLat, r.ancreLon];
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
      -- Le troisieme cas est le pendant obligatoire du retrait cote carte : un chantier
      -- dont la region n'a pas de limite chargee n'a pas d'ancre, sort de la carte, et
      -- doit donc entrer ici. Sans cette ligne il ne serait nulle part — et retirer un
      -- chantier de la carte sans le montrer ailleurs revient a l'effacer.
      --
      -- Le critere est le MEME des deux cotes (absence de polygone de niveau 1), et non
      -- deux listes a tenir en parallele : c'est ce qui garantit qu'aucun chantier ne
      -- tombe entre les deux.
      AND (r.nom IS NULL
           OR r.nom = ${REGION_NON_RENSEIGNEE}
           OR NOT EXISTS (
                SELECT 1 FROM limites_admin la
                 WHERE la.niveau = 1
                   AND unaccent(lower(la.nom)) = unaccent(lower(r.nom))))
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
