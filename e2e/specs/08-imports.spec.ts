import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Page, Response } from "@playwright/test";
import { auditDuLot, comptesReferentiel, lotsAvecMarqueur, nombreLots, requete } from "../lib/base";
import type { CompteRun } from "../lib/donnees";
import { DELAI_SYNC_MS, DOSSIER_CAPTURES, RACINE_DEPOT } from "../lib/env";
import { expect, seConnecter, test } from "../lib/fixtures";
import { apiInjoignable } from "../lib/reseau";
import { appelerApi, jetonDe } from "../lib/session";

/**
 * Parcours « Lots d'import » (docs/imports/CONTRAT-API-LOTS-IMPORT.md, RECEPTION-LOTS-IMPORT.md) : recevoir un fichier, le controler, le
 * relire. Le principe non negociable : RECEVOIR UN LOT N'ECRIT RIEN DANS LE REFERENTIEL. Chaque scenario de reception verifie les comptes
 * des tables du referentiel avant et apres, lus directement en base.
 *
 * Les fichiers d'essai sont dans e2e/fixtures/imports/ ; le jeton `{{SOURCE}}` y est remplace par la source du test (unique), pour que
 * le meme fichier envoye par deux tests ne soit pas pris pour un doublon. Le fichier « trop gros » est genere a la volee, jamais commite.
 */

const DOSSIER_FIXTURES = path.join(RACINE_DEPOT, "e2e", "fixtures", "imports");

interface Fichier { name: string; mimeType: string; buffer: Buffer }

