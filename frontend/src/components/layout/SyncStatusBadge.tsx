import { Link } from "react-router-dom";
import { CloudOff, RefreshCw, CloudUpload, Lock, ShieldAlert, OctagonX } from "lucide-react";
import { useOfflineSync } from "../../hooks/useOfflineSync";

/**
 * Etat de la synchronisation, dans l'en-tete de toutes les pages. Plusieurs pastilles peuvent se montrer ensemble, chacune pour UNE chose :
 *   - envoi ARRETE (appareil retire, compte inactif) : rien ne part, le bandeau (BandeauSynchronisation) dit quoi faire ;
 *   - « Verrouillé » : la session locale est verrouillee, la file n'est pas lisible (les compteurs, eux, se lisent sans cle) ;
 *   - le compteur « à synchroniser » / « Hors-ligne » (avec la part en conflit) ;
 *   - « refusées (droits) » : saisies que le serveur a refusees parce que les droits ont change. A part des erreurs, et PAS dans le
 *     compteur d'envoi : elles ne partent pas toutes seules. Un lien mene au panneau qui permet de les renvoyer.
 */

/** Page qui porte le panneau des saisies refusees pour droits (ObservationsTerrainPage). */
export const LIEN_REFUS_DROITS = "/inspections/terrain/observations#refus-droits";

export function SyncStatusBadge() {
  const {
    pendingCount, conflitCount = 0, refusDroitsCount = 0, syncing, online, syncNow,
    fileVerrouillee = false, appareilRevoque = false, compteInactif = false,
  } = useOfflineSync();
  const arretee = appareilRevoque || compteInactif;
  // Un conflit n'est pas une panne : il attend un responsable. Le dire dans le badge, partout dans l'application.
  const mentionConflit = conflitCount > 0 ? ` · dont ${conflitCount} en conflit` : "";
  // La quarantaine pour droits est comptee dans le total de la file mais ne part pas : elle a sa pastille, et sort du « à synchroniser ».
  const aEnvoyer = Math.max(0, pendingCount - refusDroitsCount);

  const pastilles: JSX.Element[] = [];

  if (arretee) {
    pastilles.push(
      <span
        key="arret"
        className="inline-flex items-center gap-1.5 rounded-full bg-red-100 text-red-800 px-2.5 py-1 text-xs font-medium"
        title={appareilRevoque ? "Cet appareil a été retiré par l'administration : l'envoi est arrêté." : "Votre compte est désactivé ou verrouillé : l'envoi est arrêté."}
      >
        <OctagonX className="h-3.5 w-3.5" aria-hidden="true" />
        {appareilRevoque ? "Appareil retiré" : "Compte inactif"} · envoi arrêté
      </span>,
    );
  }

  if (fileVerrouillee) {
    pastilles.push(
      <span
        key="verrou"
        className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 text-gray-700 px-2.5 py-1 text-xs font-medium"
        title="Session locale verrouillée : saisissez votre code PIN pour ouvrir les saisies de ce téléphone."
      >
        <Lock className="h-3.5 w-3.5" aria-hidden="true" />
        Verrouillé
      </span>,
    );
  }

  if (!online) {
    pastilles.push(
      <span key="compteur" className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 text-amber-700 px-2.5 py-1 text-xs font-medium">
        <CloudOff className="h-3.5 w-3.5" aria-hidden="true" />
        Hors-ligne{aEnvoyer > 0 && ` · ${aEnvoyer} en attente${mentionConflit}`}
      </span>,
    );
  } else if (arretee && aEnvoyer > 0) {
    // Le bouton « synchroniser » ne ferait rien : l'envoi est arrete. Le compte reste visible.
    pastilles.push(
      <span key="compteur" className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 text-gray-700 px-2.5 py-1 text-xs font-medium">
        {aEnvoyer} en attente{mentionConflit}
      </span>,
    );
  } else if (aEnvoyer > 0 || syncing) {
    pastilles.push(
      <button
        key="compteur"
        type="button"
        // Geste de l'agent : il reessaie l'enregistrement de l'appareil meme pendant un delai de revocation recente.
        onClick={() => void syncNow({ manuel: true })}
        disabled={syncing}
        className="inline-flex items-center gap-1.5 rounded-full bg-blue-100 text-blue-700 px-2.5 py-1 text-xs font-medium hover:bg-blue-200 transition-colors disabled:opacity-70"
        title="Synchroniser les saisies terrain en attente"
      >
        {syncing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <CloudUpload className="h-3.5 w-3.5" aria-hidden="true" />}
        {syncing ? "Synchronisation…" : `${aEnvoyer} à synchroniser${mentionConflit}`}
      </button>,
    );
  }

  if (refusDroitsCount > 0) {
    pastilles.push(
      <Link
        key="refus-droits"
        to={LIEN_REFUS_DROITS}
        className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 text-amber-900 px-2.5 py-1 text-xs font-medium hover:bg-amber-200 transition-colors"
        title="Saisies refusées parce que vos droits ont changé : elles sont conservées sur ce téléphone et ne partent pas toutes seules. Ouvrir pour les renvoyer."
      >
        <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
        {refusDroitsCount} {refusDroitsCount >= 2 ? "refusées" : "refusée"} (droits)
      </Link>,
    );
  }

  if (pastilles.length === 0) return null;
  if (pastilles.length === 1) return pastilles[0];
  return <span className="inline-flex flex-wrap items-center gap-1.5">{pastilles}</span>;
}
