import { requete } from "../lib/base";
import { expect, seConnecter, test } from "../lib/fixtures";
import {
  ApiVoirie, DIALOGUE_ASSISTANT, attendreEtape, codeProjet, comptesInterdits, creerCompte, empreinteTroncons, etapeDepot, exigerAccessible, jeuxDuProjet,
  nombreObjetsDuJeu, ouvrirAssistant, ouvrirProjet, sha256, auditDe, violationsAxe, type CompteVoirie,
} from "../lib/voirie";
import { AXES, RESEAU_TELECOM, geojson, kml } from "../lib/voirie-geo";

/**
 * KIS-IMP-01 (cahier 22.3), KIS-LOG-01 : l'assistant d'import dans le navigateur, du projet au jeu en quarantaine.
 *
 *   - un GESTIONNAIRE cree un projet (code, emprise 15 m, chaussee 7 m), ouvre l'assistant, depose un GeoJSON synthetique d'axes (WGS 84), parcourt
 *     les etapes, voit l'apercu sur carte, depose : le jeu est en quarantaine (CONTROLE), le referentiel n'a pas bouge ;
 *   - un KML synthetique de reseau de concessionnaire (role reseau, origine renseignee, concessionnaire cree par l'assistant) idem ;
 *   - le meme fichier redepose : message « deja charge » et aucun doublon (KIS-LOG-01) ;
 *   - un lecteur ne voit pas le jeu en quarantaine.
 * Les fichiers sont fabriques ici (e2e/lib/voirie-geo.ts) : donnees 100 % synthetiques.
 */

test.describe.configure({ mode: "serial" });

let gestionnaire: CompteVoirie;
let lecteur: CompteVoirie;

test.beforeAll(async () => {
  gestionnaire = await creerCompte("e2e-voirie-gest", "Gestionnaire Voirie E2E", "GESTIONNAIRE");
  lecteur = await creerCompte("e2e-voirie-lect", "Lecteur Voirie E2E", "LECTEUR");
});

// Etat partage par les trois premiers scenarios (meme projet : le fichier redepose doit etre celui du deuxieme).
const partage: { projetId: string; code: string; nom: string; kml?: Buffer; jeuAxes?: string; jeuReseau?: string } = { projetId: "", code: "", nom: "" };

