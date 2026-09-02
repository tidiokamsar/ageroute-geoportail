import { Link } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import { useAuth } from "../../lib/auth";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { GlobalSearch } from "./GlobalSearch";
import { SyncStatusBadge } from "./SyncStatusBadge";
import { useConfirm } from "../../hooks/useConfirm";

export function Header({ title, onMenuClick }: { title: string; onMenuClick?: () => void }) {
  const { user, logout, logoutAll } = useAuth();
  const { confirm } = useConfirm();

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
          <Link to="/securite" title="Sécurité du compte" className="p-2 text-gray-400 hover:text-navy hover:bg-gray-100 rounded-md transition-colors">
            <ShieldCheck className="h-4 w-4" />
          </Link>
          <span className="hidden sm:inline text-sm text-gray-600 truncate max-w-[140px]">{user.nomComplet}</span>
          <Badge>{user.role}</Badge>
          <Button
            variant="ghost"
            className="px-2 md:px-4 hidden lg:inline-flex"
            title="Déconnecter toutes les sessions, tous appareils"
            onClick={async () => {
              const ok = await confirm(
                "Toutes vos sessions seront révoquées, y compris sur les autres navigateurs. Vous devrez vous reconnecter partout.",
                { title: "Déconnecter tous les appareils ?", danger: true }
              );
              if (ok) await logoutAll();
            }}
          >
            Tous appareils
          </Button>
          <Button variant="ghost" className="px-2 md:px-4" onClick={() => logout()}>
            <span className="hidden sm:inline">Déconnexion</span>
            <span className="sm:hidden">Quitter</span>
          </Button>
        </div>
      )}
    </header>
  );
}
