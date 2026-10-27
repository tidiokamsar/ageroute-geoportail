import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { chromium, expect, test as base, type BrowserContext, type Page } from "@playwright/test";
import { lireRun, type CompteRun, type DonneesRun } from "./donnees";
import { DOSSIER_SORTIES, FICHIER_SERVEUR_COUPE, ORIGINE_WEB } from "./env";
import { fermerBase, revoquerAppareilsDeTest } from "./base";

/**
 * Fixtures communes.
 *
 * PROFIL PERSISTANT POUR TOUS LES TESTS. Chaque test ouvre son navigateur avec `launchPersistentContext` sur
 * un dossier de profil jetable. C'est ce qui rend vrai le scenario du terrain : IndexedDB, localStorage et
 * cookies sont ECRITS SUR LE DISQUE du profil, donc un « redemarrage du telephone » se rejoue en fermant le
 * contexte puis en en ouvrant un nouveau sur le meme dossier (`profil.redemarrer()`), et « deux comptes sur
 * le meme appareil » en se connectant tour a tour dans le meme profil.
 *
 * ADRESSE ANNONCEE. `/api/auth/login` plafonne a 10 par 15 min et par adresse, plafond fixe dans le code du
 * serveur. Chaque profil annonce sa propre adresse (`X-Forwarded-For`, lue par le serveur car `trust proxy`
 * vaut 1) : les tests ne se genent pas, et le serveur n'est pas modifie.
 *
 * DEUX PROJETS. `dev` (Vite, service worker bloque) et `build` (build de production, service worker actif) : l'adresse de base
 * et la politique des workers viennent du projet (`testInfo.project.use`).
 */

export interface OptionsProfil {
  /** Horloge simulee installee AVANT toute page (Playwright `clock`) : date de depart. Le temps continue ensuite de s'ecouler. */
  horloge?: Date;
}

export interface Profil {
  readonly dossier: string;
  readonly adresse: string;
  context: BrowserContext;
  page: Page;
  /**
   * Attend qu'aucun rafraichissement de session (`POST /api/auth/refresh`) ne soit en vol, ni n'ait demarre depuis 1,5 s. A appeler AVANT de
   * recharger ou de fermer le navigateur : la rotation du jeton se fait cote serveur, et si la page disparait avant d'avoir recu la reponse, le
   * nouveau cookie est perdu ; le rafraichissement suivant presente l'ancien jeton, le serveur y voit une REUTILISATION et ferme la session
   * (constat E2E-4, voir session-hors-ligne.cible.spec.ts). Une requete de synchronisation qui echoue declenche justement un tel rafraichissement.
   */
  attendreCalme(): Promise<void>;
  /** Ferme le navigateur (comme une application tuee), puis le rouvre sur le MEME profil. */
  redemarrer(options?: OptionsProfil): Promise<void>;
}

interface Fixtures {
  run: DonneesRun;
  ouvrirProfil: (options?: OptionsProfil) => Promise<Profil>;
  /** Identifiant court et unique, a mettre dans ce qu'un test saisit pour le retrouver en base. */
  marqueur: string;
}

function adresseAleatoire(): string {
  const o = randomBytes(3);
  return `10.${(o[0] % 250) + 1}.${(o[1] % 250) + 1}.${(o[2] % 250) + 1}`;
}

