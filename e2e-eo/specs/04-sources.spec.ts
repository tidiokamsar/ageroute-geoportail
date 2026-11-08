import { compter, requete } from "../lib/base";
import { api, comptesSql } from "../lib/oracle";
import { nettoyer } from "../lib/ecran";
import { attendreEcran, capturer, carte, expect, test } from "../lib/fixtures";
import type { Page } from "@playwright/test";

/**
 * Parcours 4 : les SOURCES. Tableau d'etat lu en base, bouton « Verifier » (ADMIN seulement) qui appelle le VRAI catalogue Copernicus
 * (recherche anonyme, une requete), aucune source « Active ».
 */

const LIBELLE_ETAT: Record<string, string> = {
  NON_CONFIGUREE: "Non configurée", CONFIGUREE: "Configurée, non testée", AUTHENTIFIEE: "Authentifiée", ACCESSIBLE: "Catalogue accessible",
  PRODUIT_DISPONIBLE: "Produits disponibles", TRAITEMENT_OPERATIONNEL: "Active", EN_ERREUR: "En erreur", EN_ATTENTE_CONFIGURATION: "Identifiants requis",
};

const tableau = (page: Page) => page.locator('section[aria-labelledby="titre-sources"]');
const ligne = (page: Page, nom: string) => tableau(page).getByRole("row").filter({ has: page.getByRole("rowheader", { name: new RegExp(`^${nom}`) }) });

