import { randomUUID } from "node:crypto";
import { requete } from "../lib/base";
import { expect, seConnecter, test } from "../lib/fixtures";
import {
  ApiVoirie, BASE, accorderPerimetre, auditDe, codeProjet, comptesInterdits, creerCompte, creerRegion, creerTerritoire, empreinteTroncons,
  jeuxDuProjet, nombreObjetsDuJeu, territoireNational, type CompteVoirie,
} from "../lib/voirie";
import { AXES, RESEAU_TELECOM, boiteWgs84, geojson, polygoneDeBoite, type Ligne } from "../lib/voirie-geo";

/**
 * Lot C1 bis, scenarios multi-territoires (decision architecturale 2, sections 2 et 8 ; CONTRAT-TERRITOIRES.md ; CONTRAT-EXPORTS.md, section 6).
 *
 *   a. « nouvelle ville sans code » : un ADMIN cree une region, une prefecture et une commune par l'ecran Parametres ; un gestionnaire de cette region
 *      y rattache un projet par le selecteur ; depot, autorisation, analyse ; CRS de calcul par bandes puis impose par le territoire ; un compte d'une
 *      autre region ne voit rien (404 identique a l'inexistant, liste, tableau de bord, ecran) ;
 *   b. projet lineaire : un corridor de niveau ZONE sous une region couvre trois prefectures et porte deux projets de largeurs differentes ; filtre par
 *      territoire (API et ecran) ;
 *   f. tableaux de bord national et par territoire, filtres par perimetre ; un lecteur ne compte ni la quarantaine, ni les pieces en cours, ni les referents.
 * Donnees 100 % synthetiques : noms « synthetique », codes tires au hasard, origine UTM arbitraire (lib/voirie-geo.ts), aucun lieu reel.
 */

test.describe.configure({ mode: "serial" });

const suffixe = randomUUID().slice(0, 6).toUpperCase();
const UUID_INCONNU = "00000000-0000-4000-8000-0000000000ef";

let admin: CompteVoirie;
let gestionnaireRegional: CompteVoirie;
let autreRegional: CompteVoirie;
let national: CompteVoirie;
let lecteur: CompteVoirie;
let regionNouvelle = 0;
let regionAutre = 0;

const ville = {
  region: { code: `E2E-REG-NV-${suffixe}`, nom: `Region synthetique NV ${suffixe}`, id: "" },
  prefecture: { code: `E2E-PREF-NV-${suffixe}`, nom: `Prefecture synthetique NV ${suffixe}`, id: "" },
  commune: { code: `E2E-COM-NV-${suffixe}`, nom: `Commune synthetique NV ${suffixe}`, id: "" },
  projetId: "", projetCode: "", jeuAxes: "", jeuReseau: "",
};
let territoireAutreRegion = "";

test.beforeAll(async () => {
  admin = await creerCompte("e2e-terr-admin", "Admin Territoires C1bis", "ADMIN");
  gestionnaireRegional = await creerCompte("e2e-terr-greg", "Gestionnaire region nouvelle", "GESTIONNAIRE");
  autreRegional = await creerCompte("e2e-terr-autre", "Gestionnaire autre region", "GESTIONNAIRE");
  national = await creerCompte("e2e-terr-nat", "Gestionnaire national C1bis", "GESTIONNAIRE");
  lecteur = await creerCompte("e2e-terr-lect", "Lecteur national C1bis", "LECTEUR");
  // Regions du referentiel ADMINISTRATIF (perimetre des comptes, table `regions` hors module) : donnees de reference, creees ici comme en C1.
  regionNouvelle = await creerRegion(`E2E Region administrative NV ${suffixe}`);
  regionAutre = await creerRegion(`E2E Region administrative AUTRE ${suffixe}`);
  await accorderPerimetre(gestionnaireRegional.id, regionNouvelle, admin.id);
  await accorderPerimetre(autreRegional.id, regionAutre, admin.id);
  territoireAutreRegion = await creerTerritoire({ code: `E2E-REG-AUTRE-${suffixe}`, nom: `Region synthetique AUTRE ${suffixe}`, niveau: "REGION", regionId: regionAutre });
});

/** Emprise approximative de la commune : un rectangle de 1,4 km x 1 km autour de l'origine synthetique. */
const BOITE_COMMUNE = boiteWgs84(-500, -400, 900, 600);
const fmt = (v: number) => v.toFixed(6);

