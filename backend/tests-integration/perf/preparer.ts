/**
 * Cree et charge le clone de mesure SANS lancer le banc (pour explorer a la main : EXPLAIN ANALYZE,
 * psql...). Le clone reste en place ; le supprimer avec `--supprimer`.
 *
 *   DATABASE_URL=postgresql://utilisateur:motdepasse@127.0.0.1:5434/replay \
 *     npx tsx tests-integration/perf/preparer.ts --nombre 261387 [--nom essai_perf] [--graine N]
 *   DATABASE_URL=... npx tsx tests-integration/perf/preparer.ts --supprimer [--nom essai_perf]
 */
import "../lib/garde";
import { supprimerClone } from "../lib/clone";
import { preparerClone } from "./lib/preparation";

const arg = (nom: string, defaut?: string) => {
  const i = process.argv.indexOf(`--${nom}`);
  return i >= 0 ? process.argv[i + 1] : defaut;
};

async function main() {
  const url = process.env.DATABASE_URL!;
  const nom = arg("nom", "essai_perf")!;
  if (process.argv.includes("--supprimer")) {
    await supprimerClone(url, nom);
    console.log(`clone ${nom} supprime`);
    return;
  }
  const p = await preparerClone({ urlReplay: url, nom, nombre: Number(arg("nombre", "20000")), graine: arg("graine") ? Number(arg("graine")) : undefined });
  console.log(JSON.stringify({ base: nom, empreinte: p.empreinte, description: p.description, chargement: p.chargement }, null, 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
