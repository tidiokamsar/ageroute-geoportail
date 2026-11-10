import { randomUUID } from "node:crypto";
import { expect, seConnecter, test } from "../lib/fixtures";
import { ApiVoirie, BASE, codeProjet, creerCompte, exigerAccessible, ouvrirProjet, type CompteVoirie } from "../lib/voirie";
import { AXES, geojson, type Ligne } from "../lib/voirie-geo";

/**
 * Lot C1 bis, scenario g : accessibilite des ecrans de la vague 3 dans Chromium reel (axe-core 4.14 du frontend, WCAG 2.0/2.1 A et AA, contraste
 * compris ; la carte Leaflet est exclue, voir lib/voirie.ts). Ecrans : Parametres du module (trois onglets, dialogue de creation d'un territoire),
 * liste des projets avec le filtre par territoire, dialogue de creation d'un projet (selecteur de territoire), onglet Sources (source unique,
 * comparaison et resultats). Les documents du projet, l'export du dossier et les tableaux de bord n'ont PAS d'ecran (lot UI-C) : rien a parcourir,
 * le test le constate sur la fiche (aucun onglet ni lien de ces fonctions).
 */

test.describe.configure({ mode: "serial" });

const suffixe = randomUUID().slice(0, 6).toUpperCase();
let admin: CompteVoirie;
let gestionnaire: CompteVoirie;

test.beforeAll(async () => {
  admin = await creerCompte("e2e-a11y-admin", "Admin Accessibilite C1bis", "ADMIN");
  gestionnaire = await creerCompte("e2e-a11y-gest", "Gestionnaire Accessibilite C1bis", "GESTIONNAIRE");
});

/** Attend un ecran stable puis passe axe (rejoue sur 15 s : une animation de dialogue peut fausser le contraste au premier passage). */
const verifier = (page: import("@playwright/test").Page, contexte: string, racine?: string) =>
  expect(async () => exigerAccessible(page, contexte, racine ? { racine } : {})).toPass({ timeout: 15_000 });

