import { randomUUID } from "node:crypto";
import { requete } from "../lib/base";
import { expect, seConnecter, test } from "../lib/fixtures";
import {
  ApiVoirie, BASE, auditDe, codeProjet, comptesInterdits, creerCompte, empreinteTroncons, jeuxDuProjet, ouvrirProjet,
  type CompteVoirie, type ReponseApi,
} from "../lib/voirie";
import { AXES, geojson, type Ligne } from "../lib/voirie-geo";

/**
 * Lot C1 bis, scenario c : plusieurs sources d'un meme reseau (CONTRAT-SOURCES.md ; decision architecturale 2, section 4).
 *
 *   - un TYPE de reseau configurable (referentiel TYPE_RESEAU, cree par un ADMIN) ; deux jeux du meme reseau (meme concessionnaire, meme type) acquis
 *     par deux METHODES du referentiel : deux sources, jamais une version l'une de l'autre ; un autre type de la meme famille est un autre reseau ;
 *   - une source unique est affichee comme l'etat NORMAL (aucune alerte) ;
 *   - le jeu B en quarantaine n'est rien pour un lecteur (sources, jeux, comparaisons) ; puis autorise : comparaison lancee dans l'ecran, divergence
 *     mesuree, dossier de divergence ouvert par une action humaine justifiee ; aucune geometrie modifiee ni fusionnee, aucun ordre ;
 *   - une version candidate (B v2) comparee avant autorisation : invisible d'un lecteur (404 identique a l'inexistant).
 * Donnees 100 % synthetiques (lib/voirie-geo.ts) ; aucun concessionnaire reel.
 */

test.describe.configure({ mode: "serial" });

const suffixe = randomUUID().slice(0, 6).toUpperCase();
const TYPE_FIBRE = `FIBRE_SYNTH_${suffixe}`;
const TYPE_CUIVRE = `CUIVRE_SYNTH_${suffixe}`;
const UUID_INCONNU = "00000000-0000-4000-8000-0000000000ad";

let admin: CompteVoirie;
let g1: CompteVoirie;
let lecteur: CompteVoirie;

/** Source A (releve GNSS, 0,5 m) : S1, S2 et S4 (S4 n'existe que dans A). */
const SOURCE_A: Ligne[] = [
  { nom: "Fibre-Synth S1", coords: [[0, 30], [100, 30]] },
  { nom: "Fibre-Synth S2", coords: [[0, 60], [100, 60]] },
  { nom: "Fibre-Synth S4", coords: [[0, 200], [100, 200]] },
];
/** Source B (numerisation d'un plan, 1 m) : S1 a 0,30 m (concordance), S2 a 3 m (divergence : corridor max(0,5 ; 1) + 1 = 2 m), S5 seulement dans B. */
const SOURCE_B: Ligne[] = [
  { nom: "Fibre-Synth S1", coords: [[0, 30.3], [100, 30.3]] },
  { nom: "Fibre-Synth S2", coords: [[0, 63], [100, 63]] },
  { nom: "Fibre-Synth S5", coords: [[0, 400], [100, 400]] },
];

const etat = { projetId: "", nom: "", conc: "", jeuA: "", jeuB: "", jeuCuivre: "", jeuBv2: "", cmp: "", cmpCandidate: "", conflit: "" };

/** Empreinte des geometries des objets d'un jeu : une comparaison ne doit jamais les modifier ni les fusionner. */
async function empreinteObjets(jeuId: string): Promise<string> {
  return (await requete<{ h: string }>(`SELECT md5(string_agg(ST_AsEWKB(geom)::text, '|' ORDER BY id)) AS h FROM projets_voirie_objets WHERE "jeuId" = $1`, [jeuId]))[0].h;
}

test.beforeAll(async () => {
  admin = await creerCompte("e2e-src-admin", "Admin Sources C1bis", "ADMIN");
  g1 = await creerCompte("e2e-src-g1", "Gestionnaire Sources C1bis", "GESTIONNAIRE");
  lecteur = await creerCompte("e2e-src-lect", "Lecteur Sources C1bis", "LECTEUR");
});

