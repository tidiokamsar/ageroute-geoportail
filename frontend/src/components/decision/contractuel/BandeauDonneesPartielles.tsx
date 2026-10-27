import { AlertTriangle } from "lucide-react";
import {
  BANDEAU_PARTIEL, formaterDate, formaterDateHeure, type DonneesPartielles, type FraicheurVue, type ReponseContractuel,
} from "../../../lib/aideDecisionContractuel";

/**
 * Bandeau permanent : la source de verite des marches, decomptes et paiements (DigitalRoad) n'est pas integree ; ce que l'ecran
 * montre est une copie gelee. Dit le PERIMETRE (qui est vu), la FRAICHEUR (derniere mise a jour, synchronisation inconnue) et les
 * RAISONS mesurees. Il ne disparait pas quand les donnees sont completes : elles ne le sont jamais tant que la source est externe.
 */
export function BandeauDonneesPartielles({ partielles, fraicheur, perimetre }: {
  partielles: DonneesPartielles; fraicheur: FraicheurVue; perimetre: ReponseContractuel["perimetre"];
}) {
  return (
    <section aria-label="Avertissement sur les données contractuelles" data-testid="bandeau-partiel"
      className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
      <p className="flex items-start gap-2 font-semibold">
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{BANDEAU_PARTIEL}</span>
      </p>
      <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
        <div>
          <dt className="font-semibold">Périmètre</dt>
          <dd>{perimetre.libelle}</dd>
        </div>
        <div>
          <dt className="font-semibold">Source</dt>
          <dd>Copie locale gelée (ADR-003) ; DigitalRoad fait foi.</dd>
        </div>
        <div>
          <dt className="font-semibold">Fraîcheur</dt>
          <dd>
            {fraicheur.derniereMiseAJour ? <>Dernière mise à jour de la copie : {formaterDate(fraicheur.derniereMiseAJour)} ({fraicheur.ageJours} jour{(fraicheur.ageJours ?? 0) > 1 ? "s" : ""}). </> : "Aucune mise à jour connue. "}
            Dernière synchronisation avec DigitalRoad : inconnue. Calculé le {formaterDateHeure(fraicheur.calculeLe)}.
            {fraicheur.perime && <strong className="ml-1 text-amber-900">Données périmées (au-delà de {fraicheur.seuilPeremptionJours} jours, seuil provisoire).</strong>}
          </dd>
        </div>
      </dl>
      <details className="mt-2 text-xs">
        <summary className="min-h-[44px] cursor-pointer py-2 font-medium xl:min-h-0 xl:py-0">Pourquoi les données sont partielles ({partielles.raisons.length} raison{partielles.raisons.length > 1 ? "s" : ""})</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          {partielles.raisons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      </details>
    </section>
  );
}
