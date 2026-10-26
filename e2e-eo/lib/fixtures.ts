import fs from "node:fs";
import path from "node:path";
import { chromium, expect, test as base, type Browser, type BrowserContext, type Page, type Locator } from "@playwright/test";
import { adresseAleatoire, espacerConnexion } from "./api";
import { fermerBase } from "./base";
import { lireRun, type CompteRun, type DonneesRun } from "./donnees";
import { DOSSIER_CAPTURES, ORIGINE_WEB, RACINE_DEPOT } from "./env";

/**
 * Fixtures communes.
 *
 * UN CONTEXTE DE NAVIGATEUR PAR SESSION, connecte PAR L'INTERFACE (le chemin de l'agent, pas un jeton injecte). Chaque contexte annonce sa
 * propre adresse (`X-Forwarded-For`, lue par le serveur car `trust proxy` vaut 1) : le plafond de connexion fixe du serveur
 * (10 par 15 min et par adresse) ne gene pas les tests, et le serveur n'est pas modifie.
 *
 * RESEAU EXTERIEUR.
 *   - la feuille de style Leaflet (unpkg, `index.html`) est servie par la copie LOCALE de la meme version (1.9.4) : sans elle la carte
 *     n'est pas mise en page ; aucune requete ne part vers unpkg ;
 *   - les tuiles de fond (OpenStreetMap, Esri) sont refusees (aucun fond de carte : les marqueurs, eux, sont dessines par l'application),
 *     sauf demande (`tuilesReelles`, captures) ;
 *   - les APERCUS (`/produits/:id/apercu`) : le serveur relaie la vignette du fournisseur, ce qui coute 1 a 4 requetes vers Copernicus
 *     a CHAQUE ouverture d'une proposition. Pour ne pas solliciter ce service public a chaque test, l'appel est REMPLACE par le 404
 *     `APERCU_INDISPONIBLE` que le serveur reel rend (constate le 25/10/2026, API.md section 10), sauf pour la spec qui l'examine
 *     (`apercuReel: true`) : celle-la appelle le vrai serveur et le vrai fournisseur.
 */

export interface OptionsSession {
  /** Laisse passer les apercus jusqu'au serveur reel (et le fournisseur reel). Defaut : 404 APERCU_INDISPONIBLE remplace. */
  apercuReel?: boolean;
  tuilesReelles?: boolean;
  viewport?: { width: number; height: number };
}

export interface Session {
  context: BrowserContext;
  page: Page;
  compte: CompteRun;
  /** Erreurs JavaScript non interceptees de la page (`pageerror`) : doivent rester vides. */
  erreursPage: string[];
  /** Appels qui ont ete REMPLACES par le harnais (apercus), pour que la spec puisse dire ce qu'elle n'a pas touche. */
  apercusRemplaces: { n: number };
  /** Requetes d'ecriture (POST/PUT/PATCH/DELETE) vers /api, hors connexion et rafraichissement : sert a prouver « aucun POST ». */
  ecritures: { methode: string; url: string; status: number | null }[];
  /** Reponses 4xx/5xx de /api (hors 401 de connexion), pour distinguer ce que l'ecran a recu. */
  reponsesErreur: { methode: string; url: string; status: number }[];
  /** Rafraichissements de session refuses (4xx/5xx de /api/auth/refresh). */
  refreshEchoues: { url: string; status: number }[];
}

interface Fixtures {
  run: DonneesRun;
  ouvrirSession: (compte: CompteRun, options?: OptionsSession) => Promise<Session>;
}

const CSS_LEAFLET = fs.readFileSync(path.join(RACINE_DEPOT, "frontend", "node_modules", "leaflet", "dist", "leaflet.css"));