test("c. préparation : deux types configurables de la même famille, une source A par type ; une source unique est un état normal", async ({ ouvrirProfil, marqueur }) => {
  const adm = await ApiVoirie.connecter(admin);
  for (const [code, libelle] of [[TYPE_FIBRE, `Fibre synthetique ${suffixe}`], [TYPE_CUIVRE, `Cuivre synthetique ${suffixe}`]]) {
    const r = await adm.post(`${BASE}/referentiels/TYPE_RESEAU`, { code, libelle, parametres: { famille: "TELECOM" } });
    expect(r.statut, r.texte.slice(0, 300)).toBe(201);
  }
  // Une methode inconnue du referentiel est refusee au depot (422), jamais devinee.
  const g = await ApiVoirie.connecter(g1);
  etat.projetId = await g.creerProjet(codeProjet(marqueur, "SRC"));
  etat.nom = `Projet ${codeProjet(marqueur, "SRC")}`;
  const c = await g.post(`${BASE}/concessionnaires`, { nom: `Operateur synthetique SRC ${suffixe}`, typeReseauCode: TYPE_FIBRE });
  expect(c.statut, c.texte.slice(0, 300)).toBe(201);
  expect(c.corps.concessionnaire).toMatchObject({ typeReseau: "TELECOM", typeReseauCode: TYPE_FIBRE });
  etat.conc = c.corps.concessionnaire.id;
  await g.deposerEtAutoriser(etat.projetId, { name: "axes-src.geojson", buffer: geojson(AXES) }, { role: "AXES_TRAVAUX" });
  const inconnue = await g.deposer(etat.projetId, { name: "a-inconnue.geojson", buffer: geojson(SOURCE_A, [0, 1_000]) }, { role: "RESEAU_TIERS", concessionnaireId: etat.conc, typeReseauCode: TYPE_FIBRE, methodeAcquisition: "PIFOMETRE_SYNTH" });
  expect(inconnue.statut).toBe(422);
  expect(inconnue.corps.code).toBe("METHODE_ACQUISITION_INCONNUE");

  etat.jeuA = await g.deposerEtAutoriser(etat.projetId, { name: "fibre-source-a-gnss.geojson", buffer: geojson(SOURCE_A) },
    { role: "RESEAU_TIERS", concessionnaireId: etat.conc, typeReseauCode: TYPE_FIBRE, methodeAcquisition: "GNSS_RTK", precisionHorizontaleM: "0.5" });
  // Autre TYPE configurable de la meme famille (TELECOM), meme concessionnaire : un AUTRE reseau, jamais une version ni une source du premier.
  etat.jeuCuivre = await g.deposerEtAutoriser(etat.projetId, { name: "cuivre-source-unique.geojson", buffer: geojson(SOURCE_A, [0, 1_000]) },
    { role: "RESEAU_TIERS", concessionnaireId: etat.conc, typeReseauCode: TYPE_CUIVRE, methodeAcquisition: "GNSS_RTK", precisionHorizontaleM: "0.5" });
  const jeux = await jeuxDuProjet(etat.projetId);
  expect(jeux.find((j) => j.id === etat.jeuCuivre)).toMatchObject({ version: 1, remplaceId: null, statut: "AUTORISE" });
  expect(jeux.find((j) => j.id === etat.jeuA)).toMatchObject({ version: 1, statut: "AUTORISE" });

  const s = await g.get(`${BASE}/${etat.projetId}/sources`);
  expect(s.statut, s.texte.slice(0, 300)).toBe(200);
  const groupes = (s.corps.reseaux as Array<{ role: string; typeReseauCode: string | null; statut: string; nbSources: number }>).filter((x) => x.role === "RESEAU_TIERS");
  expect(groupes.map((x) => [x.typeReseauCode, x.statut, x.nbSources]).sort()).toEqual([
    [TYPE_CUIVRE, "SOURCE_UNIQUE_COMPARAISON_INDISPONIBLE", 1], [TYPE_FIBRE, "SOURCE_UNIQUE_COMPARAISON_INDISPONIBLE", 1],
  ].sort());
  // Forcer une comparaison de deux reseaux differents (meme famille, autres types) : refuse.
  const force = await g.comparer(etat.projetId, etat.jeuA, etat.jeuCuivre);
  expect(force.statut).toBe(409);
  expect(force.corps).toMatchObject({ code: "JEUX_NON_COMPARABLES", motif: "RESEAU_DIFFERENT" });
  expect((await g.get(`${BASE}/${etat.projetId}/comparaisons`)).corps.comparaisons).toEqual([]);

  // Ecran (lecteur) : source unique = etat normal, ton neutre, aucune alerte, aucun bouton de comparaison.
  const { page } = await ouvrirProfil();
  await seConnecter(page, lecteur);
  await ouvrirProjet(page, etat.projetId, etat.nom);
  await page.getByRole("tab", { name: "Sources" }).click();
  const panneau = page.getByRole("tabpanel");
  for (const libelle of [`Fibre synthetique ${suffixe}`, `Cuivre synthetique ${suffixe}`]) {
    const article = panneau.getByRole("article", { name: new RegExp(libelle) });
    await expect(article.getByTestId("source-unique")).toContainText("Source unique : comparaison indisponible");
    await expect(article.getByTestId("source-unique")).toContainText("C'est l'état normal");
    await expect(article.getByRole("alert")).toHaveCount(0);
  }
  await expect(panneau.getByRole("button", { name: /Comparer/ })).toHaveCount(0);
  await Promise.all([adm.fermer(), g.fermer()]);
});

