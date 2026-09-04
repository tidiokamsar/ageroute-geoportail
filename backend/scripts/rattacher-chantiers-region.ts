/**
 * Rattacher a une region les chantiers saisis en « Non renseigne ».
 *
 * SANS `--apply`, LE SCRIPT NE FAIT QUE LIRE.
 *
 * LE PROBLEME
 *
 * 50 chantiers portent `regionId` = 9, « Non renseigne ». Ce n'est pas une region :
 * c'est un contournement de la contrainte NOT NULL, cree pour pouvoir enregistrer un
 * chantier dont on ignorait la localisation. Ces 50 dossiers sont donc invisibles de
 * toute lecture regionale.
 *
 * CE QUE LES INTITULES PERMETTENT, ET CE QU'ILS NE PERMETTENT PAS
 *
 * Ils sont du texte libre. Trois familles s'y distinguent :
 *
 *   - une prefecture ou une commune NOMMEE explicitement
 *     (« dans la Prefecture de Forecariah », « commune Urbaine de Labe ») ;
 *   - une localite reconnaissable (Bambeto, Kipe, Diecke, Kounsitel) ;
 *   - aucun indice geographique (« Programme d'Urgence Entretien Routier »).
 *
 * Seules les deux premieres sont exploitables. La troisieme reste sans region, et
 * c'est le bon resultat : inventer vaut moins que ne rien dire.
 *
 * DEUX PIEGES QUE CE SCRIPT EVITE
 *
 * Maneah et Kagbelen ressemblent a des quartiers de Conakry — les chantiers qui les
 * citent voisinent avec Bambeto et Gbessia dans la meme liste. Ils relevent en
 * realite de Coyah et Dubreka, donc de la region de Kindia. Une regle « ca ressemble
 * a Conakry » les aurait mal rattaches.
 *
 * Un intitule peut citer DEUX localites de regions differentes (un axe qui traverse).
 * Le script ne tranche pas : il laisse le chantier sans region et le signale.
 *
 * LE DECOUPAGE EST CELUI DU 20 AOUT 2026
 *
 * Siguiri et Beyla sont desormais des regions, non plus des prefectures de Kankan et
 * Nzerekore. Un chantier « a Siguiri » va donc a la region Siguiri.
 *
 * CE QUI EST ECRIT DANS valeurs_qualite
 *
 * `regionId` en DERIVED, confiance LOW, avec le mot qui a declenche le rattachement.
 * Un agent peut ainsi verifier chaque cas sur piece, et le rattachement ne se lit
 * jamais comme une saisie.
 *
 * Usage :
 *   tsx scripts/rattacher-chantiers-region.ts            (lecture seule)
 *   tsx scripts/rattacher-chantiers-region.ts --apply    (ecrit)
 */
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

const prisma = new PrismaClient();

/**
 * Localite -> nom de region. Volontairement restreint a ce qui est certain.
 *
 * Les prefectures viennent du decret D/2025/055 du 14 avril 2025 et des decrets du
 * 20 aout 2026. Les localites non prefectorales n'y figurent que lorsqu'elles ne
 * presentent aucune ambiguite.
 */
