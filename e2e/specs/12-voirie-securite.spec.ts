import { createHmac, randomUUID } from "node:crypto";
import { requete } from "../lib/base";
import { expect, seConnecter, test } from "../lib/fixtures";
import {
  ApiVoirie, BASE, MODULES_VOIRIE, accorderPerimetre, attendreEtape, auditDe, codeProjet, comptesInterdits, creerCompte, creerRegion, empreinteTroncons, etapeDepot,
  jeuxDuProjet, ouvrirAssistant, ouvrirProjet, territoireDeRegion, type CompteVoirie, type FichierEnvoye,
} from "../lib/voirie";
import { AXES, RESEAU_TELECOM, geojson, kml, zip } from "../lib/voirie-geo";

/**
 * KIS-SEC-01 (cahier 22.3) : securite d'acces, dans le navigateur ET par l'API.
 *
 *   - sans jeton 401 ; jeton falsifie 401 ; sans cle de module 403 ; un lecteur ne peut rien ecrire (403, base inchangee) ;
 *   - hors perimetre territorial : 404 MASQUE, identique a celui d'un projet qui n'existe pas ; projet supprime : 404 pour tous ;
 *   - aucune route n'exporte la geometrie d'un jeu ; l'export CSV est reserve aux roles qui decident ; la consultation d'un reseau
 *     confidentiel est tracee, sans geometrie ni nom d'objet ;
 *   - fichiers hostiles refuses AVANT toute ecriture : ZIP dangereux (zip-slip, bombe de decompression, archive imbriquee, trop d'entrees), XML a
 *     entite externe ou a DTD, JSON trop profond, extension trompeuse (le contenu fait foi) ;
 *   - ce qui vient d'un fichier (nom d'objet) est du TEXTE : jamais du HTML execute.
 */


let admin: CompteVoirie;
let gestionnaire: CompteVoirie;
let gestionnaire2: CompteVoirie;
let lecteur: CompteVoirie;
let sansModule: CompteVoirie;
let regionalA: CompteVoirie;
let regionalB: CompteVoirie;
let regionA = 0;
let regionB = 0;

test.beforeAll(async () => {
  admin = await creerCompte("e2e-sec-admin", "Admin Securite E2E", "ADMIN", []);
  gestionnaire = await creerCompte("e2e-sec-gest", "Gestionnaire Securite E2E", "GESTIONNAIRE");
  gestionnaire2 = await creerCompte("e2e-sec-gest2", "Gestionnaire 2 Securite E2E", "GESTIONNAIRE");
  lecteur = await creerCompte("e2e-sec-lect", "Lecteur Securite E2E", "LECTEUR");
  sansModule = await creerCompte("e2e-sec-nomod", "Sans module E2E", "GESTIONNAIRE", ["dashboard", "troncons"]);
  regionalA = await creerCompte("e2e-sec-rega", "Regional A E2E", "GESTIONNAIRE");
  regionalB = await creerCompte("e2e-sec-regb", "Regional B E2E", "GESTIONNAIRE");
  regionA = await creerRegion("E2E-Voirie-Region-A");
  regionB = await creerRegion("E2E-Voirie-Region-B");
  await accorderPerimetre(regionalA.id, regionA, admin.id);
  await accorderPerimetre(regionalB.id, regionB, admin.id);
});

const UUID_INCONNU = "00000000-0000-4000-8000-0000000000ee";

