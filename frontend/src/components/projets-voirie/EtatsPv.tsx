import type { ReactNode } from "react";
import { AlertCircle, Inbox, Loader2, Lock, RefreshCw, SearchX, WifiOff } from "lucide-react";
import { Button } from "../ui/Button";
import type { ErreurPv } from "../../lib/projetsVoirie";

/**
 * Etats obligatoires du module : chargement, vide, erreur, refus de droit (403), introuvable (404), hors ligne.
 * Une erreur n'est JAMAIS rendue comme un vide, et un compteur en erreur n'affiche pas zero.
 */

export function EtatChargement({ libelle }: { libelle: string }) {
  return (
    <p role="status" className="flex items-center gap-2 p-3 text-sm text-gray-600">
      <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
      {libelle}
    </p>
  );
}

export function EtatVide({ titre, children }: { titre: string; children?: ReactNode }) {
  return (
    <div data-etat="vide" className="flex flex-col items-center gap-1 rounded-md border border-dashed border-gray-300 bg-white p-5 text-center text-sm text-gray-600">
      <Inbox aria-hidden="true" className="h-6 w-6" />
      <p className="font-medium text-gray-700">{titre}</p>
      {children && <div className="max-w-prose space-y-1">{children}</div>}
    </div>
  );
}

/** Bandeau « ce module a besoin du reseau » : les donnees de concessionnaires ne sont jamais conservees hors ligne. */
export function BandeauHorsLigne() {
  return (
    <div role="alert" data-etat="hors-ligne" className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <WifiOff aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <p>
        <strong>Vous êtes hors ligne.</strong> Ce module a besoin du réseau : les tracés des concessionnaires sont des données sensibles, ils ne sont jamais
        conservés sur cet appareil. Rien de nouveau ne peut être chargé ni enregistré tant que la connexion n&apos;est pas revenue.
      </p>
    </div>
  );
}

export function EtatErreur({ erreur, sujet, onReessayer, enCours }: { erreur: ErreurPv; sujet: string; onReessayer?: () => void; enCours?: boolean }) {
  if (erreur.genre === "permission") {
    return (
      <div role="alert" data-etat="permission" className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <Lock aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          <strong>Accès refusé.</strong> Votre compte n&apos;a pas la clé de module « Projets de voirie ». Demandez à un administrateur de l&apos;ajouter à votre
          compte (page Utilisateurs), puis rechargez cette page.
        </p>
      </div>
    );
  }
  if (erreur.genre === "introuvable") {
    return (
      <div role="alert" data-etat="introuvable" className="flex items-start gap-2 rounded-md border border-gray-300 bg-white p-3 text-sm text-gray-800">
        <SearchX aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <p><strong>{sujet} : introuvable.</strong> Il n&apos;existe pas, ou il a été retiré. Revenez à la liste des projets.</p>
      </div>
    );
  }
  const titre = erreur.genre === "reseau" ? "Réseau indisponible" : "Chargement impossible";
  return (
    <div role="alert" data-etat={erreur.genre === "reseau" ? "reseau" : "erreur"} className="flex flex-wrap items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
      <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="min-w-0 flex-1"><strong>{sujet} : {titre.toLowerCase()}.</strong> {erreur.message}</p>
      {onReessayer && (
        <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-0" aria-label={`Réessayer : ${sujet}`} disabled={enCours} onClick={onReessayer}>
          <RefreshCw aria-hidden="true" className={enCours ? "animate-spin" : ""} />
          Réessayer
        </Button>
      )}
    </div>
  );
}
