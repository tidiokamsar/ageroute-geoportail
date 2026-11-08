import { forwardRef } from "react";
import type { KpiLu } from "../../lib/aideDecisionApi";
import { useDictionnaire } from "../../lib/aideDecisionHooks";
import { classerErreurDecision } from "../../lib/aideDecisionApi";
import { LIBELLE_ETAT_KPI, textePeriode } from "../../lib/decision";
import { Button } from "../ui/Button";

/**
 * Definition detaillee d'un indicateur, ouverte par « Voir la definition ». Elle montre tout de suite ce que la
 * reponse porte (definition, formule, source, periode, perimetre, statut) et y ajoute, quand le dictionnaire repond,
 * les conditions, les limites et le responsable metier A CONFIRMER. Un dictionnaire indisponible ne vide pas la
 * definition deja connue.
 */
export const PanneauDefinition = forwardRef<HTMLHeadingElement, { kpi: KpiLu; onFermer: () => void }>(function PanneauDefinition({ kpi, onFermer }, ref) {
  const dico = useDictionnaire(true);
  const entree = dico.data?.find((e) => e.code === kpi.code);
  return (
    <section id="panneau-definition" aria-labelledby="titre-definition" className="rounded-lg border border-navy/30 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start gap-2">
        <h3 id="titre-definition" ref={ref} tabIndex={-1} className="min-w-0 flex-1 text-sm font-semibold text-navy focus:outline-none">
          Définition : {kpi.libelle}
        </h3>
        <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-8" aria-label={`Fermer la définition : ${kpi.libelle}`} onClick={onFermer}>
          Fermer
        </Button>
      </div>
      <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm text-gray-800 sm:grid-cols-[max-content_1fr]">
        <dt className="font-medium">Définition</dt><dd>{entree?.definition || kpi.definition || "Non fournie par le serveur."}</dd>
        <dt className="font-medium">Formule</dt><dd>{entree?.formule || kpi.formule || "Non fournie par le serveur."}</dd>
        <dt className="font-medium">Unité</dt><dd>{kpi.unite || "non précisée"}</dd>
        <dt className="font-medium">Périmètre</dt>
        <dd>
          {kpi.perimetre.libelle || "non précisé"}
          {entree && (entree.perimetre.libelle || entree.perimetre.definition) && (
            <span className="block text-gray-700">{[entree.perimetre.libelle, entree.perimetre.definition].filter(Boolean).join(" : ")}</span>
          )}
        </dd>
        <dt className="font-medium">Période</dt><dd>{textePeriode(kpi.periode)}</dd>
        <dt className="font-medium">Source</dt><dd>{entree?.source || kpi.source || "non précisée"}{entree?.dateDefinition && <span className="block text-gray-700">Définition révisée le {entree.dateDefinition}{entree.miseAJour ? ` ; mise à jour : ${entree.miseAJour}` : ""}</span>}</dd>
        <dt className="font-medium">Statut</dt>
        <dd>{kpi.statutDefinition === "PROVISOIRE" ? "Définition provisoire : choix de conduite réversible, pas une règle officielle validée par le métier." : "Définition validée."} État de l&apos;indicateur : {LIBELLE_ETAT_KPI[kpi.etat]}.</dd>
        {entree && entree.conditionsCalcul.length > 0 && (<><dt className="font-medium">Conditions de calcul</dt><dd><ul className="list-disc pl-4">{entree.conditionsCalcul.map((c) => <li key={c}>{c}</li>)}</ul></dd></>)}
        {entree && entree.reglesExclusion.length > 0 && (<><dt className="font-medium">Règles d&apos;exclusion</dt><dd><ul className="list-disc pl-4">{entree.reglesExclusion.map((c) => <li key={c}>{c}</li>)}</ul></dd></>)}
        {entree && entree.limites.length > 0 && (<><dt className="font-medium">Limites</dt><dd><ul className="list-disc pl-4">{entree.limites.map((c) => <li key={c}>{c}</li>)}</ul></dd></>)}
        {entree && entree.decisionsOuvertes.length > 0 && (
          <>
            <dt className="font-medium">Décisions métier non tranchées</dt>
            <dd data-testid="decisions-ouvertes"><ul className="list-disc pl-4">{entree.decisionsOuvertes.map((c) => <li key={c}>{c}</li>)}</ul></dd>
          </>
        )}
        {entree && entree.responsableMetier && (<><dt className="font-medium">Responsable métier</dt><dd>{entree.responsableMetier}</dd></>)}
      </dl>
      {dico.isPending && <p role="status" className="mt-2 text-xs text-gray-700">Chargement du dictionnaire des indicateurs…</p>}
      {dico.isError && (
        <p role="status" className="mt-2 text-xs text-amber-900">
          Le dictionnaire détaillé est indisponible ({classerErreurDecision(dico.error).message}) : conditions, limites et responsable ne sont pas affichés.
        </p>
      )}
      {dico.isSuccess && !entree && <p role="status" className="mt-2 text-xs text-gray-700">Aucune entrée du dictionnaire pour le code « {kpi.code} ».</p>}
    </section>
  );
});
