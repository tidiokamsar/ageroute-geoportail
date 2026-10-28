import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), download: vi.fn() }));
vi.mock("./api", () => ({ api: { get: h.get, post: h.post, patch: h.patch, delete: h.delete } }));
vi.mock("./download", () => ({ downloadViaApi: h.download }));

import {
  autoriserJeu, chargerAnalyse, chargerCarte, creerConcessionnaire, creerProjet, deposerJeu, exporterCsv, lireAnalyse, lireCarte, lireFicheProjet, lireJeu, lirePageProjets,
  lireObjetCarte, lireReponseDepot, listerConcessionnaires, listerJeux, listerProjets, lireProjet, modifierProjet, rejeterJeu, retirerJeu, retirerProjet, urlExportCsv,
} from "./projetsVoirieApi";
import { analyse, jeu, ligne, projetFiche } from "../components/projets-voirie/synthetique.testutil";

/**
 * Client « Projets de voirie » : chaque route du contrat (section 4), la forme des requetes (URL, parametres, multipart) et les lecteurs de
 * reponse (tolerance sur les formes non fixees par le contrat, refus d'une reponse inattendue).
 */

beforeEach(() => { for (const f of Object.values(h)) f.mockReset(); });

const BASE = "/v2/projets-voirie";
const brutJeu = { id: "j1", role: "RESEAU_TIERS", nomFichier: "a.kml", format: "KML", nbObjets: "4", statut: "CONTROLE", version: 1, concessionnaire: { id: "c1", nom: "Operateur", typeReseau: "TELECOM" } };

describe("liste, creation, fiche, parametres, retrait du projet", () => {
  it("GET / : filtre q, curseur, limite ; lit {projets, suivant} et une liste nue", async () => {
    h.get.mockResolvedValueOnce({ data: { projets: [{ id: "p1", code: "A-1", nom: "A", largeurEmpriseM: "15.00", largeurChausseeM: "7.00", statutParametres: "THEORIQUE", nbJeux: 2 }], suivant: "c2" } });
    const page = await listerProjets({ q: " kissi ", curseur: "c1", limite: 25 });
    expect(h.get).toHaveBeenCalledWith(BASE, { params: { q: "kissi", curseur: "c1", limite: 25 } });
    expect(page.suivant).toBe("c2");
    expect(page.projets[0]).toMatchObject({ largeurEmpriseM: 15, largeurChausseeM: 7, nbJeux: 2, statutParametres: "THEORIQUE" });
    expect(lirePageProjets([{ id: "p", code: "C", nom: "N" }]).projets).toHaveLength(1);
    expect(lirePageProjets({ items: [], nextCursor: null })).toEqual({ projets: [], suivant: null });
  });
  it("POST / cree un projet", async () => {
    h.post.mockResolvedValueOnce({ data: { id: "p1", code: "A-1", nom: "A", jeux: [] } });
    const p = await creerProjet({ code: "A-1", nom: "A", largeurEmpriseM: 15, largeurChausseeM: 7 });
    expect(h.post).toHaveBeenCalledWith(BASE, { code: "A-1", nom: "A", largeurEmpriseM: 15, largeurChausseeM: 7 });
    expect(p.id).toBe("p1");
  });
  it("GET /:id : forme a plat ou imbriquee, emprise, jeux", async () => {
    h.get.mockResolvedValueOnce({ data: { projet: { id: "p1", code: "A-1", nom: "A" }, parametres: { largeurEmpriseM: "20.00", statutParametres: "VALIDE" }, jeux: [brutJeu], bbox: [-10.1, 9.1, -10, 9.2] } });
    const f = await lireProjet("p/1");
    expect(h.get).toHaveBeenCalledWith(`${BASE}/p%2F1`);
    expect(f).toMatchObject({ largeurEmpriseM: 20, statutParametres: "VALIDE", bbox: [-10.1, 9.1, -10, 9.2] });
    expect(f.jeux[0]).toMatchObject({ nbObjets: 4, statut: "CONTROLE", nonAutorise: true });
  });
  it("une reponse inattendue LEVE : jamais un projet vide", () => {
    expect(() => lireFicheProjet("nimporte quoi")).toThrow(/Réponse inattendue/);
    expect(() => lireFicheProjet({ id: "p" })).toThrow();
    expect(() => lirePageProjets({ foo: 1 })).toThrow();
    expect(() => lireAnalyse({})).toThrow();
    expect(() => lireCarte({})).toThrow();
    expect(() => lireReponseDepot({})).toThrow();
  });
  it("PATCH /:id : largeurs et validation ; DELETE /:id", async () => {
    h.patch.mockResolvedValueOnce({ data: projetFiche() });
    await modifierProjet("p1", { largeurEmpriseM: 20, largeurChausseeM: 8, statutParametres: "VALIDE" });
    expect(h.patch).toHaveBeenCalledWith(`${BASE}/p1`, { largeurEmpriseM: 20, largeurChausseeM: 8, statutParametres: "VALIDE" });
    h.delete.mockResolvedValueOnce({ data: {} });
    await retirerProjet("p1");
    expect(h.delete).toHaveBeenCalledWith(`${BASE}/p1`);
  });
});

