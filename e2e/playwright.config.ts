import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { DOSSIER_SORTIES, FACTEUR_DELAI, ORIGINE_API, ORIGINE_BUILD, ORIGINE_WEB, RACINE_DEPOT } from "./lib/env";

/**
 * Tests de bout en bout dans un navigateur reel (Chromium), contre une pile locale jetable :
 *   - base PostgreSQL/PostGIS `essai_e2e`, clone de `replay` (conteneur `bdri-dev-db`) ;
 *   - API sur le port 3101 (le code de `backend/src`, tel quel) ;
 *   - projet « dev » : Vite sur le port 5201 (le code de `frontend/src`, tel quel), proxy `/api` vers 3101, service worker BLOQUE ;
 *   - projet « build » : `vite build` dans un dossier temporaire, servi sur le port 5301 par un serveur statique qui reproduit
 *     nginx.conf (scripts/serveur-statique.ts), service worker ACTIF. Il ne porte que les scenarios marques `@froid` de
 *     session-hors-ligne.cible.spec.ts : ceux qui exigent une reouverture a froid sans serveur.
 * Le code est celui de l'arbre de travail (modifications non commitees comprises).
 *
 * Lancement : `npm run test:e2e` depuis `frontend/`. Un seul projet : `npm run test:e2e -- --project=dev` (le build n'est alors
 * ni construit ni servi). Details : docs/e2e/README.md.
 *
 * Un seul worker : toutes les specs partagent une base ; chaque spec isole ses donnees par un marqueur unique
 * dans la description de ce qu'elle saisit, et par une adresse IP annoncee distincte (limiteur de connexion).
 */
const tsx = path.join(RACINE_DEPOT, "backend", "node_modules", "tsx", "dist", "cli.mjs");
const vite = path.join(RACINE_DEPOT, "frontend", "node_modules", "vite", "bin", "vite.js");
// Les journaux des serveurs (une ligne par requete) noient la sortie : silence par defaut, `E2E_LOGS=1` pour les voir.
const sortieServeur: "pipe" | "ignore" = process.env.E2E_LOGS ? "pipe" : "ignore";

/** Noms de projet demandes par `--project`, ou `null` (tous). Sert seulement a ne pas construire un build qui ne sera pas utilise. */
function projetsDemandes(): string[] | null {
  const noms: string[] = [];
  const a = process.argv;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--project" && a[i + 1]) noms.push(a[i + 1]);
    else if (a[i].startsWith("--project=")) noms.push(a[i].slice("--project=".length));
  }
  return noms.length > 0 ? noms : null;
}
// Confort de mise au point : `E2E_REUTILISER=1` reutilise une pile deja lancee (voir docs/e2e/README.md). Sans effet par defaut.
const reutiliser = Boolean(process.env.E2E_REUTILISER);
const demandes = projetsDemandes();
const avecBuild = !process.env.E2E_SANS_BUILD && (demandes === null || demandes.includes("build"));
const avecDev = demandes === null || demandes.includes("dev");
// Transmis au globalSetup (meme processus) : inutile de prechauffer Vite s'il n'est pas lance.
process.env.E2E_AVEC_DEV = avecDev ? "1" : "0";

export default defineConfig({
  testDir: __dirname,
  testMatch: "**/*.spec.ts",
  // Sorties (traces des echecs, captures) hors du depot, dans le dossier temporaire du poste.
  outputDir: path.join(DOSSIER_SORTIES, "resultats"),
  // Pas de rapport HTML : un rapport est un artefact, il n'a pas sa place dans le depot.
  reporter: [["list"]],
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // Large a dessein : fermer puis rouvrir un profil Chromium prend de 4 a 20 s sur ce poste, davantage quand d'autres travaux le chargent,
  // et chaque deverrouillage derive la cle du code PIN (PBKDF2, 600 000 iterations).
  timeout: 240_000 * FACTEUR_DELAI,
  expect: { timeout: 30_000 * FACTEUR_DELAI },
  globalSetup: path.join(__dirname, "global-setup.ts"),
  globalTeardown: path.join(__dirname, "global-teardown.ts"),

  use: {
    locale: "fr-FR",
    timezoneId: "Africa/Conakry",
    viewport: { width: 1280, height: 800 },
    actionTimeout: 30_000 * FACTEUR_DELAI,
    navigationTimeout: 60_000 * FACTEUR_DELAI,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "dev",
      grepInvert: /@froid/,
      use: {
        ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, baseURL: ORIGINE_WEB,
        // Le service worker met en cache l'enveloppe : en mode developpement, il rendrait les coupures reseau dependantes de
        // l'historique du profil. Bloque ici ; actif dans le projet « build ».
        serviceWorkers: "block",
      },
    },
    {
      name: "build",
      grep: /@froid/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, baseURL: ORIGINE_BUILD, serviceWorkers: "allow" },
    },
  ],

  webServer: [
    {
      // Prepare la base (clone de `replay` + semis) PUIS lance l'API, dans un seul processus.
      command: `node "${tsx}" --tsconfig tsconfig.json scripts/lancer-api.ts`,
      cwd: __dirname,
      url: `${ORIGINE_API}/api/health`,
      reuseExistingServer: reutiliser,
      timeout: 180_000,
      stdout: sortieServeur,
      stderr: "pipe",
    },
    ...(avecDev ? [{
      command: `node "${vite}" --config "${path.join(__dirname, "vite.e2e.config.ts")}"`,
      cwd: path.join(RACINE_DEPOT, "frontend"),
      url: ORIGINE_WEB,
      reuseExistingServer: reutiliser,
      timeout: 120_000,
      stdout: sortieServeur,
      stderr: "pipe" as const,
    }] : []),
    ...(avecBuild ? [{
      // Construit puis sert. `precache-manifest.json` n'existe qu'une fois la construction terminee.
      command: `node "${tsx}" --tsconfig tsconfig.json scripts/lancer-build.ts`,
      cwd: __dirname,
      url: `${ORIGINE_BUILD}/precache-manifest.json`,
      reuseExistingServer: reutiliser,
      timeout: 600_000,
      stdout: "pipe" as const,
      stderr: "pipe" as const,
    }] : []),
  ],
});
