import { useId, useState } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { deplacer, LIBELLE_LOGIQUE, type CandidatApercu, type DefinitionLogique, type FormulaireSimulation } from "../../../lib/aideDecisionScenarios";

/**
 * Choix de la logique de priorite parmi les cinq autorisees. Chaque option dit ce qu'elle fait ; une definition non validee
 * par le metier est marquee « provisoire ». L'equilibre territorial demande la part minimale par region ; l'ordre personnalise
 * demande une liste ordonnee de tronçons (monter, descendre, retirer : aucun glisser-deposer, tout est au clavier).
 */
export function ChoixLogique({ logiques, form, onForm, candidats, erreurs }: {
  logiques: DefinitionLogique[]; form: FormulaireSimulation; onForm: (f: FormulaireSimulation) => void; candidats: readonly CandidatApercu[]; erreurs: Record<string, string>;
}) {
  const idPart = useId(); const idAjout = useId();
  const [ajout, setAjout] = useState("");
  const codeDe = (id: string) => candidats.find((c) => c.id === id)?.code ?? id;
  const disponibles = candidats.filter((c) => (form.selection === null || form.selection.includes(c.id)) && !form.ordrePersonnalise.includes(c.id));
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="text-sm font-semibold text-navy">Logique de priorité</legend>
      <div role="radiogroup" aria-label="Logique de priorité" className="space-y-2">
        {logiques.map((l) => (
          <label key={l.code} className="flex cursor-pointer items-start gap-2 rounded border p-2 text-sm has-[:checked]:border-navy has-[:checked]:bg-sky-50">
            <input type="radio" name="logique" value={l.code} checked={form.logique === l.code} onChange={() => onForm({ ...form, logique: l.code })} className="mt-1 h-5 w-5" />
            <span>
              <span className="font-medium">{LIBELLE_LOGIQUE[l.code] ?? l.libelle}{l.provisoire ? <span className="ml-2 rounded bg-amber-100 px-1 text-xs text-amber-950">provisoire</span> : null}</span>
              <span className="block text-xs text-gray-700">{l.explication}</span>
            </span>
          </label>
        ))}
      </div>
      {erreurs.logique && <p role="alert" className="text-xs text-red-900">{erreurs.logique}</p>}
      {form.logique === "equilibre_territorial" && (
        <div>
          <label htmlFor={idPart} className="block text-xs text-gray-700">Part minimale de l'enveloppe garantie à chaque région (%, entier de 1 à 100)</label>
          <input id={idPart} inputMode="numeric" value={form.partMinimalePct} onChange={(e) => onForm({ ...form, partMinimalePct: e.target.value })} aria-invalid={!!erreurs.partMinimale}
            aria-describedby={erreurs.partMinimale ? `${idPart}-e` : undefined} className="min-h-[44px] w-24 rounded border px-2 py-1.5 text-sm tabular-nums xl:min-h-0" />
          {erreurs.partMinimale && <p id={`${idPart}-e`} role="alert" className="text-xs text-red-900">{erreurs.partMinimale}</p>}
          <p className="text-xs text-gray-700">Plancher d'une région = part x enveloppe. Une région qui ne l'atteint pas est signalée, jamais comblée en silence.</p>
        </div>
      )}
      {form.logique === "personnalise" && (
        <div className="space-y-2" data-testid="ordre-personnalise">
          <p className="text-xs text-gray-700">Les tronçons non listés passent après la liste, par ratio coût / impact.</p>
          {form.ordrePersonnalise.length === 0 ? <p className="text-sm text-gray-700">Aucun tronçon dans l'ordre : ajoutez-en.</p> : (
            <ol className="space-y-1 text-sm">
              {form.ordrePersonnalise.map((id, i) => (
                <li key={id} className="flex items-center gap-2">
                  <span className="w-6 tabular-nums">{i + 1}.</span><span className="flex-1">{codeDe(id)}</span>
                  <button type="button" className="min-h-[44px] min-w-[44px] rounded border xl:min-h-0 xl:min-w-0 xl:p-1" aria-label={`Monter ${codeDe(id)}`} disabled={i === 0} onClick={() => onForm({ ...form, ordrePersonnalise: deplacer(form.ordrePersonnalise, i, -1) })}><ArrowUp aria-hidden="true" className="mx-auto h-4 w-4" /></button>
                  <button type="button" className="min-h-[44px] min-w-[44px] rounded border xl:min-h-0 xl:min-w-0 xl:p-1" aria-label={`Descendre ${codeDe(id)}`} disabled={i === form.ordrePersonnalise.length - 1} onClick={() => onForm({ ...form, ordrePersonnalise: deplacer(form.ordrePersonnalise, i, 1) })}><ArrowDown aria-hidden="true" className="mx-auto h-4 w-4" /></button>
                  <button type="button" className="min-h-[44px] min-w-[44px] rounded border xl:min-h-0 xl:min-w-0 xl:p-1" aria-label={`Retirer ${codeDe(id)} de l'ordre`} onClick={() => onForm({ ...form, ordrePersonnalise: form.ordrePersonnalise.filter((x) => x !== id) })}><X aria-hidden="true" className="mx-auto h-4 w-4" /></button>
                </li>
              ))}
            </ol>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor={idAjout} className="block text-xs text-gray-700">Ajouter un tronçon à l'ordre</label>
              <select id={idAjout} value={ajout} onChange={(e) => setAjout(e.target.value)} className="min-h-[44px] rounded border px-2 py-1.5 text-sm xl:min-h-0">
                <option value="">Choisir…</option>
                {disponibles.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
              </select>
            </div>
            <button type="button" disabled={ajout === ""} className="min-h-[44px] rounded border px-3 py-1 text-sm xl:min-h-0" onClick={() => { onForm({ ...form, ordrePersonnalise: [...form.ordrePersonnalise, ajout] }); setAjout(""); }}>Ajouter</button>
          </div>
          {erreurs.ordre && <p role="alert" className="text-xs text-red-900">{erreurs.ordre}</p>}
        </div>
      )}
    </fieldset>
  );
}
