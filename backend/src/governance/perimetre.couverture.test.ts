import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Garde-fou : TOUTE route d'ecriture des huit domaines porte `requireTerritoire`. Une route
 * ajoutee un jour sans lui ouvrirait une porte hors zone (A10) que personne ne verrait ; ce test
 * la nomme. Les seules exemptions sont listees, avec leur raison.
 */

const SRC = join(__dirname, "..");
const FICHIERS = [
  "modules/troncons/troncons.routes.ts",
  "modules/ouvrages/ouvrages.routes.ts",
  "modules/points-noirs/points-noirs.routes.ts",
  "modules/postes/postes.routes.ts",
  "modules/chantiers/chantiers.routes.ts",
  "api-v2/defauts.routes.ts",
  "api-v2/observations.routes.ts",
  "api-v2/portions.routes.ts",
];

/** Ecritures qui ne portent sur aucun objet localise. */
const EXEMPTIONS: Record<string, string> = {
  "api-v2/defauts.routes.ts POST /catalogue": "le catalogue des types de defaut est national",
  "api-v2/defauts.routes.ts PATCH /catalogue/:code": "idem",
};

function ecritures(fichier: string): { cle: string; texte: string }[] {
  const s = readFileSync(join(SRC, fichier), "utf8");
  const res: { cle: string; texte: string }[] = [];
  const re = /Router\.(post|put|patch|delete)\(\s*"([^"]+)"/g;
  const debuts: { index: number; cle: string }[] = [];
  for (let m = re.exec(s); m; m = re.exec(s)) debuts.push({ index: m.index, cle: `${fichier} ${m[1].toUpperCase()} ${m[2]}` });
  // Une declaration est bornee par la SUIVANTE (et au plus 600 caracteres) : une fenetre fixe
  // debordait sur la ligne d'apres et y trouvait SON garde (defaut trouve par contre-epreuve le
  // 22/10/2026).
  for (let i = 0; i < debuts.length; i++) {
    const fin = Math.min(debuts[i + 1]?.index ?? s.length, debuts[i].index + 600);
    let texte = s.slice(debuts[i].index, fin);
    // Pour une route a gestionnaire en ligne, la declaration s'arrete a `async (`.
    const corps = texte.indexOf("async (");
    if (corps >= 0) texte = texte.slice(0, corps);
    res.push({ cle: debuts[i].cle, texte });
  }
  return res;
}

describe("Chaque ecriture des huit domaines passe par le perimetre territorial", () => {
  const toutes = FICHIERS.flatMap(ecritures);
  it("le balayage trouve bien des routes (sinon le test ne prouverait rien)", () => {
    expect(toutes.length).toBeGreaterThan(30);
  });
  it.each(toutes.map((e) => [e.cle, e] as const))("%s", (cle, e) => {
    if (EXEMPTIONS[cle]) return;
    expect(e.texte).toMatch(/requireTerritoire\(/);
  });
});