/** Un jeton signe avec un AUTRE secret que celui du serveur : la signature ne vaut rien. */
function jetonFalsifie(sub: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const maintenant = Math.floor(Date.now() / 1000);
  const corps = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, role: "ADMIN", email: "faux@e2e.test.invalid", iat: maintenant, exp: maintenant + 900 })}`;
  return `${corps}.${createHmac("sha256", "un-secret-qui-n-est-pas-celui-du-serveur").update(corps).digest("base64url")}`;
}

test("sans jeton : 401 sur toutes les familles de routes ; jeton falsifié : 401", async ({ marqueur }) => {
  const api = await ApiVoirie.connecter(gestionnaire);
  const projetId = await api.creerProjet(codeProjet(marqueur, "401"));
  const routes: Array<[string, string]> = [
    ["GET", BASE], ["POST", BASE], ["GET", `${BASE}/${projetId}`], ["PATCH", `${BASE}/${projetId}`], ["DELETE", `${BASE}/${projetId}`],
    ["GET", `${BASE}/${projetId}/jeux`], ["POST", `${BASE}/${projetId}/jeux`], ["GET", `${BASE}/${projetId}/carte?jeux=${UUID_INCONNU}`],
    ["GET", `${BASE}/${projetId}/analyse`], ["GET", `${BASE}/${projetId}/analyse/export.csv`], ["POST", `${BASE}/${projetId}/analyses`],
    ["GET", `${BASE}/${projetId}/conflits`], ["GET", `${BASE}/${projetId}/conflits/export.csv`], ["GET", `${BASE}/${projetId}/import/options`],
    ["POST", `${BASE}/${projetId}/import/apercu`], ["GET", `${BASE}/${projetId}/reseau/comptage`], ["POST", `${BASE}/${projetId}/reseau/associations/proposer`],
    ["GET", `${BASE}/workflow/mon-profil`], ["GET", `${BASE}/${projetId}/workflow/demandes`], ["POST", `${BASE}/${projetId}/workflow/referents`],
    ["GET", `${BASE}/concessionnaires`], ["POST", `${BASE}/concessionnaires`],
  ];
  const anonyme = await ApiVoirie.anonyme();
  const faux = await ApiVoirie.anonyme(jetonFalsifie(admin.id));
  const poubelle = await ApiVoirie.anonyme("pas-un-jeton");
  const appel = (c: ApiVoirie, m: string, u: string) => (m === "GET" ? c.get(u) : m === "POST" ? c.post(u, {}) : m === "PATCH" ? c.patch(u, {}) : c.delete(u));
  const avant = await requete<{ n: string }>(`SELECT count(*)::text AS n FROM projets_voirie`);
  for (const [m, u] of routes) {
    for (const [nom, client] of [["sans jeton", anonyme], ["jeton signe d'un autre secret", faux], ["texte quelconque", poubelle]] as const) {
      const r = await appel(client, m, u);
      expect(r.statut, `${m} ${u.replace(projetId, ":id")} ${nom}`).toBe(401);
    }
  }
  const apres = await requete<{ n: string }>(`SELECT count(*)::text AS n FROM projets_voirie`);
  expect(apres[0].n, "aucun projet n'a ete cree ni retire par ces appels").toBe(avant[0].n);
  await Promise.all([api.fermer(), anonyme.fermer(), faux.fermer(), poubelle.fermer()]);
});

test("sans clé de module : 403 partout ; un ADMIN passe sans clé ; l'interface refuse l'accès au module", async ({ ouvrirProfil, marqueur }) => {
  const api = await ApiVoirie.connecter(gestionnaire);
  const projetId = await api.creerProjet(codeProjet(marqueur, "MOD"));
  const sans = await ApiVoirie.connecter(sansModule);
  for (const [m, u] of [["GET", BASE], ["POST", BASE], ["GET", `${BASE}/${projetId}`], ["GET", `${BASE}/${projetId}/jeux`], ["GET", `${BASE}/${projetId}/conflits`],
    ["GET", `${BASE}/${projetId}/reseau/comptage`], ["GET", `${BASE}/workflow/mon-profil`], ["GET", `${BASE}/${projetId}/import/options`]] as const) {
    const r = m === "GET" ? await sans.get(u) : await sans.post(u, { code: "NON", nom: "Non" });
    expect(r.statut, `${m} ${u.replace(projetId, ":id")} sans cle de module`).toBe(403);
  }
  // Le refus est cote serveur : aucun projet n'a ete cree par le compte sans module.
  expect((await requete(`SELECT 1 FROM projets_voirie WHERE code = 'NON'`))).toHaveLength(0);
  // Un ADMIN n'a pas besoin de la cle (comportement documente de l'API) : il lit.
  const adminApi = await ApiVoirie.connecter(admin);
  expect((await adminApi.get(`${BASE}/${projetId}`)).statut).toBe(200);

  const { page } = await ouvrirProfil();
  await seConnecter(page, sansModule);
  await page.goto("/projets-voirie");
  await expect(page.getByRole("heading", { name: "Accès non autorisé" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Projets de voirie et réseaux" })).toHaveCount(0);
  await Promise.all([api.fermer(), sans.fermer(), adminApi.fermer()]);
});

test("un lecteur ne peut rien écrire : 403 sur chaque route d'écriture, base et référentiel inchangés", async ({ ouvrirProfil, marqueur }) => {
  const api = await ApiVoirie.connecter(gestionnaire);
  const projetId = await api.creerProjet(codeProjet(marqueur, "LECT"));
  const jeuId = await api.deposerEtAutoriser(projetId, { name: "axes.geojson", buffer: geojson(AXES) }, { role: "AXES_TRAVAUX" });
  const l = await ApiVoirie.connecter(lecteur);
  const avant = { interdits: await comptesInterdits(), troncons: await empreinteTroncons(), jeux: await jeuxDuProjet(projetId), projets: (await requete<{ n: string }>(`SELECT count(*)::text AS n FROM projets_voirie`))[0].n };
  const p = `${BASE}/${projetId}`;
  const ecritures: Array<[string, string, unknown]> = [
    ["POST", BASE, { code: "LECTEUR-INTERDIT", nom: "Interdit" }], ["PATCH", p, { nom: "Renomme" }], ["DELETE", p, undefined],
    ["POST", `${BASE}/concessionnaires`, { nom: "Interdit", typeReseau: "TELECOM" }],
    ["POST", `${p}/jeux/${jeuId}/autoriser`, { justification: "Je ne devrais pas pouvoir" }], ["POST", `${p}/jeux/${jeuId}/rejeter`, { justification: "Je ne devrais pas pouvoir" }],
    ["DELETE", `${p}/jeux/${jeuId}`, undefined], ["POST", `${p}/analyses`, {}], ["POST", `${p}/regles`, { code: "REGLE-INTERDITE", toleranceProximiteM: 2, justification: "Je ne devrais pas pouvoir" }],
    ["POST", `${p}/conflits/${UUID_INCONNU}/statut`, { vers: "INFIRME", justification: "Je ne devrais pas pouvoir" }],
    ["POST", `${p}/conflits/${UUID_INCONNU}/preuves`, { type: "NOTE", texte: "Je ne devrais pas pouvoir" }],
    ["POST", `${p}/conflits/${UUID_INCONNU}/decisions`, { option: "PROTEGER", justification: "Je ne devrais pas pouvoir" }],
    ["PUT", `${p}/reseau/objets/1/descripteur`, { nature: "CIRCUIT_LOGIQUE", justification: "Je ne devrais pas pouvoir" }],
    ["POST", `${p}/reseau/relations`, { type: "PORTE_PAR", sourceObjetId: "1", cibleObjetId: "2", justification: "Je ne devrais pas pouvoir" }],
    ["POST", `${p}/reseau/associations/proposer`, {}],
    ["POST", `${p}/workflow/demandes`, { concessionnaireId: UUID_INCONNU, objet: "Je ne devrais pas pouvoir" }],
    ["POST", `${p}/workflow/referents`, { userId: lecteur.id, concessionnaireId: UUID_INCONNU, motif: "Je ne devrais pas pouvoir" }],
  ];
  for (const [m, u, corps] of ecritures) {
    const r = m === "POST" ? await l.post(u, corps) : m === "PATCH" ? await l.patch(u, corps) : m === "PUT" ? await l.put(u, corps) : await l.delete(u);
    expect(r.statut, `${m} ${u.replace(projetId, ":id").replace(jeuId, ":jeu")} par un lecteur`).toBe(403);
  }
  // Depot, import (toutes les routes d'import sont reservees aux roles qui ecrivent, lectures comprises) et exports CSV.
  const depot = await l.deposer(projetId, { name: "axes2.geojson", buffer: geojson(AXES, [3, 3]) }, { role: "AXES_TRAVAUX" });
  expect(depot.statut, "depot par un lecteur").toBe(403);
  expect((await l.multipart(`${p}/import/inventaire`, { name: "a.geojson", buffer: geojson(AXES) })).statut).toBe(403);
  expect((await l.multipart(`${p}/import/apercu`, { name: "a.geojson", buffer: geojson(AXES) })).statut).toBe(403);
  expect((await l.get(`${p}/import/options`)).statut).toBe(403);
  expect((await l.get(`${p}/analyse/export.csv`)).statut, "export CSV de l'analyse").toBe(403);
  expect((await l.get(`${p}/conflits/export.csv`)).statut, "export CSV des conflits").toBe(403);
  // Ce qu'un lecteur PEUT faire : lire. La route repond.
  expect((await l.get(`${p}`)).statut).toBe(200);

  const apres = { interdits: await comptesInterdits(), troncons: await empreinteTroncons(), jeux: await jeuxDuProjet(projetId), projets: (await requete<{ n: string }>(`SELECT count(*)::text AS n FROM projets_voirie`))[0].n };
  expect(apres, "aucune de ces ecritures n'a eu d'effet").toEqual(avant);
  expect((await requete(`SELECT 1 FROM projets_voirie WHERE code = 'LECTEUR-INTERDIT'`))).toHaveLength(0);

  // Dans le navigateur : le lecteur ne voit aucune action d'ecriture.
  const { page } = await ouvrirProfil();
  await seConnecter(page, lecteur);
  await ouvrirProjet(page, projetId);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ajouter des données" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Couches" }).click();
  await expect(page.getByRole("button", { name: /Retirer le jeu/ })).toHaveCount(0);
  await page.getByRole("tab", { name: "Conflits" }).click();
  await expect(page.getByRole("button", { name: "Lancer une analyse" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Exporter les conflits/ })).toHaveCount(0);
  await Promise.all([api.fermer(), l.fermer()]);
});

test("hors périmètre territorial : 404 masqué, identique à un projet inexistant ; projet retiré : 404 pour tous", async ({ ouvrirProfil, marqueur }) => {
  const adm = await ApiVoirie.connecter(admin);
  const idA = await adm.creerProjet(codeProjet(marqueur, "REGA"), { regionId: regionA });
  const idSansRegion = await adm.creerProjet(codeProjet(marqueur, "NOREG"));
  const jeuA = await adm.deposerEtAutoriser(idA, { name: "axes.geojson", buffer: geojson(AXES) }, { role: "AXES_TRAVAUX" });
  const a = await ApiVoirie.connecter(regionalA);
  const b = await ApiVoirie.connecter(regionalB);
  const national = await ApiVoirie.connecter(gestionnaire);

  const lectures = (id: string) => [
    `${BASE}/${id}`, `${BASE}/${id}/jeux`, `${BASE}/${id}/carte?jeux=${jeuA}`, `${BASE}/${id}/analyse`, `${BASE}/${id}/analyses`, `${BASE}/${id}/conflits`,
    `${BASE}/${id}/regles`, `${BASE}/${id}/import/options`, `${BASE}/${id}/reseau/objets`, `${BASE}/${id}/reseau/comptage`, `${BASE}/${id}/workflow/demandes`,
    `${BASE}/${id}/workflow/taches`,
  ];
  // Reference : la reponse a un projet qui n'existe pas. Le projet d'une autre region doit repondre EXACTEMENT pareil.
  for (const u of lectures(UUID_INCONNU)) {
    const inconnu = await b.get(u);
    const hors = await b.get(u.replace(UUID_INCONNU, idA).replace(`jeux=${jeuA}`, `jeux=${jeuA}`));
    expect(inconnu.statut, `projet inconnu : ${u.replace(UUID_INCONNU, ":id")}`).toBe(404);
    expect(hors.statut, `hors perimetre : ${u.replace(UUID_INCONNU, ":id")}`).toBe(404);
    expect(hors.corps, "meme corps : rien ne revele que le projet existe").toEqual(inconnu.corps);
  }
  // Ecritures hors perimetre : 404 aussi, et rien n'est ecrit.
  const avantJeux = await jeuxDuProjet(idA);
  expect((await b.deposer(idA, { name: "intrus.geojson", buffer: geojson(AXES, [9, 9]) }, { role: "AXES_TRAVAUX" })).statut).toBe(404);
  expect((await b.patch(`${BASE}/${idA}`, { nom: "Pirate" })).statut).toBe(404);
  // DELETE est reserve a l'ADMIN : le role est controle AVANT le projet (ordre documente des gardes), donc 403 et non 404.
  expect((await b.delete(`${BASE}/${idA}`)).statut).toBe(403);
  expect((await b.post(`${BASE}/${idA}/analyses`, {})).statut).toBe(404);
  expect((await b.post(`${BASE}/${idA}/jeux/${jeuA}/autoriser`, { justification: "Je ne devrais pas pouvoir" })).statut).toBe(404);
  expect((await b.multipart(`${BASE}/${idA}/import/apercu`, { name: "a.geojson", buffer: geojson(AXES) })).statut).toBe(404);
  expect(await jeuxDuProjet(idA)).toEqual(avantJeux);
  expect((await requete<{ nom: string }>(`SELECT nom FROM projets_voirie WHERE id = $1`, [idA]))[0].nom).not.toBe("Pirate");
  // La liste ne les mentionne pas : le compte de la region B ne voit ni le projet de A ni le projet sans region.
  const liste = await b.get(`${BASE}?limite=100`);
  const ids = liste.corps.projets.map((x: { id: string }) => x.id);
  expect(ids).not.toContain(idA);
  expect(ids).not.toContain(idSansRegion);
  // Le compte de la region A le voit ; le compte national aussi ; le projet sans region n'est lisible que d'un compte national.
  expect((await a.get(`${BASE}/${idA}`)).statut).toBe(200);
  expect((await national.get(`${BASE}/${idA}`)).statut).toBe(200);
  expect((await a.get(`${BASE}/${idSansRegion}`)).statut, "projet sans region : invisible d'un compte regional").toBe(404);
  expect((await national.get(`${BASE}/${idSansRegion}`)).statut).toBe(200);
  // Un compte regional ne cree que dans sa region (403), jamais sans region ni dans une autre.
  expect((await b.post(BASE, { code: codeProjet(marqueur, "CREE-B"), nom: "Region A", regionId: regionA })).statut).toBe(403);
  expect((await b.post(BASE, { code: codeProjet(marqueur, "CREE-B2"), nom: "Sans region" })).statut).toBe(403);
  // Lot T1 (correctifs m3) : un territoire d'une autre region et un territoire inexistant repondent la MEME chose a un compte regional
  // (404 TERRITOIRE_INTROUVABLE, avant toute autre verification) : aucun oracle d'existence d'un territoire.
  const territoireA = await territoireDeRegion(regionA);
  const terrAutre = await b.post(BASE, { code: codeProjet(marqueur, "CREE-B3"), nom: "Territoire de A", territoireId: territoireA });
  const terrInconnu = await b.post(BASE, { code: codeProjet(marqueur, "CREE-B4"), nom: "Territoire inconnu", territoireId: UUID_INCONNU });
  expect(terrAutre.statut, terrAutre.texte.slice(0, 200)).toBe(404);
  expect(terrAutre.corps).toMatchObject({ code: "TERRITOIRE_INTROUVABLE" });
  expect(terrAutre.corps, "meme corps que pour un territoire inexistant").toEqual(terrInconnu.corps);
  expect(await requete(`SELECT 1 FROM projets_voirie WHERE code LIKE $1`, [`${codeProjet(marqueur, "CREE-B")}%`])).toHaveLength(0);

  // Navigateur : le compte de la region B ouvre le projet de A : « introuvable », pas « refuse », et rien du projet.
  const { page } = await ouvrirProfil();
  await seConnecter(page, regionalB);
  await ouvrirProjet(page, idA);
  const etat = page.locator('[data-etat="introuvable"]');
  await expect(etat).toBeVisible();
  await expect(etat).toContainText("Projet : introuvable");
  await expect(page.getByText(codeProjet(marqueur, "REGA"))).toHaveCount(0);

  // Projet retire : 404 pour tous, ADMIN national compris, en lecture comme en ecriture.
  expect((await adm.delete(`${BASE}/${idA}`)).statut).toBe(200);
  for (const [nom, c] of [["admin", adm], ["gestionnaire de la region", a], ["gestionnaire national", national]] as const) {
    for (const u of [`${BASE}/${idA}`, `${BASE}/${idA}/jeux`, `${BASE}/${idA}/conflits`, `${BASE}/${idA}/import/options`]) {
      expect((await c.get(u)).statut, `projet retire, ${nom} : ${u.replace(idA, ":id")}`).toBe(404);
    }
    expect((await c.post(`${BASE}/${idA}/analyses`, {})).statut, `projet retire, analyse par ${nom}`).toBe(404);
  }
  // Suppression logique : la ligne est toujours en base (patrimoine d'archive).
  expect((await requete<{ supprime: boolean }>(`SELECT "deletedAt" IS NOT NULL AS supprime FROM projets_voirie WHERE id = $1`, [idA]))[0].supprime).toBe(true);
  await Promise.all([adm.fermer(), a.fermer(), b.fermer(), national.fermer()]);
});

test("aucune route n'exporte la géométrie ; la consultation d'un réseau confidentiel est tracée sans géométrie ni nom d'objet", async ({ marqueur }) => {
  const api = await ApiVoirie.connecter(gestionnaire);
  const projetId = await api.creerProjet(codeProjet(marqueur, "EXP"));
  const concId = await api.creerConcessionnaire(`Operateur ${marqueur}`);
  const jeuId = await api.deposerEtAutoriser(projetId, { name: "reseau-confidentiel.kml", buffer: kml(RESEAU_TELECOM) }, { role: "RESEAU_TIERS", concessionnaireId: concId });
  const jeux = await jeuxDuProjet(projetId);
  expect(jeux[0].confidentialite).toBe("CONFIDENTIEL_CONCESSIONNAIRE");

  // Aucun export de geometrie, meme pour celui qui a le droit de lire la carte : ces routes n'existent pas.
  for (const u of [`${BASE}/${projetId}/jeux/${jeuId}/export`, `${BASE}/${projetId}/jeux/${jeuId}/export.kml`, `${BASE}/${projetId}/jeux/${jeuId}/export.geojson`,
    `${BASE}/${projetId}/jeux/${jeuId}/geometrie`, `${BASE}/${projetId}/jeux/${jeuId}/telecharger`, `${BASE}/${projetId}/export.geojson`, `${BASE}/${projetId}/reseau/export`]) {
    const r = await api.get(u);
    expect(r.statut, `GET ${u.replace(projetId, ":id").replace(jeuId, ":jeu")} n'existe pas`).toBe(404);
    expect(r.texte).not.toContain("Fibre-Synth");
  }
  // La consultation de la carte est autorisee ET tracee (action SECURITY_EVENT), avant la remise des donnees.
  const carte = await api.get(`${BASE}/${projetId}/carte?jeux=${jeuId}`);
  expect(carte.statut).toBe(200);
  const traces = (await auditDe("ConsultationJeuProjet", jeuId));
  expect(traces.length, "une ligne d'audit de consultation pour le jeu confidentiel").toBeGreaterThanOrEqual(1);
  expect(traces[0].action).toBe("SECURITY_EVENT");
  expect(traces[0].userId).toBe(gestionnaire.id);
  const texteAudit = JSON.stringify(traces);
  expect(texteAudit, "l'audit ne contient aucun nom d'objet").not.toContain("Fibre-Synth");
  expect(texteAudit, "l'audit ne contient aucune coordonnee").not.toMatch(/-?\d{1,2}\.\d{5,}/);
  // Pas de fuite dans l'API PUBLIQUE de la carte (aucun nom d'objet du module).
  const anonyme = await ApiVoirie.anonyme();
  const publique = await anonyme.get("/api/public/carte/geo");
  expect(publique.texte, "l'API publique ne porte aucun objet du module").not.toContain("Fibre-Synth");
  expect(publique.texte).not.toContain(marqueur);
  await Promise.all([api.fermer(), anonyme.fermer()]);
});