test("a. nouvelle ville sans code : un ADMIN crée région, préfecture et commune par l'écran Paramètres (audit, région effective propagée)", async ({ ouvrirProfil }) => {
  const referentiel = await comptesInterdits();
  const troncons = await empreinteTroncons();
  const { page } = await ouvrirProfil();
  await seConnecter(page, admin);
  await page.goto("/projets-voirie");
  await page.getByRole("link", { name: "Paramètres du module" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Paramètres du module" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Territoires" })).toHaveAttribute("aria-selected", "true");
  const recherche = page.getByLabel("Rechercher un territoire");

  // ---- Region sous la nation, rattachee a la region administrative (perimetre des comptes)
  await page.getByRole("button", { name: "Sous-territoire de Guinée", exact: true }).click();
  let d = page.getByRole("dialog", { name: "Nouveau territoire sous « Guinée »" });
  await d.getByLabel("Code", { exact: true }).fill(ville.region.code);
  await d.getByLabel("Niveau").selectOption("REGION");
  await d.getByLabel("Nom", { exact: true }).fill(ville.region.nom);
  await d.getByLabel("Région administrative (périmètre des comptes)").selectOption({ label: `E2E Region administrative NV ${suffixe}` });
  await d.getByRole("button", { name: "Créer le territoire" }).click();
  await expect(page.getByTestId("annonce-territoire")).toContainText(`Territoire « ${ville.region.nom} » créé.`);

  // ---- Prefecture sous la region (region heritee)
  await recherche.fill(ville.region.code);
  await page.getByRole("button", { name: `Sous-territoire de ${ville.region.nom}`, exact: true }).click();
  d = page.getByRole("dialog", { name: `Nouveau territoire sous « ${ville.region.nom} »` });
  await d.getByLabel("Code", { exact: true }).fill(ville.prefecture.code);
  await d.getByLabel("Niveau").selectOption("PREFECTURE");
  await d.getByLabel("Nom", { exact: true }).fill(ville.prefecture.nom);
  await d.getByRole("button", { name: "Créer le territoire" }).click();
  await expect(page.getByTestId("annonce-territoire")).toContainText(`Territoire « ${ville.prefecture.nom} » créé.`);

  // ---- Commune sous la prefecture, avec une emprise APPROXIMATIVE (rectangle par ses bornes)
  await recherche.fill(ville.prefecture.code);
  await page.getByRole("button", { name: `Sous-territoire de ${ville.prefecture.nom}`, exact: true }).click();
  d = page.getByRole("dialog", { name: `Nouveau territoire sous « ${ville.prefecture.nom} »` });
  await d.getByLabel("Code", { exact: true }).fill(ville.commune.code);
  await d.getByLabel("Niveau").selectOption("COMMUNE");
  await d.getByLabel("Nom", { exact: true }).fill(ville.commune.nom);
  await d.getByLabel("Source (facultatif)").fill("emprise approximative synthetique (essai de bout en bout)");
  await d.getByRole("radio", { name: "Rectangle par ses quatre bornes" }).check();
  await d.getByLabel("Ouest (longitude min.)").fill(fmt(BOITE_COMMUNE[0]));
  await d.getByLabel("Sud (latitude min.)").fill(fmt(BOITE_COMMUNE[1]));
  await d.getByLabel("Est (longitude max.)").fill(fmt(BOITE_COMMUNE[2]));
  await d.getByLabel("Nord (latitude max.)").fill(fmt(BOITE_COMMUNE[3]));
  await d.getByRole("button", { name: "Créer le territoire" }).click();
  await expect(page.getByTestId("annonce-territoire")).toContainText(`Territoire « ${ville.commune.nom} » créé.`);
  // L'arborescence montre la commune avec son emprise et la regle nationale de CRS.
  await recherche.fill(ville.commune.code);
  const ligne = page.getByRole("listitem").filter({ hasText: ville.commune.code });
  await expect(ligne).toContainText("Commune");
  await expect(ligne).toContainText("règle nationale par bandes");
  await expect(ligne).not.toContainText("Emprise : aucune");

  // ---- En base : chaine, profondeur, region effective PROPAGEE, emprise, auteur ; audit sans geometrie
  const nation = await territoireNational();
  const lignes = await requete<{ id: string; code: string; niveau: string; parent: string | null; profondeur: number; region: number | null; effective: number | null; emprise: boolean; auteur: string | null }>(
    `SELECT id, code, niveau::text AS niveau, "parentId" AS parent, profondeur, "regionId" AS region, "regionEffectiveId" AS effective,
            emprise IS NOT NULL AS emprise, "creeParId" AS auteur
       FROM territoires_voirie WHERE code = ANY($1) AND "deletedAt" IS NULL`, [[ville.region.code, ville.prefecture.code, ville.commune.code]]);
  const parCode = new Map(lignes.map((l) => [l.code, l]));
  const r = parCode.get(ville.region.code)!, p = parCode.get(ville.prefecture.code)!, c = parCode.get(ville.commune.code)!;
  expect(r).toMatchObject({ niveau: "REGION", parent: nation, profondeur: 1, region: regionNouvelle, effective: regionNouvelle, emprise: false, auteur: admin.id });
  expect(p).toMatchObject({ niveau: "PREFECTURE", parent: r.id, profondeur: 2, region: null, effective: regionNouvelle, auteur: admin.id });
  expect(c).toMatchObject({ niveau: "COMMUNE", parent: p.id, profondeur: 3, region: null, effective: regionNouvelle, emprise: true, auteur: admin.id });
  ville.region.id = r.id; ville.prefecture.id = p.id; ville.commune.id = c.id;
  for (const t of [r, p, c]) {
    const audit = await auditDe("TerritoireVoirie", t.id);
    expect(audit.map((a) => a.action), `audit de ${t.code}`).toEqual(["CREATE"]);
    expect(audit[0].userId).toBe(admin.id);
    expect(JSON.stringify(audit), "l'audit ne porte aucune coordonnee d'emprise").not.toMatch(/coordinates|Polygon/);
  }
  // Le referentiel officiel n'a pas bouge.
  expect(await comptesInterdits()).toEqual(referentiel);
  expect(await empreinteTroncons()).toBe(troncons);
});

