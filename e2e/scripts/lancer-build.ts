/**
 * Lanceur du projet « build » : construit le frontend (`vite build`, dans un dossier temporaire) puis sert le resultat par
 * `serveur-statique.ts`. Lance par `webServer` ; Playwright attend `/precache-manifest.json`, qui n'existe qu'une fois la
 * construction terminee. Les lignes `[build]` vont sur la sortie d'erreur pour que l'avancement soit visible.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DOSSIER_BUILD, DOSSIER_RUN, FICHIER_SERVEUR_COUPE, RACINE_DEPOT } from "../lib/env";
import { demarrerServeurStatique } from "./serveur-statique";

async function main() {
  fs.mkdirSync(DOSSIER_RUN, { recursive: true });
  fs.rmSync(FICHIER_SERVEUR_COUPE, { force: true });
  const vite = path.join(RACINE_DEPOT, "frontend", "node_modules", "vite", "bin", "vite.js");
  const config = path.join(RACINE_DEPOT, "e2e", "vite.e2e.config.ts");
  const debut = Date.now();
  console.error("[build] vite build en cours...");
  const minuteur = setInterval(() => console.error(`[build] ... ${Math.round((Date.now() - debut) / 1000)} s`), 20_000);
  const code = await new Promise<number>((resolve) => {
    const p = spawn(process.execPath, [vite, "build", "--config", config], {
      cwd: path.join(RACINE_DEPOT, "frontend"), stdio: ["ignore", "inherit", "inherit"],
    });
    p.on("exit", (c) => resolve(c ?? 1));
  });
  clearInterval(minuteur);
  if (code !== 0) { console.error(`[build] ECHEC (code ${code})`); process.exit(1); }
  console.error(`[build] termine en ${Math.round((Date.now() - debut) / 1000)} s : ${DOSSIER_BUILD}`);
  demarrerServeurStatique();
}

main().catch((e) => { console.error("[build] impossible :", e instanceof Error ? e.message : e); process.exit(1); });
