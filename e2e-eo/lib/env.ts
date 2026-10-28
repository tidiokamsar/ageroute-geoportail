import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Constantes communes au lanceur de la pile (scripts/lancer-api.ts), a la configuration Playwright et aux specs.
 * Rien ici n'est un secret : les identifiants sont generes a chaque lancement (lib/donnees.ts) et ecrits dans le
 * dossier temporaire du poste, jamais dans le depot.
 *
 * Harnais de bout en bout de l'Observation de la Terre : meme idee que `e2e/` du depot principal (base clonee,
 * API reelle, Vite reel, Chromium), avec ses propres ports et sa propre base pour ne jamais gener l'autre.
 */

export const PORT_API = 3401;
export const PORT_WEB = 5410;

/** `127.0.0.1` et non `localhost` : l'origine doit etre identique au caractere pres (cookie SameSite=Strict, verification d'origine). */
export const ORIGINE_WEB = `http://127.0.0.1:${PORT_WEB}`;
export const ORIGINE_API = `http://127.0.0.1:${PORT_API}`;

/** Seule base que ce harnais cree, remplit et detruit. Conforme a la garde des bancs (`essai_<nom>`). */
export const NOM_BASE = "essai_eo_e2e";
/** Modele du clone : le schema complet jusqu'a la migration 20261028130000, sans donnee. */
export const NOM_MODELE = "essai_eo_workflow";

export const RACINE_DEPOT = path.resolve(__dirname, "..", "..");

/** Tout ce qui est genere vit ici, hors du depot. `realpathSync.native` : nom long (Vite compare des chemins reels). */
export const DOSSIER_RUN = path.join(fs.realpathSync.native(os.tmpdir()), "bdri-eo-e2e");
export const FICHIER_RUN = path.join(DOSSIER_RUN, "run.json");
export const DOSSIER_SORTIES = path.join(DOSSIER_RUN, "sorties");
/** Repertoire de travail de l'API : jamais `backend/`. */
export const DOSSIER_API = path.join(DOSSIER_RUN, "api");
/** Captures d'ecran de l'ecran reel avec les vraies donnees (`E2E_EO_CAPTURES` pour les ranger ailleurs). */
export const DOSSIER_CAPTURES = process.env.E2E_EO_CAPTURES ?? path.join(DOSSIER_SORTIES, "captures");

/** Delai large : le poste est souvent charge ; un vrai defaut se constate par une assertion qui reste fausse, pas par un delai court. */
export const DELAI_MS = 60_000;
