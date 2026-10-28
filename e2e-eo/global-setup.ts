import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { adresseAleatoire } from "./lib/api";
import { lireRun } from "./lib/donnees";
import { DOSSIER_SORTIES, ORIGINE_WEB } from "./lib/env";
import { semerTout } from "./lib/semis";

/**
 * Apres le demarrage de l'API reelle et de Vite (webServer) :
 *   1. semis par l'API reelle (comptes, catalogue Copernicus reel, referentiel de test, propositions FIXTURES : lib/semis.ts) ;
 *   2. prechauffage de Vite : il transforme les modules A LA PREMIERE DEMANDE ; laisse au premier test, cela donne un chargement
 *      de plusieurs dizaines de secondes. Un navigateur jetable ouvre une fois l'ecran, connecte. Aucun test ne depend de ce passage.
 */
export default async function globalSetup(): Promise<void> {
  const debut = Date.now();
  try { fs.rmSync(path.join(DOSSIER_SORTIES, "profils"), { recursive: true, force: true }); } catch { /* retente au lancement suivant */ }
  await semerTout();
  console.log(`Semis : ${Math.round((Date.now() - debut) / 1000)} s`);

  const t1 = Date.now();
  const run = lireRun();
  const navigateur = await chromium.launch();
  try {
    const context = await navigateur.newContext({
      baseURL: ORIGINE_WEB, serviceWorkers: "block", locale: "fr-FR", extraHTTPHeaders: { "X-Forwarded-For": adresseAleatoire() },
    });
    await context.route(/https?:\/\/unpkg\.com\//, (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
    await context.route(/https?:\/\/[^/]*(tile\.openstreetmap\.org|arcgisonline\.com)\//, (r) => r.abort());
    // Ne jamais solliciter le fournisseur d'images pendant le prechauffage.
    await context.route(/\/produits\/[^/]+\/apercu/, (r) => r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "prechauffage", code: "APERCU_INDISPONIBLE" }) }));
    const page = await context.newPage();
    page.setDefaultTimeout(300_000);
    await page.goto("/login", { waitUntil: "load" });
    await page.getByRole("textbox", { name: "E-mail" }).fill(run.comptes.admin.email);
    await page.getByPlaceholder("Mot de passe").fill(run.comptes.admin.motDePasse);
    await page.getByRole("button", { name: "Se connecter" }).click();
    await page.getByRole("button", { name: "Déconnexion" }).waitFor();
    for (let i = 0; i < 2; i++) {
      // Deux passages : le premier peut etre interrompu par le rechargement de Vite apres optimisation des dependances.
      await page.goto("/teledetection", { waitUntil: "load" });
      await page.waitForLoadState("networkidle", { timeout: 40_000 }).catch(() => undefined);
    }
  } catch (e) {
    console.warn("Prechauffage de Vite incomplet :", e instanceof Error ? e.message.split("\n")[0] : e);
  } finally {
    await navigateur.close();
    console.log(`Prechauffage de Vite : ${Math.round((Date.now() - t1) / 1000)} s`);
  }
}
