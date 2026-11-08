import { execFileSync } from "node:child_process";
import { ORIGINE_API, PORT_API } from "../lib/env";
import { nettoyer, onglet, titrePropositions, totalAffiche } from "../lib/ecran";
import { comptesSql } from "../lib/oracle";
import { attendreEcran, capturer, carte, expect, test } from "../lib/fixtures";

/**
 * Parcours 9 : PANNE REELLE. Le processus de l'API est ARRETE pendant que l'ecran est ouvert et charge. Cette spec est la DERNIERE : plus rien
 * ne peut s'executer ensuite contre l'API (la base, elle, reste lue directement par le parcours suivant s'il y en avait, et supprimee par le
 * nettoyage). Le navigateur parle a Vite, dont le proxy repond 5xx quand l'API est morte.
 */

function pidEnEcoute(port: number): number | null {
  const sortie = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
  for (const l of sortie.split(/\r?\n/)) {
    const m = new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`).exec(l);
    if (m) return Number(m[1]);
  }
  return null;
}

test("l'API s'arrete en cours d'ecran : chaque panneau dit sa panne, les chiffres d'avant sont dits perimes, rien ne tombe a zero", async ({ ouvrirSession, run }) => {
  test.setTimeout(300_000);
  const s = await ouvrirSession(run.comptes.admin);
  await s.page.goto("/teledetection");
  await attendreEcran(s.page);
  const sql = await comptesSql();
  expect(await totalAffiche(s.page)).toBe(sql.aVerifier);
  await expect(carte(s.page, "Propositions à vérifier").valeur).toHaveText(String(sql.aVerifier));

  // --- on tue le processus de l'API (et ses enfants)
  const pid = pidEnEcoute(PORT_API);
  expect(pid, `un processus ecoute sur le port ${PORT_API}`).toBeTruthy();
  execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  await expect.poll(async () => {
    try { await fetch(`${ORIGINE_API}/api/health`, { signal: AbortSignal.timeout(2_000) }); return "ouverte"; } catch { return "arretee"; }
  }, { timeout: 30_000 }).toBe("arretee");

  // --- un nouvel onglet de statut : requete neuve, sans donnees en memoire -> erreur dite, ni liste vide ni « rien a traiter »
  await onglet(s.page, "Non concluantes").click();
  await expect(s.page.getByText("Propositions : chargement impossible.")).toBeVisible({ timeout: 30_000 });
  await expect(s.page.getByRole("button", { name: "Réessayer : Propositions", exact: true })).toBeVisible();
  await expect(titrePropositions(s.page)).toContainText("(—)");
  await expect(s.page.getByText(/Aucune proposition « Non concluantes »/)).toHaveCount(0);
  await expect(s.page.getByText("Il n'y a rien à traiter dans cette catégorie.")).toHaveCount(0);

  // --- une action : la verification d'une source dit son echec, et la relecture de la synthese qui suit n'efface pas les chiffres
  await s.page.getByRole("button", { name: "Vérifier la source PlanetScope" }).click();
  await expect(s.page.getByRole("alert").filter({ hasText: "Vérification de PlanetScope impossible" })).toBeVisible({ timeout: 30_000 });
  await expect(s.page.getByText(/Indicateurs : l'actualisation a échoué, ces données datent du/)).toBeVisible({ timeout: 30_000 });
  await expect(carte(s.page, "Propositions à vérifier").valeur).toHaveText(String(sql.aVerifier)); // derniere lecture reussie, dite perimee
  await expect(s.page.getByText(/Sources : l'actualisation a échoué, ces données datent du/)).toBeVisible({ timeout: 30_000 });

  // --- reprise pendant la panne : l'erreur reste dite, rien ne plante
  await s.page.getByRole("button", { name: "Réessayer : Propositions", exact: true }).click();
  await expect(s.page.getByText("Propositions : chargement impossible.")).toBeVisible({ timeout: 30_000 });
  await capturer(s.page, "09-api-arretee-1440", { pleinePage: true });

  // --- ce que le navigateur a vu : des 5xx du proxy, jamais un 200 vide
  const serveurs = s.reponsesErreur.filter((r) => r.url.includes("/teledetection/"));
  console.log(`[constat] reponses vues pendant la panne : ${[...new Set(serveurs.map((r) => `${r.methode} ${r.status}`))].join(", ")}`);
  expect(serveurs.length).toBeGreaterThan(0);
  expect(serveurs.every((r) => r.status >= 500)).toBe(true);
  const message = nettoyer(await s.page.getByRole("alert").filter({ hasText: "Propositions : chargement impossible." }).innerText());
  console.log(`[constat] message affiche pendant la panne : « ${message} »`);
  expect(s.erreursPage).toEqual([]);
});
