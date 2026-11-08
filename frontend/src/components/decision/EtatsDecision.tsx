import type { ReactNode } from "react";
import { AlertCircle, Inbox, Loader2, Lock, RefreshCw } from "lucide-react";
import type { ErreurDecision } from "../../lib/aideDecisionApi";
import { formaterDateHeure } from "../../lib/decision";
import { useDelaiDepasse } from "../../lib/aideDecisionHooks";
import { Button } from "../ui/Button";

/**
 * Etats obligatoires de chaque panneau (contrat paragraphe 7), adaptes de ceux du module Observation de la Terre :
 * chargement, vide, erreur, permission refusee, donnees perimees, reponse inattendue. Une erreur n'est JAMAIS rendue
 * comme un vide, et un panneau en erreur n'affiche pas zero : les appelants passent par ces composants.
 */

/**
 * Chargement : `role="status"`. Le squelette est BORNE dans le temps : passe `delaiMs`, le message dit que la reponse
 * tarde et propose de reessayer, au lieu de laisser croire a un chargement sans fin.
 */
export function EtatChargement({ libelle, panneau, onReessayer, delaiMs = 10_000 }: { libelle: string; panneau?: string; onReessayer?: () => void; delaiMs?: number }) {
  const long = useDelaiDepasse(true, delaiMs);
  return (
    <div role="status" data-etat={long ? "chargement-long" : "chargement"} className="flex flex-wrap items-center gap-2 p-3 text-sm text-gray-700">
      {!long && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
      <span>{long ? `${libelle.replace(/…$/, "")} : la réponse tarde plus que prévu.` : libelle}</span>
      {long && onReessayer && (
        <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-0" aria-label={`Réessayer : ${panneau ?? "chargement"}`} onClick={onReessayer}>
          <RefreshCw aria-hidden="true" />
          Réessayer
        </Button>
      )}
    </div>
  );
}

/** « indicateurs » (nom accessible du bouton) se lit « Indicateurs » en tete d'un message visible. */
const majuscule = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Vide explicite : « il n'y a rien dans ce perimetre », dit en mots, jamais un zero. */
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
        <strong>{majuscule(panneau)} : accès refusé.</strong>{" "}
        {message ?? "Votre rôle, vos modules ou votre périmètre territorial ne permettent pas de voir cette partie."}
      </p>
    </div>
  );
}

function BoutonReessayer({ panneau, onReessayer, enCours }: { panneau: string; onReessayer: () => void; enCours?: boolean }) {
  return (
    // Nom accessible UNIQUE par panneau (plusieurs « Reessayer » identiques sur un ecran ne se distinguent pas) et qui COMMENCE par le libelle visible (WCAG 2.5.3).
    <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-0" aria-label={`Réessayer : ${panneau}`} disabled={enCours} onClick={onReessayer}>
      <RefreshCw aria-hidden="true" className={enCours ? "animate-spin" : ""} />
      Réessayer
    </Button>
  );
}

/** Erreur d'API : `role="alert"` + « Reessayer ». Un refus de droit (403) prend le message dedie, sans « Reessayer ». */
export function EtatErreur({ panneau, erreur, onReessayer, reessaiEnCours }: { panneau: string; erreur: ErreurDecision; onReessayer?: () => void; reessaiEnCours?: boolean }) {
  if (erreur.genre === "permission") return <EtatPermission panneau={panneau} message={erreur.message} />;
  const titre = erreur.genre === "inattendue" ? "réponse inattendue" : "chargement impossible";
  return (
    <div role="alert" data-etat={erreur.genre === "inattendue" ? "inattendu" : "erreur"} className="flex flex-wrap items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
      <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="min-w-0 flex-1">
        <strong>{majuscule(panneau)} : {titre}.</strong> {erreur.message}
      </p>
      {onReessayer && <BoutonReessayer panneau={panneau} onReessayer={onReessayer} enCours={reessaiEnCours} />}
    </div>
  );
}

/** Une section de la reponse est presente mais sa forme n'est pas celle du contrat : le panneau le dit, les autres restent lisibles. */
export function EtatInattendu({ panneau, onReessayer }: { panneau: string; onReessayer?: () => void }) {
  return (
    <div role="alert" data-etat="inattendu" className="flex flex-wrap items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
      <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="min-w-0 flex-1">
        <strong>{majuscule(panneau)} : réponse inattendue.</strong> Cette partie de la réponse du serveur est absente ou mal formée ; aucune valeur n&apos;est affichée.
      </p>
      {onReessayer && <BoutonReessayer panneau={panneau} onReessayer={onReessayer} />}
    </div>
  );
}

/** Donnees affichees = derniere lecture reussie, alors que la lecture suivante a echoue. */
export function BandeauPerime({ panneau, misAJourLe, onReessayer, cause }: { panneau: string; misAJourLe: number; onReessayer?: () => void; cause?: string }) {
  return (
    <div role="status" data-etat="perime" className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {panneau} : l&apos;actualisation a échoué{cause ? ` (${cause})` : ""}, ces données datent du {formaterDateHeure(new Date(misAJourLe).toISOString())} et peuvent être périmées.
      </span>
      {onReessayer && (
        <Button type="button" size="sm" variant="ghost" className="min-h-[44px] xl:min-h-0" aria-label={`Actualiser : ${panneau}`} onClick={onReessayer}>
          Actualiser
        </Button>
      )}
    </div>
  );
}
