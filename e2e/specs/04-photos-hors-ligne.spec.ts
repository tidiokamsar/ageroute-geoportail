import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { inspectionsAvecMarqueur, mediasDeObservation, observationsParOperation } from "../lib/base";
import { DELAI_SYNC_MS } from "../lib/env";
import {
  coupureReseau, ECRAN_ROULAGE, expect, ouvrirEcranTerrain, ouvrirInspection, remplirInspection, retablirReseau, seConnecter, test,
} from "../lib/fixtures";
import { compterPhotos, contientEnClair, lireFile, lireStockageBrut } from "../lib/idb";
import { pngUnique } from "../lib/image";

/**
 * Parcours 4 : photo attachee a une saisie faite HORS LIGNE, puis synchronisee. L'integrite se verifie par les OCTETS :
 * l'empreinte SHA-256 du fichier recu par le serveur doit etre celle du fichier que l'agent a choisi. Et, hors ligne,
 * AUCUN octet de la photo ne doit etre lisible en clair dans le stockage du navigateur (les photos sont chiffrees, un bloc chacune).
 */
test.describe("photo hors ligne", () => {
  test("observation rapide en roulant avec photo : chiffree hors ligne, puis photo identique octet pour octet en base", async ({ ouvrirProfil, run }) => {
    const { page, context } = await ouvrirProfil();
    const agent = run.comptes.agentA;
    const photo = pngUnique("route-affaissee.png");
    await seConnecter(page, agent);
    await ouvrirEcranTerrain(page, ECRAN_ROULAGE, agent);
    await expect(page.getByRole("heading", { name: "Enregistrer un relevé en roulant" })).toBeVisible();

    // La position vient de l'emulation GPS du navigateur (lib/fixtures.ts) : 9.53, -13.68, precision 5 m.
    await page.getByRole("button", { name: "Démarrer l'enregistrement" }).click();
    await expect(page.getByText(/GPS : signal reçu/)).toBeVisible();

    const rapide = page.getByRole("group", { name: "Observation rapide ici" });
    await coupureReseau(context, page);
    await rapide.getByRole("button", { name: "Dégradation" }).click();
    await rapide.getByLabel("Prendre une photo (facultatif)").setInputFiles(photo);
    await expect(rapide.getByText("1 photo(s) jointe(s)")).toBeVisible();
    await rapide.getByRole("button", { name: "Forte", exact: true }).click();
    await expect(page.getByText("Observation conservée sur ce téléphone").first()).toBeVisible();

    // Dans IndexedDB du compte : une observation et SA photo (un bloc chiffre), rien d'envoye.
    const [entree] = await lireFile(page, "pending_observations", agent.id);
    expect(entree).toMatchObject({ compteId: agent.id, status: "pending", nbPhotos: 1 });
    expect(await compterPhotos(page, agent.id)).toBe(1);
    expect(await observationsParOperation(entree.localId)).toHaveLength(0);

    // Aucun octet de la photo n'est lisible en clair : ni le fichier entier, ni un morceau, ni sa miniature, ni son nom.
    const brut = await lireStockageBrut(page);
    expect(contientEnClair(brut, photo.buffer), "photo entiere en clair").toBe(false);
    expect(contientEnClair(brut, photo.buffer.subarray(40, 120)), "morceau de la photo en clair").toBe(false);
    expect(contientEnClair(brut, "route-affaissee")).toBe(false);

    await retablirReseau(context, page);

    await expect.poll(async () => (await observationsParOperation(entree.localId)).length, { timeout: DELAI_SYNC_MS }).toBe(1);
    const [obs] = await observationsParOperation(entree.localId);
    expect(obs).toMatchObject({ type: "DEGRADATION", gravite: "FORTE", agentId: agent.id });
    // La position est celle du GPS emule, jointe a l'observation.
    expect(obs.lat).toBeCloseTo(9.53, 4);
    expect(obs.lon).toBeCloseTo(-13.68, 4);

    // La photo arrive apres l'observation, une fois, et ses octets sont intacts.
    await expect.poll(async () => (await mediasDeObservation(obs.id)).length, { timeout: DELAI_SYNC_MS }).toBe(1);
    const [media] = await mediasDeObservation(obs.id);
    expect(media.sha256).toBe(photo.sha256);
    expect(media.tailleOctets).toBe(photo.buffer.length);
    expect(media.mimeType).toBe("image/png");
    // La file est vide : l'observation ne quitte la file qu'avec sa derniere photo, et les blocs de photo avec elle.
    await expect.poll(async () => (await lireFile(page, "pending_observations", agent.id)).length).toBe(0);
    await expect.poll(async () => compterPhotos(page, agent.id)).toBe(0);
  });

  test("inspection avec photo saisie hors ligne : chiffree, synchronisee, fichier identique octet pour octet sur le disque du serveur", async ({ ouvrirProfil, run, marqueur }) => {
    const { page, context } = await ouvrirProfil();
    // Un INSPECTEUR peut desormais creer une inspection (defaut E2E-2 corrige) : le test passe par le compte agent.
    const agent = run.comptes.agentA;
    const photo = pngUnique("fissure.png");
    await seConnecter(page, agent);
    await ouvrirInspection(page, agent);

    await coupureReseau(context, page);
    await remplirInspection(page, run.troncons[1].id, marqueur, photo);
    await expect(page.getByText("Inspection enregistrée hors-ligne").first()).toBeVisible();

    const [entree] = await lireFile(page, "pending_inspections", agent.id);
    expect(entree).toMatchObject({ compteId: agent.id, status: "pending", nbPhotos: 1 });
    expect(await compterPhotos(page, agent.id)).toBe(1);
    expect(await inspectionsAvecMarqueur(marqueur)).toHaveLength(0);
    const brut = await lireStockageBrut(page);
    expect(contientEnClair(brut, photo.buffer), "photo entiere en clair").toBe(false);
    expect(contientEnClair(brut, photo.buffer.subarray(40, 120)), "morceau de la photo en clair").toBe(false);
    expect(contientEnClair(brut, marqueur), "texte de l'inspection en clair").toBe(false);

    await retablirReseau(context, page);

    // L'inspection est creee, puis sa photo ; la file ne se vide qu'apres la derniere photo.
    await expect.poll(async () => (await inspectionsAvecMarqueur(marqueur))[0]?.photos.length, { timeout: DELAI_SYNC_MS }).toBe(1);
    const lignes = await inspectionsAvecMarqueur(marqueur);
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toMatchObject({ tronconId: run.troncons[1].id, inspecteurId: agent.id });

    // `Inspection.photos` ne garde que le nom du fichier : on relit les octets sur le disque de l'API.
    const fichier = path.join(run.dossierTeleversements, lignes[0].photos[0]);
    expect(fs.existsSync(fichier), `fichier televerse ${path.basename(fichier)}`).toBe(true);
    expect(createHash("sha256").update(fs.readFileSync(fichier)).digest("hex")).toBe(photo.sha256);
    await expect.poll(async () => (await lireFile(page, "pending_inspections", agent.id)).length).toBe(0);
  });
});
