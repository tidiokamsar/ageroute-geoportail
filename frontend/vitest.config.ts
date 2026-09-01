import path from "path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Configuration distincte de vite.config.ts : les tests n'ont besoin ni du serveur
// de developpement ni du decoupage en chunks, et jsdom ne doit etre charge que la.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // Leaflet exige un vrai moteur de rendu : les composants de carte ne sont pas
    // testables sous jsdom. On teste donc la logique et les composants de
    // presentation, et la carte elle-meme reste couverte par les verifications
    // manuelles en navigateur.
    exclude: ["node_modules", "dist", "**/*.spec.ts"],
  },
});
