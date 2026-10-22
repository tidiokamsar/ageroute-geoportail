/**
 * Jeux de donnees de TEST du moteur de programmation. Ce ne sont pas des donnees officielles :
 * les neuf baremes recopient les lignes `standard_initial` de la base (non approuvees, sans
 * millesime ni largeur), le catalogue et les conditions recopient la migration 20261014220000,
 * les matrices recopient le semis HDM-4 simplifie de 20260706100000. Aucun fichier de production
 * n'importe ce module.
 */

import type { LigneBareme } from "../engines/cout.noyau";
import type { ConditionTraitement, LigneMatrice, Traitement } from "../engines/traitement.noyau";
import { parametresAmorcage } from "./parametres.noyau";
import type { CandidatTroncon, EntreesScenario } from "./scenario.noyau";

export const BAREMES: LigneBareme[] = [
  { id: 1, code: null, familleRevetement: "bitume", etatDepart: "MOYEN", typeIntervention: "entretien_periodique", coutKmGnf: 350_000_000n, uniteCout: "KM", devise: "GNF" },
  { id: 2, code: null, familleRevetement: "bitume", etatDepart: "MAUVAIS", typeIntervention: "rehabilitation", coutKmGnf: 1_100_000_000n, uniteCout: "KM", devise: "GNF" },
  { id: 3, code: null, familleRevetement: "bitume", etatDepart: "CRITIQUE", typeIntervention: "reconstruction", coutKmGnf: 3_500_000_000n, uniteCout: "KM", devise: "GNF" },
  { id: 4, code: null, familleRevetement: "terre_laterite", etatDepart: "MOYEN", typeIntervention: "entretien_periodique", coutKmGnf: 80_000_000n, uniteCout: "KM", devise: "GNF" },
  { id: 5, code: null, familleRevetement: "terre_laterite", etatDepart: "MAUVAIS", typeIntervention: "rehabilitation", coutKmGnf: 250_000_000n, uniteCout: "KM", devise: "GNF" },
  { id: 6, code: null, familleRevetement: "terre_laterite", etatDepart: "CRITIQUE", typeIntervention: "reconstruction", coutKmGnf: 700_000_000n, uniteCout: "KM", devise: "GNF" },
  { id: 7, code: null, familleRevetement: "pave", etatDepart: "MOYEN", typeIntervention: "entretien_periodique", coutKmGnf: 300_000_000n, uniteCout: "KM", devise: "GNF" },
  { id: 8, code: null, familleRevetement: "pave", etatDepart: "MAUVAIS", typeIntervention: "rehabilitation", coutKmGnf: 900_000_000n, uniteCout: "KM", devise: "GNF" },
  { id: 9, code: null, familleRevetement: "pave", etatDepart: "CRITIQUE", typeIntervention: "reconstruction", coutKmGnf: 2_800_000_000n, uniteCout: "KM", devise: "GNF" },
];

export const CATALOGUE: Traitement[] = [
  { code: "entretien_periodique", libelle: "Entretien periodique", famille: "ENTRETIEN_PERIODIQUE", version: 1 },
  { code: "rehabilitation", libelle: "Rehabilitation", famille: "REHABILITATION", version: 1 },
  { code: "reconstruction", libelle: "Reconstruction", famille: "RECONSTRUCTION", version: 1 },
];

export const CONDITIONS: ConditionTraitement[] = BAREMES.map((b) => ({
  traitementCode: b.typeIntervention, familleRevetement: b.familleRevetement, etatDepart: b.etatDepart, classeTrafic: null,
}));

export const MATRICES: LigneMatrice[] = [
  { familleRevetement: "bitume", classeTrafic: "T1_faible", pBonVersMoyen: 0.08, pMoyenVersMauvais: 0.12, pMauvaisVersCritique: 0.18 },
  { familleRevetement: "bitume", classeTrafic: "T2_moyen", pBonVersMoyen: 0.12, pMoyenVersMauvais: 0.18, pMauvaisVersCritique: 0.25 },
  { familleRevetement: "bitume", classeTrafic: "T3_fort", pBonVersMoyen: 0.18, pMoyenVersMauvais: 0.28, pMauvaisVersCritique: 0.38 },
  { familleRevetement: "terre_laterite", classeTrafic: "T1_faible", pBonVersMoyen: 0.25, pMoyenVersMauvais: 0.35, pMauvaisVersCritique: 0.45 },
  { familleRevetement: "terre_laterite", classeTrafic: "T2_moyen", pBonVersMoyen: 0.35, pMoyenVersMauvais: 0.5, pMauvaisVersCritique: 0.6 },
  { familleRevetement: "terre_laterite", classeTrafic: "T3_fort", pBonVersMoyen: 0.5, pMoyenVersMauvais: 0.65, pMauvaisVersCritique: 0.75 },
  { familleRevetement: "pave", classeTrafic: "T1_faible", pBonVersMoyen: 0.06, pMoyenVersMauvais: 0.1, pMauvaisVersCritique: 0.15 },
  { familleRevetement: "pave", classeTrafic: "T2_moyen", pBonVersMoyen: 0.09, pMoyenVersMauvais: 0.14, pMauvaisVersCritique: 0.2 },
  { familleRevetement: "pave", classeTrafic: "T3_fort", pBonVersMoyen: 0.14, pMoyenVersMauvais: 0.22, pMauvaisVersCritique: 0.3 },
];

export function candidat(id: string, o: Partial<CandidatTroncon> = {}): CandidatTroncon {
  return {
    id, code: o.code ?? `T-${id}`, nom: null, regionId: 1, classe: "RN", revetement: "BITUME", longueurM: 1000,
    etat: "MAUVAIS", traficMoyenJma: null, criticiteStrategique: null, nbPointsNoirs: null, vulnerabiliteClimatique: null, populationDesservie: null,
    ...o,
  };
}

/** Jeu de base : trois candidats chiffrables dont les resultats sont calcules a la main dans les tests. */
export function candidatsDeBase(): CandidatTroncon[] {
  return [
    // risque (40x65 + 25x50 + 15x200/3)/80 = 60,625 ; classe T3 ; rehabilitation bitume ; 4 000 m x 1,1 Md/km = 4,4 Md
    candidat("a", { code: "RN-A", etat: "MAUVAIS", traficMoyenJma: 2500, nbPointsNoirs: 2, longueurM: 4000 }),
    // risque (40x90 + 25x12)/80 = 48,75 ; classe T2 ; reconstruction bitume ; 1 000 m x 3,5 Md/km = 3,5 Md
    candidat("b", { code: "RN-B", etat: "CRITIQUE", traficMoyenJma: 600, nbPointsNoirs: 0, longueurM: 1000, regionId: 2 }),
    // risque (40x35 + 25x2 + 15x100/3)/80 = 24,375 ; classe T1 ; entretien terre ; 10 000 m x 80 M/km = 0,8 Md
    candidat("c", { code: "RN-C", etat: "MOYEN", traficMoyenJma: 100, nbPointsNoirs: 1, longueurM: 10000, revetement: "TERRE" }),
  ];
}

export function entreesDeBase(o: Partial<EntreesScenario> = {}): EntreesScenario {
  return {
    annee: 2027,
    budgetGnf: 10_000_000_000n,
    plafondsRegionauxGnf: {},
    parametres: parametresAmorcage(),
    candidats: candidatsDeBase(),
    baremes: BAREMES,
    catalogue: CATALOGUE,
    conditions: CONDITIONS,
    matrices: MATRICES,
    ...o,
  };
}
