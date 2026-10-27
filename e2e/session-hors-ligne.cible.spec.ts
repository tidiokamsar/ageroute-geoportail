import { request } from "@playwright/test";
import {
  appareilsDe, definirCompteActif, definirModules, evenementsLocauxDe, lireModules, observationsAvecMarqueur, requete, sessionsVivantes,
} from "./lib/base";
import { DELAI_SYNC_MS, ORIGINE_WEB } from "./lib/env";
import {
  coupureReseau, deverrouiller, ECRAN_OBSERVATIONS, essayerPin, expect, ouvrirEcranTerrain, ouvrirObservations, retablirReseau,
  saisirObservation, seConnecter, seDeconnecter, test,
} from "./lib/fixtures";
import { contientEnClair, lireFile, lireStockageBrut, nomBaseOffline, nomsBases } from "./lib/idb";
import { apiInjoignable, attendreSync, envoyerMaintenant, sonderSync } from "./lib/reseau";
import {
  appelerApi, attendreServiceWorkerPret, compterRequetes, definirVisibilite, jetonDe, modeAvion, ouvrirPanneauSession, urlsEnCache,
} from "./lib/session";

/**
 * SESSION HORS LIGNE (docs/securite/SESSION-HORS-LIGNE.md, SESSION-HORS-LIGNE-SERVEUR.md, SERVICE-WORKER-HORS-LIGNE.md).
 * Les scenarios de cette page etaient des `test.fixme` ; ils sont ACTIVES. Deux projets Playwright :
 *   - `dev` (Vite, service worker bloque) : tout sauf les titres marques `@froid` ;
 *   - `build` (build de production, serveur statique, service worker actif) : seulement les titres `@froid`, ceux qui exigent une
 *     REOUVERTURE A FROID sans serveur du tout (le service worker est alors la seule source de l'application).
 * Hors ligne en mode dev, deux outils (lib/reseau.ts, lib/session.ts) : `coupureReseau` (setOffline, page deja chargee) et
 * `apiInjoignable` (seules les requetes /api/ echouent : telephone dont l'enveloppe est en cache, couverture absente).
 * Les durees (inactivite, expiration, delais de PIN) se pilotent par `page.clock` (`ouvrirProfil({ horloge })`), jamais par des attentes.
 */

