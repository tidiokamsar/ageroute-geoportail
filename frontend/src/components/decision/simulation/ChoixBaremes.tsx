/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- zone de defilement horizontal focusable au clavier (WCAG 2.1.1, regle axe scrollable-region-focusable) */
import { libelleStatutBareme, libelleValiditeBareme, type BaremeOption, type FormulaireSimulation } from "../../../lib/aideDecisionScenarios";
import { formaterGnf } from "../../../lib/moteurProgrammation";
import { CaseACocher } from "./CaseACocher";

/**
 * Baremes applicables a la periode. Chaque ligne dit sa version, son statut d'approbation (un bareme non approuve est
 * « provisoire »), sa fenetre de validite et si elle couvre la periode : un bareme qui ne la couvre pas donnera des couts
 * PERIMES, ecartes de la simulation. Par defaut tous sont retenus (aucun identifiant envoye) ; en decocher restreint le choix.
 */
export function ChoixBaremes({ baremes, form, onForm, erreur }: { baremes: BaremeOption[]; form: FormulaireSimulation; onForm: (f: FormulaireSimulation) => void; erreur?: string }) {
  if (baremes.length === 0) {
    return <p role="alert" className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950">Aucun barème actif : aucun coût ne peut être chiffré, toutes les interventions seront écartées (coût manquant).</p>;
  }
  const retenus = form.baremeIds === null ? baremes.map((b) => Number(b.id)) : form.baremeIds;
  const basculerBareme = (id: number) => {
    const suivant = retenus.includes(id) ? retenus.filter((x) => x !== id) : [...retenus, id];
    onForm({ ...form, baremeIds: suivant.length === baremes.length ? null : suivant });
  };
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="text-sm font-semibold text-navy">Barèmes applicables</legend>
      <p className="text-xs text-gray-700">{retenus.length} barème(s) retenu(s) sur {baremes.length}. Un barème non approuvé rend les coûts provisoires.</p>
      <div className="relative overflow-x-auto" role="region" tabIndex={0} aria-label="Barèmes applicables (défilement horizontal)">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Barèmes de coût applicables à la période</caption>
          <thead className="text-xs uppercase text-gray-700">
            <tr><th scope="col" className="py-1 pr-2">Retenu</th><th scope="col" className="pr-2">Barème</th><th scope="col" className="pr-2">Coût au km</th><th scope="col" className="pr-2">Version</th><th scope="col" className="pr-2">Statut</th><th scope="col">Validité</th></tr>
          </thead>
          <tbody>
            {baremes.map((b) => {
              const nom = b.code ?? `n° ${b.id}`;
              return (
                <tr key={String(b.id)} className="border-t align-top">
                  <td className="py-1 pr-2"><CaseACocher checked={retenus.includes(Number(b.id))} aria-label={`Retenir le barème ${nom}`} onChange={() => basculerBareme(Number(b.id))} /></td>
                  <td className="pr-2">{nom}<span className="block text-xs text-gray-700">{b.typeIntervention} · {b.familleRevetement} · {b.etatDepart}</span></td>
                  <td className="whitespace-nowrap pr-2 tabular-nums">{formaterGnf(b.coutKmGnf)}</td>
                  <td className="pr-2 tabular-nums">{b.version ?? "inconnue"}</td>
                  <td className={`pr-2 ${b.statut === "PROVISOIRE" ? "text-amber-950" : "text-green-900"}`}>{libelleStatutBareme(b.statut)}</td>
                  <td className="text-xs">{libelleValiditeBareme(b)}{!b.couvrePeriode && <span className="block font-semibold text-red-900">ne couvre pas la période : coûts périmés</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {erreur && <p role="alert" className="text-xs text-red-900">{erreur}</p>}
    </fieldset>
  );
}