test("KIS-IMP-01 : un gestionnaire cree un projet puis depose un GeoJSON d'axes par l'assistant : le jeu est en quarantaine", async ({ ouvrirProfil, marqueur }) => {
  const { page } = await ouvrirProfil();
  const code = codeProjet(marqueur, "IMP");
  const nom = `Voirie synthetique ${marqueur}`;
  const referentielAvant = await comptesInterdits();
  const troncons = await empreinteTroncons();

  await seConnecter(page, gestionnaire);
  await page.goto("/projets-voirie");
  await expect(page.getByRole("heading", { level: 1, name: "Projets de voirie et réseaux" })).toBeVisible();

  // ---- Creation du projet (emprise 15 m, chaussee 7 m)
  await page.getByRole("button", { name: "Nouveau projet" }).click();
  const creation = page.getByRole("dialog", { name: "Nouveau projet de voirie et réseaux" });
  await creation.getByLabel("Code du projet").fill(code);
  await creation.getByLabel("Nom du projet").fill(nom);
  await creation.getByLabel("Commune (facultatif)").fill("Commune synthetique");
  await creation.getByLabel("Chaussée (m)").fill("7");
  await creation.getByLabel("Emprise (m)").fill("15");
  await creation.getByRole("button", { name: "Créer le projet" }).click();
  await expect(page.getByRole("heading", { level: 1, name: nom })).toBeVisible();
  await expect(page).toHaveURL(/\/projets-voirie\/[0-9a-f-]{36}$/);

  const lignes = await requete<{ id: string; emprise: number; chaussee: number; statut: string; cree: string }>(
    `SELECT id, "largeurEmpriseM"::float AS emprise, "largeurChausseeM"::float AS chaussee, "statutParametres"::text AS statut, "creeParId" AS cree FROM projets_voirie WHERE code = $1`, [code]);
  expect(lignes, "le projet est en base, une seule fois").toHaveLength(1);
  expect(lignes[0]).toMatchObject({ emprise: 15, chaussee: 7, statut: "THEORIQUE", cree: gestionnaire.id });
  partage.projetId = lignes[0].id; partage.code = code; partage.nom = nom;

  // ---- Assistant : etape 1, depot
  const fichier = { name: "axes-synthetiques.geojson", buffer: geojson(AXES), mimeType: "application/geo+json" };
  const d = await ouvrirAssistant(page);
  await attendreEtape(d, "Dépôt du fichier");
  await expect(d.getByTestId("formats-acceptes")).toContainText("GeoJSON");
  await etapeDepot(page, d, { fichier, role: "AXES_TRAVAUX" });

  // ---- Etape 2 : format detecte PAR LE CONTENU
  await attendreEtape(d, "Format et couches");
  await expect(d.getByTestId("detection")).toContainText("Format détecté par le contenu : GeoJSON");
  await d.getByRole("button", { name: "Continuer", exact: true }).click();

  // ---- Etape 3 : CRS. Un GeoJSON est en WGS 84 par la norme : choix facultatif, transformation affichee apres verification.
  await attendreEtape(d, "Système de coordonnées");
  await expect(d.getByTestId("crs-facultatif")).toBeVisible();
  await d.getByRole("button", { name: "Vérifier la transformation" }).click();
  await expect(d.getByTestId("bloc-crs")).toContainText("Système source");
  await expect(d.getByTestId("plausibilite")).toHaveAttribute("data-statut", "CONFORME");
  await d.getByRole("button", { name: "Continuer", exact: true }).click();

  // ---- Etape 4 : correspondance des champs (facultative)
  await attendreEtape(d, "Correspondance des champs");
  await d.getByRole("button", { name: "Continuer vers les contrôles" }).click();

  // ---- Etape 5 : controles, echantillon, APERCU SUR CARTE
  await attendreEtape(d, "Contrôles et échantillon");
  await expect(d.getByTestId("statistiques")).toContainText("Objets du fichier");
  await expect(d.getByTestId("statistiques")).toContainText("2");
  const echantillon = d.getByTestId("echantillon");
  await expect(echantillon).toContainText("Échantillon : 2 objet(s) sur 2");
  await expect(echantillon.getByRole("row", { name: /Axe A/ })).toBeVisible();
  const carte = d.getByTestId("carte-echantillon");
  await expect(carte.locator(".leaflet-container")).toBeVisible();
  // Les tuiles sont refusees par le harnais : tout pixel dessine sur le canevas de la carte vient de l'apercu des axes.
  await expect.poll(() => carte.locator(".leaflet-overlay-pane canvas").first().evaluate((c: HTMLCanvasElement) => {
    const g = c.getContext("2d");
    if (!g) return -1;
    const px = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] !== 0) n++;
    return n;
  }), { message: "l'apercu dessine les axes sur la carte" }).toBeGreaterThan(0);
  expect(await comptesInterdits(), "l'apercu n'ecrit rien").toEqual(referentielAvant);
  expect(await jeuxDuProjet(partage.projetId), "avant le depot, aucun jeu n'existe").toHaveLength(0);
  await d.getByRole("button", { name: "Simuler l'enregistrement" }).click();

  // ---- Etape 6 : simulation (rien n'est ecrit), puis enregistrement en quarantaine
  await attendreEtape(d, "Comparaison avec la version autorisée");
  await expect(d.getByTestId("simulation-seule")).toContainText("rien n'a été écrit");
  expect(await jeuxDuProjet(partage.projetId), "la simulation n'a rien ecrit").toHaveLength(0);
  await d.getByRole("button", { name: "Enregistrer en quarantaine" }).click();
  await expect(d.getByTestId("depot-enregistre")).toContainText("Fichier enregistré en quarantaine, version 1");

  // ---- En base : jeu CONTROLE, empreinte exacte, objets lus, referentiel intact
  const jeux = await jeuxDuProjet(partage.projetId);
  expect(jeux).toHaveLength(1);
  expect(jeux[0]).toMatchObject({ role: "AXES_TRAVAUX", statut: "CONTROLE", version: 1, format: "GEOJSON", nomFichier: fichier.name, sha256: sha256(fichier.buffer), nbObjets: 2 });
  expect(await nombreObjetsDuJeu(jeux[0].id)).toBe(2);
  expect(jeux[0].longueurTotaleM, "longueur des axes A (200 m) et B (150 m)").toBeGreaterThan(349);
  expect(jeux[0].longueurTotaleM).toBeLessThan(351);
  partage.jeuAxes = jeux[0].id;
  expect(await comptesInterdits(), "recevoir un jeu n'ecrit pas dans le referentiel").toEqual(referentielAvant);
  expect(await empreinteTroncons()).toBe(troncons);
  const audit = await auditDe("JeuDonneesProjet", jeux[0].id);
  expect(audit.map((a) => a.action)).toContain("CREATE");
  expect(JSON.stringify(audit), "l'audit ne porte aucune geometrie").not.toMatch(/coordinates|LineString/);

  // ---- Etape 7 : approbation, le jeu attend sa decision
  await d.getByRole("button", { name: "Continuer vers l'approbation" }).click();
  await attendreEtape(d, "Approbation");
  await expect(d.getByTestId("statut-jeu")).toHaveText("À autoriser (quarantaine)");
  await d.getByRole("button", { name: "Terminer" }).click();
  await expect(page.getByTestId("bandeau-a-autoriser")).toContainText("1 fichier(s) à autoriser");
});

