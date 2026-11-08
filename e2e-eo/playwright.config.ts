import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { DOSSIER_SORTIES, ORIGINE_API, ORIGINE_WEB, RACINE_DEPOT } from "./lib/env";

/**
 * Tests de bout en bout de l'Observation de la Terre : l'ecran REEL (`frontend/src`, servi par Vite) contre l'API REELLE
 * (`backend/src`, port 3401) et la base REELLE (PostGIS, clone jetable `essai_eo_e2e` de `essai_eo_workflow`), dans un Chromium reel.
 *
 * Lancement, depuis `frontend/` (c'est la que vit `@playwright/test`, par la jonction de node_modules) :
 *   cd frontend && npx playwright test --config ../e2e-eo/playwright.config.ts
 * Details : docs/observation-terre/E2E.md.
 *
 * Un seul worker : toutes les specs partagent la base et se suivent dans l'ordre des fichiers (les decisions de l'une sont l'etat de l'autre :
 * chaque spec relit ce qu'elle attend EN BASE, elle ne suppose pas de constante).
 */
const tsx = path.join(RACINE_DEPOT, "backend", "node_modules", "tsx", "dist", "cli.mjs");
const vite = path.join(RACINE_DEPOT, "frontend", "node_modules", "vite", "bin", "vite.js");
// Les journaux des serveurs (une ligne par requete) noient la sortie : silence par defaut, `E2E_LOGS=1` pour les voir.
const sortieServeur: "pipe" | "ignore" = process.env.E2E_LOGS ? "pipe" : "ignore";

export default defineConfig({
  testDir: path.join(__dirname, "specs"),
  testMatch: "**/*.spec.ts",
  outputDir: path.join(DOSSIER_SORTIES, "resultats"),
  reporter: [["list"]],
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  globalSetup: path.join(__dirname, "global-setup.ts"),
  globalTeardown: path.join(__dirname, "global-teardown.ts"),

  use: {
    locale: "fr-FR",
    timezoneId: "Africa/Conakry",
    viewport: { width: 1440, height: 900 },
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, baseURL: ORIGINE_WEB, serviceWorkers: "block" } },
  ],

  webServer: [
    {
      // Prepare la base (clone + ADMIN + regions) PUIS lance l'API, dans un seul processus.
      command: `node "${tsx}" --tsconfig tsconfig.json scripts/lancer-api.ts`,
      cwd: __dirname,
      url: `${ORIGINE_API}/api/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: sortieServeur,
      stderr: "pipe",
    },
    {
      command: `node "${vite}" --config "${path.join(__dirname, "vite.eo.config.ts")}"`,
      cwd: path.join(RACINE_DEPOT, "frontend"),
      url: ORIGINE_WEB,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: sortieServeur,
      stderr: "pipe",
    },
  ],
});
