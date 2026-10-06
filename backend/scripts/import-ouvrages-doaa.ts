/**
 * Import des ouvrages releves dans les documents de la DOA&A (Direction des Ouvrages
 * d'Art et d'Assainissement), lus le 06/10/2026 : rapports de mission et de reception
 * qui donnent, pour chaque ouvrage, un repere, une section et des coordonnees GPS.
 *
 * Pourquoi ici : le Geoportail est le referentiel geographique (cahier DigitalRoad
 * DOA&A, §2 et §21). L'espace SharePoint de la DOA&A garde le metier et reference
 * l'ouvrage par son ID SIG ; il ne doit pas porter sa propre position de reference.
 *
 * Ces ouvrages appartiennent a l'inventaire de l'agence (ce ne sont pas des donnees
 * reprises d'une source externe) mais leur position vient d'un document, pas d'un
 * releve de la Console : `sourceReference` commence par « doc_dtoaa: », ce qui les
 * signale « a valider » sur la carte publique. Etat NON_EVALUE : les documents
 * decrivent des desordres, pas une note d'etat.
 *
 * Rejouable : un ouvrage dont la `sourceReference` existe deja n'est pas recree.
 * SIMULATION par defaut ; APPLIQUER=1 pour ecrire.
 *
 * Usage : DOAA_JSON_PATH=/chemin/geoportail-doaa.json [APPLIQUER=1] tsx scripts/import-ouvrages-doaa.ts
 * Sortie : une ligne « code;id » par ouvrage (cree ou deja present), pour SharePoint.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const jsonPath = process.env.DOAA_JSON_PATH;
if (!jsonPath) {
  console.error("DOAA_JSON_PATH manquant.");
  process.exit(1);
}
const appliquer = process.env.APPLIQUER === "1";
const prisma = new PrismaClient();

const PREFIXE = "doc_dtoaa:";
const TYPES = new Set(["PONT", "DALOT", "BUSE", "PASSERELLE"]);
const CONFIANCES = new Set(["HIGH", "MEDIUM", "LOW"]);
// Bbox large de la Guinee, comme import-ouvrages-rn4.ts.
const LAT_RANGE = [6.5, 13];
const LON_RANGE = [-16, -7];
/** Au-dela, l'ouvrage n'est pas rattache a un troncon : on ne devine pas. */
const RATTACHEMENT_MAX_M = 2000;

interface Ligne {
  code: string;
  nom: string;
  type: string;
  route: string;
  region: string;
  lat: number;
  lon: number;
  pk: number | null;
  observations: string;
  source: string;
  confiance: string;
}

async function tronconProche(lat: number, lon: number, route: string) {
  const rows = await prisma.$queryRaw<{ id: string; regionId: number; distanceM: number }[]>`
    SELECT id, "regionId",
           ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography) AS "distanceM"
    FROM troncons
    WHERE nom = ${route} AND "deletedAt" IS NULL AND geom IS NOT NULL
    ORDER BY geom <-> ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Region du troncon le plus proche, toutes routes confondues : la geographie de la Console fait foi. */
async function regionProche(lat: number, lon: number) {
  const rows = await prisma.$queryRaw<{ regionId: number }[]>`
    SELECT "regionId" FROM troncons
    WHERE "deletedAt" IS NULL AND geom IS NOT NULL
    ORDER BY geom <-> ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)
    LIMIT 1
  `;
  return rows[0]?.regionId ?? null;
}

async function main() {
  const lignes = JSON.parse(readFileSync(jsonPath!, "utf-8")) as Ligne[];
  console.log(`Mode : ${appliquer ? "APPLICATION" : "SIMULATION"} — ${lignes.length} ligne(s) lue(s)`);

  const resultats: string[] = [];
  const erreurs: string[] = [];
  let crees = 0;
  let presents = 0;

  for (const l of lignes) {
    try {
      if (!l.code) throw new Error("code manquant");
      if (!TYPES.has(l.type)) throw new Error(`type inconnu « ${l.type} »`);
      if (!(l.lat >= LAT_RANGE[0] && l.lat <= LAT_RANGE[1] && l.lon >= LON_RANGE[0] && l.lon <= LON_RANGE[1])) {
        throw new Error(`coordonnees hors de Guinee (${l.lat}, ${l.lon})`);
      }
      const sourceReference = `${PREFIXE}${l.code}`;
      const existant = await prisma.ouvrage.findFirst({ where: { sourceReference, deletedAt: null }, select: { id: true } });
      if (existant) {
        presents++;
        resultats.push(`${l.code};${existant.id}`);
        continue;
      }

      const troncon = await tronconProche(l.lat, l.lon, l.route);
      const rattache = troncon && troncon.distanceM <= RATTACHEMENT_MAX_M ? troncon : null;
      let regionId = rattache?.regionId ?? (await regionProche(l.lat, l.lon));
      if (regionId == null) {
        const r = await prisma.region.findFirst({ where: { nom: l.region } });
        if (!r) throw new Error(`region introuvable « ${l.region} »`);
        regionId = r.id;
      }

      const detail = `troncon ${rattache ? `${l.route} a ${Math.round(rattache.distanceM)} m` : "non rattache"}, region ${regionId}`;
      if (!appliquer) {
        console.log(`  [simulation] ${l.code} : ${l.type}, ${detail}`);
        crees++;
        continue;
      }

      const cree = await prisma.ouvrage.create({
        data: {
          nom: l.nom,
          type: l.type as never,
          regionId,
          tronconId: rattache?.id,
          pk: l.pk ?? undefined,
          code: l.code,
          remarques: `${l.observations}\nSource : ${l.source}`.trim(),
          sourceType: "IMPORT_DOCUMENTE",
          sourceReference,
          sourceConfidence: CONFIANCES.has(l.confiance) ? (l.confiance as never) : undefined,
          sourceDetectedAt: new Date(),
        },
        select: { id: true },
      });
      await prisma.$executeRaw`UPDATE ouvrages SET geom = ST_SetSRID(ST_MakePoint(${l.lon}, ${l.lat}), 4326) WHERE id = ${cree.id}`;
      crees++;
      resultats.push(`${l.code};${cree.id}`);
      console.log(`  ${l.code} : cree (${detail})`);
    } catch (err) {
      erreurs.push(`${l.code || "?"} : ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`${appliquer ? "Crees" : "A creer"} : ${crees} ; deja presents : ${presents} ; erreurs : ${erreurs.length}`);
  for (const e of erreurs) console.log(`  ERREUR ${e}`);
  if (resultats.length) {
    console.log("--- CORRESPONDANCES code;id ---");
    for (const r of resultats) console.log(r);
  }
  if (erreurs.length) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("Erreur d'import :", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
