import { observationsAvecMarqueur } from "../lib/base";
import { DELAI_SYNC_MS } from "../lib/env";
import {
  coupureReseau, ECRAN_OBSERVATIONS, expect, ouvrirEcranTerrain, ouvrirObservations, retablirReseau, saisirObservation, seConnecter,
  seDeconnecter, test,
} from "../lib/fixtures";
import { contientEnClair, lireFile, lireStockageBrut, nomBaseOffline, nomsBases } from "../lib/idb";
import { attendreSync, sonderSync } from "../lib/reseau";

/**
 * Parcours 6 : DEUX COMPTES sur le meme appareil (meme profil de navigateur). Depuis la session hors ligne, chaque compte a SA base
 * IndexedDB (`bdri-offline-<empreinte>`) et son propre code PIN : il n'y a plus de filtre a oublier, l'autre compte n'atteint rien.
 */
test.describe("deux comptes sur le meme appareil", () => {
  test("la file d'un compte n'est ni vue ni envoyee par l'autre, et revient intacte a son proprietaire", async ({ ouvrirProfil, run, marqueur }) => {
    const profil = await ouvrirProfil();
    const { page, context } = profil;
    const A = run.comptes.agentA;
    const B = run.comptes.agentB;
    const marqueurA = `${marqueur}-A`;
    const marqueurB = `${marqueur}-B`;

    // 1. A saisit hors ligne ; son envoi est tenu en echec quand le reseau revient.
    await ouvrirObservations(page, A);
    await coupureReseau(context, page);
    await saisirObservation(page, { type: "OUVRAGE", description: `${marqueurA} parapet endommage` });
    const [entreeA] = await lireFile(page, "pending_observations", A.id);
    const sonde = await sonderSync(context, "abandonner-avant-serveur");
    await retablirReseau(context, page);
    await attendreSync(sonde, 1);

    // 2. A se deconnecte (en ligne) ; B se connecte sur le MEME navigateur et cree SON code.
    const texteDeconnexion = await seDeconnecter(page);
    expect(texteDeconnexion).toContain("1 saisie");
    await seConnecter(page, B);
    await ouvrirEcranTerrain(page, ECRAN_OBSERVATIONS, B);
    await expect(page.getByRole("heading", { name: "Nouvelle observation" })).toBeVisible();

    // B ne voit pas la saisie de A, ni dans la liste ni dans le badge ; il sait seulement qu'un autre compte a des saisies en attente.
    await expect(page.getByRole("heading", { name: /Saisies sur ce téléphone \(0\)/ })).toBeVisible();
    await expect(page.getByText(`${marqueurA} parapet endommage`)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /à synchroniser/ })).toHaveCount(0);
    await expect(page.getByText("Des saisies d'un autre compte sont en attente sur ce téléphone").first()).toBeVisible();
    // Deux bases distinctes, une par compte ; la file de A n'est pas dans celle de B.
    const bases = await nomsBases(page);
    expect(bases).toContain(nomBaseOffline(A.id));
    expect(bases).toContain(nomBaseOffline(B.id));
    expect(await lireFile(page, "pending_observations", B.id)).toHaveLength(0);
    expect((await lireFile(page, "pending_observations", A.id)).map((e) => e.localId)).toEqual([entreeA.localId]);

    // 3. B saisit et envoie la sienne (la sonde la laisse passer : B n'a qu'a se mettre en ligne). Celle de A reste a A.
    await sonde.retirer();
    await saisirObservation(page, { type: "TRAFIC", description: `${marqueurB} ralentissement` });
    await expect.poll(async () => (await observationsAvecMarqueur(marqueurB)).length, { timeout: DELAI_SYNC_MS }).toBe(1);
    expect((await observationsAvecMarqueur(marqueurB))[0].agentId).toBe(B.id);
    // La saisie de A n'a PAS ete envoyee sous le compte de B, et rien du contenu de A n'est lisible dans le stockage.
    expect(await observationsAvecMarqueur(marqueurA)).toHaveLength(0);
    expect(contientEnClair(await lireStockageBrut(page), marqueurA)).toBe(false);
    expect((await lireFile(page, "pending_observations", A.id)).map((e) => e.localId)).toEqual([entreeA.localId]);

    // 4. B se deconnecte, A revient : sa saisie est toujours la, apres SON code, et part sous SON nom.
    await seDeconnecter(page);
    await seConnecter(page, A);
    await ouvrirEcranTerrain(page, ECRAN_OBSERVATIONS, A);
    await expect.poll(async () => (await observationsAvecMarqueur(marqueurA)).length, { timeout: DELAI_SYNC_MS }).toBe(1);
    const [ligneA] = await observationsAvecMarqueur(marqueurA);
    expect(ligneA).toMatchObject({ agentId: A.id, clientOperationId: entreeA.localId });
    await expect.poll(async () => (await lireFile(page, "pending_observations", A.id)).length).toBe(0);
  });
});
