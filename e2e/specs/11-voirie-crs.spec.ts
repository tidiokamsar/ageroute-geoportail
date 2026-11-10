import { requete } from "../lib/base";
import { expect, seConnecter, test } from "../lib/fixtures";
import {
  ApiVoirie, BASE, CHAMPS_CSV_AXES, attendreEtape, codeProjet, configurerCsvLignes, continuer, creerCompte, etapeDepot, jeuxDuProjet, ouvrirAssistant,
  ouvrirProjet, type CompteVoirie,
} from "../lib/voirie";
import { AXES, AXE_ISOLE, csvUtm, distanceMetres, kml, versWgs84, type Ligne, type Point } from "../lib/voirie-geo";

/**
 * KIS-CRS-01 (cahier 22.3) : un plan d'axes en UTM 29N (CSV) et un reseau KML en WGS 84.
 *
 *   - sans choix de CRS, l'interface EXIGE le choix : aucune valeur par defaut, aucun bouton qui avance ;
 *   - avec le CRS choisi, la transformation est affichee (source, cible, unites, methode) ;
 *   - le resultat se superpose a un KML WGS 84 de reference a moins de 5 cm : la reference est calculee par une formule INDEPENDANTE de
 *     l'application (series de Kruger, e2e/lib/voirie-geo.ts), la transformation de l'application est lue par l'API (apercu) et en base ;
 *   - un CRS hors liste blanche est refuse ; un fichier hors de la Guinee declenche l'alerte bloquante.
 */


let gestionnaire: CompteVoirie;
test.beforeAll(async () => { gestionnaire = await creerCompte("e2e-crs-gest", "Gestionnaire CRS E2E", "GESTIONNAIRE"); });

const PLAN = [...AXES, AXE_ISOLE];
const fichierPlan = (lignes: Ligne[] = PLAN) => ({ name: "plan-axes-utm29n.csv", buffer: csvUtm(lignes), mimeType: "text/csv" });

/** Distance maximale, en metres, entre les sommets d'un axe lu par l'API (WGS 84) et ceux de la reference. */
function ecartMax(lu: Array<{ nom: string | null; geometrie: { coordinates: Point[] } }>, reference: Ligne[], decalage: Point = [0, 0]): number {
  let max = 0;
  let compares = 0;
  for (const ref of reference) {
    const obj = lu.find((o) => o.nom === ref.nom);
    expect(obj, `l'axe « ${ref.nom} » est lu par l'application`).toBeTruthy();
    const attendus = ref.coords.map(([x, y]) => versWgs84([x + decalage[0], y + decalage[1]]));
    expect(obj!.geometrie.coordinates, `meme nombre de sommets pour « ${ref.nom} »`).toHaveLength(attendus.length);
    obj!.geometrie.coordinates.forEach((p, i) => { max = Math.max(max, distanceMetres(p, attendus[i])); compares++; });
  }
  expect(compares, "des sommets ont ete compares").toBeGreaterThan(0);
  return max;
}

