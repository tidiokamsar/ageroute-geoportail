import type { FiltresDecision } from "../types";
import { apercuParametres, definitionType, repartitionFiltres, type DroitsCompte, type TypeRapport } from "../../../lib/aideDecisionRapports";

/**
 * Apercu des PARAMETRES d'un export avant de le lancer : periode, perimetre, sources, unites, droit financier, filtres
 * appliques, filtres NON appliques (avec la raison) et filtres que les donnees ne permettent pas. Rien n'est calcule ici ;
 * le fichier remis porte les memes informations. Un filtre qui ne s'applique pas est dit, jamais retire en silence.
 */
export function ApercuRapport({ type, filtres, compte, nomRegion = null, scenario = null }: {
  type: TypeRapport; filtres: FiltresDecision; compte: DroitsCompte | null | undefined; nomRegion?: string | null; scenario?: string | null;
}) {
  const a = apercuParametres(type, filtres, compte, nomRegion);
  const r = repartitionFiltres(type, filtres, nomRegion);
  const def = definitionType(type);
  return (
    <section aria-labelledby="apercu-titre" className="rounded-md border border-gray-200 p-3 text-sm">
      <h3 id="apercu-titre" className="mb-2 font-semibold text-gray-900">Paramètres de l&apos;export : {a.titre}</h3>
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[10rem_1fr]">
        <dt className="font-medium text-gray-800">Période</dt><dd>{a.periode}</dd>
        <dt className="font-medium text-gray-800">Périmètre</dt><dd>{a.perimetre}</dd>
        {def.necessiteScenario && (<><dt className="font-medium text-gray-800">Scénario</dt><dd>{scenario ?? "Aucun scénario choisi"}</dd></>)}
        <dt className="font-medium text-gray-800">Sources</dt>
        <dd><ul className="list-disc pl-4">{a.sources.map((s) => <li key={s}>{s}</li>)}</ul></dd>
        <dt className="font-medium text-gray-800">Unités</dt><dd>{a.unites}</dd>
        <dt className="font-medium text-gray-800">Droit financier</dt><dd>{a.financier}</dd>
        <dt className="font-medium text-gray-800">Filtres appliqués</dt>
        <dd>
          {r.appliques.length === 0
            ? "Aucun filtre : tout le périmètre autorisé est exporté."
            : <ul className="list-disc pl-4">{r.appliques.map((f) => <li key={f.cle}>{f.libelle} : {f.valeur}</li>)}</ul>}
        </dd>
        {r.nonAppliques.length > 0 && (
          <>
            <dt className="font-medium text-amber-900">Filtres non appliqués</dt>
            <dd data-etat="filtres-non-appliques">
              <ul className="list-disc pl-4">{r.nonAppliques.map((f) => <li key={f.cle}>{f.libelle} : non appliqué, {f.raison}.</li>)}</ul>
            </dd>
          </>
        )}
        <dt className="font-medium text-gray-800">Filtres indisponibles</dt>
        <dd>
          <ul className="list-disc pl-4 text-gray-700">{r.sansDonnee.map((f) => <li key={f.cle}>{f.libelle} : indisponible, {f.raison}.</li>)}</ul>
        </dd>
      </dl>
    </section>
  );
}
