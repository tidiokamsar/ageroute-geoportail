import { formaterDate, rendreVisible } from "./CompteursLot";
import type { EvenementHistorique } from "./types";

/**
 * Historique d'un lot : date, action, acteur, dans l'ordre chronologique (le plus ancien d'abord).
 *
 * La source est `audit_logs` (entité LotImport) : le client n'invente aucun événement. Le code d'action
 * est rendu tel que le serveur le donne, sauf les trois verbes d'audit courants, traduits. Un code
 * inconnu reste lisible tel quel plutôt qu'être deviné.
 */

const LIBELLE_ACTION: Record<string, string> = { CREATE: "Création", UPDATE: "Modification", DELETE: "Suppression" };

function ordre(evenements: EvenementHistorique[]): EvenementHistorique[] {
  // Tri stable : deux événements de même instant, ou une date illisible, gardent l'ordre du serveur.
  const horodatage = (e: EvenementHistorique) => {
    const t = new Date(e.date).getTime();
    return Number.isNaN(t) ? 0 : t;
  };
  return evenements.map((e, i) => ({ e, i })).sort((a, b) => horodatage(a.e) - horodatage(b.e) || a.i - b.i).map(({ e }) => e);
}

export function HistoriqueLot({ historique, idTitre }: { historique: EvenementHistorique[]; idTitre?: string }) {
  return (
    <div>
      <h3 id={idTitre} className="mb-2 text-sm font-semibold text-slate-900">Historique du lot</h3>
      {historique.length === 0 ? (
        <p className="text-sm text-slate-700">Aucun événement enregistré pour ce lot.</p>
      ) : (
        <ol className="space-y-2" aria-labelledby={idTitre}>
          {ordre(historique).map((e, i) => (
            <li key={`${e.date}-${i}`} className="rounded border border-slate-200 p-2 text-sm">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <time dateTime={e.date} className="text-xs text-slate-700">{formaterDate(e.date)}</time>
                <span className="font-medium text-slate-900">{rendreVisible(LIBELLE_ACTION[e.action] ?? e.action)}</span>
                <span className="text-slate-700">par {e.acteur ? rendreVisible(e.acteur) : "un acteur non renseigné"}</span>
              </p>
              {e.details && <p className="mt-0.5 break-words text-xs text-slate-700">{rendreVisible(e.details)}</p>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
