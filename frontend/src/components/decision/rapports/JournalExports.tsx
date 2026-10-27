import { useQuery } from "@tanstack/react-query";
import { classerErreurDecision } from "../../../lib/aideDecisionApi";
import { OPTIONS_RELANCE, lireJournalExports } from "../../../lib/aideDecisionRapportsApi";
import { libelleTypeJournal, peutConsulterJournal, resumeFiltresJournal } from "../../../lib/aideDecisionRapports";
import { useAuth } from "../../../lib/auth";
import { formaterDateHeure, formaterEntier } from "../../../lib/decision";
import { EtatChargement, EtatErreur, EtatVide } from "../EtatsDecision";

/**
 * Journal des exports recents (qui, quand, type, filtres, perimetre, lignes, empreinte). Lecture seule. Un administrateur
 * voit tout le journal ; un gestionnaire, ses propres exports (regle du serveur).
 */
export const CLE_JOURNAL_EXPORTS = ["aide-decision", "exports-journal"] as const;

export function JournalExports() {
  const { user } = useAuth();
  // Le journal est reserve aux roles ADMIN et GESTIONNAIRE avec le module Rapports (serveur : liste de modules vide = aucun module).
  // Sans ce droit on NE LE REQUETE PAS : pas de 403 evitable, pas de refus bruyant pour un simple lecteur.
  const droit = peutConsulterJournal(user);
  const q = useQuery({ queryKey: CLE_JOURNAL_EXPORTS, queryFn: () => lireJournalExports(20), staleTime: 15_000, enabled: droit, ...OPTIONS_RELANCE });

  return (
    <section aria-labelledby="journal-titre" className="space-y-2">
      <h3 id="journal-titre" className="font-semibold text-gray-900">Exports récents</h3>
      {!droit && <p data-etat="journal-reserve" className="text-xs text-gray-700">Le journal des exports n'est consultable que par les Administrateurs et Gestionnaires disposant du module Rapports.</p>}
      {droit && q.isPending && <EtatChargement libelle="Chargement du journal des exports…" panneau="journal des exports" onReessayer={() => void q.refetch()} />}
      {q.isError && <EtatErreur panneau="journal des exports" erreur={classerErreurDecision(q.error)} onReessayer={() => void q.refetch()} reessaiEnCours={q.isFetching} />}
      {q.isSuccess && q.data.entrees.length === 0 && <EtatVide titre="Aucun export enregistré" detail="Les exports que vous lancerez apparaîtront ici avec leurs filtres et l'empreinte du fichier." />}
      {q.isSuccess && q.data.entrees.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Exports récents : date, auteur, type, filtres, périmètre, nombre de lignes et empreinte du fichier</caption>
            <thead className="text-gray-700">
              <tr className="border-b border-gray-200">
                <th scope="col" className="py-1 pr-3">Date</th>
                <th scope="col" className="py-1 pr-3">Auteur</th>
                <th scope="col" className="py-1 pr-3">Type</th>
                <th scope="col" className="py-1 pr-3">Filtres</th>
                <th scope="col" className="py-1 pr-3">Périmètre</th>
                <th scope="col" className="py-1 pr-3 text-right">Lignes</th>
                <th scope="col" className="py-1">Empreinte</th>
              </tr>
            </thead>
            <tbody>
              {q.data.entrees.map((e) => (
                <tr key={e.id} className="border-b border-gray-100 align-top">
                  <td className="py-1 pr-3 whitespace-nowrap">{formaterDateHeure(e.creeLe)}</td>
                  <td className="py-1 pr-3">{e.auteurEmail}</td>
                  <td className="py-1 pr-3">{libelleTypeJournal(e.type)} ({e.format.toUpperCase()}){e.colonnesRetirees.length > 0 ? ", sans colonnes financières" : ""}</td>
                  <td className="py-1 pr-3">{resumeFiltresJournal(e.filtres)}</td>
                  <td className="py-1 pr-3">{e.perimetreLibelle ?? "Non précisé"}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{formaterEntier(e.nbLignes)}</td>
                  <td className="py-1 font-mono" title={e.empreinteSha256 ?? undefined}>{e.empreinteSha256 ? `${e.empreinteSha256.slice(0, 12)}…` : "Non disponible"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {q.data.total > q.data.entrees.length && <p className="mt-1 text-xs text-gray-700">{q.data.entrees.length} exports affichés sur {q.data.total}.</p>}
        </div>
      )}
    </section>
  );
}
