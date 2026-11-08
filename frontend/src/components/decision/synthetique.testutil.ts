import type { KpiLu } from "../../lib/aideDecisionApi";
import reponses from "./reponses-reelles.testdata.json";

/**
 * Fixtures des tests du module « Aide a la decision ». Elles ne sont PAS ecrites a la main : elles viennent de
 * `reponses-reelles.testdata.json`, ensemble de reponses REELLES de `composerSynthese` et `reponseDictionnaire`
 * (backend/src/aide-decision), capturees le 27/10/2026 par `scratchpad/ad/capture-synthese.mts` avec un depot injecte
 * aux donnees SYNTHETIQUES de `synthese.test.ts`. Les fixtures ecrites a la main inventaient la forme de la reponse
 * (champs, noms, unites) : c'est pourquoi les tests du premier jet passaient alors que le lecteur etait faux.
 *
 * Contenu du fichier (contrat paragraphe 10 : donnees synthetiques, jamais de donnee de production) :
 *   - `nationale`            compte national, tous droits : 12 indicateurs, 4 classes + etat non valide + non evalues ;
 *   - `regionaleSansDroits`  compte de la region Boke sans module marches ni programmation : montants NON_AUTORISE ;
 *   - `tronque`              ventilation par bailleur limitee, bailleurs agreges dans « autres » ;
 *   - `bailleurSansMontant`  un bailleur dont AUCUN marche n'a de montant GNF : contractuelGnf null, marches comptes ;
 *   - `tronqueAutresSansMontant`  liste tronquee dont la ligne « autres » a contractuelGnf null ;
 *   - `vide`                 perimetre sans troncon, sans marche : tout NON_DISPONIBLE ;
 *   - `dictionnaire`         la reponse de GET /dictionnaire.
 *
 * Ce fichier n'est importe que par des tests : il n'entre jamais dans le code livre.
 */

export type NomReponse = "nationale" | "regionaleSansDroits" | "tronque" | "bailleurSansMontant" | "tronqueAutresSansMontant" | "vide";

type Objet = Record<string, unknown>;

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Une reponse reelle de /synthese (copie profonde : les tests la modifient librement), avec surcharge de sections. */
export function syntheseReelle(nom: NomReponse = "nationale", surcharge: Objet = {}): Objet {
  return { ...clone((reponses as unknown as Record<NomReponse, Objet>)[nom]), ...surcharge };
}

/** La reponse reelle de GET /dictionnaire (objet `{ version, ..., indicateurs }`). */
export function dictionnaireReel(): Objet {
  return clone((reponses as unknown as { dictionnaire: Objet }).dictionnaire);
}

/** Les douze indicateurs de la reponse nationale reelle, tels que le serveur les envoie. */
export function kpisReels(): KpiLu[] {
  return syntheseReelle("nationale").kpis as KpiLu[];
}

/** Un indicateur de la reponse nationale reelle, par code. */
export function kpiReel(code: string): KpiLu {
  const k = kpisReels().find((x) => x.code === code);
  if (!k) throw new Error(`indicateur absent de la reponse reelle : ${code}`);
  return k;
}

export const REGIONS_SYNTHETIQUES = [
  { id: 1, nom: "Boké" },
  { id: 2, nom: "Kindia" },
  { id: 3, nom: "Non renseigné" },
];

/** Instant de reference des tests : 1 jour apres `calculeLe` de la reponse reelle (2026-10-26T12:00Z). */
export const MAINTENANT_SYNTHETIQUE = new Date("2026-10-27T12:00:00.000Z");
