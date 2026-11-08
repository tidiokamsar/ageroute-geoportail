/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- zone de defilement horizontal focusable au clavier (WCAG 2.1.1, regle axe scrollable-region-focusable) */
import { useId, useState } from "react";
import { LIBELLE_EXCLUSION_SIM, LIBELLE_PHASE, type LigneSim } from "../../../lib/aideDecisionScenarios";
import { formaterGnf, type Scenario } from "../../../lib/moteurProgrammation";
import { DetailLigne } from "../../../pages/moteur/LignesScenario";

/**
 * Interventions retenues et exclues d'une simulation, ligne par ligne. L'ORDRE D'ARBITRAGE (selon la logique choisie) et la
 * PRIORITE TECHNIQUE (rang du risque propre, sans le cout) sont deux colonnes distinctes : l'une ne remplace jamais l'autre.
 * Un cout manquant ou perime est dit « non fiable » et n'est jamais affiche comme un montant. La justification complete
 * (entrees, facteurs, formules, version des parametres) reutilise le detail du moteur de programmation.
 */

const PAS = 25;
type Filtre = "TOUTES" | "RETENUE" | "ECARTEE";

export function TableLignesSimulation({ lignes, parametres, titre }: { lignes: LigneSim[]; parametres: Scenario["parametres"]; titre: string }) {
  const idFiltre = useId();
  const [filtre, setFiltre] = useState<Filtre>("TOUTES");
  const [affiches, setAffiches] = useState(PAS);
  const [ouverte, setOuverte] = useState<string | null>(null);
  const visibles = lignes.filter((l) => filtre === "TOUTES" || l.decision === filtre);
  const montres = visibles.slice(0, affiches);
  return (
    <section aria-labelledby={`${idFiltre}-t`} className="space-y-2" data-testid="lignes-simulation">
      <h4 id={`${idFiltre}-t`} className="text-sm font-semibold text-navy">Interventions retenues et exclues</h4>
      <div>
        <label htmlFor={idFiltre} className="block text-xs text-gray-700">Lignes à afficher</label>
        <select id={idFiltre} value={filtre} onChange={(e) => { setFiltre(e.target.value as Filtre); setAffiches(PAS); }} className="min-h-[44px] rounded border px-2 py-1 text-sm xl:min-h-0">
          <option value="TOUTES">Toutes ({lignes.length})</option>
          <option value="RETENUE">Retenues ({lignes.filter((l) => l.decision === "RETENUE").length})</option>
          <option value="ECARTEE">Exclues ({lignes.filter((l) => l.decision === "ECARTEE").length})</option>
        </select>
      </div>
      <div className="relative overflow-x-auto" role="region" tabIndex={0} aria-label="Lignes de la simulation (défilement horizontal)">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{titre}</caption>
          <thead className="text-xs uppercase text-gray-700">
            <tr>
              <th scope="col" className="py-1 pr-2">Ordre d'arbitrage</th><th scope="col" className="pr-2">Priorité technique</th><th scope="col" className="pr-2">Tronçon</th>
              <th scope="col" className="pr-2">Décision</th><th scope="col" className="pr-2">Coût estimé</th><th scope="col" className="pr-2">Motif</th><th scope="col"><span className="sr-only">Justification</span></th>
            </tr>
          </thead>
          <tbody>
            {montres.map((l) => <Rangee key={l.troncon.id} l={l} ouvert={ouverte === l.troncon.id} parametres={parametres} basculer={() => setOuverte(ouverte === l.troncon.id ? null : l.troncon.id)} />)}
          </tbody>
        </table>
      </div>
      {visibles.length === 0 && <p className="text-sm text-gray-700">Aucune ligne pour ce filtre.</p>}
      {visibles.length > montres.length && (
        <button type="button" className="min-h-[44px] rounded border px-3 py-1 text-sm xl:min-h-0" onClick={() => setAffiches(affiches + PAS)}>
          Afficher {Math.min(PAS, visibles.length - montres.length)} ligne(s) de plus ({montres.length} sur {visibles.length})
        </button>
      )}
    </section>
  );
}

function Rangee({ l, ouvert, basculer, parametres }: { l: LigneSim; ouvert: boolean; basculer: () => void; parametres: Scenario["parametres"] }) {
  const id = useId();
  const s = l.simulation;
  const fiable = s ? s.coutFiable : l.cout?.ok === true;
  return (
    <>
      <tr className="border-t align-top">
        <td className="py-1 pr-2 tabular-nums">{s?.ordreArbitrage ?? (l.rangPriorite ?? "non classée")}</td>
        <td className="pr-2 tabular-nums">{s?.prioriteTechnique.rang ?? "non classée"}</td>
        <td className="pr-2">
          {l.troncon.code}{l.troncon.nom ? <span className="block text-xs text-gray-700">{l.troncon.nom}</span> : null}
          {s?.obligatoire && <span className="block text-xs font-semibold text-navy">Obligatoire</span>}
          {s?.groupe != null && <span className="block text-xs text-gray-700">Groupe non divisible n°{s.groupe}</span>}
        </td>
        <td className="pr-2">
          <span className={l.decision === "RETENUE" ? "font-semibold text-green-900" : "text-gray-900"}>{l.decision === "RETENUE" ? "Retenue" : "Exclue"}</span>
          {s?.phase && <span className="block text-xs text-gray-700">{LIBELLE_PHASE[s.phase]}</span>}
        </td>
        <td className="whitespace-nowrap pr-2 tabular-nums">
          {l.cout?.ok && fiable ? (
            <>{formaterGnf(l.cout.montantGnf)}{l.cout.provisoire && <span className="block text-xs text-amber-900">provisoire</span>}</>
          ) : (
            <span className="font-semibold text-red-900">{String(l.motifExclusion?.code) === "COUT_PERIME" ? "coût périmé" : "coût non fiable"}</span>
          )}
        </td>
        <td className="pr-2 text-xs">{l.motifExclusion ? (LIBELLE_EXCLUSION_SIM[l.motifExclusion.code] ?? l.motifExclusion.code) : ""}</td>
        <td>
          <button type="button" aria-expanded={ouvert} aria-controls={id} className="min-h-[44px] rounded border px-2 py-0.5 text-xs xl:min-h-0" onClick={basculer}>
            {ouvert ? "Masquer" : "Justification"}<span className="sr-only"> de {l.troncon.code}</span>
          </button>
        </td>
      </tr>
      {ouvert && (
        <tr id={id} className="bg-white">
          <td colSpan={7} className="p-3">
            <DetailLigne ligne={l} parametres={parametres} />
            {s?.coutSource && (
              <p className="mt-2 text-xs text-gray-800" data-testid={`source-cout-${l.troncon.code}`}>
                Source du coût : barème {s.coutSource.baremeCode ?? `n° ${s.coutSource.baremeId}`}, version {s.coutSource.version ?? "inconnue"}, unité {s.coutSource.uniteCout}/{s.coutSource.devise},{" "}
                {s.coutSource.validDe || s.coutSource.validA ? `validité ${s.coutSource.validDe ?? "sans début"} au ${s.coutSource.validA ?? "sans fin"}` : "sans fenêtre de validité"}, {s.coutSource.approuve ? "approuvé" : "provisoire (non approuvé)"}.
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
