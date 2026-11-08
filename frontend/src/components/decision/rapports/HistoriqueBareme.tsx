import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { ReponseInattendue, classerErreurDecision } from "../../../lib/aideDecisionApi";
import { OPTIONS_RELANCE } from "../../../lib/aideDecisionRapportsApi";
import { libelleEvenement, lignesChangement, type EvenementBareme } from "../../../lib/aideDecisionRapportsBaremes";
import { formaterDateHeure } from "../../../lib/decision";
import { EtatChargement, EtatErreur, EtatVide } from "../EtatsDecision";

/**
 * Historique d'une ligne de bareme : qui a change quoi, quand, pourquoi (motif obligatoire), valeurs avant et apres, et
 * l'etat d'approbation laisse par l'evenement. Source : `GET /api/v2/baremes/:id/historique` (le meme contenu est servi par
 * `GET /api/v2/aide-decision/baremes/:id/historique`). Lecture seule, du plus recent au plus ancien.
 */
async function lireHistorique(id: number): Promise<EvenementBareme[]> {
  const r = await api.get<unknown>(`/v2/baremes/${id}/historique`);
  const d = (r.data as { data?: unknown } | null)?.data;
  if (!Array.isArray(d)) throw new ReponseInattendue("l'historique du barème");
  for (const e of d) {
    const o = e as Partial<EvenementBareme> | null;
    if (!o || typeof o.id !== "number" || typeof o.evenement !== "string" || !Array.isArray(o.champsModifies) || typeof o.creeLe !== "string" || !o.auteur) {
      throw new ReponseInattendue("l'historique du barème");
    }
  }
  return d as EvenementBareme[];
}

export function HistoriqueBareme({ id, titre }: { id: number; titre: string }) {
  const q = useQuery({ queryKey: ["v2", "baremes", id, "historique"], queryFn: () => lireHistorique(id), staleTime: 0, ...OPTIONS_RELANCE });
  const panneau = `historique du barème ${titre}`;
  return (
    <section aria-label={`Historique : ${titre}`} className="space-y-2 rounded-md border border-gray-200 bg-gray-50 p-3 text-sm">
      {q.isPending && <EtatChargement libelle="Chargement de l'historique…" panneau={panneau} onReessayer={() => void q.refetch()} />}
      {q.isError && <EtatErreur panneau={panneau} erreur={classerErreurDecision(q.error)} onReessayer={() => void q.refetch()} reessaiEnCours={q.isFetching} />}
      {q.isSuccess && q.data.length === 0 && (
        <EtatVide titre="Aucun historique" detail="Cette ligne est une valeur d'origine (standard initial) : personne ne l'a modifiée depuis. Sa première modification sera historisée." />
      )}
      {q.isSuccess && q.data.length > 0 && (
        <ol className="space-y-2">
          {q.data.map((e) => (
            <li key={e.id} className="border-l-2 border-gray-300 pl-3">
              <p className="font-medium text-gray-900">
                {libelleEvenement(e)} · version {e.version} · {formaterDateHeure(e.creeLe)}
              </p>
              <p className="text-gray-800">Par {e.auteur.email} · statut après : {e.statutApprobation === "APPROUVE" ? "approuvé" : "non approuvé"}</p>
              <p className="text-gray-800">Motif : {e.motif}</p>
              {e.commentaire && <p className="text-gray-800">Commentaire : {e.commentaire}</p>}
              {lignesChangement(e).length > 0 && (
                <ul className="list-disc pl-4 text-gray-700">{lignesChangement(e).map((l) => <li key={l}>{l}</li>)}</ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
