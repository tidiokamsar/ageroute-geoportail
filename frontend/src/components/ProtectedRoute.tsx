import { Navigate, Outlet, useLocation } from "react-router-dom";
import { ShieldAlert } from "lucide-react";
import { useAuth } from "../lib/auth";
import { hasModuleAccess, moduleForPath } from "../lib/modules";
import type { Role } from "../types";

function ModuleAccessDenied() {
  const { logout } = useAuth();
  return (
    <div className="h-screen flex flex-col items-center justify-center gap-3 text-center px-6">
      <ShieldAlert className="h-10 w-10 text-amber-500" />
      <h1 className="text-lg font-bold text-navy">Accès non autorisé</h1>
      <p className="text-sm text-gray-500 max-w-sm">
        Votre compte n'a pas accès à ce module. Contactez un administrateur si vous pensez qu'il s'agit d'une erreur.
      </p>
      <button onClick={() => logout()} className="text-sm text-navy underline mt-2">Se déconnecter</button>
    </div>
  );
}

export function ProtectedRoute({ roles }: { roles?: Role[] }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <div className="h-screen flex items-center justify-center text-gray-400">Chargement...</div>;
  // Visiteur non connecte : la racine du domaine ouvre la carte publique en lecture
  // seule plutot que le formulaire de connexion — carte.ageroute.gov.gn doit montrer
  // le geoportail a tout le monde. Un lien profond vers un module reste renvoye vers
  // /login, ou l'utilisateur se connecte avec son compte pour acceder au reste.
  if (!user) return <Navigate to={location.pathname === "/" ? "/carte" : "/login"} replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;

  const moduleKey = moduleForPath(location.pathname);
  if (moduleKey && !hasModuleAccess(user.modulesAutorises, user.role, moduleKey)) {
    return <ModuleAccessDenied />;
  }

  return <Outlet />;
}