test("KIS-CRS-01 : sans choix de CRS l'interface exige le choix ; avec le CRS, la transformation est affichée et passe à la quarantaine", async ({ ouvrirProfil, marqueur }) => {
  const { page } = await ouvrirProfil();
  const api = await ApiVoirie.connecter(gestionnaire);
  const projetId = await api.creerProjet(codeProjet(marqueur, "CRS"));
  await seConnecter(page, gestionnaire);
  await ouvrirProjet(page, projetId);
  const d = await ouvrirAssistant(page);
  const fichier = fichierPlan();
  await etapeDepot(page, d, { fichier, role: "AXES_TRAVAUX" });

  // ---- Format : tableau a points, lu en lignes par cle
  await attendreEtape(d, "Format et couches");
  await expect(d.getByTestId("detection")).toContainText("Tableau délimité (CSV, TSV, TXT)");
  await expect(d.getByTestId("csv-detecte")).toContainText("délimiteur point-virgule");
  await expect(d.getByTestId("csv-detecte")).toContainText("séparateur décimal « , »");
  await configurerCsvLignes(d, { x: "x", y: "y", cle: "axe", ordre: "ordre" });
  await continuer(d).click();

  // ---- CRS : choix OBLIGATOIRE, aucune valeur par defaut
  await attendreEtape(d, "Système de coordonnées");
  await expect(d.getByTestId("crs-obligatoire")).toContainText("n'est jamais deviné ni rempli par défaut");
  const choix = d.getByLabel("Système de coordonnées source");
  await expect(choix).toHaveValue("");
  await expect(d.getByRole("button", { name: "Vérifier la transformation" })).toBeDisabled();
  await expect(continuer(d)).toBeDisabled();
  await expect(d.getByText("Le choix du système est nécessaire avant la vérification.")).toBeVisible();
  // Liste blanche validee par le DSI : seuls ces codes sont proposes (WGS 84, UTM 28N, UTM 29N).
  const valeurs = await choix.locator("option").evaluateAll((o) => (o as HTMLOptionElement[]).map((x) => x.value));
  expect(valeurs).toEqual(["", "4326", "32628", "32629"]);
  const libelles = await choix.locator("option").allInnerTexts();
  expect(libelles.join(" | ")).toContain("EPSG:32629 : WGS 84 / UTM zone 29N, unité : mètres");

  // ---- Un CRS choisi : la transformation est affichee (source, cible, unites, methode)
  await choix.selectOption("32629");
  await d.getByRole("button", { name: "Vérifier la transformation" }).click();
  const bloc = d.getByTestId("bloc-crs");
  await expect(bloc).toContainText("EPSG:32629 (WGS 84 / UTM zone 29N)");
  await expect(bloc).toContainText("EPSG:4326");
  await expect(bloc).toContainText("mètres (source), degrés (cible)");
  await expect(bloc).toContainText("ST_Transform (PostGIS");
  await expect(bloc).toContainText("PROJ");
  await expect(bloc).toContainText("Choisi par vous");
  await expect(d.getByTestId("plausibilite")).toHaveAttribute("data-statut", "CONFORME");
  await expect(continuer(d)).toBeEnabled();

  // ---- Superposition a la reference WGS 84 (oracle independant), lue par l'API
  const apercu = await api.multipart(`${BASE}/${projetId}/import/apercu`, fichier, { ...CHAMPS_CSV_AXES, epsgSource: "32629" });
  expect(apercu.statut, apercu.texte.slice(0, 300)).toBe(200);
  expect(apercu.corps.resume.crs).toMatchObject({ epsgSource: 32629, epsgCible: 4326, uniteSource: "metre", uniteCible: "degre", origine: "choisi_par_utilisateur" });
  const ecart = ecartMax(apercu.corps.echantillon.objets, PLAN);
  expect(ecart, `ecart maximal entre le plan UTM transforme par l'application et la reference WGS 84 : ${(ecart * 100).toFixed(3)} cm`).toBeLessThan(0.05);
  // Controle negatif : le comparateur DETECTE un decalage. La meme lecture comparee a une reference decalee de 1 m echoue bien.
  expect(ecartMax(apercu.corps.echantillon.objets, PLAN, [1, 0]), "une reference decalee de 1 m est detectee").toBeGreaterThan(0.9);

  // ---- Fin du parcours : quarantaine, puis geometrie STOCKEE comparee a la reference (position complete lue en base)
  await continuer(d).click();
  await d.getByRole("button", { name: "Continuer vers les contrôles" }).click();
  await attendreEtape(d, "Contrôles et échantillon");
  await expect(d.getByTestId("echantillon")).toContainText("Échantillon : 3 objet(s) sur 3");
  await d.getByRole("button", { name: "Simuler l'enregistrement" }).click();
  await attendreEtape(d, "Comparaison avec la version autorisée");
  await d.getByRole("button", { name: "Enregistrer en quarantaine" }).click();
  await expect(d.getByTestId("depot-enregistre")).toBeVisible();
  const jeux = await jeuxDuProjet(projetId);
  expect(jeux).toHaveLength(1);
  expect(jeux[0]).toMatchObject({ statut: "CONTROLE", format: "CSV", nbObjets: 3 });
  expect(jeux[0].resume.crs).toMatchObject({ epsgSource: 32629, epsgCible: 4326, methode: expect.stringContaining("ST_Transform") });
  const stockes = await requete<{ nom: string; coords: string }>(
    `SELECT nom, ST_AsGeoJSON(geom, 12) AS coords FROM projets_voirie_objets WHERE "jeuId" = $1 ORDER BY nom`, [jeux[0].id]);
  const lus = stockes.map((s) => ({ nom: s.nom, geometrie: JSON.parse(s.coords) as { coordinates: Point[] } }));
  expect(ecartMax(lus, PLAN), "geometrie stockee en base, comparee a la reference independante").toBeLessThan(0.05);
  await api.fermer();
});

