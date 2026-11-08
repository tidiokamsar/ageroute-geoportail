/**
 * Jeux de donnees de TEST du simulateur (options, version des baremes). Ce ne sont pas des donnees officielles :
 * ils completent `scenario.fixtures.ts` (neuf baremes `standard_initial`, trois candidats calcules a la main). Aucun
 * fichier de production n'importe ce module.
 */

import type { LigneBareme } from "../engines/cout.noyau";
import { refDe, versionBaremes, type BaremeRef } from "./comparaison.baremes.noyau";
import type { OptionsSimulation } from "./contraintes.noyau";
import { BAREMES, entreesDeBase } from "./scenario.fixtures";
import type { EntreesScenario } from "./scenario.noyau";

/** Versions des baremes de test : version 1, sans fenetre de validite, sauf `fenetres` (identifiant vers [validDe, validA]). */
export function versionDesBaremes(baremes: readonly LigneBareme[] = BAREMES, fenetres: Record<string, [string | null, string | null]> = {}) {
  const liste: BaremeRef[] = baremes.map((b) => {
    const [validDe, validA] = fenetres[String(b.id)] ?? [null, null];
    return refDe(b, { version: 1, validDe, validA });
  });
  return versionBaremes(liste);
}

export function optionsDeBase(o: Partial<OptionsSimulation> = {}, baremes: readonly LigneBareme[] = BAREMES): OptionsSimulation {
  return {
    version: 1,
    periode: { debut: "2027-01-01", fin: "2027-12-31" },
    devise: "GNF",
    logique: "ratio_cout_impact",
    ordrePersonnalise: [],
    equilibre: null,
    obligatoires: [],
    groupesNonDivisibles: [],
    baremes: versionDesBaremes(baremes),
    rangsTechniques: null,
    perimetre: { regionId: null, classe: null, selection: null },
    ...o,
  };
}

/** Entrees du simulateur : le jeu de base de `scenario.fixtures.ts` plus des options (la version des baremes suit les baremes fournis). */
export function entreesSimulation(o: Partial<EntreesScenario> = {}, opts: Partial<OptionsSimulation> = {}): EntreesScenario {
  const e = entreesDeBase(o);
  return { ...e, simulation: optionsDeBase({ baremes: versionDesBaremes(e.baremes), ...opts }, e.baremes) };
}
