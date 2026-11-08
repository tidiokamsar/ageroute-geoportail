import type { UseQueryResult } from "@tanstack/react-query";
import { classerErreur, type Synthese } from "../../lib/teledetectionApi";
import { affichageTaux, MENTION_NON_PRECISION } from "../../lib/teledetectionAffichage";
import { BandeauPerime, EtatChargement, EtatErreur } from "./EtatsPanneau";
import { InfoBulle } from "./InfoBulle";

/**
 * Taux de confirmation terrain = confirmees / (confirmees + infirmees).
 *
 * CE QUE CE WIDGET NE DIT PAS : « precision ». Il ne voit pas les changements reels que la methode
 * n'a pas detectes ; la precision et le rappel d'une methode exigent un protocole de reference
 * terrain qui n'existe pas encore (contrat, principe 3). D'ou : le mot « precision » n'est jamais
 * la valeur affichee, la mention le nie en toutes lettres, et sous le seuil d'echantillon la valeur
 * est accompagnee de « echantillon insuffisant (n = ... ) ». A zero verdict : « Aucun verdict ».
 */

const R = 40;
const C = 2 * Math.PI * R;
const VERT = "#12694a";
const ROUGE = "#b91c1c";

export function WidgetTauxConfirmation({ synthese }: { synthese: UseQueryResult<Synthese, unknown> }) {
  const { data, isPending, isError, error, refetch, isFetching, dataUpdatedAt } = synthese;
  const erreur = isError ? classerErreur(error) : null;
  const t = data ? affichageTaux(data.tauxConfirmation) : null;
  const definition = data?.tauxConfirmation.definition?.trim() || "Confirmées ÷ (confirmées + infirmées), mesuré contre les verdicts du terrain.";

  const longConf = t && t.jugees > 0 ? (t.confirmees / t.jugees) * C : 0;
  const longInf = t && t.jugees > 0 ? (t.infirmees / t.jugees) * C : 0;

  return (
    <section aria-labelledby="titre-taux" className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 id="titre-taux" className="text-sm font-semibold text-navy">Taux de confirmation terrain</h2>
        <InfoBulle libelle="Taux de confirmation terrain" alignement="droite">
          <strong className="block">{definition}</strong>
          <span className="mt-1 block">{MENTION_NON_PRECISION}</span>
          {t && <span className="mt-1 block">Seuil d&apos;échantillon : {t.seuil} verdicts (provisoire).</span>}
        </InfoBulle>
      </div>

      {isPending && <EtatChargement libelle="Chargement du taux de confirmation…" />}
      {erreur && !data && <div className="mt-2"><EtatErreur panneau="Taux de confirmation" erreur={erreur} onReessayer={() => void refetch()} reessaiEnCours={isFetching} /></div>}
      {erreur && data && <div className="mt-2"><BandeauPerime panneau="Taux de confirmation" misAJourLe={dataUpdatedAt} onReessayer={() => void refetch()} /></div>}

      {t && (
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <div className="relative h-28 w-28 shrink-0">
            <svg viewBox="0 0 100 100" className="h-28 w-28 -rotate-90" role="img" aria-label={`${t.confirmees} confirmées et ${t.infirmees} infirmées sur ${t.jugees} jugées`}>
              <circle cx="50" cy="50" r={R} fill="none" stroke="#e5e7eb" strokeWidth="10" />
              {t.jugees > 0 && (
                <>
                  <circle cx="50" cy="50" r={R} fill="none" stroke={VERT} strokeWidth="10" strokeDasharray={`${longConf} ${C - longConf}`} strokeDashoffset={0} />
                  <circle cx="50" cy="50" r={R} fill="none" stroke={ROUGE} strokeWidth="10" strokeDasharray={`${longInf} ${C - longInf}`} strokeDashoffset={-longConf} />
                </>
              )}
            </svg>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
              <span
                data-testid="valeur-taux"
                className={`${t.genre === "aucun" ? "text-xs" : "text-xl"} font-bold leading-tight ${t.genre === "insuffisant" ? "text-gray-600" : "text-navy"}`}
              >
                {t.valeur}
              </span>
            </div>
          </div>

          <div className="min-w-0 flex-1 basis-40">
            <dl className="space-y-1 text-sm">
              <div className="flex items-center justify-between gap-2">
                <dt className="flex items-center gap-1.5"><span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: VERT }} />Confirmées</dt>
                <dd className="font-semibold">{t.confirmees.toLocaleString("fr-FR")}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="flex items-center gap-1.5"><span aria-hidden="true" className="inline-block h-2.5 w-2.5 rotate-45" style={{ backgroundColor: ROUGE }} />Infirmées</dt>
                <dd className="font-semibold">{t.infirmees.toLocaleString("fr-FR")}</dd>
              </div>
              <div className="flex items-center justify-between gap-2 border-t pt-1">
                <dt>Total jugées</dt>
                <dd className="font-semibold">{t.jugees.toLocaleString("fr-FR")}</dd>
              </div>
            </dl>
            {t.mention && (
              <p data-testid="mention-echantillon" className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs font-medium text-amber-900">{t.mention}</p>
            )}
            {t.genre === "aucun" && <p className="mt-2 text-xs text-gray-600">Aucune proposition n&apos;a encore reçu de verdict du terrain.</p>}
          </div>
        </div>
      )}

      <p className="mt-3 border-t pt-2 text-xs text-gray-600">
        Ce n&apos;est pas la précision statistique de la détection : ce taux ne mesure que la part des propositions jugées que le terrain a confirmées.
      </p>
    </section>
  );
}
