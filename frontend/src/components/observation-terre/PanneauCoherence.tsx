import type { UseQueryResult } from "@tanstack/react-query";
import { classerErreur, type Coherence } from "../../lib/teledetectionApi";
import { BandeauPerime, EtatChargement, EtatErreur, EtatPermission } from "./EtatsPanneau";

/**
 * « Coherence » : ce que la vue `coherence_teledetection` signale entre le registre des produits, les propositions, les missions de
 * verification et les verdicts (ajout du lot 17, reporte sur l'ecran Observation de la Terre).
 *
 * - « Bloquante » : la mesure du taux de confirmation est faussee. « A examiner » : rien n'est faux, quelque chose est en suspens et
 *   demande une personne. Rien n'est corrige automatiquement.
 * - Une regle inconnue du libelle est rendue par son code, jamais masquee.
 * - C'est un agregat NATIONAL (toutes regions) : le serveur le refuse a un compte regional (403 HORS_PERIMETRE). Comme pour la qualite
 *   par methode, ce refus est une ABSENCE DE PERMISSION (message dedie), ni une panne ni un « aucune anomalie ».
 */

const LIBELLE_REGLE: Record<string, string> = {
  HORS_EMPRISE_PRODUIT: "Hors de l'emprise du produit",
  HORS_EMPRISE_REFERENCE: "Hors de l'emprise du produit de référence",
  REFERENCE_NON_ANTERIEURE: "Référence non antérieure au produit",
  VERDICT_AVANT_DEPOT: "Verdict antérieur au dépôt",
  TRONCON_SUPPRIME: "Tronçon retiré depuis le rattachement",
  PRODUIT_RETIRE_EN_ATTENTE: "Produit retiré, proposition en attente",
  MISSION_SANS_VERDICT: "Mission close sans verdict",
  VERDICT_AVANT_FIN_MISSION: "Verdict avant la fin de la mission",
};

const MESSAGE_REGIONAL =
  "Le contrôle de cohérence porte sur toutes les régions : il est réservé aux comptes nationaux.";

export function PanneauCoherence({ coherence }: { coherence: UseQueryResult<Coherence, unknown> }) {
  const { data, isPending, isError, error, refetch, isFetching, dataUpdatedAt } = coherence;
  const erreur = isError ? classerErreur(error) : null;

  return (
    <section aria-labelledby="titre-coherence" className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <h2 id="titre-coherence" className="text-sm font-semibold text-navy">Cohérence du registre, des propositions et des verdicts</h2>
      <p className="mt-0.5 text-xs text-gray-600">
        « Bloquante » : le taux de confirmation mesuré est faussé. « À examiner » : quelque chose reste en suspens. Rien n'est corrigé automatiquement.
      </p>

      {isPending && <EtatChargement libelle="Chargement du contrôle de cohérence…" />}
      {erreur && !data && (
        <div className="mt-2">
          {erreur.genre === "permission"
            ? <EtatPermission panneau="Cohérence" message={MESSAGE_REGIONAL} />
            : <EtatErreur panneau="Cohérence" erreur={erreur} onReessayer={() => void refetch()} reessaiEnCours={isFetching} />}
        </div>
      )}
      {erreur && data && <div className="mt-2"><BandeauPerime panneau="Cohérence" misAJourLe={dataUpdatedAt} onReessayer={() => void refetch()} /></div>}

      {data && data.anomalies.length === 0 && <p className="mt-2 text-sm text-gray-700">Aucune anomalie.</p>}

      {data && data.anomalies.length > 0 && (
        <>
          <p className="mt-2 text-sm">
            <strong>{data.bloquantes}</strong> bloquante(s), <strong>{data.aExaminer}</strong> à examiner
            {data.tronquee ? " (liste limitée aux 1 000 premières)" : ""}.
          </p>
          <ul className="mt-1 divide-y text-sm">
            {data.anomalies.map((a) => (
              <li key={`${a.regle}-${a.propositionId}`} className="py-1">
                <span className={a.gravite === "BLOQUANTE" ? "font-medium text-red-800" : "font-medium text-amber-900"}>
                  {a.gravite === "BLOQUANTE" ? "Bloquante" : "À examiner"}
                </span>
                {" · "}{LIBELLE_REGLE[a.regle] ?? a.regle}{a.detail ? ` — ${a.detail}` : ""}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