const LIEUX: Record<string, string> = {
  // --- Prefectures, par region -------------------------------------------------
  conakry: "Conakry",
  coyah: "Kindia", dubreka: "Kindia", forecariah: "Kindia", kindia: "Kindia", telimele: "Kindia",
  boffa: "Boké", boke: "Boké", fria: "Boké", gaoual: "Boké", koundara: "Boké", kamsar: "Boké",
  dalaba: "Mamou", mamou: "Mamou", pita: "Mamou", timbo: "Mamou",
  koubia: "Labé", labe: "Labé", lelouma: "Labé", tougue: "Labé",
  dabola: "Faranah", dinguiraye: "Faranah", faranah: "Faranah", kissidougou: "Faranah",
  kankan: "Kankan", kerouane: "Kankan", kouroussa: "Kankan", mandiana: "Kankan",
  tokounou: "Kankan", dialakoro: "Kankan",
  gueckedou: "Nzérékoré", lola: "Nzérékoré", macenta: "Nzérékoré",
  nzerekore: "Nzérékoré", yomou: "Nzérékoré",
  siguiri: "Siguiri", doko: "Siguiri", siguirini: "Siguiri", kintinian: "Siguiri",
  beyla: "Beyla", sinko: "Beyla", kouankan: "Beyla", karala: "Beyla",

  // --- Communes et quartiers de Conakry ----------------------------------------
  kaloum: "Conakry", dixinn: "Conakry", matam: "Conakry", matoto: "Conakry", ratoma: "Conakry",
  bambeto: "Conakry", gbessia: "Conakry", kipe: "Conakry", miniere: "Conakry",
  hamdallaye: "Conakry", cosa: "Conakry", taouyah: "Conakry", nongo: "Conakry",
  kaporo: "Conakry", lambanyi: "Conakry", sonfonia: "Conakry", enco5: "Conakry",
  camayenne: "Conakry", madina: "Conakry", bonfi: "Conakry", darsalam: "Conakry",
  keitaya: "Conakry", yenguema: "Conakry", avaria: "Conakry", solokoure: "Conakry",

  // --- Localites hors Conakry, sans ambiguite ----------------------------------
  // Maneah (Coyah) et Kagbelen (Dubreka) NE SONT PAS Conakry, malgre les apparences.
  maneah: "Kindia", kagbelen: "Kindia", tanene: "Kindia", kaleah: "Kindia",
  wonkifong: "Kindia", gomboyah: "Kindia", kitima: "Kindia",
  kounsitel: "Boké",
  diecke: "Nzérékoré", mangalabe: "Labé",
};

/**
 * « Route le Prince », « Route Niger » et les transversales T1 a T14 sont la voirie
 * structurante de Conakry. Traitees a part : ce sont des voies, pas des lieux, et
 * leur nom seul suffit a situer le chantier.
 */
const VOIES_CONAKRY = [
  /route\s+le\s+prince/i,
  /route\s+niger/i,
  /\bT(?:1[0-4]|[1-9])\b/,
];

/**
 * Enleve accents et ponctuation pour comparer « N'Zérékoré » et « nzerekore ».
 *
 * La plage de diacritiques est ecrite en echappement Unicode et non en caracteres
 * combinants litteraux : ces derniers sont invisibles dans un editeur et survivent
 * mal a un changement d'encodage du fichier.
 */
