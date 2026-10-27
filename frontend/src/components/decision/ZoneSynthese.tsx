import type { UseQueryResult } from "@tanstack/react-query";
import type { SyntheseLue } from "../../lib/aideDecisionApi";
import { classerErreurDecision } from "../../lib/aideDecisionApi";
import type { FiltresDecision } from "./types";
import { BandeauPerime, EtatChargement, EtatErreur } from "./EtatsDecision";
import { PanneauBudget, PanneauQualite, PanneauRegions, PanneauRepartition } from "./PanneauxSynthese";
import { formaterDateHeure, textePeriode } from "../../lib/decision";

/**
 * Zone inferieure de l'onglet « Carte et priorisation » (maquette, cahier paragraphe 4.1) : repartition de l'etat du
 * reseau, degradation par region, budget, qualite. Elle lit la MEME synthese que les indicateurs (un seul appel, un
 * seul perimetre) et porte ses propres etats : chargement borne, erreur avec « Reessayer » au nom unique,
 * permission refusee, donnees perimees.
 */
export function ZoneSynthese({ requete, filtres, onFiltres }: { requete: UseQueryResult<SyntheseLue, unknown>; filtres: FiltresDecision; onFiltres: (f: FiltresDecision) => void }) {
  const { data, isPending, isError, error, isFetching, refetch, dataUpdatedAt } = requete;
  const erreur = isError ? classerErreurDecision(error) : null;
  const reessayer = () => void refetch();

  return (
    <section aria-labelledby="titre-synthese" aria-busy={isPending} className="space-y-3">
      <h2 id="titre-synthese" className="text-sm font-semibold text-navy">Situation du réseau et budget</h2>
      {isPending && <EtatChargement libelle="Chargement de la synthèse du réseau…" panneau="synthèse du réseau" onReessayer={reessayer} />}
      {erreur && !data && <EtatErreur panneau="synthèse du réseau" erreur={erreur} onReessayer={reessayer} reessaiEnCours={isFetching} />}
      {erreur && data && <BandeauPerime panneau="Synthèse du réseau" misAJourLe={dataUpdatedAt} onReessayer={reessayer} />}
      {data && (
        <div className="grid gap-3 lg:grid-cols-2">
          <PanneauRepartition
            section={data.repartitionEtat}
            periode={filtres.depuis || filtres.jusqua ? textePeriode({ depuis: filtres.depuis ?? null, jusqua: filtres.jusqua ?? null }) : "Période : état courant, non filtré par date"}
            situation={data.fraicheur.ok ? `situation au ${formaterDateHeure(data.fraicheur.valeur.calculeLe)}` : "date de calcul inconnue"}
            onReessayer={reessayer}
          />
          <PanneauRegions section={data.degradationParRegion} filtres={filtres} onFiltres={onFiltres} onReessayer={reessayer} />
          <PanneauBudget section={data.budget} onReessayer={reessayer} />
          <PanneauQualite section={data.qualite} onReessayer={reessayer} />
        </div>
      )}
    </section>
  );
}
