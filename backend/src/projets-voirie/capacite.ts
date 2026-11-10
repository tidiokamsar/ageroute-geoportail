/**
 * CAPACITE DES CALCULS LOURDS (pilote local du 09/11/2026, defaut D4) : analyse 2D (`analyse.service.ts`), comptage des reseaux
 * (`reseaux/comptage.service.ts`) et analyse persistee des conflits (`conflits/analyse-conflits.service.ts`).
 *
 * Avant : le depot acceptait 50 000 objets et 200 000 sommets, mais ces trois calculs repondaient alors 500 ou 504 apres 20 a 50 s, sans refus
 * precoce (les seuls plafonds, 500 000 sommets d'axes et 3 000 000 de sommets de reseau, ne refletaient aucune mesure). Maintenant, chacun
 * commence par un COMPTAGE PREALABLE bon marche (objets lineaires et sommets des jeux retenus, `analyse.depot.ts` `volumes`, sans calcul
 * geometrique) et refuse IMMEDIATEMENT au-dela des plafonds : 422 `ANALYSE_TROP_VOLUMINEUSE`, le meme code que le plafond de conflits de RC-3,
 * avec le volume et les plafonds dans la reponse (`objets`, `sommets`, `objetsMax`, `sommetsMax`, `calcul`, et `sommetsAxes`, `sommetsReseau`
 * comme avant). Jamais un 500.
 *
 * REGLAGES (bornes ; une valeur absente, illisible ou hors bornes redonne le defaut, comme les autres reglages du module, config.ts) :
 *   PROJETS_VOIRIE_ANALYSE_OBJETS_MAX   defaut 5 000     (bornes 100 a 200 000)      objets lineaires des jeux retenus (axes + reseaux)
 *   PROJETS_VOIRIE_ANALYSE_SOMMETS_MAX  defaut 200 000   (bornes 1 000 a 4 000 000)  sommets de ces objets
 * DEFAUTS TIRES DE LA MESURE (banc `projets-voirie-capacite`, poste de developpement charge a 100 %, delai d'analyse de 20 s ; detail dans
 * docs/reports/CORRECTIFS-PILOTE-D4-D7.md) : apres le prefiltre des objets voisins, le calcul le plus lent des trois (l'analyse 2D) prend
 * environ 10 s a 5 000 objets et 25 a 30 s a 20 000 ; 5 000 objets et 200 000 sommets laissent une marge d'un facteur 2 sous le delai sur un
 * poste charge. Un exploitant qui mesure une machine plus rapide peut relever les plafonds (le banc donne la mesure : PV_CAPACITE_MESURE=1).
 */

import { borneEnv } from "./config";
import { ErreurMetier } from "./erreurs";
import type { Volumes } from "./analyse.depot";

export const OBJETS_ANALYSE_DEFAUT = 5_000;
export const SOMMETS_ANALYSE_DEFAUT = 200_000;

export const analyseObjetsMax = () => borneEnv("PROJETS_VOIRIE_ANALYSE_OBJETS_MAX", OBJETS_ANALYSE_DEFAUT, 100, 200_000);
export const analyseSommetsMax = () => borneEnv("PROJETS_VOIRIE_ANALYSE_SOMMETS_MAX", SOMMETS_ANALYSE_DEFAUT, 1_000, 4_000_000);

export type CalculLourd = "ANALYSE_2D" | "COMPTAGE" | "ANALYSE_CONFLITS";

const LIBELLE: Record<CalculLourd, string> = {
  ANALYSE_2D: "l'analyse 2D",
  COMPTAGE: "le comptage des réseaux",
  ANALYSE_CONFLITS: "l'analyse de conflits",
};

const fr = (n: number) => Math.round(n).toLocaleString("fr-FR").replace(/ | /g, " ");

/** Refus immediat (422 ANALYSE_TROP_VOLUMINEUSE) si le volume des jeux retenus depasse l'un des plafonds ; ne fait rien sinon. */
export function exigerCapacite(v: Volumes, calcul: CalculLourd, plafonds = { objetsMax: analyseObjetsMax(), sommetsMax: analyseSommetsMax() }): void {
  const objets = Math.round(v.objetsAxes + v.objetsReseau);
  const sommets = Math.round(v.sommetsAxes + v.sommetsReseau);
  if (objets <= plafonds.objetsMax && sommets <= plafonds.sommetsMax) return;
  throw new ErreurMetier(422, "ANALYSE_TROP_VOLUMINEUSE",
    `Les jeux retenus portent ${fr(objets)} objets linéaires et ${fr(sommets)} sommets : c'est au-delà de ce que ${LIBELLE[calcul]} peut traiter en un calcul immédiat (au plus ${fr(plafonds.objetsMax)} objets et ${fr(plafonds.sommetsMax)} sommets). Restreignez le calcul, découpez ou simplifiez les fichiers.`,
    {
      calcul, objets, sommets, objetsMax: plafonds.objetsMax, sommetsMax: plafonds.sommetsMax,
      objetsAxes: Math.round(v.objetsAxes), objetsReseau: Math.round(v.objetsReseau), sommetsAxes: Math.round(v.sommetsAxes), sommetsReseau: Math.round(v.sommetsReseau),
    });
}
