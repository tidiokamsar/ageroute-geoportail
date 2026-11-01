import fs from "node:fs";
import { expect, request, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import type { CompteRun } from "./donnees";
import { FICHIER_SERVEUR_COUPE, ORIGINE_WEB } from "./env";

/** Outils des scenarios de session hors ligne (`session-hors-ligne.cible.spec.ts`). */

/** Ouvre le panneau « Session locale » de l'en-tete (verrouiller, changer le code, reinitialiser, effacer). */
export async function ouvrirPanneauSession(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Session locale" }).click();
  await expect(page.getByRole("dialog", { name: "Session locale" })).toBeVisible();
}

/**
 * Coupe (ou rouvre) le SERVEUR STATIQUE du projet build : toute connexion est refusee tant que le fichier existe. Avec `setOffline`,
 * c'est un telephone sans aucun reseau ; le service worker est alors la seule source de l'application.
 */
export function coupureServeurStatique(coupe: boolean): void {
  if (coupe) fs.writeFileSync(FICHIER_SERVEUR_COUPE, "coupe");
  else fs.rmSync(FICHIER_SERVEUR_COUPE, { force: true });
}

/** Coupure complete (projet build) : le navigateur se croit hors ligne ET le serveur ne repond plus. */
export async function modeAvion(context: BrowserContext, page: Page | null, actif: boolean): Promise<void> {
  coupureServeurStatique(actif);
  await context.setOffline(actif);
  if (page) await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(!actif);
}

/**
 * Attend que le service worker soit actif ET que le precache de l'application soit COMPLET : autant d'entrees que le manifeste
 * du build (`/precache-manifest.json`). Rend le nombre d'entrees et les cles des caches.
 */
export async function attendreServiceWorkerPret(page: Page): Promise<{ entrees: number; caches: string[] }> {
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(async () => page.evaluate(async () => {
    const manifeste = await (await fetch("/precache-manifest.json", { cache: "no-store" })).json();
    const nom = (await caches.keys()).find((k) => k.startsWith("bdri-precache-"));
    if (!nom) return "pas de precache";
    const n = (await (await caches.open(nom)).keys()).length;
    return n >= manifeste.entrees.length ? "complet" : `${n}/${manifeste.entrees.length}`;
  }), { timeout: 180_000, intervals: [1000, 2000] }).toBe("complet");
  return page.evaluate(async () => {
    const noms = await caches.keys();
    const nom = noms.find((k) => k.startsWith("bdri-precache-"))!;
    return { entrees: (await (await caches.open(nom)).keys()).length, caches: noms };
  });
}

/** Les URL de toutes les entrees de tous les caches du navigateur (pour verifier qu'aucune reponse d'API n'y est). */
export async function urlsEnCache(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const sortie: string[] = [];
    for (const nom of await caches.keys()) for (const r of await (await caches.open(nom)).keys()) sortie.push(r.url);
    return sortie;
  });
}

/** Simule l'arriere-plan / le premier plan de la page (evenement `visibilitychange`), que Chromium sans fenetre ne produit pas seul. */
export async function definirVisibilite(page: Page, etat: "hidden" | "visible"): Promise<void> {
  await page.evaluate((e) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => e });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => e === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, etat);
}

/** Compte les requetes de la page qui correspondent (methode + fin d'URL), a partir de l'appel. */
export function compterRequetes(page: Page, methode: string, finUrl: string): { n(): number; arreter(): void } {
  let n = 0;
  const ecouteur = (r: { method(): string; url(): string }) => { if (r.method() === methode && r.url().split("?")[0].endsWith(finUrl)) n++; };
  page.on("request", ecouteur);
  return { n: () => n, arreter: () => page.off("request", ecouteur) };
}

/**
 * Jeton d'acces d'un compte, obtenu par un contexte d'API SEPARE de celui du navigateur : se connecter dans le navigateur ecraserait le cookie
 * de session (meme nom, meme chemin) du compte de l'agent. Sert aux gestes d'administration d'un scenario (revoquer un appareil).
 */
export async function jetonDe(compte: CompteRun, testInfo: TestInfo, adresse = "10.77.77.77"): Promise<string> {
  const baseURL = (testInfo.project.use.baseURL as string | undefined) ?? ORIGINE_WEB;
  const api = await request.newContext({ baseURL, extraHTTPHeaders: { "X-Forwarded-For": adresse } });
  try {
    const r = await api.post("/api/auth/login", { data: { email: compte.email, password: compte.motDePasse } });
    expect(r.status(), "connexion de l'administrateur du scenario").toBe(200);
    return (await r.json()).accessToken as string;
  } finally {
    await api.dispose();
  }
}

/** Appel authentifie de l'API par un contexte separe (voir `jetonDe`). */
export async function appelerApi(testInfo: TestInfo, jeton: string, methode: "GET" | "POST", chemin: string, data?: unknown) {
  const baseURL = (testInfo.project.use.baseURL as string | undefined) ?? ORIGINE_WEB;
  const api = await request.newContext({ baseURL, extraHTTPHeaders: { "X-Forwarded-For": "10.77.77.78", authorization: `Bearer ${jeton}` } });
  try {
    const r = methode === "GET" ? await api.get(chemin) : await api.post(chemin, { data });
    return { statut: r.status(), corps: await r.json().catch(() => null) as any };
  } finally {
    await api.dispose();
  }
}