test("KIS-CRS-01 : le plan UTM 29N se superpose à un KML WGS 84 de référence (jeux comparés, longueurs égales)", async ({ marqueur }) => {
  const api = await ApiVoirie.connecter(gestionnaire);
  const projetId = await api.creerProjet(codeProjet(marqueur, "SUP"));
  const idPlan = await api.deposerOk(projetId, fichierPlan(), { role: "AXES_TRAVAUX", ...CHAMPS_CSV_AXES, epsgSource: "32629" });
  const reference = { name: "reference-wgs84.kml", buffer: kml(PLAN), mimeType: "application/vnd.google-earth.kml+xml" };
  const idRef = await api.deposerOk(projetId, reference, { role: "LIMITES_ROUTE" });
  const jeux = await jeuxDuProjet(projetId);
  const plan = jeux.find((j) => j.id === idPlan)!;
  const ref = jeux.find((j) => j.id === idRef)!;
  // Meme nombre d'objets, memes longueurs : le KML WGS 84 de reference et le plan UTM transforme decrivent les memes traces.
  expect(plan.nbObjets).toBe(ref.nbObjets);
  expect(Math.abs(plan.longueurTotaleM - ref.longueurTotaleM), "ecart de longueur totale (m)").toBeLessThan(0.05);
  // Position de chaque sommet stockee, lue en base : plan transforme contre reference.
  const lire = (id: string) => requete<{ nom: string; coords: string }>(`SELECT nom, ST_AsGeoJSON(geom, 12) AS coords FROM projets_voirie_objets WHERE "jeuId" = $1 ORDER BY nom`, [id]);
  const a = await lire(idPlan);
  const b = await lire(idRef);
  expect(a.map((x) => x.nom)).toEqual(b.map((x) => x.nom));
  let max = 0;
  a.forEach((x, i) => {
    const pa = (JSON.parse(x.coords) as { coordinates: Point[] }).coordinates;
    const pb = (JSON.parse(b[i].coords) as { coordinates: Point[] }).coordinates;
    expect(pa).toHaveLength(pb.length);
    pa.forEach((p, k) => { max = Math.max(max, distanceMetres(p, pb[k])); });
  });
  expect(max, `ecart maximal plan transforme / KML de reference : ${(max * 100).toFixed(3)} cm`).toBeLessThan(0.05);
  await api.fermer();
});

test("KIS-CRS-01 : un CRS hors liste blanche est refusé (API), et l'interface ne le propose pas", async ({ marqueur }) => {
  const api = await ApiVoirie.connecter(gestionnaire);
  const projetId = await api.creerProjet(codeProjet(marqueur, "LB"));
  const fichier = fichierPlan();
  for (const epsg of ["2154", "3857", "32630", "4269"]) {
    const apercu = await api.multipart(`${BASE}/${projetId}/import/apercu`, fichier, { ...CHAMPS_CSV_AXES, epsgSource: epsg });
    expect(apercu.statut, `apercu avec EPSG:${epsg}`).toBe(422);
    expect(apercu.corps.code).toBe("CRS_NON_AUTORISE");
    const depot = await api.deposer(projetId, fichier, { role: "AXES_TRAVAUX", ...CHAMPS_CSV_AXES, epsgSource: epsg }, { simuler: true });
    expect(depot.statut, `simulation avec EPSG:${epsg}`).toBe(422);
    expect(depot.corps.code).toBe("CRS_NON_AUTORISE");
  }
  // Pas de CRS du tout pour un tableau : refuse, jamais devine.
  const sans = await api.multipart(`${BASE}/${projetId}/import/apercu`, fichier, { ...CHAMPS_CSV_AXES });
  expect(sans.statut).toBe(422);
  expect(sans.corps.code).toBe("CRS_REQUIS");
  // Des metres lus comme des degres (WGS 84 choisi pour un plan UTM) : incoherence signalee, pas de carte au bout du monde.
  const metresEnDegres = await api.multipart(`${BASE}/${projetId}/import/apercu`, fichier, { ...CHAMPS_CSV_AXES, epsgSource: "4326" });
  expect(metresEnDegres.statut).toBe(422);
  expect(metresEnDegres.corps.code).toBe("CRS_INCOHERENT");
  expect(await jeuxDuProjet(projetId), "aucun jeu n'a ete cree par ces refus").toHaveLength(0);
  // La liste des CRS proposes par l'API est la liste blanche.
  const options = await api.get(`${BASE}/${projetId}/import/options`);
  expect(options.corps.crs.sourcesAutorises.map((s: { epsg: number }) => s.epsg)).toEqual([4326, 32628, 32629]);
  await api.fermer();
});

