import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { ControleVue } from "../../../lib/aideDecisionContractuel";
import { Button } from "../../ui/Button";

/**
 * Controles de coherence du perimetre : relations manquantes ou ambigues marche-chantier-troncon, bailleur, decomptes, dates,
 * avancement. Chaque controle dit son compte, la population examinee, ce qu'il n'a pas pu verifier et au plus cinq exemples
 * avec un lien. « 0 » est affiche tel quel, accompagne de sa population : c'est une mesure, pas une absence de mesure.
 */
export function ControlesCoherence({ controles, onOuvrirMarche }: { controles: ControleVue[]; onOuvrirMarche: (id: string) => void }) {
  return (
    <section aria-labelledby="titre-controles-contractuel" className="space-y-2">
      <h3 id="titre-controles-contractuel" className="text-sm font-semibold text-navy">Contrôles de cohérence</h3>
      <p className="text-xs text-gray-700">
        Définitions provisoires. Un contrôle signale une incohérence de la copie gelée ; il ne la corrige pas et ne dit pas laquelle des deux copies (Géoportail, DigitalRoad) a raison.
      </p>
      <ul className="grid gap-2 lg:grid-cols-2">
        {controles.map((c) => {
          const anomalie = c.nombre > 0;
          const unite = c.unite === "marches" ? "marché(s)" : "chantier(s)";
          return (
            <li key={c.code} data-controle={c.code} className={`rounded-lg border p-3 text-sm ${anomalie ? "border-amber-300 bg-amber-50" : "border-gray-200 bg-white"}`}>
              <h4 className="flex items-start gap-2 font-semibold text-gray-900">
                {anomalie ? <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-800" /> : <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-green-800" />}
                <span>{c.libelle}</span>
              </h4>
              <p className="mt-1 tabular-nums">
                <strong>{c.nombre}</strong> {unite} sur {c.surTotal} examiné(s)
                {c.nonVerifiables > 0 && <span className="block text-xs text-gray-700">{c.nonVerifiables} non vérifiable(s) faute de donnée : ni conformes, ni en anomalie.</span>}
              </p>
              <details className="mt-1 text-xs text-gray-700">
                <summary className="min-h-[44px] cursor-pointer py-2 xl:min-h-0 xl:py-0">Définition ({c.statutDefinition.toLowerCase()})</summary>
                <p className="mt-1">{c.definition}</p>
              </details>
              {c.exemples.length > 0 && (
                <ul className="mt-2 space-y-1.5 border-t border-amber-200 pt-2 text-xs">
                  {c.exemples.map((e) => (
                    <li key={`${e.type}-${e.id}-${e.detail}`} className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1"><strong>{e.intitule}</strong> : {e.detail}</span>
                      {e.type === "marche" || e.marcheId ? (
                        <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-0" aria-label={`Ouvrir la fiche : ${e.intitule}, ${c.libelle}, ${e.detail.slice(0, 60)}`} onClick={() => onOuvrirMarche(e.marcheId ?? e.id)}>
                          Ouvrir la fiche
                        </Button>
                      ) : (
                        <Link to="/chantiers" className="inline-flex min-h-[44px] items-center text-xs font-medium text-navy underline xl:min-h-0" aria-label={`Chercher dans la page Chantiers : ${e.intitule}`}>
                          Page Chantiers
                        </Link>
                      )}
                    </li>
                  ))}
                  {c.nombre > c.exemples.length && <li className="text-gray-700">… et {c.nombre - c.exemples.length} autre(s).</li>}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