test("KIS-IMP-01 : un KML de réseau de concessionnaire (rôle réseau, origine renseignée) arrive en quarantaine", async ({ ouvrirProfil }) => {
  test.skip(!partage.projetId, "depend du scenario precedent (projet cree)");
  const { page } = await ouvrirProfil();
  const fichier = { name: "reseau-telecom-synthetique.kml", buffer: kml(RESEAU_TELECOM), mimeType: "application/vnd.google-earth.kml+xml" };
  partage.kml = fichier.buffer;
  const referentielAvant = await comptesInterdits();

  await seConnecter(page, gestionnaire);
  await ouvrirProjet(page, partage.projetId, partage.nom);
  const d = await ouvrirAssistant(page);
  await etapeDepot(page, d, {
    fichier, role: "RESEAU_TIERS", nouveauConcessionnaire: { nom: `Operateur ${partage.code}`, type: "TELECOM" },
    origine: "reçu de l'opérateur synthétique le 05/11/2026 (essai de bout en bout)",
  });

  await attendreEtape(d, "Format et couches");
  await expect(d.getByTestId("detection")).toContainText("Format détecté par le contenu : KML");
  await d.getByRole("button", { name: "Continuer", exact: true }).click();
  await attendreEtape(d, "Système de coordonnées");
  // KML : WGS 84 par la norme du format, aucun choix possible.
  await expect(d.getByTestId("crs-impose")).toContainText("EPSG:4326");
  await d.getByRole("button", { name: "Vérifier la transformation" }).click();
  await expect(d.getByTestId("bloc-crs")).toContainText("Imposé par la norme du format");
  await d.getByRole("button", { name: "Continuer", exact: true }).click();
  await d.getByRole("button", { name: "Continuer vers les contrôles" }).click();
  await attendreEtape(d, "Contrôles et échantillon");
  await expect(d.getByTestId("echantillon")).toContainText("Échantillon : 6 objet(s) sur 6");
  // Trois circuits superposes (L2, L2 bis, L2 ter) : signales comme doublons internes, pas comme trois cables.
  await expect(d.getByTestId("doublons")).toContainText("tracé(s) identique(s) répété(s)");
  await d.getByRole("button", { name: "Simuler l'enregistrement" }).click();
  await attendreEtape(d, "Comparaison avec la version autorisée");
  await d.getByRole("button", { name: "Enregistrer en quarantaine" }).click();
  await expect(d.getByTestId("depot-enregistre")).toBeVisible();

  const jeux = (await jeuxDuProjet(partage.projetId)).filter((j) => j.role === "RESEAU_TIERS");
  expect(jeux).toHaveLength(1);
  expect(jeux[0]).toMatchObject({
    statut: "CONTROLE", version: 1, format: "KML", sha256: sha256(fichier.buffer), nbObjets: 6, confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE",
    origineFichier: "reçu de l'opérateur synthétique le 05/11/2026 (essai de bout en bout)",
  });
  expect(jeux[0].concessionnaireId, "le concessionnaire cree par l'assistant est lie au jeu").not.toBeNull();
  expect(jeux[0].longueurTotaleM, "somme des 6 longueurs (somme, pas trace fusionnee)").toBeGreaterThan(jeux[0].resume.longueurTraceFusionneM);
  partage.jeuReseau = jeux[0].id;
  expect(await comptesInterdits()).toEqual(referentielAvant);
  await d.getByRole("button", { name: "Terminer" }).click().catch(() => undefined);
});

