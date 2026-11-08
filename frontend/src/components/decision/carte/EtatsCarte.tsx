import type { ReactNode } from "react";
import { AlertCircle, Inbox, Loader2, Lock, RefreshCw } from "lucide-react";
import type { ErreurAD } from "../../../lib/aideDecisionInterventions";
import { Button } from "../../ui/Button";

/**
 * Etats obligatoires de chaque panneau de la carte et de la liste (contrat paragraphe 7) : chargement, vide, erreur, permission refusee.
 * Une erreur n'est JAMAIS rendue comme un vide, et un compteur en erreur n'affiche pas zero. Composants copies sur ceux d'Observation de
 * la Terre (lecture seule), adaptes au type d'erreur de ce module.
 */

export function EtatChargement({ libelle }: { libelle: string }) {
  return (
    <p role="status" className="flex items-center gap-2 p-3 text-sm text-gray-700">
      <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
      {libelle}
    </p>
  );
}

export function EtatVide({ titre, detail }: { titre: string; detail?: ReactNode }) {
  return (
    <div data-etat="vide" className="flex flex-col items-center gap-1 rounded-md border border-dashed border-gray-300 p-4 text-center text-sm text-gray-700">
      <Inbox aria-hidden="true" className="h-5 w-5" />
      <p className="font-medium text-gray-800">{titre}</p>
      {detail && <p>{detail}</p>}
    </div>
  );
}

/** Refus de droit (403) : message dedie, ni un vide ni une panne. */
export function EtatPermission({ panneau, message }: { panneau: string; message?: string }) {
  return (
    <div role="status" data-etat="permission" className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <Lock aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <p>
        <strong>{panneau} : accès refusé.</strong>{" "}
        {message ?? "Votre rôle, vos modules ou votre périmètre territorial ne permettent pas de voir cette partie."}
      </p>
    </div>
  );
}

export function EtatErreur({ panneau, erreur, onReessayer, reessaiEnCours }: { panneau: string; erreur: ErreurAD; onReessayer?: () => void; reessaiEnCours?: boolean }) {
  if (erreur.genre === "permission") return <EtatPermission panneau={panneau} message={erreur.message} />;
  return (
    <div role="alert" data-etat="erreur" className="flex flex-wrap items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
      <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="min-w-0 flex-1">
        <strong>{panneau} : chargement impossible.</strong> {erreur.message}
      </p>
      {onReessayer && (
        // Nom accessible UNIQUE par panneau (plusieurs « Reessayer » sur un ecran ne se distinguent pas), et il COMMENCE par le libelle visible (WCAG 2.5.3).
        <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-0" aria-label={`Réessayer : ${panneau}`} disabled={reessaiEnCours} onClick={onReessayer}>
          <RefreshCw aria-hidden="true" className={reessaiEnCours ? "animate-spin" : ""} />
          Réessayer
        </Button>
      )}
    </div>
  );
}
