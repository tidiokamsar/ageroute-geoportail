/**
 * Lanceur de l'API pour les tests de bout en bout. Lance par `webServer` (playwright.config.ts) avec le `tsx`
 * du backend, en passant `e2e/tsconfig.json` (alias `pg` et `argon2` vers `backend/node_modules`).
 *
 * Il fait deux choses, dans cet ordre, DANS LE MEME PROCESSUS (un seul processus a tuer a la fin) :
 *   1. recree la base `essai_e2e` depuis `replay` et y seme le jeu minimal (lib/donnees.ts) ;
 *   2. fixe l'environnement de l'API, se place dans un dossier temporaire (les photos televersees
 *      s'ecrivent dans `<cwd>/uploads/photos` : elles ne doivent pas salir `backend/`), puis charge
 *      `backend/src/server.ts` tel quel. Rien du code de l'application n'est copie ni modifie.
 *
 * Plafonds de debit : `/api/auth/login` a un plafond FIXE (10 par 15 min et par adresse, app.ts), qui n'est
 * pas reglable par variable. Les specs contournent cela sans toucher au serveur : chaque contexte de
 * navigateur annonce sa propre adresse dans `X-Forwarded-For` (le serveur fait confiance au premier proxy,
 * `trust proxy` = 1). Les deux plafonds reglables (`/auth/refresh`, `/api/v2`) sont desactives (0).
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { preparerBase } from "../lib/donnees";
import { DOSSIER_API, ORIGINE_BUILD, ORIGINE_WEB, PORT_API, RACINE_DEPOT } from "../lib/env";

async function main() {
  const d = await preparerBase();

  fs.rmSync(DOSSIER_API, { recursive: true, force: true });
  fs.mkdirSync(DOSSIER_API, { recursive: true });
  process.chdir(DOSSIER_API);

  Object.assign(process.env, {
    DATABASE_URL: d.urlBase,
    PORT: String(PORT_API),
    NODE_ENV: "development", // cookie de session non Secure (http), comme le dev local
    // Deux origines : Vite (projet dev) et le serveur statique du build (projet build). Le controle d'origine de /api/auth
    // (verifyOrigin) accepte une liste ; le POST same-origin du navigateur porte l'en-tete Origin de la page.
    CORS_ORIGIN: `${ORIGINE_WEB},${ORIGINE_BUILD}`,
    JWT_ACCESS_SECRET: d.secretAcces,
    JWT_REFRESH_SECRET: d.secretRafraichissement,
    JWT_ACCESS_EXPIRES_IN: "15m",
    JWT_REFRESH_EXPIRES_IN: "7d",
    RATE_LIMIT_REFRESH_MAX: "0",
    RATE_LIMIT_V2_MAX: "0",
    // Aucune integration sortante : INTEGRATIONS_SORTANTES_ACTIVES n'est pas defini.
  });

  // URL file:// : sous Windows, import() refuse un chemin absolu de type F:\.
  await import(pathToFileURL(path.join(RACINE_DEPOT, "backend", "src", "server.ts")).href);
}

main().catch((e) => {
  console.error("Lancement de l'API de test impossible :", e instanceof Error ? e.message : e);
  process.exit(1);
});
