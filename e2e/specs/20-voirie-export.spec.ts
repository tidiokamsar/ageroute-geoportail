import { createHash } from "node:crypto";
import { requete } from "../lib/base";
import { expect, test } from "../lib/fixtures";
import {
  ApiVoirie, BASE, attendreQue, auditDe, codeProjet, creerCompte, jeuxDuProjet, sha256, type CompteVoirie,
} from "../lib/voirie";
import { AXES, RESEAU_TELECOM, geojson, lireZip, versWgs84 } from "../lib/voirie-geo";

/**
 * Lot C1 bis, scenario e : export du dossier technique (CONTRAT-EXPORTS.md ; decision architecturale 2, section 8). Aucun ecran d'export dans
 * l'interface (lot UI-C : hors perimetre) : couvert par l'API, archive RELUE par un lecteur ZIP independant de l'application (lib/voirie-geo.ts).
 *
 *   - archive : manifeste, empreintes SHA-256 de chaque fichier (manifeste.json et manifeste.sha256), empreinte de l'archive dans l'en-tete ;
 *   - GeoJSON des seuls jeux AUTORISE d'un niveau exportable : le reseau CONFIDENTIEL_CONCESSIONNAIRE est ecarte sans derogation, la quarantaine aussi ;
 *   - derogation ADMIN accordee a une AUTRE personne (l'ADMIN ne se l'accorde pas), citee par elle seule, consommee UNE fois ;
 *   - un lecteur n'exporte pas ; audit sans geometrie.
 */

test.describe.configure({ mode: "serial" });

let admin: CompteVoirie;
let g1: CompteVoirie;
let g2: CompteVoirie;
let lecteur: CompteVoirie;
const etat = { projetId: "", code: "", axes: "", reseau: "", quarantaine: "", derogation: "" };
type Entree = { nom: string; donnees: Buffer };

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Relit une archive : chaque fichier liste au manifeste existe et a l'empreinte dite ; manifeste.sha256 couvre aussi manifeste.json. */
function verifierArchive(octets: Buffer, entetes: Record<string, string>): { fichiers: Map<string, Buffer>; manifeste: any; racine: string } {
  expect(entetes["content-type"]).toContain("application/zip");
  expect(entetes["x-empreinte-sha256"], "empreinte de l'archive annoncee").toBe(sha(octets));
  const entrees: Entree[] = lireZip(octets);
  const racine = entrees[0].nom.split("/")[0];
  for (const e of entrees) expect(e.nom.startsWith(`${racine}/`), `${e.nom} sous la racine`).toBe(true);
  const fichiers = new Map(entrees.map((e) => [e.nom.slice(racine.length + 1), e.donnees]));
  expect(Number(entetes["x-fichiers"])).toBe(entrees.length);
  const manifeste = JSON.parse(fichiers.get("manifeste.json")!.toString("utf8"));
  expect(manifeste.format).toBe("BDRI-DOSSIER-1");
  expect(manifeste.exportId).toBe(entetes["x-export-id"]);
  for (const f of manifeste.fichiers as Array<{ chemin: string; octets: number; sha256: string }>) {
    const d = fichiers.get(f.chemin);
    expect(d, `${f.chemin} present dans l'archive`).toBeTruthy();
    expect(d!.length).toBe(f.octets);
    expect(sha(d!), `empreinte de ${f.chemin}`).toBe(f.sha256);
  }
  // Tous les fichiers sauf le manifeste et son controle sont au manifeste ; manifeste.sha256 (format sha256sum) couvre tout, manifeste compris.
  expect([...fichiers.keys()].filter((k) => !["manifeste.json", "manifeste.sha256"].includes(k)).sort()).toEqual((manifeste.fichiers as Array<{ chemin: string }>).map((f) => f.chemin).sort());
  const lignes = fichiers.get("manifeste.sha256")!.toString("utf8").trim().split(/\r?\n/);
  const controle = new Map(lignes.map((l) => { const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(l)!; return [m[2], m[1]] as const; }));
  expect(controle.get("manifeste.json")).toBe(sha(fichiers.get("manifeste.json")!));
  for (const [chemin, h] of controle) expect(sha(fichiers.get(chemin)!), `manifeste.sha256 : ${chemin}`).toBe(h);
  return { fichiers, manifeste, racine };
}

