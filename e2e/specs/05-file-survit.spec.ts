import { observationsAvecMarqueur } from "../lib/base";
import { DELAI_SYNC_MS } from "../lib/env";
import {
  coupureReseau, deverrouiller, ECRAN_OBSERVATIONS, expect, ouvrirEcranTerrain, ouvrirObservations, retablirReseau, saisirObservation, test,
} from "../lib/fixtures";
import { lireFile } from "../lib/idb";
import { attendreSync, envoyerMaintenant, sonderSync } from "../lib/reseau";

/**
 * Parcours 5 : la file hors ligne SURVIT a un rechargement de page et a un redemarrage du navigateur.
 *
 * Pour que l'observation reste en file sans que le test depende du hasard, la synchronisation est tenue en echec
 * (requete abandonnee avant le serveur) tant que le test ne la libere pas. Apres rechargement ou redemarrage, l'agent
 * doit redonner son code PIN : la cle est oubliee avec la page. La reouverture SANS serveur est traitee dans
 * `session-hors-ligne.cible.spec.ts` (dev : API injoignable ; build : service worker).
 */
test.describe("la file hors ligne survit", () => {
  test("a un rechargement de la page : le PIN est redemande, la saisie est intacte", async ({ ouvrirProfil, run, marqueur }) => {
    const profil = await ouvrirProfil();
    const { page, context } = profil;
    const agent = run.comptes.agentA;
    await ouvrirObservations(page, agent);

    await coupureReseau(context, page);
    await saisirObservation(page, { type: "TRAFIC", description: `${marqueur} embouteillage` });
    const [avant] = await lireFile(page, "pending_observations", agent.id);
    const sonde = await sonderSync(context, "abandonner-avant-serveur");
    await retablirReseau(context, page);
    await attendreSync(sonde, 1);

    await profil.attendreCalme();
    await page.reload();
    // La page a redemarre : la session est retrouvee par le cookie, mais la cle de la file est oubliee. Le PIN d'abord.
    await expect(page.getByRole("dialog", { name: "Session verrouillée" })).toBeVisible();
    await expect(page.getByText(`${marqueur} embouteillage`)).toHaveCount(0);
    const [verrouille] = await lireFile(page, "pending_observations", agent.id);
    expect(verrouille.localId).toBe(avant.localId);

    await deverrouiller(page, agent);
    await expect(page.getByRole("heading", { name: /Saisies sur ce téléphone \(1\)/ })).toBeVisible();
    await expect(page.getByText(`${marqueur} embouteillage`)).toBeVisible();
    const [apres] = await lireFile(page, "pending_observations", agent.id);
    expect(apres.localId).toBe(avant.localId);
    expect(await observationsAvecMarqueur(marqueur)).toHaveLength(0);

    // La coupure cesse : la saisie part, une seule fois.
    await sonde.retirer();
    await envoyerMaintenant(page);
    await expect.poll(async () => (await observationsAvecMarqueur(marqueur)).length, { timeout: DELAI_SYNC_MS }).toBe(1);
    await expect.poll(async () => (await lireFile(page, "pending_observations", agent.id)).length).toBe(0);
  });

  test("a la fermeture puis a la reouverture du navigateur sur le meme profil", async ({ ouvrirProfil, run, marqueur }) => {
    const profil = await ouvrirProfil();
    const agent = run.comptes.agentA;
    await ouvrirObservations(profil.page, agent);

    await coupureReseau(profil.context, profil.page);
    await saisirObservation(profil.page, { type: "ENVIRONNEMENT", gravite: "FAIBLE", description: `${marqueur} eboulement` });
    const [avant] = await lireFile(profil.page, "pending_observations", agent.id);
    // Rien ne part tant que le test ne l'autorise pas (la sonde est posee avant le retour du reseau).
    let sonde = await sonderSync(profil.context, "abandonner-avant-serveur");
    await retablirReseau(profil.context, profil.page);
    await attendreSync(sonde, 1);
    await sonde.retirer();

    // « Le telephone redemarre » : le navigateur est ferme (contexte detruit), puis rouvert sur le meme dossier de profil.
    await profil.redemarrer();
    // La synchronisation automatique du demarrage est tenue en echec elle aussi, le temps de constater la survie.
    sonde = await sonderSync(profil.context, "abandonner-avant-serveur");
    await ouvrirEcranTerrain(profil.page, ECRAN_OBSERVATIONS, agent);

    // Session retrouvee par le cookie du profil, file retrouvee dans IndexedDB, lisible apres le PIN.
    await expect(profil.page.getByRole("button", { name: "Déconnexion" })).toBeVisible();
    await expect(profil.page.getByRole("heading", { name: /Saisies sur ce téléphone \(1\)/ })).toBeVisible();
    const [apres] = await lireFile(profil.page, "pending_observations", agent.id);
    expect(apres).toMatchObject({ localId: avant.localId, compteId: agent.id });
    expect(await observationsAvecMarqueur(marqueur)).toHaveLength(0);

    await sonde.retirer();
    await envoyerMaintenant(profil.page);
    await expect.poll(async () => (await observationsAvecMarqueur(marqueur)).length, { timeout: DELAI_SYNC_MS }).toBe(1);
    const [ligne] = await observationsAvecMarqueur(marqueur);
    expect(ligne.clientOperationId).toBe(avant.localId);
    await expect.poll(async () => (await lireFile(profil.page, "pending_observations", agent.id)).length).toBe(0);
  });
});
