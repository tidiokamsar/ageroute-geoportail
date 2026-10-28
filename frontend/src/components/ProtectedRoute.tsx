import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { ShieldAlert } from "lucide-react";
import { useAuth } from "../lib/auth";
import { hasModuleAccess, moduleForPath } from "../lib/modules";
import { routeUtiliseLaFile, useSessionLocaleOptionnelle } from "../session/useSessionLocale";
import { ConfigurationPin } from "./session/ConfigurationPin";
import { EcranDeverrouillage } from "./session/EcranDeverrouillage";
import { Button } from "./ui/Button";
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

/** Attributs qui retirent un sous-arbre de l'affichage, du clavier et des lecteurs d'ecran sans le demonter. */
const MASQUE = { "aria-hidden": true, inert: "", style: { visibility: "hidden" as const } };

/**
 * `ouvertAuxDelegants` : la route reste accessible a un compte qui porte le droit de
 * designer un validateur (`peutDeleguerValidation`), meme sans role de la liste. Sert
 * uniquement a `/gouvernance`, dont les routes serveur (delegations.controller.ts) exigent
 * « ADMIN ou peutDeleguerValidation » : la Direction Technique est GESTIONNAIRE, voyait le
 * lien du menu et etait renvoyee vers « / ». Ne jamais l'activer pour une route que le
 * serveur reserve au role.
 *
 * SESSION LOCALE (docs/securite/SESSION-HORS-LIGNE.md). La route ne montre jamais un contenu sensible a une session
 * verrouillee :
 *   - hors ligne et verrouille, ou compte a choisir, ou session expiree : l'ecran correspondant, sur TOUTES les routes ;
 *   - sur une route qui utilise la file locale (`routeUtiliseLaFile`) : creation du PIN s'il n'existe pas, deverrouillage
 *     s'il est verrouille. Sur les autres routes, un coffre verrouille ne gene pas (carte, tableaux restent utilisables en
 *     ligne) ; l'agent peut demander le deverrouillage depuis le bandeau.
 * Le contenu n'est PAS demonte pendant un verrou : il est cache (inert, invisible, hors lecteurs d'ecran). Demonter la page
 * arreterait un releve de roulage en cours et perdrait une saisie commencee ; la cle, elle, est deja oubliee.
 * C'est un MASQUAGE, pas une purge : texte, valeurs de champs et donnees deja dechiffrees restent dans le DOM et la memoire (voir
 * SESSION-HORS-LIGNE.md, section 3). Les portails sous `body` (un dialogue Radix ouvert au moment du verrou) sont masques par
 * l'ecran de verrouillage lui-meme (`masquerHorsDe`), car ils sont hors de l'arbre que cette route controle.
 */
export function ProtectedRoute({ roles, ouvertAuxDelegants = false }: { roles?: Role[]; ouvertAuxDelegants?: boolean }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const sl = useSessionLocaleOptionnelle();

  if (loading) return <div className="h-screen flex items-center justify-center text-gray-400">Chargement...</div>;

  const session = sl?.session ?? null;
  const surLaFile = routeUtiliseLaFile(location.pathname);
  const retour = () => navigate("/");

  // Ce qui remplace le contenu. `null` : rien, le contenu s'affiche.
  let ecran: JSX.Element | null = null;
  if (session) {
    if (session.ecran !== "AUCUN") {
      ecran = <EcranDeverrouillage />;
    } else if (user && session.etat === "EN_LIGNE" && session.coffrePresent && !session.deverrouille && (surLaFile || session.deverrouillageDemande)) {
      ecran = <EcranDeverrouillage retour={retour} />;
    } else if (user && session.pinACreer && surLaFile) {
      ecran = (
        <div className="fixed inset-0 z-40 overflow-y-auto bg-gray-50">
          <div className="mx-auto max-w-lg px-4 pt-4">
            <Button type="button" variant="ghost" size="sm" onClick={retour}>← Retour au tableau de bord</Button>
          </div>
          <ConfigurationPin />
        </div>
      );
    }
  }

  // Visiteur non connecte : la racine du domaine ouvre la carte publique en lecture
  // seule plutot que le formulaire de connexion — carte.ageroute.gov.gn doit montrer
  // le geoportail a tout le monde. Un lien profond vers un module reste renvoye vers
  // /login, ou l'utilisateur se connecte avec son compte pour acceder au reste.
  if (!user) {
    if (ecran) return ecran;
    // Session locale OUVERTE hors ligne : une coupure n'est jamais une deconnexion. L'identite se reconstruit du profil du coffre
    // (ControleurSession.deverrouiller) ; si un rendu la voit un instant absente (defaut E2E-5), on attend au lieu de renvoyer vers
    // /login. Seule une session FERMEE (refus 401/403 du serveur, deconnexion) ou un depart voulu (« Aller a la connexion », etat
    // verrouille sans ecran) mene a la connexion.
    if (session?.etat === "HORS_LIGNE_OUVERT") return <div className="h-screen flex items-center justify-center text-gray-400">Chargement...</div>;
    return <Navigate to={location.pathname === "/" ? "/carte" : "/login"} replace />;
  }
  const delegantAutorise = ouvertAuxDelegants && user.peutDeleguerValidation === true;
  if (roles && !roles.includes(user.role) && !delegantAutorise) return <Navigate to="/" replace />;

  const moduleKey = moduleForPath(location.pathname);
  if (moduleKey && !hasModuleAccess(user.modulesAutorises, user.role, moduleKey)) {
    return <ModuleAccessDenied />;
  }

  return (
    <>
      <div {...(ecran ? MASQUE : {})}>
        <Outlet />
      </div>
      {ecran}
    </>
  );
}