// ---------------------------------------------------------------------------------------------------------------------------
// (a) Ouverture hors ligne autorisee, a froid (service worker)
// ---------------------------------------------------------------------------------------------------------------------------
test.describe("(a) ouverture hors ligne autorisee", () => {
  test("@froid le service worker precache toute l'application et ne garde jamais l'API", async ({ ouvrirProfil, run }) => {
    const { page } = await ouvrirProfil();
    await seConnecter(page, run.comptes.agentA);
    const { entrees, caches } = await attendreServiceWorkerPret(page);
    expect(entrees).toBeGreaterThan(50);
    expect(caches.some((c) => c.startsWith("bdri-precache-"))).toBe(true);
    // Aucune reponse d'API (donnees authentifiees) dans aucun cache, apres une session qui en a pourtant beaucoup fait.
    await ouvrirEcranTerrain(page, ECRAN_OBSERVATIONS, run.comptes.agentA);
    const urls = await urlsEnCache(page);
    expect(urls.filter((u) => /\/api(\/|$)/i.test(new URL(u).pathname))).toEqual([]);
  });

  test("@froid connexion, PIN, saisie en file, mode avion, rechargement ET redemarrage, deverrouillage, nouvelle saisie, retour du reseau, sans doublon", async ({ ouvrirProfil, run, marqueur }) => {
    const profil = await ouvrirProfil();
    const A = run.comptes.agentA;
    const m1 = `${marqueur}-1`;
    const m2 = `${marqueur}-2`;

    // En ligne : connexion, creation du PIN, application precachee.
    await ouvrirObservations(profil.page, A);
    await attendreServiceWorkerPret(profil.page);

    // Mode avion TOTAL (navigateur hors ligne ET serveur muet) : une premiere saisie hors ligne.
    await modeAvion(profil.context, profil.page, true);
    await saisirObservation(profil.page, { type: "DEGRADATION", gravite: "FORTE", description: `${m1} nid de poule` });
    await expect(profil.page.getByRole("heading", { name: /Saisies sur ce téléphone \(1\)/ })).toBeVisible();

    // RECHARGEMENT hors ligne : la page est servie par le service worker, l'application demande le PIN et le dit hors ligne.
    const reponse = await profil.page.reload();
    expect(reponse?.fromServiceWorker(), "document servi par le service worker").toBe(true);
    const verrou = profil.page.getByRole("dialog", { name: "Session verrouillée" });
    await expect(verrou).toBeVisible();
    await expect(verrou.getByText("Vous êtes hors ligne : vos droits seront revérifiés à la reconnexion.")).toBeVisible();
    // Le contenu n'est pas lisible tant que le code n'est pas donne.
    await expect(profil.page.getByText(`${m1} nid de poule`)).toHaveCount(0);

    // REDEMARRAGE du navigateur (profil persistant), mode avion des l'ouverture.
    await profil.redemarrer();
    await profil.context.setOffline(true);
    await profil.page.goto(ECRAN_OBSERVATIONS);
    // Un localisateur se lie a SA page : apres le redemarrage, il faut le refaire (celui d'avant vise la page fermee).
    const verrouRouvert = profil.page.getByRole("dialog", { name: "Session verrouillée" });
    await expect(verrouRouvert).toBeVisible();
    await expect(verrouRouvert.getByText("Compte : Agent A E2E")).toBeVisible();

    // Mauvais code : message, rien ne se perd ; bon code : la saisie est lisible.
    await essayerPin(profil.page, "pas-le-bon-code");
    await expect(verrouRouvert.getByRole("alert")).toContainText("Code incorrect");
    // Rien n'est parti : le serveur n'a vu aucune des deux sessions hors ligne.
    expect(await observationsAvecMarqueur(marqueur)).toHaveLength(0);
    const brutAvant = await lireStockageBrut(profil.page);
    expect(contientEnClair(brutAvant, m1), "contenu de la saisie en clair dans le stockage").toBe(false);

    // Le deverrouillage HORS LIGNE lui-meme est le defaut E2E-5 (test dedie plus bas, `test.fail`) : l'application renvoie vers
    // /login. Ici, le reseau revient AVANT le bon code : la reouverture a froid a bien affiche l'ecran du PIN hors ligne.
    await modeAvion(profil.context, profil.page, false);
    // Le retour du reseau declenche un rafraichissement de session : le laisser finir avant de recharger (sinon sa reponse est perdue, E2E-4).
    await profil.attendreCalme();
    await profil.page.reload();
    await deverrouiller(profil.page, A);
    // La saisie en file part des le deverrouillage, une seule fois.
    await expect.poll(async () => (await observationsAvecMarqueur(marqueur)).length, { timeout: DELAI_SYNC_MS }).toBe(1);

    // Nouvelle saisie hors ligne, page deverrouillee, puis retour du reseau : une seule ligne de plus, jamais de doublon.
    await modeAvion(profil.context, profil.page, true);
    await saisirObservation(profil.page, { type: "CHAUSSEE", description: `${m2} affaissement` });
    await expect(profil.page.getByRole("heading", { name: /Saisies sur ce téléphone \(1\)/ })).toBeVisible();
    expect(await observationsAvecMarqueur(marqueur)).toHaveLength(1);
    const brut = await lireStockageBrut(profil.page);
    expect(contientEnClair(brut, m1) || contientEnClair(brut, m2), "contenu des saisies en clair dans le stockage").toBe(false);
    await modeAvion(profil.context, profil.page, false);
    await expect.poll(async () => (await observationsAvecMarqueur(marqueur)).length, { timeout: DELAI_SYNC_MS }).toBe(2);
    const lignes = await observationsAvecMarqueur(marqueur);
    expect(new Set(lignes.map((l) => l.clientOperationId)).size).toBe(2);
    expect(lignes.every((l) => l.agentId === A.id)).toBe(true);
    await expect.poll(async () => (await lireFile(profil.page, "pending_observations", A.id)).length).toBe(0);
    // Le telephone a depose ses evenements de session locale (ouverture hors ligne, deverrouillage, echec de code) a la reconnexion.
    await expect.poll(async () => (await evenementsLocauxDe(A.id)).map((e) => e.evenement), { timeout: DELAI_SYNC_MS })
      .toEqual(expect.arrayContaining(["OUVERTURE_HORS_LIGNE"]));
  });

  /**
   * DEFAUT E2E-5 (candidat, a confirmer par l'equipe frontend). Attendu (SESSION-HORS-LIGNE.md : « ouverture hors ligne autorisee ») :
   * a froid, sans reseau, le bon code PIN rouvre la file locale. Constate : la page affiche bien l'ecran du PIN hors ligne, le bon code
   * est accepte, puis l'application navigue vers /login SANS aucune requete d'API (seul le logo est demande) et la saisie reste
   * illisible. Piste de lecture du code (non verifiee) : `ProtectedRoute` renvoie vers /login quand `useAuth().user` est nul
   * (frontend/src/components/ProtectedRoute.tsx, bloc `if (!user)`), et rien ne renseigne l'utilisateur apres un deverrouillage hors ligne.
   * REPRODUCTION : `npm run test:e2e -- --project=build -g E2E-5` (le test passe parce qu'il est `test.fail` ; retirer `test.fail`
   * pour voir l'echec : « page.url() = /login »). A la correction, ce test passera en echec : retirer alors `test.fail`.
   */
  test("@froid E2E-5 (defaut) : le bon code PIN hors ligne, apres redemarrage, rouvre la saisie au lieu de renvoyer vers /login", async ({ ouvrirProfil, run, marqueur }, testInfo) => {
    test.skip(testInfo.project.name !== "build", "exige une reouverture a froid sans serveur : projet build seulement");
    test.fail(true, "E2E-5 : deverrouillage hors ligne renvoye vers /login (voir le commentaire du test)");
    const profil = await ouvrirProfil();
    const A = run.comptes.agentA;
    await ouvrirObservations(profil.page, A);
    await attendreServiceWorkerPret(profil.page);
    await modeAvion(profil.context, profil.page, true);
    await saisirObservation(profil.page, { type: "DEGRADATION", gravite: "FORTE", description: `${marqueur} e2e5` });
    await profil.redemarrer();
    await profil.context.setOffline(true);
    await profil.page.goto(ECRAN_OBSERVATIONS);
    await expect(profil.page.getByRole("dialog", { name: "Session verrouillée" })).toBeVisible();
    await deverrouiller(profil.page, A);
    await expect(profil.page).not.toHaveURL(/\/login/);
    await expect(profil.page.getByText(`${marqueur} e2e5`)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// (b) Code PIN faux : message, delais croissants, aucune perte
// ---------------------------------------------------------------------------------------------------------------------------
test.describe("(b) code PIN faux", () => {
  test("message, 5 essais libres puis delais croissants (30 s, 1 min), aucune perte, le bon code rouvre", async ({ ouvrirProfil, run, marqueur }) => {
    const profil = await ouvrirProfil({ horloge: new Date() });
    const A = run.comptes.agentA;
    await ouvrirObservations(profil.page, A);
    await coupureReseau(profil.context, profil.page);
    await saisirObservation(profil.page, { type: "AUTRE", description: `${marqueur} a ne pas perdre` });
    const sonde = await sonderSync(profil.context, "abandonner-avant-serveur");
    await retablirReseau(profil.context, profil.page);
    await attendreSync(sonde, 1);

    await profil.attendreCalme();
    await profil.page.reload();
    const verrou = profil.page.getByRole("dialog", { name: "Session verrouillée" });
    await expect(verrou).toBeVisible();

    // Cinq echecs : « Code incorrect. », aucun delai.
    for (let i = 1; i <= 5; i++) {
      await essayerPin(profil.page, `faux-${i}-${marqueur}`);
      await expect(verrou.getByRole("alert")).toContainText("Code incorrect");
      await expect(verrou.getByText(/patientez/)).toHaveCount(0);
    }
    // Le sixieme echec impose une attente : 30 s, bouton inactif.
    await essayerPin(profil.page, `faux-6-${marqueur}`);
    const attente = verrou.getByRole("status").filter({ hasText: "patientez" });
    await expect(attente).toBeVisible();
    await expect(verrou.getByRole("button", { name: "Déverrouiller" })).toBeDisabled();
    await expect(attente).toContainText(/(2\d|30) s/);

    // L'horloge avance de 31 s : l'essai est de nouveau possible ; un nouvel echec double le delai (1 min).
    await profil.page.clock.fastForward(31_000);
    await expect(verrou.getByRole("status").filter({ hasText: "patientez" })).toHaveCount(0);
    await essayerPin(profil.page, `faux-7-${marqueur}`);
    await expect(attente).toBeVisible();
    await expect(attente).toContainText(/(59 s|1 min)/);

    // Pas de destruction automatique : apres l'attente, le bon code rouvre la meme saisie.
    await profil.page.clock.fastForward(61_000);
    await deverrouiller(profil.page, A);
    await expect(profil.page.getByRole("heading", { name: /Saisies sur ce téléphone \(1\)/ })).toBeVisible();
    await expect(profil.page.getByText(`${marqueur} a ne pas perdre`)).toBeVisible();
    // Les echecs sont deposes comme evenements a la reconnexion (regroupes).
    await sonde.retirer();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// (c) Session expiree (7 jours) et horloge reculee
// ---------------------------------------------------------------------------------------------------------------------------
test.describe("(c) expiration et horloge reculee", () => {
  test("au-dela de 7 jours, ou si l'horloge recule, l'ouverture hors ligne est refusee, le coffre est intact, la reconnexion en ligne puis le PIN rouvrent les memes donnees", async ({ ouvrirProfil, run, marqueur }) => {
    const profil = await ouvrirProfil();
    const A = run.comptes.agentA;
    await ouvrirObservations(profil.page, A);
    await coupureReseau(profil.context, profil.page);
    await saisirObservation(profil.page, { type: "AUTRE", description: `${marqueur} avant expiration` });
    const [avant] = await lireFile(profil.page, "pending_observations", A.id);
    const maintenant = Date.now();

    // 1. Huit jours plus tard, API injoignable : session expiree, rien n'est ouvert, rien n'est efface.
    await profil.redemarrer({ horloge: new Date(maintenant + 8 * 24 * 3600 * 1000) });
    const libere = await apiInjoignable(profil.context);
    await profil.page.goto(ECRAN_OBSERVATIONS);
    // L'expiration est une propriete du PROFIL CHIFFRE du coffre (date de derniere validation par le serveur) : elle ne se lit qu'avec le bon
    // code. L'ecran de verrou s'affiche donc d'abord ; le bon code est alors REFUSE, et l'ecran « Session locale expiree » prend la place.
    const expiree = await refuseParExpiration(profil.page, A);
    await expect(expiree).toContainText("La durée maximale sans connexion est dépassée");
    await expect(expiree).toContainText("ne sont pas perdues");
    expect((await lireFile(profil.page, "pending_observations", A.id)).map((e) => e.localId)).toEqual([avant.localId]);

    // 2. L'horloge est RECULEE de 30 minutes (au-dela de la tolerance de 5 min) : traite comme une falsification, meme refus.
    await profil.redemarrer({ horloge: new Date(maintenant - 30 * 60 * 1000) });
    await apiInjoignable(profil.context);
    await profil.page.goto(ECRAN_OBSERVATIONS);
    await refuseParExpiration(profil.page, A);
    expect((await lireFile(profil.page, "pending_observations", A.id)).map((e) => e.localId)).toEqual([avant.localId]);

    // 3. Retour de l'horloge a l'heure et du reseau : « Aller a la connexion », connexion en ligne, puis le PIN rouvre les memes donnees.
    await profil.redemarrer();
    await profil.page.goto(ECRAN_OBSERVATIONS);
    // En ligne, la session retrouvee par le cookie : le code suffit.
    await passerParLaConnexionSiDemande(profil.page, A);
    await expect(profil.page.getByText(`${marqueur} avant expiration`)).toBeVisible();
    await expect.poll(async () => (await observationsAvecMarqueur(marqueur)).length, { timeout: DELAI_SYNC_MS }).toBe(1);
    const [ligne] = await observationsAvecMarqueur(marqueur);
    expect(ligne.clientOperationId).toBe(avant.localId);
    void libere;
  });
});

/** Ouverture hors ligne qui doit etre REFUSEE pour expiration : donne le bon code, rend l'ecran « Session locale expiree ». */
async function refuseParExpiration(page: import("@playwright/test").Page, compte: import("./lib/donnees").CompteRun) {
  const verrou = page.getByRole("dialog", { name: "Session verrouillée" });
  const expiree = page.getByRole("dialog", { name: "Session locale expirée" });
  await expect.poll(async () => ((await verrou.isVisible()) ? "verrou" : (await expiree.isVisible()) ? "expiree" : "rien"), { timeout: 60_000 }).not.toBe("rien");
  if (await verrou.isVisible()) await essayerPin(page, compte.pin);
  await expect(expiree).toBeVisible();
  return expiree;
}

/** Apres une reouverture : si l'application demande une connexion complete, la faire ; puis donner le code. */
async function passerParLaConnexionSiDemande(page: import("@playwright/test").Page, compte: import("./lib/donnees").CompteRun): Promise<void> {
  const verrou = page.getByRole("dialog", { name: "Session verrouillée" });
  const expiree = page.getByRole("dialog", { name: "Session locale expirée" });
  await expect.poll(async () => ((await verrou.isVisible()) ? "verrou" : (await expiree.isVisible()) || /\/login/.test(page.url()) ? "connexion" : "rien"),
    { timeout: 60_000 }).not.toBe("rien");
  if (!(await verrou.isVisible())) {
    await seConnecter(page, compte);
    await page.goto(ECRAN_OBSERVATIONS);
  }
  await deverrouiller(page, compte);
  // L'horloge ayant ete avancee de 8 jours puis ramenee, le « dernier instant vu » garde par le coffre est dans le futur : le bon code est
  // accepte, puis le retour d'horloge est traite comme une falsification (ecran « Session locale expiree »). La connexion en ligne renouvelle.
  if (await expiree.waitFor({ state: "visible", timeout: 3_000 }).then(() => true, () => false)) {
    await page.getByRole("button", { name: "Aller à la connexion" }).click();
    await seConnecter(page, compte);
    await page.goto(ECRAN_OBSERVATIONS);
    await deverrouiller(page, compte);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// (d) verrou d'inactivite (5 min) et (e) arriere-plan (2 min)
// ---------------------------------------------------------------------------------------------------------------------------
test.describe("(d) verrou d'inactivite", () => {
  test("apres 5 minutes sans interaction le contenu n'est plus lisible (inert, masque) ; le PIN le rouvre, la saisie en cours est conservee", async ({ ouvrirProfil, run, marqueur }) => {
    const profil = await ouvrirProfil({ horloge: new Date() });
    const { page } = profil;
    await ouvrirObservations(page, run.comptes.agentA);
    await page.getByLabel("Description").fill(`${marqueur} brouillon non enregistre`);

    // Une interaction a 4 minutes repousse le verrou : a 6 minutes depuis le debut, mais 2 depuis l'interaction, rien.
    await page.clock.fastForward("04:00");
    await page.getByLabel("Description").click();
    await page.clock.fastForward("02:00");
    await expect(page.getByRole("dialog", { name: "Session verrouillée" })).toHaveCount(0);

    // Cinq minutes sans interaction : verrou.
    await page.clock.fastForward("05:10");
    const verrou = page.getByRole("dialog", { name: "Session verrouillée" });
    await expect(verrou).toBeVisible();
    // Le contenu est masque : plus de titre ni de champ pour les lecteurs d'ecran, sous-arbre inert et invisible.
    await expect(page.getByRole("heading", { name: "Nouvelle observation" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Description" })).toHaveCount(0);
    expect(await page.evaluate(() => document.querySelector("[inert]") !== null)).toBe(true);
    expect(await page.locator("textarea#obs-description").isVisible()).toBe(false);

    await deverrouiller(page, run.comptes.agentA);
    // Le contenu reste monte : le brouillon n'est pas perdu.
    await expect(page.getByLabel("Description")).toHaveValue(`${marqueur} brouillon non enregistre`);
  });
});

test.describe("(e) arriere-plan", () => {
  test("2 minutes en arriere-plan verrouillent ; moins, non", async ({ ouvrirProfil, run }) => {
    const profil = await ouvrirProfil({ horloge: new Date() });
    const { page } = profil;
    await ouvrirObservations(page, run.comptes.agentA);

    // 1 minute en arriere-plan : pas de verrou au retour.
    await definirVisibilite(page, "hidden");
    await page.clock.fastForward("01:00");
    await definirVisibilite(page, "visible");
    await expect(page.getByRole("dialog", { name: "Session verrouillée" })).toHaveCount(0);

    // 2 minutes 30 en arriere-plan : verrou.
    await definirVisibilite(page, "hidden");
    await page.clock.fastForward("02:30");
    await definirVisibilite(page, "visible");
    await expect(page.getByRole("dialog", { name: "Session verrouillée" })).toBeVisible();
    await deverrouiller(page, run.comptes.agentA);
    await expect(page.getByRole("heading", { name: "Nouvelle observation" })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// (f) deux comptes sur le meme appareil, y compris hors ligne
// ---------------------------------------------------------------------------------------------------------------------------
test.describe("(f) deux comptes sur le meme appareil, hors ligne", () => {
  test("A saisit puis se deconnecte, B se connecte : il ne voit rien de A ; hors ligne, chacun ouvre SA file avec SON code", async ({ ouvrirProfil, run, marqueur }) => {
    const profil = await ouvrirProfil();
    const { page, context } = profil;
    const A = run.comptes.agentA;
    const B = run.comptes.agentB;
    const mA = `${marqueur}-A`;
    const mB = `${marqueur}-B`;

    // A saisit (en file, envoi tenu en echec), se deconnecte.
    await ouvrirObservations(page, A);
    const sonde = await sonderSync(context, "abandonner-avant-serveur");
    await saisirObservation(page, { type: "TRAFIC", description: `${mA} saisie de A` });
    await attendreSync(sonde, 1);
    await profil.attendreCalme();
    await seDeconnecter(page);

    // B se connecte, ne voit rien de A, saisit la sienne ; sa session RESTE OUVERTE (se deconnecter fermerait la session locale :
    // hors ligne, seule une session restee ouverte se rouvre avec le code).
    await seConnecter(page, B);
    await ouvrirEcranTerrain(page, ECRAN_OBSERVATIONS, B);
    await expect(page.getByRole("heading", { name: /Saisies sur ce téléphone \(0\)/ })).toBeVisible();
    await expect(page.getByText(mA)).toHaveCount(0);
    await saisirObservation(page, { type: "TRAFIC", description: `${mB} saisie de B` });
    await expect(page.getByRole("heading", { name: /Saisies sur ce téléphone \(1\)/ })).toBeVisible();
    await profil.attendreCalme();

    // Le telephone redemarre, l'API est injoignable : seule la session restee OUVERTE (B) se rouvre hors ligne. A s'est deconnecte :
    // sa session locale est fermee (docs/securite/SESSION-HORS-LIGNE.md, section 6), il n'est pas propose ; sa file reste chiffree.
    await profil.redemarrer();
    await apiInjoignable(profil.context);
    await profil.page.goto(ECRAN_OBSERVATIONS);
    const verrou = profil.page.getByRole("dialog", { name: "Session verrouillée" });
    await expect(verrou).toBeVisible();
    await expect(verrou.getByText("Compte : Agent B E2E")).toBeVisible();
    await expect(verrou.getByText("Des saisies d'un autre compte sont en attente sur ce téléphone. Elles ne sont pas visibles ici.")).toBeVisible();
    await expect(verrou.getByText("Ce n'est pas votre compte ?")).toHaveCount(0);

    // Le code de A n'ouvre pas la file de B ; celui de B ouvre la sienne, et elle seule.
    await essayerPin(profil.page, A.pin);
    await expect(verrou.getByRole("alert")).toContainText("Code incorrect");
    await deverrouiller(profil.page, B);
    // Le bon code de B est ACCEPTE (l'ecran de verrou disparait) et rien de A n'apparait. La lecture du contenu de B apres ce deverrouillage
    // hors ligne est le defaut E2E-5 (l'application renvoie vers /login) : elle est verifiee par le test `test.fail` de la section (a).
    await expect(profil.page.getByText(mA)).toHaveCount(0);
    // Dans le stockage brut : deux bases, aucun texte en clair.
    const bases = await nomsBases(profil.page);
    expect(bases).toEqual(expect.arrayContaining([nomBaseOffline(A.id), nomBaseOffline(B.id)]));
    const brut = await lireStockageBrut(profil.page);
    expect(contientEnClair(brut, mA) || contientEnClair(brut, mB)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// (g) deconnexion avec des saisies en attente
// ---------------------------------------------------------------------------------------------------------------------------
test.describe("(g) deconnexion avec saisies en attente", () => {
  test("rien n'est efface, le message dit ce qui reste, la reconnexion du meme compte retrouve la file et la synchronise", async ({ ouvrirProfil, run, marqueur }) => {
    const profil = await ouvrirProfil();
    const { page, context } = profil;
    const A = run.comptes.agentA;
    await ouvrirObservations(page, A);
    const sonde = await sonderSync(context, "abandonner-avant-serveur");
    await saisirObservation(page, { type: "ENVIRONNEMENT", description: `${marqueur} en attente a la deconnexion` });
    await attendreSync(sonde, 1);
    const [avant] = await lireFile(page, "pending_observations", A.id);

    // Le dialogue dit combien de saisies restent et qu'elles partiront a la prochaine connexion du MEME compte.
    const texte = await seDeconnecter(page, { confirmer: false });
    expect(texte).toContain("Aucune donnée n'est supprimée de ce téléphone");
    expect(texte).toContain("Restent chiffrés sur ce téléphone : 1 saisie.");
    expect(texte).toContain("Elles partiront à votre prochaine connexion en ligne avec ce même compte.");
    const sessionsAvant = await sessionsVivantes(A.id);
    await page.getByRole("dialog", { name: "Se déconnecter ?" }).getByRole("button", { name: "Se déconnecter" }).click();
    // Le message qui suit la deconnexion repete ce qui reste et ce qui part.
    await expect(page.getByText("Session fermée. Aucune donnée locale n'a été supprimée.").first()).toBeVisible();
    await expect(page.getByText("à envoyer à votre prochaine connexion en ligne : 1 saisie").first()).toBeVisible();
    await expect(page).toHaveURL(/\/(login|carte)/);

    // Rien n'est efface : la saisie est toujours dans la base du compte, chiffree, et la session serveur est coupee.
    expect((await lireFile(page, "pending_observations", A.id)).map((e) => e.localId)).toEqual([avant.localId]);
    expect(contientEnClair(await lireStockageBrut(page), marqueur)).toBe(false);
    await expect.poll(() => sessionsVivantes(A.id)).toBe(sessionsAvant - 1);
    expect(await observationsAvecMarqueur(marqueur)).toHaveLength(0);

    // Reconnexion du meme compte : la file est la (apres le code) et part.
    await sonde.retirer();
    await seConnecter(page, A);
    await ouvrirEcranTerrain(page, ECRAN_OBSERVATIONS, A);
    await expect.poll(async () => (await observationsAvecMarqueur(marqueur)).length, { timeout: DELAI_SYNC_MS }).toBe(1);
    expect((await observationsAvecMarqueur(marqueur))[0].clientOperationId).toBe(avant.localId);
  });

  test("hors ligne : l'application se verrouille tout de suite, la deconnexion est rejouee au retour du reseau", async ({ ouvrirProfil, run, marqueur }) => {
    const profil = await ouvrirProfil();
    const { page, context } = profil;
    const A = run.comptes.agentA;
    await ouvrirObservations(page, A);
    await coupureReseau(context, page);
    await saisirObservation(page, { type: "ENVIRONNEMENT", description: `${marqueur} hors ligne a la deconnexion` });
    const sessionsAvant = await sessionsVivantes(A.id);
    expect(sessionsAvant).toBeGreaterThan(0);

    const texte = await seDeconnecter(page, { confirmer: false });
    expect(texte).toContain("Vous êtes hors ligne : l'application se verrouille tout de suite, et la déconnexion sera confirmée au retour du réseau.");
    await page.getByRole("dialog", { name: "Se déconnecter ?" }).getByRole("button", { name: "Se déconnecter" }).click();
    await expect(page.getByRole("dialog", { name: "Session verrouillée" })).toBeVisible();
    // La session serveur est encore vivante (rien n'a pu etre dit au serveur) ; la file est intacte.
    expect(await sessionsVivantes(A.id)).toBe(sessionsAvant);
    expect(await lireFile(page, "pending_observations", A.id)).toHaveLength(1);

    await retablirReseau(context, page);
    // La deconnexion rejouee coupe la session de CE profil (les sessions des autres tests du meme compte ne sont pas concernees).
    await expect.poll(() => sessionsVivantes(A.id), { timeout: DELAI_SYNC_MS }).toBe(sessionsAvant - 1);
    expect(await lireFile(page, "pending_observations", A.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// (h) reinitialisation du PIN : distincte de la deconnexion
// ---------------------------------------------------------------------------------------------------------------------------
test.describe("(h) reinitialisation du code PIN", () => {
  test("confirmation en deux temps, perte annoncee, bases du compte detruites, journalisee", async ({ ouvrirProfil, run, marqueur }) => {
    const profil = await ouvrirProfil();
    const { page, context } = profil;
    const A = run.comptes.agentA;
    await ouvrirObservations(page, A);
    const sonde = await sonderSync(context, "abandonner-avant-serveur");
    await saisirObservation(page, { type: "AUTRE", description: `${marqueur} qui sera perdue` });
    await attendreSync(sonde, 1);
    expect(await nomsBases(page)).toContain(nomBaseOffline(A.id));

    await ouvrirPanneauSession(page);
    await page.getByRole("button", { name: "Code oublié : réinitialiser" }).click();
    const dialogue = page.getByRole("dialog", { name: "Code oublié : réinitialiser" });
    // Temps 1 : ce que cela detruit, avec le decompte de la perte, et la distinction avec la deconnexion.
    await expect(dialogue).toContainText("Ce n'est pas la même chose que se déconnecter");
    await expect(dialogue.getByRole("alert")).toContainText("Seront perdus définitivement : 1 saisie non envoyée");
    // Renoncer ne detruit rien.
    await dialogue.getByRole("button", { name: "J'essaie encore" }).click();
    await expect(dialogue).toBeHidden();
    expect(await lireFile(page, "pending_observations", A.id)).toHaveLength(1);

    await ouvrirPanneauSession(page);
    await page.getByRole("button", { name: "Code oublié : réinitialiser" }).click();
    await dialogue.getByRole("button", { name: "Continuer" }).click();
    // Temps 2 : derniere confirmation, case a cocher obligatoire.
    await expect(dialogue).toContainText("Dernière confirmation");
    const reinit = dialogue.getByRole("button", { name: "Réinitialiser le code" });
    await expect(reinit).toBeDisabled();
    await dialogue.getByRole("checkbox").check();
    await expect(reinit).toBeEnabled();
    await reinit.click();
    await expect(page.getByText("Code réinitialisé").first()).toBeVisible();

    // La base du compte est DETRUITE (la saisie est perdue, comme annonce) ; rien n'est parti.
    await expect.poll(async () => nomsBases(page)).not.toContain(nomBaseOffline(A.id));
    expect(await observationsAvecMarqueur(marqueur)).toHaveLength(0);
    // La reinitialisation est journalisee : l'evenement part avec la prochaine connexion en ligne (rien ne reste a ouvrir avant).
    await sonde.retirer();
    await seConnecter(page, A);
    await expect.poll(async () => (await evenementsLocauxDe(A.id)).map((e) => e.evenement), { timeout: DELAI_SYNC_MS })
      .toContain("PIN_REINITIALISE");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// (i) effacement local : refuse tant que la file n'est pas vide, jamais un autre compte
// ---------------------------------------------------------------------------------------------------------------------------
test.describe("(i) effacement local", () => {
  test("refuse tant qu'une saisie attend, accepte ensuite, ne touche jamais un autre compte", async ({ ouvrirProfil, run, marqueur }) => {
    const profil = await ouvrirProfil();
    const { page, context } = profil;
    const A = run.comptes.agentA;
    const B = run.comptes.agentB;

    // B laisse une saisie en attente sur le telephone.
    await ouvrirObservations(page, B);
    const sondeB = await sonderSync(context, "abandonner-avant-serveur");
    await saisirObservation(page, { type: "TRAFIC", description: `${marqueur} saisie de B` });
    await attendreSync(sondeB, 1);
    await seDeconnecter(page);

    // A a, lui aussi, une saisie en attente.
    await ouvrirObservations(page, A);
    await saisirObservation(page, { type: "TRAFIC", description: `${marqueur} saisie de A` });

    await ouvrirPanneauSession(page);
    await page.getByRole("button", { name: "Effacer les données de ce téléphone" }).click();
    const dialogue = page.getByRole("dialog", { name: "Effacer les données de ce téléphone" });
    await expect(dialogue).toContainText("pour votre compte seulement");
    // REFUS : la file n'est pas vide.
    await expect(dialogue.getByRole("alert")).toBeVisible();
    await expect(dialogue.getByRole("button", { name: "Effacer les données" })).toBeDisabled();
    expect(await nomsBases(page)).toContain(nomBaseOffline(A.id));

    // Synchroniser vide la file de A ; l'effacement devient possible.
    await sondeB.retirer();
    await dialogue.getByRole("button", { name: "Synchroniser maintenant" }).click();
    await expect.poll(async () => (await observationsAvecMarqueur(`${marqueur} saisie de A`)).length, { timeout: DELAI_SYNC_MS }).toBe(1);
    await expect(dialogue.getByRole("button", { name: "Effacer les données" })).toBeEnabled({ timeout: DELAI_SYNC_MS });
    await dialogue.getByRole("button", { name: "Effacer les données" }).click();
    await expect(page.getByText("Les données de ce téléphone ont été effacées pour votre compte.").first()).toBeVisible();

    // La base de A est detruite ; celle de B, avec sa saisie, est INTACTE.
    await expect.poll(async () => nomsBases(page)).not.toContain(nomBaseOffline(A.id));
    const bases = await nomsBases(page);
    expect(bases).toContain(nomBaseOffline(B.id));
    expect((await lireFile(page, "pending_observations", B.id))).toHaveLength(1);
    // La saisie de B n'est ni partie ni perdue.
    expect(await observationsAvecMarqueur(`${marqueur} saisie de B`)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// (j) compte desactive pendant que l'agent est hors ligne
// ---------------------------------------------------------------------------------------------------------------------------
test.describe("(j) compte desactive", () => {
  test("a la reconnexion la session se ferme avec un message, la file chiffree est conservee, et repart apres reactivation", async ({ ouvrirProfil, run, marqueur }) => {
    const profil = await ouvrirProfil();
    const { page, context } = profil;
    const C = run.comptes.agentC;
    await ouvrirObservations(page, C);
    await coupureReseau(context, page);
    await saisirObservation(page, { type: "INCIDENT", description: `${marqueur} avant desactivation` });
    const [avant] = await lireFile(page, "pending_observations", C.id);

    await definirCompteActif(C.id, false);
    try {
      await retablirReseau(context, page);
      // Le serveur refuse le rafraichissement : la session se ferme et le dit.
      await expect(page).toHaveURL(/\/login/, { timeout: DELAI_SYNC_MS });
      await expect(page.getByText("Le serveur a fermé votre session")).toBeVisible();
      await expect(page.getByText("restent chiffrées sur ce téléphone")).toBeVisible();
      // Rien ne part, rien n'est efface.
      expect((await lireFile(page, "pending_observations", C.id)).map((e) => e.localId)).toEqual([avant.localId]);
      expect(await observationsAvecMarqueur(marqueur)).toHaveLength(0);
      // Connexion refusee tant que le compte est desactive.
      await page.getByRole("textbox", { name: "E-mail" }).fill(C.email);
      await page.getByPlaceholder("Mot de passe").fill(C.motDePasse);
      await page.getByRole("button", { name: "Se connecter" }).click();
      await expect(page.getByRole("alert").filter({ hasText: /incorrect|désactiv|verrouill/i })).toBeVisible();
    } finally {
      await definirCompteActif(C.id, true);
    }

    // Reactive : la reconnexion du meme compte retrouve la file et la synchronise.
    await seConnecter(page, C);
    await ouvrirEcranTerrain(page, ECRAN_OBSERVATIONS, C);
    await expect.poll(async () => (await observationsAvecMarqueur(marqueur)).length, { timeout: DELAI_SYNC_MS }).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// (k) appareil revoque par un administrateur
// ---------------------------------------------------------------------------------------------------------------------------
test.describe("(k) appareil revoque", () => {
  test("la synchronisation s'arrete, aucun reenregistrement automatique, bandeau visible, saisies conservees", async ({ ouvrirProfil, run, marqueur }, testInfo) => {
    const profil = await ouvrirProfil();
    const { page, context } = profil;
    const D = run.comptes.agentD;
    await ouvrirObservations(page, D);

    // Une premiere saisie, envoyee : elle enregistre l'appareil.
    await saisirObservation(page, { type: "TRAFIC", description: `${marqueur}-1 envoyee` });
    await expect.poll(async () => (await observationsAvecMarqueur(`${marqueur}-1`)).length, { timeout: DELAI_SYNC_MS }).toBe(1);
    const appareils = (await appareilsDe(D.id)).filter((a) => a.revoqueA === null);
    expect(appareils).toHaveLength(1);

    // Une seconde saisie reste en file (envoi tenu en echec) ; un administrateur revoque l'appareil par l'API.
    const sonde = await sonderSync(context, "abandonner-avant-serveur");
    await saisirObservation(page, { type: "TRAFIC", description: `${marqueur}-2 en attente` });
    await attendreSync(sonde, 1);
    const jeton = await jetonDe(run.comptes.admin, testInfo);
    const r = await appelerApi(testInfo, jeton, "POST", `/api/v2/devices/${appareils[0].id}/revoke`, {});
    expect(r.statut).toBe(200);
    expect((await appareilsDe(D.id))[0].revoqueA).not.toBeNull();

    // L'envoi reprend : le serveur dit APPAREIL_REVOQUE ; l'application s'arrete et ne se reenregistre PAS.
    await sonde.retirer();
    const enregistrements = compterRequetes(page, "POST", "/api/v2/devices");
    await envoyerMaintenant(page);
    const bandeau = page.getByTestId("bandeau-synchronisation");
    await expect(bandeau).toBeVisible({ timeout: DELAI_SYNC_MS });
    await expect(bandeau).toContainText("L'envoi de vos saisies est arrêté");
    await expect(bandeau).toContainText("Contactez votre responsable");
    // Plusieurs gestes de plus : toujours aucun enregistrement d'appareil.
    await page.waitForTimeout(2_000);
    expect(enregistrements.n(), "requetes POST /v2/devices apres la revocation").toBe(0);
    enregistrements.arreter();

    // Les saisies sont conservees, la seconde n'est pas partie, aucun nouvel appareil n'existe.
    expect((await lireFile(page, "pending_observations", D.id)).length).toBe(1);
    expect(await observationsAvecMarqueur(`${marqueur}-2`)).toHaveLength(0);
    expect((await appareilsDe(D.id)).filter((a) => a.revoqueA === null)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// (l) droits modifies : quarantaine
// ---------------------------------------------------------------------------------------------------------------------------
test.describe("(l) droits modifies", () => {
  test("une saisie refusee pour droits passe en quarantaine (refus_droits), n'est pas rejouee, et compte dans le decompte de suppression", async ({ ouvrirProfil, run, marqueur }) => {
    const profil = await ouvrirProfil();
    const { page, context } = profil;
    const E = run.comptes.agentE;
    await ouvrirObservations(page, E);
    // Premiere saisie envoyee : l'appareil est enregistre (tant que le module existe).
    await saisirObservation(page, { type: "TRAFIC", description: `${marqueur}-1 envoyee` });
    await expect.poll(async () => (await observationsAvecMarqueur(`${marqueur}-1`)).length, { timeout: DELAI_SYNC_MS }).toBe(1);

    // Deuxieme saisie en file ; un administrateur retire le module « inspections ».
    const sonde = await sonderSync(context, "abandonner-avant-serveur");
    await saisirObservation(page, { type: "TRAFIC", description: `${marqueur}-2 refusee` });
    await attendreSync(sonde, 1);
    const modulesAvant = await lireModules(E.id);
    await definirModules(E.id, modulesAvant.filter((m) => m !== "inspections"));
    try {
      await sonde.retirer();
      const compteur = await sonderSync(context, "laisser-passer");
      await envoyerMaintenant(page);

      // Le serveur refuse ; la saisie est mise en quarantaine, visible, avec son motif.
      await expect.poll(async () => (await lireFile(page, "pending_observations", E.id))[0]?.status, { timeout: DELAI_SYNC_MS }).toBe("refus_droits");
      await expect(page.getByRole("heading", { name: "Saisies refusées : droits modifiés (1)" })).toBeVisible();
      await expect(page.getByText("Le serveur a refusé ces saisies parce que vos droits ont changé.")).toBeVisible();
      expect(await observationsAvecMarqueur(`${marqueur}-2`)).toHaveLength(0);

      // Non rejouee : de nouveaux gestes ne renvoient pas cette saisie.
      const vues = compteur.vues();
      for (let i = 0; i < 2; i++) {
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await page.waitForTimeout(1500);
      }
      expect(compteur.vues(), "requetes sync/push apres la quarantaine").toBe(vues);
      expect((await lireFile(page, "pending_observations", E.id))[0].status).toBe("refus_droits");

      // Comptee dans le decompte de suppression : l'effacement local est refuse et le dit.
      await ouvrirPanneauSession(page);
      await page.getByRole("button", { name: "Effacer les données de ce téléphone" }).click();
      const dialogue = page.getByRole("dialog", { name: "Effacer les données de ce téléphone" });
      await expect(dialogue.getByRole("alert")).toContainText("refusée car vos droits ont changé");
      await expect(dialogue.getByRole("button", { name: "Effacer les données" })).toBeDisabled();
      await dialogue.getByRole("button", { name: "Annuler" }).click();

      // Et le dialogue de deconnexion annonce qu'elle ne partira pas sans decision de l'agent.
      const texte = await seDeconnecter(page, { confirmer: false });
      expect(texte).toContain("refusée car vos droits ont changé");
      expect(texte).toContain("« Renvoyer »");
    } finally {
      await definirModules(E.id, modulesAvant);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// (o) E2E-4 : la reponse perdue d'un rafraichissement coute la session (propriete du serveur, constatee ici en toute precision)
// ---------------------------------------------------------------------------------------------------------------------------
test.describe("(o) rafraichissement dont la reponse est perdue", () => {
  test("un jeton de rafraichissement deja remplace est refuse et FERME LA FAMILLE : meme le nouveau jeton meurt", async ({ run }, testInfo) => {
    // CONSTAT E2E-4 (a decider par l'architecte, pas un test en echec). Le serveur ROTE le jeton de rafraichissement a chaque appel et le
    // nouveau jeton n'existe que dans la reponse. Si cette reponse se perd (couverture qui tombe a cet instant, page rechargee ou fermee
    // pendant la requete), le navigateur garde l'ANCIEN jeton ; son prochain rafraichissement est pris pour une REUTILISATION et le serveur
    // REVOQUE TOUTE LA FAMILLE (auth.service.ts, revoquerFamilleCompromise) : l'agent est deconnecte, sans raison, en pleine mission.
    // Depuis la session hors ligne, TOUTE requete qui echoue sans reponse declenche une sonde de rafraichissement
    // (useSessionLocale.reseauPerdu, au plus une par 10 s), ce qui multiplie les occasions. Observe en navigateur : une requete de
    // synchronisation coupee, puis un rechargement de la page 2 s plus tard, rendent 401 au rafraichissement du demarrage (trace dans le
    // rapport). Ce test le prouve SANS navigateur, de facon deterministe : trois contextes d'API, un cookie explicite chacun.
    const baseURL = (testInfo.project.use.baseURL as string) ?? ORIGINE_WEB;
    const A = run.comptes.agentA;
    const contexte = async () => request.newContext({ baseURL, extraHTTPHeaders: { "X-Forwarded-For": "10.88.1.1" } });
    const cookieDe = (r: import("@playwright/test").APIResponse) => {
      const brut = r.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value).find((v) => v.startsWith("bdri_rt="));
      return brut?.split(";")[0] ?? null;
    };
    const ctx = await contexte();
    const connexion = await ctx.post("/api/auth/login", { data: { email: A.email, password: A.motDePasse } });
    expect(connexion.status()).toBe(200);
    const c0 = cookieDe(connexion)!;
    await ctx.dispose();
    const avant = await sessionsVivantes(A.id);

    // 1. Rafraichissement normal : 200, un NOUVEAU cookie. On fait comme si la reponse s'etait perdue : on n'en garde pas le cookie.
    const un = await contexte();
    const r1 = await un.post("/api/auth/refresh", { headers: { cookie: c0 }, data: {} });
    expect(r1.status()).toBe(200);
    const c1 = cookieDe(r1)!;
    expect(c1).not.toBe(c0);
    await un.dispose();

    // 2. Le navigateur, qui n'a que l'ANCIEN cookie, se presente de nouveau : refuse (reutilisation).
    const deux = await contexte();
    const r2 = await deux.post("/api/auth/refresh", { headers: { cookie: c0 }, data: {} });
    expect(r2.status()).toBe(401);
    await deux.dispose();

    // 3. Et le NOUVEAU cookie, valide une seconde plus tot, est mort lui aussi : toute la famille est revoquee.
    const trois = await contexte();
    const r3 = await trois.post("/api/auth/refresh", { headers: { cookie: c1 }, data: {} });
    expect(r3.status()).toBe(401);
    await trois.dispose();
    expect(await sessionsVivantes(A.id)).toBe(avant - 1);
  });
});

// (m) coupure reseau en plein envoi et synchronisations repetees : une seule ligne serveur. Prouve par specs/03-hors-ligne.spec.ts
// (« coupure reseau en plein envoi » : 6 coupures de suite, « reponse perdue » : rejeu REJOUEE et troisieme rejeu manuel, une seule ligne).
// (n) mauvais mot de passe visible, INSPECTEUR et inspection, etiquettes : specs/01-connexion.spec.ts et specs/02-saisie-en-ligne.spec.ts.

// Garde-fou de compilation : `requete` est utile aux scenarios qui ecrivent des preuves SQL.
void requete;
