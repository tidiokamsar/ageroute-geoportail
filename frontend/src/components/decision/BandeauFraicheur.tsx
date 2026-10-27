import { AlertTriangle, CalendarClock } from "lucide-react";
import type { CouvertureSynthese, FraicheurSynthese, PerimetreSynthese, Section } from "../../lib/aideDecisionApi";
import type { Kpi } from "./types";
import { couverturePartielle, evaluerFraicheur, formaterDate, formaterDateHeure, SEUIL_PERIME_JOURS_PROVISOIRE, texteCouverture } from "../../lib/decision";

/**
 * Bandeau de fraicheur (cahier paragraphe 4.3) : date d'actualisation, derniere evaluation d'etat, perimetre et
 * couverture des indicateurs cles. Quand les sources sont anciennes, incompletes ou perimees, il le dit ET interdit les
 * conclusions excessives : un chiffre calcule sur des donnees vieilles ou partielles est un ordre de grandeur, pas un constat.
 */
export function BandeauFraicheur({ fraicheur, couverture, perimetre, avertissements, kpis, maintenant }: {
  fraicheur: Section<FraicheurSynthese>;
  couverture: CouvertureSynthese | null;
  perimetre: PerimetreSynthese | null;
  avertissements: string[];
  kpis: Pick<Kpi, "etat">[];
  maintenant: Date;
}) {
  const ev = fraicheur.ok ? evaluerFraicheur(fraicheur.valeur, maintenant) : null;
  const partiel = couverturePartielle(couverture) || kpis.some((k) => k.etat === "PARTIEL");
  const kpisPerimes = kpis.filter((k) => k.etat === "PERIME").length;
  const prudence = !!ev?.perime || kpisPerimes > 0 || partiel || !fraicheur.ok;
  const texteCouv = texteCouverture(couverture);

  return (
    <section
      aria-label="Fraîcheur et couverture des données"
      data-etat={prudence ? "prudence" : "ok"}
      className={`rounded-md border px-3 py-2 text-xs ${prudence ? "border-amber-300 bg-amber-50 text-amber-900" : "border-gray-200 bg-white text-gray-800"}`}
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <CalendarClock aria-hidden="true" className="h-4 w-4 shrink-0" />
        {ev ? (
          <>
            <span><strong>Actualisé le {formaterDateHeure(ev.calculeLe)}</strong></span>
            <span>
              {ev.derniereEvaluationLe
                ? `· dernière évaluation d'état : ${formaterDate(ev.derniereEvaluationLe)}${ev.ageDonneesJours !== null ? ` (${ev.ageDonneesJours} jour${ev.ageDonneesJours > 1 ? "s" : ""})` : ""}`
                : "· date de la dernière évaluation d'état inconnue"}
            </span>
            {ev.plusAncienneEvaluationLe && <span>· la plus ancienne : {formaterDate(ev.plusAncienneEvaluationLe)}</span>}
          </>
        ) : (
          <span><strong>Date d&apos;actualisation indisponible</strong> (réponse inattendue du serveur).</span>
        )}
        {perimetre && <span>· Périmètre : {perimetre.libelle}</span>}
        {texteCouv && <span>· Longueur : {texteCouv}</span>}
      </p>
      {prudence && (
        <p className="mt-1 flex items-start gap-1 font-medium" data-testid="mise-en-garde-fraicheur">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {ev?.perime && `Données anciennes (plus de ${SEUIL_PERIME_JOURS_PROVISOIRE} jours, seuil provisoire). `}
            {kpisPerimes > 0 && `${kpisPerimes} indicateur${kpisPerimes > 1 ? "s" : ""} périmé${kpisPerimes > 1 ? "s" : ""}. `}
            {partiel && "Couverture partielle : une part du réseau n'est pas à état valide (non évaluée, état non valide ou sans longueur) et reste hors des taux. "}
            {!fraicheur.ok && "Fraîcheur inconnue. "}
            N&apos;en tirez pas de conclusion définitive : ces chiffres sont des ordres de grandeur.
          </span>
        </p>
      )}
      {avertissements.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          {avertissements.map((a) => <li key={a}>{a}</li>)}
        </ul>
      )}
    </section>
  );
}