function normaliser(s: string): string {
  return s
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

interface Verdict {
  region: string | null;
  indices: string[];
  motif: string;
}

export function deduireRegion(intitule: string): Verdict {
  const t = normaliser(intitule);

  // 1. Une prefecture ou commune NOMMEE explicitement l'emporte : c'est une
  //    affirmation de l'intitule, pas une reconnaissance de mot.
  const explicite = t.match(/(?:prefecture|commune(?: urbaine)?) (?:de |d )?([a-z]+)/);
  if (explicite && LIEUX[explicite[1]]) {
    return { region: LIEUX[explicite[1]], indices: [explicite[1]], motif: "mention explicite" };
  }

  // 2. Sinon, tous les lieux reconnus dans le texte.
  const trouves = Object.keys(LIEUX).filter((l) =>
    new RegExp(`(^| )${l}( |$)`).test(t),
  );
  const regions = [...new Set(trouves.map((l) => LIEUX[l]))];

  if (regions.length === 1) {
    return { region: regions[0], indices: trouves, motif: "localité reconnue" };
  }
  if (regions.length > 1) {
    // Un axe qui traverse deux regions. Trancher serait arbitraire.
    return { region: null, indices: trouves, motif: `ambigu : ${regions.join(" / ")}` };
  }

  // 3. Voirie structurante de Conakry.
  const voie = VOIES_CONAKRY.find((r) => r.test(intitule));
  if (voie) {
    return { region: "Conakry", indices: [String(voie)], motif: "voirie de Conakry" };
  }

  return { region: null, indices: [], motif: "aucun indice géographique" };
}

async function main() {
  const appliquer = process.argv.includes("--apply");

  const nonRenseignee = await prisma.region.findFirst({ where: { nom: "Non renseigné" } });
  if (!nonRenseignee) throw new Error("Region « Non renseigné » introuvable.");

  const regions = await prisma.region.findMany();
  const parNom = new Map(regions.map((r) => [r.nom, r.id]));

  const chantiers = await prisma.chantier.findMany({
    where: { deletedAt: null, regionId: nonRenseignee.id },
    select: { id: true, intitule: true },
    orderBy: { intitule: "asc" },
  });

  console.log("=== Rattachement des chantiers sans region ===");
  console.log(`Mode : ${appliquer ? "ECRITURE" : "LECTURE SEULE (ajouter --apply)"}`);
  console.log(`Chantiers concernes : ${chantiers.length}`);
  console.log("");

  const resolus: { id: string; regionId: number; region: string; intitule: string; verdict: Verdict }[] = [];
  const restants: { intitule: string; verdict: Verdict }[] = [];

  for (const c of chantiers) {
    const v = deduireRegion(c.intitule);
    const id = v.region ? parNom.get(v.region) : undefined;
    if (v.region && id) {
      resolus.push({ id: c.id, regionId: id, region: v.region, intitule: c.intitule, verdict: v });
    } else {
      restants.push({ intitule: c.intitule, verdict: v });
    }
  }

  const parRegion = new Map<string, number>();
  for (const r of resolus) parRegion.set(r.region, (parRegion.get(r.region) ?? 0) + 1);

  console.log(`Rattachables : ${resolus.length}`);
  for (const [nom, n] of [...parRegion].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${nom}`);
  }
  console.log("");
  console.log(`Laisses sans region : ${restants.length}`);
  for (const r of restants) {
    console.log(`  [${r.verdict.motif}] ${r.intitule.slice(0, 70)}`);
  }
  console.log("");

  if (!appliquer || resolus.length === 0) {
    if (resolus.length > 0) {
      console.log("Detail des rattachements proposes :");
      for (const r of resolus) {
        console.log(`  -> ${r.region.padEnd(12)} (${r.verdict.indices.join(", ")})  ${r.intitule.slice(0, 60)}`);
      }
      console.log("");
    }
    console.log("LECTURE SEULE — rien n'a ete ecrit. Ajouter --apply pour appliquer.");
    return;
  }

  const maintenant = new Date();
  await prisma.$transaction(async (tx) => {
    for (const r of resolus) {
      await tx.chantier.update({ where: { id: r.id }, data: { regionId: r.regionId } });
      await tx.valeurQualite.upsert({
        where: { entityType_entityId_champ: { entityType: "Chantier", entityId: r.id, champ: "regionId" } },
        create: {
          entityType: "Chantier", entityId: r.id, champ: "regionId",
          statut: "DERIVED", source: "INTITULE_CHANTIER", methode: "RECONNAISSANCE_LOCALITE",
          observedAt: maintenant, confiance: "LOW",
          note: `Région déduite de l'intitulé (${r.verdict.motif} : ${r.verdict.indices.join(", ")}). `
            + "Aucune saisie ni relevé — à confirmer sur le dossier de marché.",
        },
        update: {
          statut: "DERIVED", source: "INTITULE_CHANTIER", methode: "RECONNAISSANCE_LOCALITE",
          observedAt: maintenant, confiance: "LOW",
          note: `Région déduite de l'intitulé (${r.verdict.motif} : ${r.verdict.indices.join(", ")}). `
            + "Aucune saisie ni relevé — à confirmer sur le dossier de marché.",
        },
      });
    }
  });

  console.log("--- Applique ---");
  console.log(`  chantiers rattaches       : ${resolus.length}`);
  console.log(`  lignes valeurs_qualite    : ${resolus.length}`);
  console.log(`  laisses sans region       : ${restants.length}`);
  console.log("");
  console.log("Retour arriere :");
  console.log(`  update chantiers set "regionId"=${nonRenseignee.id} where id in (`);
  console.log(`    select "entityId" from valeurs_qualite where "entityType"='Chantier'`);
  console.log(`      and champ='regionId' and methode='RECONNAISSANCE_LOCALITE');`);
  console.log(`  delete from valeurs_qualite where "entityType"='Chantier'`);
  console.log(`    and champ='regionId' and methode='RECONNAISSANCE_LOCALITE';`);
}

if (process.argv[1]?.includes("rattacher-chantiers-region")) {
  main()
    .catch((e) => { console.error("ECHEC :", e instanceof Error ? e.message : e); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
