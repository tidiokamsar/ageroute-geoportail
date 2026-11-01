import { inspectionsAvecMarqueur, observationsAvecMarqueur, requete } from "../lib/base";
import { DELAI_SYNC_MS } from "../lib/env";
import {
  expect, ouvrirInspection, ouvrirObservations, remplirInspection, saisirInspection, saisirObservation, seConnecter, test,
} from "../lib/fixtures";
import { lireFile } from "../lib/idb";

/**
 * Parcours 2 : saisies terrain faites EN LIGNE, puis verification cote serveur (lecture de la base).
 * Les ecrans de la file locale exigent maintenant le code PIN : creation la premiere fois sur l'appareil.
 * Defaut E2E-2 (un INSPECTEUR recevait 403 sur POST /api/inspections) corrige : plus de `test.fail`.
 */
test.describe("saisie terrain en ligne", () => {
  test("le PIN est demande a la premiere ouverture d'un ecran de terrain, jamais ailleurs", async ({ ouvrirProfil, run }) => {
    const { page } = await ouvrirProfil();
    await seConnecter(page, run.comptes.agentA);
    // Le tableau de bord n'utilise pas la file locale : aucun PIN.
    await expect(page.getByRole("heading", { name: "Créez votre code PIN" })).toHaveCount(0);
    await page.goto("/inspections/terrain/observations");
    await expect(page.getByRole("heading", { name: "Créez votre code PIN" })).toBeVisible();
    // Le texte dit ce que le code protege et ce qu'il ne protege pas.
    await expect(page.getByText("ralentit son attaque mais ne la rend pas impossible")).toBeVisible();
    await expect(page.getByText("les saisies non envoyées de ce téléphone seront perdues")).toBeVisible();
    // Un code trop court est refuse avec un message, rien n'est cree.
    await page.getByLabel("Code PIN", { exact: true }).fill("123");
    await page.getByLabel("Confirmez le code").fill("123");
    await page.getByRole("button", { name: "Créer mon code" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Créez votre code PIN" })).toBeVisible();
  });

  test("une observation saisie en ligne arrive en base, une seule fois, et la file locale se vide", async ({ ouvrirProfil, run, marqueur }) => {
    const { page } = await ouvrirProfil();
    await ouvrirObservations(page, run.comptes.agentA);

    await saisirObservation(page, { type: "DEGRADATION", gravite: "FORTE", description: `${marqueur} nid de poule en bord de chaussee` });

    await expect.poll(async () => (await observationsAvecMarqueur(marqueur)).length, { timeout: DELAI_SYNC_MS }).toBe(1);
    const [obs] = await observationsAvecMarqueur(marqueur);
    expect(obs).toMatchObject({ type: "DEGRADATION", gravite: "FORTE", statut: "PROPOSEE", agentId: run.comptes.agentA.id });
    // La cle d'idempotence du serveur est celle que le telephone a generee.
    expect(obs.clientOperationId).toMatch(/^[0-9a-f-]{36}$/);

    // L'ecran dit que plus rien n'attend, et IndexedDB (le vrai, celui du compte) est vide.
    await expect(page.getByText("Aucune observation en attente sur ce téléphone.")).toBeVisible();
    await expect.poll(async () => (await lireFile(page, "pending_observations", run.comptes.agentA.id)).length).toBe(0);

    // Regle 3 d'AGENTS.md : toute ecriture est auditee.
    const audit = await requete<{ action: string; userId: string }>(
      `SELECT action::text AS action, "userId" FROM audit_logs WHERE "entityType" = 'Observation' AND "entityId" = $1`, [obs.id]);
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0].userId).toBe(run.comptes.agentA.id);
  });

  test("une inspection saisie en ligne par un ADMIN arrive en base avec son troncon, une seule fois", async ({ ouvrirProfil, run, marqueur }) => {
    const { page } = await ouvrirProfil();
    await seConnecter(page, run.comptes.admin);
    await saisirInspection(page, run.comptes.admin, run.troncons[0].id, marqueur);

    await expect.poll(async () => (await inspectionsAvecMarqueur(marqueur)).length, { timeout: DELAI_SYNC_MS }).toBe(1);
    const [insp] = await inspectionsAvecMarqueur(marqueur);
    expect(insp).toMatchObject({ tronconId: run.troncons[0].id, etatObserve: "MAUVAIS", inspecteurId: run.comptes.admin.id });
    expect(insp.clientInspectionId).toBeTruthy();
    expect(insp.photos).toEqual([]);
    await expect.poll(async () => (await lireFile(page, "pending_inspections", run.comptes.admin.id)).length).toBe(0);
  });

  test("une inspection saisie en ligne par un INSPECTEUR arrive en base (defaut E2E-2 corrige)", async ({ ouvrirProfil, run, marqueur }) => {
    const { page } = await ouvrirProfil();
    await seConnecter(page, run.comptes.agentA);
    await ouvrirInspection(page, run.comptes.agentA);
    await remplirInspection(page, run.troncons[0].id, marqueur);

    await expect.poll(async () => (await inspectionsAvecMarqueur(marqueur)).length, { timeout: DELAI_SYNC_MS }).toBe(1);
    const [insp] = await inspectionsAvecMarqueur(marqueur);
    expect(insp).toMatchObject({ tronconId: run.troncons[0].id, inspecteurId: run.comptes.agentA.id, etatObserve: "MAUVAIS" });
    await expect.poll(async () => (await lireFile(page, "pending_inspections", run.comptes.agentA.id)).length).toBe(0);
  });

  test("le serveur accepte un INSPECTEUR sur POST /api/inspections (sans passer par l'interface)", async ({ ouvrirProfil, run, marqueur }) => {
    const { page } = await ouvrirProfil();
    await seConnecter(page, run.comptes.agentA);
    // Le jeton d'acces vit en memoire de la page : on rafraichit par le cookie, comme l'application, pour parler a l'API.
    const jeton = await page.evaluate(async () => (await (await fetch("/api/auth/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()).accessToken as string);
    const reponse = await page.request.post("/api/inspections", {
      headers: { authorization: `Bearer ${jeton}` },
      data: { clientInspectionId: crypto.randomUUID(), tronconId: run.troncons[0].id, dateInspection: new Date().toISOString().slice(0, 10), etatObserve: "BON", defautsConstates: `${marqueur} direct` },
    });
    expect(reponse.status()).toBe(201);
  });
});
