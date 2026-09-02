/**
 * Import de l'inventaire terrain reel des ouvrages d'art RN4 (Coyah - Forecariah),
 * fiche "Base de Donnees Mission Inventaire ouvrages". Coordonnees GPS directement
 * fournies dans la fiche (colonnes X/Y), donc geolocalisation immediate sans passer
 * par le PK.
 *
 * Le classeur doit etre au format .xlsx : exceljs ne lit pas le .xls binaire
 * (voir scripts/lib/excel-grid.ts). Convertir la fiche au prealable si besoin.
 *
 * Usage : INVENTAIRE_XLS_PATH=/chemin/fichier.xlsx tsx scripts/import-ouvrages-rn4.ts
 */
import { openWorkbook } from "./lib/excel-grid";
import { PrismaClient } from "@prisma/client";

const xlsPath = process.env.INVENTAIRE_XLS_PATH;
if (!xlsPath) {
  console.error("INVENTAIRE_XLS_PATH manquant.");
  process.exit(1);
}

const prisma = new PrismaClient();

const TYPE_MAP: Record<string, string> = { dalot: "DALOT", pont: "PONT" };

// Bbox large de la Guinee, pour rejeter les coordonnees visiblement corrompues
// (ex: chiffre manquant dans la saisie terrain) plutot que d'importer une position fausse.
const LAT_RANGE = [6.5, 13];
const LON_RANGE = [-16, -7];

function parsePk(raw: unknown): number | undefined {
  const s = String(raw ?? "").trim();
  if (!s) return undefined;
  const [km, m] = s.split("+");
  const kmNum = Number(km);
  const mNum = Number(m ?? 0);
  if (isNaN(kmNum) || isNaN(mNum)) return undefined;
  return kmNum + mNum / 1000;
}

function parseLat(raw: unknown): number | undefined {
  const n = Number(raw);
  if (isNaN(n) || n === 0) return undefined;
  return n / 1e6;
}

function parseLon(raw: unknown): number | undefined {
  const cleaned = String(raw ?? "").replace(/[^0-9.-]/g, "");
  if (!cleaned) return undefined;
  const n = Number(cleaned);
  if (isNaN(n) || n === 0) return undefined;
  return n / 1e6;
}

interface Row {
  ficheNumero?: string;
  pk?: number;
  nom?: string;
  type?: string;
  code?: string;
  lat?: number;
  lon?: number;
  longueurM?: number;
  largeurM?: number;
  hauteurM?: number;
  nbTravees?: number;
  longueurTravee?: number;
  materiauAppuis?: string;
  materiauTablier?: string;
  materiauPiles?: string;
  materiauAutre?: string;
  remarques?: string;
  travauxAPrevoir?: string;
}

async function readRows(): Promise<Row[]> {
  const wb = await openWorkbook(xlsPath!);
  const raw = wb.sheet("Tableau récapitulatif");
  const rows: Row[] = [];
  for (let i = 5; i < raw.length; i++) {
    const r = raw[i];
    const pkRaw = r[2];
    const nom = String(r[3] ?? "").trim();
    if (!pkRaw && !nom) continue; // fin des donnees reelles (ligne recap / vide)
    rows.push({
      ficheNumero: r[1] !== "" ? String(r[1]) : undefined,
      pk: parsePk(pkRaw),
      nom: nom || undefined,
      type: String(r[4] ?? "").trim(),
      code: r[5] !== "" ? String(r[5]) : undefined,
      lat: parseLat(r[6]),
      lon: parseLon(r[7]),
      longueurM: Number(r[8]) || undefined,
      largeurM: Number(r[9]) || undefined,
      hauteurM: Number(r[10]) || undefined,
      nbTravees: Number(r[11]) || undefined,
      longueurTravee: Number(r[12]) || undefined,
      materiauAppuis: r[13] ? String(r[13]) : undefined,
      materiauTablier: r[14] ? String(r[14]) : undefined,
      materiauPiles: r[15] ? String(r[15]) : undefined,
      materiauAutre: r[16] ? String(r[16]) : undefined,
      remarques: r[17] ? String(r[17]) : undefined,
      travauxAPrevoir: r[18] ? String(r[18]) : undefined,
    });
  }
  return rows;
}

async function findNearestRn4Troncon(lat: number, lon: number) {
  const rows = await prisma.$queryRaw<{ id: string; regionId: number }[]>`
    SELECT id, "regionId" FROM troncons
    WHERE nom = 'RN4' AND "deletedAt" IS NULL AND geom IS NOT NULL
    ORDER BY geom <-> ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function main() {
  const rows = await readRows();
  console.log(`Lignes lues : ${rows.length}`);

  let created = 0;
  const errors: { row: number; message: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      if (!r.type) throw new Error("Type manquant");
      const type = TYPE_MAP[r.type.toLowerCase()];
      if (!type) throw new Error(`Type d'ouvrage inconnu : "${r.type}"`);
      const nom = r.nom || `${r.type} PK ${r.pk ?? "?"}`;

      let regionId: number;
      let tronconId: string | undefined;
      let lat = r.lat;
      let lon = r.lon;

      if (lat != null && lon != null && lat >= LAT_RANGE[0] && lat <= LAT_RANGE[1] && lon >= LON_RANGE[0] && lon <= LON_RANGE[1]) {
        const nearest = await findNearestRn4Troncon(lat, lon);
        if (nearest) {
          regionId = nearest.regionId;
          tronconId = nearest.id;
        } else {
          const fallback = await prisma.region.findFirst({ where: { nom: "Kindia" } });
          regionId = fallback?.id ?? 1;
        }
      } else {
        lat = undefined;
        lon = undefined;
        const fallback = await prisma.region.findFirst({ where: { nom: "Kindia" } });
        regionId = fallback?.id ?? 1;
      }

      const created_ = await prisma.ouvrage.create({
        data: {
          nom,
          type: type as never,
          regionId,
          tronconId,
          pk: r.pk,
          longueurM: r.longueurM,
          largeurM: r.largeurM,
          hauteurM: r.hauteurM,
          nbTravees: r.nbTravees,
          longueurTravee: r.longueurTravee,
          materiauAppuis: r.materiauAppuis,
          materiauTablier: r.materiauTablier,
          materiauPiles: r.materiauPiles,
          materiauAutre: r.materiauAutre,
          remarques: r.remarques,
          travauxAPrevoir: r.travauxAPrevoir,
          ficheNumero: r.ficheNumero,
          code: r.code,
        },
      });

      if (lat != null && lon != null) {
        await prisma.$executeRaw`UPDATE ouvrages SET geom = ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326) WHERE id = ${created_.id}`;
      }

      created++;
    } catch (err) {
      errors.push({ row: i + 6, message: err instanceof Error ? err.message : "Erreur inconnue" });
    }
  }

  console.log(`Ouvrages crees : ${created}`);
  if (errors.length) {
    console.log(`Erreurs (${errors.length}) :`);
    for (const e of errors) console.log(`  ligne ${e.row} : ${e.message}`);
  }
}

main()
  .catch((err) => {
    console.error("Erreur d'import :", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