export const test = base.extend<Fixtures>({
  run: async ({}, use) => { await use(lireRun()); },

  marqueur: async ({}, use) => { await use(`E2E-${randomUUID().slice(0, 8)}`); },

  ouvrirProfil: async ({}, use, testInfo) => {
    const ouverts: Profil[] = [];
    const racine = path.join(DOSSIER_SORTIES, "profils");
    const baseURL = (testInfo.project.use.baseURL as string | undefined) ?? ORIGINE_WEB;
    const serviceWorkers = (testInfo.project.use.serviceWorkers as "allow" | "block" | undefined) ?? "block";

    async function lancer(dossier: string, adresse: string, options?: OptionsProfil): Promise<{ context: BrowserContext; page: Page; attendreCalme: () => Promise<void> }> {
      const context = await chromium.launchPersistentContext(dossier, {
        headless: !process.env.E2E_AVEC_FENETRE,
        baseURL,
        locale: "fr-FR",
        timezoneId: "Africa/Conakry",
        viewport: { width: 1280, height: 800 },
        serviceWorkers,
        extraHTTPHeaders: { "X-Forwarded-For": adresse },
        // Position GPS d'un point de la RN1 pres de Conakry, precision annoncee de 5 m.
        permissions: ["geolocation"],
        geolocation: { latitude: 9.53, longitude: -13.68, accuracy: 5 },
        acceptDownloads: true,
      });
      // Services tiers que l'application charge (feuille Leaflet de unpkg, tuiles) : sans reseau public ils retarderaient
      // l'evenement `load` (et, avec lui, l'enregistrement du service worker). La feuille est servie vide, les tuiles refusees.
      await context.route(/https?:\/\/unpkg\.com\//, (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
      await context.route(/https?:\/\/[^/]*(tile\.openstreetmap\.org|arcgisonline\.com)\//, (r) => r.abort());
      // Suivi des rafraichissements de session en vol (voir Profil.attendreCalme).
      const enVol = new Set<unknown>();
      let dernier = 0;
      const estRefresh = (u: string) => /\/api\/auth\/refresh(\?|$)/.test(u);
      context.on("request", (r) => { if (estRefresh(r.url())) { enVol.add(r); dernier = Date.now(); } });
      const fini = (r: { url(): string }) => { if (estRefresh(r.url())) { enVol.delete(r); dernier = Date.now(); } };
      context.on("requestfinished", fini);
      context.on("requestfailed", fini);
      const attendreCalme = async () => {
        await expect.poll(() => (enVol.size === 0 && Date.now() - dernier > 1500 ? "calme" : "en cours"), { timeout: 60_000, intervals: [250] }).toBe("calme");
      };
      const page = context.pages()[0] ?? (await context.newPage());
      if (options?.horloge) await page.clock.install({ time: options.horloge });
      return { context, page, attendreCalme };
    }

    async function ouvrir(options?: OptionsProfil): Promise<Profil> {
      fs.mkdirSync(racine, { recursive: true });
      const dossier = fs.mkdtempSync(path.join(racine, "profil-"));
      const adresse = adresseAleatoire();
      const profil = { dossier, adresse } as Profil;
      Object.assign(profil, await lancer(dossier, adresse, options));
      profil.redemarrer = async (opts?: OptionsProfil) => {
        await profil.attendreCalme().catch(() => undefined);
        // La trace du contexte ferme est perdue : seule celle de la derniere vie du profil est gardee.
        await profil.context.close();
        Object.assign(profil, await lancer(dossier, adresse, opts));
      };
      ouverts.push(profil);
      return profil;
    }
    await use(ouvrir);

    for (const p of ouverts) {
      await p.context.close().catch(() => undefined);
      // Sous Windows, Chromium peut tenir encore quelques fichiers du profil apres la fermeture (EPERM) : ce n'est pas un echec
      // du test. Les dossiers oublies sont balayes au lancement suivant (global-setup.ts).
      try { fs.rmSync(p.dossier, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* voir ci-dessus */ }
    }
    // Le serveur statique est rouvert quoi qu'il arrive (un test du projet build peut l'avoir coupe).
    fs.rmSync(FICHIER_SERVEUR_COUPE, { force: true });
    // Les appareils enregistres par ce test ne comptent plus dans le plafond des 10 appareils actifs d'un compte.
    await revoquerAppareilsDeTest().catch(() => undefined);
    await fermerBase();
  },
});

export { expect };

// ---------------------------------------------------------------------------------------------------------
// Gestes : connexion
// ---------------------------------------------------------------------------------------------------------

/** Connexion PAR L'INTERFACE : meme chemin que l'agent. Les champs n'ont que leur texte indicatif (defaut E2E-3, voir 01-connexion). */
export async function seConnecter(page: Page, compte: CompteRun): Promise<void> {
  await page.goto("/login");
  await page.getByRole("textbox", { name: "E-mail" }).fill(compte.email);
  await page.getByPlaceholder("Mot de passe").fill(compte.motDePasse);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page.getByRole("button", { name: "Déconnexion" })).toBeVisible();
}

/**
 * Se deconnecter par l'interface : le bouton de l'en-tete ouvre un dialogue qui dit ce qui reste sur le telephone ; la
 * deconnexion n'a lieu qu'a la confirmation. Rend le texte du dialogue (ce que l'agent a lu avant de confirmer).
 */
export async function seDeconnecter(page: Page, options: { confirmer?: boolean } = {}): Promise<string> {
  const confirmer = options.confirmer ?? true;
  await page.getByRole("button", { name: "Déconnexion" }).click();
  const dialogue = page.getByRole("dialog", { name: "Se déconnecter ?" });
  await expect(dialogue).toBeVisible();
  // Le dialogue lit d'abord le decompte de la file : on attend qu'il l'ait fait.
  await expect(dialogue.getByText("Vérification de la file de ce téléphone...")).toHaveCount(0);
  const texte = await dialogue.innerText();
  if (confirmer) {
    await dialogue.getByRole("button", { name: "Se déconnecter" }).click();
    await expect(page).toHaveURL(/\/(login|carte)/);
  }
  return texte;
}

// ---------------------------------------------------------------------------------------------------------
// Gestes : session locale (code PIN)
// ---------------------------------------------------------------------------------------------------------

const TITRE_CREATION_PIN = "Créez votre code PIN";
const DIALOGUE_VERROU = "Session verrouillée";

/** Cree le code PIN du compte sur l'ecran de creation (premiere fois sur cet appareil). */
export async function creerPin(page: Page, compte: CompteRun): Promise<void> {
  const titre = page.getByRole("heading", { name: TITRE_CREATION_PIN });
  await expect(titre).toBeVisible();
  await page.getByLabel("Code PIN", { exact: true }).fill(compte.pin);
  await page.getByLabel("Confirmez le code").fill(compte.pin);
  await page.getByRole("button", { name: "Créer mon code" }).click();
  await expect(titre).toBeHidden();
}

/** Deverrouille la session locale avec le PIN du compte (ou un PIN donne, pour les essais faux). Attend la disparition de l'ecran. */
export async function deverrouiller(page: Page, compte: CompteRun, pin: string = compte.pin): Promise<void> {
  const dialogue = page.getByRole("dialog", { name: DIALOGUE_VERROU });
  await expect(dialogue).toBeVisible();
  await dialogue.getByLabel("Code PIN").fill(pin);
  await dialogue.getByRole("button", { name: "Déverrouiller" }).click();
  await expect(dialogue).toBeHidden();
}

/** Un essai de deverrouillage qui ne reussit pas : saisit le PIN, clique, rend le message qui s'affiche (sans attendre la fermeture). */
export async function essayerPin(page: Page, pin: string): Promise<void> {
  const dialogue = page.getByRole("dialog", { name: DIALOGUE_VERROU });
  await dialogue.getByLabel("Code PIN").fill(pin);
  await dialogue.getByRole("button", { name: "Déverrouiller" }).click();
}

/**
 * Apres un chargement de page (ou une connexion) sur un ecran de la file locale : l'application demande soit de CREER le PIN
 * (premiere fois), soit de DEVERROUILLER. Fait ce qu'il faut et dit ce qui a ete fait.
 */
export async function passerLePin(page: Page, compte: CompteRun): Promise<"cree" | "deverrouille"> {
  const creation = page.getByRole("heading", { name: TITRE_CREATION_PIN });
  const verrou = page.getByRole("dialog", { name: DIALOGUE_VERROU });
  let etat: "cree" | "deverrouille" | null = null;
  await expect.poll(async () => {
    if (await creation.isVisible()) return "creation";
    if (await verrou.isVisible()) return "verrou";
    return "rien";
  }, { timeout: 60_000, intervals: [250, 500] }).not.toBe("rien");
  if (await creation.isVisible()) { await creerPin(page, compte); etat = "cree"; }
  else { await deverrouiller(page, compte); etat = "deverrouille"; }
  return etat;
}

export const ECRAN_OBSERVATIONS = "/inspections/terrain/observations";
export const ECRAN_INSPECTION = "/inspections/terrain";
export const ECRAN_ROULAGE = "/inspections/releve/enregistrer";

/** Ouvre un ecran de la file locale (chargement de page complet) et passe l'ecran du PIN. */
export async function ouvrirEcranTerrain(page: Page, route: string, compte: CompteRun): Promise<"cree" | "deverrouille"> {
  await page.goto(route);
  return passerLePin(page, compte);
}

/** Connexion, puis ecran « Observations terrain » pret a saisir (PIN cree ou deverrouille). */
export async function ouvrirObservations(page: Page, compte: CompteRun): Promise<void> {
  await seConnecter(page, compte);
  await ouvrirEcranTerrain(page, ECRAN_OBSERVATIONS, compte);
  await expect(page.getByRole("heading", { name: "Nouvelle observation" })).toBeVisible();
}

// ---------------------------------------------------------------------------------------------------------
// Gestes : reseau
// ---------------------------------------------------------------------------------------------------------

/**
 * Coupe le reseau du navigateur : les requetes echouent et `navigator.onLine` passe a `false` (evenement
 * `offline`). Les pages deja chargees continuent de tourner ; un chargement de page, lui, echouerait (sauf avec le service worker,
 * projet build). On ouvre donc l'ecran EN LIGNE, puis on coupe, comme un agent qui perd la couverture en route.
 */
export async function coupureReseau(context: BrowserContext, page: Page): Promise<void> {
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
}

/** Retablit le reseau : `navigator.onLine` repasse a `true` et l'evenement `online` declenche la synchronisation. */
export async function retablirReseau(context: BrowserContext, page: Page): Promise<void> {
  await context.setOffline(false);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
}

// ---------------------------------------------------------------------------------------------------------
// Gestes : saisie
// ---------------------------------------------------------------------------------------------------------

/** Saisit une observation sur l'ecran « Observations terrain » (sans position) et l'enregistre. */
export async function saisirObservation(page: Page, o: { type: string; gravite?: string; description: string }): Promise<void> {
  await page.getByLabel("Type", { exact: true }).selectOption(o.type);
  if (o.gravite) await page.getByLabel("Gravité (facultative)").selectOption(o.gravite);
  await page.getByLabel("Description").fill(o.description);
  await page.getByRole("button", { name: "Enregistrer sur ce téléphone" }).click();
  await expect(page.getByText("Observation conservée sur ce téléphone").first()).toBeVisible();
}

/** Ouvre l'ecran « Inspection terrain » EN LIGNE (il charge le referentiel des troncons, garde ensuite en copie locale). */
export async function ouvrirInspection(page: Page, compte: CompteRun): Promise<void> {
  await ouvrirEcranTerrain(page, ECRAN_INSPECTION, compte);
  await expect(page.getByRole("heading", { name: "Inspection terrain", level: 1 })).toBeVisible();
}

export async function remplirInspection(page: Page, tronconId: string, marqueur: string, photo?: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  // Le libelle « Tronçon inspecté » est associe a sa liste (`for`), corrige depuis E2E-3.
  const listeTroncons = page.getByLabel("Tronçon inspecté");
  await expect(listeTroncons.locator(`option[value="${tronconId}"]`)).toHaveCount(1);
  await listeTroncons.selectOption(tronconId);
  await page.getByLabel("État observé").selectOption("MAUVAIS");
  await page.getByLabel("Défauts constatés").fill(`${marqueur} fissures longitudinales`);
  if (photo) await page.getByLabel("Photos", { exact: true }).setInputFiles(photo);
  await page.getByRole("button", { name: "Enregistrer l'inspection" }).click();
}

export async function saisirInspection(page: Page, compte: CompteRun, tronconId: string, marqueur: string): Promise<void> {
  await ouvrirInspection(page, compte);
  await remplirInspection(page, tronconId, marqueur);
}
