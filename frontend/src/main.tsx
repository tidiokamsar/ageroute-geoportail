import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "./lib/auth";
import { App } from "./App";
import { startOfflineSync } from "./lib/offlineSync";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

startOfflineSync();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      // L'APPLICATION RESTE UTILISABLE, MAIS PLUS HORS LIGNE.
      //
      // L'echec etait silencieux : un worker qui ne s'enregistre pas laissait l'application
      // fonctionner en apparence, et c'est en mission, sans couverture, que l'agent
      // decouvrait que ni la carte ni l'enveloppe n'etaient en cache. Personne ne pouvait
      // le savoir avant.
      //
      // On ne montre rien a l'utilisateur — il n'y a rien qu'il puisse faire — mais la
      // console garde la raison, ce qui suffit a diagnostiquer un appareil rapporte.
      console.warn(
        "Service worker non enregistre : le mode hors ligne est indisponible sur cet appareil.",
        err,
      );
    });
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>
);