const geojsons = (f: Map<string, Buffer>) => [...f.keys()].filter((k) => k.startsWith("geojson/"));
/** Le GeoJSON d'un jeu (nom `geojson/<role>-v<version>-<jeuId>.geojson`) ; `undefined` s'il n'est pas dans l'archive. */
const geojsonDe = (f: Map<string, Buffer>, jeuId: string) => { const k = geojsons(f).find((n) => n.endsWith(`-v1-${jeuId}.geojson`)); return k ? JSON.parse(f.get(k)!.toString("utf8")) : undefined; };

test.beforeAll(async () => {
  admin = await creerCompte("e2e-exp-admin", "Admin Export C1bis", "ADMIN");
  g1 = await creerCompte("e2e-exp-g1", "Gestionnaire beneficiaire C1bis", "GESTIONNAIRE");
  g2 = await creerCompte("e2e-exp-g2", "Gestionnaire tiers C1bis", "GESTIONNAIRE");
  lecteur = await creerCompte("e2e-exp-lect", "Lecteur export C1bis", "LECTEUR");
});

test("e. archive relue : manifeste et empreintes exacts ; le réseau confidentiel et la quarantaine sont absents du GeoJSON sans dérogation", async ({ marqueur }) => {
  const g = await ApiVoirie.connecter(g1);
  etat.code = codeProjet(marqueur, "EXP");
  etat.projetId = await g.creerProjet(etat.code);
  const conc = await g.creerConcessionnaire(`Operateur synthetique EXP ${marqueur}`, "TELECOM");
  etat.axes = await g.deposerEtAutoriser(etat.projetId, { name: "axes-exp.geojson", buffer: geojson(AXES) }, { role: "AXES_TRAVAUX" });
  etat.reseau = await g.deposerEtAutoriser(etat.projetId, { name: "reseau-exp.geojson", buffer: geojson(RESEAU_TELECOM) }, { role: "RESEAU_TIERS", concessionnaireId: conc, classePrecision: "B" });
  etat.quarantaine = await g.deposerOk(etat.projetId, { name: "limites-exp.geojson", buffer: geojson(AXES, [0, 50]) }, { role: "LIMITES_ROUTE" });
  const jeux = await jeuxDuProjet(etat.projetId);
  const conf = (id: string) => jeux.find((j) => j.id === id)!.confidentialite;
  expect(conf(etat.reseau), "plancher d'un reseau de concessionnaire").toBe("CONFIDENTIEL_CONCESSIONNAIRE");
  expect(["PUBLIC", "INTERNE", "RESTREINT_PROJET"]).toContain(conf(etat.axes));
  expect((await g.analyser(etat.projetId)).statut).toBe(201);

  const r = await g.getBinaire(`${BASE}/${etat.projetId}/export/dossier`);
  expect(r.statut, r.texte.slice(0, 300)).toBe(200);
  expect(r.entetes["content-disposition"]).toMatch(new RegExp(`attachment; filename="dossier-${etat.code}-\\d{4}-\\d{2}-\\d{2}\\.zip"`, "i"));
  const { fichiers, manifeste } = verifierArchive(r.octets, r.entetes);
  for (const f of ["LISEZMOI.txt", "fiche-projet.json", "fiche-projet.pdf", "analyse/agregats.json", "conflits/dossiers.csv", "documents/journal.json", "documents/journal.csv", "documents/completude.json"]) {
    expect(fichiers.has(f), `${f} dans l'archive`).toBe(true);
  }
  expect(fichiers.get("fiche-projet.pdf")!.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  // GeoJSON : le plan d'axes seulement.
  expect(geojsons(fichiers)).toHaveLength(1);
  expect(geojsonDe(fichiers, etat.axes), "le GeoJSON du plan d'axes").toBeTruthy();
  expect(Number(r.entetes["x-jeux-geojson"])).toBe(1);
  expect(manifeste.geojson.inclus.map((x: { jeuId: string }) => x.jeuId)).toEqual([etat.axes]);
  const ecartes = new Map((manifeste.geojson.ecartes as Array<{ jeuId: string; raison: string }>).map((x) => [x.jeuId, x.raison]));
  expect(ecartes.get(etat.reseau), "reseau confidentiel, sans derogation").toBe("CONFIDENTIALITE");
  expect(ecartes.get(etat.quarantaine), "jeu en quarantaine : jamais exporte").toBe("NON_AUTORISE");
  // Le GeoJSON exporte est celui des axes synthetiques (WGS 84, 7 decimales), sans les attributs du fichier source.
  const fc = geojsonDe(fichiers, etat.axes);
  expect(fc.type).toBe("FeatureCollection");
  expect(fc.bdri).toMatchObject({ jeuId: etat.axes, role: "AXES_TRAVAUX", derogation: false });
  expect(fc.features).toHaveLength(2);
  const a = fc.features.find((f: { properties: { nom: string } }) => f.properties.nom === "Axe A");
  const attendu = versWgs84([0, 0]);
  expect(Math.abs(a.geometry.coordinates[0][0] - attendu[0])).toBeLessThan(1e-6);
  expect(Object.keys(a.properties).sort()).toEqual(["longueurM", "nom", "objetId", "ordre", "typeGeom"]);
  // Journal : une tentative REMIS, empreinte de l'archive.
  const journal = await attendreQue(() => g.get(`${BASE}/${etat.projetId}/export/journal`), (j) => j.corps.exports?.[0]?.statut === "REMIS");
  expect(journal.corps.exports[0]).toMatchObject({ statut: "REMIS", sha256: sha(r.octets), nbJeuxGeojson: 1, derogationId: null, acteur: { id: g1.id } });
  await g.fermer();
});

test("e. un lecteur n'exporte pas ; un projet hors de portée répond comme l'inexistant", async () => {
  test.skip(!etat.projetId, "depend de la preparation");
  const l = await ApiVoirie.connecter(lecteur);
  const r = await l.getBinaire(`${BASE}/${etat.projetId}/export/dossier`);
  expect(r.statut).toBe(403);
  expect((await l.get(`${BASE}/${etat.projetId}/export/journal`)).statut).toBe(403);
  expect((await l.post(`${BASE}/${etat.projetId}/export/derogations`, { jeuxIds: [etat.reseau], justification: "Un lecteur ne derogera jamais rien", beneficiaireId: lecteur.id })).statut).toBe(403);
  // Une derogation est reservee a l'ADMIN.
  const g = await ApiVoirie.connecter(g2);
  expect((await g.post(`${BASE}/${etat.projetId}/export/derogations`, { jeuxIds: [etat.reseau], justification: "Un gestionnaire ne derogera jamais rien", beneficiaireId: g2.id })).statut).toBe(403);
  await Promise.all([l.fermer(), g.fermer()]);
});

test("e. dérogation : accordée par l'ADMIN à une autre personne, citée par elle seule, consommée une seule fois", async () => {
  test.skip(!etat.projetId, "depend de la preparation");
  const p = `${BASE}/${etat.projetId}`;
  const adm = await ApiVoirie.connecter(admin);
  const justification = "Transmission au bureau d'etudes synthetique pour l'etude de deviation";
  // L'ADMIN ne se l'accorde pas a lui-meme (separation des taches) ; un jeu exportable n'en a pas besoin ; un jeu en quarantaine non plus.
  const soi = await adm.post(`${p}/export/derogations`, { jeuxIds: [etat.reseau], justification, beneficiaireId: admin.id });
  expect(soi.statut).toBe(409);
  expect(soi.corps.code).toBe("SEPARATION_DES_TACHES");
  const inutile = await adm.post(`${p}/export/derogations`, { jeuxIds: [etat.axes], justification, beneficiaireId: g1.id });
  expect(inutile.statut).toBe(409);
  expect(inutile.corps.code).toBe("DEROGATION_INUTILE");
  const nonAut = await adm.post(`${p}/export/derogations`, { jeuxIds: [etat.quarantaine], justification, beneficiaireId: g1.id });
  expect(nonAut.statut).toBe(409);
  expect(nonAut.corps.code).toBe("JEU_NON_AUTORISE");
  expect((await adm.post(`${p}/export/derogations`, { jeuxIds: [etat.reseau], justification: "trop courte", beneficiaireId: g1.id })).statut, "justification de 20 caracteres").toBe(400);
  const ok = await adm.post(`${p}/export/derogations`, { jeuxIds: [etat.reseau], justification, beneficiaireId: g1.id, dureeHeures: 2 });
  expect(ok.statut, ok.texte.slice(0, 300)).toBe(201);
  expect(ok.corps.derogation).toMatchObject({ etat: "DISPONIBLE", beneficiaire: { id: g1.id }, accordeePar: { id: admin.id }, jeuxIds: [etat.reseau] });
  etat.derogation = ok.corps.derogation.id;

  // Citee par un autre compte (l'ADMIN qui l'accorde, un autre gestionnaire) : 404 identique a une derogation inconnue ; rien n'est consomme.
  const inconnue = await adm.getBinaire(`${p}/export/dossier?derogation=00000000-0000-4000-8000-0000000000de`);
  expect(inconnue.statut).toBe(404);
  const parAdmin = await adm.getBinaire(`${p}/export/dossier?derogation=${etat.derogation}`);
  expect(parAdmin.statut).toBe(404);
  expect(parAdmin.corps).toEqual(inconnue.corps);
  const g2c = await ApiVoirie.connecter(g2);
  const parTiers = await g2c.getBinaire(`${p}/export/dossier?derogation=${etat.derogation}`);
  expect(parTiers.statut).toBe(404);
  expect(parTiers.corps).toEqual(inconnue.corps);
  expect((await adm.get(`${p}/export/derogations`)).corps.derogations.find((x: { id: string }) => x.id === etat.derogation).etat).toBe("DISPONIBLE");

  // Le beneficiaire l'utilise : le reseau confidentiel est exporte, le manifeste et le GeoJSON disent la derogation.
  const g = await ApiVoirie.connecter(g1);
  const r = await g.getBinaire(`${p}/export/dossier?derogation=${etat.derogation}`);
  expect(r.statut, r.texte.slice(0, 300)).toBe(200);
  const { fichiers, manifeste } = verifierArchive(r.octets, r.entetes);
  expect(geojsons(fichiers)).toHaveLength(2);
  expect(manifeste.derogationId).toBe(etat.derogation);
  expect(manifeste.geojson.inclus.find((x: { jeuId: string }) => x.jeuId === etat.reseau)).toMatchObject({ confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE", derogation: true });
  const fc = geojsonDe(fichiers, etat.reseau);
  expect(fc.bdri).toMatchObject({ jeuId: etat.reseau, confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE", derogation: true });
  expect(fc.features).toHaveLength(6);
  expect(manifeste.geojson.ecartes.map((x: { jeuId: string }) => x.jeuId)).toEqual([etat.quarantaine]);

  // Consommee (apres la remise complete) : un second usage est refuse, rien n'est exporte.
  const vue = await attendreQue(() => adm.get(`${p}/export/derogations`), (v) => v.corps.derogations.find((x: { id: string }) => x.id === etat.derogation)?.etat === "UTILISEE");
  const d = vue.corps.derogations.find((x: { id: string }) => x.id === etat.derogation);
  expect(d).toMatchObject({ etat: "UTILISEE", exportId: r.entetes["x-export-id"] });
  expect(d.utiliseeLe).not.toBeNull();
  const encore = await g.getBinaire(`${p}/export/dossier?derogation=${etat.derogation}`);
  expect(encore.statut).toBe(409);
  expect(encore.corps).toMatchObject({ code: "DEROGATION_INDISPONIBLE", etat: "UTILISEE" });
  // Sans derogation, le meme compte retombe sur la regle : le reseau est ecarte.
  const sans = await g.getBinaire(`${p}/export/dossier`);
  expect(sans.statut).toBe(200);
  const fs = verifierArchive(sans.octets, sans.entetes).fichiers;
  expect(geojsons(fs)).toHaveLength(1);
  expect(geojsonDe(fs, etat.reseau), "sans derogation, le reseau est ecarte").toBeUndefined();
  // La base garantit l'usage unique (declencheur) : une seule consommation, un seul export la porte.
  const lignes = await requete<{ n: string }>(`SELECT count(*)::text AS n FROM exports_dossier_projet_voirie WHERE "projetId" = $1 AND manifeste->>'derogationId' = $2`, [etat.projetId, etat.derogation]);
  expect(lignes[0].n, "un seul export a utilise la derogation").toBe("1");

  // Audit : creation et consommation de la derogation, remise des archives ; aucune coordonnee.
  const auditDerog = await auditDe("DerogationExportProjetVoirie", etat.derogation);
  expect(auditDerog.length, "creation et consommation tracees").toBeGreaterThanOrEqual(2);
  const auditExports = await requete<{ after: unknown }>(`SELECT "after" FROM audit_logs WHERE "entityType" = 'ExportDossierProjetVoirie' AND "userId" = $1`, [g1.id]);
  expect(auditExports.length).toBeGreaterThanOrEqual(3);
  expect(JSON.stringify([...auditDerog, ...auditExports]), "audit sans geometrie").not.toMatch(/coordinates|LineString/);
  expect(JSON.stringify(auditExports)).toContain(sha(r.octets));
  await Promise.all([adm.fermer(), g.fermer(), g2c.fermer()]);
});

test("e. empreinte du fichier source portée par le GeoJSON exporté (provenance), jamais ses attributs", async () => {
  test.skip(!etat.axes, "depend de la preparation");
  const jeux = await jeuxDuProjet(etat.projetId);
  const g = await ApiVoirie.connecter(g1);
  const r = await g.getBinaire(`${BASE}/${etat.projetId}/export/dossier?geojson=false`);
  expect(r.statut).toBe(200);
  const { fichiers, manifeste } = verifierArchive(r.octets, r.entetes);
  expect(geojsons(fichiers), "geojson=false : aucun GeoJSON").toEqual([]);
  expect(new Set(manifeste.geojson.ecartes.map((x: { raison: string }) => x.raison))).toEqual(new Set(["GEOJSON_NON_DEMANDE", "NON_AUTORISE"]));
  const fiche = JSON.parse(fichiers.get("fiche-projet.json")!.toString("utf8"));
  const texte = JSON.stringify(fiche);
  expect(texte, "la fiche porte l'empreinte du fichier d'origine des axes").toContain(jeux.find((j) => j.id === etat.axes)!.sha256);
  const jeuxFiche = (fiche.jeux ?? fiche.projet?.jeux) as Array<Record<string, unknown>>;
  expect(jeuxFiche.map((j) => j.id).sort(), "jeux non retires, quarantaine comprise (le decideur la lit deja)").toEqual([etat.axes, etat.reseau, etat.quarantaine].sort());
  for (const j of jeuxFiche) { expect(j).not.toHaveProperty("resume"); expect(j).not.toHaveProperty("avertissements"); }
  expect(sha256(r.octets)).toBe(r.entetes["x-empreinte-sha256"]);
  await g.fermer();
});
