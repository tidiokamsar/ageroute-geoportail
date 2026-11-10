/**
 * GRAINE DE DEMONSTRATION des territoires du module Projets de voirie (lot T1, CONTRAT-TERRITOIRES.md section 9).
 *
 * NE VAUT PAS REFERENTIEL OFFICIEL. Cree, sous la nation de la migration 20261103100000, sept communes de DEMONSTRATION avec leur region et leur
 * prefecture, toutes marquees DEMO (code `DEMO-...`, `source` « graine de demonstration DEMO, emprise approximative »). Les emprises sont des
 * rectangles d'environ 11 km autour d'un centre approximatif de la ville : elles servent a montrer qu'une ville s'ajoute par des DONNEES, pas par
 * du code. Elles ne doivent jamais servir a une decision.
 *
 * GARDES : refuse sans `GRAINE_DEMO=OUI`, refuse sous `NODE_ENV=production`, refuse une base dont le nom ne commence pas par `essai_`, `replay`,
 * `demo` ou `dev` (meme principe que la garde des bancs). Rejouable : un code deja present n'est ni recree ni modifie. Aucune ecriture hors de
 * `territoires_voirie` et de son historique. La region de la migration (GN-REG-FARANAH) est reutilisee si elle existe.
 *
 * Usage (depuis backend/) :  GRAINE_DEMO=OUI DATABASE_URL=postgresql://.../dev npx tsx scripts/graine-demo-territoires.ts
 */
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

interface VilleDemo { cle: string; nom: string; region: string; lon: number; lat: number; codeRegionExistant?: string }

// Centres APPROXIMATIFS (domaine public), arrondis au centieme de degre. Donnees de demonstration, jamais de production.
const VILLES: VilleDemo[] = [
  { cle: "CONAKRY", nom: "Conakry", region: "Conakry", lon: -13.68, lat: 9.54 },
  { cle: "KANKAN", nom: "Kankan", region: "Kankan", lon: -9.31, lat: 10.39 },
  { cle: "KINDIA", nom: "Kindia", region: "Kindia", lon: -12.86, lat: 10.06 },
  { cle: "LABE", nom: "Labé", region: "Labé", lon: -12.28, lat: 11.32 },
  { cle: "BOKE", nom: "Boké", region: "Boké", lon: -14.29, lat: 10.94 },
  { cle: "FARANAH", nom: "Faranah", region: "Faranah", lon: -10.74, lat: 10.04, codeRegionExistant: "GN-REG-FARANAH" },
  { cle: "NZEREKORE", nom: "N'Zérékoré", region: "N'Zérékoré", lon: -8.82, lat: 7.75 },
];
const DEMI_COTE = 0.05;
const SOURCE = "graine de demonstration DEMO, emprise approximative (ne vaut pas referentiel officiel)";

function garde(): void {
  if (process.env.GRAINE_DEMO !== "OUI") throw new Error("Graine de demonstration refusee : GRAINE_DEMO=OUI est requis.");
  if (process.env.NODE_ENV === "production") throw new Error("Graine de demonstration refusee sous NODE_ENV=production.");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL absente.");
  const base = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!/^(essai_|replay|demo|dev)/.test(base)) throw new Error(`Graine de demonstration refusee : la base « ${base} » n'est pas une base d'essai, de demonstration ou de developpement.`);
}

async function main(): Promise<void> {
  garde();
  const prisma = new PrismaClient();
  try {
    const nation = await prisma.territoireVoirie.findFirst({ where: { niveau: "NATION", deletedAt: null }, select: { id: true } });
    if (!nation) throw new Error("Aucune nation : appliquez d'abord la migration 20261103100000_territoires_referentiels.");
    let crees = 0;
    const creer = async (code: string, nom: string, niveau: "REGION" | "PREFECTURE" | "COMMUNE", parentId: string, regionId: number | null, emprise?: [number, number, number, number]): Promise<string> => {
      const deja = await prisma.territoireVoirie.findUnique({ where: { code }, select: { id: true } });
      if (deja) return deja.id;
      const id = await prisma.$transaction(async (tx) => {
        const t = await tx.territoireVoirie.create({ data: { code, nom, niveau, parentId, regionId, source: SOURCE, chemin: "", profondeur: 0 } });
        if (emprise) await tx.$executeRaw`UPDATE "territoires_voirie" SET "emprise" = ST_SetSRID(ST_MakeEnvelope(${emprise[0]}, ${emprise[1]}, ${emprise[2]}, ${emprise[3]}), 4326) WHERE "id" = ${t.id}`;
        await tx.territoireVoirieHistorique.create({ data: { territoireId: t.id, action: "CREATION", version: 1, apres: { code, nom, niveau, source: SOURCE, bbox: emprise ?? null } } });
        return t.id;
      });
      crees += 1;
      return id;
    };
    for (const v of VILLES) {
      // Correctifs T1+S1 (m12) : rapprochement sans accents, casse, apostrophes ni espaces (« N'Zérékoré » de la graine, « Nzérékoré » de prisma/seed.ts).
      const region = await prisma.$queryRaw<{ id: number }[]>`SELECT "id" FROM "regions" WHERE regexp_replace(lower(unaccent("nom")), '[^a-z0-9]', '', 'g') = regexp_replace(lower(unaccent(${v.region})), '[^a-z0-9]', '', 'g') ORDER BY "id" LIMIT 1`;
      const regionId = region[0]?.id ?? null;
      const existante = v.codeRegionExistant ? await prisma.territoireVoirie.findUnique({ where: { code: v.codeRegionExistant }, select: { id: true } }) : null;
      const regId = existante?.id ?? await creer(`DEMO-REG-${v.cle}`, `${v.region} (DEMO)`, "REGION", nation.id, regionId);
      const prefId = await creer(`DEMO-PREF-${v.cle}`, `${v.nom} (DEMO)`, "PREFECTURE", regId, null);
      await creer(`DEMO-COM-${v.cle}`, `${v.nom} (DEMO)`, "COMMUNE", prefId, null, [v.lon - DEMI_COTE, v.lat - DEMI_COTE, v.lon + DEMI_COTE, v.lat + DEMI_COTE]);
    }
    console.log(`Graine de demonstration : ${crees} territoire(s) cree(s), ${VILLES.length} communes DEMO au total (rejouable).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
