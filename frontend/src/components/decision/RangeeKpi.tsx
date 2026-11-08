import type { UseQueryResult } from "@tanstack/react-query";
import type { SyntheseLue } from "../../lib/aideDecisionApi";
import { classerErreurDecision } from "../../lib/aideDecisionApi";
import type { Kpi } from "./types";
import { BandeauPerime, EtatChargement, EtatErreur, EtatVide } from "./EtatsDecision";
import { KpiDecision } from "./KpiDecision";
import { BandeauFraicheur } from "./BandeauFraicheur";

/**
 * Rangee des indicateurs cles et son bandeau de fraicheur, avec TOUS les etats du paragraphe 7 du contrat :
 * chargement (squelette borne), vide explicite, erreur API (role alert + « Reessayer : indicateurs »), permission
 * refusee, donnees perimees (derniere lecture + avertissement), indicateurs illisibles ecartes et comptes.
 */
export function RangeeKpi({ requete, onOuvrir, onDefinition, definitionCode, maintenant }: {
  requete: UseQueryResult<SyntheseLue, unknown>;
  onOuvrir: (k: Kpi) => void;
  onDefinition: (code: string) => void;
  definitionCode: string | null;
  maintenant: Date;
}) {
  const { data, isPending, isError, error, isFetching, refetch, dataUpdatedAt } = requete;
  const erreur = isError ? classerErreurDecision(error) : null;
  const reessayer = () => void refetch();

  return (
    <section aria-labelledby="titre-kpi" aria-busy={isPending} className="space-y-2">
      <h2 id="titre-kpi" className="text-sm font-semibold text-navy">Indicateurs clés</h2>
      {isPending && (
        <>
          <EtatChargement libelle="Chargement des indicateurs…" panneau="indicateurs" onReessayer={reessayer} />
          <div aria-hidden="true" className="grid animate-pulse gap-3 min-[480px]:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-40 rounded-lg bg-gray-200" />)}
          </div>
        </>
      )}
      {erreur && !data && <EtatErreur panneau="indicateurs" erreur={erreur} onReessayer={reessayer} reessaiEnCours={isFetching} />}
      {erreur && data && <BandeauPerime panneau="Indicateurs" misAJourLe={dataUpdatedAt} onReessayer={reessayer} />}
      {data && (
        <>
          <BandeauFraicheur fraicheur={data.fraicheur} couverture={data.couverture} perimetre={data.perimetre} avertissements={data.avertissements} kpis={data.kpis} maintenant={maintenant} />
          {data.kpisIgnores > 0 && (
            <p role="status" data-etat="kpi-ignores" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-900">
              {data.kpisIgnores} indicateur{data.kpisIgnores > 1 ? "s" : ""} de la réponse {data.kpisIgnores > 1 ? "ont" : "a"} une forme inattendue et {data.kpisIgnores > 1 ? "ne sont" : "n'est"} pas affiché{data.kpisIgnores > 1 ? "s" : ""}.
            </p>
          )}
          {data.kpis.length === 0 ? (
            <EtatVide titre="Aucun indicateur disponible pour ce périmètre." detail="Modifiez les filtres ou réessayez plus tard." />
          ) : (
            <div className="grid gap-3 min-[480px]:grid-cols-2 xl:grid-cols-4">
              {data.kpis.map((k) => (
                <KpiDecision key={k.code} kpi={k} onOuvrir={onOuvrir} onDefinition={onDefinition} definitionOuverte={definitionCode === k.code} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
