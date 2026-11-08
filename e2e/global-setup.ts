import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { lireRun } from "./lib/donnees";
import { DOSSIER_SORTIES, OPTIONS_LANCEMENT_NAVIGATEUR, ORIGINE_WEB } from "./lib/env";

/**
 * Prechauffage de Vite. Le serveur de developpement transforme les modules A LA PREMIERE DEMANDE, et decouvre en route
 * des dependances qu'il pre-assemble alors (« new dependencies optimized » : rechargement complet de la page). Laisse
 * au premier test, cela donne un chargement de 30 s ou plus qui echoue au hasard. Ici, un navigateur jetable ouvre une
 * fois chaque ecran que les tests utilisent, connecte, et attend que le reseau soit calme. Aucun test ne depend de ce que
 * ce passage affiche : s'il echoue, on le dit sans arreter le lancement (les tests rapporteront leur propre erreur).
 */
/** Attend que le reseau se calme, sans en faire une condition : l'application interroge parfois le serveur en continu. */
async function calme(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
}

/**
 * Module « Projets de voirie et reseaux » : la page d'un projet (Leaflet) et l'assistant d'import sont charges a la demande ; sans ce passage,
 * leur premiere transformation par Vite tombe dans le premier test qui les ouvre. Un projet jetable est cree par l'API avec le compte admin
 * (code PREPARATION-VOIRIE, sans region ni jeu) puis la page et l'assistant sont ouverts une fois. Meilleur effort : une erreur est ignoree.
 */
async function prechaufferVoirie(page: import("@playwright/test").Page, run: ReturnType<typeof lireRun>): Promise<void> {
  try {
    const jeton = await page.evaluate(async ({ email, password }) => {
      const r = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
      return ((await r.json()) as { accessToken?: string }).accessToken ?? null;
    }, { email: run.comptes.admin.email, password: run.comptes.admin.motDePasse });
    if (!jeton) return;
    const id = await page.evaluate(async (t) => {
      const r = await fetch("/api/v2/projets-voirie", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${t}` }, body: JSON.stringify({ code: "PREPARATION-VOIRIE", nom: "Preparation du navigateur" }) });
      return ((await r.json()) as { projet?: { id: string } }).projet?.id ?? null;
    }, jeton);
    if (!id) return;
    for (let i = 0; i < 2; i++) {
      await page.goto(`/projets-voirie/${id}`, { waitUntil: "load" });
      await calme(page);
      await page.getByRole("button", { name: "Ajouter des données" }).click();
      await page.getByRole("dialog", { name: "Ajouter des données au projet" }).waitFor();
      await calme(page);
    }
  } catch (e) {
    console.warn("Prechauffage du module voirie incomplet :", e instanceof Error ? e.message.split(String.fromCharCode(10))[0] : e);
  }
}

export default async function globalSetup(): Promise<void> {
  const debut = Date.now();
  // Profils de navigateur oublies par un lancement precedent (voir lib/fixtures.ts) : balayes ici.
  try { fs.rmSync(path.join(DOSSIER_SORTIES, "profils"), { recursive: true, force: true }); } catch { /* sera retente au lancement suivant */ }
  // Le projet « dev » n'est pas demande (`--project=build`) : pas de Vite a prechauffer.
  if (process.env.E2E_AVEC_DEV === "0") return;
  const run = lireRun();
  const navigateur = await chromium.launch({ ...OPTIONS_LANCEMENT_NAVIGATEUR });
  try {
    const context = await navigateur.newContext({
      baseURL: ORIGINE_WEB, serviceWorkers: "block", locale: "fr-FR",
      permissions: ["geolocation"], geolocation: { latitude: 9.53, longitude: -13.68, accuracy: 5 },
      // Adresse tiree au hasard a chaque lancement : le plafond de connexion (10 par 15 min et par adresse) ne doit pas compter les relances.
      extraHTTPHeaders: { "X-Forwarded-For": `10.${200 + Math.floor(Math.random() * 50)}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}` },
    });
    // Les services tiers (feuille Leaflet, tuiles) ne doivent pas retarder le chargement.
    await context.route(/https?:\/\/unpkg\.com\//, (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
    await context.route(/https?:\/\/[^/]*(tile\.openstreetmap\.org|arcgisonline\.com)\//, (r) => r.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(300_000);
    // Premier chargement : Windows peut refuser une connexion locale (ERR_NO_BUFFER_SPACE) quand le poste est charge. Trois essais.
    for (let essai = 1; ; essai++) {
      try { await page.goto("/login", { waitUntil: "load" }); break; } catch (e) { if (essai >= 3) throw e; await page.waitForTimeout(2_000); }
    }
    await calme(page);
    await page.getByRole("textbox", { name: "E-mail" }).fill(run.comptes.admin.email);
    await page.getByPlaceholder("Mot de passe").fill(run.comptes.admin.motDePasse);
    await page.getByRole("button", { name: "Se connecter" }).click();
    await page.getByRole("button", { name: "Déconnexion" }).waitFor();
    for (const chemin of ["/", "/inspections/terrain/observations", "/inspections/terrain", "/inspections/terrain/defauts", "/inspections/releve/enregistrer", "/imports", "/securite", "/projets-voirie"]) {
      // Deux passages : le premier peut etre interrompu par le rechargement de Vite apres optimisation des dependances.
      for (let i = 0; i < 2; i++) {
        await page.goto(chemin, { waitUntil: "load" });
        await calme(page);
      }
    }
    await prechaufferVoirie(page, run);
  } catch (e) {
    console.warn("Prechauffage de Vite incomplet :", e instanceof Error ? e.message.split("\n")[0] : e);
  } finally {
    await navigateur.close();
    console.log(`Prechauffage de Vite : ${Math.round((Date.now() - debut) / 1000)} s`);
  }
}
