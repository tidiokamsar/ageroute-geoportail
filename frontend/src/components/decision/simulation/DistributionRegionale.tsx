/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- zone de defilement horizontal focusable au clavier (WCAG 2.1.1, regle axe scrollable-region-focusable) */
import { formaterPart, libelleRegion, partDe, type ResultatSimulation } from "../../../lib/aideDecisionScenarios";
import { formaterGnf } from "../../../lib/moteurProgrammation";

/**
 * Distribution territoriale d'une simulation : par region, interventions retenues, montant engage, ecartees et besoin.
 * Le tableau est la lecture de reference (accessible) ; les barres ne sont qu'un renfort visuel (aria-hidden), proportionnelles
 * au besoin de la region, calculees en BigInt.
 */
export function DistributionRegionale({ distribution, regions }: { distribution: ResultatSimulation["distributionRegionale"]; regions: readonly { id: number; nom: string }[] }) {
  if (distribution.length === 0) return <p className="text-sm text-gray-700">Aucune région dans cette simulation.</p>;
  return (
    <section aria-labelledby="distrib-titre" className="space-y-2" data-testid="distribution-regionale">
      <h4 id="distrib-titre" className="text-sm font-semibold text-navy">Distribution territoriale</h4>
      <div className="relative overflow-x-auto" role="region" tabIndex={0} aria-label="Distribution territoriale (défilement horizontal)">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Interventions retenues et montants engagés par région</caption>
          <thead className="text-xs uppercase text-gray-700">
            <tr><th scope="col" className="py-1 pr-2">Région</th><th scope="col" className="pr-2">Retenues</th><th scope="col" className="pr-2">Écartées</th><th scope="col" className="pr-2">Engagé</th><th scope="col" className="pr-2">Besoin chiffré</th><th scope="col">Part du besoin engagée</th></tr>
          </thead>
          <tbody>
            {distribution.map((r) => {
              const part = partDe(r.engageGnf, r.besoinGnf);
              return (
                <tr key={String(r.regionId)} className="border-t align-middle">
                  <th scope="row" className="py-1 pr-2 font-normal">{libelleRegion(r.regionId, regions)}</th>
                  <td className="pr-2 tabular-nums">{r.nbRetenues}</td>
                  <td className="pr-2 tabular-nums">{r.nbEcartees}</td>
                  <td className="pr-2 whitespace-nowrap tabular-nums">{formaterGnf(r.engageGnf)}</td>
                  <td className="pr-2 whitespace-nowrap tabular-nums">{formaterGnf(r.besoinGnf)}</td>
                  <td className="min-w-[8rem]">
                    <div className="flex items-center gap-2">
                      <div aria-hidden="true" className="h-2 flex-1 rounded bg-gray-200"><div className="h-2 rounded bg-navy" style={{ width: `${part ?? 0}%` }} /></div>
                      <span className="tabular-nums text-xs">{formaterPart(part)}</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
