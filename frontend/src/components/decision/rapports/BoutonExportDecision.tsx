import { useId } from "react";
import { useMutation } from "@tanstack/react-query";
import { Download, Loader2 } from "lucide-react";
import type { FiltresDecision } from "../types";
import { useAuth } from "../../../lib/auth";
import { corpsExport, definitionType, verdictExport, type FormatRapport, type TypeRapport } from "../../../lib/aideDecisionRapports";
import { erreurExport, exporterRapport, remettreFichier, type FichierExporte } from "../../../lib/aideDecisionRapportsApi";
import type { ErreurDecision } from "../../../lib/aideDecisionApi";
import { Button } from "../../ui/Button";

/**
 * Bouton « Exporter » de la page « Aide a la decision » (lot 6). Le shell (lot 1) le laisse desactive avec une raison ;
 * l'orchestrateur le remplace par `<BoutonExportDecision filtres={filtres} />`.
 *
 * - Les MEMES filtres que le reste de la page (AD-11) : le fichier porte le perimetre que l'ecran affiche.
 * - Desactive, il DIT POURQUOI en texte visible (un bouton `disabled` n'est pas focalisable : une info-bulle ne suffirait
 *   pas au clavier ni au lecteur d'ecran). Le serveur reverifie tout.
 * - Le fichier est recu par un appel authentifie (blob), jamais par un lien avec cle dans l'URL.
 * - Etats : en cours (`role="status"`), refus de droit (message dedie), erreur (`role="alert"`, avec le mot du serveur :
 *   « trop volumineux », « scenario introuvable »...), fichier remis (`role="status"`, nom, lignes, empreinte).
 */
export interface PropsBoutonExport {
  filtres: FiltresDecision;
  type?: TypeRapport;
  format?: FormatRapport;
  scenarioId?: string | null;
  libelle?: string;
  onRemis?: (f: FichierExporte) => void;
}

export function BoutonExportDecision({ filtres, type = "synthese", format = "csv", scenarioId = null, libelle = "Exporter", onRemis }: PropsBoutonExport) {
  const { user } = useAuth();
  const idRaison = useId();
  const verdict = verdictExport(user, type, filtres, scenarioId);

  const m = useMutation<FichierExporte, ErreurDecision & { code: string | null }>({
    mutationFn: async () => {
      try {
        return await exporterRapport(corpsExport(type, format, filtres, scenarioId));
      } catch (e) {
        throw await erreurExport(e);
      }
    },
    onSuccess: (f) => { remettreFichier(f); onRemis?.(f); },
  });

  const nom = `${libelle} : ${definitionType(type).libelle} (${format.toUpperCase()})`;
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button" variant="outline" className="min-h-[44px] xl:min-h-0"
        aria-label={nom} aria-describedby={!verdict.ok ? idRaison : undefined} aria-busy={m.isPending}
        disabled={!verdict.ok || m.isPending}
        onClick={() => m.mutate()}
      >
        {m.isPending ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Download aria-hidden="true" />}
        {m.isPending ? "Export en cours…" : libelle}
      </Button>
      {!verdict.ok && <p id={idRaison} data-etat="export-inactif" className="max-w-xs text-xs text-gray-700">{verdict.raison}</p>}
      {m.isPending && <p role="status" className="text-xs text-gray-700">Génération du fichier en cours.</p>}
      {m.isError && (
        m.error.genre === "permission"
          ? <p role="status" data-etat="permission" className="max-w-xs text-xs text-amber-900"><strong>Export refusé.</strong> {m.error.message}</p>
          : <p role="alert" data-etat="erreur" className="max-w-xs text-xs text-red-900"><strong>Export impossible.</strong> {m.error.message}</p>
      )}
      {m.isSuccess && (
        <p role="status" data-etat="remis" className="max-w-xs text-xs text-gray-800">
          Fichier remis : {m.data.nomFichier}
          {m.data.nbLignes !== null ? `, ${m.data.nbLignes} ligne${m.data.nbLignes > 1 ? "s" : ""}` : ""}
          {m.data.empreinteSha256 ? `, empreinte ${m.data.empreinteSha256.slice(0, 12)}…` : ""}. Export enregistré au journal.
        </p>
      )}
    </div>
  );
}