test("KIS-LOG-01 : redéposer le même KML annonce « déjà chargé » et ne crée aucun doublon", async ({ ouvrirProfil }) => {
  test.skip(!partage.kml, "depend du scenario precedent (KML depose)");
  const { page } = await ouvrirProfil();
  const fichier = { name: "reseau-telecom-synthetique.kml", buffer: partage.kml!, mimeType: "application/vnd.google-earth.kml+xml" };
  const avant = await jeuxDuProjet(partage.projetId);
  const objetsAvant = await nombreObjetsDuJeu(partage.jeuReseau!);

  await seConnecter(page, gestionnaire);
  await ouvrirProjet(page, partage.projetId, partage.nom);
  const d = await ouvrirAssistant(page);
  const concessionnaireId = (await requete<{ id: string }>(`SELECT id FROM concessionnaires_reseau WHERE nom = $1`, [`Operateur ${partage.code}`]))[0].id;
  await etapeDepot(page, d, { fichier, role: "RESEAU_TIERS", concessionnaireId });
  await attendreEtape(d, "Format et couches");
  await d.getByRole("button", { name: "Continuer", exact: true }).click();
  await d.getByRole("button", { name: "Vérifier la transformation" }).click();
  await expect(d.getByTestId("bloc-crs")).toBeVisible();
  await d.getByRole("button", { name: "Continuer", exact: true }).click();
  await d.getByRole("button", { name: "Continuer vers les contrôles" }).click();
  await attendreEtape(d, "Contrôles et échantillon");
  // La simulation rejoue le depot complet et annonce les 409 : le fichier est refuse AVANT toute ecriture.
  await d.getByRole("button", { name: "Simuler l'enregistrement" }).click();
  const alerte = d.locator('[role="alert"][data-code="JEU_DEJA_CHARGE"]');
  await expect(alerte).toBeVisible();
  await expect(alerte).toContainText("Ce fichier est déjà chargé");
  await expect(alerte.getByRole("button", { name: "Voir le jeu existant" })).toBeVisible();

  const apres = await jeuxDuProjet(partage.projetId);
  expect(apres.map((j) => j.id), "aucun jeu n'a ete cree").toEqual(avant.map((j) => j.id));
  expect(await nombreObjetsDuJeu(partage.jeuReseau!), "aucun objet n'a ete duplique").toBe(objetsAvant);

  // Meme refus par l'API, avec l'identifiant du jeu existant.
  const api = await ApiVoirie.connecter(gestionnaire);
  const r = await api.deposer(partage.projetId, fichier, { role: "RESEAU_TIERS", concessionnaireId });
  expect(r.statut).toBe(409);
  expect(r.corps).toMatchObject({ code: "JEU_DEJA_CHARGE", jeuId: partage.jeuReseau, statut: "CONTROLE", version: 1 });
  expect(await jeuxDuProjet(partage.projetId)).toHaveLength(avant.length);
  await api.fermer();
});

