/**
 * Configuration de Vite pour les tests de bout en bout : celle du frontend du worktree (`frontend/vite.config.ts`, inchangee), avec
 * peu de surcharges : le port, l'adresse d'ecoute, la cible du proxy `/api` (l'API de test sur le port 3401, jamais le 4000 du
 * developpement, jamais la production) et un dossier de cache hors du depot. Rechargement a chaud desactive (sa websocket tombe
 * quand l'API est arretee en cours d'ecran, et le client Vite recharge alors la page : cela effacerait l'etat que les tests observent).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import base from "../frontend/vite.config";

const PORT_WEB = 5410;
const PORT_API = 3401;
const TEMP = fs.realpathSync.native(os.tmpdir());

export default {
  ...base,
  root: path.resolve(__dirname, "..", "frontend"),
  cacheDir: path.join(TEMP, "bdri-eo-e2e", "vite-cache"),
  server: {
    ...base.server,
    host: "127.0.0.1",
    port: PORT_WEB,
    strictPort: true,
    hmr: false,
    // `frontend/node_modules` est une jonction vers le depot principal dans ce worktree : Vite resout les paquets par leur chemin
    // reel (hors de la racine) et refuserait de les servir. On autorise la racine du worktree et ce depot principal.
    fs: { strict: false },
    proxy: {
      "/api": { target: `http://127.0.0.1:${PORT_API}`, changeOrigin: true },
    },
  },
};
