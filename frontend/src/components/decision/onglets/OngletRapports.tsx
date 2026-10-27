import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PropsOnglet } from "../types";
import { useAuth } from "../../../lib/auth";
import { classerErreurDecision } from "../../../lib/aideDecisionApi";
import { OPTIONS_RELANCE, lireRegionsApercu, lireScenariosExportables } from "../../../lib/aideDecisionRapportsApi";
import {
  LIBELLE_FORMAT, MENTION_CONSULTATIVE, TYPES_RAPPORT, definitionType, type FormatRapport, type TypeRapport,
} from "../../../lib/aideDecisionRapports";
import { BoutonExportDecision } from "../rapports/BoutonExportDecision";
import { ApercuRapport } from "../rapports/ApercuRapport";
import { JournalExports, CLE_JOURNAL_EXPORTS } from "../rapports/JournalExports";
import { RapportRegionsTable } from "../rapports/RapportRegionsTable";
import { EtatChargement, EtatErreur, EtatVide } from "../EtatsDecision";

/**
 * Onglet « Rapports » (lot 6) : choix du type de rapport, memes filtres que le reste de la page (AD-11), apercu des
 * parametres (periode, perimetre, sources, filtres non appliques), bouton Exporter (inactif AVEC sa raison), journal des
 * exports recents. Le serveur applique le perimetre territorial, le droit financier et le plafond ; ce composant n'en
 * decide rien. La mention « consultatif, non engageant » est toujours visible.
 */
export function OngletRapports({ filtres }: PropsOnglet) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const idType = useId();
  const [type, setType] = useState<TypeRapport>("reseau_regions");
  const [format, setFormat] = useState<FormatRapport>("csv");
  const [scenarioId, setScenarioId] = useState<string>("");
  const def = definitionType(type);

  const regions = useQuery({ queryKey: ["regions"], queryFn: lireRegionsApercu, staleTime: 10 * 60_000, ...OPTIONS_RELANCE });
  const nomRegion = filtres.regionId !== undefined ? (regions.data?.find((r) => r.id === filtres.regionId)?.nom ?? null) : null;

  const scenarios = useQuery({
    queryKey: ["aide-decision", "scenarios-exportables"],
    queryFn: lireScenariosExportables, enabled: def.necessiteScenario, staleTime: 60_000, ...OPTIONS_RELANCE,
  });
  const scenarioChoisi = scenarios.data?.find((s) => s.id === scenarioId) ?? null;

  return (
    <div className="space-y-4" data-onglet="rapports">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Rapports et exports</h2>
        <p role="note" data-mention="consultatif" className="mt-1 rounded-md border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900">{MENTION_CONSULTATIVE}</p>
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium text-gray-900">Type de rapport</legend>
        <div className="grid gap-2 md:grid-cols-2">
          {TYPES_RAPPORT.map((t) => (
            <label key={t.type} className={`flex min-h-[44px] cursor-pointer items-start gap-2 rounded-md border p-2 text-sm xl:min-h-0 ${t.type === type ? "border-blue-700 bg-blue-50" : "border-gray-200"}`}>
              <input type="radio" name={idType} value={t.type} checked={t.type === type} onChange={() => setType(t.type)} className="mt-1" />
              <span><span className="font-medium text-gray-900">{t.libelle}</span><br /><span className="text-gray-700">{t.description}</span></span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${idType}-format`} className="text-sm font-medium text-gray-900">Format du fichier</label>
          <select id={`${idType}-format`} value={format} onChange={(e) => setFormat(e.target.value as FormatRapport)} className="min-h-[44px] rounded-md border border-gray-300 bg-white px-2 text-sm xl:min-h-0">
            {(Object.keys(LIBELLE_FORMAT) as FormatRapport[]).map((f) => <option key={f} value={f}>{LIBELLE_FORMAT[f]}</option>)}
          </select>
          <span className="text-xs text-gray-700">PDF : non disponible (aucune bibliothèque de génération côté serveur).</span>
        </div>

        {def.necessiteScenario && (
          <div className="flex min-w-[16rem] flex-col gap-1">
            <label htmlFor={`${idType}-scenario`} className="text-sm font-medium text-gray-900">Scénario à exporter</label>
            {scenarios.isPending && <EtatChargement libelle="Chargement des scénarios…" panneau="liste des scénarios" onReessayer={() => void scenarios.refetch()} />}
            {scenarios.isError && <EtatErreur panneau="liste des scénarios" erreur={classerErreurDecision(scenarios.error)} onReessayer={() => void scenarios.refetch()} reessaiEnCours={scenarios.isFetching} />}
            {scenarios.isSuccess && scenarios.data.length === 0 && <EtatVide titre="Aucun scénario calculé" detail="Calculez un scénario dans l'onglet Simulation budgétaire, puis revenez l'exporter." />}
            {scenarios.isSuccess && scenarios.data.length > 0 && (
              <select id={`${idType}-scenario`} value={scenarioId} onChange={(e) => setScenarioId(e.target.value)} className="min-h-[44px] rounded-md border border-gray-300 bg-white px-2 text-sm xl:min-h-0">
                <option value="">Choisir un scénario…</option>
                {scenarios.data.map((s) => <option key={s.id} value={s.id}>{s.intitule} ({s.annee}{s.provisoire ? ", provisoire" : ""})</option>)}
              </select>
            )}
          </div>
        )}

        <BoutonExportDecision
          filtres={filtres} type={type} format={format} scenarioId={def.necessiteScenario ? (scenarioId || null) : null}
          onRemis={() => void qc.invalidateQueries({ queryKey: CLE_JOURNAL_EXPORTS })}
        />
      </div>

      <ApercuRapport type={type} filtres={filtres} compte={user} nomRegion={nomRegion} scenario={scenarioChoisi ? `${scenarioChoisi.intitule} (${scenarioChoisi.annee})` : null} />

      {type === "reseau_regions" && <RapportRegionsTable filtres={filtres} />}

      <JournalExports />
    </div>
  );
}
