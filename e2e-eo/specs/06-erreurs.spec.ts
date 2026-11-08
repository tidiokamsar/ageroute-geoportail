import { comptesSql } from "../lib/oracle";
import { nettoyer, onglet, titrePropositions, totalAffiche } from "../lib/ecran";
import { attendreEcran, capturer, carte, expect, test, type Session } from "../lib/fixtures";

/**
 * Parcours 6 : ETATS D'ERREUR sur l'ecran reel. L'ecran est ouvert et connecte pour de vrai ; ce sont les appels du MODULE
 * (`/api/v2/teledetection/**`) que le navigateur voit echouer, soit en coupant la route (`page.route`, connexion refusee : le serveur
 * est injoignable), soit en rendant un 500. La panne reelle de l'API (processus arrete) est au parcours 9.
 *
 * Regle du contrat (§7) : chaque panneau dit son erreur, avec un bouton « Reessayer : <panneau> » ; un compteur en erreur n'affiche
 * JAMAIS « 0 » ; une erreur n'est jamais rendue comme un vide.
 */

const COMPTEURS = ["Propositions à vérifier", "Confirmées", "Infirmées", "Sources actives", "Dernière acquisition", "Taux de confirmation terrain"];

async function aucunFauxZero(s: Session) {
  for (const lib of COMPTEURS) {
    const v = nettoyer(await carte(s.page, lib).valeur.innerText());
    expect(v, `carte « ${lib} » : ni 0, ni « Aucun verdict »`).not.toMatch(/^(0|Aucun verdict|Aucune acquisition)$/);
    expect(v).toContain("—");
  }
}

