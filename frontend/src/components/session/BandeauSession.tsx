import { Lock, WifiOff } from "lucide-react";
import { NON_VERIFIABLE_HORS_LIGNE, useSessionLocaleOptionnelle } from "../../session/useSessionLocale";
import { Button } from "../ui/Button";

/**
 * Bandeau permanent de la session locale (conception : SESSION-HORS-LIGNE.md, section 9).
 *  - hors ligne : « Mode hors ligne : vos droits seront revérifiés à la reconnexion », avec ce qui ne peut pas l'être ;
 *  - droits changés : la session locale est invalidée, le code la renouvelle ;
 *  - en ligne, coffre verrouille : rappel discret, le deverrouillage n'est exige que sur les routes de la file locale ;
 *  - saisies d'un autre compte en attente sur ce telephone (nombre seulement, jamais de contenu).
 * Rend `null` hors fournisseur ou quand il n'y a rien a dire.
 */
export function BandeauSession() {
  const s = useSessionLocaleOptionnelle();
  if (!s) return null;
  const { session, controleur } = s;

  const messages: JSX.Element[] = [];

  if (session.horsLigne) {
    messages.push(
      <div key="hors-ligne" role="status" className="flex items-start gap-2 bg-amber-100 px-4 py-2 text-sm text-amber-900">
        <WifiOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-medium">Mode hors ligne : vos droits seront revérifiés à la reconnexion.</p>
          <details className="text-xs">
            <summary className="cursor-pointer py-0.5">Ce qui ne peut pas être vérifié hors ligne</summary>
            <ul className="ml-4 list-disc">
              {NON_VERIFIABLE_HORS_LIGNE.map((t) => <li key={t}>{t}</li>)}
            </ul>
          </details>
        </div>
      </div>,
    );
  } else if (session.droitsAReverifier && session.etat === "EN_LIGNE") {
    messages.push(
      <div key="droits" role="alert" className="flex items-center justify-between gap-2 bg-amber-100 px-4 py-2 text-sm text-amber-900">
        <p>Vos droits ont changé sur le serveur : la session locale a été invalidée. Saisissez votre code PIN pour la renouveler.</p>
        <Button type="button" size="sm" variant="outline" onClick={() => controleur.demanderDeverrouillage()}>Renouveler</Button>
      </div>,
    );
  } else if (session.etat === "EN_LIGNE" && session.coffrePresent && !session.deverrouille) {
    messages.push(
      <div key="verrou" role="status" className="flex items-center justify-between gap-2 bg-gray-100 px-4 py-1.5 text-xs text-gray-700">
        <p className="flex items-center gap-1"><Lock className="h-3.5 w-3.5" aria-hidden="true" /> Session terrain verrouillée.</p>
        <Button type="button" size="sm" variant="ghost" onClick={() => controleur.demanderDeverrouillage()}>Déverrouiller</Button>
      </div>,
    );
  }

  if (session.autresComptes.comptes > 0) {
    messages.push(
      <p key="autres" role="status" className="bg-gray-100 px-4 py-1 text-xs text-gray-700">
        Des saisies d'un autre compte sont en attente sur ce téléphone. Elles ne sont pas visibles avec votre compte.
      </p>,
    );
  }

  if (messages.length === 0) return null;
  return <div className="no-print">{messages}</div>;
}