test("a. un gestionnaire de la nouvelle région y rattache un projet par le sélecteur ; dépôt, autorisation, analyse ; CRS par bandes puis imposé par le territoire", async ({ ouvrirProfil, marqueur }) => {
  test.skip(!ville.commune.id, "depend de la creation des territoires");
  const referentiel = await comptesInterdits();
  const troncons = await empreinteTroncons();
  const { page } = await ouvrirProfil();
  await seConnecter(page, gestionnaireRegional);
  await page.goto("/projets-voirie");
  await page.getByRole("button", { name: "Nouveau projet" }).click();
  const creation = page.getByRole("dialog", { name: "Nouveau projet de voirie et réseaux" });
  ville.projetCode = codeProjet(marqueur, "NV");
  await creation.getByLabel("Code du projet").fill(ville.projetCode);
  await creation.getByLabel("Nom du projet").fill(`Voirie nouvelle ville ${marqueur}`);
  const recherche = creation.getByRole("searchbox", { name: "Rechercher (nom ou code)" });
  // Le selecteur est celui du PERIMETRE : le territoire d'une autre region n'y figure pas, la nation non plus.
  await recherche.fill(`E2E-REG-AUTRE-${suffixe}`);
  await expect(creation.getByText("Aucun territoire ne correspond à cette recherche.")).toBeVisible();
  await recherche.fill(ville.commune.code);
  await creation.getByRole("radio", { name: new RegExp(ville.commune.code) }).check();
  await expect(creation.getByTestId("territoire-choisi")).toContainText(ville.prefecture.nom);
  await creation.getByRole("button", { name: "Créer le projet" }).click();
  await expect(page.getByRole("heading", { level: 1, name: `Voirie nouvelle ville ${marqueur}` })).toBeVisible();

  const projets = await requete<{ id: string; region: number | null; commune: string | null; prefecture: string | null; territoire: string }>(
    `SELECT id, "regionId" AS region, commune, prefecture, "territoireId" AS territoire FROM projets_voirie WHERE code = $1`, [ville.projetCode]);
  // Region, commune et prefecture DERIVEES du territoire (aucune saisie, aucun nom code).
  expect(projets).toEqual([{ id: expect.any(String), region: regionNouvelle, commune: ville.commune.nom, prefecture: ville.prefecture.nom, territoire: ville.commune.id }]);
  ville.projetId = projets[0].id;
  // La fiche montre le territoire et ses ancetres.
  await expect(page.getByText(ville.commune.nom).first()).toBeVisible();

  // ---- Depot, autorisation, analyse (API du gestionnaire regional)
  const g = await ApiVoirie.connecter(gestionnaireRegional);
  const conc = await g.creerConcessionnaire(`Operateur synthetique NV ${suffixe}`, "TELECOM");
  ville.jeuAxes = await g.deposerEtAutoriser(ville.projetId, { name: "axes-nv.geojson", buffer: geojson(AXES) }, { role: "AXES_TRAVAUX" });
  const depotReseau = await g.deposer(ville.projetId, { name: "reseau-nv.geojson", buffer: geojson(RESEAU_TELECOM) }, { role: "RESEAU_TIERS", concessionnaireId: conc, classePrecision: "B" });
  expect(depotReseau.statut, depotReseau.texte.slice(0, 300)).toBe(201);
  ville.jeuReseau = depotReseau.corps.jeu.id;
  const avertissementsDe = async (jeuId: string) => ((await jeuxDuProjet(ville.projetId)).find((j) => j.id === jeuId)?.avertissements ?? []).map((a) => a.code);
  expect(await avertissementsDe(ville.jeuReseau), "dans l'emprise de la commune : aucun signalement hors territoire").not.toContain("ELEMENTS_HORS_TERRITOIRE");
  expect((await g.autoriser(ville.projetId, ville.jeuReseau)).statut).toBe(200);
  // Un jeu a 3 km de la commune (hors de son emprise APPROXIMATIVE, dans le pays) : signale, jamais ecarte.
  const loin: Ligne[] = [{ nom: "Fibre-Synth hors commune", coords: [[3_000, 3_000], [3_100, 3_000]] }];
  const horsCommune = await g.deposer(ville.projetId, { name: "reseau-hors-commune.geojson", buffer: geojson(loin) }, { role: "RESEAU_TIERS", concessionnaireId: await g.creerConcessionnaire(`Operateur synthetique NV2 ${suffixe}`, "EAU_POTABLE"), classePrecision: "C" });
  expect(horsCommune.statut, horsCommune.texte.slice(0, 300)).toBe(201);
  expect(await avertissementsDe(horsCommune.corps.jeu.id), "hors de l'emprise du territoire : signale").toContain("ELEMENTS_HORS_TERRITOIRE");
  expect(await nombreObjetsDuJeu(horsCommune.corps.jeu.id), "compte, pas ecarte").toBe(1);

  const a1 = await g.get(`${BASE}/${ville.projetId}/analyse`);
  expect(a1.statut, a1.texte.slice(0, 300)).toBe(200);
  expect(a1.corps.parametres.projection, "CRS de calcul : regle nationale par bandes (longitude > -12)").toBe("EPSG:32629");
  expect(a1.corps.conflits.total.chausseeM, "l'analyse 2D mesure les reseaux en chaussee").toBeGreaterThan(0);
  const persistee = await g.analyser(ville.projetId);
  expect(persistee.statut, persistee.texte.slice(0, 300)).toBe(201);
  expect((await g.get(`${BASE}/${ville.projetId}/conflits?limite=200`)).corps.conflits.length, "dossiers de conflit crees").toBeGreaterThan(0);

  // ---- CRS impose par le territoire, choisi par l'ADMIN dans l'ecran (liste blanche) : l'analyse suivante l'utilise.
  const { page: pa } = await ouvrirProfil();
  await seConnecter(pa, admin);
  await pa.goto("/projets-voirie/parametres");
  await pa.getByLabel("Rechercher un territoire").fill(ville.commune.code);
  await pa.getByRole("button", { name: `Modifier ${ville.commune.nom}`, exact: true }).click();
  const m = pa.getByRole("dialog", { name: `Modifier « ${ville.commune.nom} »` });
  await m.getByLabel("Système métrique de calcul").selectOption("32628");
  await m.getByRole("button", { name: "Enregistrer" }).click();
  await expect(pa.getByTestId("annonce-territoire")).toContainText(`Territoire « ${ville.commune.nom} » modifié.`);
  expect((await requete<{ e: number }>(`SELECT "crsMetriqueEpsg" AS e FROM territoires_voirie WHERE id = $1`, [ville.commune.id]))[0].e).toBe(32628);
  const a2 = await g.get(`${BASE}/${ville.projetId}/analyse`);
  expect(a2.corps.parametres.projection, "CRS impose par le territoire du projet").toBe("EPSG:32628");

  expect(await comptesInterdits(), "aucune ecriture dans le referentiel officiel").toEqual(referentiel);
  expect(await empreinteTroncons()).toBe(troncons);
  await g.fermer();
});

