import { useId } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "../../ui/Button";
import {
  enMilliardsTexte, type CandidatApercu, type FormulaireSimulation, type OptionsSimulateur, type ReponseCandidats, validerEnveloppe,
} from "../../../lib/aideDecisionScenarios";
import { formaterGnf, type ParametresVersion } from "../../../lib/moteurProgrammation";
import { CLASSES_ROUTE } from "../../../pages/moteur/PerimetreChamps";
import { ChoixBaremes } from "./ChoixBaremes";
import { ChoixLogique } from "./ChoixLogique";
import { EtatChargement, EtatErreur, type ErreurSimulation } from "./EtatsSimulation";
import { SelectionInterventions } from "./SelectionInterventions";

/**
 * Formulaire de simulation : enveloppe en GNF et periode, perimetre, logique de priorite, baremes, interventions candidates et
 * contraintes (obligatoires, groupes non divisibles, plafonds regionaux). La saisie est validee AVANT l'envoi ; aucune valeur
 * n'est proposee par defaut pour l'enveloppe, et une saisie vide n'est jamais convertie en 0.
 */
export interface PropsFormulaire {
  form: FormulaireSimulation; onForm: (f: FormulaireSimulation) => void;
  erreurs: Record<string, string>; tentative: boolean;
  options: OptionsSimulateur | undefined; optionsChargement: boolean; optionsErreur: ErreurSimulation | null; onReessayerOptions: () => void;
  candidats: ReponseCandidats | undefined; candidatsChargement: boolean; candidatsErreur: ErreurSimulation | null; onReessayerCandidats: () => void;
  parametres: ParametresVersion[]; regions: readonly { id: number; nom: string }[];
  onSimuler: () => void; enCours: boolean; peutEcrire: boolean;
}

