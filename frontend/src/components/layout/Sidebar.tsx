import { useEffect } from "react";
import { NavLink } from "react-router-dom";
import clsx from "clsx";
import { useAuth } from "../../lib/auth";
import { GlobalSearch } from "./GlobalSearch";
import { hasModuleAccess, moduleForPath } from "../../lib/modules";

const sections = [
  {
    title: "PILOTAGE",
    items: [
      { to: "/", label: "Tableau de bord" },
      { to: "/control-tower", label: "Control Tower" },
      { to: "/geoportail", label: "Géoportail" },
      { to: "/alertes", label: "Alertes" },
      { to: "/rapports", label: "Rapports" },
      { to: "/rapports/bailleur", label: "Rapport bailleur" },
      { to: "/decision", label: "Aide à la décision" },
      { to: "/administration/baremes", label: "Barèmes de coût", roles: ["ADMIN", "GESTIONNAIRE"] },
      { to: "/qualite", label: "Qualité des données" },
    ],
  },
  {
    title: "PATRIMOINE",
    items: [
      { to: "/troncons", label: "Tronçons routiers" },
      { to: "/troncons/audit", label: "Audit du référentiel" },
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
      { to: "/programmation/moteur", label: "Moteur de programmation", roles: ["ADMIN", "GESTIONNAIRE"] },
      { to: "/inspections", label: "Inspections" },
      { to: "/inspections/missions", label: "Missions terrain" },
      { to: "/inspections/defauts/registre", label: "Registre des défauts" },
      { to: "/inspections/defauts/validation", label: "Validation des relevés", roles: ["ADMIN", "GESTIONNAIRE"] },
      { to: "/inspections/a-controler", label: "Points à contrôler", roles: ["ADMIN", "GESTIONNAIRE"] },
      // Route ouverte a tout compte connecte (App.tsx) : pas de filtre de role ici non plus. Seul lien
      // jusque-la : la carte « Portions validees » du tableau de bord.
      { to: "/portions/validation", label: "Validation des portions" },
      { to: "/inspections/conflits", label: "Conflits de synchronisation", roles: ["ADMIN", "GESTIONNAIRE"] },
      { to: "/inspections/defauts/catalogue", label: "Catalogue des défauts", roles: ["ADMIN", "GESTIONNAIRE"] },
      { to: "/imports", label: "Lots d'import", roles: ["ADMIN", "GESTIONNAIRE"] },
    ],
  },
  {
    title: "RELEVÉ TERRAIN",
    items: [
      { to: "/inspections/releve/enregistrer", label: "Enregistrer en roulant" },
      { to: "/inspections/releve/envoyes", label: "Relevés envoyés" },
      { to: "/inspections/releve", label: "Relevé en véhicule" },
      { to: "/inspections/terrain", label: "Inspection terrain" },
      { to: "/inspections/terrain/defauts", label: "Défauts terrain" },
      { to: "/inspections/terrain/portions", label: "Portions terrain" },
      { to: "/portions/gestion", label: "Gestion des portions" },
      { to: "/inspections/terrain/observations", label: "Observations terrain" },
    ],
  },
  {
    title: "EXPLOITATION",
    items: [
      { to: "/exploitation/main-courante", label: "Main courante" },
      { to: "/veille", label: "Cellule de veille" },
      { to: "/exploitation/patrouilles", label: "Patrouilles" },
      { to: "/exploitation/info-route", label: "Info Route et bulletin" },
      { to: "/teledetection", label: "Observation de la Terre" },
      { to: "/veille/configuration", label: "Configuration de la veille", roles: ["ADMIN", "GESTIONNAIRE"] },
    ],
  },
  {
    title: "DOCUMENTATION",
    items: [{ to: "/documents", label: "Base documentaire" }],
  },
];

export function Sidebar({ open = false, onClose }: { open?: boolean; onClose?: () => void }) {
  const { user } = useAuth();

  // Le tiroir mobile se fermait a la souris seulement (clic sur le fond). Echap le ferme aussi :
  // c'est l'equivalent clavier qu'exige le paragraphe 7.11 (WCAG 2.1.1, clavier).
  useEffect(() => {
    if (!open || !onClose) return;
    const surTouche = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", surTouche);
    return () => window.removeEventListener("keydown", surTouche);
  }, [open, onClose]);

  const filteredSections = sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        if ("roles" in item && item.roles && !item.roles.includes(user?.role ?? "LECTEUR")) return false;
        const key = moduleForPath(item.to);
        return !key || hasModuleAccess(user?.modulesAutorises, user?.role, key);
      }),
    }))
    .filter((section) => section.items.length > 0);

  /**
   * L'ecran de designation n'est PAS reserve a ADMIN.
   *
   * AGEROUTE a confie la designation des validateurs a la Direction Technique, qui n'est
   * pas administrateur de la plateforme. Le gater sur le role reviendrait a refuser cette
   * decision — c'est pourquoi le droit est porte par le compte (`peutDeleguerValidation`)
   * et non par le role : six profils sur onze sont GESTIONNAIRE.
   */
  const administration = [
    { to: "/utilisateurs", label: "Utilisateurs" },
    { to: "/administration", label: "Paramètres" },
  ];
  const peutDesigner = user?.role === "ADMIN" || user?.peutDeleguerValidation === true;
  const itemsAdministration = [
    ...(user?.role === "ADMIN" ? administration : []),
    ...(peutDesigner ? [{ to: "/gouvernance", label: "Validateurs" }] : []),
  ];

  const visibleSections = itemsAdministration.length > 0
    ? [...filteredSections, { title: "ADMINISTRATION", items: itemsAdministration }]
    : filteredSections;

  const tousLesLiens = visibleSections.flatMap((s) => s.items.map((i) => i.to));

  return (
    <>
      {/* Fond cliquable pour fermer le tiroir sur mobile. Raccourci souris : l'equivalent
          clavier est Echap (effet ci-dessus). Le fond est masque aux lecteurs d'ecran. */}
      {open && <div aria-hidden="true" className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={onClose} />}
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
      {/* Sur telephone, la recherche globale de l'en-tete est masquee (md:) : le tiroir
          est le seul endroit ou elle existe. Sans lui, chercher exigerait un ordinateur. */}
      <div className="md:hidden px-4 pt-3">
        <GlobalSearch />
      </div>
      <nav className="flex-1 overflow-y-auto py-4">
        {visibleSections.map((section) => (
          <div key={section.title} className="mb-5">
            <p className="px-5 mb-2 text-[10px] font-bold tracking-wider text-white/60">{section.title}</p>
            {section.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                // Correspondance exacte quand un autre element du menu est SOUS cette adresse :
                // sans cela, /veille reste surligne sur /veille/configuration, et deux entrees
                // paraissent actives a la fois.
                end={tousLesLiens.some((t) => t !== item.to && t.startsWith(`${item.to}/`))}
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