test("a. un compte d'une autre région ne voit rien : 404 identique à l'inexistant (projet, territoire, tableau), listes filtrées, écran « introuvable »", async ({ ouvrirProfil }) => {
  test.skip(!ville.projetId, "depend du projet de la nouvelle ville");
  const b = await ApiVoirie.connecter(autreRegional);
  for (const [nom, vrai, faux] of [
    ["projet", `${BASE}/${ville.projetId}`, `${BASE}/${UUID_INCONNU}`],
    ["jeux du projet", `${BASE}/${ville.projetId}/jeux`, `${BASE}/${UUID_INCONNU}/jeux`],
    ["analyse", `${BASE}/${ville.projetId}/analyse`, `${BASE}/${UUID_INCONNU}/analyse`],
    ["conflits", `${BASE}/${ville.projetId}/conflits`, `${BASE}/${UUID_INCONNU}/conflits`],
    ["sources", `${BASE}/${ville.projetId}/sources`, `${BASE}/${UUID_INCONNU}/sources`],
    ["completude", `${BASE}/${ville.projetId}/completude`, `${BASE}/${UUID_INCONNU}/completude`],
    ["documents", `${BASE}/${ville.projetId}/documents`, `${BASE}/${UUID_INCONNU}/documents`],
    ["territoire (region)", `${BASE}/territoires/${ville.region.id}`, `${BASE}/territoires/${UUID_INCONNU}`],
    ["territoire (commune)", `${BASE}/territoires/${ville.commune.id}`, `${BASE}/territoires/${UUID_INCONNU}`],
    ["tableau de bord du territoire", `${BASE}/tableau-de-bord/territoires/${ville.region.id}`, `${BASE}/tableau-de-bord/territoires/${UUID_INCONNU}`],
  ] as const) {
    const rv = await b.get(vrai), rf = await b.get(faux);
    expect(rv.statut, `${nom} hors perimetre`).toBe(404);
    expect(rv.corps, `${nom} : meme corps qu'une ressource inexistante`).toEqual(rf.corps);
  }
  // Ecritures : rien ne passe, rien n'est ecrit.
  const avant = await requete<{ n: string }>(`SELECT count(*)::text AS n FROM projets_voirie_jeux WHERE "projetId" = $1`, [ville.projetId]);
  expect((await b.deposer(ville.projetId, { name: "intrus.geojson", buffer: geojson(AXES, [7, 7]) }, { role: "AXES_TRAVAUX" })).statut).toBe(404);
  expect((await b.post(`${BASE}/${ville.projetId}/analyses`, {})).statut).toBe(404);
  const creer = await b.post(BASE, { code: `E2E-INTRUS-${suffixe}`, nom: "Intrus", territoireId: ville.commune.id });
  const creerInconnu = await b.post(BASE, { code: `E2E-INTRUS2-${suffixe}`, nom: "Intrus", territoireId: UUID_INCONNU });
  expect(creer.statut).toBe(404);
  expect(creer.corps, "creation sur un territoire d'une autre region : meme reponse qu'un territoire inexistant").toEqual(creerInconnu.corps);
  expect((await requete<{ n: string }>(`SELECT count(*)::text AS n FROM projets_voirie_jeux WHERE "projetId" = $1`, [ville.projetId]))[0].n).toBe(avant[0].n);
  expect(await requete(`SELECT 1 FROM projets_voirie WHERE code LIKE $1`, [`E2E-INTRUS%-${suffixe}`])).toHaveLength(0);
  // Listes : ni le projet ni les territoires de la nouvelle ville ; sa propre region, oui.
  const projets = (await b.get(`${BASE}?limite=100`)).corps.projets.map((x: { id: string }) => x.id);
  expect(projets).not.toContain(ville.projetId);
  const territoires = (await b.get(`${BASE}/territoires?limite=500`)).corps.territoires.map((t: { id: string }) => t.id);
  for (const id of [ville.region.id, ville.prefecture.id, ville.commune.id, await territoireNational()]) expect(territoires).not.toContain(id);
  expect(territoires).toContain(territoireAutreRegion);
  // Tableau national du compte : sa region seulement.
  const tb = await b.get(`${BASE}/tableau-de-bord`);
  expect(tb.statut, tb.texte.slice(0, 300)).toBe(200);
  expect(tb.corps.perimetre).toMatchObject({ national: false, regions: [regionAutre] });
  expect(tb.corps.parRegion.map((x: { regionId: number }) => x.regionId)).not.toContain(regionNouvelle);
  await b.fermer();
  // Ecran : « introuvable », jamais le code du projet.
  const { page } = await ouvrirProfil();
  await seConnecter(page, autreRegional);
  await page.goto(`/projets-voirie/${ville.projetId}`);
  await expect(page.locator('[data-etat="introuvable"]')).toBeVisible();
  await expect(page.getByText(ville.projetCode)).toHaveCount(0);
  await expect(page.getByText(ville.commune.nom)).toHaveCount(0);
});

