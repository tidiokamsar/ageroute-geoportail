// Liste canonique des modules configurables individuellement par utilisateur, en plus
// du rôle. Doit rester synchronisée avec backend/src/lib/modules.ts. "path" sert au
// garde-fou de route (ProtectedRoute) : toute URL commençant par ce préfixe est bloquée
// si le module n'est pas autorisé.
export const MODULES = [
  { key: "dashboard", label: "Tableau de bord", path: "/" },
  { key: "geoportail", label: "Géoportail", path: "/geoportail" },
  { key: "alertes", label: "Alertes", path: "/alertes" },
  { key: "rapports", label: "Rapports", path: "/rapports" },
  { key: "troncons", label: "Tronçons routiers", path: "/troncons" },
  { key: "ouvrages", label: "Ouvrages d'art", path: "/ouvrages" },
  { key: "points-noirs", label: "Points noirs", path: "/points-noirs" },
  { key: "postes", label: "Péages / Pesages", path: "/postes" },
  { key: "chantiers", label: "Chantiers", path: "/chantiers" },
  { key: "programmation", label: "Programmation budgétaire", path: "/programmation" },
  { key: "marches", label: "Marchés", path: "/marches" },
  { key: "inspections", label: "Inspections", path: "/inspections" },
  { key: "documents", label: "Base documentaire", path: "/documents" },
  { key: "decision", label: "Aide à la décision", path: "/decision" },
  { key: "ordres-travaux", label: "Ordres de travaux", path: "/ordres-travaux" },
  { key: "signalements", label: "Signalements citoyens", path: "/signalements" },
] as const;

export type ModuleKey = (typeof MODULES)[number]["key"];

// Vide = pas de restriction (accès à tout ce que le rôle autorise déjà, comportement
// historique). ADMIN n'est jamais restreint, quel que soit le contenu du tableau.
export function hasModuleAccess(
  modulesAutorises: string[] | undefined,
  role: string | undefined,
  moduleKey: string
): boolean {
  if (role === "ADMIN") return true;
  if (!modulesAutorises || modulesAutorises.length === 0) return true;
  return modulesAutorises.includes(moduleKey);
}

// Résout le module correspondant à un chemin de route (le plus long préfixe qui matche),
// pour le garde-fou de navigation. Retourne undefined pour les routes hors périmètre
// (login, utilisateurs, administration — gérées par le rôle uniquement).
export function moduleForPath(pathname: string): ModuleKey | undefined {
  if (pathname === "/") return "dashboard";
  const matches = MODULES.filter((m) => m.path !== "/" && (pathname === m.path || pathname.startsWith(`${m.path}/`)));
  if (matches.length === 0) return undefined;
  return matches.sort((a, b) => b.path.length - a.path.length)[0].key;
}