test("c. la source B en quarantaine n'est rien pour un lecteur ; autorisée, elle rend le réseau comparable (deux méthodes, deux sources, aucun remplacement)", async () => {
  test.skip(!etat.jeuA, "depend de la preparation");
  const g = await ApiVoirie.connecter(g1);
  const depot = await g.deposer(etat.projetId, { name: "fibre-source-b-numerisation.geojson", buffer: geojson(SOURCE_B) },
    { role: "RESEAU_TIERS", concessionnaireId: etat.conc, typeReseauCode: TYPE_FIBRE, methodeAcquisition: "NUMERISATION_PLAN", precisionHorizontaleM: "1" });
  expect(depot.statut, depot.texte.slice(0, 300)).toBe(201);
  etat.jeuB = depot.corps.jeu.id;
  expect((await jeuxDuProjet(etat.projetId)).find((j) => j.id === etat.jeuB), "autre methode : une nouvelle SOURCE (version 1), pas une version de A")
    .toMatchObject({ version: 1, remplaceId: null, statut: "CONTROLE", confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE" });

  // Lecteur : rien du jeu B (ni dans les sources, ni dans les jeux, ni par son identifiant).
  const l = await ApiVoirie.connecter(lecteur);
  const sl = await l.get(`${BASE}/${etat.projetId}/sources`);
  expect(sl.statut).toBe(200);
  expect(sl.texte, "ni l'identifiant ni le nom du fichier de B").not.toContain(etat.jeuB);
  expect(sl.texte).not.toContain("fibre-source-b-numerisation");
  expect(sl.texte, "aucune version candidate pour un lecteur").not.toContain("versionsCandidates");
  const fibre = sl.corps.reseaux.find((x: { typeReseauCode: string }) => x.typeReseauCode === TYPE_FIBRE);
  expect(fibre).toMatchObject({ statut: "SOURCE_UNIQUE_COMPARAISON_INDISPONIBLE", nbSources: 1 });
  expect((await l.get(`${BASE}/${etat.projetId}/jeux`)).texte).not.toContain(etat.jeuB);
  const carte = await l.get(`${BASE}/${etat.projetId}/carte?jeux=${etat.jeuB}&inclureNonAutorises=true`);
  expect(carte.statut).toBe(403);
  // Le decideur voit B (quarantaine) mais ne peut pas comparer une source non autorisee qui ne remplace rien.
  const sg = await g.get(`${BASE}/${etat.projetId}/sources`);
  expect(sg.texte).toContain(etat.jeuA);
  const tot = await g.comparer(etat.projetId, etat.jeuA, etat.jeuB);
  expect(tot.statut).toBe(409);
  expect(tot.corps.code).toBe("JEUX_NON_COMPARABLES");

  // Autorisation de B : deux sources AUTORISE du meme reseau, A reste AUTORISE (aucun remplacement).
  expect((await g.autoriser(etat.projetId, etat.jeuB, "Seconde source du meme reseau, autre methode")).statut).toBe(200);
  const jeux = await jeuxDuProjet(etat.projetId);
  expect(jeux.find((j) => j.id === etat.jeuA)!.statut, "A n'est pas remplacee").toBe("AUTORISE");
  expect(jeux.find((j) => j.id === etat.jeuB)!.statut).toBe("AUTORISE");
  const apres = (await l.get(`${BASE}/${etat.projetId}/sources`)).corps.reseaux.find((x: { typeReseauCode: string }) => x.typeReseauCode === TYPE_FIBRE);
  expect(apres).toMatchObject({ statut: "COMPARABLE", nbSources: 2 });
  // Complétude : la fonction de comparaison est disponible.
  const comp = await l.get(`${BASE}/${etat.projetId}/completude`);
  expect(comp.corps.fonctions.find((f: { code: string }) => f.code === "COMPARAISON_SOURCES").etat).toBe("DISPONIBLE");
  await Promise.all([g.fermer(), l.fermer()]);
});

test("c. comparaison lancée dans l'écran : divergence mesurée, dossier ouvert par une action justifiée ; sources préservées, aucun ordre", async ({ ouvrirProfil }) => {
  test.skip(!etat.jeuB, "depend de la seconde source");
  const empreintes = { a: await empreinteObjets(etat.jeuA), b: await empreinteObjets(etat.jeuB) };
  const referentiel = await comptesInterdits();
  const troncons = await empreinteTroncons();

  const { page } = await ouvrirProfil();
  await seConnecter(page, g1);
  await ouvrirProjet(page, etat.projetId, etat.nom);
  await page.getByRole("tab", { name: "Sources" }).click();
  const panneau = page.getByRole("tabpanel");
  const article = panneau.getByRole("article", { name: new RegExp(`Fibre synthetique ${suffixe}`) });
  await expect(article).toContainText("Plusieurs sources : comparaison possible");
  await expect(article.getByRole("row", { name: /fibre-source-b-numerisation/ })).toBeVisible();
  await article.getByRole("button", { name: "Comparer deux sources" }).click();
  const d = page.getByRole("dialog", { name: "Lancer une comparaison" });
  await expect(d).toContainText("aucune n'est modifiée, fusionnée ni privilégiée");
  await d.getByRole("button", { name: "Lancer la comparaison" }).click();
  await expect(d).toHaveCount(0);
  const resultats = panneau.getByRole("list", { name: "Résultats par objet" });
  await expect(resultats).toBeVisible();
  const divergence = resultats.getByRole("listitem").filter({ has: page.locator('[data-statut="DIVERGENCE"]') });
  await expect(divergence).toHaveCount(1);
  await expect(divergence.getByTestId("mesure-divergence")).not.toContainText("non communiquée");

  // Ce que le serveur a calcule et persiste.
  const g = await ApiVoirie.connecter(g1);
  const liste = (await g.get(`${BASE}/${etat.projetId}/comparaisons`)).corps.comparaisons as Array<{ id: string; mode: string; statut: string }>;
  expect(liste).toHaveLength(1);
  etat.cmp = liste[0].id;
  const cmp = (await g.get(`${BASE}/${etat.projetId}/comparaisons/${etat.cmp}`)).corps.comparaison;
  expect(cmp).toMatchObject({ statut: "TERMINEE", mode: "SOURCES", role: "RESEAU_TIERS", jeuAId: etat.jeuA, jeuBId: etat.jeuB, versionAlgorithme: "S1-CORRIDOR-UTM-1", epsg: 32629 });
  const objets = (await g.get(`${BASE}/${etat.projetId}/comparaisons/${etat.cmp}/objets?limite=200`)).corps.resultats as Array<{ id: string; statut: string; corridorM: number | null; mesure: any; objetA: { nom: string } | null; objetB: { nom: string } | null }>;
  const par = (s: string) => objets.filter((o) => o.statut === s);
  expect(par("CONCORDANCE").map((o) => o.objetA!.nom)).toEqual(["Fibre-Synth S1"]);
  expect(par("DIVERGENCE").map((o) => o.objetA!.nom)).toEqual(["Fibre-Synth S2"]);
  expect(par("SANS_CORRESPONDANCE_A").map((o) => o.objetA!.nom)).toEqual(["Fibre-Synth S4"]);
  expect(par("SANS_CORRESPONDANCE_B").map((o) => o.objetB!.nom)).toEqual(["Fibre-Synth S5"]);
  const div = par("DIVERGENCE")[0];
  expect(div.corridorM, "corridor = max(0,5 ; 1) + marge 1 m").toBeCloseTo(2, 3);
  expect(div.mesure.hausdorffM, "decalage synthetique de 3 m").toBeCloseTo(3, 1);
  expect(div.mesure.partHorsCorridor).toBeCloseTo(1, 2);
  expect(par("CONCORDANCE")[0].mesure.hausdorffM).toBeCloseTo(0.3, 1);

  // Ouverture du dossier depuis l'ecran : justification obligatoire.
  await divergence.getByRole("button", { name: "Ouvrir un dossier de divergence" }).click();
  const od = page.getByRole("dialog", { name: "Ouvrir un dossier de divergence" });
  await expect(od.getByRole("button", { name: "Ouvrir le dossier" })).toBeDisabled();
  await od.getByLabel("Justification (10 caractères minimum)").fill("Ecart de 3 m entre releve GNSS et plan numerise : a verifier sur le terrain");
  await od.getByRole("button", { name: "Ouvrir le dossier" }).click();
  await expect(divergence).toContainText("Dossier de divergence ouvert (à investiguer)");

  const conflits = (await g.get(`${BASE}/${etat.projetId}/conflits?limite=200`)).corps.conflits as Array<{ id: string; type: string; statut: string }>;
  const dossiers = conflits.filter((c) => c.type === "DIVERGENCE_SOURCES");
  expect(dossiers).toHaveLength(1);
  expect(dossiers[0].statut, "a investiguer, jamais une decision").toBe("A_INVESTIGUER");
  etat.conflit = dossiers[0].id;
  // Doublon et resultat non divergent : refuses ; un lecteur ne peut pas ouvrir de dossier.
  const encore = await g.post(`${BASE}/${etat.projetId}/comparaisons/${etat.cmp}/dossiers-conflit`, { resultatId: div.id, justification: "Deuxieme ouverture du meme dossier" });
  expect(encore.statut).toBe(409);
  expect(encore.corps).toMatchObject({ code: "DOSSIER_DEJA_OUVERT", conflitId: etat.conflit });
  const nonDiv = await g.post(`${BASE}/${etat.projetId}/comparaisons/${etat.cmp}/dossiers-conflit`, { resultatId: par("CONCORDANCE")[0].id, justification: "Une concordance n'ouvre pas de dossier" });
  expect(nonDiv.statut).toBe(409);
  expect(nonDiv.corps.code).toBe("RESULTAT_NON_DIVERGENT");
  const l = await ApiVoirie.connecter(lecteur);
  expect((await l.post(`${BASE}/${etat.projetId}/comparaisons/${etat.cmp}/dossiers-conflit`, { resultatId: div.id, justification: "Un lecteur n'ouvre rien" })).statut).toBe(403);
  expect((await l.comparer(etat.projetId, etat.jeuA, etat.jeuB)).statut).toBe(403);

  // Sources preservees : ni modifiees ni fusionnees ; aucun ordre ; referentiel intact ; audit sans geometrie.
  expect(await empreinteObjets(etat.jeuA)).toBe(empreintes.a);
  expect(await empreinteObjets(etat.jeuB)).toBe(empreintes.b);
  expect((await jeuxDuProjet(etat.projetId)).filter((j) => [etat.jeuA, etat.jeuB].includes(j.id)).map((j) => j.statut)).toEqual(["AUTORISE", "AUTORISE"]);
  expect(await comptesInterdits()).toEqual(referentiel);
  expect(await empreinteTroncons()).toBe(troncons);
  const audit = await auditDe("ComparaisonSources", etat.cmp);
  expect(audit.length).toBeGreaterThan(0);
  expect(JSON.stringify([...audit, ...(await auditDe("ConflitProjet", etat.conflit))]), "audit sans geometrie").not.toMatch(/coordinates|LineString/);
  // Le lecteur voit la comparaison (deux jeux autorises) et le dossier, sans bouton d'ecriture.
  expect((await l.get(`${BASE}/${etat.projetId}/comparaisons/${etat.cmp}`)).statut).toBe(200);
  expect((await l.get(`${BASE}/${etat.projetId}/conflits/${etat.conflit}`)).statut).toBe(200);
  await Promise.all([g.fermer(), l.fermer()]);
});

test("c. une version candidate de B comparée avant autorisation : un lecteur n'en voit rien (404 identique à l'inexistant)", async ({ ouvrirProfil }) => {
  test.skip(!etat.cmp, "depend de la comparaison");
  const g = await ApiVoirie.connecter(g1);
  const v2: Ligne[] = SOURCE_B.map((x) => (x.nom === "Fibre-Synth S2" ? { ...x, coords: x.coords.map(([a, b]) => [a, b - 2.5] as [number, number]) } : x));
  etat.jeuBv2 = await g.deposerOk(etat.projetId, { name: "fibre-source-b-v2.geojson", buffer: geojson(v2) },
    { role: "RESEAU_TIERS", concessionnaireId: etat.conc, typeReseauCode: TYPE_FIBRE, methodeAcquisition: "NUMERISATION_PLAN", precisionHorizontaleM: "1" });
  expect((await jeuxDuProjet(etat.projetId)).find((j) => j.id === etat.jeuBv2), "meme methode : une VERSION de B").toMatchObject({ version: 2, remplaceId: etat.jeuB, statut: "CONTROLE" });
  const sg = (await g.get(`${BASE}/${etat.projetId}/sources`)).corps.reseaux.find((x: { typeReseauCode: string }) => x.typeReseauCode === TYPE_FIBRE);
  expect(sg.versionsCandidates.map((v: { jeuId: string }) => v.jeuId), "le decideur voit la candidate").toEqual([etat.jeuBv2]);
  const c = await g.comparer(etat.projetId, etat.jeuBv2, etat.jeuB);
  expect(c.statut, c.texte.slice(0, 300)).toBe(201);
  etat.cmpCandidate = c.corps.comparaison.id;
  expect(c.corps.comparaison).toMatchObject({ mode: "VERSION_CANDIDATE", jeuAId: etat.jeuB, jeuBId: etat.jeuBv2 });

  const l = await ApiVoirie.connecter(lecteur);
  const ref = async (u: string): Promise<[ReponseApi, ReponseApi]> => [await l.get(u.replace("@", etat.cmpCandidate)), await l.get(u.replace("@", UUID_INCONNU))];
  for (const u of [`${BASE}/${etat.projetId}/comparaisons/@`, `${BASE}/${etat.projetId}/comparaisons/@/objets`]) {
    const [vrai, faux] = await ref(u);
    expect(vrai.statut, `lecteur : ${u}`).toBe(404);
    expect(vrai.corps, "meme reponse qu'une comparaison inexistante").toEqual(faux.corps);
  }
  const listeL = await l.get(`${BASE}/${etat.projetId}/comparaisons`);
  expect(listeL.corps.comparaisons.map((x: { id: string }) => x.id), "la liste du lecteur ne porte que la comparaison des deux sources autorisees").toEqual([etat.cmp]);
  const sl = await l.get(`${BASE}/${etat.projetId}/sources`);
  expect(sl.texte).not.toContain(etat.jeuBv2);
  expect(sl.texte).not.toContain("fibre-source-b-v2");
  // Le decideur la voit dans l'historique.
  expect((await g.get(`${BASE}/${etat.projetId}/comparaisons`)).corps.comparaisons.map((x: { id: string }) => x.id)).toContain(etat.cmpCandidate);

  // Ecran du lecteur : ni la candidate, ni bouton de comparaison, ni bouton d'ouverture de dossier.
  const { page } = await ouvrirProfil();
  await seConnecter(page, lecteur);
  await ouvrirProjet(page, etat.projetId, etat.nom);
  await page.getByRole("tab", { name: "Sources" }).click();
  const panneau = page.getByRole("tabpanel");
  await expect(panneau.getByRole("article", { name: new RegExp(`Fibre synthetique ${suffixe}`) })).toContainText("Plusieurs sources : comparaison possible");
  await expect(panneau.getByText("fibre-source-b-v2.geojson")).toHaveCount(0);
  await expect(panneau.getByText("Version(s) candidate(s)")).toHaveCount(0);
  await expect(panneau.getByRole("button", { name: /Comparer/ })).toHaveCount(0);
  await panneau.getByRole("button", { name: /Voir le détail de la comparaison/ }).first().click();
  await expect(panneau.getByRole("list", { name: "Résultats par objet" })).toBeVisible();
  await expect(panneau.getByRole("button", { name: "Ouvrir un dossier de divergence" })).toHaveCount(0);
  await Promise.all([g.fermer(), l.fermer()]);
});
