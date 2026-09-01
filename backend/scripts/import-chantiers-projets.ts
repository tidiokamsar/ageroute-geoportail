/**
 * Importe le tableau de synthese des contrats AGEROUTE (fichier "Liste des
 * projets_contrats a saisir dans le systeme ageroute360.xlsx") comme Chantiers BDRI.
 * Trois feuilles sources : FER, BND-FINEX, INVEST A VENIR (la feuille "Feuil1" est un
 * doublon quasi complet de FER, volontairement ignoree pour ne pas dupliquer les lignes).
 *
 * La feuille ne donne pas de tronçon/PK precis (juste une "Zone du projet" par
 * region/prefecture) : les chantiers sont crees sans tronconId ni geometrie -
 * ils apparaitront dans les listes/KPIs mais pas comme trace sur la carte, faute
 * de reference lineaire dans la source.
 *
 * Usage : PROJETS_XLSX_PATH=/chemin/fichier.xlsx tsx scripts/import-chantiers-projets.ts
 */
import * as XLSX from "xlsx";
import { PrismaClient } from "@prisma/client";

const xlsPath = process.env.PROJETS_XLSX_PATH;
if (!xlsPath) {
  console.error("PROJETS_XLSX_PATH manquant.");
  process.exit(1);
}

const prisma = new PrismaClient();

const PREF_TO_REGION: Record<string, string> = {
  boke: "Boké", boffa: "Boké", fria: "Boké", gaoual: "Boké", koundara: "Boké",
  kindia: "Kindia", coyah: "Kindia", dubreka: "Kindia", forecariah: "Kindia", telimele: "Kindia", telimile: "Kindia",
  mamou: "Mamou", dalaba: "Mamou", pita: "Mamou",
  labe: "Labé", koubia: "Labé", lelouma: "Labé", mali: "Labé", tougue: "Labé",
  faranah: "Faranah", dabola: "Faranah", dinguiraye: "Faranah", kissidougou: "Faranah",
  kankan: "Kankan", kerouane: "Kankan", kouroussa: "Kankan", mandiana: "Kankan", siguiri: "Kankan",
  nzerekore: "Nzérékoré", beyla: "Nzérékoré", gueckedou: "Nzérékoré", guekedou: "Nzérékoré",
  lola: "Nzérékoré", macenta: "Nzérékoré", yomou: "Nzérékoré", youmou: "Nzérékoré",
  conakry: "Conakry", kaloum: "Conakry", dixinn: "Conakry", matam: "Conakry", matoto: "Conakry",
  ratoma: "Conakry", gbessia: "Conakry", bonfi: "Conakry", nongo: "Conakry", kassonyah: "Conakry",
  "iles de loos": "Conakry", kiroty: "Conakry", touba: "Conakry", hamdallaye: "Conakry", sonfonia: "Conakry",
  tanene: "Kindia", kagbelen: "Kindia",
};

function normalize(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/['']/g, "'").trim().toLowerCase();
}

function resolveRegionNom(zone: string): string | null {
  if (!zone || !zone.trim()) return null;
  const parts = zone.split(/[/,]/).map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const tokens = part.split(/[-\s]+/);
    for (const tok of [part, ...tokens]) {
      const n = normalize(tok);
      if (PREF_TO_REGION[n]) return PREF_TO_REGION[n];
    }
  }
  return null;
}

function resolveStatut(raw: string): string {
  const s = normalize(raw);
  if (!s) return "PLANIFIE";
  if (/resili|abandon|arret|souffrance|suspend/.test(s)) return "SUSPENDU";
  if (/reception|achev|clotur/.test(s)) return "TERMINE";
  if (/passation|etude|recherche de financement|signature|revoir/.test(s)) return "PLANIFIE";
  if (/cours|retard|ralenti/.test(s)) return "EN_COURS";
  return "EN_COURS";
}

interface Row {
  sheet: string;
  intitule: string;
  numContrat?: string;
  montant?: number;
  zone: string;
  financement?: string;
  entreprise?: string;
  tauxPhysique: number;
  anneeSignature?: number;
  statut: string;
  observations?: string;
}

function readSheet(wb: XLSX.WorkBook, name: string, hasCode: boolean): Row[] {
  const raw = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: "" });
  const off = hasCode ? 1 : 0;
  const rows: Row[] = [];
  for (let i = 2; i < raw.length; i++) {
    const r = raw[i];
    if (typeof r[0] !== "number") continue;
    const zone = String(r[4 + off] ?? "").trim();
    const statutRaw = String(r[11 + off] ?? "").trim();
    const dateSignature = r[10 + off];
    rows.push({
      sheet: name,
      intitule: String(r[1 + off] ?? "").trim(),
      numContrat: String(r[2 + off] ?? "").trim() || undefined,
      montant: Number(r[3 + off]) || undefined,
      zone,
      financement: String(r[5 + off] ?? "").trim() || undefined,
      entreprise: String(r[6 + off] ?? "").trim() || undefined,
      tauxPhysique: Number(r[8 + off]) || 0,
      anneeSignature: Number(dateSignature) >= 1900 && Number(dateSignature) <= 2100 ? Number(dateSignature) : undefined,
      statut: resolveStatut(statutRaw),
      observations: String(r[12 + off] ?? "").trim() || undefined,
    });
  }
  return rows;
}

async function main() {
  const wb = XLSX.readFile(xlsPath!);
  const rows = [
    ...readSheet(wb, "FER", false),
    ...readSheet(wb, "BND-FINEX", true),
    ...readSheet(wb, "INVEST A VENIR", true),
  ].filter((r) => r.intitule);

  console.log(`Lignes a importer : ${rows.length}`);

  const regionCache = new Map<string, number>();
  async function regionId(nom: string | null): Promise<number> {
    const key = nom ?? "Non renseigné";
    if (regionCache.has(key)) return regionCache.get(key)!;
    const region = await prisma.region.findUnique({ where: { nom: key } });
    const id = region?.id ?? (await prisma.region.findUniqueOrThrow({ where: { nom: "Non renseigné" } })).id;
    regionCache.set(key, id);
    return id;
  }

  let created = 0;
  const statutCounts: Record<string, number> = {};
  const errors: { row: number; message: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const regionNom = resolveRegionNom(r.zone);
      const rid = await regionId(regionNom);

      await prisma.chantier.create({
        data: {
          intitule: r.intitule,
          entreprise: r.entreprise || "À déterminer",
          bailleur: r.financement,
          montantGnf: r.montant != null ? BigInt(Math.round(r.montant)) : undefined,
          regionId: rid,
          avancementPct: Math.round(r.tauxPhysique * 100),
          statut: r.statut as never,
          numContrat: r.numContrat,
          observations: r.observations,
          dateDebutPrevue: r.anneeSignature ? new Date(`${r.anneeSignature}-01-01`) : undefined,
        },
      });
      statutCounts[r.statut] = (statutCounts[r.statut] || 0) + 1;
      created++;
    } catch (err) {
      errors.push({ row: i + 1, message: err instanceof Error ? err.message : "Erreur inconnue" });
    }
  }

  console.log("Repartition statuts :", statutCounts);
  console.log(`Chantiers crees : ${created}`);
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
