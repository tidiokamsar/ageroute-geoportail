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
import http from "node:http";
import { pathToFileURL } from "node:url";
import { preparerBase } from "../lib/donnees";
import { DOSSIER_API, ORIGINE_BUILD, ORIGINE_WEB, PORT_API, PORT_CONTROLE, RACINE_DEPOT } from "../lib/env";

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
    // Module « Projets de voirie et reseaux » : delai minimal entre deux analyses de conflits d'un meme projet (defaut 60 s) et entre deux
    // propositions d'association (defaut 30 s) ramenes a 3 s, pour que les scenarios qui rejouent une analyse n'attendent pas une minute.
    // Pas a 0 : la cadence reste ACTIVE et un test la verifie (429 ANALYSE_TROP_FREQUENTE). Aucune autre valeur du module n'est touchee.
    PROJETS_VOIRIE_ANALYSE_INTERVALLE_S: "3",
    PROJETS_VOIRIE_ASSOC_INTERVALLE_S: "3",
    // Lot S1 : meme raisonnement pour la cadence des comparaisons de sources (defaut 60 s) : 3 s, cadence toujours ACTIVE (le client la respecte).
    PROJETS_VOIRIE_COMPARAISON_INTERVALLE_S: "3",
    // Delai de la base pour une analyse (defaut 20 s, 504 ANALYSE_TROP_LONGUE au-dela) porte a 120 s : sur un poste partage et charge, une analyse de
    // quelques objets depasse 20 s et ferait echouer un scenario pour une raison qui ne dit rien de l'application. Borne du serveur : 1 s a 300 s.
    PROJETS_VOIRIE_DELAI_ANALYSE_MS: "120000",
    // Aucune integration sortante : INTEGRATIONS_SORTANTES_ACTIVES n'est pas defini.
  });

  // URL file:// : sous Windows, import() refuse un chemin absolu de type F:\.
  await import(pathToFileURL(path.join(RACINE_DEPOT, "backend", "src", "server.ts")).href);

  // PORT DE CONTROLE (127.0.0.1 seulement, ce processus de test seulement). Le serveur plafonne les evenements de session locale a
  // 5 lots par 15 min ET PAR COMPTE (backend/src/modules/auth/evenements-locaux.ts) : toute la batterie partage les memes comptes, donc
  // le plafond serait epuise au milieu de la suite (reponse 429, evenement garde mais non depose avant 15 min). Chaque test remet donc le
  // compteur a zero par ce port, avec la fonction que le module exporte pour ses propres tests ; le code du serveur n'est pas modifie.
  const limites = await import(pathToFileURL(path.join(RACINE_DEPOT, "backend", "src", "modules", "auth", "evenements-locaux.ts")).href);
  http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/reinitialiser-limites") {
      limites._reinitialiserLimiteEvenementsLocaux();
      res.writeHead(204).end();
    } else {
      res.writeHead(404).end();
    }
  }).listen(PORT_CONTROLE, "127.0.0.1");
}

main().catch((e) => {
  console.error("Lancement de l'API de test impossible :", e instanceof Error ? e.message : e);
  process.exit(1);
});
