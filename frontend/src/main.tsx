/// <reference types="vite/client" />
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

// Le worker n'est enregistre qu'en production : il precharge l'application d'apres
// `/precache-manifest.json`, genere par la CONSTRUCTION (vite-plugin-precache.ts). Le serveur de
// developpement n'a ni ce manifeste ni la revision gravee dans `sw.js`, et un worker de
// developpement qui met en cache gene le rechargement a chaud.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    // `updateViaCache: "none"` : par defaut le navigateur releve `sw.js` hors du cache HTTP mais
    // PAS `sw-policy.js` (importe), qui pourrait donc rester perime des jours sous l'en-tete
    // heuristique d'un serveur qui n'envoie pas de Cache-Control. Le worker et sa politique
    // doivent toujours etre revalides ensemble.
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then((registration) => {
      // L'enregistrement reussit meme quand l'INSTALLATION echoue (un fichier du precache
      // introuvable, un manifeste incoherent) : le worker devient alors "redundant". Sans cette
      // ecoute, l'agent decouvrirait en mission que rien n'est en cache.
      registration.addEventListener("updatefound", () => {
        const installation = registration.installing;
        installation?.addEventListener("statechange", () => {
          if (installation.state === "redundant") {
            console.warn(
              "Installation du service worker echouee : la nouvelle version n'est pas disponible hors ligne.",
            );
          }
        });
      });
    }).catch((err) => {
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