// ---------------------------------------------------------------------------------------------- b. corridor interprefectoral

const corridor = {
  region: "", prefectures: [] as string[], zone: "", projetLarge: "", projetEtroit: "", projetPrefecture: "", codes: { large: "", etroit: "", pref: "" },
};

/** Trois prefectures adjacentes de 10 km sur 4 km, le long de l'axe x ; le corridor (ZONE) couvre les trois. */
const BOITES_PREF = [0, 1, 2].map((i) => boiteWgs84(i * 10_000, -2_000, (i + 1) * 10_000, 2_000));
const BOITE_CORRIDOR = boiteWgs84(-100, -500, 30_100, 500);
/** Axe de 28 km qui traverse les trois prefectures ; reseau parallele a 5 m de l'axe sur 1 km. */
const AXE_LONG: Ligne[] = [{ nom: "Axe long synthetique", coords: [[1_000, 0], [15_000, 0], [29_000, 0]] }];
const RESEAU_PARALLELE: Ligne[] = [{ nom: "Cable-Synth parallele 5 m", coords: [[12_000, 5], [13_000, 5]] }];

test("b. projet linéaire : un corridor ZONE couvre trois préfectures et porte deux projets de largeurs différentes ; filtre par territoire", async ({ marqueur }) => {
  const adm = await ApiVoirie.connecter(admin);
  corridor.region = await creerTerritoire({ code: `E2E-REG-COR-${suffixe}`, nom: `Region synthetique COR ${suffixe}`, niveau: "REGION", regionId: regionNouvelle }, adm);
  for (const [i, boite] of BOITES_PREF.entries()) {
    corridor.prefectures.push(await creerTerritoire({ code: `E2E-PREF-COR${i + 1}-${suffixe}`, nom: `Prefecture synthetique COR${i + 1} ${suffixe}`, niveau: "PREFECTURE", parentId: corridor.region, emprise: polygoneDeBoite(boite) }, adm));
  }
  // Le corridor est un FRERE des prefectures (sous la region) : la hierarchie n'est pas un pavage.
  const z = await adm.post(`${BASE}/territoires`, { code: `E2E-ZONE-COR-${suffixe}`, nom: `Corridor synthetique ${suffixe}`, niveau: "ZONE", parentId: corridor.region, emprise: polygoneDeBoite(BOITE_CORRIDOR), source: "corridor synthetique (essai de bout en bout)" });
  expect(z.statut, z.texte.slice(0, 300)).toBe(201);
  corridor.zone = z.corps.territoire.id;
  expect(z.corps.territoire).toMatchObject({ niveau: "ZONE", parentId: corridor.region, regionEffectiveId: regionNouvelle });
  const couvre = await requete<{ c: boolean }>(
    `SELECT bool_and(ST_Intersects(z.emprise, p.emprise)) AS c FROM territoires_voirie z, territoires_voirie p WHERE z.id = $1 AND p.id = ANY($2)`, [corridor.zone, corridor.prefectures]);
  expect(couvre[0].c, "l'emprise du corridor traverse les trois prefectures").toBe(true);

  // Deux projets distincts sur le meme corridor, largeurs differentes ; un troisieme dans une prefecture traversee.
  const g = await ApiVoirie.connecter(gestionnaireRegional);
  corridor.codes = { large: codeProjet(marqueur, "COR-LARGE"), etroit: codeProjet(marqueur, "COR-ETROIT"), pref: codeProjet(marqueur, "COR-PREF2") };
  corridor.projetLarge = await g.creerProjet(corridor.codes.large, { territoireId: corridor.zone, largeurEmpriseM: 30, largeurChausseeM: 12 });
  corridor.projetEtroit = await g.creerProjet(corridor.codes.etroit, { territoireId: corridor.zone, largeurEmpriseM: 20, largeurChausseeM: 8 });
  corridor.projetPrefecture = await g.creerProjet(corridor.codes.pref, { territoireId: corridor.prefectures[1] });
  const lignes = await requete<{ id: string; region: number; commune: string | null; prefecture: string | null; emprise: number; chaussee: number }>(
    `SELECT id, "regionId" AS region, commune, prefecture, "largeurEmpriseM"::float AS emprise, "largeurChausseeM"::float AS chaussee FROM projets_voirie WHERE id = ANY($1)`,
    [[corridor.projetLarge, corridor.projetEtroit]]);
  for (const l of lignes) expect(l, "un corridor n'invente ni commune ni prefecture ; region derivee").toMatchObject({ region: regionNouvelle, commune: null, prefecture: null });
  expect(lignes.find((l) => l.id === corridor.projetLarge)).toMatchObject({ emprise: 30, chaussee: 12 });
  expect(lignes.find((l) => l.id === corridor.projetEtroit)).toMatchObject({ emprise: 20, chaussee: 8 });

  // Meme axe, meme reseau a 5 m : en chaussee pour la chaussee de 12 m (demi 6 m), hors chaussee mais dans l'emprise pour 8 m (demi 4 m).
  const conc = await g.creerConcessionnaire(`Operateur synthetique COR ${suffixe}`, "ELECTRICITE");
  for (const id of [corridor.projetLarge, corridor.projetEtroit]) {
    await g.deposerEtAutoriser(id, { name: "axe-long.geojson", buffer: geojson(AXE_LONG) }, { role: "AXES_TRAVAUX" });
    await g.deposerEtAutoriser(id, { name: "cable-parallele.geojson", buffer: geojson(RESEAU_PARALLELE) }, { role: "RESEAU_TIERS", concessionnaireId: conc, classePrecision: "B" });
  }
  const large = (await g.get(`${BASE}/${corridor.projetLarge}/analyse`)).corps;
  const etroit = (await g.get(`${BASE}/${corridor.projetEtroit}/analyse`)).corps;
  expect(large.parametres).toMatchObject({ largeurChausseeM: 12, largeurEmpriseM: 30 });
  expect(etroit.parametres).toMatchObject({ largeurChausseeM: 8, largeurEmpriseM: 20 });
  expect(large.conflits.total.chausseeM, "chaussee de 12 m : le cable a 5 m est en chaussee").toBeGreaterThan(990);
  expect(etroit.conflits.total.chausseeM, "chaussee de 8 m : le cable a 5 m n'est pas en chaussee").toBe(0);
  expect(etroit.conflits.total.empriseM, "mais il est dans l'emprise de 20 m").toBeGreaterThan(990);

  // Filtre par territoire : le territoire ET ses descendants, jamais un frere.
  const ids = async (tid: string) => ((await g.get(`${BASE}?limite=100&territoireId=${tid}`)).corps.projets as Array<{ id: string }>).map((p) => p.id).sort();
  expect(await ids(corridor.zone)).toEqual([corridor.projetLarge, corridor.projetEtroit].sort());
  expect(await ids(corridor.prefectures[1]), "le corridor n'est pas sous la prefecture qu'il traverse").toEqual([corridor.projetPrefecture]);
  expect(await ids(corridor.prefectures[0])).toEqual([]);
  expect(await ids(corridor.region)).toEqual([corridor.projetLarge, corridor.projetEtroit, corridor.projetPrefecture].sort());
  // La fiche de chaque projet porte le corridor.
  expect((await g.get(`${BASE}/${corridor.projetLarge}`)).corps.projet.territoire).toMatchObject({ id: corridor.zone, niveau: "ZONE" });
  await Promise.all([adm.fermer(), g.fermer()]);
});

