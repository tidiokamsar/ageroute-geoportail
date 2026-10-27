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
    <header className="no-print h-16 bg-white border-b border-gray-200 flex items-center justify-between px-4 md:px-6 gap-2 md:gap-4">
      <div className="flex items-center gap-2 min-w-0">
        <button
          onClick={onMenuClick}
          className="md:hidden p-2 -ml-2 text-navy hover:bg-gray-100 rounded shrink-0"
          aria-label="Ouvrir le menu"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <h2 className="text-base md:text-lg font-semibold text-navy truncate">{title}</h2>
      </div>
      {user && (
        <div className="hidden md:block">
          <GlobalSearch />
        </div>
      )}
      {user && (
        <div className="flex items-center gap-2 md:gap-3 shrink-0">
          <SyncStatusBadge />
          {sessionLocale && (
            <button
              type="button"
              onClick={() => setDialogue("PANNEAU")}
              title="Session locale : verrou, code PIN, données du téléphone"
              aria-label="Session locale"
              className="p-2 text-gray-600 hover:text-navy hover:bg-gray-100 rounded-md transition-colors"
            >
              <KeyRound className="h-4 w-4" />
            </button>
          )}
          <Link to="/securite" title="Sécurité du compte" className="p-2 text-gray-500 hover:text-navy hover:bg-gray-100 rounded-md transition-colors">
            <ShieldCheck className="h-4 w-4" />
          </Link>
          <span className="hidden sm:inline text-sm text-gray-600 truncate max-w-[140px]">{user.nomComplet}</span>
          <Badge>{user.role}</Badge>
          <Button
            variant="ghost"
            className="px-2 md:px-4 hidden lg:inline-flex"
            title="Déconnecter toutes les sessions, tous appareils"
            onClick={() => (sessionLocale ? setDialogue("TOUS") : void logoutAll())}
          >
            Tous appareils
          </Button>
          <Button variant="ghost" className="px-2 md:px-4" onClick={() => (sessionLocale ? setDialogue("DECO") : void logout())}>
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