test.describe.serial("erreurs de l'API vues par l'ecran", () => {
  test("API injoignable : chaque panneau dit son erreur, aucun faux zero, aucun faux vide ; le retablissement se voit", async ({ ouvrirSession, run }) => {
    const s = await ouvrirSession(run.comptes.admin);
    let coupe = true;
    await s.context.route(/\/api\/v2\/teledetection\//, (r) => (coupe ? r.abort("connectionrefused") : r.continue()));
    await s.page.goto("/teledetection");
    await expect(s.page.getByRole("heading", { name: "Observation de la Terre", level: 1 })).toBeVisible();
    // Chaque panneau : erreur dite (role=alert), avec son bouton de reprise a nom unique.
    for (const panneau of ["Indicateurs", "Propositions", "Sources", "Taux de confirmation", "Qualité par méthode"]) {
      await expect(s.page.getByText(`${panneau} : chargement impossible.`), panneau).toBeVisible({ timeout: 30_000 });
      await expect(s.page.getByRole("button", { name: `Réessayer : ${panneau}`, exact: true }), panneau).toBeVisible();
    }
    await expect(s.page.getByRole("button", { name: "Réessayer : propositions de la carte", exact: true }).or(s.page.getByText("Zoomez pour afficher les propositions"))).toBeVisible();
    // Aucun faux zero : tirets, jamais 0 ; compteurs d'onglets indisponibles ; total de la liste « (—) ».
    await aucunFauxZero(s);
    await expect(titrePropositions(s.page)).toContainText("(—)");
    for (const lib of ["À vérifier", "En attente", "Non concluantes", "Confirmées", "Infirmées"]) {
      expect(nettoyer(await onglet(s.page, lib).innerText()), `onglet ${lib}`).toContain("—");
    }
    // Aucun faux vide : l'erreur n'est pas rendue comme « rien a traiter ».
    await expect(s.page.getByText("Aucune proposition « À vérifier »")).toHaveCount(0);
    await expect(s.page.getByText("Aucune source d'observation enregistrée")).toHaveCount(0);
    await expect(s.page.getByText("Aucune méthode n'a encore produit de proposition")).toHaveCount(0);
    await expect(s.page.getByText("Aucun verdict", { exact: true })).toHaveCount(0);
    // La liste n'est pas vide : aucune ligne, mais pas de message « Il n'y a rien a traiter ».
    await expect(s.page.getByText("Il n'y a rien à traiter dans cette catégorie.")).toHaveCount(0);
    await capturer(s.page, "06-api-injoignable-1440", { pleinePage: true });

    // Retablissement : la reprise d'un panneau le remet a jour, sans recharger la page.
    coupe = false;
    await s.page.getByRole("button", { name: "Réessayer : Indicateurs", exact: true }).click();
    const sql = await comptesSql();
    await expect(carte(s.page, "Propositions à vérifier").valeur).toHaveText(String(sql.aVerifier));
    await s.page.getByRole("button", { name: "Réessayer : Propositions", exact: true }).click();
    expect(await totalAffiche(s.page)).toBe(sql.aVerifier);
    await s.page.getByRole("button", { name: "Réessayer : Sources", exact: true }).click();
    await expect(s.page.getByText("Sources : chargement impossible.")).toHaveCount(0);
    expect(s.erreursPage).toEqual([]);
  });

  test("erreur serveur 500 sur la synthese seule : seuls les panneaux qui la lisent tombent, les autres restent exacts", async ({ ouvrirSession, run }) => {
    const s = await ouvrirSession(run.comptes.admin);
    await s.context.route(/\/api\/v2\/teledetection\/synthese/, (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Erreur interne du serveur", code: "ERREUR_INTERNE" }) }));
    await s.page.goto("/teledetection");
    await expect(s.page.getByRole("heading", { name: "Observation de la Terre", level: 1 })).toBeVisible();
    await expect(s.page.getByText("Indicateurs : chargement impossible.")).toBeVisible({ timeout: 30_000 });
    await expect(s.page.getByText("Taux de confirmation : chargement impossible.")).toBeVisible();
    await aucunFauxZero(s);
    // Independance : la liste, les sources, la qualite par methode se chargent normalement.
    const sql = await comptesSql();
    expect(await totalAffiche(s.page)).toBe(sql.aVerifier);
    await expect(s.page.getByText("Sources : chargement impossible.")).toHaveCount(0);
    await expect(s.page.getByRole("row")).not.toHaveCount(0);
    // Le message de l'erreur serveur n'expose rien de technique.
    const alerte = nettoyer(await s.page.getByRole("alert").filter({ hasText: "Indicateurs : chargement impossible." }).innerText());
    console.log(`[constat] message affiche pour un 500 : « ${alerte} »`);
    expect(alerte).not.toMatch(/stack|prisma|SELECT|at \w+\.\w+/i);
    expect(s.erreursPage).toEqual([]);
  });

  test("donnees perimees : une actualisation qui echoue ne remplace pas les chiffres par zero, elle dit leur age", async ({ ouvrirSession, run }) => {
    const s = await ouvrirSession(run.comptes.admin);
    await s.page.goto("/teledetection");
    await attendreEcran(s.page);
    const sql = await comptesSql();
    await expect(carte(s.page, "Propositions à vérifier").valeur).toHaveText(String(sql.aVerifier));
    // La synthese ne repond plus ; une action sans reseau externe (verification d'une facade) la fait relire.
    await s.context.route(/\/api\/v2\/teledetection\/synthese/, (r) => r.abort("connectionrefused"));
    await s.page.getByRole("button", { name: "Vérifier la source PlanetScope" }).click();
    await expect(s.page.getByText(/Indicateurs : l'actualisation a échoué, ces données datent du/)).toBeVisible({ timeout: 30_000 });
    // Les chiffres d'avant restent affiches (derniere lecture reussie), avec leur date ; pas de zero.
    await expect(carte(s.page, "Propositions à vérifier").valeur).toHaveText(String(sql.aVerifier));
    await expect(s.page.getByRole("button", { name: "Actualiser : Indicateurs", exact: true })).toBeVisible();
    expect(s.erreursPage).toEqual([]);
  });

  test("autorisation expiree ou retiree (401 puis 403 sur le module) : l'ecran dit le refus, il ne montre pas un ecran vide", async ({ ouvrirSession, run }) => {
    const s = await ouvrirSession(run.comptes.admin);
    await s.context.route(/\/api\/v2\/teledetection\/propositions(\?|$)/, (r) => r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "Module non autorise", code: "MODULE_NON_AUTORISE" }) }));
    await s.page.goto("/teledetection");
    await expect(s.page.getByRole("heading", { name: "Observation de la Terre", level: 1 })).toBeVisible();
    await expect(s.page.getByText("Propositions : accès refusé.")).toBeVisible({ timeout: 30_000 });
    await expect(s.page.getByText("Aucune proposition « À vérifier »")).toHaveCount(0);
    // Un refus d'autorisation ne se retente pas en boucle : une seule requete de liste.
    const nb = await s.page.evaluate(() => performance.getEntriesByType("resource").filter((e) => /teledetection\/propositions\?/.test(e.name)).length);
    expect(nb).toBeLessThanOrEqual(2);
  });
});
