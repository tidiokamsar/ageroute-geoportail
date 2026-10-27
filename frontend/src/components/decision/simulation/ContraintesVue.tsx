/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- zone de defilement horizontal focusable au clavier (WCAG 2.1.1, regle axe scrollable-region-focusable) */
import { AlertTriangle } from "lucide-react";
import { LIBELLE_CONTRAINTE, libelleRegion, type ResultatSimulation } from "../../../lib/aideDecisionScenarios";
import { formaterGnf } from "../../../lib/moteurProgrammation";

/**
 * Contraintes d'une simulation et leur sort : obligatoires financees ou non, groupes non divisibles retenus entiers ou ecartes,
 * plafonds regionaux, plancher regional de l'equilibre territorial. Une contrainte INSATISFAISABLE est dite en alerte avec sa
 * cause ; le simulateur ne la comble jamais en silence (ni depassement d'enveloppe, ni cout raccourci).
 */
export function ContraintesVue({ contraintes, codeDe, regions }: { contraintes: ResultatSimulation["contraintes"]; codeDe: (id: string) => string; regions: readonly { id: number; nom: string }[] }) {
  const { obligatoires, groupesNonDivisibles: groupes, plafondsRegionauxGnf: plafonds, equilibre, insatisfaisables } = contraintes;
  const rien = obligatoires.demandees.length === 0 && groupes.length === 0 && Object.keys(plafonds).length === 0 && equilibre === null && insatisfaisables.length === 0;
  return (
    <section aria-labelledby="contr-titre" className="space-y-2" data-testid="contraintes">
      <h4 id="contr-titre" className="text-sm font-semibold text-navy">Contraintes</h4>
      {rien && <p className="text-sm text-gray-700">Aucune contrainte saisie : l'enveloppe est distribuée selon la seule logique de priorité.</p>}
      {insatisfaisables.length > 0 && (
        <div role="alert" data-testid="contraintes-insatisfaisables" className="space-y-1 rounded-lg border-2 border-red-400 bg-red-50 p-3 text-sm text-red-950">
          <p className="flex items-center gap-2 font-semibold"><AlertTriangle aria-hidden="true" className="h-4 w-4" />{insatisfaisables.length} contrainte(s) ne peuvent pas être satisfaites</p>
          <ul className="list-disc space-y-1 pl-5 text-xs">
            {insatisfaisables.map((c, i) => <li key={`${c.code}-${c.reference}-${i}`}><strong>{LIBELLE_CONTRAINTE[c.code] ?? c.code}</strong> : {c.detail}</li>)}
          </ul>
          <p className="text-xs">Elles ne sont pas comblées : l'enveloppe n'est pas dépassée et aucun coût n'est ajusté.</p>
        </div>
      )}
      {obligatoires.demandees.length > 0 && (
        <p className="text-sm">
          Interventions obligatoires : {obligatoires.retenues.length} financée(s) sur {obligatoires.effectives.length}
          {obligatoires.nonRetenues.length > 0 ? ` ; non financée(s) : ${obligatoires.nonRetenues.map(codeDe).join(", ")}` : ""}.
        </p>
      )}
      {groupes.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {groupes.map((g) => (
            <li key={g.numero}>
              Groupe non divisible n°{g.numero} ({g.membres.map(codeDe).join(", ")}) : <strong>{g.retenu ? `retenu en entier pour ${formaterGnf(g.coutGnf ?? "0")}` : "écarté en entier"}</strong>
              {g.motif ? ` (${g.motif.code})` : ""}.
            </li>
          ))}
        </ul>
      )}
      {Object.keys(plafonds).length > 0 && (
        <p className="text-sm">Plafonds régionaux : {Object.entries(plafonds).map(([r, v]) => `${libelleRegion(Number(r), regions)} ${formaterGnf(v)}`).join(" ; ")}.</p>
      )}
      {equilibre && (
        <div className="relative overflow-x-auto" role="region" tabIndex={0} aria-label="Plancher par région (défilement horizontal)">
          <table className="w-full text-left text-sm">
            <caption className="text-left text-xs font-semibold uppercase text-gray-700">Plancher de dépense par région (équilibre territorial)</caption>
            <thead className="text-xs uppercase text-gray-700"><tr><th scope="col" className="py-1 pr-2">Région</th><th scope="col" className="pr-2">Plancher</th><th scope="col" className="pr-2">Dépense</th><th scope="col">Atteint</th></tr></thead>
            <tbody>
              {equilibre.map((q) => (
                <tr key={q.regionId} className="border-t">
                  <th scope="row" className="py-1 pr-2 font-normal">{libelleRegion(q.regionId, regions)}</th>
                  <td className="whitespace-nowrap pr-2 tabular-nums">{formaterGnf(q.plancherGnf)}</td>
                  <td className="whitespace-nowrap pr-2 tabular-nums">{formaterGnf(q.depenseGnf)}</td>
                  <td className={q.atteint ? "text-green-900" : "font-semibold text-red-900"}>{q.atteint ? "oui" : "non"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
