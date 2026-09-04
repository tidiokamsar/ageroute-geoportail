/**
 * Referentiel des regions administratives : codes officiels et validite.
 *
 * SANS `--apply`, LE SCRIPT NE FAIT QUE LIRE.
 *
 * CE QU'IL POSE
 *
 * 1. Le code a deux chiffres des huit regions existantes, tel que le fixe le decret
 *    D/2025/055/PRG/CNRD/SGG du 14 avril 2025.
 * 2. Les deux regions creees par les decrets du 20 aout 2026 : Siguiri et Beyla.
 *
 * CE QU'IL NE FAIT PAS
 *
 * Il ne deplace AUCUN actif. Beyla etait une prefecture de Nzerekore et devient une
 * region ; Siguiri etait une prefecture de Kankan. Les troncons, chantiers et
 * ouvrages qui s'y trouvent restent rattaches a Nzerekore et a Kankan.
 *
 * Ce n'est pas une omission. Rattacher un actif a sa nouvelle region suppose de
 * savoir dans quelle prefecture il se trouve — information que la base ne porte pas,
 * faute de decoupage administratif geographique. Le faire « au jugé » deplacerait des
 * kilometres de reseau d'une region a l'autre sur une supposition.
 *
 * Il ne renomme ni ne supprime rien : la ligne « Non renseigne » (id 9) reste, parce
 * que 50 chantiers s'y rattachent et qu'elle designe une saisie manquante, pas une
 * region.
 *
 * POURQUOI SIGUIRI ET BEYLA N'ONT PAS DE CODE
 *
 * Aucune des sources consultees ne publie de code pour elles. Leur attribuer 09 et 10
 * par symetrie serait inventer une donnee officielle. La colonne reste nulle.
 *
 * Usage :
 *   tsx scripts/referentiel-regions.ts            (lecture seule)
 *   tsx scripts/referentiel-regions.ts --apply    (ecrit)
 */
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

const prisma = new PrismaClient();

const DECRET_2025 = "Décret D/2025/055/PRG/CNRD/SGG du 14 avril 2025 — codification";
const DECRET_2026 = "Décrets du 20 août 2026 — création de régions et préfectures";

/** Entree en vigueur du decoupage a huit regions : anterieure au perimetre du projet. */
const VALIDITE_ANCIENNE = new Date("2025-04-14T00:00:00Z");
const VALIDITE_NOUVELLE = new Date("2026-08-20T00:00:00Z");

const CODES: Record<string, string> = {
  Conakry: "01",
  Kindia: "02",
  Boké: "03",
  Mamou: "04",
  Labé: "05",
  Faranah: "06",
  Kankan: "07",
  Nzérékoré: "08",
};

/** Creees le 20 aout 2026. Aucun code publie a ce jour. */
const NOUVELLES = [
  { nom: "Siguiri", ancienneAppartenance: "Kankan" },
  { nom: "Beyla", ancienneAppartenance: "Nzérékoré" },
];

async function main() {
  const appliquer = process.argv.includes("--apply");

  console.log("=== Referentiel des regions administratives ===");
  console.log(`Mode : ${appliquer ? "ECRITURE" : "LECTURE SEULE (ajouter --apply)"}`);
  console.log("");

  const existantes = await prisma.region.findMany({ orderBy: { id: "asc" } });
  console.log(`Regions en base : ${existantes.length}`);

  const aCoder = existantes.filter((r) => CODES[r.nom] && !r.code);
  const aCreer = NOUVELLES.filter((n) => !existantes.some((r) => r.nom === n.nom));
  const sansCode = existantes.filter((r) => !CODES[r.nom]).map((r) => r.nom);

  console.log(`  a coder          : ${aCoder.length}  (${aCoder.map((r) => r.nom).join(", ") || "aucune"})`);
  console.log(`  a creer          : ${aCreer.length}  (${aCreer.map((n) => n.nom).join(", ") || "aucune"})`);
  console.log(`  laissees sans code : ${sansCode.join(", ") || "aucune"}`);
  console.log("");

  if (aCoder.length === 0 && aCreer.length === 0) {
    console.log("Rien a faire.");
    return;
  }

  console.log("Aucun actif ne sera deplace : Beyla et Siguiri deviennent des regions,");
  console.log("mais les troncons et chantiers qui s'y trouvent restent rattaches a");
  console.log("Nzerekore et Kankan — la base ne sait pas dans quelle prefecture ils sont.");
  console.log("");

  if (!appliquer) {
    console.log("LECTURE SEULE — rien n'a ete ecrit.");
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const r of aCoder) {
      await tx.region.update({
        where: { id: r.id },
        data: {
          code: CODES[r.nom],
          validFrom: VALIDITE_ANCIENNE,
          source: DECRET_2025,
          sourceDate: VALIDITE_ANCIENNE,
        },
      });
    }
    for (const n of aCreer) {
      await tx.region.create({
        data: {
          nom: n.nom,
          validFrom: VALIDITE_NOUVELLE,
          source: `${DECRET_2026} — anciennement préfecture de ${n.ancienneAppartenance}`,
          sourceDate: VALIDITE_NOUVELLE,
        },
      });
    }
  });

  const apres = await prisma.region.findMany({ orderBy: { id: "asc" } });
  console.log("--- Applique ---");
  for (const r of apres) {
    console.log(
      `  ${String(r.id).padStart(2)}  ${(r.code ?? "--").padEnd(3)} ${r.nom.padEnd(16)}` +
      `${r.validFrom ? r.validFrom.toISOString().slice(0, 10) : "date inconnue"}`,
    );
  }
  console.log("");
  console.log("Retour arriere :");
  console.log(`  delete from regions where nom in (${aCreer.map((n) => `'${n.nom}'`).join(", ") || "''"});`);
  console.log(`  update regions set code=null, "validFrom"=null, source=null, "sourceDate"=null;`);
}

main()
  .catch((e) => { console.error("ECHEC :", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
