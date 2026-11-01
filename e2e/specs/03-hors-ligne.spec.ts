import { observationsAvecMarqueur } from "../lib/base";
import { DELAI_SYNC_MS } from "../lib/env";
import {
  coupureReseau, expect, ouvrirObservations, retablirReseau, saisirObservation, test,
} from "../lib/fixtures";
import { contientEnClair, lireFile, lireStockageBrut } from "../lib/idb";
import { attendreSync, envoyerMaintenant, sonderSync } from "../lib/reseau";

/**
 * Parcours 3 : observation saisie HORS LIGNE (reseau coupe apres le chargement de l'ecran), conservee dans le vrai
 * IndexedDB (CHIFFRE, une base par compte), puis synchronisee au retour du reseau. Verification cote serveur : UNE seule ligne.
 */
test.describe("observation hors ligne", () => {
  test("reste en file IndexedDB hors ligne (chiffree), puis arrive en base en une seule ligne au retour du reseau", async ({ ouvrirProfil, run, marqueur }) => {
    const { page, context } = await ouvrirProfil();
    const agent = run.comptes.agentA;
    await ouvrirObservations(page, agent);

    await coupureReseau(context, page);
    await saisirObservation(page, { type: "CHAUSSEE", gravite: "MOYENNE", description: `${marqueur} affaissement hors ligne` });

    // Ecran et badge disent la verite : hors ligne, une saisie attend.
    await expect(page.getByRole("heading", { name: /Saisies sur ce téléphone \(1\)/ })).toBeVisible();
    await expect(page.getByText(/Hors-ligne · 1 en attente/)).toBeVisible();
    // Dans le vrai IndexedDB du compte : une entree, en attente, jamais envoyee.
    const [entree] = await lireFile(page, "pending_observations", agent.id);
    expect(entree).toMatchObject({ compteId: agent.id, status: "pending", nbPhotos: 0 });
    // Et le contenu n'est PAS lisible en clair dans le stockage brut (ni la description, ni son marqueur).
    const brut = await lireStockageBrut(page);
    expect(contientEnClair(brut, marqueur), "le marqueur de la saisie ne doit apparaitre nulle part en clair").toBe(false);
    expect(contientEnClair(brut, "affaissement hors ligne")).toBe(false);
    // Le serveur ne sait encore rien.
    expect(await observationsAvecMarqueur(marqueur)).toHaveLength(0);

    await retablirReseau(context, page);

    await expect.poll(async () => (await observationsAvecMarqueur(marqueur)).length, { timeout: DELAI_SYNC_MS }).toBe(1);
    const lignes = await observationsAvecMarqueur(marqueur);
    expect(lignes).toHaveLength(1);
    // La cle d'idempotence cote serveur est l'identifiant genere sur le telephone, hors ligne.
    expect(lignes[0].clientOperationId).toBe(entree.localId);
    expect(lignes[0]).toMatchObject({ type: "CHAUSSEE", gravite: "MOYENNE", statut: "PROPOSEE", agentId: agent.id });
    // La file locale se vide et l'ecran le dit.
    await expect.poll(async () => (await lireFile(page, "pending_observations", agent.id)).length).toBe(0);
    await expect(page.getByText("Aucune observation en attente sur ce téléphone.")).toBeVisible();
  });

  test("plusieurs observations hors ligne partent toutes, chacune une seule fois", async ({ ouvrirProfil, run, marqueur }) => {
    const { page, context } = await ouvrirProfil();
    const agent = run.comptes.agentA;
    await ouvrirObservations(page, agent);

    await coupureReseau(context, page);
    for (const n of [1, 2, 3]) {
      await saisirObservation(page, { type: "SIGNALISATION", description: `${marqueur} panneau ${n}` });
    }
    const avant = await lireFile(page, "pending_observations", agent.id);
    expect(avant).toHaveLength(3);
    await retablirReseau(context, page);

    await expect.poll(async () => (await observationsAvecMarqueur(marqueur)).length, { timeout: DELAI_SYNC_MS }).toBe(3);
    const lignes = await observationsAvecMarqueur(marqueur);
    expect(new Set(lignes.map((l) => l.clientOperationId))).toEqual(new Set(avant.map((a) => a.localId)));
    await expect.poll(async () => (await lireFile(page, "pending_observations", agent.id)).length).toBe(0);
  });

  test("coupure reseau en plein envoi : la requete est abandonnee, la saisie reste en file, la reprise l'envoie une fois", async ({ ouvrirProfil, run, marqueur }) => {
    const { page, context } = await ouvrirProfil();
    const agent = run.comptes.agentA;
    await ouvrirObservations(page, agent);

    await coupureReseau(context, page);
    await saisirObservation(page, { type: "ASSAINISSEMENT", description: `${marqueur} fosse bouche` });
    // Le reseau revient, mais la requete de synchronisation est coupee avant d'atteindre le serveur.
    const sonde = await sonderSync(context, "abandonner-avant-serveur");
    await retablirReseau(context, page);
    await attendreSync(sonde, 1);

    // Rien n'est parti, rien n'est perdu : la saisie est toujours la, marquee « erreur, nouvel essai prevu ».
    expect(await observationsAvecMarqueur(marqueur)).toHaveLength(0);
    await expect(page.getByText("Erreur, nouvel essai prévu")).toBeVisible();
    const [apres] = await lireFile(page, "pending_observations", agent.id);
    expect(apres.status).toBe("error");

    // Un reseau muet ne compte pas dans le plafond de tentatives : 6 coupures de suite (le plafond est 5) ne l'abandonnent pas.
    for (let i = 2; i <= 6; i++) {
      await envoyerMaintenant(page);
      await attendreSync(sonde, i);
      await expect(page.getByRole("button", { name: "Envoyer maintenant" })).toBeEnabled();
    }
    const [apres6] = await lireFile(page, "pending_observations", agent.id);
    expect(apres6.status).toBe("error");
    expect(apres6.status).not.toBe("abandonnee");
    expect(await observationsAvecMarqueur(marqueur)).toHaveLength(0);

    // Reprise : la coupure cesse, la saisie part, une seule fois.
    await sonde.retirer();
    await envoyerMaintenant(page);
    await expect.poll(async () => (await observationsAvecMarqueur(marqueur)).length, { timeout: DELAI_SYNC_MS }).toBe(1);
    await expect.poll(async () => (await lireFile(page, "pending_observations", agent.id)).length).toBe(0);
  });

  test("reponse perdue : le serveur a enregistre, le telephone reessaie, le rejeu ne cree pas de doublon (operationId)", async ({ ouvrirProfil, run, marqueur }) => {
    const { page, context } = await ouvrirProfil();
    const agent = run.comptes.agentA;
    await ouvrirObservations(page, agent);

    await coupureReseau(context, page);
    await saisirObservation(page, { type: "SECURITE", gravite: "FORTE", description: `${marqueur} glissiere arrachee` });
    // Le serveur traitera la requete, mais la reponse n'arrivera jamais au telephone (une seule fois).
    const sonde = await sonderSync(context, "perdre-la-reponse", 1);
    await retablirReseau(context, page);
    await attendreSync(sonde, 1);

    // Le serveur A la ligne ; le telephone, lui, croit a un echec et garde la saisie en file.
    await expect.poll(async () => (await observationsAvecMarqueur(marqueur)).length, { timeout: DELAI_SYNC_MS }).toBe(1);
    await expect.poll(async () => (await lireFile(page, "pending_observations", agent.id)).length).toBe(1);

    // Deuxieme envoi par le telephone (la sonde laisse passer) : le serveur reconnait l'operation.
    const corps = sonde.premierCorps();
    expect(corps?.operations).toHaveLength(1);
    const operationId = corps!.operations[0].operationId;
    const [reponse] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/v2/sync/push") && r.status() < 500),
      envoyerMaintenant(page),
    ]);
    const resultat = (await reponse.json()).resultats?.[0];
    expect(resultat?.statut).toBe("REJOUEE");
    await expect.poll(async () => (await lireFile(page, "pending_observations", agent.id)).length).toBe(0);

    // Troisieme envoi, a la main, avec le meme jeton et le meme corps : toujours REJOUEE, toujours une seule ligne.
    const rejeu = await page.request.post("/api/v2/sync/push", {
      headers: { authorization: sonde.premiersEntetes()!.authorization, "content-type": "application/json" },
      data: corps,
    });
    expect(rejeu.status()).toBe(200);
    expect((await rejeu.json()).resultats[0].statut).toBe("REJOUEE");

    const lignes = await observationsAvecMarqueur(marqueur);
    expect(lignes).toHaveLength(1);
    expect(lignes[0].clientOperationId).toBe(operationId);
  });
});
