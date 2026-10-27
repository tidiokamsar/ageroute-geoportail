import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, CheckCircle2, Database, Satellite, Target, XCircle } from "lucide-react";
import { classerErreur, type Synthese } from "../../lib/teledetectionApi";
import {
  acquisitionAncienne, affichageTaux, formaterDate, formaterResolution, SEUIL_ACQUISITION_ANCIENNE_JOURS,
} from "../../lib/teledetectionAffichage";
import { BandeauPerime, EtatChargement, EtatErreur } from "./EtatsPanneau";

/**
 * Rangee d'indicateurs de synthese. Chaque carte est independante : une valeur manquante affiche
 * « indisponible » ou une mention explicite, JAMAIS zero. Un zero n'apparait que si le serveur l'a
 * envoye.
 */

function Carte({ icone, libelle, valeur, detail, teinte, petitValeur }: {
  icone: ReactNode; libelle: string; valeur: ReactNode; detail?: ReactNode; teinte: string; petitValeur?: boolean;
}) {
  return (
    // dt et dd restent enfants directs de ce div (groupe de liste de definition valide pour axe).
    <div className="relative min-w-0 rounded-lg border border-gray-200 bg-white p-3 pl-14 shadow-sm">
      <span className="absolute left-3 top-3 flex h-9 w-9 items-center justify-center rounded-lg" style={{ backgroundColor: `${teinte}1a`, color: teinte }} aria-hidden="true">
        {icone}
      </span>
      <dt className="text-xs font-medium text-gray-600">{libelle}</dt>
      <dd className={`${petitValeur ? "text-base" : "text-2xl"} break-words font-bold leading-tight text-navy`}>{valeur}</dd>
      {detail && <dd className="mt-0.5 text-xs text-gray-600">{detail}</dd>}
    </div>
  );
}

const INDISPONIBLE = <span className="text-gray-500">—<span className="sr-only"> indisponible</span></span>;

export function IndicateursSynthese({ synthese }: { synthese: UseQueryResult<Synthese, unknown> }) {
  const { data, isPending, isError, error, isFetching, refetch, dataUpdatedAt } = synthese;
  const erreur = isError ? classerErreur(error) : null;
  const sans = !data;
  // Sans donnee : chargement ou erreur. Chaque carte montre un tiret, jamais 0.
  const v = (f: (d: Synthese) => ReactNode): ReactNode => (data ? f(data) : INDISPONIBLE);
  const taux = data ? affichageTaux({ ...data.tauxConfirmation, seuil: data.tauxConfirmation.seuil }) : null;
  const total = data?.sources.total ?? 0;
  const acq = data?.derniereAcquisition ?? null;
  const ancienne = acquisitionAncienne(data?.fraicheur.ageDerniereAcquisitionJours);

  return (
    <section aria-label="Indicateurs de synthèse" aria-busy={isPending} className="space-y-2">
      {isPending && <EtatChargement libelle="Chargement des indicateurs…" />}
      {erreur && sans && <EtatErreur panneau="Indicateurs" erreur={erreur} onReessayer={() => void refetch()} reessaiEnCours={isFetching} />}
      {erreur && !sans && <BandeauPerime panneau="Indicateurs" misAJourLe={dataUpdatedAt} onReessayer={() => void refetch()} />}
      <dl className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Carte
          teinte="#1a2942" icone={<Satellite className="h-5 w-5" />} libelle="Propositions à vérifier"
          valeur={v((d) => d.propositions.aVerifier.toLocaleString("fr-FR"))}
          detail={data ? (
            <span className={data.propositions.prioritaires > 0 ? "inline-flex items-center gap-1 font-medium text-red-700" : ""}>
              {data.propositions.prioritaires > 0 && <AlertTriangle aria-hidden="true" className="h-3 w-3" />}
              dont {data.propositions.prioritaires.toLocaleString("fr-FR")} {data.propositions.prioritaires > 1 ? "prioritaires" : "prioritaire"}
            </span>
          ) : undefined}
        />
        <Carte
          teinte="#12694a" icone={<CheckCircle2 className="h-5 w-5" />} libelle="Confirmées"
          valeur={v((d) => d.propositions.confirmees.toLocaleString("fr-FR"))}
          detail={taux && taux.jugees > 0 ? `sur ${taux.jugees.toLocaleString("fr-FR")} jugées` : undefined}
        />
        <Carte
          teinte="#b91c1c" icone={<XCircle className="h-5 w-5" />} libelle="Infirmées"
          valeur={v((d) => d.propositions.infirmees.toLocaleString("fr-FR"))}
          detail={taux && taux.jugees > 0 ? `sur ${taux.jugees.toLocaleString("fr-FR")} jugées` : undefined}
        />
        <Carte
          teinte="#1a2942" icone={<Database className="h-5 w-5" />} libelle="Sources actives"
          valeur={v((d) => d.sources.actives.toLocaleString("fr-FR"))}
          detail={data ? (total === 0 ? "Aucune source enregistrée" : `sur ${total.toLocaleString("fr-FR")} ${total > 1 ? "enregistrées" : "enregistrée"}`) : undefined}
        />
        <Carte
          teinte="#1a2942" icone={<CalendarClock className="h-5 w-5" />} libelle="Dernière acquisition" petitValeur
          valeur={v(() => (acq ? formaterDate(acq.date) : <span className="text-gray-700">Aucune acquisition</span>))}
          detail={data ? (acq ? (
            <>
              {acq.source} · {formaterResolution(acq.resolutionM)}
              {ancienne && <span className="block font-medium text-amber-800">Ancienne : {data.fraicheur.ageDerniereAcquisitionJours} jours (seuil {SEUIL_ACQUISITION_ANCIENNE_JOURS})</span>}
            </>
          ) : "Aucun produit enregistré") : undefined}
        />
        <Carte
          teinte="#1a2942" icone={<Target className="h-5 w-5" />} libelle="Taux de confirmation terrain" petitValeur
          valeur={taux ? taux.valeur : INDISPONIBLE}
          detail={taux ? (
            <>
              {taux.mention ?? (taux.genre === "aucun" ? "Aucune proposition jugée" : `sur ${taux.jugees.toLocaleString("fr-FR")} jugées`)}
              <span className="block" data-testid="non-precision-synthese">Ce n&apos;est pas la précision statistique.</span>
            </>
          ) : undefined}
        />
      </dl>
    </section>
  );
}
