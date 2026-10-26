/**
 * Lanceur de l'API pour les tests de bout en bout de l'Observation de la Terre. Lance par `webServer` (playwright.config.ts) avec
 * le `tsx` du backend, en passant `e2e-eo/tsconfig.json` (alias `pg` et `argon2` vers `backend/node_modules`).
 *
 * Il fait deux choses, dans cet ordre, DANS LE MEME PROCESSUS (un seul processus a tuer a la fin) :
 *   1. recree la base `essai_eo_e2e` depuis `essai_eo_workflow` et y seme l'ADMIN et deux regions (lib/donnees.ts) ;
 *   2. fixe l'environnement de l'API, se place dans un dossier temporaire, puis charge `backend/src/server.ts` du worktree tel quel.
 *      Rien du code de l'application n'est copie ni modifie.
 *
 * Plafonds de debit : `/api/auth/login` a un plafond FIXE (10 par 15 min et par adresse, app.ts), qui n'est pas reglable par variable.
 * Les specs le contournent sans toucher au serveur : chaque contexte de navigateur annonce sa propre adresse dans `X-Forwarded-For`
 * (le serveur fait confiance au premier proxy, `trust proxy` = 1). Les deux plafonds reglables (`/auth/refresh`, `/api/v2`) sont
 * desactives (0) par variable d'environnement.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { preparerBase } from "../lib/donnees";
import { DOSSIER_API, ORIGINE_WEB, PORT_API, RACINE_DEPOT } from "../lib/env";

async function main() {
  const d = await preparerBase();

  // Sous Windows, le dossier d'un lancement precedent peut rester verrouille un instant (processus en train de mourir, antivirus) : EPERM.
  // On retente, puis on se rabat sur un dossier unique plutot que d'echouer.
  let dossier = DOSSIER_API;
  for (let essai = 1; ; essai++) {
    try { fs.rmSync(DOSSIER_API, { recursive: true, force: true }); break; } catch (e) {
      if (essai >= 5) { dossier = `${DOSSIER_API}-${process.pid}`; break; }
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  fs.mkdirSync(dossier, { recursive: true });
  process.chdir(dossier);

  Object.assign(process.env, {
    DATABASE_URL: d.urlBase,
    PORT: String(PORT_API),
    NODE_ENV: "development", // cookie de session non Secure (http), comme le dev local
    CORS_ORIGIN: ORIGINE_WEB,
    JWT_ACCESS_SECRET: d.secretAcces,
    JWT_REFRESH_SECRET: d.secretRafraichissement,
    JWT_ACCESS_EXPIRES_IN: "15m",
    JWT_REFRESH_EXPIRES_IN: "7d",
    RATE_LIMIT_REFRESH_MAX: "0",
    RATE_LIMIT_V2_MAX: "0",
    // Aucune integration sortante : INTEGRATIONS_SORTANTES_ACTIVES n'est pas defini. Aucune variable CDSE_* : la recherche de
    // catalogue est anonyme (docs/observation-terre/SOURCES.md, section 11).
  });

  // URL file:// : sous Windows, import() refuse un chemin absolu de type F:\.
  await import(pathToFileURL(path.join(RACINE_DEPOT, "backend", "src", "server.ts")).href);
}

main().catch((e) => {
  console.error("Lancement de l'API de test impossible :", e instanceof Error ? e.message : e);
  process.exit(1);
});
