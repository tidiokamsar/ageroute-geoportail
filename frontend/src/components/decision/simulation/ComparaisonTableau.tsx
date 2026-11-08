/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- zone de defilement horizontal focusable au clavier (WCAG 2.1.1, regle axe scrollable-region-focusable) */
import { type ReactNode } from "react";
import {
  LIBELLE_EXCLUSION_SIM, empreinteCourte, formaterKm, formaterPart, formaterPct, formaterSolde, libelleRegion, partDe, type ColonneComparaison, type Comparaison,
} from "../../../lib/aideDecisionScenarios";
import { enMilliards, formaterGnf } from "../../../lib/moteurProgrammation";
import { jourFr } from "../../../lib/tableauDeBord";
import { BandeauNonEngageant } from "./EtatsSimulation";

/**
 * Comparaison de 2 a 5 scenarios cote a cote. Le TABLEAU est la lecture de reference (accessible : en-tetes de ligne et de colonne
 * associes, legende) ; les barres ne font que le renforcer visuellement (aria-hidden), avec la valeur ecrite a cote.
 * Rien n'est calcule ici : tout vient des resultats scelles. Le deficit garde son signe et sa mention « minimum » ; une longueur
 * metier absente se dit, la geometrique n'est jamais substituee.
 */
export function ComparaisonTableau({ comparaison, regions }: { comparaison: Comparaison; regions: readonly { id: number; nom: string }[] }) {
  const cols = comparaison.scenarios;
  const ligne = (titre: string, cellule: (c: ColonneComparaison) => ReactNode, id?: string) => (
    <tr key={titre} className="border-t align-top" data-testid={id}>
      <th scope="row" className="py-1 pr-3 text-left text-xs font-semibold text-gray-800">{titre}</th>
      {cols.map((c) => <td key={c.id} className="pr-3 text-sm tabular-nums">{cellule(c)}</td>)}
    </tr>
  );
  return (
    <section aria-labelledby="cmp-titre" className="space-y-4" data-testid="comparaison">
      <h4 id="cmp-titre" className="text-base font-semibold text-navy">Comparaison de {cols.length} scénarios</h4>
      <BandeauNonEngageant mention={comparaison.mention} />
      <p className="text-xs text-gray-700">Période commune : {jourFr(comparaison.periode.debut)} au {jourFr(comparaison.periode.fin)} · devise {comparaison.devise}. Aucune donnée officielle n'est modifiée par la comparaison.</p>

      <div className="space-y-2" data-testid="barres-comparaison">
        {cols.map((c) => {
          const part = partDe(c.consommeGnf, c.enveloppeGnf);
          return (
            <div key={c.id} className="text-sm">
              <p className="font-medium">{c.intitule}</p>
              <div className="flex items-center gap-2">
                <div aria-hidden="true" className="h-3 flex-1 rounded bg-gray-200"><div className="h-3 rounded bg-navy" style={{ width: `${part ?? 0}%` }} /></div>
                <span className="text-xs tabular-nums">{part === null ? "Part de l'enveloppe consommée : non calculable (enveloppe nulle)" : `${formaterPart(part)} de l'enveloppe consommée`}</span>
              </div>
              <p className={`text-xs ${c.deficitGnf !== "0" ? "font-semibold text-red-900" : "text-gray-800"}`}>
                {c.deficitGnf !== "0" ? `Déficit de ${formaterGnf(c.deficitGnf)}${c.deficitMinorant ? " (minimum)" : ""}` : c.deficitMinorant ? `Aucun déficit chiffré : ${c.nbCoutsNonFiables} coût(s) non fiable(s) ne sont pas comptés` : "Aucun déficit"}
              </p>
            </div>
          );
        })}
      </div>

      <div className="relative overflow-x-auto" role="region" tabIndex={0} aria-label="Comparaison des scénarios (défilement horizontal)">
        <table className="w-full min-w-[32rem] text-left">
          <caption className="sr-only">Comparaison côte à côte de {cols.length} scénarios de simulation</caption>
          <thead>
            <tr>
              <th scope="col" className="py-1 pr-3 text-xs uppercase text-gray-700">Indicateur</th>
              {cols.map((c) => <th key={c.id} scope="col" className="pr-3 text-sm font-semibold">{c.intitule}<span className="block text-xs font-normal text-gray-700">{c.logique.libelle}</span></th>)}
            </tr>
          </thead>
          <tbody>
            {ligne("Statut", (c) => c.etiquette)}
            {ligne("Enveloppe", (c) => (<>{formaterGnf(c.enveloppeGnf)}<span className="block text-xs text-gray-700">{enMilliards(c.enveloppeGnf)}</span></>), "ligne-enveloppe")}
            {ligne("Consommé", (c) => formaterGnf(c.consommeGnf), "ligne-consomme")}
            {ligne("Reste", (c) => formaterGnf(c.resteGnf), "ligne-reste")}
            {ligne("Besoin chiffré", (c) => formaterGnf(c.besoinTotalGnf))}
            {ligne("Déficit", (c) => (
              <span className={c.deficitGnf !== "0" ? "font-semibold text-red-900" : ""}>
                {c.deficitGnf !== "0" ? formaterGnf(c.deficitGnf) : "aucun"}{c.deficitMinorant ? <span className="block text-xs font-normal">minimum : {c.nbCoutsNonFiables} coût(s) non fiable(s)</span> : null}
                <span className="block text-xs font-normal text-gray-700">solde {formaterSolde(c.soldeGnf)}</span>
              </span>
            ), "ligne-deficit")}
            {ligne("Interventions retenues", (c) => `${c.nbInterventions} sur ${c.nbCandidats}`, "ligne-interventions")}
            {ligne("Kilomètres (longueur métier)", (c) => (<>{formaterKm(c.kilometres.metierKm)}{c.kilometres.lignesSansLongueurMetier > 0 && <span className="block text-xs text-gray-700">longueur métier absente pour {c.kilometres.lignesSansLongueurMetier} intervention(s){c.kilometres.geometriqueKm ? ` ; géométrique à part : ${formaterKm(c.kilometres.geometriqueKm)}` : ""}</span>}</>), "ligne-km")}
            {ligne("Risque couvert", (c) => formaterPct(c.risqueCouvert.partChiffrablePct))}
            {ligne("Exclusions par motif", (c) => {
              const l = Object.entries(c.exclusionsParMotif);
              return l.length === 0 ? "aucune" : <ul className="text-xs">{l.map(([k, n]) => <li key={k}>{LIBELLE_EXCLUSION_SIM[k] ?? k} : {n}</li>)}</ul>;
            })}
            {ligne("Distribution régionale", (c) => (
              <ul className="text-xs">{c.distributionRegionale.map((r) => <li key={String(r.regionId)}>{libelleRegion(r.regionId, regions)} : {r.nbRetenues} retenue(s), {formaterGnf(r.engageGnf)}</li>)}</ul>
            ))}
            {ligne("Contraintes insatisfaisables", (c) => c.nbContraintesInsatisfaisables)}
            {ligne("Version des paramètres", (c) => c.parametresVersion)}
            {ligne("Version des barèmes", (c) => (<>{c.baremes.nbLignes} ligne(s)<span className="block text-xs text-gray-700">{empreinteCourte(c.baremes.empreinte)} · {c.baremes.nbApprouvees} approuvée(s)</span></>))}
          </tbody>
        </table>
      </div>

      <div className="relative overflow-x-auto" role="region" tabIndex={0} aria-label="Hypothèses des scénarios (défilement horizontal)">
        <table className="w-full min-w-[32rem] text-left" data-testid="hypotheses">
          <caption className="text-left text-xs font-semibold uppercase text-gray-700">Hypothèses : en gras, celles qui diffèrent d'un scénario à l'autre</caption>
          <thead><tr><th scope="col" className="py-1 pr-3 text-xs uppercase text-gray-700">Hypothèse</th>{cols.map((c) => <th key={c.id} scope="col" className="pr-3 text-xs">{c.intitule}</th>)}</tr></thead>
          <tbody>
            {comparaison.hypotheses.map((h) => (
              <tr key={h.champ} className={`border-t align-top ${h.identiques ? "" : "bg-amber-50"}`} data-differe={!h.identiques}>
                <th scope="row" className={`py-1 pr-3 text-left text-xs ${h.identiques ? "font-normal" : "font-bold"}`}>{h.libelle}{!h.identiques && <span className="sr-only"> (diffère)</span>}</th>
                {h.valeurs.map((v, i) => <td key={cols[i].id} className={`pr-3 text-xs ${h.identiques ? "" : "font-bold"}`}>{v}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-800" data-testid="interventions-communes">
        Interventions retenues dans tous les scénarios : {comparaison.interventions.communes}. Propres à un seul : {comparaison.interventions.propres.map((p) => `${cols.find((c) => c.id === p.id)?.intitule ?? p.id} ${p.nb}`).join(" ; ")}.
      </p>
    </section>
  );
}
