import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
        manualChunks: {
          charts: ["recharts"],
          maps: ["leaflet", "react-leaflet", "react-leaflet-cluster"],
          pdf: ["jspdf", "html2canvas"],
          "react-vendor": ["react", "react-dom", "react-router-dom"],
        },
      },
    },
  },
});
