/**
 * Deduit et met a jour l'etat des 116 ouvrages RN4 deja importes (import-ouvrages-rn4.ts) :
 * la fiche terrain n'a pas de colonne "etat" explicite, mais les remarques de terrain
 * (RAS/BAS = bon, balise cassee/vibration = moyen, fissure/affouillement = mauvais,
 * cumul de plusieurs defauts structurels = critique) permettent de la deriver.
 *
 * Usage : INVENTAIRE_XLS_PATH=/chemin/fichier.xls tsx scripts/update-ouvrages-etat-rn4.ts
 */
import * as XLSX from "xlsx";
import { PrismaClient } from "@prisma/client";

const xlsPath = process.env.INVENTAIRE_XLS_PATH;
if (!xlsPath) {
  console.error("INVENTAIRE_XLS_PATH manquant.");
  process.exit(1);
}

const prisma = new PrismaClient();

function deriveEtat(remarques: string, commentaire: string): string {
  const r = remarques.toLowerCase();
  const hasBaliseCassee = /balise cass/.test(r);
  const hasFissure = /fissure/.test(r);
  const hasAffouillement = /affouillement/.test(r);
  const hasGardeCorps = /garde corps/.test(r);
  const hasVibration = /vibration/.test(r);

  const structuralCount = [hasFissure, hasAffouillement].filter(Boolean).length;
  if (structuralCount >= 2) return "CRITIQUE";
  if (hasFissure || hasAffouillement) return "MAUVAIS";
  if (hasBaliseCassee || hasGardeCorps || hasVibration) return "MOYEN";
  if (r === "ras" || r === "bas" || r === "") return "BON";
  return "NON_EVALUE";
}

interface Row {
  ficheNumero: string;
  remarques: string;
  commentaire: string;
}

function readRows(): Row[] {
  const wb = XLSX.readFile(xlsPath!);
  const sheet = wb.Sheets["Tableau récapitulatif"];
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
  const rows: Row[] = [];
  for (let i = 5; i < raw.length; i++) {
    const r = raw[i];
    const pkRaw = r[2];
    const nom = String(r[3] ?? "").trim();
    if (!pkRaw && !nom) continue;
    rows.push({
      ficheNumero: r[1] !== "" ? String(r[1]) : "",
      remarques: String(r[17] ?? "").trim(),
      commentaire: String(r[18] ?? "").trim(),
    });
  }
  return rows;
}

async function main() {
  const rows = readRows();
  console.log(`Lignes lues : ${rows.length}`);

  const counts: Record<string, number> = {};
  let updated = 0;
  const errors: { ficheNumero: string; message: string }[] = [];

  for (const r of rows) {
    if (!r.ficheNumero) continue;
    try {
      const etat = deriveEtat(r.remarques, r.commentaire);
      counts[etat] = (counts[etat] || 0) + 1;
      const result = await prisma.ouvrage.updateMany({
        where: { ficheNumero: r.ficheNumero, tronconId: { not: null } },
        data: { etat: etat as never },
      });
      updated += result.count;
    } catch (err) {
      errors.push({ ficheNumero: r.ficheNumero, message: err instanceof Error ? err.message : "Erreur inconnue" });
    }
  }

  console.log("Repartition deduite :", counts);
  console.log(`Ouvrages mis a jour : ${updated}`);
  if (errors.length) {
    console.log(`Erreurs (${errors.length}) :`);
    for (const e of errors) console.log(`  fiche ${e.ficheNumero} : ${e.message}`);
  }
}

main()
  .catch((err) => {
    console.error("Erreur de mise a jour :", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