function fixture(nom: string, source: string, mimeType?: string): Fichier {
  const brut = fs.readFileSync(path.join(DOSSIER_FIXTURES, nom));
  const estTexte = !nom.startsWith("binaire") && !nom.startsWith("windows");
  const buffer = estTexte ? Buffer.from(brut.toString("utf8").replaceAll("{{SOURCE}}", source), "utf8")
    : nom.startsWith("windows") ? Buffer.from(brut.toString("latin1").replaceAll("{{SOURCE}}", source), "latin1") : brut;
  return { name: path.basename(nom), mimeType: mimeType ?? (nom.endsWith(".geojson") ? "application/geo+json" : "text/csv"), buffer };
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

interface OptionsReception { source: string; format?: "csv" | "geojson"; autorisation?: string }

/** Remplit le formulaire « Recevoir un lot de données » comme un agent, sans l'envoyer. */
async function remplirReception(page: Page, fichier: Fichier, o: OptionsReception): Promise<void> {
  await page.getByLabel("Système source").fill(o.source);
  // Le libelle porte un « * » (aria-hidden) : une correspondance exacte du texte du libelle ne le trouverait pas.
  const format = page.getByLabel("Format");
  await format.selectOption(o.format ?? (fichier.name.endsWith(".geojson") ? "geojson" : "csv"));
  await page.getByLabel("Méthode de la source").fill("export de test bout en bout");
  await page.getByLabel("Version du mapping").fill("v0");
  await page.getByLabel("Référence de l'autorisation écrite").fill(o.autorisation ?? "AUT-E2E-2026-001");
  await page.getByLabel("Fichier à recevoir").setInputFiles(fichier);
}

const estPostLots = (r: Response) => r.request().method() === "POST" && /\/api\/v2\/imports\/?(\?.*)?$/.test(r.url());

/** Recoit un fichier par l'interface et rend la reponse du serveur. */
async function recevoir(page: Page, fichier: Fichier, o: OptionsReception): Promise<{ statut: number; corps: any }> {
  await remplirReception(page, fichier, o);
  const [reponse] = await Promise.all([
    page.waitForResponse(estPostLots),
    page.getByRole("button", { name: "Recevoir et contrôler le lot" }).click(),
  ]);
  return { statut: reponse.status(), corps: await reponse.json().catch(() => null) };
}

async function ouvrirImports(page: Page, compte: CompteRun, requete = ""): Promise<void> {
  await seConnecter(page, compte);
  await page.goto(`/imports${requete}`);
  await expect(page.getByRole("heading", { name: "Recevoir un lot de données" })).toBeVisible();
}

const detail = (page: Page) => page.getByRole("region", { name: /^LOT-|^IMP-|\w/ }).filter({ has: page.getByRole("heading", { level: 2 }) });

test.describe("lots d'import", () => {
  // IMPORTANT : ce test est le PREMIER du fichier et de la suite a creer des lots. Il est le seul a lire une liste VIDE (base fraiche).
  test("liste vide sur une base fraiche, distincte d'une erreur de l'API", async ({ ouvrirProfil, run }) => {
    expect(await nombreLots(), "aucun lot avant ce test (base fraiche)").toBe(0);
    const { page, context } = await ouvrirProfil();
    await ouvrirImports(page, run.comptes.admin);
    await expect(page.getByText("Aucun lot reçu.").first()).toBeVisible();

    // Erreur de l'API (reseau coupe sur la LISTE seulement) : un etat different, avec un bouton pour reessayer, et PAS « aucun lot ».
    await context.route(/\/api\/v2\/imports(\?.*)?$/, (r) => (r.request().method() === "GET" ? r.abort("connectionreset") : r.continue()));
    await page.goto("/imports");
    await expect(page.getByRole("heading", { name: "Recevoir un lot de données" })).toBeVisible();
    await expect(page.getByRole("alert").filter({ has: page.getByRole("button", { name: /Réessayer|Nouvelle tentative/ }) })).toBeVisible();
    await expect(page.getByText("Aucun lot reçu.")).toHaveCount(0);
    await expect(page.getByText("Pas de réponse du serveur.")).toBeVisible();

    // Reponse 500 : meme famille d'etat, avec le code.
    await context.unroute(/\/api\/v2\/imports(\?.*)?$/);
    await context.route(/\/api\/v2\/imports(\?.*)?$/, (r) => (r.request().method() === "GET" ? r.fulfill({ status: 500, json: { error: "panne" } }) : r.continue()));
    await page.goto("/imports");
    await expect(page.getByText("Réponse du serveur : code 500.")).toBeVisible();
    await expect(page.getByText("Aucun lot reçu.")).toHaveCount(0);
    void apiInjoignable;
  });

  test("reception d'un lot valide : ligne et audit en base, detail avec empreinte, etapes 3 et 4 non disponibles, referentiel INCHANGE", async ({ ouvrirProfil, run, marqueur }) => {
    const { page } = await ouvrirProfil();
    const source = `E2E-${marqueur}`;
    const fichier = fixture("lot-valide.csv", source);
    await ouvrirImports(page, run.comptes.admin);
    const avant = await comptesReferentiel();

    const { statut, corps } = await recevoir(page, fichier, { source });
    expect(statut).toBe(201);
    expect(corps).toMatchObject({ statut: "VALIDE_SCHEMA", dejaRecu: false });
    expect(corps.compteurs).toMatchObject({ lues: 3, validees: 3, importees: 0, rejetees: 0 });

    // L'ecran le dit, et l'adresse retient le lot recu.
    await expect(page.getByText(new RegExp(`Lot ${corps.reference} reçu : 3 ligne\\(s\\) validée\\(s\\)`)).first()).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`lot=${corps.id}`));

    // En base : une ligne, ses compteurs, rien d'importe, et son audit.
    const lots = await lotsAvecMarqueur(marqueur);
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ reference: corps.reference, statut: "VALIDE_SCHEMA", lignesLues: 3, lignesValidees: 3, lignesImportees: 0, lignesRejetees: 0 });
    expect(lots[0].empreinte).toBe(sha256(fichier.buffer));
    const audit = await auditDuLot(corps.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].userId).toBe(run.comptes.admin.id);

    // Le detail affiche l'empreinte du fichier (calculee par le serveur sur les octets recus) et les etapes non disponibles.
    const panneau = page.getByRole("region").filter({ has: page.getByRole("heading", { level: 2, name: corps.reference }) });
    await expect(panneau).toBeVisible();
    await expect(panneau).toContainText(sha256(fichier.buffer).slice(0, 12));
    await expect(panneau).toContainText("Non disponible");
    // Les etapes 3 et 4 du cycle (indicateur de la page) disent « Non disponible », visiblement.
    await expect.poll(async () => page.getByText("Non disponible", { exact: true }).filter({ visible: true }).count()).toBeGreaterThanOrEqual(2);
    await expect(panneau).toContainText("Aucune action d'approbation de l'échantillon ni d'écriture au référentiel");

    // Le detail renvoye par l'API : etapes 3 et 4 NON_DISPONIBLE, aucune ligne importee.
    const jeton = await page.evaluate(async () => (await (await fetch("/api/auth/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()).accessToken as string);
    const d = await page.request.get(`/api/v2/imports/${corps.id}`, { headers: { authorization: `Bearer ${jeton}` } });
    const lot = await d.json();
    expect(lot.etapes.map((e: { id: string; etat: string }) => [e.id, e.etat])).toEqual([
      ["reception", "TERMINEE"], ["controle_schema", "TERMINEE"], ["echantillon", "NON_DISPONIBLE"], ["import_autorise", "NON_DISPONIBLE"],
    ]);
    expect(lot.controle.compteurs.importees).toBe(0);
    expect(lot.empreinte).toEqual({ algorithme: "sha256", valeur: sha256(fichier.buffer) });

    // Le referentiel n'a pas bouge : meme nombre de lignes dans chaque table que recevoir un lot pourrait toucher.
    expect(await comptesReferentiel()).toEqual(avant);
  });

  test("reception d'un lot GeoJSON valide", async ({ ouvrirProfil, run, marqueur }) => {
    const { page } = await ouvrirProfil();
    const source = `E2E-${marqueur}`;
    await ouvrirImports(page, run.comptes.gestionnaire);
    const avant = await comptesReferentiel();
    const { statut, corps } = await recevoir(page, fixture("lot-valide.geojson", source), { source });
    expect(statut).toBe(201);
    expect(corps).toMatchObject({ statut: "VALIDE_SCHEMA" });
    expect(corps.compteurs).toMatchObject({ lues: 2, validees: 2, importees: 0 });
    expect((await lotsAvecMarqueur(marqueur))[0]).toMatchObject({ format: "geojson", lignesLues: 2, lignesImportees: 0 });
    expect(await comptesReferentiel()).toEqual(avant);
  });

  test("lots rejetes : motif visible (CRS 3857, colonne obligatoire absente), referentiel inchange", async ({ ouvrirProfil, run, marqueur }) => {
    const { page } = await ouvrirProfil();
    const source = `E2E-${marqueur}`;
    await ouvrirImports(page, run.comptes.admin);
    const avant = await comptesReferentiel();

    const crs = await recevoir(page, fixture("crs-3857.geojson", source), { source });
    expect(crs.statut).toBe(201);
    expect(crs.corps.statut).toBe("REJETE");
    await expect(page.getByText(`Lot ${crs.corps.reference} rejeté`).first()).toBeVisible();
    await expect(page.getByText(/CRS .*3857.* refus/).first()).toBeVisible();

    const sans = await recevoir(page, fixture("sans-colonne.csv", source), { source });
    expect(sans.statut).toBe(201);
    expect(sans.corps.statut).toBe("REJETE");
    await expect(page.getByText(`Lot ${sans.corps.reference} rejeté`).first()).toBeVisible();

    const lots = await lotsAvecMarqueur(marqueur);
    expect(lots.map((l) => l.statut)).toEqual(["REJETE", "REJETE"]);
    expect(lots.every((l) => l.motifRejetLot && l.lignesImportees === 0 && l.lignesValidees === 0)).toBe(true);
    // Les etapes de controle disent l'echec, les etapes 3 et 4 ne sont pas commencees.
    const panneau = page.getByRole("region").filter({ has: page.getByRole("heading", { level: 2, name: sans.corps.reference }) });
    await expect(panneau).toContainText(lots[1].motifRejetLot!.slice(0, 30));
    expect(await comptesReferentiel()).toEqual(avant);
  });

  test("fichier vide (en-tete seul) : aucun lot conforme, aucun import", async ({ ouvrirProfil, run, marqueur }) => {
    const { page } = await ouvrirProfil();
    const source = `E2E-${marqueur}`;
    await ouvrirImports(page, run.comptes.admin);
    const r = await recevoir(page, fixture("vide.csv", source), { source });
    // Un fichier lisible mais sans ligne est un RESULTAT (lot rejete) ou une demande refusee : jamais un lot « valide », jamais un 500.
    expect([201, 400]).toContain(r.statut);
    if (r.statut === 201) expect(r.corps.statut).toBe("REJETE");
    expect((await lotsAvecMarqueur(marqueur)).every((l) => l.lignesImportees === 0 && l.statut !== "VALIDE_SCHEMA")).toBe(true);
  });

  test("meme fichier envoye deux fois : « deja recu », une seule ligne, un seul audit", async ({ ouvrirProfil, run, marqueur }) => {
    const { page } = await ouvrirProfil();
    const source = `E2E-${marqueur}`;
    const fichier = fixture("lot-valide.csv", source);
    await ouvrirImports(page, run.comptes.admin);
    const premier = await recevoir(page, fichier, { source });
    expect(premier.statut).toBe(201);

    const second = await recevoir(page, fichier, { source });
    expect(second.statut).toBe(200);
    expect(second.corps).toMatchObject({ dejaRecu: true, id: premier.corps.id, reference: premier.corps.reference });
    await expect(page.getByText(`Fichier déjà reçu : lot ${premier.corps.reference}. Rien n'a été écrit.`).first()).toBeVisible();

    expect(await lotsAvecMarqueur(marqueur)).toHaveLength(1);
    expect(await auditDuLot(premier.corps.id)).toHaveLength(1);
  });

  test("meme nom de fichier, contenu different : deux lots distincts", async ({ ouvrirProfil, run, marqueur }) => {
    const { page } = await ouvrirProfil();
    const source = `E2E-${marqueur}`;
    await ouvrirImports(page, run.comptes.admin);
    const v1 = await recevoir(page, fixture("lot-v1/lot.csv", source), { source });
    const v2 = await recevoir(page, fixture("lot-v2/lot.csv", source), { source });
    expect([v1.statut, v2.statut]).toEqual([201, 201]);
    expect(v2.corps.dejaRecu).toBe(false);
    expect(v2.corps.id).not.toBe(v1.corps.id);
    const lots = await lotsAvecMarqueur(marqueur);
    expect(lots).toHaveLength(2);
    expect(lots.map((l) => l.nomFichier)).toEqual(["lot.csv", "lot.csv"]);
    expect(new Set(lots.map((l) => l.empreinte)).size).toBe(2);
  });

  test("BOM UTF-8 et fins de ligne CRLF : recus normalement, accents conserves", async ({ ouvrirProfil, run, marqueur }) => {
    const { page } = await ouvrirProfil();
    const source = `E2E-${marqueur}`;
    await ouvrirImports(page, run.comptes.admin);
    const r = await recevoir(page, fixture("bom-crlf.csv", source), { source });
    expect(r.statut).toBe(201);
    expect(r.corps).toMatchObject({ statut: "VALIDE_SCHEMA" });
    expect(r.corps.compteurs).toMatchObject({ lues: 2, validees: 2 });
  });

  test("format declare incoherent (binaire renomme .csv, CSV declare GeoJSON) : refus 400, aucun lot", async ({ ouvrirProfil, run, marqueur }) => {
    const { page } = await ouvrirProfil();
    const source = `E2E-${marqueur}`;
    await ouvrirImports(page, run.comptes.admin);
    const avant = await nombreLots();

    const binaire = await recevoir(page, fixture("binaire.csv", source), { source });
    expect(binaire.statut).toBe(400);
    expect(binaire.corps.code).toBe("FORMAT_INCOHERENT");
    // Le message du serveur est montre a l'agent.
    await expect(page.getByText(binaire.corps.error).first()).toBeVisible();

    const csvEnGeoJson = await recevoir(page, fixture("lot-valide.csv", source), { source, format: "geojson" });
    expect(csvEnGeoJson.statut).toBe(400);
    expect(csvEnGeoJson.corps.code).toBe("FORMAT_INCOHERENT");

    expect(await nombreLots()).toBe(avant);
    expect(await lotsAvecMarqueur(marqueur)).toHaveLength(0);
  });

  test("fichier non UTF-8 (Windows-1252) : 400 ENCODAGE_NON_UTF8, aucun lot", async ({ ouvrirProfil, run, marqueur }) => {
    const { page } = await ouvrirProfil();
    const source = `E2E-${marqueur}`;
    await ouvrirImports(page, run.comptes.admin);
    const avant = await nombreLots();
    const r = await recevoir(page, fixture("windows-1252.csv", source), { source });
    expect(r.statut).toBe(400);
    expect(r.corps.code).toBe("ENCODAGE_NON_UTF8");
    await expect(page.getByText(r.corps.error).first()).toBeVisible();
    expect(await nombreLots()).toBe(avant);
  });

  test("fichier trop gros (genere a la volee, jamais commite) : refuse par l'ecran avant l'envoi, et par le serveur, aucun lot", async ({ ouvrirProfil, run, marqueur }) => {
    const { page } = await ouvrirProfil();
    const source = `E2E-${marqueur}`;
    await ouvrirImports(page, run.comptes.admin);
    const jeton = await page.evaluate(async () => (await (await fetch("/api/auth/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()).accessToken as string);
    const meta = await (await page.request.get("/api/v2/imports/meta", { headers: { authorization: `Bearer ${jeton}` } })).json();
    const avant = await nombreLots();
    // Un CSV d'une seule colonne, plus gros que le plafond annonce par /meta. Genere en memoire, jamais ecrit sur disque.
    const enTete = "systeme_source;type_objet;identifiant_source\n";
    const gros: Fichier = { name: "gros.csv", mimeType: "text/csv", buffer: Buffer.concat([Buffer.from(enTete), Buffer.alloc(meta.tailleMaxOctets + 1024, "a")]) };

    // 1. L'ecran : l'erreur est dite des le choix du fichier, et rien ne part.
    let envoyes = 0;
    page.on("request", (r) => { if (estPostLots({ request: () => r, url: () => r.url() } as unknown as Response)) envoyes++; });
    await remplirReception(page, gros, { source });
    await expect(page.getByText(/trop gros|taille maximale|dépasse/i).first()).toBeVisible();
    await page.getByRole("button", { name: "Recevoir et contrôler le lot" }).click({ trial: true }).catch(() => undefined);
    expect(envoyes).toBe(0);

    // 2. Le serveur, sans l'ecran : refus net (400 FICHIER_TROP_GROS ; derriere nginx ce serait un 413), jamais un lot.
    const reponse = await page.request.post("/api/v2/imports", {
      headers: { authorization: `Bearer ${jeton}` },
      multipart: { fichier: gros, systemeSource: source, format: "csv", methodeSource: "essai", versionMapping: "v0", autorisationRef: "AUT-E2E-2026-001" },
    });
    expect([400, 413]).toContain(reponse.status());
    if (reponse.status() === 400) expect((await reponse.json()).code).toBe("FICHIER_TROP_GROS");
    expect(await nombreLots()).toBe(avant);
  });

  test("coupure reseau pendant l'envoi : la reception n'est pas confirmee, le nouvel essai cree UNE seule ligne", async ({ ouvrirProfil, run, marqueur }) => {
    const { page, context } = await ouvrirProfil();
    const source = `E2E-${marqueur}`;
    const fichier = fixture("lot-valide.csv", source);
    await ouvrirImports(page, run.comptes.admin);

    // 1. La requete est coupee AVANT le serveur : rien n'est cree, l'ecran dit qu'il n'a pas pu confirmer.
    const coupure = (r: import("@playwright/test").Route) => (r.request().method() === "POST" ? r.abort("connectionreset") : r.continue());
    await context.route(estUrlPost, coupure);
    await remplirReception(page, fichier, { source });
    await page.getByRole("button", { name: "Recevoir et contrôler le lot" }).click();
    await expect(page.getByText("La réception n'a pas pu être confirmée").first()).toBeVisible();
    expect(await lotsAvecMarqueur(marqueur)).toHaveLength(0);

    // 2. Nouvel essai (reseau revenu) : un lot, une ligne.
    await context.unroute(estUrlPost, coupure);
    const reponse = page.waitForResponse(estPostLots);
    await page.getByRole("button", { name: "Recevoir et contrôler le lot" }).click();
    expect((await reponse).status()).toBe(201);
    expect(await lotsAvecMarqueur(marqueur)).toHaveLength(1);
  });

  test("reponse perdue : le serveur a recu le lot, le nouvel essai rend « deja recu », toujours une seule ligne", async ({ ouvrirProfil, run, marqueur }) => {
    const { page, context } = await ouvrirProfil();
    const source = `E2E-${marqueur}`;
    const fichier = fixture("lot-valide.csv", source);
    await ouvrirImports(page, run.comptes.admin);

    const perdre = async (r: import("@playwright/test").Route) => {
      if (r.request().method() !== "POST") return r.continue();
      await r.fetch();
      return r.abort("connectionreset");
    };
    await context.route(estUrlPost, perdre);
    await remplirReception(page, fichier, { source });
    await page.getByRole("button", { name: "Recevoir et contrôler le lot" }).click();
    await expect(page.getByText("La réception n'a pas pu être confirmée").first()).toBeVisible();
    // Le serveur, lui, a le lot.
    await expect.poll(async () => (await lotsAvecMarqueur(marqueur)).length, { timeout: DELAI_SYNC_MS }).toBe(1);

    await context.unroute(estUrlPost, perdre);
    const reponse = page.waitForResponse(estPostLots);
    await page.getByRole("button", { name: "Recevoir et contrôler le lot" }).click();
    const r = await reponse;
    expect(r.status()).toBe(200);
    expect((await r.json()).dejaRecu).toBe(true);
    expect(await lotsAvecMarqueur(marqueur)).toHaveLength(1);
  });

  test("filtres et lot choisi conserves dans l'adresse : apres selection et apres rechargement", async ({ ouvrirProfil, run, marqueur }) => {
    const { page } = await ouvrirProfil();
    const sourceA = `E2E-${marqueur}-alpha`;
    const sourceB = `E2E-${marqueur}-beta`;
    await ouvrirImports(page, run.comptes.admin);
    const a = await recevoir(page, fixture("lot-valide.csv", sourceA), { source: sourceA });
    const b = await recevoir(page, fixture("lot-v1/lot.csv", sourceB), { source: sourceB });
    expect([a.statut, b.statut]).toEqual([201, 201]);

    // Filtre par source : l'adresse le garde, la liste ne montre que ce lot ; choisir un lot garde le filtre.
    await page.goto(`/imports?source=${encodeURIComponent(sourceA)}`);
    const tableau = page.getByRole("region", { name: "Tableau des lots reçus" });
    await expect(tableau.getByRole("rowheader", { name: a.corps.reference })).toBeVisible();
    await expect(tableau.getByRole("rowheader", { name: b.corps.reference })).toHaveCount(0);
    await tableau.getByRole("row").filter({ hasText: a.corps.reference }).getByRole("button").first().click();
    await expect(page).toHaveURL(new RegExp(`source=${encodeURIComponent(sourceA).replace(/[-]/g, "\\-")}`));
    await expect(page).toHaveURL(new RegExp(`lot=${a.corps.id}`));
    await expect(page.getByRole("heading", { level: 2, name: a.corps.reference })).toBeVisible();

    // Rechargement : meme filtre, meme lot, meme liste.
    await page.reload();
    await expect(page.getByRole("heading", { level: 2, name: a.corps.reference })).toBeVisible();
    await expect(tableau.getByRole("rowheader", { name: b.corps.reference })).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("source")).toBe(sourceA);
    expect(new URL(page.url()).searchParams.get("lot")).toBe(a.corps.id);
    // Le champ de recherche relit l'adresse.
    await page.goto(`/imports?q=${encodeURIComponent(marqueur)}&statut=VALIDE_SCHEMA`);
    await expect(page.getByLabel("Rechercher")).toHaveValue(marqueur);
    await expect(page.getByLabel("Statut")).toHaveValue("VALIDE_SCHEMA");
    await expect(tableau.getByRole("rowheader", { name: a.corps.reference })).toBeVisible();
    await expect(tableau.getByRole("rowheader", { name: b.corps.reference })).toBeVisible();
  });

  test("telechargement du CSV d'erreurs : aucune cellule ne commence par =, +, - ou @ sans apostrophe", async ({ ouvrirProfil, run, marqueur }) => {
    const { page } = await ouvrirProfil();
    const source = `E2E-${marqueur}`;
    await ouvrirImports(page, run.comptes.admin);
    const r = await recevoir(page, fixture("hostile.csv", source), { source });
    expect(r.statut).toBe(201);
    await expect(page.getByRole("heading", { level: 2, name: r.corps.reference })).toBeVisible();

    const [telechargement] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Télécharger le rapport des erreurs" }).click(),
    ]);
    const chemin = await telechargement.path();
    const contenu = fs.readFileSync(chemin!, "utf8");
    const cellules = lireCsvPointVirgule(contenu).flat();
    expect(cellules.length).toBeGreaterThan(10);
    // Aucune cellule ne commence par un declencheur de formule ; la valeur d'origine est la cellule sans l'apostrophe initiale.
    const dangereuses = cellules.filter((c) => /^[=+\-@\t\r]/.test(c));
    expect(dangereuses, "cellules qui commencent par =, +, -, @ ou une tabulation").toEqual([]);
    expect(cellules).toEqual(expect.arrayContaining(["'=HYPERLINK(\"http://x\",\"a\")", "'+cmd|' /C calc'!A0", "'-2+3+cmd", "'@SUM(A1)", "'=1+1"]));
  });

  test("contenu hostile rendu comme TEXTE : aucun script execute, aucun dialogue, aucune image injectee", async ({ ouvrirProfil, run, marqueur }) => {
    const { page } = await ouvrirProfil();
    const source = `E2E-${marqueur}`;
    const dialogues: string[] = [];
    page.on("dialog", async (d) => { dialogues.push(d.message()); await d.dismiss(); });
    await ouvrirImports(page, run.comptes.admin);
    const r = await recevoir(page, fixture("hostile.csv", source), { source });
    expect(r.statut).toBe(201);
    const panneau = page.getByRole("region").filter({ has: page.getByRole("heading", { level: 2, name: r.corps.reference }) });
    await expect(panneau).toBeVisible();
    // L'apercu des lignes montre la charge brute : le texte de la balise est LU, pas interprete.
    await panneau.getByLabel("Filtrer par statut de ligne").selectOption("REJETEE");
    await expect(panneau.getByText("<img src=x onerror=window.__piege=3>").first()).toBeVisible();
    await panneau.getByLabel("Filtrer par statut de ligne").selectOption("VALIDEE");
    await expect(panneau.getByText(/<script>window\.__piege = 1<\/script>/).first()).toBeVisible();
    await page.waitForTimeout(500);

    expect(await page.evaluate(() => (window as unknown as { __piege?: number }).__piege)).toBeUndefined();
    expect(await page.locator('img[src="x"]').count()).toBe(0);
    expect(await page.locator("main script").count()).toBe(0);
    expect(dialogues).toEqual([]);
    // Meme apres un rechargement de la page (adresse du lot).
    await page.reload();
    await expect(page.getByRole("heading", { level: 2, name: r.corps.reference })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __piege?: number }).__piege)).toBeUndefined();
    expect(dialogues).toEqual([]);
  });

  for (const largeur of [375, 768]) {
    test(`${largeur} px : aucun debordement horizontal, captures hors depot`, async ({ ouvrirProfil, run, marqueur }) => {
      const { page } = await ouvrirProfil();
      const source = `E2E-${marqueur}`;
      await ouvrirImports(page, run.comptes.admin);
      const r = await recevoir(page, fixture("hostile.csv", source), { source });
      expect(r.statut).toBe(201);
      await page.setViewportSize({ width: largeur, height: 900 });
      await page.goto(`/imports?lot=${r.corps.id}`);
      await expect(page.getByRole("heading", { name: "Recevoir un lot de données" })).toBeVisible();
      await expect(page.getByRole("heading", { level: 2, name: r.corps.reference })).toBeVisible();
      await page.waitForTimeout(500);
      const mesure = await page.evaluate(() => ({ defile: document.documentElement.scrollWidth, visible: document.documentElement.clientWidth }));
      expect(mesure.defile, `scrollWidth ${mesure.defile} > clientWidth ${mesure.visible} a ${largeur} px`).toBeLessThanOrEqual(mesure.visible);
      fs.mkdirSync(DOSSIER_CAPTURES, { recursive: true });
      await page.screenshot({ path: path.join(DOSSIER_CAPTURES, `imports-${largeur}px.png`), fullPage: true });
    });
  }
});