// ------------------------------------------------------------------------------------------------ Fichiers hostiles

const KML_VALIDE = kml(AXES);
const nomHostile = (n: string) => ({ name: n, buffer: Buffer.alloc(0) });

interface CasHostile { nom: string; fichier: FichierEnvoye; statut: number[]; codes: string[] }

function casHostiles(): CasHostile[] {
  const xxe = Buffer.from(`<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>&xxe;</name><LineString><coordinates>-10.0,9.2,0 -10.001,9.2,0</coordinates></LineString></Placemark></Document></kml>`);
  const xxeParametre = Buffer.from(`<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY % ext SYSTEM "http://127.0.0.1:9/evil.dtd"> %ext;]><kml xmlns="http://www.opengis.net/kml/2.2"><Document/></kml>`);
  const milliard = Buffer.from(`<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>&c;</name><LineString><coordinates>-10.0,9.2,0 -10.001,9.2,0</coordinates></LineString></Placemark></Document></kml>`);
  const profond = Buffer.from(`{"type":"FeatureCollection","features":[{"type":"Feature","properties":${"[".repeat(200)}${"]".repeat(200)},"geometry":{"type":"Point","coordinates":[-10,9.2]}}]}`);
  const entrees101 = zip(Array.from({ length: 101 }, (_, i) => ({ nom: `dossier/n${i}.txt`, donnees: Buffer.from("x"), methode: "stocke" as const })));
  return [
    { nom: "KMZ zip-slip (..)", fichier: { name: "slip.kmz", buffer: zip([{ nom: "../evil.kml", donnees: KML_VALIDE }]) }, statut: [422], codes: ["ARCHIVE_CHEMIN_DANGEREUX"] },
    { nom: "KMZ zip-slip (chemin absolu)", fichier: { name: "absolu.kmz", buffer: zip([{ nom: "/etc/evil.kml", donnees: KML_VALIDE }]) }, statut: [422], codes: ["ARCHIVE_CHEMIN_DANGEREUX"] },
    { nom: "KMZ zip-slip (antislash)", fichier: { name: "antislash.kmz", buffer: zip([{ nom: "..\\evil.kml", donnees: KML_VALIDE }]) }, statut: [422], codes: ["ARCHIVE_CHEMIN_DANGEREUX"] },
    { nom: "KMZ bombe de decompression (5 Mo de zeros, ratio > 100)", fichier: { name: "bombe.kmz", buffer: zip([{ nom: "doc.kml", donnees: Buffer.alloc(5 * 1024 * 1024) }]) }, statut: [422], codes: ["ARCHIVE_TAUX_COMPRESSION"] },
    { nom: "KMZ imbrique (zip dans zip)", fichier: { name: "imbrique.kmz", buffer: zip([{ nom: "doc.kml", donnees: KML_VALIDE }, { nom: "interne.zip", donnees: zip([{ nom: "x.kml", donnees: KML_VALIDE }]) }]) }, statut: [422], codes: ["ARCHIVE_IMBRIQUEE"] },
    { nom: "KMZ de 101 entrees", fichier: { name: "beaucoup.kmz", buffer: entrees101 }, statut: [422], codes: ["ARCHIVE_TROP_D_ENTREES"] },
    { nom: "KML a entite externe (XXE, file:///etc/passwd)", fichier: { name: "xxe.kml", buffer: xxe }, statut: [422], codes: ["DTD_REFUSEE", "ENTITE_REFUSEE"] },
    { nom: "KML a entite parametre distante", fichier: { name: "xxe-param.kml", buffer: xxeParametre }, statut: [422], codes: ["DTD_REFUSEE", "ENTITE_REFUSEE"] },
    { nom: "KML « milliard de rires » (expansion d'entites)", fichier: { name: "rires.kml", buffer: milliard }, statut: [422], codes: ["DTD_REFUSEE", "ENTITE_REFUSEE"] },
    { nom: "GeoJSON a imbrication de 200 niveaux", fichier: { name: "profond.geojson", buffer: profond }, statut: [422], codes: ["JSON_TROP_PROFOND", "JSON_INVALIDE"] },
    { nom: "page HTML a script nommee .kml (contenu trompeur)", fichier: { name: "carte.kml", buffer: Buffer.from("<!doctype html><html><body><script>fetch('http://127.0.0.1:9/x')</script></body></html>") }, statut: [422, 415], codes: ["CONTENU_NON_RECONNU", "FORMAT_NON_SUPPORTE", "XML_INVALIDE"] },
    { nom: "PDF nomme .geojson", fichier: { name: "plan.geojson", buffer: Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n") }, statut: [422, 415], codes: ["CONTENU_NON_RECONNU", "FORMAT_NON_SUPPORTE", "JSON_INVALIDE"] },
    { nom: "executable Windows (MZ) nomme .csv", fichier: { name: "donnees.csv", buffer: Buffer.concat([Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "latin1"), Buffer.alloc(256, 0)]) }, statut: [422, 415], codes: ["CONTENU_NON_RECONNU", "FORMAT_NON_SUPPORTE"] },
    { nom: "base SQLite (GeoPackage) nommee .kml", fichier: { name: "donnees.kml", buffer: Buffer.concat([Buffer.from("SQLite format 3\0", "latin1"), Buffer.alloc(512, 0)]) }, statut: [422, 415], codes: ["CONTENU_NON_RECONNU", "FORMAT_NON_SUPPORTE"] },
    { nom: "image PNG nommee .json", fichier: { name: "carte.json", buffer: Buffer.from("89504e470d0a1a0a0000000d49484452", "hex") }, statut: [422, 415], codes: ["CONTENU_NON_RECONNU", "FORMAT_NON_SUPPORTE", "JSON_INVALIDE"] },
  ];
}

test("fichiers hostiles : refusés par le contenu AVANT toute écriture (dépôt, simulation, aperçu)", async ({ marqueur }) => {
  const api = await ApiVoirie.connecter(gestionnaire);
  const projetId = await api.creerProjet(codeProjet(marqueur, "HOST"));
  const avant = { interdits: await comptesInterdits(), troncons: await empreinteTroncons() };
  const auditAvant = (await auditDe("JeuDonneesProjet")).length;
  for (const c of casHostiles()) {
    for (const [route, appel] of [
      ["depot", () => api.deposer(projetId, c.fichier, { role: "AXES_TRAVAUX" })],
      ["simulation", () => api.deposer(projetId, c.fichier, { role: "AXES_TRAVAUX" }, { simuler: true })],
      ["apercu", () => api.multipart(`${BASE}/${projetId}/import/apercu`, c.fichier, {})],
    ] as const) {
      const r = await appel();
      expect(c.statut, `${c.nom} (${route}) : statut ${r.statut} ${r.texte.slice(0, 160)}`).toContain(r.statut);
      expect(c.codes, `${c.nom} (${route}) : code ${r.corps?.code}`).toContain(r.corps?.code);
      expect(r.statut, `${c.nom} (${route}) : jamais un 5xx`).toBeLessThan(500);
    }
  }
  expect(await jeuxDuProjet(projetId), "aucun fichier hostile n'a cree de jeu").toHaveLength(0);
  expect((await requete<{ n: string }>(`SELECT count(*)::text AS n FROM projets_voirie_objets o JOIN projets_voirie_jeux j ON j.id = o."jeuId" WHERE j."projetId" = $1`, [projetId]))[0].n).toBe("0");
  expect(await comptesInterdits()).toEqual(avant.interdits);
  expect(await empreinteTroncons()).toBe(avant.troncons);
  expect((await auditDe("JeuDonneesProjet")).length, "aucun depot refuse n'est audite comme un depot").toBe(auditAvant);
  // Un nom de fichier a octet NUL ou a chemin : refuse proprement (400), jamais un 500 ni une ecriture hors du dossier de travail.
  for (const nom of ["axes\u0000.kml", "../../etc/passwd.kml", "..\\..\\evil.kml"]) {
    const r = await api.deposer(projetId, { name: nom, buffer: KML_VALIDE }, { role: "AXES_TRAVAUX" }, { simuler: true });
    expect(r.statut, `nom de fichier ${JSON.stringify(nom)}`).toBeLessThan(500);
  }
  expect(await jeuxDuProjet(projetId)).toHaveLength(0);
  await api.fermer();
});

test("l'extension ne décide pas : un KML nommé .geojson est lu comme un KML, par son contenu", async ({ marqueur }) => {
  const api = await ApiVoirie.connecter(gestionnaire);
  const projetId = await api.creerProjet(codeProjet(marqueur, "EXT"));
  const r = await api.deposer(projetId, { name: "plan-axes.geojson", buffer: KML_VALIDE }, { role: "AXES_TRAVAUX" }, { simuler: true });
  expect(r.statut, r.texte.slice(0, 300)).toBe(200);
  expect(r.corps.jeu.format, "le format est celui du contenu").toBe("KML");
  const inv = await api.multipart(`${BASE}/${projetId}/import/inventaire`, { name: "plan-axes.geojson", buffer: KML_VALIDE });
  expect(inv.corps.detection).toMatchObject({ methode: "contenu", extensionDeclaree: "geojson", extensionCoherente: false });
  await api.fermer();
});

test("un nom d'objet qui contient du HTML est affiché comme du texte, jamais exécuté (assistant d'import)", async ({ ouvrirProfil, marqueur }) => {
  const { page } = await ouvrirProfil();
  const api = await ApiVoirie.connecter(gestionnaire);
  const projetId = await api.creerProjet(codeProjet(marqueur, "XSS"));
  const piege = "<img src=x onerror=window.__pwn=1>";
  const fichier = {
    name: "piege.kml",
    buffer: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name><![CDATA[${piege}]]></name><description><![CDATA[<script>window.__pwn=2</script>]]></description><LineString><coordinates>-10.0,9.2,0 -9.999,9.2,0</coordinates></LineString></Placemark></Document></kml>`),
  };
  await seConnecter(page, gestionnaire);
  await ouvrirProjet(page, projetId);
  const d = await ouvrirAssistant(page);
  await etapeDepot(page, d, { fichier, role: "AXES_TRAVAUX" });
  await attendreEtape(d, "Format et couches");
  await d.getByRole("button", { name: "Continuer", exact: true }).click();
  await d.getByRole("button", { name: "Vérifier la transformation" }).click();
  await expect(d.getByTestId("bloc-crs")).toBeVisible();
  await d.getByRole("button", { name: "Continuer", exact: true }).click();
  await d.getByRole("button", { name: "Continuer vers les contrôles" }).click();
  await attendreEtape(d, "Contrôles et échantillon");
  const echantillon = d.getByTestId("echantillon");
  await expect(echantillon).toContainText(piege);
  // Vague 3 : l'echantillon contient la carte (Leaflet y cree ses propres <img> de tuiles) ; seules comptent les balises HORS de la carte, et toute
  // balise portant la source ou le gestionnaire du piege.
  expect(await echantillon.evaluate((e) => Array.from(e.querySelectorAll("img")).filter((i) => !i.closest(".leaflet-container")).length), "aucune balise <img> n'a ete creee depuis le fichier").toBe(0);
  expect(await page.locator('img[src="x"], img[onerror]').count(), "aucune balise du piege, nulle part").toBe(0);
  expect(await page.locator("script:not([src])", { hasText: "__pwn" }).count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __pwn?: number }).__pwn), "aucun script du fichier ne s'est execute").toBeUndefined();
  await api.fermer();
  void nomHostile;
  void randomUUID;
  void MODULES_VOIRIE;
  void gestionnaire2;
});
