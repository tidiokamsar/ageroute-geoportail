import type { ReactNode } from "react";
import { AlertCircle, Inbox, Loader2, Lock, RefreshCw } from "lucide-react";
import { Button } from "../../ui/Button";

/**
 * Etats obligatoires de chaque panneau du simulateur (contrat AD paragraphe 7) : chargement, vide, erreur, permission refusee.
 * Adaptes des composants du module Observation de la Terre. Une erreur n'est JAMAIS rendue comme un vide, et un refus de droit
 * (403) n'est ni un vide ni une panne : il a son propre message.
 */

export type GenreErreur = "permission" | "panne";

export interface ErreurSimulation { genre: GenreErreur; message: string }

/** Lit une erreur axios sans en deviner davantage : 403 = permission, le reste = panne, avec la phrase du serveur si elle existe. */
export function lireErreur(e: unknown, repli = "Réessayez dans un instant."): ErreurSimulation {
  const r = (e as { response?: { status?: number; data?: { error?: string } } } | null)?.response;
  if (r?.status === 403) return { genre: "permission", message: r.data?.error ?? "" };
  return { genre: "panne", message: r?.data?.error ?? (e instanceof Error && e.message ? e.message : repli) };
}

export function EtatChargement({ libelle }: { libelle: string }) {
  return (
    <p role="status" className="flex items-center gap-2 p-3 text-sm text-gray-700">
      <Loader2 aria-hidden="true" className="h-4 w-4 motion-safe:animate-spin" />
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

export function EtatPermission({ panneau, message }: { panneau: string; message?: string }) {
  return (
    <div role="status" data-etat="permission" className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
      <Lock aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <p>
        <strong>{panneau} : accès refusé.</strong>{" "}
        {message || "Votre rôle, vos modules (aide à la décision et programmation) ou votre périmètre territorial ne permettent pas cette action."}
      </p>
    </div>
  );
}

export function EtatErreur({ panneau, erreur, onReessayer, reessaiEnCours }: { panneau: string; erreur: ErreurSimulation; onReessayer?: () => void; reessaiEnCours?: boolean }) {
  if (erreur.genre === "permission") return <EtatPermission panneau={panneau} message={erreur.message} />;
  return (
    <div role="alert" data-etat="erreur" className="flex flex-wrap items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-950">
      <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="min-w-0 flex-1"><strong>{panneau} : l'opération a échoué.</strong> {erreur.message}</p>
      {onReessayer && (
        // Nom accessible unique par panneau, et qui commence par le libelle visible (WCAG 2.5.3).
        <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-0" aria-label={`Réessayer : ${panneau}`} disabled={reessaiEnCours} onClick={onReessayer}>
          <RefreshCw aria-hidden="true" className={reessaiEnCours ? "motion-safe:animate-spin" : ""} />
          Réessayer
        </Button>
      )}
    </div>
  );
}

/** Rappel permanent, en haut de chaque ecran du simulateur : une simulation n'engage rien. */
export function BandeauNonEngageant({ mention }: { mention: string }) {
  return (
    <p role="note" data-testid="mention-simulation" className="rounded-md border border-sky-300 bg-sky-50 p-2 text-sm font-semibold text-sky-950">
      {mention}
    </p>
  );
}
