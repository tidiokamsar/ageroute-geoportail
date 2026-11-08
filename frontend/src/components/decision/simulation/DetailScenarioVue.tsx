import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { toast } from "../../../lib/toast";
import { LIBELLE_LOGIQUE, MENTION_SIMULATION, empreinteCourte, relancer, type VerdictExport } from "../../../lib/aideDecisionScenarios";
import { lireScenario, rejouerScenario, remettreFichier, supprimerScenario, telechargerExport } from "../../../lib/aideDecisionScenariosApi";
import { formaterGnf } from "../../../lib/moteurProgrammation";
import { jourFr } from "../../../lib/tableauDeBord";
import { LignesScenario } from "../../../pages/moteur/LignesScenario";
import { BandeauProvisoire } from "../../../pages/moteur/Bandeaux";
import { BandeauNonEngageant, EtatChargement, EtatErreur, lireErreur } from "./EtatsSimulation";
import { ResultatSimulationVue } from "./ResultatSimulationVue";

/**
 * Detail d'un scenario enregistre : entrees (periode, logique, contraintes, version des parametres et des baremes), resultat,
 * REJEU avec verification de l'empreinte (le scenario est recalcule depuis ses seules entrees stockees et compare octet pour
 * octet), export, suppression logique (confirmation, droits). Un scenario calcule avant le simulateur se lit avec le detail du
 * moteur de programmation, et dit qu'il n'a ni periode ni deficit.
 */
