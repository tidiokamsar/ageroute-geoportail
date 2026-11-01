import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { messageErreur } from "../../lib/exploitation";
import { toast } from "../../lib/toast";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { jourFr } from "../../lib/tableauDeBord";
import {
  chiffresGnf, diagnostiquerSansRetenue, enMilliards, formaterGnf,
  type ParametresVersion, type RapportRejeu, type ReponseFigeage, type ReponsePraticabilite, type ReponseScenario, type ResumeScenario,
} from "../../lib/moteurProgrammation";
import { LignesScenario } from "./LignesScenario";
import { AlertesPraticabilite, BandeauProvisoire, ResultatVide, TotauxScenario } from "./Bandeaux";
import { PERIMETRE_VIDE, PerimetreChamps, corpsPerimetre, type ChampsPerimetre } from "./PerimetreChamps";

/**
 * Scenario annuel (PAE) : choisir l'annee, l'enveloppe et le perimetre, calculer, lire le resultat ligne par ligne,
 * le rejouer, figer des fiches d'intervention (action explicite, confirmation, empreinte SHA-256 affichee).
 *
 * L'ecran n'invente aucune enveloppe : le champ est vide au depart, il n'a pas de valeur par defaut.
 */

const BASE = "/v2/programmation/moteur";

export function ScenarioAnnuelPanel({ parametres, peutEcrire, praticabiliteBranchee }: { parametres: ParametresVersion[]; peutEcrire: boolean; praticabiliteBranchee: boolean }) {
  const qc = useQueryClient();
  const idAnnee = useId(); const idIntitule = useId(); const idBudget = useId(); const idSource = useId();
  const [annee, setAnnee] = useState(String(new Date().getFullYear()));
  const [intitule, setIntitule] = useState("");
  const [budget, setBudget] = useState("");
  const [perimetre, setPerimetre] = useState<ChampsPerimetre>(PERIMETRE_VIDE);
  const [ouvertId, setOuvertId] = useState<string | null>(null);
  const [rejeu, setRejeu] = useState<RapportRejeu | null>(null);
  const [figeage, setFigeage] = useState<ReponseFigeage | null>(null);
  const [confirmation, setConfirmation] = useState(false);
  const [source, setSource] = useState("");

  const budgetChiffres = chiffresGnf(budget);
  const anneeNum = Number(annee);
  const valide = Number.isInteger(anneeNum) && anneeNum >= 2000 && anneeNum <= 2100 && intitule.trim().length >= 3 && budgetChiffres !== null;

  const liste = useQuery({
    queryKey: ["v2", "moteur", "scenarios"],
    queryFn: async () => (await api.get<{ data: ResumeScenario[]; total: number }>(`${BASE}/simulations`, { params: { pageSize: 20 } })).data,
  });

  const ouvert = useQuery({
    queryKey: ["v2", "moteur", "scenario", ouvertId],
    enabled: ouvertId !== null,
    queryFn: async () => (await api.get<ReponseScenario>(`${BASE}/simulations/${ouvertId}`)).data,
  });

  const praticabilite = useQuery({
    queryKey: ["v2", "moteur", "scenario", ouvertId, "praticabilite"],
    enabled: ouvertId !== null && praticabiliteBranchee,
    queryFn: async () => (await api.get<ReponsePraticabilite>(`${BASE}/simulations/${ouvertId}/praticabilite`)).data,
  });

  const calculer = useMutation({
    mutationFn: async () => (await api.post<ReponseScenario>(`${BASE}/simulations`, {
      annee: anneeNum, intitule: intitule.trim(), budgetGnf: budgetChiffres, ...corpsPerimetre(perimetre),
    })).data,
    onSuccess: (r) => {
      qc.setQueryData(["v2", "moteur", "scenario", r.scenario.id], r);
      setOuvertId(r.scenario.id); setRejeu(null); setFigeage(null);
      void qc.invalidateQueries({ queryKey: ["v2", "moteur", "scenarios"] });
      toast.success("Scénario calculé et enregistré (résultat provisoire tant que les paramètres ne sont pas approuvés).");
    },
    onError: (e) => toast.error(messageErreur(e, "Le calcul a été refusé.")),
  });

  const rejouer = useMutation({
    mutationFn: async () => (await api.post<RapportRejeu>(`${BASE}/simulations/${ouvertId}/rejouer`)).data,
    onSuccess: (r) => setRejeu(r),
    onError: (e) => toast.error(messageErreur(e, "Le rejeu a échoué.")),
  });

  const figer = useMutation({
    mutationFn: async () => (await api.post<ReponseFigeage>(`${BASE}/simulations/${ouvertId}/fiches`, { ...(source.trim() ? { sourceFinancement: source.trim() } : {}) })).data,
    onSuccess: (r) => {
      setFigeage(r); setConfirmation(false);
      void qc.invalidateQueries({ queryKey: ["v2", "moteur", "fiches"] });
      toast.success(`${r.fiches.length} fiche(s) figée(s).`);
    },
    onError: (e) => { setConfirmation(false); toast.error(messageErreur(e, "Le gel a été refusé.")); },
  });

  const reponse = ouvert.data;
  const resultat = reponse?.resultat;
  const minimum = (() => {
    const p = parametres.find((x) => x.id === reponse?.scenario.parametresId);
    return typeof p?.valeurs.facteursMinimum === "number" ? p.valeurs.facteursMinimum : null;
  })();
  const diagnostic = resultat ? diagnostiquerSansRetenue(resultat.lignes, minimum) : null;

  return (
    <div className="space-y-4">
      <form className="grid gap-3 rounded-lg border bg-white p-4 md:grid-cols-3" onSubmit={(e) => { e.preventDefault(); if (valide && peutEcrire) calculer.mutate(); }} aria-label="Calculer un scénario annuel">
        <div>
          <label htmlFor={idAnnee} className="block text-xs text-gray-700">Année du programme</label>
          <input id={idAnnee} inputMode="numeric" value={annee} onChange={(e) => setAnnee(e.target.value)} className="w-28 rounded border px-2 py-1.5 text-sm tabular-nums" aria-required="true" />
        </div>
        <div className="md:col-span-2">
          <label htmlFor={idIntitule} className="block text-xs text-gray-700">Intitulé du scénario</label>
          <input id={idIntitule} value={intitule} onChange={(e) => setIntitule(e.target.value)} className="w-full rounded border px-2 py-1.5 text-sm" aria-required="true" />
        </div>
        <div className="md:col-span-3">
          <label htmlFor={idBudget} className="block text-xs text-gray-700">Enveloppe budgétaire (GNF, chiffres seulement)</label>
          <input id={idBudget} inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value)} className="w-64 rounded border px-2 py-1.5 text-sm tabular-nums" aria-required="true" aria-describedby={`${idBudget}-aide`} />
          <p id={`${idBudget}-aide`} className="text-xs text-gray-600">
            {budget === "" ? "Aucune enveloppe n'est proposée : saisissez le montant du PAE." : budgetChiffres ? `Soit ${formaterGnf(budgetChiffres)} (${enMilliards(budgetChiffres)}).` : "Saisie invalide : un entier de 1 à 18 chiffres est attendu."}
          </p>
        </div>
        <PerimetreChamps valeur={perimetre} onChange={setPerimetre} parametres={parametres} />
        <div className="md:col-span-3">
          <Button type="submit" disabled={!valide || !peutEcrire || calculer.isPending}>{calculer.isPending ? "Calcul en cours…" : "Calculer le scénario"}</Button>
        </div>
      </form>

      <section aria-labelledby="sc-anciens" className="space-y-1">
        <h3 id="sc-anciens" className="text-xs font-semibold uppercase text-gray-700">Scénarios déjà calculés ({liste.data?.total ?? 0})</h3>
        {(liste.data?.data.length ?? 0) === 0 ? <p className="text-sm text-gray-700">Aucun scénario calculé.</p> : (
          <ul className="space-y-1 text-sm">
            {liste.data!.data.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2">
                <button type="button" className="rounded border px-2 py-0.5 text-xs" onClick={() => { setOuvertId(s.id); setRejeu(null); setFigeage(null); }} aria-pressed={ouvertId === s.id}>
                  Ouvrir<span className="sr-only"> {s.intitule}</span>
                </button>
                <span>{s.annee} · {s.intitule} · {s.nbRetenues} retenue(s) · {formaterGnf(s.montantEngageGnf)} sur {formaterGnf(s.budgetGnf)} · {s.parametresVersion} · {s.etiquette} · {jourFr(s.creeLe)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {ouvertId && ouvert.isLoading && <p role="status" className="text-sm text-gray-700">Chargement du scénario…</p>}
      {ouvertId && ouvert.isError && <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800">Le scénario n'a pas pu être chargé. {messageErreur(ouvert.error, "Réessayez dans un instant.")}</p>}

      {resultat && reponse && diagnostic && (
        <section aria-labelledby="sc-resultat" className="space-y-3" data-testid="resultat-scenario">
          <h3 id="sc-resultat" className="text-base font-semibold text-navy">Résultat : {reponse.scenario.intitule} ({resultat.annee})</h3>
          {resultat.provisoire && <BandeauProvisoire etiquette={resultat.etiquette} motifs={resultat.motifsProvisoire} detail={`Paramètres ${resultat.parametres.version} : ${resultat.parametres.etiquette}.`} />}
          <TotauxScenario {...resultat.totaux} budgetGnf={resultat.budgetGnf} />
          <ResultatVide diagnostic={diagnostic} />
          <details className="text-xs text-gray-700">
            <summary className="cursor-pointer">Méthode et limites</summary>
            <p>{resultat.methode.id} version {resultat.methode.version}. Algorithme glouton, non optimal (aucune optimisation).</p>
            <ul className="list-disc pl-5">{resultat.limites.map((l) => <li key={l}>{l}</li>)}</ul>
            <p className="mt-1">{resultat.avertissement}</p>
          </details>

          {praticabilite.data && <AlertesPraticabilite alertes={praticabilite.data.alertes} />}

          <LignesScenario lignes={resultat.lignes} parametres={resultat.parametres} titre={`Lignes du scénario ${resultat.annee}`} />

          <div className="flex flex-wrap items-center gap-3 border-t pt-3">
            <Button variant="outline" onClick={() => rejouer.mutate()} disabled={rejouer.isPending}>Rejouer depuis les entrées stockées</Button>
            {peutEcrire && resultat.totaux.retenues > 0 && (
              <Button variant="primary" onClick={() => setConfirmation(true)}>Figer les {resultat.totaux.retenues} intervention(s) retenue(s) en fiches</Button>
            )}
          </div>
          {rejeu && (
            <p role="status" data-testid="rapport-rejeu" className={`rounded border p-2 text-sm ${rejeu.identique ? "border-green-300 bg-green-50 text-green-900" : "border-amber-300 bg-amber-50 text-amber-950"}`}>
              {rejeu.explication} {rejeu.entreesIntegres ? "Les entrées stockées sont intègres." : "ATTENTION : les entrées stockées ne correspondent plus à leur empreinte."} Empreinte du résultat stocké : <code className="break-all">{rejeu.empreinteStockee}</code>, recalculée : <code className="break-all">{rejeu.empreinteRecalculee}</code>.
            </p>
          )}
          {figeage && (
            <div role="status" data-testid="fiches-figees-creees" className="space-y-1 rounded border border-green-300 bg-green-50 p-3 text-sm text-green-950">
              <p><strong>{figeage.fiches.length} fiche(s) figée(s)</strong>, statut BROUILLON. {figeage.provisoire ? `${figeage.etiquette} : les fiches héritent de l'étiquette.` : ""}</p>
              <table className="w-full text-left text-xs">
                <caption className="sr-only">Fiches d'intervention figées</caption>
                <thead className="uppercase"><tr><th scope="col" className="pr-2">Référence</th><th scope="col" className="pr-2">Tronçon</th><th scope="col">Empreinte SHA-256</th></tr></thead>
                <tbody>
                  {figeage.fiches.map((f) => (<tr key={f.id} className="border-t align-top"><td className="pr-2">{f.reference}</td><td className="pr-2">{f.code}</td><td><code className="break-all">{f.empreinteSha256}</code></td></tr>))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <Modal open={confirmation} onClose={() => setConfirmation(false)} title="Figer les fiches d'intervention">
        <div className="space-y-3 text-sm">
          <p>
            Vous allez figer {resultat?.totaux.retenues ?? 0} fiche(s) d'intervention à partir de ce scénario. Une fiche figée est <strong>immuable</strong> :
            elle embarque une copie des paramètres et ne se modifie ni ne se supprime. Elle ne crée ni marché, ni ordre de travaux, ni engagement financier.
          </p>
          {resultat?.provisoire && <p className="rounded bg-amber-50 p-2 text-amber-950">Le résultat est {resultat.etiquette} : les fiches porteront cette étiquette.</p>}
          <div>
            <label htmlFor={idSource} className="block text-xs text-gray-700">Source de financement (facultatif, jamais déduite)</label>
            <input id={idSource} value={source} onChange={(e) => setSource(e.target.value)} className="w-full rounded border px-2 py-1.5 text-sm" />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmation(false)}>Annuler</Button>
            <Button variant="primary" onClick={() => figer.mutate()} disabled={figer.isPending}>Confirmer le gel</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
