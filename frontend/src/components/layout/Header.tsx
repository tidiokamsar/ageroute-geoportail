import { useState } from "react";
import { Link } from "react-router-dom";
import { KeyRound, ShieldCheck } from "lucide-react";
import { useAuth } from "../../lib/auth";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { GlobalSearch } from "./GlobalSearch";
import { SyncStatusBadge } from "./SyncStatusBadge";
import { useSessionLocaleOptionnelle } from "../../session/useSessionLocale";
import { DialogueDeconnexion } from "../session/DialogueDeconnexion";
import { PanneauSessionLocale } from "../session/PanneauSessionLocale";

export function Header({ title, onMenuClick }: { title: string; onMenuClick?: () => void }) {
  const { user, logout, logoutAll } = useAuth();
  // La deconnexion passe par un dialogue qui dit ce qui reste sur le telephone (rien n est efface). Hors fournisseur
  // de session locale (composant isole), le comportement d avant est conserve.
  const sessionLocale = useSessionLocaleOptionnelle();
  const [dialogue, setDialogue] = useState<"DECO" | "TOUS" | "PANNEAU" | null>(null);

  return (
    // Le titre de page n'est JAMAIS tronque (cahier AD paragraphe 4.2) : la hauteur est un minimum, l'en-tete passe a la
    // ligne plutot que de couper le titre ou de le faire disparaitre quand la place manque (mesure : « Aide a la de... »
    // a 1440 px, titre invisible a 768 et 375 px). La recherche, qui occupait 320 px, passe sur sa propre ligne de md a xl (elle reste disponible) ; les commandes de l'en-tete font 44 px de haut sous xl (cibles tactiles).
    <header className="no-print min-h-16 bg-white border-b border-gray-200 flex flex-wrap items-center justify-between px-4 md:px-6 py-2 gap-x-2 gap-y-1 md:gap-x-4">
      <div className="flex items-center gap-2 min-w-0 flex-1 basis-40">
        <button
          onClick={onMenuClick}
          className="md:hidden p-2 -ml-2 min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-navy hover:bg-gray-100 rounded shrink-0"
          aria-label="Ouvrir le menu"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <h2 className="text-base md:text-lg font-semibold text-navy leading-tight break-words">{title}</h2>
      </div>
      {user && (
        // La recherche reste disponible des md (le tiroir mobile n'a la sienne que sous md). Etroite et sur sa propre ligne (ordre du DOM = ordre visuel)
        // sous xl, pour ne jamais voler la place du titre ; 14 rem a xl, 20 rem a 2xl.
        <div className="hidden md:block md:basis-full xl:basis-auto xl:w-56 2xl:w-80 [&>div]:!w-full">
          <GlobalSearch />
        </div>
      )}
      {user && (
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 md:gap-3">
          <SyncStatusBadge />
          {sessionLocale && (
            <button
              type="button"
              onClick={() => setDialogue("PANNEAU")}
              title="Session locale : verrou, code PIN, données du téléphone"
              aria-label="Session locale"
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center p-2 text-gray-600 hover:text-navy hover:bg-gray-100 rounded-md transition-colors xl:min-h-0 xl:min-w-0"
            >
              <KeyRound className="h-4 w-4" />
            </button>
          )}
          <Link to="/securite" title="Sécurité du compte" aria-label="Sécurité du compte" className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center p-2 text-gray-600 hover:text-navy hover:bg-gray-100 rounded-md transition-colors xl:min-h-0 xl:min-w-0">
            <ShieldCheck className="h-4 w-4" />
          </Link>
          <span className="hidden xl:inline text-sm text-gray-600 truncate max-w-[140px]">{user.nomComplet}</span>
          <Badge>{user.role}</Badge>
          <Button
            variant="ghost"
            className="px-2 md:px-4 hidden lg:inline-flex min-h-[44px] xl:min-h-0"
            title="Déconnecter toutes les sessions, tous appareils"
            onClick={() => (sessionLocale ? setDialogue("TOUS") : void logoutAll())}
          >
            Tous appareils
          </Button>
          <Button variant="ghost" className="px-2 md:px-4 min-h-[44px] xl:min-h-0" onClick={() => (sessionLocale ? setDialogue("DECO") : void logout())}>
            <span className="hidden sm:inline">Déconnexion</span>
            <span className="sm:hidden">Quitter</span>
          </Button>
        </div>
      )}
      {sessionLocale && (
        <>
          <DialogueDeconnexion ouvert={dialogue === "DECO"} surFermer={() => setDialogue(null)} />
          <DialogueDeconnexion ouvert={dialogue === "TOUS"} surFermer={() => setDialogue(null)} tous />
          <PanneauSessionLocale ouvert={dialogue === "PANNEAU"} surFermer={() => setDialogue(null)} />
        </>
      )}
    </header>
  );
}
