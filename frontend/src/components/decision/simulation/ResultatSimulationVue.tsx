import type { ReactNode } from "react";
import {
  MENTION_SIMULATION, empreinteCourte, formaterKm, formaterPct, listerExclusions, type ScenarioSim,
} from "../../../lib/aideDecisionScenarios";
import { BandeauProvisoire } from "../../../pages/moteur/Bandeaux";
import { jourFr } from "../../../lib/tableauDeBord";
import { AvertissementsSimulation } from "./AvertissementsSimulation";
import { BilanBudgetaireVue } from "./BilanBudgetaireVue";
import { ContraintesVue } from "./ContraintesVue";
import { DistributionRegionale } from "./DistributionRegionale";
import { BandeauNonEngageant } from "./EtatsSimulation";
import { TableLignesSimulation } from "./TableLignesSimulation";

/**
 * Resultat complet d'une simulation (calculee ou relue d'un scenario enregistre) : mention « non engageante », bandeau
 * PROVISOIRE, bilan et deficit, avertissements (couts manquants ou perimes en evidence), contraintes et leur sort, interventions
 * et kilometres, risque couvert, distribution territoriale, exclusions par motif, lignes avec justification.
 *
 * Aucune valeur n'est calculee ici : tout vient du resultat du serveur (noyau teste contre un oracle SQL).
 */
export function ResultatSimulationVue({ resultat, regions, actions }: { resultat: ScenarioSim; regions: readonly { id: number; nom: string }[]; actions?: ReactNode }) {
  const sim = resultat.simulation;
  if (!sim) {
    return <p role="alert" className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950">Ce scénario a été calculé avant le simulateur : il n'a ni période, ni devise, ni déficit.</p>;
  }
  const codeDe = (id: string) => resultat.lignes.find((l) => l.troncon.id === id)?.troncon.code ?? id;
  const exclusions = listerExclusions(resultat.totaux.ecartesParMotif);
  const k = sim.kilometres;
  const r = sim.risqueCouvert;
  const cases: [string, string, string?][] = [
    ["Période", `${jourFr(sim.periode.debut)} au ${jourFr(sim.periode.fin)}`, `devise ${sim.devise}`],
    ["Interventions retenues", `${resultat.totaux.retenues} sur ${resultat.totaux.candidats} candidat(s)`, `${resultat.totaux.ecartees} exclue(s)`],
    ["Kilomètres concernés (longueur métier)", formaterKm(k.metierKm), k.lignesSansLongueurMetier > 0 ? `longueur métier absente pour ${k.lignesSansLongueurMetier} intervention(s)${k.geometriqueKm ? ` ; géométrique à part : ${formaterKm(k.geometriqueKm)}` : ""}` : undefined],
    ["Risque couvert", formaterPct(r.partChiffrablePct), r.nbSansRisqueCalculable > 0 ? `${r.nbSansRisqueCalculable} tronçon(s) sans risque calculable, non comptés` : "du risque des candidats chiffrés"],
    ["Version des paramètres", sim.parametresVersion, resultat.parametres.etiquette],
    ["Version des barèmes", `${sim.baremes.nbLignes} ligne(s) · empreinte ${empreinteCourte(sim.baremes.empreinte)}`, `${sim.baremes.nbApprouvees} approuvée(s), ${sim.baremes.nbProvisoires} provisoire(s)`],
  ];
  return (
    <div className="space-y-4" data-testid="resultat-simulation">
      <BandeauNonEngageant mention={sim.mention || MENTION_SIMULATION} />
      {resultat.provisoire && <BandeauProvisoire etiquette={resultat.etiquette} motifs={resultat.motifsProvisoire} detail="Aucun résultat n'est officiel : paramètres, barèmes ou logique ne sont pas tous approuvés." />}
      <section aria-labelledby="logique-titre" className="rounded-lg border bg-white p-3 text-sm">
        <h4 id="logique-titre" className="text-sm font-semibold text-navy">Logique de priorité : {sim.logique.libelle}{sim.logique.provisoire ? " (définition provisoire)" : ""}</h4>
        <p>{sim.logique.explication}</p>
        <p className="text-xs text-gray-700">Règle : {sim.logique.regle}</p>
      </section>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3" data-testid="synthese-simulation">
        {cases.map(([t, v, aide]) => (
          <div key={t}><dt className="text-xs text-gray-700">{t}</dt><dd className="font-medium">{v}</dd>{aide && <dd className="text-xs text-gray-700">{aide}</dd>}</div>
        ))}
      </dl>
      <BilanBudgetaireVue bilan={sim.bilan} />
      <AvertissementsSimulation simulation={sim} />
      <ContraintesVue contraintes={sim.contraintes} codeDe={codeDe} regions={regions} />
      <DistributionRegionale distribution={sim.distributionRegionale} regions={regions} />
      <section aria-labelledby="excl-titre" className="space-y-1">
        <h4 id="excl-titre" className="text-sm font-semibold text-navy">Exclusions par motif</h4>
        {exclusions.length === 0 ? <p className="text-sm text-gray-700">Aucune intervention exclue.</p> : (
          <ul className="list-disc pl-5 text-sm">
            {exclusions.map((e) => <li key={e.code}>{e.libelle} : {e.nb}{e.coutNonFiable ? " (coût non valorisé)" : ""}</li>)}
          </ul>
        )}
      </section>
      <TableLignesSimulation lignes={resultat.lignes} parametres={resultat.parametres} titre={`Lignes de la simulation ${resultat.annee}`} />
      <details className="text-xs text-gray-800">
        <summary className="cursor-pointer">Méthode et limites</summary>
        <p>{resultat.methode.id} version {resultat.methode.version}. Algorithme glouton, non optimal.</p>
        <ul className="list-disc pl-5">{resultat.limites.map((l) => <li key={l}>{l}</li>)}</ul>
        <p className="mt-1">{resultat.avertissement}</p>
      </details>
      {actions}
    </div>
  );
}
