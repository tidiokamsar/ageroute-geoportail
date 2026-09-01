import { Suspense, lazy } from "react";
import { createBrowserRouter, createRoutesFromElements, Route, RouterProvider } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { LoginPage } from "./pages/LoginPage";
import { Toaster } from "./components/ui/Toaster";

// Chargement paresseux : chaque page devient son propre chunk JS, telecharge uniquement
// a la premiere navigation vers cette route. Evite d'embarquer recharts/leaflet/jspdf
// (utilises seulement par quelques pages) dans le bundle initial charge au login.
const DashboardPage = lazy(() => import("./pages/DashboardPage").then((m) => ({ default: m.DashboardPage })));
const GeoportailPage = lazy(() => import("./pages/GeoportailPage").then((m) => ({ default: m.GeoportailPage })));
const EmbedCartePage = lazy(() => import("./pages/EmbedCartePage").then((m) => ({ default: m.EmbedCartePage })));
const TronconsPage = lazy(() => import("./pages/TronconsPage").then((m) => ({ default: m.TronconsPage })));
const OuvragesPage = lazy(() => import("./pages/OuvragesPage").then((m) => ({ default: m.OuvragesPage })));
const PointsNoirsPage = lazy(() => import("./pages/PointsNoirsPage").then((m) => ({ default: m.PointsNoirsPage })));
const PostesPage = lazy(() => import("./pages/PostesPage").then((m) => ({ default: m.PostesPage })));
const ChantiersPage = lazy(() => import("./pages/ChantiersPage").then((m) => ({ default: m.ChantiersPage })));
const InspectionsPage = lazy(() => import("./pages/InspectionsPage").then((m) => ({ default: m.InspectionsPage })));
const DocumentsPage = lazy(() => import("./pages/DocumentsPage").then((m) => ({ default: m.DocumentsPage })));
const AlertesPage = lazy(() => import("./pages/AlertesPage").then((m) => ({ default: m.AlertesPage })));
const RapportsPage = lazy(() => import("./pages/RapportsPage").then((m) => ({ default: m.RapportsPage })));
const ProgrammationPage = lazy(() => import("./pages/ProgrammationPage").then((m) => ({ default: m.ProgrammationPage })));
const DecisionPage = lazy(() => import("./pages/DecisionPage").then((m) => ({ default: m.DecisionPage })));
const MarchesPage = lazy(() => import("./pages/MarchesPage").then((m) => ({ default: m.MarchesPage })));
const InspectionTerrainPage = lazy(() => import("./pages/InspectionTerrainPage").then((m) => ({ default: m.InspectionTerrainPage })));
const RapportBailleurPage = lazy(() => import("./pages/RapportBailleurPage").then((m) => ({ default: m.RapportBailleurPage })));
const UsersPage = lazy(() => import("./pages/UsersPage").then((m) => ({ default: m.UsersPage })));
const SecuritePage = lazy(() => import("./pages/SecuritePage").then((m) => ({ default: m.SecuritePage })));
const AdministrationPage = lazy(() => import("./pages/AdministrationPage").then((m) => ({ default: m.AdministrationPage })));
const OrdresTravauxPage = lazy(() => import("./pages/OrdresTravauxPage").then((m) => ({ default: m.OrdresTravauxPage })));

function PageFallback() {
  return (
    <div className="flex items-center justify-center h-[60vh]">
      <div className="h-8 w-8 rounded-full border-2 border-navy/20 border-t-navy animate-spin" />
    </div>
  );
}

function LazyPage({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PageFallback />}>{children}</Suspense>;
}

// createBrowserRouter (data router) requis par useMatches() utilise dans AppLayout
// pour deriver le titre de page depuis route.handle — <BrowserRouter>+<Routes> classique
// ne suffit pas (useMatches leve "must be used within a data router").
const router = createBrowserRouter(
  createRoutesFromElements(
    <>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/embed/carte" element={<LazyPage><EmbedCartePage /></LazyPage>} />
      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route index element={<LazyPage><DashboardPage /></LazyPage>} handle={{ title: "Tableau de bord" }} />
          <Route path="geoportail" element={<LazyPage><GeoportailPage /></LazyPage>} handle={{ title: "Géoportail" }} />
          <Route path="alertes" element={<LazyPage><AlertesPage /></LazyPage>} handle={{ title: "Alertes" }} />
          <Route path="rapports" element={<LazyPage><RapportsPage /></LazyPage>} handle={{ title: "Rapports" }} />
          <Route path="rapports/bailleur" element={<LazyPage><RapportBailleurPage /></LazyPage>} handle={{ title: "Rapport bailleur" }} />
          <Route path="troncons" element={<LazyPage><TronconsPage /></LazyPage>} handle={{ title: "Tronçons routiers" }} />
          <Route path="ouvrages" element={<LazyPage><OuvragesPage /></LazyPage>} handle={{ title: "Ouvrages d'art" }} />
          <Route path="points-noirs" element={<LazyPage><PointsNoirsPage /></LazyPage>} handle={{ title: "Points noirs" }} />
          <Route path="postes" element={<LazyPage><PostesPage /></LazyPage>} handle={{ title: "Péages / Pesages" }} />
          <Route path="chantiers" element={<LazyPage><ChantiersPage /></LazyPage>} handle={{ title: "Chantiers" }} />
          <Route path="programmation" element={<LazyPage><ProgrammationPage /></LazyPage>} handle={{ title: "Programmation budgétaire" }} />
          <Route path="marches" element={<LazyPage><MarchesPage /></LazyPage>} handle={{ title: "Marchés" }} />
          <Route path="inspections" element={<LazyPage><InspectionsPage /></LazyPage>} handle={{ title: "Inspections" }} />
          <Route path="inspections/terrain" element={<LazyPage><InspectionTerrainPage /></LazyPage>} handle={{ title: "Inspection terrain" }} />
          <Route path="documents" element={<LazyPage><DocumentsPage /></LazyPage>} handle={{ title: "Base documentaire" }} />
          <Route path="decision" element={<LazyPage><DecisionPage /></LazyPage>} handle={{ title: "Aide à la décision" }} />
          <Route path="ordres-travaux" element={<LazyPage><OrdresTravauxPage /></LazyPage>} handle={{ title: "Ordres de travaux" }} />
          <Route path="securite" element={<LazyPage><SecuritePage /></LazyPage>} handle={{ title: "Sécurité du compte" }} />
        </Route>
      </Route>
      <Route element={<ProtectedRoute roles={["ADMIN"]} />}>
        <Route element={<AppLayout />}>
          <Route path="utilisateurs" element={<LazyPage><UsersPage /></LazyPage>} handle={{ title: "Utilisateurs" }} />
          <Route path="administration" element={<LazyPage><AdministrationPage /></LazyPage>} handle={{ title: "Administration" }} />
        </Route>
      </Route>
    </>
  )
);

export function App() {
  return (
    <>
      <RouterProvider router={router} />
      <Toaster />
    </>
  );
}