test("g. Paramètres du module : onglets Territoires, Référentiels, Configuration et dialogue de création, sans violation", async ({ ouvrirProfil }) => {
  const { page } = await ouvrirProfil();
  await seConnecter(page, admin);
  await page.goto("/projets-voirie/parametres");
  await expect(page.getByRole("heading", { level: 1, name: "Paramètres du module" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Arborescence des territoires" })).toBeVisible();
  await verifier(page, "parametres, onglet Territoires", "main");
  await page.getByRole("button", { name: "Sous-territoire de Guinée", exact: true }).click();
  const d = page.getByRole("dialog", { name: "Nouveau territoire sous « Guinée »" });
  await d.getByRole("radio", { name: "Rectangle par ses quatre bornes" }).check();
  await verifier(page, "dialogue de creation d'un territoire (bornes)", '[role="dialog"]');
  await d.getByRole("button", { name: "Annuler" }).click();
  await expect(d).toHaveCount(0);
  await page.getByRole("tab", { name: "Référentiels" }).click();
  await expect(page.getByRole("tab", { name: "Référentiels" })).toHaveAttribute("aria-selected", "true");
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await verifier(page, "parametres, onglet Referentiels", "main");
  await page.getByRole("tab", { name: "Configuration nationale" }).click();
  // Une fiche par cle de configuration (libelles humains, pas les cles) : on attend les quatre, chargees depuis GET /configuration.
  await expect(page.getByRole("heading", { level: 2, name: "Configuration nationale" })).toBeVisible();
  await expect(page.locator('article[aria-labelledby^="pv-cfg-"]')).toHaveCount(4);
  await verifier(page, "parametres, onglet Configuration nationale", "main");
  // Clavier : les onglets se parcourent aux fleches (WAI-ARIA).
  await page.getByRole("tab", { name: "Configuration nationale" }).focus();
  await page.keyboard.press("Home");
  await expect(page.getByRole("tab", { name: "Territoires" })).toBeFocused();
});

test("g. liste des projets (filtre par territoire) et création d'un projet (sélecteur de territoire), sans violation", async ({ ouvrirProfil }) => {
  const { page } = await ouvrirProfil();
  await seConnecter(page, gestionnaire);
  await page.goto("/projets-voirie");
  await expect(page.getByRole("heading", { level: 1, name: "Projets de voirie et réseaux" })).toBeVisible();
  await page.getByRole("button", { name: "Filtrer par territoire" }).click();
  await expect(page.locator("#pv-filtre-territoire").getByRole("radio").first()).toBeVisible();
  await verifier(page, "liste des projets, filtre par territoire ouvert", "main");
  await page.getByRole("button", { name: "Nouveau projet" }).click();
  const d = page.getByRole("dialog", { name: "Nouveau projet de voirie et réseaux" });
  await expect(d.getByRole("radio").first()).toBeVisible();
  await verifier(page, "dialogue de creation d'un projet (selecteur de territoire)", '[role="dialog"]');
  // Refus local sans territoire : l'erreur est annoncee (role alert) et reste accessible.
  await d.getByLabel("Code du projet").fill(`E2E-A11Y-${suffixe}`);
  await d.getByLabel("Nom du projet").fill("Projet accessibilite synthetique");
  await d.getByRole("button", { name: "Créer le projet" }).click();
  await expect(d.getByRole("alert").filter({ hasText: "Choisissez le territoire du projet" })).toBeVisible();
  await verifier(page, "dialogue de creation, erreur de territoire", '[role="dialog"]');
});

test("g. onglet Sources : source unique, puis comparaison et résultats, sans violation ; aucun écran de documents, d'export ni de tableau de bord", async ({ ouvrirProfil, marqueur }) => {
  const g = await ApiVoirie.connecter(gestionnaire);
  const code = codeProjet(marqueur, "A11Y-SRC");
  const projetId = await g.creerProjet(code);
  const conc = await g.creerConcessionnaire(`Operateur synthetique A11Y ${suffixe}`, "TELECOM");
  await g.deposerEtAutoriser(projetId, { name: "axes-a11y.geojson", buffer: geojson(AXES) }, { role: "AXES_TRAVAUX" });
  const lignes: Ligne[] = [{ nom: "Cable-Synth A1", coords: [[0, 30], [100, 30]] }, { nom: "Cable-Synth A2", coords: [[0, 60], [100, 60]] }];
  const a = await g.deposerEtAutoriser(projetId, { name: "source-gnss.geojson", buffer: geojson(lignes) }, { role: "RESEAU_TIERS", concessionnaireId: conc, methodeAcquisition: "GNSS_RTK", precisionHorizontaleM: "0.5" });

  const { page } = await ouvrirProfil();
  await seConnecter(page, gestionnaire);
  await ouvrirProjet(page, projetId, `Projet ${code}`);
  // La fiche n'a que cinq onglets : aucun ecran de documents, d'export ni de tableau de bord (fonctions livrees cote serveur seulement).
  const onglets = page.getByRole("tablist").first().getByRole("tab");
  await expect(onglets).toHaveText(["Analyse", "Couches", "Conflits", "Réseaux", "Sources"]);
  await expect(page.getByRole("link", { name: /Tableau de bord du module|Documents du projet|Exporter le dossier/ })).toHaveCount(0);
  await page.getByRole("tab", { name: "Sources" }).click();
  await expect(page.getByTestId("source-unique").first()).toBeVisible();
  await verifier(page, "onglet Sources, source unique", '[role="tabpanel"]');

  const b = await g.deposerEtAutoriser(projetId, { name: "source-plan.geojson", buffer: geojson(lignes.map((l, i) => ({ ...l, coords: l.coords.map(([x, y]) => [x, y + (i === 1 ? 3 : 0.2)] as [number, number]) }))) },
    { role: "RESEAU_TIERS", concessionnaireId: conc, methodeAcquisition: "NUMERISATION_PLAN", precisionHorizontaleM: "1" });
  const c = await g.comparer(projetId, a, b);
  expect(c.statut, c.texte.slice(0, 300)).toBe(201);
  await page.reload();
  await page.getByRole("tab", { name: "Sources" }).click();
  await page.getByRole("button", { name: /Voir le détail de la comparaison/ }).first().click();
  await expect(page.getByRole("list", { name: "Résultats par objet" })).toBeVisible();
  await verifier(page, "onglet Sources, comparaison et resultats", '[role="tabpanel"]');
  await page.getByRole("button", { name: "Ouvrir un dossier de divergence" }).first().click();
  await expect(page.getByRole("dialog", { name: "Ouvrir un dossier de divergence" })).toBeVisible();
  await verifier(page, "dialogue d'ouverture d'un dossier de divergence", '[role="dialog"]');
  // Aucune ecriture : le dialogue est ferme sans valider.
  await page.getByRole("dialog", { name: "Ouvrir un dossier de divergence" }).getByRole("button", { name: "Annuler" }).click();
  expect((await g.get(`${BASE}/${projetId}/conflits?limite=200`)).corps.conflits.filter((x: { type: string }) => x.type === "DIVERGENCE_SOURCES")).toHaveLength(0);
  await g.fermer();
});
