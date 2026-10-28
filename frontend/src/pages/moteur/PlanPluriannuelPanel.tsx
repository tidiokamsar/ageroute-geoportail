import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { messageErreur } from "../../lib/exploitation";
import { toast } from "../../lib/toast";
import { Button } from "../../components/ui/Button";
import { jourFr } from "../../lib/tableauDeBord";
import {
  chiffresGnf, diagnostiquerSansRetenue, enMilliards, formaterGnf,
  type ParametresVersion, type RapportRejeu, type ReponsePlan, type ReponsePraticabilite, type ResumePlan,
} from "../../lib/moteurProgrammation";
import { LignesScenario } from "./LignesScenario";
import { AlertesPraticabilite, BandeauProvisoire, ResultatVide } from "./Bandeaux";
import { PERIMETRE_VIDE, PerimetreChamps, corpsPerimetre, type ChampsPerimetre } from "./PerimetreChamps";

/**
 * Plan pluriannuel (PPE) minimal : 2 a 5 annees, UNE ENVELOPPE SAISIE PAR ANNEE (aucune n'est proposee, aucune n'est
 * repartie ni reportee), scenarios annuels chaines par une methode GLOUTONNE et DETERMINISTE : un troncon retenu une
 * annee n'est pas reutilise ensuite. Ce n'est pas une optimisation (aucun PLNE) et l'ecran le dit.
 */

const BASE = "/v2/programmation/moteur/ppe";
const MIN = 2; const MAX = 5;

