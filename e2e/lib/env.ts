import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Constantes communes au lanceur de la pile (scripts/lancer-api.ts), a la configuration Playwright et
 * aux specs. Rien ici n'est un secret : les identifiants sont generes a chaque lancement (lib/donnees.ts)
 * et ecrits dans le dossier temporaire du poste, jamais dans le depot.
 */

/**
 * Coefficient des delais d'attente (variable E2E_FACTEUR_DELAI, defaut 1) : a monter (2, 3) quand la machine est chargee. Les tests attendent des
 * CONDITIONS (ligne en base, ecran affiche), jamais une duree ; ce coefficient ne rallonge que le plafond de ces attentes.
 */
export const FACTEUR_DELAI = Math.max(1, Number(process.env.E2E_FACTEUR_DELAI ?? 1) || 1);

export const PORT_API = 3101;
export const PORT_WEB = 5201;
/** Port de controle de l'API de test (remise a zero du plafond des evenements locaux). */
export const PORT_CONTROLE = 3102;
/** Projet « build » : le build de production servi par un serveur statique (scripts/serveur-statique.ts). */
export const PORT_BUILD = 5301;

/**
 * `127.0.0.1` et non `localhost` : sur Windows, `localhost` peut se resoudre en `::1` pour l'un des deux
 * serveurs et en `127.0.0.1` pour l'autre, et l'origine doit etre identique au caractere pres pour que le
 * cookie de session (SameSite=Strict) et la verification d'origine du serveur (`CORS_ORIGIN`) concordent.
 */
export const ORIGINE_WEB = `http://127.0.0.1:${PORT_WEB}`;
export const ORIGINE_BUILD = `http://127.0.0.1:${PORT_BUILD}`;
export const ORIGINE_API = `http://127.0.0.1:${PORT_API}`;

/** Seule base que ce harnais cree, remplit et detruit. Conforme a la garde des bancs (`essai_<nom>`). */
export const NOM_BASE = "essai_e2e";
/** Modele du clone : le schema complet, sans donnee, que les bancs PostGIS utilisent deja. */
export const NOM_MODELE = "replay";

export const RACINE_DEPOT = path.resolve(__dirname, "..", "..");

/**
 * Tout ce qui est genere (identifiants, televersements, sorties de test) vit ici, hors du depot.
 * `realpathSync.native` : sous Windows, `os.tmpdir()` rend le nom court 8.3 (`ELHAMA~1`). Vite compare des chemins a leur forme
 * reelle (nom long) : avec le nom court, il refuse de charger `/src/main.tsx` depuis l'extraction de HEAD.
 */
export const DOSSIER_RUN = path.join(fs.realpathSync.native(os.tmpdir()), "bdri-e2e");
export const FICHIER_RUN = path.join(DOSSIER_RUN, "run.json");
export const DOSSIER_SORTIES = path.join(DOSSIER_RUN, "sorties");
/** Repertoire de travail de l'API : `uploads/photos` s'y cree, pas dans `backend/`. */
export const DOSSIER_API = path.join(DOSSIER_RUN, "api");

/**
 * Delai maximal d'attente d'un effet de synchronisation visible en base ou dans IndexedDB. Large : le poste est souvent charge
 * par d'autres travaux (CPU a 100 %), et une attente trop juste donnerait des echecs qui ne disent rien de l'application.
 * Un vrai defaut est constate par une assertion qui reste fausse, pas par un delai court : on prefere attendre.
 */
export const DELAI_SYNC_MS = 60_000 * FACTEUR_DELAI;

/** Build de production du frontend (vite build) : dossier temporaire, jamais frontend/dist. */
export const DOSSIER_BUILD = path.join(DOSSIER_RUN, "build");
/** Si ce fichier existe, le serveur statique coupe toute connexion : « le serveur est injoignable » (reouverture a froid hors ligne). */
export const FICHIER_SERVEUR_COUPE = path.join(DOSSIER_RUN, "serveur-coupe");
/** Captures d'ecran des controles de mise en page (hors depot). */
export const DOSSIER_CAPTURES = path.join(DOSSIER_SORTIES, "captures");
