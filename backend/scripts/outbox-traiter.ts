/**
 * Traite UN lot de l'outbox des integrations sortantes, puis s'arrete. A lancer par un
 * ordonnanceur (cron) : aucun ordonnanceur n'est demarre par le serveur.
 *
 *   npx tsx scripts/outbox-traiter.ts
 *
 * N'emet QUE vers les destinations activees par l'environnement (INTEGRATIONS_SORTANTES_ACTIVES et
 * OUTBOX_<DEST>_*, voir backend/.env.example). Sans elles : "0 destination active", rien n'est
 * contacte. Ne journalise jamais de jeton ni d'adresse. Voir docs/integrations/SORTANTS.md.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { lireConfigIntegrations } from "../src/integrations/config";
import { creerAdaptateurs } from "../src/integrations/adaptateurs";
import { depotSql } from "../src/integrations/outbox.depot";
import { lecteurSourcesSql } from "../src/integrations/sources.depot";
import { traiterLot } from "../src/integrations/outbox.service";

async function main() {
  const config = lireConfigIntegrations(process.env);
  const adaptateurs = creerAdaptateurs(config);
  const actives = Object.keys(adaptateurs);
  for (const a of config.avertissements) console.warn("avertissement de configuration :", a);
  if (actives.length === 0) {
    console.log("0 destination active : rien n'est emis.");
    for (const d of Object.values(config.destinations)) console.log(`  ${d.destination} : ${d.raison}`);
    return;
  }
  const r = await traiterLot(
    { depot: depotSql(prisma), sources: lecteurSourcesSql(prisma), adaptateurs, politique: config.politique, verrouMs: config.verrouMs },
    config.lotMax,
  );
  const parStatut: Record<string, number> = {};
  for (const x of r.resultats) {
    const cle = x.traite ? x.statut : `non traite (${x.raison})`;
    parStatut[cle] = (parStatut[cle] ?? 0) + 1;
  }
  console.log(`destinations actives : ${actives.join(", ")} ; evenements examines : ${r.examines}`, parStatut);
}

main()
  .catch((e) => { console.error("echec du traitement de l'outbox :", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
