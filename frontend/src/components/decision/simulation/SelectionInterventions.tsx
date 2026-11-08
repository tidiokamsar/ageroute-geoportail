/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- zone de defilement horizontal focusable au clavier (WCAG 2.1.1, regle axe scrollable-region-focusable) */
import { useId, useMemo, useState } from "react";
import {
  affecterGroupe, basculer, formaterKm, groupeDe, libelleRegion, purgerSelection,
  type CandidatApercu, type FormulaireSimulation, type ReponseCandidats,
} from "../../../lib/aideDecisionScenarios";
import type { ErreurSimulation } from "./EtatsSimulation";
import { EtatChargement, EtatErreur, EtatVide } from "./EtatsSimulation";
import { CaseACocher } from "./CaseACocher";

/**
 * Selection des interventions candidates du perimetre, et leurs contraintes individuelles : obligatoire, groupe non divisible.
 *
 * Par defaut TOUS les candidats du perimetre sont examines (aucune selection envoyee). Decocher « tous » permet de n'en garder
 * que quelques-uns ; une intervention decochee n'est plus obligatoire ni dans un groupe. La longueur affichee est la longueur
 * METIER ; la geometrique, quand c'est la seule, est dite a part et n'est jamais presentee comme la longueur du troncon.
 */

const PAS = 25;

export function SelectionInterventions({ candidats, chargement, erreur, onReessayer, form, onForm, regions }: {
  candidats: ReponseCandidats | undefined; chargement: boolean; erreur: ErreurSimulation | null; onReessayer: () => void;
  form: FormulaireSimulation; onForm: (f: FormulaireSimulation) => void; regions: readonly { id: number; nom: string }[];
}) {
  const idTous = useId(); const idRecherche = useId();
  const [recherche, setRecherche] = useState("");
  const [affiches, setAffiches] = useState(PAS);
  const liste = useMemo(() => candidats?.data ?? [], [candidats]);
  const choisis = form.selection;
  const visibles = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    return liste.filter((c) => q === "" || c.code.toLowerCase().includes(q) || (c.nom ?? "").toLowerCase().includes(q));
  }, [liste, recherche]);
  const montres = visibles.slice(0, affiches);

  if (chargement) return <EtatChargement libelle="Chargement des interventions candidates…" />;
  if (erreur) return <EtatErreur panneau="Interventions candidates" erreur={erreur} onReessayer={onReessayer} />;
  if (!candidats) return null;
  if (liste.length === 0) return <EtatVide titre="Aucune intervention candidate dans ce périmètre" detail="Le réseau classé de référence ne contient aucun tronçon actif et validé pour ce filtre. Aucun chiffre n'est inventé." />;

  const toutesChoisies = choisis === null;
  const estChoisie = (c: CandidatApercu) => choisis === null || choisis.includes(c.id);
  const nbChoisies = choisis === null ? liste.length : choisis.length;

  return (
    <div className="space-y-2" data-testid="selection-interventions">
      {candidats.tronque && <p role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-950">Plus de {candidats.maxCandidats} candidats : restreignez la région ou la classe de route, le simulateur n'examine pas un périmètre tronqué.</p>}
      <div className="flex min-h-[44px] items-center gap-2 xl:min-h-0">
        <CaseACocher id={idTous} checked={toutesChoisies}
          onChange={(e) => onForm(purgerSelection(form, e.target.checked ? null : liste.map((c) => c.id)))} />
        <label htmlFor={idTous} className="text-sm">Examiner toutes les interventions candidates du périmètre ({liste.length})</label>
      </div>
      <p className="text-xs text-gray-700" aria-live="polite">{nbChoisies} intervention(s) examinée(s) sur {liste.length}.</p>
      <div>
        <label htmlFor={idRecherche} className="block text-xs text-gray-700">Rechercher un tronçon (code ou nom)</label>
        <input id={idRecherche} type="search" value={recherche} onChange={(e) => { setRecherche(e.target.value); setAffiches(PAS); }} className="min-h-[44px] w-64 max-w-full rounded border px-2 py-1.5 text-sm xl:min-h-0" />
      </div>
      <div className="relative overflow-x-auto" role="region" tabIndex={0} aria-label="Interventions candidates (défilement horizontal)">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Interventions candidates et leurs contraintes</caption>
          <thead className="text-xs uppercase text-gray-700">
            <tr>
              <th scope="col" className="py-1 pr-2">Examinée</th><th scope="col" className="pr-2">Tronçon</th><th scope="col" className="pr-2">Région</th><th scope="col" className="pr-2">Classe</th>
              <th scope="col" className="pr-2">État</th><th scope="col" className="pr-2">Longueur métier</th><th scope="col" className="pr-2">Obligatoire</th><th scope="col">Groupe non divisible</th>
            </tr>
          </thead>
          <tbody>
            {montres.map((c) => {
              const choisie = estChoisie(c);
              return (
                <tr key={c.id} className="border-t align-middle">
                  <td className="py-1 pr-2">
                    <CaseACocher checked={choisie} aria-label={`Examiner ${c.code}`}
                      onChange={() => onForm(purgerSelection(form, basculer(choisis ?? liste.map((x) => x.id), c.id)))} />
                  </td>
                  <td className="pr-2">{c.code}{c.nom ? <span className="block text-xs text-gray-700">{c.nom}</span> : null}</td>
                  <td className="pr-2">{libelleRegion(c.regionId, regions)}</td>
                  <td className="pr-2">{c.classe ?? "non renseignée"}</td>
                  <td className="pr-2">{c.etat ?? "non renseigné"}</td>
                  <td className="pr-2">{formaterKm(c.longueurMetierKm)}{c.longueurMetierKm === null && c.longueurGeometriqueKm !== null ? <span className="block text-xs text-gray-700">géométrique, à part : {formaterKm(c.longueurGeometriqueKm)}</span> : null}</td>
                  <td className="pr-2">
                    <CaseACocher disabled={!choisie} checked={form.obligatoires.includes(c.id)} aria-label={`${c.code} obligatoire`}
                      onChange={() => onForm({ ...form, obligatoires: basculer(form.obligatoires, c.id) })} />
                  </td>
                  <td>
                    <select disabled={!choisie} aria-label={`Groupe non divisible de ${c.code}`} className="min-h-[44px] rounded border px-1 py-1 text-sm xl:min-h-0"
                      value={groupeDe(form.groupes, c.id) ?? ""} onChange={(e) => onForm({ ...form, groupes: affecterGroupe(form.groupes, c.id, e.target.value === "" ? null : Number(e.target.value)) })}>
                      <option value="">Aucun</option>
                      {form.groupes.map((_, i) => <option key={i + 1} value={i + 1}>Groupe {i + 1}</option>)}
                      <option value={form.groupes.length + 1}>Nouveau groupe</option>
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {visibles.length === 0 && <p className="text-sm text-gray-700">Aucun tronçon ne correspond à la recherche.</p>}
      {visibles.length > montres.length && (
        <button type="button" className="min-h-[44px] rounded border px-3 py-1 text-sm xl:min-h-0" onClick={() => setAffiches(affiches + PAS)}>
          Afficher {Math.min(PAS, visibles.length - montres.length)} tronçon(s) de plus ({montres.length} sur {visibles.length})
        </button>
      )}
    </div>
  );
}
