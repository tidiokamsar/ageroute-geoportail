import { AlertTriangle, Info } from "lucide-react";
import { LIBELLE_EXCLUSION_SIM, classerAvertissements, type ResultatSimulation } from "../../../lib/aideDecisionScenarios";

/**
 * Avertissements d'une simulation. Les couts MANQUANTS ou PERIMES sont mis en evidence dans un bloc a part : ces interventions
 * ne sont pas simulees comme si leur cout etait fiable (AD-09), et l'ecran le dit avec leurs codes.
 */
export function AvertissementsSimulation({ simulation }: { simulation: ResultatSimulation }) {
  const nonFiables = simulation.coutsNonFiables;
  const avertissements = classerAvertissements(simulation.avertissements);
  if (nonFiables.length === 0 && avertissements.length === 0) {
    return <p role="status" className="text-sm text-gray-700">Aucun avertissement pour cette simulation.</p>;
  }
  return (
    <section aria-labelledby="avert-titre" className="space-y-3" data-testid="avertissements">
      <h4 id="avert-titre" className="text-sm font-semibold text-navy">Avertissements</h4>
      {nonFiables.length > 0 && (
        <div role="alert" data-testid="couts-non-fiables" className="space-y-2 rounded-lg border-2 border-red-400 bg-red-50 p-3 text-sm text-red-950">
          <p className="flex items-center gap-2 font-semibold"><AlertTriangle aria-hidden="true" className="h-4 w-4" />Coûts manquants ou périmés : ces interventions ne sont pas simulées avec un coût fiable.</p>
          <ul className="list-disc space-y-1 pl-5 text-xs">
            {nonFiables.map((c) => (
              <li key={c.code}>
                <strong>{LIBELLE_EXCLUSION_SIM[c.code] ?? c.code}</strong> : {c.nb} intervention(s)
                {c.troncons.length > 0 ? ` (${c.troncons.slice(0, 12).join(", ")}${c.nb > 12 ? ", …" : ""})` : ""}.
              </li>
            ))}
          </ul>
          <p className="text-xs">Leur coût n'est pas valorisé : le besoin et le déficit affichés sont donc des minimums.</p>
        </div>
      )}
      {avertissements.length > 0 && (
        <ul className="space-y-1 text-sm">
          {avertissements.map((a) => (
            <li key={a.code} data-niveau={a.niveau} className={`flex items-start gap-2 rounded border p-2 ${a.niveau === "ALERTE" ? "border-amber-300 bg-amber-50 text-amber-950" : "border-gray-300 bg-gray-50 text-gray-900"}`}>
              {a.niveau === "ALERTE" ? <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" /> : <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />}
              <span><span className="sr-only">{a.niveau === "ALERTE" ? "Alerte : " : "Information : "}</span>{a.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
