/**
 * Control Tower : la synthese d'exploitation, lue sur ce qui existe.
 *
 * ELLE N'AJOUTE AUCUNE DONNEE. Chaque chiffre vient d'un indicateur du registre (donc d'une requete,
 * d'un perimetre et d'un controle). Un module dont la table source est vide affiche « aucune donnee »
 * avec son perimetre ; un module que le compte regional ne peut pas lire par region est declare
 * indisponible, jamais remplace par le national (A10).
 *
 * CE QU'ELLE NE COUVRE PAS, ET LE DIT
 *   - les doublons de geometrie : un balayage national de 261 387 tronçons, hors d'un ecran
 *     rafraichi (voir /qualite, qui l'exige explicitement) ;
 *   - la notification : aucune escalade n'est envoyee, le canal est une decision d'AGEROUTE ;
 *   - le "realise" physique : il vient de DigitalRoad (X-18, bloque), pas de cette base.
 */

import { evaluer, type IndicateurEvalue } from "./tableau-de-bord.service";
import type { DefinitionIndicateur, Portee } from "./indicateurs.noyau";

export interface ModuleControlTower {
  code: string;
  libelle: string;
  /** Page applicative ou l'on traite ce que le module signale. */
  lien: string;
  indicateurs: IndicateurEvalue[];
  /** Tous les indicateurs du module reposent sur une table vide (ou une valeur non calculable) dans la portee. */
  aucuneDonnee: boolean;
  /** Tous les indicateurs du module sont indisponibles pour ce compte regional. */
  indisponible: boolean;
}

export interface ControlTower {
  genereLe: string;
  modules: ModuleControlTower[];
  nonCouvert: string[];
}

interface Module { code: string; libelle: string; lien: string; codes: readonly string[] }

/** Les modules et les indicateurs qui les composent, nommes un a un : rien n'entre dans la Control Tower par accident. */
export const MODULES_CONTROL_TOWER: readonly Module[] = [
  { code: "veille", libelle: "Cellule de veille", lien: "/veille", codes: ["evenements_actifs", "evenements_non_pris_en_compte", "evenements_escalades", "trous_de_permanence", "regles_escalade_actives"] },
  { code: "patrouilles", libelle: "Patrouilles programmées", lien: "/exploitation/patrouilles", codes: ["programmes_patrouille_actifs", "patrouilles_en_retard"] },
  { code: "teledetection", libelle: "Observation de la Terre", lien: "/teledetection", codes: ["propositions_a_verifier"] },
  { code: "qualite", libelle: "Anomalies de qualité bloquantes", lien: "/qualite", codes: ["troncons_geometrie_invalide", "portions_chevauchantes"] },
  { code: "programmation", libelle: "Programme, réalisé et budget", lien: "/programmation", codes: ["previsions_retenues_nb", "previsions_retenues_gnf", "previsions_realisees_nb", "previsions_realisees_gnf", "chantiers_en_retard", "chantiers_montant_gnf"] },
];

export const NON_COUVERT_CONTROL_TOWER: readonly string[] = [
  "Doublons de géométrie : balayage national de 261 387 tronçons, non rejoué à chaque rafraîchissement (voir la page Qualité des données).",
  "Aucune notification n'est envoyée : les escalades sont inscrites et affichées, le canal reste à choisir par AGEROUTE.",
  "Réalisé physique : il viendra de DigitalRoad (retours de programmation), pas de cette base. Le « réalisé » affiché ici est le statut posé à la main sur les prévisions.",
];

export async function controlTower<D>(depot: D, registre: readonly DefinitionIndicateur<D>[], portee: Portee): Promise<ControlTower> {
  const codes = MODULES_CONTROL_TOWER.flatMap((m) => m.codes);
  const evalues = await evaluer(depot, registre, portee, { codes });
  const parCode = new Map(evalues.map((e) => [e.code, e]));
  return {
    genereLe: portee.maintenant.toISOString(),
    modules: MODULES_CONTROL_TOWER.map((m) => {
      const indicateurs = m.codes.map((c) => parCode.get(c)).filter((e): e is IndicateurEvalue => e !== undefined);
      return {
        code: m.code, libelle: m.libelle, lien: m.lien, indicateurs,
        aucuneDonnee: indicateurs.length > 0 && indicateurs.every((i) => i.statut === "CALCULE" && i.aucuneDonnee),
        indisponible: indicateurs.length > 0 && indicateurs.every((i) => i.statut === "INDISPONIBLE"),
      };
    }),
    nonCouvert: [...NON_COUVERT_CONTROL_TOWER],
  };
}
