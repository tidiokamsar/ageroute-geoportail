import { useState } from "react";
import { Outlet, useMatches, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";

export function AppLayout() {
  const matches = useMatches();
  const current = matches[matches.length - 1] as { handle?: { title?: string } } | undefined;
  const title = current?.handle?.title ?? "BDRI";
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();

  // Ferme le tiroir mobile a chaque changement de page (l'utilisateur a navigue).
  useEffect(() => setSidebarOpen(false), [location.pathname]);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0">
        <Header title={title} onMenuClick={() => setSidebarOpen(true)} />
        <main className="flex-1 overflow-y-auto bg-gray-50 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
