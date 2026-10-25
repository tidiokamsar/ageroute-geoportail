import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Garde-fou : TOUTE route d'ecriture des huit domaines passe par le controle territorial (A10).
 * Une route ajoutee un jour sans lui ouvrirait une porte « hors zone » que personne ne verrait ;
 * ce test la nomme.
 *
 * TROIS FORMES DE GARDE sont reconnues, celles que le depot emploie :
 *   - un middleware de `territoire/` (`territoireFiche(...)`, `territoireDefaut`, ...) ou
 *     `requireTerritoire(...)` dans la declaration de la route ;
 *   - un gestionnaire CRUD (`createHandler`, `updateHandler`, `deleteHandler`, `importHandler`)
 *     dont le service est construit avec `controleTerritorial: true` (`lib/crud-factory.ts` appelle
 *     alors `exigerTerritoire` a chaque ecriture, ligne d'import comprise) ;
 *   - les exemptions listees ci-dessous, chacune avec sa raison.
 */

const SRC = join(__dirname, "..");
const FICHIERS: Record<string, string | null> = {
  // fichier de routes -> fichier du service CRUD (null : pas de service CRUD generique)
  "modules/troncons/troncons.routes.ts": "modules/troncons/troncons.service.ts",
  "modules/ouvrages/ouvrages.routes.ts": "modules/ouvrages/ouvrages.service.ts",
  "modules/points-noirs/points-noirs.routes.ts": "modules/points-noirs/points-noirs.service.ts",
  "modules/postes/postes.routes.ts": "modules/postes/postes.service.ts",
  "modules/chantiers/chantiers.routes.ts": "modules/chantiers/chantiers.service.ts",
  "api-v2/defauts.routes.ts": null,
  "api-v2/observations.routes.ts": null,
  "api-v2/portions.routes.ts": null,
  "api-v2/referentiel.routes.ts": null,
};

/** Ecritures qui ne portent sur aucune fiche localisee, ou qui n'ecrivent rien. */
const EXEMPTIONS: Record<string, string> = {
  "api-v2/defauts.routes.ts POST /catalogue": "le catalogue des types de defaut est national",
  "api-v2/defauts.routes.ts PATCH /catalogue/:code": "idem",
  "api-v2/defauts.routes.ts POST /:id/appariement/suggestion": "calcule une proposition sans rien ecrire ; la confirmation, elle, est gardee",
  "api-v2/referentiel.routes.ts POST /anomalies/previsualisation": "lit et calcule sans rien ecrire ; l'application, elle, est gardee",
};

const GESTIONNAIRES_CRUD = /\b(createHandler|updateHandler|deleteHandler|importHandler)\b/;
const GARDE_ROUTE = /\b(territoire[A-Z]\w*|requireTerritoire)\b/;

interface Ecriture { cle: string; texte: string; fichier: string }

function ecritures(fichier: string): Ecriture[] {
  const s = readFileSync(join(SRC, fichier), "utf8");
  const re = /Router\.(post|put|patch|delete)\(\s*"([^"]+)"/g;
  const debuts: { index: number; cle: string }[] = [];
  for (let m = re.exec(s); m; m = re.exec(s)) debuts.push({ index: m.index, cle: `${fichier} ${m[1].toUpperCase()} ${m[2]}` });
  return debuts.map((d, i) => {
    // La declaration s'arrete a la suivante, et a son gestionnaire en ligne (`async (`) : une
    // fenetre plus large trouverait la garde de la route d'apres.
    let texte = s.slice(d.index, debuts[i + 1]?.index ?? s.length);
    const corps = texte.indexOf("async (");
    if (corps >= 0) texte = texte.slice(0, corps);
    return { cle: d.cle, texte, fichier };
  });
}

function gardee(e: Ecriture): boolean {
  if (GARDE_ROUTE.test(e.texte)) return true;
  const service = FICHIERS[e.fichier];
  if (service && GESTIONNAIRES_CRUD.test(e.texte)) {
    return /controleTerritorial:\s*true/.test(readFileSync(join(SRC, service), "utf8"));
  }
  return false;
}

describe("Chaque ecriture des huit domaines passe par le controle territorial", () => {
  const toutes = Object.keys(FICHIERS).flatMap(ecritures);
  it("le balayage trouve bien des routes (sinon le test ne prouverait rien)", () => {
    expect(toutes.length).toBeGreaterThan(30);
  });
  it("chaque exemption designe une route qui existe encore", () => {
    for (const cle of Object.keys(EXEMPTIONS)) expect(toutes.map((e) => e.cle)).toContain(cle);
  });
  it.each(toutes.filter((e) => !EXEMPTIONS[e.cle]).map((e) => [e.cle, e] as const))("%s", (_cle, e) => {
    expect(gardee(e)).toBe(true);
  });
});