export const test = base.extend<Fixtures>({
  run: async ({}, use) => { await use(lireRun()); },

  ouvrirSession: async ({ browser }, use) => {
    const ouvertes: BrowserContext[] = [];
    async function ouvrir(compte: CompteRun, options: OptionsSession = {}): Promise<Session> {
      const context = await (browser as Browser).newContext({
        baseURL: ORIGINE_WEB, locale: "fr-FR", timezoneId: "Africa/Conakry", serviceWorkers: "block",
        viewport: options.viewport ?? { width: 1440, height: 900 },
        extraHTTPHeaders: { "X-Forwarded-For": adresseAleatoire() },
      });
      ouvertes.push(context);
      // ORDRE : Playwright essaie les routes dans l'ordre INVERSE de leur enregistrement (la derniere declaree passe en premier). Le filet
      // generique (tout le reste d'unpkg : corps vide) va donc AVANT la route precise de la feuille Leaflet. Declares dans l'autre ordre
      // (premier lancement), le filet masquait la feuille : la carte n'etait pas mise en page (zoom 11x21 px, controles hors de la carte).
      await context.route(/https?:\/\/unpkg\.com\//, (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
      await context.route(/https?:\/\/unpkg\.com\/leaflet@1\.9\.4\/dist\/leaflet\.css/, (r) => r.fulfill({ status: 200, contentType: "text/css", body: CSS_LEAFLET }));
      if (!options.tuilesReelles) await context.route(/https?:\/\/[^/]*(tile\.openstreetmap\.org|arcgisonline\.com)\//, (r) => r.abort());
      const apercusRemplaces = { n: 0 };
      if (!options.apercuReel) {
        await context.route(/\/api\/v2\/teledetection\/produits\/[^/]+\/apercu/, (r) => {
          apercusRemplaces.n++;
          return r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Apercu indisponible : remplace par le harnais (le fournisseur n'est pas sollicite)", code: "APERCU_INDISPONIBLE" }) });
        });
      }
      const page = await context.newPage();
      const erreursPage: string[] = [];
      page.on("pageerror", (e) => erreursPage.push(e.message));
      const ecritures: Session["ecritures"] = [];
      const reponsesErreur: Session["reponsesErreur"] = [];
      const refreshEchoues: Session["refreshEchoues"] = [];
      page.on("response", (r) => {
        const u = r.url();
        if (!u.includes("/api/")) return;
        const m = r.request().method();
        if (m !== "GET" && !/\/api\/auth\/(login|refresh|logout)/.test(u)) ecritures.push({ methode: m, url: u.replace(ORIGINE_WEB, ""), status: r.status() });
        if (r.status() >= 400 && /\/api\/auth\/refresh/.test(u)) refreshEchoues.push({ url: u.replace(ORIGINE_WEB, ""), status: r.status() });
        if (r.status() >= 400 && !/\/api\/auth\/(login|refresh)/.test(u)) reponsesErreur.push({ methode: m, url: u.replace(ORIGINE_WEB, ""), status: r.status() });
      });
      const session: Session = { context, page, compte, erreursPage, apercusRemplaces, ecritures, reponsesErreur, refreshEchoues };
      await seConnecter(page, compte);
      return session;
    }
    await use(ouvrir);
    for (const c of ouvertes) await c.close().catch(() => undefined);
    await fermerBase();
  },
});

export { expect };

/** Connexion PAR L'INTERFACE : meme chemin que l'agent. Les champs n'ont que leur texte indicatif (placeholder). */
export async function seConnecter(page: Page, compte: CompteRun): Promise<void> {
  await espacerConnexion(compte.email);
  await page.goto("/login");
  await page.getByRole("textbox", { name: "E-mail" }).fill(compte.email);
  await page.getByPlaceholder("Mot de passe").fill(compte.motDePasse);
  await page.getByRole("button", { name: "Se connecter" }).click();
  // « Déconnexion » est masque sous 640 px (le bouton y devient « Quitter ») : on attend le bandeau commun.
  await expect(page.getByRole("button", { name: /Déconnexion|Quitter/ })).toBeVisible();
  // CONSTAT E2E-EO-D (voir lib/api.ts) : un rafraichissement dans la meme seconde que la connexion regenere le MEME jeton (JWT sans
  // identifiant) et rend 409 ; la page rechargee tout de suite apres la connexion retombait sur /login. On laisse passer la seconde.
  await page.waitForTimeout(1_200);
}

/** Ouvre l'ecran et attend que les indicateurs et la liste soient chargees (ni chargement ni erreur). */
export async function ouvrirEcran(page: Page): Promise<void> {
  await page.goto("/teledetection");
  await attendreEcran(page);
}

export async function attendreEcran(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "Observation de la Terre", level: 1 })).toBeVisible();
  await expect(page.getByText("Chargement des indicateurs…")).toHaveCount(0);
  await expect(page.getByText("Chargement des propositions…")).toHaveCount(0);
}

// ---------------------------------------------------------------------------------------------------------
// Lecture des cartes d'indicateurs (dt / dd) et gestes courants
// ---------------------------------------------------------------------------------------------------------

/** Valeur (dd) d'une carte d'indicateur, par son libelle (dt). */
export function carte(page: Page, libelle: string): { valeur: Locator; detail: Locator } {
  const groupe = page.getByRole("region", { name: "Indicateurs de synthèse" }).locator("div", { has: page.locator("dt", { hasText: new RegExp(`^${libelle}$`) }) }).last();
  return { valeur: groupe.locator("dd").first(), detail: groupe.locator("dd").nth(1) };
}

/** Entier lu dans un texte (« 1 234 » avec espaces fines ou insecables). */
export function entier(texte: string | null): number {
  return Number((texte ?? "").replace(/[^\d]/g, ""));
}

export async function capturer(page: Page, nom: string, options: { pleinePage?: boolean } = {}): Promise<string> {
  fs.mkdirSync(DOSSIER_CAPTURES, { recursive: true });
  const f = path.join(DOSSIER_CAPTURES, `${nom}.png`);
  await page.screenshot({ path: f, fullPage: options.pleinePage ?? false });
  return f;
}

export { chromium };