test.describe.serial("sources d'observation", () => {
  test("tableau : les quatre sources dans l'etat enregistre en base, aucune « Active »", async ({ ouvrirSession, run }) => {
    const s = await ouvrirSession(run.comptes.admin);
    await s.page.goto("/teledetection");
    await attendreEcran(s.page);
    const base = await requete<{ code: string; nom: string; etat: string; dernierMessage: string | null; requiertIdentifiants: boolean }>(
      `SELECT code, nom, etat, "dernierMessage", "requiertIdentifiants" FROM sources_observation WHERE "deletedAt" IS NULL ORDER BY code`);
    expect(base.map((b) => b.code)).toEqual(["LANDSAT89", "PLANETSCOPE", "SENTINEL2", "SPOT"]);
    const T = tableau(s.page);
    await expect(T.getByRole("row")).toHaveCount(base.length + 1); // + l'en-tete
    for (const b of base) {
      const l = ligne(s.page, b.nom);
      await expect(l).toHaveCount(1);
      await expect(l).toContainText(LIBELLE_ETAT[b.etat]);
      if (b.dernierMessage) await expect(l).toContainText(b.dernierMessage.slice(0, 40));
      if (b.requiertIdentifiants) await expect(l).toContainText("Identifiants requis côté serveur");
    }
    // Aucune « Active » : ni ligne du tableau, ni compteur d'en-tete, ni carte de synthese, ni API.
    // On cible le TABLEAU (les pastilles d'etat). La section contient aussi la legende repliee « Echelle d'etat des sources », ou
    // « Active » est le NOM d'une etape expliquee (<strong>Active</strong>), pas un etat affiche : la premiere version du test la comptait.
    const cellulesEtat = T.getByRole("table").getByRole("row").locator("td:nth-child(2)");
    await expect(cellulesEtat).toHaveCount(base.length);
    await expect(T.getByRole("table").getByText("Active", { exact: true })).toHaveCount(0);
    for (const b of base) expect(b.etat, `source ${b.code} en base`).not.toBe("TRAITEMENT_OPERATIONNEL");
    // La legende, elle, DOIT dire ce que « Active » veut dire (le nom de l'etape y figure une seule fois, hors tableau).
    await expect(T.locator("details").getByText("Active", { exact: true })).toHaveCount(1);
    await expect(T.getByText("0 active sur 4 enregistrées")).toBeVisible();
    await expect(carte(s.page, "Sources actives").valeur).toHaveText("0");
    const serveur = (await api(run.comptes.admin, "GET", "/sources")).corps as { code: string; etat: string; active: boolean }[];
    expect(serveur.map((x) => [x.code, x.etat])).toEqual(base.map((b) => [b.code, b.etat]));
    expect(serveur.every((x) => x.active === false)).toBe(true);
    // Sentinel-2 n'est PAS marquee active malgre ses produits reels en base : un nom de fournisseur ou des metadonnees ne suffisent pas.
    expect(await compter(`SELECT count(*) FROM earth_observation_products WHERE "sourceCode" = 'SENTINEL2'`)).toBeGreaterThan(0);
    await expect(T.getByText("Seule la mention « Active » signifie")).toBeHidden(); // dans le repliable, ferme
    await T.getByText("Échelle d'état des sources").click();
    await expect(T.getByText("Seule la mention « Active » signifie qu'un traitement réel alimente des propositions.")).toBeVisible();
    expect(s.erreursPage).toEqual([]);
  });

  test("« Verifier » Sentinel-2 : appel REEL au catalogue Copernicus, l'etat enregistre est celui que l'ecran affiche", async ({ ouvrirSession, run }) => {
    const s = await ouvrirSession(run.comptes.admin);
    await s.page.goto("/teledetection");
    await attendreEcran(s.page);
    const etatsAvant = await compter(`SELECT count(*) FROM sources_observation_etats`);
    const auditAvant = await compter(`SELECT count(*) FROM audit_logs WHERE "entityType" = 'SourceObservation' OR action::text = 'VERIFIER_CONNECTIVITE'`);
    const t0 = Date.now();
    const [rep] = await Promise.all([
      s.page.waitForResponse((r) => /\/sources\/[^/]+\/verifier/.test(r.url()) && r.request().method() === "POST", { timeout: 60_000 }),
      s.page.getByRole("button", { name: "Vérifier la source Sentinel-2" }).click(),
    ]);
    const ms = Date.now() - t0;
    const corps = await rep.json();
    // Base : la ligne de la source porte l'etat mesure, la date du test et son message.
    const [src] = await requete<{ etat: string; dernierMessage: string; derniereVerificationLe: Date | null }>(
      `SELECT etat, "dernierMessage", "derniereVerificationLe" FROM sources_observation WHERE code = 'SENTINEL2'`);
    expect(src.derniereVerificationLe).not.toBeNull();
    expect(src.dernierMessage.length).toBeGreaterThan(10);
    console.log(`[constat verification reelle] HTTP ${rep.status()} en ${ms} ms ; etat enregistre : ${src.etat} ; message : ${src.dernierMessage}`);
    expect(["PRODUIT_DISPONIBLE", "ACCESSIBLE", "EN_ERREUR"]).toContain(src.etat);
    // Jamais « active » : un test de catalogue ne prouve pas un traitement.
    expect(src.etat).not.toBe("TRAITEMENT_OPERATIONNEL");
    if (src.etat === "EN_ERREUR") {
      expect(rep.status()).toBe(503);
      expect(corps.code).toBe("SOURCE_INDISPONIBLE");
      await expect(s.page.getByRole("alert").filter({ hasText: "Vérification de Sentinel-2 impossible" })).toBeVisible();
    } else {
      expect(rep.status()).toBe(200);
      expect(corps.source.etat).toBe(src.etat);
      await expect(s.page.getByText("Vérification de Sentinel-2 terminée. L'état affiché est celui que le serveur a mesuré.")).toBeVisible();
    }
    // L'ecran affiche l'etat ET le message enregistres.
    const l = ligne(s.page, "Sentinel-2");
    await expect(l).toContainText(LIBELLE_ETAT[src.etat]);
    await expect(l).toContainText(src.dernierMessage.slice(0, 50));
    // Historique des etats : une ligne de plus, ecrite par l'ADMIN ; trace d'audit.
    expect(await compter(`SELECT count(*) FROM sources_observation_etats`)).toBeGreaterThan(etatsAvant);
    expect(await compter(`SELECT count(*) FROM audit_logs WHERE "entityType" = 'SourceObservation' OR action::text = 'VERIFIER_CONNECTIVITE'`)).toBeGreaterThan(auditAvant);
    const [dernier] = await requete<{ vers: string; auteurId: string | null }>(`SELECT vers, "auteurId" FROM sources_observation_etats e JOIN sources_observation s ON s.id = e."sourceId" WHERE s.code = 'SENTINEL2' ORDER BY "creeLe" DESC LIMIT 1`);
    expect(dernier.vers).toBe(src.etat);
    expect(dernier.auteurId).toBe(run.comptes.admin.id);
    // Toujours aucune source active.
    expect(await compter(`SELECT count(*) FROM sources_observation WHERE etat = 'TRAITEMENT_OPERATIONNEL'`)).toBe(0);
    await expect(carte(s.page, "Sources actives").valeur).toHaveText("0");
    const synthese = (await api(run.comptes.admin, "GET", "/synthese")).corps;
    expect(synthese.sources.actives).toBe(0);
    expect(synthese.sources.parEtat[src.etat]).toBeGreaterThanOrEqual(1);
    await capturer(s.page, "04-sources-apres-verification-1440");
    expect(s.erreursPage).toEqual([]);
  });

  test("« Verifier » une source a identifiants (facade) : aucune requete reseau, l'etat reste « Identifiants requis » ; un double clic = un seul appel", async ({ ouvrirSession, run }) => {
    const s = await ouvrirSession(run.comptes.admin);
    await s.page.goto("/teledetection");
    await attendreEcran(s.page);
    const appels: string[] = [];
    s.page.on("request", (r) => { if (r.method() === "POST" && /\/verifier$/.test(r.url())) appels.push(r.url()); });
    await s.page.getByRole("button", { name: "Vérifier la source PlanetScope" }).dblclick();
    await expect(s.page.getByText(/Vérification de PlanetScope (terminée|impossible)/)).toBeVisible();
    await s.page.waitForTimeout(600);
    expect(appels).toHaveLength(1);
    const [src] = await requete<{ etat: string }>(`SELECT etat FROM sources_observation WHERE code = 'PLANETSCOPE'`);
    expect(src.etat).toBe("EN_ATTENTE_CONFIGURATION");
    await expect(ligne(s.page, "PlanetScope")).toContainText("Identifiants requis");
    expect(await compter(`SELECT count(*) FROM sources_observation WHERE etat = 'TRAITEMENT_OPERATIONNEL'`)).toBe(0);
  });

  test("GESTIONNAIRE : le tableau est visible, aucun bouton « Verifier », aucun bouton d'en-tete ; l'API refuse (403 ROLE_INSUFFISANT)", async ({ ouvrirSession, run }) => {
    const s = await ouvrirSession(run.comptes.gestNational);
    await s.page.goto("/teledetection");
    await attendreEcran(s.page);
    await expect(tableau(s.page).getByRole("row")).toHaveCount(5);
    await expect(s.page.getByRole("button", { name: /^Vérifier la source/ })).toHaveCount(0);
    await expect(s.page.getByRole("button", { name: "État des sources" })).toHaveCount(0);
    const r = await api(run.comptes.gestNational, "POST", "/sources/cdse-stac/verifier", {});
    expect(r.status).toBe(403);
    expect(r.corps.code).toBe("ROLE_INSUFFISANT");
    expect(s.ecritures).toEqual([]);
    // Comme l'ADMIN : memes etats (lus en base).
    const sql = await comptesSql();
    expect(sql.total).toBeGreaterThan(0);
    expect(nettoyer(await tableau(s.page).innerText())).toContain("Sentinel-2");
  });
});
