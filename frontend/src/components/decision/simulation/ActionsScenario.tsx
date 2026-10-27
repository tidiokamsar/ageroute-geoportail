import { useId, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "../../ui/Button";
import { empreinteCourte, type VerdictExport } from "../../../lib/aideDecisionScenarios";
import { jourFr } from "../../../lib/tableauDeBord";
import { EtatErreur, type ErreurSimulation } from "./EtatsSimulation";

/**
 * Enregistrer un scenario sous un nom (auteur et date poses par le serveur, jamais saisis), puis l'exporter. L'export dit
 * « simulation non engageante » ; il n'est propose qu'une fois le scenario enregistre (l'export porte l'auteur, la date et les
 * empreintes d'un scenario scelle). Un scenario enregistre est immuable : seule une suppression logique est possible.
 */
export interface ScenarioEnregistre { id: string; intitule: string; creeLe: string; auteurNom: string | null; creeParId: string; empreinteResultat: string }

export function ActionsScenario({ peutEcrire, enregistre, onEnregistrer, enregistrement, erreurEnregistrement, onExporter, exportEnCours, erreurExport, droitExport, nomInitial = "" }: {
  peutEcrire: boolean; enregistre: ScenarioEnregistre | null; onEnregistrer: (nom: string) => void; enregistrement: boolean; erreurEnregistrement: ErreurSimulation | null;
  onExporter: (format: "csv" | "json") => void; exportEnCours: boolean; erreurExport: ErreurSimulation | null; droitExport: VerdictExport; nomInitial?: string;
}) {
  const idNom = useId();
  const [nom, setNom] = useState(nomInitial);
  const valide = nom.trim().length >= 3 && nom.trim().length <= 300;
  return (
    <section aria-labelledby="actions-titre" className="space-y-3 border-t pt-3" data-testid="actions-scenario">
      <h4 id="actions-titre" className="text-sm font-semibold text-navy">Enregistrer et exporter</h4>
      {enregistre === null && peutEcrire && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (valide) onEnregistrer(nom.trim()); }} aria-label="Enregistrer le scénario">
          <div>
            <label htmlFor={idNom} className="block text-xs text-gray-700">Nom du scénario (3 caractères au moins)</label>
            <input id={idNom} value={nom} maxLength={300} onChange={(e) => setNom(e.target.value)} aria-required="true" className="min-h-[44px] w-80 max-w-full rounded border px-2 py-1.5 text-sm xl:min-h-0" />
          </div>
          <Button type="submit" disabled={!valide || enregistrement} className="min-h-[44px] xl:min-h-0">{enregistrement ? "Enregistrement…" : "Enregistrer le scénario"}</Button>
        </form>
      )}
      {enregistre === null && !peutEcrire && <p className="text-sm text-gray-700">Enregistrer est réservé aux rôles administrateur et gestionnaire.</p>}
      {erreurEnregistrement && <EtatErreur panneau="Enregistrement du scénario" erreur={erreurEnregistrement} />}
      {enregistre && (
        <div role="status" data-testid="scenario-enregistre" className="rounded border border-green-300 bg-green-50 p-2 text-sm text-green-950">
          <p><strong>Scénario enregistré : {enregistre.intitule}.</strong> Auteur : {enregistre.auteurNom ?? `compte ${enregistre.creeParId}`} · le {jourFr(enregistre.creeLe)}.</p>
          <p className="text-xs">Empreinte du résultat (SHA-256) : <code className="break-all">{enregistre.empreinteResultat}</code> ({empreinteCourte(enregistre.empreinteResultat)}). Un scénario enregistré ne se modifie pas.</p>
        </div>
      )}
      {enregistre && droitExport.ok && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" className="min-h-[44px] xl:min-h-0" disabled={exportEnCours} onClick={() => onExporter("csv")}><Download aria-hidden="true" />Exporter en CSV</Button>
          <Button type="button" variant="outline" className="min-h-[44px] xl:min-h-0" disabled={exportEnCours} onClick={() => onExporter("json")}><Download aria-hidden="true" />Exporter en JSON</Button>
          <span className="text-xs text-gray-700">L'export porte la mention « simulation non engageante », la date, l'auteur, les versions et les avertissements.</span>
        </div>
      )}
      {enregistre && !droitExport.ok && <p role="note" data-testid="export-indisponible" className="text-sm text-gray-800">Export indisponible : {droitExport.raison}.</p>}
      {erreurExport && <EtatErreur panneau="Export du scénario" erreur={erreurExport} />}
    </section>
  );
}