// -----------------------------------------------------------------------------------------------------------------------------
// Droits : INSPECTEUR exclu, ADMIN et GESTIONNAIRE admis
// -----------------------------------------------------------------------------------------------------------------------------
test.describe("lots d'import : droits", () => {
  test("INSPECTEUR : lien absent du menu, URL directe refusee, API en 403", async ({ ouvrirProfil, run }, testInfo) => {
    const { page } = await ouvrirProfil();
    await seConnecter(page, run.comptes.agentA);
    await expect(page.getByRole("link", { name: "Lots d'import" })).toHaveCount(0);
    await page.goto("/imports");
    // La route est reservee a ADMIN et GESTIONNAIRE : l'application renvoie vers l'accueil, le formulaire n'apparait pas.
    await expect(page).not.toHaveURL(/\/imports/);
    await expect(page.getByRole("heading", { name: "Recevoir un lot de données" })).toHaveCount(0);

    const jeton = await jetonDe(run.comptes.agentA, testInfo, "10.77.1.1");
    expect((await appelerApi(testInfo, jeton, "GET", "/api/v2/imports")).statut).toBe(403);
    expect((await appelerApi(testInfo, jeton, "GET", "/api/v2/imports/meta")).statut).toBe(403);
    const avant = await nombreLots();
    expect((await appelerApi(testInfo, jeton, "POST", "/api/v2/imports", {})).statut).toBe(403);
    expect(await nombreLots()).toBe(avant);
  });

  for (const nom of ["admin", "gestionnaire"] as const) {
    test(`${nom.toUpperCase()} : lien dans le menu, page ouverte, API autorisee`, async ({ ouvrirProfil, run }, testInfo) => {
      const { page } = await ouvrirProfil();
      await seConnecter(page, run.comptes[nom]);
      await expect(page.getByRole("link", { name: "Lots d'import" })).toBeVisible();
      await page.getByRole("link", { name: "Lots d'import" }).click();
      await expect(page).toHaveURL(/\/imports/);
      await expect(page.getByRole("heading", { name: "Recevoir un lot de données" })).toBeVisible();
      const jeton = await jetonDe(run.comptes[nom], testInfo, `10.77.2.${nom === "admin" ? 1 : 2}`);
      expect((await appelerApi(testInfo, jeton, "GET", "/api/v2/imports/meta")).statut).toBe(200);
      expect((await appelerApi(testInfo, jeton, "GET", "/api/v2/imports")).statut).toBe(200);
    });
  }
});

const estUrlPost = (url: URL) => /\/api\/v2\/imports\/?$/.test(url.pathname);

/** Lecture minimale d'un CSV a point-virgule avec guillemets doubles (RFC 4180) : rend les lignes de cellules, en-tete compris. */
function lireCsvPointVirgule(texte: string): string[][] {
  const lignes: string[][] = [];
  let ligne: string[] = [];
  let cellule = "";
  let cite = false;
  const t = texte.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (cite) {
      if (c === '"' && t[i + 1] === '"') { cellule += '"'; i++; }
      else if (c === '"') cite = false;
      else cellule += c;
    } else if (c === '"') cite = true;
    else if (c === ";") { ligne.push(cellule); cellule = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      ligne.push(cellule); cellule = "";
      if (ligne.some((x) => x !== "") || ligne.length > 1) lignes.push(ligne);
      ligne = [];
    } else cellule += c;
  }
  if (cellule !== "" || ligne.length > 0) { ligne.push(cellule); lignes.push(ligne); }
  return lignes.filter((l) => !(l.length === 1 && l[0].startsWith("#")));
}

void detail;
void requete;