export function PlanPluriannuelPanel({ parametres, peutEcrire, praticabiliteBranchee }: { parametres: ParametresVersion[]; peutEcrire: boolean; praticabiliteBranchee: boolean }) {
  const qc = useQueryClient();
  const idDebut = useId(); const idNb = useId(); const idIntitule = useId();
  const [anneeDebut, setAnneeDebut] = useState(String(new Date().getFullYear()));
  const [nb, setNb] = useState(3);
  const [intitule, setIntitule] = useState("");
  const [enveloppes, setEnveloppes] = useState<string[]>(["", "", "", "", ""]);
  const [perimetre, setPerimetre] = useState<ChampsPerimetre>(PERIMETRE_VIDE);
  const [ouvertId, setOuvertId] = useState<string | null>(null);
  const [rejeu, setRejeu] = useState<RapportRejeu | null>(null);
  const [anneeOuverte, setAnneeOuverte] = useState<number | null>(null);

  const debutNum = Number(anneeDebut);
  const saisies = enveloppes.slice(0, nb).map(chiffresGnf);
  const valide = Number.isInteger(debutNum) && debutNum >= 2000 && debutNum + nb - 1 <= 2100 && intitule.trim().length >= 3 && saisies.every((s) => s !== null);

  const liste = useQuery({
    queryKey: ["v2", "moteur", "plans"],
    queryFn: async () => (await api.get<{ data: ResumePlan[]; total: number }>(`${BASE}/simulations`, { params: { pageSize: 20 } })).data,
  });
  const ouvert = useQuery({
    queryKey: ["v2", "moteur", "plan", ouvertId],
    enabled: ouvertId !== null,
    queryFn: async () => (await api.get<ReponsePlan>(`${BASE}/simulations/${ouvertId}`)).data,
  });
  const praticabilite = useQuery({
    queryKey: ["v2", "moteur", "plan", ouvertId, "praticabilite"],
    enabled: ouvertId !== null && praticabiliteBranchee,
    queryFn: async () => (await api.get<ReponsePraticabilite>(`${BASE}/simulations/${ouvertId}/praticabilite`)).data,
  });

  const calculer = useMutation({
    mutationFn: async () => (await api.post<ReponsePlan>(`${BASE}/simulations`, {
      anneeDebut: debutNum, intitule: intitule.trim(), enveloppes: saisies.map((s) => ({ budgetGnf: s })), ...corpsPerimetre(perimetre),
    })).data,
    onSuccess: (r) => {
      qc.setQueryData(["v2", "moteur", "plan", r.plan.id], r);
      setOuvertId(r.plan.id); setRejeu(null); setAnneeOuverte(null);
      void qc.invalidateQueries({ queryKey: ["v2", "moteur", "plans"] });
      toast.success("Plan calculé et enregistré (résultat provisoire tant que les paramètres ne sont pas approuvés).");
    },
    onError: (e) => toast.error(messageErreur(e, "Le calcul a été refusé.")),
  });
  const rejouer = useMutation({
    mutationFn: async () => (await api.post<RapportRejeu>(`${BASE}/simulations/${ouvertId}/rejouer`)).data,
    onSuccess: (r) => setRejeu(r),
    onError: (e) => toast.error(messageErreur(e, "Le rejeu a échoué.")),
  });

  const plan = ouvert.data?.resultat;
  const resume = ouvert.data?.plan;
  const minimum = (() => {
    const p = parametres.find((x) => x.id === resume?.parametresId);
    return typeof p?.valeurs.facteursMinimum === "number" ? p.valeurs.facteursMinimum : null;
  })();
  const diagnostic = plan ? diagnostiquerSansRetenue(plan.annees[0].scenario.lignes, minimum) : null;

  return (
    <div className="space-y-4">
      <form className="space-y-3 rounded-lg border bg-white p-4" onSubmit={(e) => { e.preventDefault(); if (valide && peutEcrire) calculer.mutate(); }} aria-label="Calculer un plan pluriannuel">
        <p className="text-xs text-gray-700">
          Méthode gloutonne et déterministe, année par année, <strong>sans optimisation</strong> (aucun PLNE). Chaque enveloppe est celle que vous saisissez :
          le plan ne répartit aucun budget total, ne reporte aucun reste d'une année sur l'autre et n'indexe rien. Un tronçon retenu une année n'est pas réutilisé ensuite.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor={idDebut} className="block text-xs text-gray-700">Première année</label>
            <input id={idDebut} inputMode="numeric" value={anneeDebut} onChange={(e) => setAnneeDebut(e.target.value)} className="w-28 rounded border px-2 py-1.5 text-sm tabular-nums" aria-required="true" />
          </div>
          <div>
            <label htmlFor={idNb} className="block text-xs text-gray-700">Nombre d'années ({MIN} à {MAX})</label>
            <select id={idNb} value={nb} onChange={(e) => setNb(Number(e.target.value))} className="rounded border px-2 py-1.5 text-sm">
              {[2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} années</option>)}
            </select>
          </div>
          <div className="min-w-[16rem] flex-1">
            <label htmlFor={idIntitule} className="block text-xs text-gray-700">Intitulé du plan</label>
            <input id={idIntitule} value={intitule} onChange={(e) => setIntitule(e.target.value)} className="w-full rounded border px-2 py-1.5 text-sm" aria-required="true" />
          </div>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold uppercase text-gray-700">Enveloppe de chaque année (GNF, chiffres seulement ; 0 est une saisie valide)</legend>
          <div className="flex flex-wrap gap-3">
            {Array.from({ length: nb }, (_, i) => {
              const s = saisies[i];
              return (
                <div key={i}>
                  <label htmlFor={`ppe-env-${i}`} className="block text-xs text-gray-700">Enveloppe {Number.isInteger(debutNum) ? debutNum + i : `année ${i + 1}`}</label>
                  <input id={`ppe-env-${i}`} inputMode="numeric" value={enveloppes[i]} onChange={(e) => setEnveloppes(enveloppes.map((x, j) => (j === i ? e.target.value : x)))}
                    className="w-44 rounded border px-2 py-1.5 text-sm tabular-nums" aria-required="true" aria-describedby={`ppe-env-${i}-aide`} />
                  <p id={`ppe-env-${i}-aide`} className="text-xs text-gray-600">{enveloppes[i] === "" ? "à saisir" : s ? enMilliards(s) : "saisie invalide"}</p>
                </div>
              );
            })}
          </div>
        </fieldset>
        <div className="flex flex-wrap items-end gap-3">
          <PerimetreChamps valeur={perimetre} onChange={setPerimetre} parametres={parametres} />
        </div>
        <Button type="submit" disabled={!valide || !peutEcrire || calculer.isPending}>{calculer.isPending ? "Calcul en cours…" : "Calculer le plan"}</Button>
      </form>

      <section aria-labelledby="pl-anciens" className="space-y-1">
        <h3 id="pl-anciens" className="text-xs font-semibold uppercase text-gray-700">Plans déjà calculés ({liste.data?.total ?? 0})</h3>
        {(liste.data?.data.length ?? 0) === 0 ? <p className="text-sm text-gray-700">Aucun plan calculé.</p> : (
          <ul className="space-y-1 text-sm">
            {liste.data!.data.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2">
                <button type="button" className="rounded border px-2 py-0.5 text-xs" aria-pressed={ouvertId === p.id} onClick={() => { setOuvertId(p.id); setRejeu(null); setAnneeOuverte(null); }}>
                  Ouvrir<span className="sr-only"> {p.intitule}</span>
                </button>
                <span>{p.anneeDebut} à {p.anneeFin} · {p.intitule} · {p.nbRetenus} retenu(s) · {formaterGnf(p.montantEngageGnf)} sur {formaterGnf(p.enveloppeTotaleGnf)} · {p.parametresVersion} · {p.etiquette} · {jourFr(p.creeLe)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {ouvertId && ouvert.isLoading && <p role="status" className="text-sm text-gray-700">Chargement du plan…</p>}
      {ouvertId && ouvert.isError && <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800">Le plan n'a pas pu être chargé. {messageErreur(ouvert.error, "Réessayez dans un instant.")}</p>}

      {plan && resume && diagnostic && (
        <section aria-labelledby="pl-resultat" className="space-y-3" data-testid="resultat-plan">
          <h3 id="pl-resultat" className="text-base font-semibold text-navy">Plan {plan.anneeDebut} à {plan.anneeDebut + plan.nbAnnees - 1} : {resume.intitule}</h3>
          {plan.provisoire && <BandeauProvisoire etiquette={plan.etiquette} motifs={plan.motifsProvisoire} detail={`Paramètres ${plan.parametres.version} : ${plan.parametres.etiquette}.`} />}
          <ResultatVide diagnostic={diagnostic} />
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-4">
            {([
              ["Enveloppes saisies (total)", formaterGnf(plan.synthese.enveloppeTotaleGnf)], ["Montant engagé", formaterGnf(plan.synthese.engageTotalGnf)],
              ["Non dépensé (non reporté)", formaterGnf(plan.synthese.resteTotalGnf)], ["Tronçons candidats", String(plan.synthese.candidats)],
              ["Retenus sur l'horizon", String(plan.synthese.retenus)], ["Jamais retenus", String(plan.synthese.nonRetenus)],
            ] as [string, string][]).map(([k, v]) => (<div key={k}><dt className="text-xs text-gray-600">{k}</dt><dd className="font-medium tabular-nums">{v}</dd></div>))}
          </dl>
          <details className="text-xs text-gray-700">
            <summary className="cursor-pointer">Méthode et limites</summary>
            <p>{plan.methode.id} version {plan.methode.version}.</p>
            <ul className="list-disc pl-5">{plan.limites.map((l) => <li key={l}>{l}</li>)}</ul>
            <p className="mt-1">{plan.avertissement}</p>
          </details>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Synthèse du plan, année par année</caption>
              <thead className="text-xs uppercase text-gray-600"><tr><th scope="col" className="py-1 pr-2">Année</th><th scope="col" className="pr-2">Enveloppe saisie</th><th scope="col" className="pr-2">Engagé</th><th scope="col" className="pr-2">Reste</th><th scope="col" className="pr-2">Candidats examinés</th><th scope="col" className="pr-2">Retenues</th><th scope="col"><span className="sr-only">Détail</span></th></tr></thead>
              <tbody>
                {plan.synthese.parAnnee.map((a) => (
                  <tr key={a.annee} className="border-t">
                    <td className="py-1 pr-2 tabular-nums">{a.annee}</td><td className="pr-2 tabular-nums">{formaterGnf(a.enveloppeGnf)}</td><td className="pr-2 tabular-nums">{formaterGnf(a.engageGnf)}</td>
                    <td className="pr-2 tabular-nums">{formaterGnf(a.resteGnf)}</td><td className="pr-2 tabular-nums">{a.candidatsEntrants}</td><td className="pr-2 tabular-nums">{a.retenues}</td>
                    <td><button type="button" className="rounded border px-2 py-0.5 text-xs" aria-expanded={anneeOuverte === a.annee} onClick={() => setAnneeOuverte(anneeOuverte === a.annee ? null : a.annee)}>
                      {anneeOuverte === a.annee ? "Masquer" : "Lire les lignes"}<span className="sr-only"> de {a.annee}</span></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {praticabilite.data && <AlertesPraticabilite alertes={praticabilite.data.alertes} />}

          {plan.annees.filter((a) => a.annee === anneeOuverte).map((a) => (
            <section key={a.annee} aria-label={`Lignes de ${a.annee}`} className="space-y-2 rounded border p-3" data-testid={`lignes-${a.annee}`}>
              <h4 className="text-sm font-semibold">{a.annee} : {a.scenario.totaux.retenues} retenue(s) sur {a.candidatsEntrants} candidat(s) examiné(s) ({a.dejaRetenusAvant} déjà retenu(s) les années précédentes, non réexaminés)</h4>
              <LignesScenario lignes={a.scenario.lignes} parametres={a.scenario.parametres} titre={`Lignes du plan pour ${a.annee}`} />
            </section>
          ))}

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="text-left text-xs font-semibold uppercase text-gray-700">Tronçons retenus sur l'horizon ({plan.synthese.tronconsRetenus.length})</caption>
              <thead className="text-xs uppercase text-gray-600"><tr><th scope="col" className="py-1 pr-2">Tronçon</th><th scope="col" className="pr-2">Année</th><th scope="col" className="pr-2">Rang dans l'année</th><th scope="col" className="pr-2">Traitement</th><th scope="col">Coût</th></tr></thead>
              <tbody>
                {plan.synthese.tronconsRetenus.map((t) => (<tr key={t.tronconId} className="border-t"><td className="py-1 pr-2">{t.code}</td><td className="pr-2 tabular-nums">{t.anneeRetenue}</td><td className="pr-2 tabular-nums">{t.rangRetenu}</td><td className="pr-2">{t.traitement}</td><td className="tabular-nums">{formaterGnf(t.montantGnf)}</td></tr>))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t pt-3">
            <Button variant="outline" onClick={() => rejouer.mutate()} disabled={rejouer.isPending}>Rejouer depuis les entrées stockées</Button>
            <p className="text-xs text-gray-700">Un plan ne crée aucune fiche : les fiches se figent depuis un scénario annuel.</p>
          </div>
          {rejeu && (
            <p role="status" data-testid="rapport-rejeu-plan" className={`rounded border p-2 text-sm ${rejeu.identique ? "border-green-300 bg-green-50 text-green-900" : "border-amber-300 bg-amber-50 text-amber-950"}`}>
              {rejeu.explication} {rejeu.entreesIntegres ? "Les entrées stockées sont intègres." : "ATTENTION : les entrées stockées ne correspondent plus à leur empreinte."} Empreinte stockée : <code className="break-all">{rejeu.empreinteStockee}</code>, recalculée : <code className="break-all">{rejeu.empreinteRecalculee}</code>.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
