/**
 * Configuration de Vite pour les tests de bout en bout : celle du frontend (`frontend/vite.config.ts`,
 * inchangee), avec peu de surcharges :
 *   - serveur de developpement (projet « dev ») : le port, l'adresse d'ecoute, la cible du proxy `/api` (l'API de test sur le
 *     port 3101, jamais le 4000 du developpement, jamais la production) et le dossier de cache ;
 *   - construction (projet « build », `vite build --config ...`) : le dossier de sortie, dans le dossier temporaire du poste
 *     (jamais `frontend/dist`). Le plugin de precache (vite-plugin-precache.ts) grave la revision dans le `sw.js` de ce dossier.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import base from "../frontend/vite.config";

const PORT_WEB = 5201;
const PORT_API = 3101;
// Nom long (realpath) : sous Windows, os.tmpdir() rend un nom court 8.3 que Vite compare mal aux chemins reels.
const TEMP = fs.realpathSync.native(os.tmpdir());

export default {
  ...base,
  root: path.resolve(__dirname, "..", "frontend"),
  // Hors de `frontend/node_modules/.vite` : la pile de test ne partage pas son cache avec un serveur de developpement.
  cacheDir: path.join(TEMP, "bdri-e2e", "vite-cache"),
  build: {
    ...base.build,
    outDir: path.join(TEMP, "bdri-e2e", "build"),
    emptyOutDir: true,
    // Pas de carte des sources : elles ne servent a rien ici et ralentissent la construction.
    sourcemap: false,
  },
  server: {
    ...base.server,
    host: "127.0.0.1",
    port: PORT_WEB,
    strictPort: true,
    // Pas de rechargement a chaud : sa websocket tombe avec la coupure reseau simulee, et le client Vite recharge alors la page
    // au retour du reseau, ce qui efface l'etat que les tests observent (et ne ressemble pas a un telephone en production).
    hmr: false,
    proxy: {
      "/api": { target: `http://127.0.0.1:${PORT_API}`, changeOrigin: true },
    },
  },
};