export function DetailScenarioVue({ id, peutEcrire, droitExport, regions, onFerme, onSupprime }: { id: string; peutEcrire: boolean; droitExport: VerdictExport; regions: readonly { id: number; nom: string }[]; onFerme: () => void; onSupprime: (id: string) => void }) {
  const qc = useQueryClient();
  const [confirmation, setConfirmation] = useState(false);
  const detail = useQuery({ queryKey: ["ad", "scenarios", "detail", id], queryFn: () => lireScenario(id), retry: relancer });
  const rejeu = useMutation({ mutationFn: () => rejouerScenario(id) });
  const exporter = useMutation({
    mutationFn: async (format: "csv" | "json") => { const f = await telechargerExport(id, format); remettreFichier(f.blob, f.nom); },
  });
  const supprimer = useMutation({
    mutationFn: () => supprimerScenario(id),
    onSuccess: () => { setConfirmation(false); void qc.invalidateQueries({ queryKey: ["ad", "scenarios", "liste"] }); toast.success("Scénario supprimé (suppression logique, audité)."); onSupprime(id); },
    onError: () => setConfirmation(false),
  });

  if (detail.isLoading) return <EtatChargement libelle="Chargement du scénario…" />;
  if (detail.isError) return <EtatErreur panneau="Détail du scénario" erreur={lireErreur(detail.error)} onReessayer={() => void detail.refetch()} reessaiEnCours={detail.isFetching} />;
  if (!detail.data) return null;
  const { scenario: s, resultat, entrees, simulateur } = detail.data;
  const sim = entrees.simulation;

  return (
    <section aria-labelledby="detail-titre" className="space-y-4 rounded-lg border bg-white p-4" data-testid="detail-scenario">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 id="detail-titre" className="text-base font-semibold text-navy">{s.intitule}</h4>
          <p className="text-xs text-gray-700">Auteur : {s.auteurNom ?? `compte ${s.creeParId}`} · enregistré le {jourFr(s.creeLe)} · {s.etiquette}</p>
        </div>
        <Button type="button" variant="ghost" className="min-h-[44px] xl:min-h-0" onClick={onFerme}>Fermer le détail</Button>
      </div>

      {simulateur ? <BandeauNonEngageant mention={resultat.simulation?.mention ?? MENTION_SIMULATION} /> : (
        <div role="note" className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950">
          Ce scénario a été calculé avant le simulateur : il n'a ni période, ni devise, ni déficit, et ne peut être ni comparé ni exporté comme une simulation. Relancez-le depuis l'onglet Simulation.
        </div>
      )}

      <section aria-labelledby="entrees-titre" className="space-y-1" data-testid="entrees-scenario">
        <h5 id="entrees-titre" className="text-sm font-semibold text-navy">Données d'entrée</h5>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-gray-700">Enveloppe</dt><dd className="tabular-nums">{formaterGnf(s.budgetGnf)}</dd></div>
          <div><dt className="text-xs text-gray-700">Version des paramètres</dt><dd>{s.parametresVersion}</dd></div>
          {sim && (
            <>
              <div><dt className="text-xs text-gray-700">Période</dt><dd>{jourFr(sim.periode.debut)} au {jourFr(sim.periode.fin)}</dd></div>
              <div><dt className="text-xs text-gray-700">Logique</dt><dd>{LIBELLE_LOGIQUE[sim.logique] ?? sim.logique}</dd></div>
              <div><dt className="text-xs text-gray-700">Version des barèmes (empreinte)</dt><dd><code>{empreinteCourte(sim.baremes.empreinte)}</code></dd></div>
              <div><dt className="text-xs text-gray-700">Candidats examinés</dt><dd>{entrees.nbCandidats}{sim.perimetre.selection ? " (sélection)" : ""}</dd></div>
              <div><dt className="text-xs text-gray-700">Obligatoires</dt><dd>{sim.obligatoires.length}</dd></div>
              <div><dt className="text-xs text-gray-700">Groupes non divisibles</dt><dd>{sim.groupesNonDivisibles.length}</dd></div>
            </>
          )}
          <div className="sm:col-span-2"><dt className="text-xs text-gray-700">Empreinte des entrées (SHA-256)</dt><dd><code className="break-all text-xs">{s.empreinteEntrees}</code></dd></div>
          <div className="sm:col-span-2"><dt className="text-xs text-gray-700">Empreinte du résultat (SHA-256)</dt><dd><code className="break-all text-xs">{s.empreinteResultat}</code></dd></div>
        </dl>
      </section>

      <div className="flex flex-wrap items-center gap-2 border-y py-3">
        <Button type="button" variant="outline" className="min-h-[44px] xl:min-h-0" disabled={rejeu.isPending} onClick={() => rejeu.mutate()}><RefreshCw aria-hidden="true" />Rejouer et vérifier l'empreinte</Button>
        {simulateur && droitExport.ok && (
          <>
            <Button type="button" variant="outline" className="min-h-[44px] xl:min-h-0" disabled={exporter.isPending} onClick={() => exporter.mutate("csv")}><Download aria-hidden="true" />Exporter en CSV</Button>
            <Button type="button" variant="outline" className="min-h-[44px] xl:min-h-0" disabled={exporter.isPending} onClick={() => exporter.mutate("json")}><Download aria-hidden="true" />Exporter en JSON</Button>
          </>
        )}
        {simulateur && !droitExport.ok && <p role="note" data-testid="export-indisponible" className="text-sm text-gray-800">Export indisponible : {droitExport.raison}.</p>}
        {peutEcrire && <Button type="button" variant="danger" className="min-h-[44px] xl:min-h-0" onClick={() => setConfirmation(true)}><Trash2 aria-hidden="true" />Supprimer le scénario</Button>}
      </div>
      {rejeu.isError && <EtatErreur panneau="Rejeu du scénario" erreur={lireErreur(rejeu.error, "Le rejeu a échoué.")} />}
      {rejeu.data && (
        <p role="status" data-testid="rapport-rejeu" className={`rounded border p-2 text-sm ${rejeu.data.identique && rejeu.data.entreesIntegres ? "border-green-300 bg-green-50 text-green-950" : "border-red-300 bg-red-50 text-red-950"}`}>
          {rejeu.data.explication} {rejeu.data.entreesIntegres ? "Les entrées stockées sont intègres." : "ATTENTION : les entrées stockées ne correspondent plus à leur empreinte."}{" "}
          Empreinte stockée : <code className="break-all">{rejeu.data.empreinteStockee}</code> ; recalculée : <code className="break-all">{rejeu.data.empreinteRecalculee}</code>.
        </p>
      )}
      {exporter.isError && <EtatErreur panneau="Export du scénario" erreur={lireErreur(exporter.error, "L'export a échoué.")} />}
      {supprimer.isError && <EtatErreur panneau="Suppression du scénario" erreur={lireErreur(supprimer.error, "La suppression a été refusée.")} />}

      {simulateur ? (
        <ResultatSimulationVue resultat={resultat} regions={regions} />
      ) : (
        <div className="space-y-2">
          {resultat.provisoire && <BandeauProvisoire etiquette={resultat.etiquette} motifs={resultat.motifsProvisoire} />}
          <LignesScenario lignes={resultat.lignes} parametres={resultat.parametres} titre={`Lignes du scénario ${resultat.annee}`} />
        </div>
      )}

      <Modal open={confirmation} onClose={() => setConfirmation(false)} title="Supprimer le scénario">
        <div className="space-y-3 text-sm">
          <p>
            Le scénario « {s.intitule} » ne sera plus listé ni comparable. C'est une suppression <strong>logique</strong> : la ligne reste en base pour l'audit.
            La suppression est refusée si une fiche d'intervention figée cite ce scénario.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmation(false)}>Annuler</Button>
            <Button variant="danger" disabled={supprimer.isPending} onClick={() => supprimer.mutate()}>Confirmer la suppression</Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