test("un lecteur ne voit pas le jeu en quarantaine ni le bouton d'import", async ({ ouvrirProfil }) => {
  test.skip(!partage.jeuReseau, "depend des scenarios precedents (jeux en quarantaine)");
  const { page } = await ouvrirProfil();
  await seConnecter(page, lecteur);
  await page.goto("/projets-voirie");
  await expect(page.getByRole("button", { name: "Nouveau projet" })).toHaveCount(0);
  await page.getByLabel("Rechercher un projet").fill(partage.code);
  const ligne = page.getByRole("row", { name: new RegExp(partage.nom) });
  await expect(ligne).toBeVisible();
  // La liste ne compte, pour un lecteur, que les jeux AUTORISES : aucun, et pas de mention « a autoriser ».
  await expect(ligne).not.toContainText("à autoriser");
  await ligne.getByRole("link").click();
  await expect(page.getByRole("heading", { level: 1, name: partage.nom })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ajouter des données" })).toHaveCount(0);
  await expect(page.getByTestId("bandeau-a-autoriser")).toHaveCount(0);
  await page.getByRole("tab", { name: "Couches" }).click();
  await expect(page.getByText("Aucun jeu autorisé.")).toBeVisible();
  await expect(page.getByText("Fichiers reçus, à autoriser")).toHaveCount(0);
  await expect(page.getByText("axes-synthetiques.geojson")).toHaveCount(0);
  await expect(page.getByText("reseau-telecom-synthetique.kml")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Autoriser le jeu/ })).toHaveCount(0);

  // Le serveur dit la meme chose que l'ecran : liste vide pour un lecteur, quarantaine refusee (403), jamais seulement masquee.
  const api = await ApiVoirie.connecter(lecteur);
  const liste = await api.get(`/api/v2/projets-voirie/${partage.projetId}/jeux`);
  expect(liste.statut).toBe(200);
  expect(liste.corps.jeux).toEqual([]);
  const carte = await api.get(`/api/v2/projets-voirie/${partage.projetId}/carte?jeux=${partage.jeuReseau}&inclureNonAutorises=true`);
  expect(carte.statut).toBe(403);
  expect(carte.corps.code).toBe("QUARANTAINE_RESERVEE");
  await api.fermer();
});

