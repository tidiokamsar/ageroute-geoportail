/**
 * Balayage des secrets a la main (scenario A25).
 *
 *   npx tsx scripts/balayer-secrets.ts               l'arbre suivi par git (ce que fait `npm test`)
 *   npx tsx scripts/balayer-secrets.ts --historique  en plus : chaque ligne ajoutee de chaque commit de toutes les branches
 *
 * Le code de sortie est 1 s'il reste une trouvaille non excusee. Le rapport montre OU, jamais QUOI.
 * L'historique est lent (il lit tous les diffs) : a lancer avant une publication ou apres un incident.
 */
import { balayerArbre, balayerHistorique, racineDepot } from "../src/securite/balayage-secrets";
import { estExcusee } from "../src/securite/exceptions-secrets";

async function main() {
  const racine = racineDepot(process.cwd());
  const arbre = balayerArbre(racine);
  const restantes = arbre.trouvailles.filter((t) => !estExcusee(t));
  console.log(`Arbre : ${arbre.fichiersLus} fichiers lus, ${arbre.ignores.length} ignores, ${arbre.trouvailles.length} trouvaille(s), ${restantes.length} non excusee(s).`);
  for (const t of restantes) console.log(`  ${t.regle} ${t.chemin}${t.ligne ? `:${t.ligne}` : ""} -> ${t.extrait}`);

  let historiqueNonExcuse = 0;
  if (process.argv.includes("--historique")) {
    const h = await balayerHistorique(racine);
    // Une trouvaille d'historique porte `chemin@commit` : l'exception se juge sur le chemin seul.
    const restantesH = h.trouvailles.filter((t) => !estExcusee({ ...t, chemin: t.chemin.split("@")[0] }));
    historiqueNonExcuse = restantesH.length;
    console.log(`Historique : ${h.commits} commits parcourus, ${h.trouvailles.length} trouvaille(s), ${restantesH.length} non excusee(s).`);
    for (const t of restantesH.slice(0, 200)) console.log(`  ${t.regle} ${t.chemin} -> ${t.extrait}`);
  }
  process.exitCode = restantes.length + historiqueNonExcuse > 0 ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 2; });