describe("concessionnaires", () => {
  it("GET et POST /concessionnaires", async () => {
    h.get.mockResolvedValueOnce({ data: [{ id: "c1", nom: "Operateur", typeReseau: "TELECOM", contact: "x" }, { nom: "sans id" }] });
    expect(await listerConcessionnaires()).toEqual([{ id: "c1", nom: "Operateur", typeReseau: "TELECOM", contact: "x" }]);
    expect(h.get).toHaveBeenCalledWith(`${BASE}/concessionnaires`);
    h.post.mockResolvedValueOnce({ data: { id: "c2", nom: "Eaux", typeReseau: "EAU_POTABLE" } });
    const c = await creerConcessionnaire({ nom: "Eaux", typeReseau: "EAU_POTABLE" });
    expect(h.post).toHaveBeenCalledWith(`${BASE}/concessionnaires`, { nom: "Eaux", typeReseau: "EAU_POTABLE" });
    expect(c.id).toBe("c2");
  });
});

describe("depot multipart", () => {
  const donnees = (over = {}) => ({ fichier: new File(["x"], "reseau.kml"), role: "RESEAU_TIERS" as const, concessionnaireId: "c1", confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE" as const, ...over });
  const reponse = { jeu: brutJeu, resume: { nbObjets: 3, parTypeGeom: { LIGNE: 3 }, longueurTotaleM: 100, longueurPhysiqueM: 80, bbox: [-10.1, 9.1, -10, 9.2], attributsDetectes: ["Name"] }, avertissements: [{ code: "ALTITUDE_IGNOREE", message: "m", nb: 2 }], crs: { source: "EPSG:4326", cible: "EPSG:4326", methode: "aucune", justification: "WGS84" }, delta: { ajoutes: 1, retires: 0, identiques: 2 } };

  it("simulation : ?simuler=true, champs AVANT le fichier, fichier en dernier", async () => {
    h.post.mockResolvedValueOnce({ data: reponse });
    await deposerJeu("p1", donnees({ origineFichier: "recu le 24/10", classePrecision: "B", precisionHorizontaleM: 2.5, natureObjet: "ACTIF_PHYSIQUE" }), { simuler: true });
    const [url, corps, options] = h.post.mock.calls[0];
    expect(url).toBe(`${BASE}/p1/jeux`);
    expect(options.params).toEqual({ simuler: "true" });
    const entrees = [...(corps as FormData).entries()];
    expect(entrees[entrees.length - 1][0]).toBe("fichier");
    expect(Object.fromEntries(entrees.filter(([k]) => k !== "fichier"))).toEqual({
      role: "RESEAU_TIERS", concessionnaireId: "c1", confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE", origineFichier: "recu le 24/10",
      classePrecision: "B", precisionHorizontaleM: "2.5", natureObjets: "ACTIF_PHYSIQUE",
    });
  });
  it("ecriture : aucun parametre `simuler`", async () => {
    h.post.mockResolvedValueOnce({ data: reponse });
    await deposerJeu("p1", donnees(), { simuler: false });
    expect(h.post.mock.calls[0][2].params).toBeUndefined();
  });
  it("sans origine du fichier : le champ n'est pas envoye (facultatif, jamais bloquant) ; plus de `referenceConvention`", async () => {
    h.post.mockResolvedValueOnce({ data: reponse });
    await deposerJeu("p1", donnees(), { simuler: true });
    const cles = [...(h.post.mock.calls[0][1] as FormData).keys()];
    expect(cles).not.toContain("origineFichier");
    expect(cles).not.toContain("referenceConvention");
    expect(cles).not.toContain("precisionDeclareeM");
  });
  it("lit le resume (tracé fusionné), le bloc CRS, le delta et les avertissements", async () => {
    h.post.mockResolvedValueOnce({ data: reponse });
    const r = await deposerJeu("p1", donnees(), { simuler: true });
    expect(r.resume).toMatchObject({ nbObjets: 3, longueurTotaleM: 100, longueurTraceFusionneM: 80, parTypeGeom: { LIGNE: 3 } });
    expect(r.crs).toEqual({ source: "EPSG:4326", cible: "EPSG:4326", methode: "aucune", justification: "WGS84" });
    expect(r.delta).toEqual({ ajoutes: 1, retires: 0, identiques: 2 });
    expect(r.avertissements).toEqual([{ code: "ALTITUDE_IGNOREE", message: "m", nb: 2 }]);
    expect(r.jeu?.statut).toBe("CONTROLE");
  });
  it("sans delta ni CRS : null, rien d'invente", () => {
    const r = lireReponseDepot({ resume: { nbObjets: 1 } });
    expect(r.crs).toBeNull();
    expect(r.delta).toBeNull();
  });
  it("les erreurs axios sont rejetees TELLES QUELLES (le dialogue les classe)", async () => {
    const e = { response: { status: 409, data: { code: "JEU_DEJA_CHARGE", jeuId: "j1" } } };
    h.post.mockRejectedValueOnce(e);
    await expect(deposerJeu("p1", donnees(), { simuler: true })).rejects.toBe(e);
  });
  it("progression d'envoi", async () => {
    h.post.mockImplementationOnce(async (_u: string, _c: unknown, o: { onUploadProgress: (e: { loaded: number; total?: number }) => void }) => { o.onUploadProgress({ loaded: 5, total: 10 }); return { data: reponse }; });
    const suivi = vi.fn();
    await deposerJeu("p1", donnees(), { simuler: true, onProgression: suivi });
    expect(suivi).toHaveBeenCalledWith(5, 10);
  });
});

describe("jeux : liste, autorisation, rejet, retrait", () => {
  it("GET /:id/jeux", async () => {
    h.get.mockResolvedValueOnce({ data: { jeux: [brutJeu, { sans: "id" }] } });
    expect(await listerJeux("p1")).toHaveLength(1);
    expect(h.get).toHaveBeenCalledWith(`${BASE}/p1/jeux`);
  });
  it("POST /:id/jeux/:jeuId/autoriser et /rejeter avec { justification }", async () => {
    h.post.mockResolvedValue({ data: { jeu: { ...brutJeu, statut: "AUTORISE" } } });
    const j = await autoriserJeu("p1", "j1", "Conforme au plan recu");
    expect(h.post).toHaveBeenLastCalledWith(`${BASE}/p1/jeux/j1/autoriser`, { justification: "Conforme au plan recu" });
    expect(j?.statut).toBe("AUTORISE");
    await rejeterJeu("p1", "j1", "Hors perimetre du projet");
    expect(h.post).toHaveBeenLastCalledWith(`${BASE}/p1/jeux/j1/rejeter`, { justification: "Hors perimetre du projet" });
  });
  it("DELETE /:id/jeux/:jeuId (retrait logique)", async () => {
    h.delete.mockResolvedValueOnce({ data: {} });
    await retirerJeu("p1", "j/1");
    expect(h.delete).toHaveBeenCalledWith(`${BASE}/p1/jeux/j%2F1`);
  });
  it("lecteur de jeu : ancien statut ACTIF = AUTORISE ; anciens noms de champs ; confidentialite a 5 niveaux", () => {
    expect(lireJeu({ ...brutJeu, statut: "ACTIF", longueurPhysiqueM: 12, confidentialite: "RESTREINT" })).toMatchObject({ statut: "AUTORISE", nonAutorise: false, longueurTraceFusionneM: 12, confidentialite: "RESTREINT_PROJET" });
    expect(lireJeu({ ...brutJeu, confidentialite: "INFRASTRUCTURE_SENSIBLE", classePrecision: "D", natureObjets: "CIRCUIT_LOGIQUE" })).toMatchObject({ confidentialite: "INFRASTRUCTURE_SENSIBLE", classePrecision: "D", natureObjet: "CIRCUIT_LOGIQUE" });
    expect(lireJeu({ ...brutJeu, classePrecision: "Z" })?.classePrecision).toBe("INCONNUE");
    expect(lireJeu({ id: "x", role: "INCONNU" })).toBeNull();
  });
});

describe("carte et analyse", () => {
  it("GET /:id/carte : jeux, bbox, zoom, inclureNonAutorises", async () => {
    h.get.mockResolvedValueOnce({ data: [{ jeuId: "j1", role: "RESEAU_TIERS", typeReseau: "TELECOM", features: [ligne("a", 0, 0, 1, 1), { pas: "une feature" }], tronque: true, nonAutorise: true }] });
    const c = await chargerCarte("p1", { jeux: ["j1", "j2"], bbox: [-10.1, 9.1, -10, 9.2], zoom: 15.4, inclureNonAutorises: true });
    expect(h.get).toHaveBeenCalledWith(`${BASE}/p1/carte`, { params: { jeux: "j1,j2", bbox: "-10.1,9.1,-10,9.2", zoom: 15, inclureNonAutorises: "true" }, signal: undefined });
    expect(c[0]).toMatchObject({ jeuId: "j1", tronque: true, nonAutorise: true });
    expect(c[0].features).toHaveLength(1);
  });
  it("sans option : pas de parametre superflu", async () => {
    h.get.mockResolvedValueOnce({ data: [] });
    await chargerCarte("p1", { jeux: [], bbox: null, zoom: null });
    expect(h.get.mock.calls[0][1].params).toEqual({});
  });
  it("GET /:id/analyse : largeurs surchargees SANS enregistrer, jeux non autorises a la demande", async () => {
    h.get.mockResolvedValue({ data: analyse() });
    await chargerAnalyse("p1");
    expect(h.get).toHaveBeenLastCalledWith(`${BASE}/p1/analyse`, { params: {} });
    await chargerAnalyse("p1", { largeurEmpriseM: 20, largeurChausseeM: 8 }, true);
    expect(h.get).toHaveBeenLastCalledWith(`${BASE}/p1/analyse`, { params: { largeurEmpriseM: 20, largeurChausseeM: 8, inclureNonAutorises: "true" } });
    expect(h.patch).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
  });
  it("lecteur d'analyse : tracé fusionné (ancien nom accepte), statut, version de la regle, version de l'algorithme", () => {
    const brut = JSON.parse(JSON.stringify(analyse()));
    brut.reseaux.parType = [{ typeReseau: "TELECOM", longueurPhysiqueM: 99, nbObjets: 1 }];
    brut.conflits.parAxe[0] = { ...brut.conflits.parAxe[0], statut: "A_VERIFIER", regle: { version: "2" } };
    delete brut.conflits.parAxe[0].verification;
    const a = lireAnalyse(brut);
    expect(a.reseaux.parType[0].longueurTraceFusionneM).toBe(99);
    expect(a.conflits.parAxe[0].verification).toEqual({ statut: "A_VERIFIER", versionRegle: "2" });
    expect(a.versionAlgorithme).toBe("2026.10-test");
  });
  it("une ligne sans statut est « A_VERIFIER » par defaut (jamais presentee comme etablie)", () => {
    const brut = JSON.parse(JSON.stringify(analyse()));
    delete brut.conflits.parAxe[1].verification;
    expect(lireAnalyse(brut).conflits.parAxe[1].verification.statut).toBe("A_VERIFIER");
  });
  it("analyse sans axes ni reseau : zeros et une phrase, jamais une erreur", () => {
    const a = lireAnalyse({ parametres: { largeurEmpriseM: 15, largeurChausseeM: 7 }, axes: { nb: 0, longueurM: 0 }, reseaux: { parType: [], parConcessionnaire: [] }, conflits: { total: {}, parAxe: [], parConcessionnaire: [], croisements: null, zones: {} }, hypotheses: [], limites: ["Aucun axe."] });
    expect(a.conflits.total).toMatchObject({ chausseeM: 0, empriseM: 0, croisements: 0, axesTouches: 0, objetsTouches: 0 });
    expect(a.limites).toEqual(["Aucun axe."]);
  });
});

describe("formes du contrat v2", () => {
  it("depot : attributs detectes en { nom, nb }, remplace, simulation", () => {
    const r = lireReponseDepot({ simulation: true, jeu: { ...brutJeu, id: null }, remplace: { jeuId: "j0", version: 2 }, resume: { nbObjets: 2, attributsDetectes: [{ nom: "Name", nb: 2 }, "Circuit", { nb: 1 }] } });
    expect(r.simulation).toBe(true);
    expect(r.remplace).toEqual({ jeuId: "j0", version: 2 });
    expect(r.resume.attributsDetectes).toEqual(["Name", "Circuit"]);
  });
  it("carte : { jeux: [FeatureCollection] } avec objetId ; l'attribut d'origine reste sous attributs", () => {
    const c = lireCarte({ projetId: "p1", plafond: 20000, tronque: false, jeux: [{ type: "FeatureCollection", jeuId: "j1", role: "RESEAU_TIERS", nonAutorise: true, features: [{ type: "Feature", geometry: { type: "Point", coordinates: [-10, 9] }, properties: { objetId: "42", jeuId: "j1", nom: "Regard", attributs: { Name: "R1" } } }] }] });
    expect(c[0]).toMatchObject({ jeuId: "j1", nonAutorise: true });
    const o = lireObjetCarte("j1", c[0].features[0]);
    expect(o).toMatchObject({ id: "42", nom: "Regard", attributs: { Name: "R1" } });
  });
  it("analyse : statut A_VERIFIER par ligne, version de la regle prise a la racine, qualification du serveur, hors emprise", () => {
    const brut = JSON.parse(JSON.stringify(analyse()));
    brut.regle = { version: "RC-2D-0.1" };
    brut.conflits.total.horsEmpriseM = 120;
    brut.conflits.total.empriseHorsChausseeM = 500;
    for (const l of brut.conflits.parAxe) { l.statut = "A_VERIFIER"; delete l.verification; }
    brut.conflits.parConcessionnaire[0] = { ...brut.conflits.parConcessionnaire[0], qualification: "PROXIMITE_A_VERIFIER", classePrecision: "D", statut: "A_VERIFIER" };
    const a = lireAnalyse(brut);
    expect(a.conflits.parAxe[0].verification).toEqual({ statut: "A_VERIFIER", versionRegle: "RC-2D-0.1" });
    expect(a.conflits.total).toMatchObject({ horsEmpriseM: 120, empriseHorsChausseeM: 500 });
    expect(a.conflits.parConcessionnaire[0]).toMatchObject({ qualification: "PROXIMITE_A_VERIFIER", classePrecision: "D" });
  });
  it("jeu : justificationDecision lue comme justification", () => {
    expect(lireJeu({ ...brutJeu, statut: "REJETE", justificationDecision: "Hors perimetre" })).toMatchObject({ statut: "REJETE", nonAutorise: true, justification: "Hors perimetre" });
  });
});

describe("export CSV d'agregats", () => {
  it("l'URL porte les memes largeurs que l'analyse affichee", () => {
    expect(urlExportCsv("p1")).toBe(`${BASE}/p1/analyse/export.csv`);
    expect(urlExportCsv("p1", { largeurEmpriseM: 20, largeurChausseeM: 8 }, true)).toBe(`${BASE}/p1/analyse/export.csv?largeurEmpriseM=20&largeurChausseeM=8&inclureNonAutorises=true`);
  });
  it("telecharge par l'API authentifiee, sous un nom de fichier sur", async () => {
    h.download.mockResolvedValueOnce(undefined);
    await exporterCsv("p1", "KISSI VOIRIE/2026");
    expect(h.download).toHaveBeenCalledWith(`${BASE}/p1/analyse/export.csv`, "KISSI_VOIRIE_2026-conflits.csv");
  });
  it("le client n'expose aucun export de geometrie", async () => {
    const mod = await import("./projetsVoirieApi");
    expect(Object.keys(mod).filter((k) => /geom|geojson|kml/i.test(k) && /export|telecharger/i.test(k))).toEqual([]);
  });
});

describe("fixtures", () => {
  it("un jeu de test est bien synthetique", () => {
    expect(jeu().concessionnaire?.nom).toMatch(/synthetique/i);
  });
});
