import { estErreurStockageLocal } from "../lib/compteCourant";

/**
 * Message a l'agent quand le stockage local (bases chiffrees par compte) refuse une lecture ou une ecriture.
 *
 * POURQUOI UN COMPOSANT A PART : l'erreur typee de `lib/compteCourant.ts` (STOCKAGE_PLEIN, TROP_DE_PHOTOS,
 * PHOTO_TROP_GROSSE, COFFRE_VERROUILLE, AUCUN_COMPTE...) porte deja un message en francais pret a afficher. Un toast
 * disparait en quelques secondes ; une saisie non enregistree doit rester dite tant que l'agent n'a pas agi. D'ou
 * une alerte (role="alert") fixe a l'ecran, que chaque page de saisie utilise de la meme facon.
 *
 * Renvoie `null` pour une erreur qui n'est pas une erreur typee du stockage : la page garde alors son propre message.
 *
 * `usage: "enregistrer"` : la saisie n'est PAS enregistree. Le coffre verrouille a alors un message d'action (le PIN).
 * Sans `usage` (lecture de la file, effacement...) : le message general de l'erreur typee, tel quel.
 */
export function messageStockageLocal(erreur: unknown, usage?: "enregistrer"): string | null {
  if (!estErreurStockageLocal(erreur)) return null;
  if (usage === "enregistrer" && erreur.code === "COFFRE_VERROUILLE") return "Déverrouillez avec votre PIN pour enregistrer.";
  return erreur.message;
}

export function AlerteStockageLocal({ message, className = "" }: { message: string | null | undefined; className?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className={`rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 ${className}`.trim()}>
      {message}
    </p>
  );
}
