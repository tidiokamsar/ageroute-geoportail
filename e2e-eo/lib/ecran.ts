import { expect, type Locator, type Page } from "@playwright/test";

/** Gestes et lectures de l'ecran Observation de la Terre (selecteurs : roles et libelles accessibles, comme l'utilisateur). */

export const nettoyer = (t: string | null | undefined) => (t ?? "").replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();

export function titrePropositions(page: Page): Locator { return page.locator("#titre-propositions"); }

/** Lignes de la liste des propositions (boutons `#proposition-<id>`). */
export function lignes(page: Page): Locator { return page.locator('#panneau-propositions button[id^="proposition-"]'); }

export function idDeLigne(id: string | null): string { return (id ?? "").replace(/^proposition-/, ""); }

/** Attend que la liste soit chargee ET donne le total affiche dans le titre « Propositions (N) ». */
export async function totalAffiche(page: Page): Promise<number> {
  await expect(titrePropositions(page)).toContainText(/\(\d[\d\s  ]*\)/);
  const t = nettoyer(await titrePropositions(page).textContent());
  const m = /\(([\d ]+)\)/.exec(t);
  return Number((m?.[1] ?? "").replace(/\s/g, ""));
}

/** Attend le total attendu (le titre passe par « (—) » pendant un rechargement : l'attente reessaie). */
export async function attendreTotal(page: Page, attendu: number, timeout = 30_000): Promise<void> {
  await expect.poll(async () => {
    const t = nettoyer(await titrePropositions(page).textContent());
    const m = /\(([\d ]+)\)/.exec(t);
    return m ? Number(m[1].replace(/\s/g, "")) : -1;
  }, { timeout, message: `total de la liste attendu : ${attendu}` }).toBe(attendu);
}

export function onglet(page: Page, libelle: string): Locator { return page.getByRole("tab", { name: new RegExp(`^${libelle}`) }).first(); }

export async function ouvrirFiltres(page: Page): Promise<void> {
  const b = page.getByRole("button", { name: /^Filtres/ });
  if ((await b.getAttribute("aria-expanded")) !== "true") await b.click();
  await expect(page.getByRole("group", { name: "Filtres des propositions" })).toBeVisible();
}

export async function reinitialiserFiltres(page: Page): Promise<void> {
  await ouvrirFiltres(page);
  const b = page.getByRole("button", { name: "Réinitialiser les filtres" });
  if (await b.isEnabled()) await b.click();
  await page.getByRole("searchbox", { name: "Rechercher dans les propositions" }).fill("");
}

export function panneauDetail(page: Page): Locator { return page.locator('section[aria-labelledby="titre-detail"]'); }

export async function ouvrirDetail(page: Page, id: string): Promise<void> {
  const l = page.locator(`#proposition-${id}`);
  await l.scrollIntoViewIfNeeded();
  await l.click();
  await expect(panneauDetail(page).getByRole("heading", { name: "Détail de la proposition" })).toBeVisible();
  await expect(page.getByText("Chargement de la proposition…")).toHaveCount(0);
  await expect(panneauDetail(page).getByText("Limites connues")).toBeVisible();
}

export async function ongletDetail(page: Page, libelle: "Aperçu" | "Comparaison" | "Terrain" | "Historique"): Promise<void> {
  await panneauDetail(page).getByRole("tab", { name: libelle }).click();
}

/** Les ids de toutes les lignes actuellement affichees, dans l'ordre. */
export async function idsAffiches(page: Page): Promise<string[]> {
  const ids = await lignes(page).evaluateAll((els) => els.map((e) => e.id));
  return ids.map(idDeLigne);
}

/** Un champ du panneau de filtres, par son libelle (le panneau est ouvert avant). Scope au groupe : les marqueurs de la carte portent aussi « priorite ». */
export function filtre(page: Page, libelle: string): Locator {
  return page.getByRole("group", { name: "Filtres des propositions" }).getByLabel(libelle);
}