test("b. filtre par territoire dans la liste des projets (écran) : le corridor montre ses deux projets, pas celui de la préfecture", async ({ ouvrirProfil }) => {
  test.skip(!corridor.zone, "depend du corridor");
  const { page } = await ouvrirProfil();
  await seConnecter(page, national);
  await page.goto("/projets-voirie");
  await page.getByRole("button", { name: "Filtrer par territoire" }).click();
  const filtre = page.locator("#pv-filtre-territoire");
  await filtre.getByRole("searchbox", { name: "Rechercher (nom ou code)" }).fill(`E2E-ZONE-COR-${suffixe}`);
  await filtre.getByRole("radio", { name: new RegExp(`E2E-ZONE-COR-${suffixe}`) }).check();
  await expect(page.getByTestId("filtre-territoire-actif")).toContainText(`Corridor synthetique ${suffixe}`);
  await expect(page.getByRole("row", { name: new RegExp(`Projet ${corridor.codes.large}`) })).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(`Projet ${corridor.codes.etroit}`) })).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(`Projet ${corridor.codes.pref}`) })).toHaveCount(0);
  // La colonne Territoire dit « Zone » ; aucune commune n'est inventee pour un corridor.
  await expect(page.getByRole("row", { name: new RegExp(`Projet ${corridor.codes.large}`) })).toContainText(`Corridor synthetique ${suffixe}`);
  await page.getByRole("button", { name: "Retirer le filtre" }).click();
  await expect(page.getByTestId("filtre-territoire-actif")).toHaveCount(0);
});

