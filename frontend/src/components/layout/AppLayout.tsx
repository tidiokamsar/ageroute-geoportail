import { useState } from "react";
import { Outlet, useMatches, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { useAuth } from "../../lib/auth";
import { routeDisponibleHorsLigne, useSessionLocaleOptionnelle } from "../../session/useSessionLocale";
import { BandeauSession } from "../session/BandeauSession";
import { BandeauSynchronisation } from "../session/BandeauSynchronisation";
import { IndisponibleHorsLigne } from "../session/IndisponibleHorsLigne";
import { configurerUtilisateurSync, refreshPendingCount, syncPendingOfflineData } from "../../lib/offlineSync";

export function AppLayout() {
  const matches = useMatches();
  const current = matches[matches.length - 1] as { handle?: { title?: string } } | undefined;
  const title = current?.handle?.title ?? "BDRI";
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();
  const { user } = useAuth();
  // Hors ligne, seules les routes qui utilisent la file locale fonctionnent : les autres disent qu il faut le reseau.
  const horsLigne = useSessionLocaleOptionnelle()?.session.horsLigne === true;
  const indisponible = horsLigne && !routeDisponibleHorsLigne(location.pathname);

  // Ferme le tiroir mobile a chaque changement de page (l'utilisateur a navigue).
  useEffect(() => setSidebarOpen(false), [location.pathname]);

  useEffect(() => {
    configurerUtilisateurSync(user?.id ?? null);
    if (user) void refreshPendingCount().then(() => syncPendingOfflineData());
    return () => configurerUtilisateurSync(null);
  }, [user?.id]);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0">
        <Header title={title} onMenuClick={() => setSidebarOpen(true)} />
        <BandeauSession />
        <BandeauSynchronisation />
        <main className="flex-1 overflow-y-auto bg-gray-50 p-4 md:p-6">
          {indisponible ? <IndisponibleHorsLigne /> : <Outlet />}
        </main>
      </div>
    </div>
  );
}