test("KIS-CRS-01 : mauvaise zone UTM (28N au lieu de 29N) : résultat hors de la Guinée refusé, la correction passe", async ({ ouvrirProfil, marqueur }) => {
  const { page } = await ouvrirProfil();
  const api = await ApiVoirie.connecter(gestionnaire);
  const projetId = await api.creerProjet(codeProjet(marqueur, "ZONE"));
  await seConnecter(page, gestionnaire);
  await ouvrirProjet(page, projetId);
  const d = await ouvrirAssistant(page);
  await etapeDepot(page, d, { fichier: fichierPlan(), role: "AXES_TRAVAUX" });
  await attendreEtape(d, "Format et couches");
  await configurerCsvLignes(d, { x: "x", y: "y", cle: "axe", ordre: "ordre" });
  await continuer(d).click();
  await attendreEtape(d, "Système de coordonnées");
  await d.getByLabel("Système de coordonnées source").selectOption("32628");
  await d.getByRole("button", { name: "Vérifier la transformation" }).click();
  const alerte = d.locator('[role="alert"][data-code="HORS_GUINEE"]');
  await expect(alerte).toBeVisible();
  // Vague 3 (UI-C, revue m7) : message generique, precise par l'emprise nationale CONFIGUREE que le serveur renvoie (aucun pays code dans l'ecran).
  await expect(alerte).toContainText("hors de l'emprise nationale de plausibilité configurée sur ce serveur");
  await expect(alerte).toContainText("Rien n'a été écrit");
  await expect(continuer(d)).toBeDisabled();
  expect(await jeuxDuProjet(projetId), "rien n'est ecrit").toHaveLength(0);
  // Correction : le bon fuseau fait disparaitre l'erreur et debloque l'etape.
  await d.getByLabel("Système de coordonnées source").selectOption("32629");
  await d.getByRole("button", { name: /Vérifier la transformation|Recalculer la transformation/ }).click();
  await expect(d.getByTestId("plausibilite")).toHaveAttribute("data-statut", "CONFORME");
  await expect(continuer(d)).toBeEnabled();
  await api.fermer();
});

test("KIS-CRS-01 : un axe hors de la Guinée déclenche l'alerte bloquante ; la confirmation l'écarte sans jamais le stocker", async ({ ouvrirProfil, marqueur }) => {
  const { page } = await ouvrirProfil();
  const api = await ApiVoirie.connecter(gestionnaire);
  const projetId = await api.creerProjet(codeProjet(marqueur, "HZ"));
  // Quatrieme axe a 1 000 km au nord de l'origine : latitude d'environ 18 degres, hors de la Guinee (7,1 a 12,8).
  const lointain: Ligne = { nom: "Axe lointain", coords: [[0, 1_000_000], [100, 1_000_000]] };
  const fichier = fichierPlan([...PLAN, lointain]);
  await seConnecter(page, gestionnaire);
  await ouvrirProjet(page, projetId);
  const d = await ouvrirAssistant(page);
  await etapeDepot(page, d, { fichier, role: "AXES_TRAVAUX" });
  await attendreEtape(d, "Format et couches");
  await configurerCsvLignes(d, { x: "x", y: "y", cle: "axe", ordre: "ordre" });
  await continuer(d).click();
  await attendreEtape(d, "Système de coordonnées");
  await d.getByLabel("Système de coordonnées source").selectOption("32629");
  await d.getByRole("button", { name: "Vérifier la transformation" }).click();

  const alerte = d.getByTestId("alerte-hors-zone");
  await expect(alerte).toBeVisible();
  await expect(alerte).toContainText("Résultat hors de la zone attendue : avancement bloqué");
  await expect(alerte).toContainText("1 élément(s)");
  await expect(continuer(d), "l'alerte bloque l'avancement").toBeDisabled();
  const confirmer = alerte.getByRole("button", { name: "Confirmer et recalculer l'aperçu" });
  await expect(confirmer, "pas de confirmation sans case cochee").toBeDisabled();
  await alerte.getByRole("checkbox").check();
  await confirmer.click();
  await expect(d.getByTestId("plausibilite")).toHaveAttribute("data-statut", "PARTIELLEMENT_HORS_ZONE");
  await expect(d.getByTestId("plausibilite")).toContainText("écartés sur votre confirmation explicite (jamais stockés)");
  await expect(continuer(d)).toBeEnabled();

  await continuer(d).click();
  await d.getByRole("button", { name: "Continuer vers les contrôles" }).click();
  await attendreEtape(d, "Contrôles et échantillon");
  await d.getByRole("button", { name: "Simuler l'enregistrement" }).click();
  await attendreEtape(d, "Comparaison avec la version autorisée");
  await d.getByRole("button", { name: "Enregistrer en quarantaine" }).click();
  await expect(d.getByTestId("depot-enregistre")).toBeVisible();

  const jeux = await jeuxDuProjet(projetId);
  expect(jeux).toHaveLength(1);
  expect(jeux[0].nbObjets, "les trois axes dans la Guinee sont stockes, l'axe lointain non").toBe(3);
  expect(jeux[0].avertissements.map((a) => a.code)).toContain("ELEMENTS_HORS_GUINEE");
  const hors = await requete<{ n: string }>(`SELECT count(*)::text AS n FROM projets_voirie_objets WHERE "jeuId" = $1 AND (ST_YMax(geom) > 12.8 OR nom = 'Axe lointain')`, [jeux[0].id]);
  expect(Number(hors[0].n), "aucun objet hors Guinee n'est stocke").toBe(0);
  await api.fermer();
});