test("accessibilité : l'assistant d'import, étape par étape (axe-core, WCAG 2.1 AA)", async ({ ouvrirProfil, marqueur }) => {
  const { page } = await ouvrirProfil();
  const api = await ApiVoirie.connecter(gestionnaire);
  const projetId = await api.creerProjet(codeProjet(marqueur, "A11Y"));
  await api.fermer();
  await seConnecter(page, gestionnaire);
  await ouvrirProjet(page, projetId);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const d = await ouvrirAssistant(page);
  const racine = `[role="dialog"]`;
  const verifier = (contexte: string) => expect.soft(async () => exigerAccessible(page, contexte, { racine })).toPass({ timeout: 15_000 });

  await verifier("etape 1, depot");
  // Controle negatif : le moteur DETECTE un defaut (champ de saisie sans etiquette ajoute a la volee), il ne rend pas « vert » par construction.
  await page.evaluate(() => { const i = document.createElement("input"); i.id = "intrus-axe"; i.type = "text"; document.querySelector('[role="dialog"]')!.appendChild(i); });
  const detecte = await violationsAxe(page, { racine });
  expect(detecte.map((v) => v.id), "axe-core signale un champ sans etiquette").toContain("label");
  await page.evaluate(() => document.getElementById("intrus-axe")?.remove());
  await etapeDepot(page, d, { fichier: { name: "axes-a11y.geojson", buffer: geojson(AXES) }, role: "AXES_TRAVAUX" });
  await attendreEtape(d, "Format et couches");
  await verifier("etape 2, format et couches");
  await d.getByRole("button", { name: "Continuer", exact: true }).click();
  await d.getByRole("button", { name: "Vérifier la transformation" }).click();
  await expect(d.getByTestId("bloc-crs")).toBeVisible();
  await verifier("etape 3, systeme de coordonnees");
  await d.getByRole("button", { name: "Continuer", exact: true }).click();
  await attendreEtape(d, "Correspondance des champs");
  await verifier("etape 4, correspondance des champs");
  await d.getByRole("button", { name: "Continuer vers les contrôles" }).click();
  await attendreEtape(d, "Contrôles et échantillon");
  await expect(d.getByTestId("carte-echantillon").locator(".leaflet-container")).toBeVisible();
  await verifier("etape 5, controles et echantillon");
  await d.getByRole("button", { name: "Simuler l'enregistrement" }).click();
  await attendreEtape(d, "Comparaison avec la version autorisée");
  await verifier("etape 6, comparaison (simulation)");
  await d.getByRole("button", { name: "Enregistrer en quarantaine" }).click();
  await expect(d.getByTestId("depot-enregistre")).toBeVisible();
  await d.getByRole("button", { name: "Continuer vers l'approbation" }).click();
  await attendreEtape(d, "Approbation");
  await verifier("etape 7, approbation");
  await expect(page.getByRole("dialog", { name: DIALOGUE_ASSISTANT })).toBeVisible();
});

/**
 * DEFAUT C1-01 (confirme le 08/11/2026, trace Playwright de l'echec) : la classe de precision par defaut de l'assistant est « Inconnue » ; l'assistant
 * l'envoie telle quelle (`frontend/src/lib/projetsVoirieApi.ts:630`, `corps.append("classePrecision", d.classePrecision)`, la valeur « INCONNUE » etant
 * `projetsVoirieImport.ts:356`) et le serveur la refuse (`backend/src/api-v2/projets-voirie.routes.ts:254`, enum A a E ; « inconnue » = champ absent) :
 * 400 CHAMPS_INVALIDES a l'etape « Simuler l'enregistrement », pour tout depot fait avec les valeurs par defaut. Les scenarios ci-dessus choisissent une
 * classe reelle pour pouvoir aller au bout. Ce test decrit le comportement ATTENDU ; il est suspendu (fixme) jusqu'a la correction du defaut.
 */
test.fixme("DEFAUT C1-01 : déposer avec la classe de précision par défaut (« Inconnue ») doit aboutir à la quarantaine", async ({ ouvrirProfil, marqueur }) => {
  const { page } = await ouvrirProfil();
  const api = await ApiVoirie.connecter(gestionnaire);
  const projetId = await api.creerProjet(codeProjet(marqueur, "C101"));
  await api.fermer();
  await seConnecter(page, gestionnaire);
  await ouvrirProjet(page, projetId);
  const d = await ouvrirAssistant(page);
  await etapeDepot(page, d, { fichier: { name: "axes-defaut.geojson", buffer: geojson(AXES) }, role: "AXES_TRAVAUX", classe: "INCONNUE" });
  await attendreEtape(d, "Format et couches");
  await d.getByRole("button", { name: "Continuer", exact: true }).click();
  await d.getByRole("button", { name: "Vérifier la transformation" }).click();
  await d.getByRole("button", { name: "Continuer", exact: true }).click();
  await d.getByRole("button", { name: "Continuer vers les contrôles" }).click();
  await d.getByRole("button", { name: "Simuler l'enregistrement" }).click();
  await attendreEtape(d, "Comparaison avec la version autorisée");
});