export function FormulaireSimulationVue(p: PropsFormulaire) {
  const { form, onForm, erreurs, tentative } = p;
  const idEnv = useId(); const idDebut = useId(); const idFin = useId();
  const env = validerEnveloppe(form.enveloppe);
  const erreurEnveloppe = form.enveloppe !== "" || tentative ? erreurs.enveloppe : undefined;
  const liste: CandidatApercu[] = p.candidats?.data ?? [];
  return (
    <form className="space-y-5 rounded-lg border bg-white p-4" aria-label="Paramètres de la simulation" noValidate onSubmit={(e) => { e.preventDefault(); p.onSimuler(); }}>
      <fieldset className="min-w-0 grid gap-3 md:grid-cols-3">
        <legend className="mb-1 text-sm font-semibold text-navy">Enveloppe et période</legend>
        <div className="md:col-span-3">
          <label htmlFor={idEnv} className="block text-xs text-gray-700">Enveloppe budgétaire (GNF, entiers, chiffres seulement)</label>
          <div className="flex items-center gap-2">
            <input id={idEnv} inputMode="numeric" autoComplete="off" value={form.enveloppe} onChange={(e) => onForm({ ...form, enveloppe: e.target.value })} aria-required="true"
              aria-invalid={!!erreurEnveloppe} aria-describedby={`${idEnv}-aide`} className="min-h-[44px] w-72 max-w-full rounded border px-2 py-1.5 text-sm tabular-nums xl:min-h-0" />
            <span className="text-sm font-medium" aria-label="devise : franc guinéen">GNF</span>
          </div>
          <p id={`${idEnv}-aide`} role={erreurEnveloppe ? "alert" : undefined} className={`text-xs ${erreurEnveloppe ? "text-red-900" : "text-gray-700"}`}>
            {erreurEnveloppe ?? (env.ok ? `Soit ${formaterGnf(env.chiffres)} (${enMilliardsTexte(env.chiffres)}).` : "Aucune enveloppe n'est proposée : saisissez le montant disponible pour la période.")}
          </p>
        </div>
        <div>
          <label htmlFor={idDebut} className="block text-xs text-gray-700">Début de la période</label>
          <input id={idDebut} type="date" value={form.debut} onChange={(e) => onForm({ ...form, debut: e.target.value })} aria-required="true" aria-invalid={!!erreurs.periode} className="min-h-[44px] rounded border px-2 py-1.5 text-sm xl:min-h-0" />
        </div>
        <div>
          <label htmlFor={idFin} className="block text-xs text-gray-700">Fin de la période</label>
          <input id={idFin} type="date" value={form.fin} onChange={(e) => onForm({ ...form, fin: e.target.value })} aria-required="true" aria-invalid={!!erreurs.periode} className="min-h-[44px] rounded border px-2 py-1.5 text-sm xl:min-h-0" />
        </div>
        {erreurs.periode && <p role="alert" className="text-xs text-red-900 md:col-span-3">{erreurs.periode}</p>}
        <p className="text-xs text-gray-700 md:col-span-3">L'enveloppe couvre toute la période. Devise : franc guinéen (GNF), seule devise gérée.</p>
      </fieldset>

      <fieldset className="min-w-0 grid gap-3 md:grid-cols-3">
        <legend className="mb-1 text-sm font-semibold text-navy">Périmètre et paramètres</legend>
        {[
          { id: `${idEnv}-reg`, libelle: "Région", cle: "regionId" as const, vide: "Toutes les régions", options: p.regions.map((r) => ({ v: String(r.id), t: r.nom })) },
          { id: `${idEnv}-cla`, libelle: "Classe de route", cle: "classe" as const, vide: "Toutes les classes", options: CLASSES_ROUTE.map((c) => ({ v: c, t: c })) },
          { id: `${idEnv}-par`, libelle: "Version des paramètres", cle: "parametresId" as const, vide: "Choix automatique par le serveur", options: p.parametres.map((x) => ({ v: x.id, t: `${x.version} : ${x.etiquette}` })) },
        ].map((c) => (
          <div key={c.id}>
            <label htmlFor={c.id} className="block text-xs text-gray-700">{c.libelle}</label>
            <select id={c.id} value={form[c.cle]} onChange={(e) => onForm({ ...form, [c.cle]: e.target.value, ...(c.cle === "parametresId" ? {} : { selection: null, obligatoires: [], groupes: [], ordrePersonnalise: [] }) })} className="min-h-[44px] max-w-full rounded border px-2 py-1.5 text-sm xl:min-h-0">
              <option value="">{c.vide}</option>
              {c.options.map((o) => <option key={o.v} value={o.v}>{o.t}</option>)}
            </select>
          </div>
        ))}
      </fieldset>

      {p.optionsChargement && <EtatChargement libelle="Chargement des logiques et des barèmes…" />}
      {p.optionsErreur && <EtatErreur panneau="Logiques et barèmes" erreur={p.optionsErreur} onReessayer={p.onReessayerOptions} />}
      {p.options && (
        <>
          <ChoixLogique logiques={p.options.logiques} form={form} onForm={onForm} candidats={liste} erreurs={erreurs} />
          <p className="text-xs text-gray-700">{p.options.contraintes.reglesFinancement}.</p>
          {p.options.baremes && <ChoixBaremes baremes={p.options.baremes} form={form} onForm={onForm} erreur={tentative ? erreurs.baremes : undefined} />}
        </>
      )}

      <fieldset className="min-w-0 space-y-2">
        <legend className="text-sm font-semibold text-navy">Interventions candidates et contraintes</legend>
        <p className="text-xs text-gray-700">Obligatoire : financée en premier, jamais forcée au-delà de l'enveloppe. Groupe non divisible : financé en entier ou pas du tout.</p>
        <SelectionInterventions candidats={p.candidats} chargement={p.candidatsChargement} erreur={p.candidatsErreur} onReessayer={p.onReessayerCandidats} form={form} onForm={onForm} regions={p.regions} />
        {tentative && Object.entries(erreurs).filter(([k]) => k === "selection" || k === "groupes" || k.startsWith("groupe")).map(([k, m]) => <p key={k} role="alert" className="text-xs text-red-900">{m}</p>)}
      </fieldset>

      <fieldset className="min-w-0 space-y-2">
        <legend className="text-sm font-semibold text-navy">Plafonds régionaux (facultatif)</legend>
        {form.plafonds.map((pl, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor={`${idEnv}-pr-${i}`} className="block text-xs text-gray-700">Région du plafond {i + 1}</label>
              <select id={`${idEnv}-pr-${i}`} value={pl.regionId} onChange={(e) => onForm({ ...form, plafonds: form.plafonds.map((x, j) => (j === i ? { ...x, regionId: e.target.value } : x)) })} className="min-h-[44px] rounded border px-2 py-1.5 text-sm xl:min-h-0">
                <option value="">Choisir…</option>
                {p.regions.map((r) => <option key={r.id} value={r.id}>{r.nom}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={`${idEnv}-pm-${i}`} className="block text-xs text-gray-700">Plafond {i + 1} (GNF)</label>
              <input id={`${idEnv}-pm-${i}`} inputMode="numeric" value={pl.montant} onChange={(e) => onForm({ ...form, plafonds: form.plafonds.map((x, j) => (j === i ? { ...x, montant: e.target.value } : x)) })} className="min-h-[44px] w-56 rounded border px-2 py-1.5 text-sm tabular-nums xl:min-h-0" />
            </div>
            <button type="button" className="min-h-[44px] min-w-[44px] rounded border xl:min-h-0 xl:min-w-0 xl:p-2" aria-label={`Retirer le plafond ${i + 1}`} onClick={() => onForm({ ...form, plafonds: form.plafonds.filter((_, j) => j !== i) })}><Trash2 aria-hidden="true" className="mx-auto h-4 w-4" /></button>
            {tentative && erreurs[`plafond${i}`] && <p role="alert" className="w-full text-xs text-red-900">{erreurs[`plafond${i}`]}</p>}
          </div>
        ))}
        <button type="button" className="inline-flex min-h-[44px] items-center gap-1 rounded border px-3 py-1 text-sm xl:min-h-0" onClick={() => onForm({ ...form, plafonds: [...form.plafonds, { regionId: "", montant: "" }] })}><Plus aria-hidden="true" className="h-4 w-4" />Ajouter un plafond</button>
      </fieldset>

      {tentative && Object.keys(erreurs).length > 0 && (
        <div role="alert" data-testid="erreurs-formulaire" className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-950">
          <p className="font-semibold">La simulation n'est pas lancée : {Object.keys(erreurs).length} point(s) à corriger.</p>
          <ul className="list-disc pl-5 text-xs">{Object.values(erreurs).map((m) => <li key={m}>{m}</li>)}</ul>
        </div>
      )}
      <div>
        <Button type="submit" disabled={p.enCours || !p.peutEcrire} className="min-h-[44px] xl:min-h-0">{p.enCours ? "Simulation en cours…" : "Simuler"}</Button>
        {!p.peutEcrire && <p className="mt-1 text-xs text-gray-700">Simuler est réservé aux rôles administrateur et gestionnaire : votre rôle peut consulter les scénarios enregistrés.</p>}
      </div>
    </form>
  );
}