// ---------------------------------------------------------------------------------------------- f. tableaux de bord

test("f. tableaux de bord national et par territoire : agrégats seulement, périmètre du compte, lecteur sans quarantaine ni pièces en cours", async () => {
  test.skip(!corridor.projetPrefecture, "depend du corridor");
  const g = await ApiVoirie.connecter(gestionnaireRegional);
  // Un jeu en quarantaine dans le projet de la prefecture : compte pour un decideur, jamais pour un lecteur.
  await g.deposerOk(corridor.projetPrefecture, { name: "axes-quarantaine.geojson", buffer: geojson(AXES) }, { role: "AXES_TRAVAUX" });

  const nat = await ApiVoirie.connecter(national);
  const t = await nat.get(`${BASE}/tableau-de-bord/territoires/${corridor.region}`);
  expect(t.statut, t.texte.slice(0, 300)).toBe(200);
  expect(t.corps).toMatchObject({ portee: "TERRITOIRE", territoire: { id: corridor.region, niveau: "REGION" }, lisibilite: { jeux: "TOUS_SAUF_RETIRE", documentsEnCours: true, referents: true } });
  expect(t.corps.total.projets, "le territoire et ses descendants : deux projets du corridor, un de prefecture").toBe(3);
  expect(t.corps.total.jeux).toMatchObject({ AUTORISE: 4, CONTROLE: 1 });
  expect(t.corps.rattachesDirectement.projets, "aucun projet sur la region elle-meme").toBe(0);
  const enfant = (tid: string) => t.corps.enfants.find((e: { territoireId: string }) => e.territoireId === tid);
  expect(enfant(corridor.zone)).toMatchObject({ niveau: "ZONE", projets: 2 });
  expect(enfant(corridor.prefectures[1])).toMatchObject({ niveau: "PREFECTURE", projets: 1 });
  expect(enfant(corridor.prefectures[0])).toMatchObject({ projets: 0 });
  expect(t.corps.total.referentsActifs).not.toBeNull();
  expect(t.corps.total.documentsManquants.piecesEnAttente).not.toBeNull();
  // Agregats seulement : aucun nom de fichier, d'objet ni de concessionnaire.
  expect(t.texte).not.toMatch(/axes-quarantaine|Cable-Synth|Operateur synthetique|coordinates/);

  // Lecteur national : jeux AUTORISE seulement (aucun comptage de quarantaine), pieces en cours et referents nuls.
  const l = await ApiVoirie.connecter(lecteur);
  const tl = await l.get(`${BASE}/tableau-de-bord/territoires/${corridor.region}`);
  expect(tl.statut).toBe(200);
  expect(tl.corps.lisibilite).toMatchObject({ jeux: "AUTORISE_SEULEMENT", conflits: "DOSSIERS_VISIBLES", documentsEnCours: false, referents: false });
  expect(tl.corps.total.jeux.AUTORISE).toBe(4);
  expect(Object.entries(tl.corps.total.jeux).filter(([k, v]) => k !== "AUTORISE" && Number(v) > 0), "un lecteur ne compte que les jeux autorises").toEqual([]);
  expect(tl.corps.total.documentsManquants.piecesEnAttente).toBeNull();
  expect(tl.corps.total.referentsActifs).toBeNull();

  // National : la nouvelle region apparait avec ses projets (nouvelle ville + corridor + prefecture).
  const n = await nat.get(`${BASE}/tableau-de-bord`);
  expect(n.statut).toBe(200);
  expect(n.corps).toMatchObject({ portee: "NATIONAL", perimetre: { national: true } });
  const ligneRegion = n.corps.parRegion.find((x: { regionId: number }) => x.regionId === regionNouvelle);
  expect(ligneRegion.projets, "nouvelle ville (1) + corridor (2) + prefecture (1)").toBe(ville.projetId ? 4 : 3);
  expect(n.corps.total.projets).toBeGreaterThanOrEqual(ligneRegion.projets);

  // Compte regional de la nouvelle region : son perimetre seulement ; il voit le tableau du territoire.
  const r = await g.get(`${BASE}/tableau-de-bord`);
  expect(r.corps.perimetre).toMatchObject({ national: false, regions: [regionNouvelle] });
  expect(r.corps.parRegion.map((x: { regionId: number }) => x.regionId)).toEqual([regionNouvelle]);
  expect(r.corps.total.projets).toBe(ligneRegion.projets);
  expect((await g.get(`${BASE}/tableau-de-bord/territoires/${corridor.zone}`)).corps.total.projets).toBe(2);
  // Aucun parametre accepte (400), et un compte d'une autre region recoit 404 masque (verifie en a).
  expect((await g.get(`${BASE}/tableau-de-bord?region=${regionAutre}`)).statut).toBe(400);
  await Promise.all([g.fermer(), nat.fermer(), l.fermer()]);
});
