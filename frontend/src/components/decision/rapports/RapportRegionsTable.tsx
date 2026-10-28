import { useQuery } from "@tanstack/react-query";
import type { FiltresDecision } from "../types";
import { classerErreurDecision } from "../../../lib/aideDecisionApi";
import { OPTIONS_RELANCE, lireRapportRegions, type LigneRegionLue } from "../../../lib/aideDecisionRapportsApi";
import { LIBELLE_DISPONIBILITE, mentionLongueur, statutLongueur } from "../../../lib/aideDecisionRapports";
import { ABSENT, erreurPeriode, formaterKm, formaterPct, serialiserFiltres } from "../../../lib/decision";
import { EtatChargement, EtatErreur, EtatVide } from "../EtatsDecision";

/**
 * Apercu du rapport « Etat du reseau par region » (km par etat, non evalue A PART, taux sur les etats valides). Meme lecture
 * que l'export : ce que l'on voit ici est ce que le fichier contient.
 *
 * UNE ABSENCE N'EST PAS UN ZERO. Un taux non calculable est « Non disponible » ; une region dont aucun troncon n'a de longueur
 * metier montre « Longueur non renseignee » (pas « 0 km ») avec le nombre de troncons concernes ; une region partiellement
 * renseignee dit combien de troncons manquent.
 */
function Ligne({ l, total = false }: { l: LigneRegionLue; total?: boolean }) {
  const statut = statutLongueur(l);
  const mention = mentionLongueur(l);
  const inconnue = statut === "NON_RENSEIGNEE";
  const km = (v: number | null) => (inconnue ? ABSENT : formaterKm(v));
  return (
    <tr className={`border-b border-gray-100 ${total ? "bg-gray-50 font-semibold" : ""}`}>
      <th scope="row" className="py-1 pr-3 text-left font-medium">
        {l.region}
        {l.troncons !== null && <span className="block text-[11px] font-normal text-gray-700">{l.troncons} tronçon{l.troncons > 1 ? "s" : ""}</span>}
        {mention && <span data-etat={inconnue ? "longueur-non-renseignee" : "longueur-partielle"} className="block text-[11px] font-normal text-amber-900">{mention}</span>}
      </th>
      <td className="py-1 pr-3 text-right tabular-nums">{km(l.kmBon)}</td>
      <td className="py-1 pr-3 text-right tabular-nums">{km(l.kmMoyen)}</td>
      <td className="py-1 pr-3 text-right tabular-nums">{km(l.kmMauvais)}</td>
      <td className="py-1 pr-3 text-right tabular-nums">{km(l.kmCritique)}</td>
      <td className="py-1 pr-3 text-right tabular-nums">{km(l.kmEtatNonValide)}</td>
      <td className="py-1 pr-3 text-right tabular-nums">{km(l.kmNonEvalue)}</td>
      <td className="py-1 pr-3 text-right tabular-nums">
        {l.degradePct === null ? ABSENT : formaterPct(l.degradePct)}
        {l.disponibilite !== "DISPONIBLE" && <span className="block text-[11px] font-normal text-gray-700">{LIBELLE_DISPONIBILITE[l.disponibilite] ?? l.disponibilite}</span>}
      </td>
    </tr>
  );
}

export function RapportRegionsTable({ filtres }: { filtres: FiltresDecision }) {
  const periodeKo = erreurPeriode(filtres) !== null;
  const q = useQuery({
    queryKey: ["aide-decision", "rapport-regions", serialiserFiltres(filtres).toString()],
    queryFn: () => lireRapportRegions(filtres),
    enabled: !periodeKo, staleTime: 60_000, ...OPTIONS_RELANCE,
  });

  return (
    <section aria-labelledby="rapport-regions-titre" className="space-y-2">
      <h3 id="rapport-regions-titre" className="font-semibold text-gray-900">Aperçu : état du réseau par région</h3>
      {periodeKo && <EtatVide titre="Aperçu indisponible" detail="La période est incohérente : corrigez-la dans les filtres." />}
      {!periodeKo && q.isPending && <EtatChargement libelle="Chargement de l'aperçu par région…" panneau="aperçu par région" onReessayer={() => void q.refetch()} />}
      {q.isError && <EtatErreur panneau="aperçu par région" erreur={classerErreurDecision(q.error)} onReessayer={() => void q.refetch()} reessaiEnCours={q.isFetching} />}
      {q.isSuccess && (
        <>
          <p className="text-xs text-gray-700">Périmètre : {q.data.perimetreLibelle}. Longueurs métier en km ; taux sur les seuls états valides, non évalué compté à part.</p>
          {q.data.regions.length === 0 ? (
            <EtatVide titre="Aucune région dans ce périmètre" detail="Le rapport est vide, il n'est pas nul : aucun tronçon du réseau classé n'est saisi ici." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <caption className="sr-only">Kilomètres par état et par région, non évalué à part, part dégradée</caption>
                <thead className="text-gray-700">
                  <tr className="border-b border-gray-200 text-right">
                    <th scope="col" className="py-1 pr-3 text-left">Région</th>
                    <th scope="col" className="py-1 pr-3">Bon</th>
                    <th scope="col" className="py-1 pr-3">Moyen</th>
                    <th scope="col" className="py-1 pr-3">Mauvais</th>
                    <th scope="col" className="py-1 pr-3">Critique</th>
                    <th scope="col" className="py-1 pr-3">État non valide</th>
                    <th scope="col" className="py-1 pr-3">Non évalué</th>
                    <th scope="col" className="py-1 pr-3">Dégradé (provisoire)</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.regions.map((l) => <Ligne key={l.region} l={l} />)}
                  {q.data.total && <Ligne l={q.data.total} total />}
                </tbody>
              </table>
            </div>
          )}
          {q.data.avertissements.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-gray-700">{q.data.avertissements.map((a) => <li key={a}>{a}</li>)}</ul>
          )}
        </>
      )}
    </section>
  );
}
