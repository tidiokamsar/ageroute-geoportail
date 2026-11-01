import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { precachePlugin } from "./vite-plugin-precache";

export default defineConfig({
  // `precachePlugin` n'agit qu'a la construction (apply: "build") : le serveur de developpement
  // et les essais de bout en bout (e2e/vite.e2e.config.ts reprend cette liste) ne sont pas touches.
  plugins: [react(), precachePlugin()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: 5173,
    proxy: {
      // Proxy vers le backend local UNIQUEMENT : ne jamais pointer le dev vers la
      // production, sinon toute session de development ecrit dans la base reelle.
      "/api": { target: "http://localhost:4000", changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Isole les grosses dependances tierces dans des chunks dedies : elles ne
        // changent quasiment jamais, donc restent en cache navigateur d'un deploiement
        // a l'autre meme quand seul le code applicatif change.
        //
        // `recharts` et `jspdf`/`html2canvas` n'ont PAS de chunk manuel (retires le 23/10/2026).
        // Avec `charts` et `pdf` nommes ici, Rollup les rattachait au chunk d'entree comme
        // dependances statiques : la carte publique (/carte), servie a des visiteurs en 3G, telechargeait
        // 278 Ko gzip de graphiques et de PDF dont elle ne se sert pas (mesure : docs/performance/
        // MESURES-A15-A20.md). Laisses a Rollup, ils ne sont charges que par les pages qui les importent.
        manualChunks: {
          maps: ["leaflet", "react-leaflet", "react-leaflet-cluster"],
          "react-vendor": ["react", "react-dom", "react-router-dom"],
        },
      },
    },
  },
});
