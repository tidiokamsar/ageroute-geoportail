import { expect, seConnecter, seDeconnecter, test } from "../lib/fixtures";

/**
 * Parcours 1 : connexion. Navigateur reel, API reelle, cookie reel.
 * Defauts E2E-1 (message d'un mauvais mot de passe) corrige : ce test ne porte plus de `test.fail`.
 */
test.describe("connexion", () => {
  test("un agent se connecte par l'interface et arrive sur le tableau de bord", async ({ ouvrirProfil, run }) => {
    const { page, context } = await ouvrirProfil();
    await seConnecter(page, run.comptes.agentA);

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText("INSPECTEUR", { exact: true })).toBeVisible();

    // Le jeton de rafraichissement vit dans un cookie HttpOnly, SameSite=Strict, limite a /api/auth.
    const cookies = await context.cookies();
    const rt = cookies.find((c) => c.name === "bdri_rt");
    expect(rt, "cookie de session bdri_rt").toBeTruthy();
    expect(rt!.httpOnly).toBe(true);
    expect(rt!.sameSite).toBe("Strict");
    expect(rt!.path).toBe("/api/auth");
    // Illisible depuis le JavaScript de la page.
    expect(await page.evaluate(() => document.cookie)).not.toContain("bdri_rt");
    // Aucun jeton dans le stockage de la page.
    const stockage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stockage).not.toMatch(/eyJ/);
  });

  test("un mauvais mot de passe est refuse (401) et n'ouvre aucune session", async ({ ouvrirProfil, run }) => {
    const { page, context } = await ouvrirProfil();
    await page.goto("/login");
    await page.getByRole("textbox", { name: "E-mail" }).fill(run.comptes.agentB.email);
    await page.getByPlaceholder("Mot de passe").fill("mot-de-passe-faux-0123456789");
    const [reponse] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/auth/login")),
      page.getByRole("button", { name: "Se connecter" }).click(),
    ]);
    expect(reponse.status()).toBe(401);
    await expect(page).toHaveURL(/\/login/);
    expect((await context.cookies()).some((c) => c.name === "bdri_rt")).toBe(false);
    await expect(page.getByRole("button", { name: "Déconnexion" })).toHaveCount(0);
  });

  test("un mauvais mot de passe affiche un message a l'agent (defaut E2E-1 corrige)", async ({ ouvrirProfil, run }) => {
    const { page } = await ouvrirProfil();
    await page.goto("/login");
    await page.getByRole("textbox", { name: "E-mail" }).fill(run.comptes.agentB.email);
    await page.getByPlaceholder("Mot de passe").fill("mot-de-passe-faux-0123456789");
    await page.getByRole("button", { name: "Se connecter" }).click();
    // Le message est dans une alerte et RESTE : la page ne se recharge plus.
    const alerte = page.getByRole("alert").filter({ hasText: "E-mail ou mot de passe incorrect" });
    await expect(alerte).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(alerte).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("les champs de la page de connexion ont une etiquette accessible (E2E-3)", async ({ ouvrirProfil }) => {
    // E2E-3 (accessibilite) : corrige le 27/10/2026 (aria-label sur les deux champs de LoginPage).
    const { page } = await ouvrirProfil();
    await page.goto("/login");
    await expect(page.getByLabel("Mot de passe")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByLabel("E-mail")).toBeVisible({ timeout: 5_000 });
  });

  test("la session survit a un rechargement de page (jeton de rafraichissement en cookie)", async ({ ouvrirProfil, run }) => {
    const { page } = await ouvrirProfil();
    await seConnecter(page, run.comptes.agentA);
    await page.reload();
    await expect(page.getByRole("button", { name: "Déconnexion" })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  });

  test("la deconnexion demande confirmation, efface la session ; un ecran protege renvoie alors a la connexion", async ({ ouvrirProfil, run }) => {
    const { page, context } = await ouvrirProfil();
    await seConnecter(page, run.comptes.agentA);
    // Annuler laisse la session ouverte.
    const texte = await seDeconnecter(page, { confirmer: false });
    expect(texte).toContain("Aucune donnée n'est supprimée de ce téléphone");
    await page.getByRole("dialog", { name: "Se déconnecter ?" }).getByRole("button", { name: "Annuler" }).click();
    await expect(page.getByRole("button", { name: "Déconnexion" })).toBeVisible();

    await seDeconnecter(page);
    expect((await context.cookies()).some((c) => c.name === "bdri_rt")).toBe(false);

    await page.goto("/inspections/terrain/observations");
    await expect(page).toHaveURL(/\/login/);
  });
});
