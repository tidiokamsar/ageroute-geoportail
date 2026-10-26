import type { ReactNode } from "react";
import { AlertCircle, Inbox, Loader2, Lock, RefreshCw } from "lucide-react";
import type { ErreurTd } from "../../lib/teledetectionApi";
import { formaterDateHeure } from "../../lib/teledetectionAffichage";
import { Button } from "../ui/Button";

/**
 * Etats obligatoires de chaque panneau (contrat paragraphe 7) : chargement, vide, erreur, permission
 * refusee, donnees perimees. Une erreur n'est JAMAIS rendue comme un vide, et un compteur en erreur
 * n'affiche pas zero : les appelants passent par ces composants plutot que par un « 0 ».
 */

export function EtatChargement({ libelle }: { libelle: string }) {
  return (
    <p role="status" className="flex items-center gap-2 p-3 text-sm text-gray-600">
      <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
      {libelle}
    </p>
  );
}

export function EtatVide({ titre, detail }: { titre: string; detail?: ReactNode }) {
  return (
    <div data-etat="vide" className="flex flex-col items-center gap-1 rounded-md border border-dashed border-gray-300 p-4 text-center text-sm text-gray-600">
      <Inbox aria-hidden="true" className="h-5 w-5" />
      <p className="font-medium text-gray-700">{titre}</p>
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

export function EtatErreur({ panneau, erreur, onReessayer, reessaiEnCours }: { panneau: string; erreur: ErreurTd; onReessayer?: () => void; reessaiEnCours?: boolean }) {
  if (erreur.genre === "permission") return <EtatPermission panneau={panneau} message={erreur.message} />;
  return (
    <div role="alert" data-etat="erreur" className="flex flex-wrap items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
      <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="min-w-0 flex-1">
        <strong>{panneau} : chargement impossible.</strong> {erreur.message}
      </p>
      {onReessayer && (
        // Nom accessible UNIQUE par panneau (4 « Reessayer » identiques sur un ecran ne se distinguent pas), et il COMMENCE par le libelle visible (WCAG 2.5.3).
        <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-0" aria-label={`Réessayer : ${panneau}`} disabled={reessaiEnCours} onClick={onReessayer}>
          <RefreshCw aria-hidden="true" className={reessaiEnCours ? "animate-spin" : ""} />
          Réessayer
        </Button>
      )}
    </div>
  );
}

/** Donnees affichees = derniere lecture reussie, alors que la lecture suivante a echoue. */
export function BandeauPerime({ panneau, misAJourLe, onReessayer }: { panneau: string; misAJourLe: number; onReessayer?: () => void }) {
  return (
    <div role="status" data-etat="perime" className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {panneau} : l'actualisation a échoué, ces données datent du {formaterDateHeure(new Date(misAJourLe).toISOString())} et peuvent être périmées.
      </span>
      {onReessayer && <Button type="button" size="sm" variant="ghost" className="min-h-[44px] xl:min-h-0" aria-label={`Actualiser : ${panneau}`} onClick={onReessayer}>Actualiser</Button>}
    </div>
  );
}
