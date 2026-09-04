import { NavLink } from "react-router-dom";
import clsx from "clsx";
import { useAuth } from "../../lib/auth";
import { hasModuleAccess, moduleForPath } from "../../lib/modules";

const sections = [
  {
    title: "PILOTAGE",
    items: [
      { to: "/", label: "Tableau de bord" },
      { to: "/geoportail", label: "Géoportail" },
      { to: "/alertes", label: "Alertes" },
      { to: "/rapports", label: "Rapports" },
      { to: "/rapports/bailleur", label: "Rapport bailleur" },
      { to: "/decision", label: "Aide à la décision" },
      { to: "/qualite", label: "Qualité des données" },
    ],
  },
  {
    title: "PATRIMOINE",
    items: [
      { to: "/troncons", label: "Tronçons routiers" },
      { to: "/ouvrages", label: "Ouvrages d'art" },
      { to: "/points-noirs", label: "Points noirs" },
      { to: "/postes", label: "Péages / Pesages" },
    ],
  },
  {
    title: "TRAVAUX",
    items: [
      { to: "/chantiers", label: "Chantiers" },
      { to: "/ordres-travaux", label: "Ordres de travaux" },
      { to: "/marches", label: "Marchés" },
      { to: "/programmation", label: "Programmation" },
      { to: "/inspections", label: "Inspections" },
    ],
  },
  {
    title: "DOCUMENTATION",
    items: [{ to: "/documents", label: "Base documentaire" }],
  },
];

export function Sidebar({ open = false, onClose }: { open?: boolean; onClose?: () => void }) {
  const { user } = useAuth();

  const filteredSections = sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        const key = moduleForPath(item.to);
        return !key || hasModuleAccess(user?.modulesAutorises, user?.role, key);
      }),
    }))
    .filter((section) => section.items.length > 0);

  const visibleSections =
    user?.role === "ADMIN"
      ? [...filteredSections, { title: "ADMINISTRATION", items: [
          { to: "/utilisateurs", label: "Utilisateurs" },
          { to: "/administration", label: "Paramètres" },
        ] }]
      : filteredSections;

  return (
    <>
      {/* Fond cliquable pour fermer le tiroir sur mobile */}
      {open && <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={onClose} />}
      <aside
        className={clsx(
          "no-print fixed md:static inset-y-0 left-0 z-40 w-64 bg-navy text-white flex flex-col h-screen transform transition-transform md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
      <div className="px-5 py-6 border-b border-white/10 flex items-center gap-2.5">
        <img src="/ageroute-logo.svg" alt="AGEROUTE" className="h-9 w-auto bg-white rounded p-0.5" />
        <div>
          <h1 className="text-base font-bold leading-tight">BDRI</h1>
          <p className="text-xs text-white/60 mt-0.5">AGEROUTE Guinée</p>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto py-4">
        {visibleSections.map((section) => (
          <div key={section.title} className="mb-5">
            <p className="px-5 mb-2 text-[10px] font-bold tracking-wider text-white/40">{section.title}</p>
            {section.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  clsx(
                    "block px-5 py-2 text-sm transition border-l-2",
                    isActive
                      ? "bg-navy2 border-gold text-white font-medium"
                      : "border-transparent text-white/70 hover:bg-navy2/60 hover:text-white"
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      </aside>
    </>
  );
}
