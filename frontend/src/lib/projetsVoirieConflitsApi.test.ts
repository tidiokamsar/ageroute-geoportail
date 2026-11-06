import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), download: vi.fn() }));
vi.mock("./api", () => ({ api: { get: h.get, post: h.post, patch: h.patch, delete: h.delete } }));
vi.mock("./download", () => ({ downloadViaApi: h.download }));

import {
  ajouterPreuve, approuverDecision, approuverRegle, attribuerConflit, changerStatutConflit, comparerAnalyses, creerRegle, exporterConflitsCsv, lancerAnalyseConflits,
  lireAnalyseConflit, lireComparaison, lireConflit, lireConflitResume, lireDetailAnalyse, lireFicheConflit, lireGeom, lireListeAnalyses, lireListeRegles, lirePageConflits,
  lirePersonne, lireRegle, lireTransitions, listerAnalyses, listerConflits, listerRegles, proposerDecision, refuserDecision, transitionsAffichees, urlExportConflits,
} from "./projetsVoirieConflitsApi";
import { FILTRES_VIDES } from "./projetsVoirieConflits";
import { ANALYSE_1, CONFLIT_INVESTIGUER, analyseConflit, brut, conflit, decision, fiche, pageConflits, preuve, regle } from "../components/projets-voirie/conflitsSynthetiques.testutil";

/**
 * Client des dossiers de conflit : chaque route du contrat (section 6), la forme des requetes (URL, parametres, corps) et les lecteurs de reponse
 * (tolerance sur les enveloppes non fixees par le contrat, refus du sens douteux : jamais de zero ni de statut invente).
 */

beforeEach(() => { for (const f of Object.values(h)) f.mockReset(); });

const BASE = "/v2/projets-voirie/p1";

describe("lecteur d'un conflit", () => {
  it("lit le modele du contrat (aller-retour d'une fixture serialisee)", () => {
    const c = lireConflitResume(brut(conflit()));
    expect(c).toMatchObject({
      id: "cf-1", cle: "cle-aaaa", type: "INTERSECTION_CHAUSSEE", statut: "POTENTIEL", risque: "MOYEN", classePrecision: "B", verticalEvalue: false, aReexaminer: false,
      axe: "Axe A", concessionnaire: { id: "c1", nom: "Operateur synthetique A" }, responsable: { id: "u-resp", nom: "Awa Responsable" }, echeance: "2099-12-31",
      mesure: { longueurChausseeM: 74.01, longueurEmpriseM: 145.02, distanceMinM: 0, nbCroisements: 2 },
      tronconsProches: [{ code: "RN1-012", nom: "Kissidougou - Faranah" }],
      premiereAnalyse: { id: "an-1", numero: 1 }, derniereAnalyse: { id: "an-2", numero: 2 },
    });
    expect(c?.geom?.type).toBe("LineString");
  });
  it("accepte les formes a plat : responsableId + responsableNom, concessionnaireId, premiereAnalyseId, decimaux en chaine, geometrie en Feature", () => {
    const c = lireConflitResume({
      id: 7, type: "PROXIMITE", statut: "A_INVESTIGUER", concessionnaireId: "c9", concessionnaireNom: "Eaux", responsableId: "u1", responsableNom: "Moi",
      mesure: { longueurChausseeM: "12.50", distanceMinM: "0.00" }, premiereAnalyseId: "a1", premiereAnalyseNumero: "3",
      geometrie: { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [-10, 9] } }, tronconsProches: ["RN1-001", { codeTroncon: "RN1-002", nomTroncon: "X" }, 5, ""],
    });
    expect(c).toMatchObject({ id: "7", concessionnaire: { id: "c9", nom: "Eaux" }, responsable: { id: "u1", nom: "Moi" }, premiereAnalyse: { id: "a1", numero: 3 } });
    expect(c?.mesure).toEqual({ longueurChausseeM: 12.5, longueurEmpriseM: null, distanceMinM: 0, nbCroisements: null });
    expect(c?.geom).toEqual({ type: "Point", coordinates: [-10, 9] });
    expect(c?.tronconsProches).toEqual([{ code: "RN1-001", nom: null }, { code: "RN1-002", nom: "X" }]);
  });
  it("une valeur absente reste null : jamais zero, jamais une classe, jamais « vertical evalue »", () => {
    const c = lireConflitResume({ id: "x", type: "PROXIMITE", statut: "POTENTIEL" });
    expect(c).toMatchObject({ axe: null, risque: null, responsable: null, echeance: null, classePrecision: "INCONNUE", verticalEvalue: null, geom: null, aReexaminer: false, motifReexamen: null });
    expect(c?.mesure).toEqual({ longueurChausseeM: null, longueurEmpriseM: null, distanceMinM: null, nbCroisements: null });
    expect(lireConflitResume({ id: "x", type: "PROXIMITE", statut: "POTENTIEL", verticalEvalue: true })?.verticalEvalue).toBe(true);
  });
  it("refuse un conflit sans identifiant, de statut ou de type inconnu (il n'est pas rendu : il est compte)", () => {
    expect(lireConflitResume({ type: "PROXIMITE", statut: "POTENTIEL" })).toBeNull();
    expect(lireConflitResume({ id: "x", type: "PROXIMITE", statut: "EXECUTE" })).toBeNull();
    expect(lireConflitResume({ id: "x", type: "DEPLACER", statut: "POTENTIEL" })).toBeNull();
    expect(lireConflitResume("x")).toBeNull();
    expect(lireConflitResume(null)).toBeNull();
  });
  it("lireGeom : nue, Feature, collection ; une valeur qui n'est pas une geometrie est ecartee", () => {
    expect(lireGeom({ type: "Point", coordinates: [1, 2] })).not.toBeNull();
    expect(lireGeom({ type: "GeometryCollection", geometries: [] })).not.toBeNull();
    expect(lireGeom({ type: "Point" })).toBeNull();
    expect(lireGeom("POINT(1 2)")).toBeNull();
    expect(lireGeom(null)).toBeNull();
  });
  it("lirePersonne : objet, identifiant seul, rien", () => {
    expect(lirePersonne({ id: "u", nomComplet: "A B" })).toEqual({ id: "u", nom: "A B" });
    expect(lirePersonne("u")).toEqual({ id: "u", nom: null });
    expect(lirePersonne(undefined, "u2", "N")).toEqual({ id: "u2", nom: "N" });
    expect(lirePersonne(null)).toBeNull();
    expect(lirePersonne({})).toBeNull();
  });
});

describe("liste des conflits", () => {
  it("lit {conflits, curseurSuivant, compteurs} et compte les elements illisibles", () => {
    const p = lirePageConflits({ conflits: [brut(conflit()), { id: "z", type: "?", statut: "?" }, 5], curseurSuivant: "c2", compteurs: { POTENTIEL: 1, CONFIRME: "2", X: 9 } });
    expect(p.conflits).toHaveLength(1);
    expect(p.ignores).toBe(2);
    expect(p.suivant).toBe("c2");
    expect(p.compteurs).toEqual({ POTENTIEL: 1, CONFIRME: 2 });
  });
  it("variantes d'enveloppe : liste nue, items, suivant, compteursParStatut", () => {
    expect(lirePageConflits([brut(conflit())]).conflits).toHaveLength(1);
    expect(lirePageConflits({ items: [brut(conflit())], suivant: "s", compteursParStatut: { INFIRME: 3 } })).toMatchObject({ suivant: "s", compteurs: { INFIRME: 3 } });
    expect(lirePageConflits({ conflits: [] })).toMatchObject({ conflits: [], suivant: null, compteurs: null, ignores: 0 });
  });
  it("une reponse inattendue LEVE : jamais une liste vide", () => {
    expect(() => lirePageConflits({ foo: 1 })).toThrow(/Réponse inattendue/);
    expect(() => lirePageConflits("x")).toThrow();
    expect(() => lirePageConflits(null)).toThrow();
  });
  it("GET /:id/conflits : parametres du contrat, curseur, identifiant encode", async () => {
    h.get.mockResolvedValueOnce({ data: brut(pageConflits()) });
    const page = await listerConflits("p/1", { ...FILTRES_VIDES, statut: "CONFIRME", aReexaminer: true, q: "fibre" }, "cur");
    expect(h.get).toHaveBeenCalledWith("/v2/projets-voirie/p%2F1/conflits", { params: { statut: "CONFIRME", aReexaminer: "true", q: "fibre", curseur: "cur" }, signal: undefined });
    expect(page.conflits).toHaveLength(4);
    expect(page.compteurs?.CONFIRME).toBe(2);
  });
});

describe("fiche d'un conflit", () => {
  it("lit mesure, regle, sources, historique (chronologique), preuves, decisions, transitions", () => {
    const f = lireFicheConflit(brut(fiche({ decisions: [decision()], historique: [{ ...fiche().historique[1] }, { ...fiche().historique[0] }] })));
    expect(f.regle).toMatchObject({ code: "RC-2D-0.1", version: 0, toleranceProximiteM: 0, margeIncertitude: 1 });
    expect(f.sources).toHaveLength(2);
    expect(f.sources[0]).toMatchObject({ version: 2, role: "RESEAU_TIERS", classePrecision: "B" });
    expect(f.historique.map((x) => x.action)).toEqual(["CREATION", "STATUT"]);
    expect(f.historique[0].acteur).toBeNull();
    expect(f.historique[1]).toMatchObject({ ancienStatut: "A_INVESTIGUER", nouveauStatut: "POTENTIEL", acteur: { nom: "Moussa Gestionnaire" } });
    expect(f.preuves[0]).toMatchObject({ type: "CONTACT_CONCESSIONNAIRE", reference: "Courrier 42/2026" });
    expect(f.decisions[0]).toMatchObject({ option: "PROTEGER", statut: "PROPOSEE", coutEstime: 12000, coutReel: null, deviseCout: "GNF" });
    expect(f.transitions?.map((t) => t.vers)).toEqual(["CONFIRME", "INFIRME", "A_INVESTIGUER"]);
  });
  it("enveloppe {conflit, historique...} : les listes peuvent etre au meme niveau que le conflit", () => {
    const f = lireFicheConflit({ conflit: brut(conflit()), historique: [brut(fiche().historique[0])], preuves: [], decisions: [], transitionsPossibles: ["CONFIRME"] });
    expect(f.id).toBe("cf-1");
    expect(f.historique).toHaveLength(1);
    expect(f.transitions).toEqual([{ vers: "CONFIRME", derogationPossible: false, exigences: [] }]);
  });
  it("couts : estime et reel sont DISTINCTS ; une chaine decimale est lue ; un cout absent est null, jamais 0 ; rien n'est somme", () => {
    const f = lireFicheConflit(brut(fiche({ decisions: [decision({ id: "d1", coutEstime: 1000, coutReel: 0 }), decision({ id: "d2", coutEstime: null, coutReel: null })] })));
    expect(f.decisions[0]).toMatchObject({ coutEstime: 1000, coutReel: 0 });
    expect(f.decisions[1]).toMatchObject({ coutEstime: null, coutReel: null });
    const brutD = lireFicheConflit({ ...(brut(fiche()) as object), decisions: [{ id: "d9", option: "A_ETUDIER", statut: "PROPOSEE", coutEstime: "12500.50", coutReel: "" }] });
    expect(brutD.decisions[0].coutEstime).toBe(12500.5);
    expect(brutD.decisions[0].coutReel).toBeNull();
    expect(Object.keys(brutD.decisions[0])).not.toContain("coutTotal");
  });
  it("ignore une decision, une preuve ou une regle d'etat inconnu plutot que d'inventer un etat", () => {
    const f = lireFicheConflit({ ...(brut(fiche()) as object), decisions: [{ id: "d", option: "EXECUTER", statut: "PROPOSEE" }, { id: "e", option: "PROTEGER", statut: "EXECUTEE" }], preuves: [{ id: "p", type: "RUMEUR", texte: "x" }] });
    expect(f.decisions).toEqual([]);
    expect(f.preuves).toEqual([]);
  });
  it("transitions : chaines ou objets ; vide = aucune (lecteur) ; absent = null (affichage de secours)", () => {
    expect(lireTransitions(["POTENTIEL", "INCONNU"])?.map((t) => t.vers)).toEqual(["POTENTIEL"]);
    expect(lireTransitions([{ vers: "CLOTURE", derogationPossible: true, exigences: ["motif", 3] }])).toEqual([{ vers: "CLOTURE", derogationPossible: true, exigences: ["motif"] }]);
    expect(lireTransitions([])).toEqual([]);
    expect(lireTransitions(undefined)).toBeNull();
    expect(lireTransitions("POTENTIEL")).toBeNull();
  });
  it("transitionsAffichees : le serveur d'abord (meme vide), la table de secours seulement s'il est muet", () => {
    expect(transitionsAffichees({ statut: "POTENTIEL", transitions: [] }, "ADMIN")).toEqual({ liste: [], deSecours: false });
    expect(transitionsAffichees({ statut: "POTENTIEL", transitions: null }, "GESTIONNAIRE").liste.map((t) => t.vers)).toEqual(["CONFIRME", "INFIRME", "A_INVESTIGUER"]);
    expect(transitionsAffichees({ statut: "POTENTIEL", transitions: null }, "GESTIONNAIRE").deSecours).toBe(true);
    expect(transitionsAffichees({ statut: "POTENTIEL", transitions: null }, "LECTEUR").liste).toEqual([]);
  });
  it("une reponse inattendue LEVE", () => {
    expect(() => lireFicheConflit("x")).toThrow(/Réponse inattendue/);
    expect(() => lireFicheConflit({ id: "x" })).toThrow();
    expect(() => lireFicheConflit({ id: "x", type: "PROXIMITE", statut: "NOUVEAU" })).toThrow();
  });
  it("GET /:id/conflits/:cid", async () => {
    h.get.mockResolvedValueOnce({ data: brut(fiche()) });
    const f = await lireConflit("p1", "cf/1");
    expect(h.get).toHaveBeenCalledWith(`${BASE}/conflits/cf%2F1`, { signal: undefined });
    expect(f.id).toBe("cf-1");
  });
});

describe("ecritures : une route par geste, corps du contrat", () => {
  it("PATCH attribution : seuls les champs fournis partent, null efface", async () => {
    h.patch.mockResolvedValueOnce({ data: {} });
    await attribuerConflit("p1", "cf-1", { responsableId: "u1", echeance: "2026-12-01", risque: "ELEVE", actionProposee: "Vérifier" });
    expect(h.patch).toHaveBeenCalledWith(`${BASE}/conflits/cf-1`, { responsableId: "u1", echeance: "2026-12-01", risque: "ELEVE", actionProposee: "Vérifier" });
    h.patch.mockResolvedValueOnce({ data: {} });
    await attribuerConflit("p1", "cf-1", { responsableId: null });
    expect(h.patch).toHaveBeenLastCalledWith(`${BASE}/conflits/cf-1`, { responsableId: null });
  });
  it("POST statut : { vers, justification, derogation? }", async () => {
    h.post.mockResolvedValue({ data: {} });
    await changerStatutConflit("p1", "cf-1", { vers: "CONFIRME", justification: "Preuve au dossier" });
    expect(h.post).toHaveBeenCalledWith(`${BASE}/conflits/cf-1/statut`, { vers: "CONFIRME", justification: "Preuve au dossier" });
    await changerStatutConflit("p1", "cf-1", { vers: "CLOTURE", justification: "Clos par l'administrateur", derogation: "Seul compte habilité" });
    expect(h.post).toHaveBeenLastCalledWith(`${BASE}/conflits/cf-1/statut`, { vers: "CLOTURE", justification: "Clos par l'administrateur", derogation: "Seul compte habilité" });
  });
  it("POST preuves, decisions, approuver, refuser", async () => {
    h.post.mockResolvedValue({ data: {} });
    await ajouterPreuve("p1", "cf-1", { type: "NOTE", texte: "Vu sur place", reference: "Plan 3" });
    expect(h.post).toHaveBeenLastCalledWith(`${BASE}/conflits/cf-1/preuves`, { type: "NOTE", texte: "Vu sur place", reference: "Plan 3" });
    await proposerDecision("p1", "cf-1", { option: "DEPLACER_RESEAU", justification: "Le réseau est sous la future chaussée", coutEstime: 5000, deviseCout: "GNF", coutReel: 0 });
    expect(h.post).toHaveBeenLastCalledWith(`${BASE}/conflits/cf-1/decisions`, { option: "DEPLACER_RESEAU", justification: "Le réseau est sous la future chaussée", coutEstime: 5000, deviseCout: "GNF", coutReel: 0 });
    await approuverDecision("p1", "cf-1", "d/1", { motif: "Approuvé en comité", derogation: "Seul compte habilité" });
    expect(h.post).toHaveBeenLastCalledWith(`${BASE}/conflits/cf-1/decisions/d%2F1/approuver`, { motif: "Approuvé en comité", derogation: "Seul compte habilité" });
    await refuserDecision("p1", "cf-1", "d1", { motif: "Option non retenue" });
    expect(h.post).toHaveBeenLastCalledWith(`${BASE}/conflits/cf-1/decisions/d1/refuser`, { motif: "Option non retenue" });
  });
  it("aucune route du module ne deplace, n'ordonne ni n'execute, et aucune n'exporte une geometrie", () => {
    const src = readFileSync(path.resolve(__dirname, "projetsVoirieConflitsApi.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const routes = [...src.matchAll(/`\$\{BASE\}([^`]*)`/g)].map((m) => m[1]);
    expect(routes.length).toBeGreaterThanOrEqual(15);
    for (const r of routes) {
      expect(r).not.toMatch(/deplacer|ordre|ordonner|executer|execution|travaux/i);
      expect(r).not.toMatch(/\.(geojson|kml|kmz|shp)|\/geometri/i);
    }
  });
});

describe("analyses persistees", () => {
  it("lit une analyse (resume, regles, jeux, acteur) et refuse un statut inconnu", () => {
    const a = lireAnalyseConflit(brut(analyseConflit()));
    expect(a).toMatchObject({ id: "an-2", numero: 2, statut: "TERMINEE", versionAlgorithme: "2D-UTM-1", dureeMs: 1840, declenchePar: { nom: "Moussa Gestionnaire" } });
    expect(a?.resume).toMatchObject({ total: 4, nouveaux: 1, retrouves: 2, disparus: 1, parType: { PROXIMITE: 2 } });
    expect(a?.regles[0]).toMatchObject({ code: "RC-2D-0.1", version: 0 });
    expect(a?.jeux[0]).toMatchObject({ version: 2, role: "RESEAU_TIERS" });
    expect(lireAnalyseConflit({ id: "a", statut: "EN_COURS" })).toBeNull();
    expect(lireAnalyseConflit({ statut: "TERMINEE" })).toBeNull();
  });
  it("resume : variantes de noms (totaux.conflits, nbNouveaux...) ; une valeur absente reste null", () => {
    const a = lireAnalyseConflit({ analyse: { id: "a", statut: "TERMINEE", numero: "5" }, resume: { totaux: { conflits: 9 }, nbNouveaux: "2", nbRetrouves: 7 } });
    expect(a?.numero).toBe(5);
    expect(a?.resume).toMatchObject({ total: 9, nouveaux: 2, retrouves: 7, disparus: null });
    expect(lireAnalyseConflit({ id: "a", statut: "ECHEC" })?.resume).toEqual({ total: null, parType: {}, parStatut: {}, nouveaux: null, retrouves: null, disparus: null });
  });
  it("une duree d'unite inconnue n'est pas affichee : seul `dureeMs` est lu", () => {
    expect(lireAnalyseConflit({ id: "a", statut: "TERMINEE", duree: 12 })?.dureeMs).toBeNull();
  });
  it("liste d'analyses : {analyses}, liste nue ; reponse inattendue LEVE", () => {
    expect(lireListeAnalyses({ analyses: [brut(analyseConflit()), brut(ANALYSE_1), { id: "?" }] })).toHaveLength(2);
    expect(lireListeAnalyses([brut(ANALYSE_1)])).toHaveLength(1);
    expect(() => lireListeAnalyses({ x: 1 })).toThrow(/Réponse inattendue/);
  });
  it("POST /:id/analyses : corps vide, lit {analyse} ou l'analyse a la racine", async () => {
    h.post.mockResolvedValueOnce({ data: { analyse: brut(analyseConflit()), resume: brut(analyseConflit().resume) } });
    const r = await lancerAnalyseConflits("p1");
    expect(h.post).toHaveBeenCalledWith(`${BASE}/analyses`, {});
    expect(r.analyse?.numero).toBe(2);
    h.post.mockResolvedValueOnce({ data: brut(analyseConflit()) });
    expect((await lancerAnalyseConflits("p1")).analyse?.id).toBe("an-2");
  });
  it("GET analyses, analyses/:aid, comparaison?avec=", async () => {
    h.get.mockResolvedValueOnce({ data: { analyses: [brut(ANALYSE_1)] } });
    expect(await listerAnalyses("p1")).toHaveLength(1);
    expect(h.get).toHaveBeenLastCalledWith(`${BASE}/analyses`, { signal: undefined });
    h.get.mockResolvedValueOnce({ data: brut(analyseConflit()) });
    expect((await lireDetailAnalyse("p1", "an-2")).numero).toBe(2);
    expect(h.get).toHaveBeenLastCalledWith(`${BASE}/analyses/an-2`, { signal: undefined });
    h.get.mockResolvedValueOnce({ data: { apparus: { nb: 1, cles: ["k1"] }, disparus: { nb: 0, cles: [] }, modifies: { nb: 0, cles: [] }, identiques: { nb: 3, cles: [] } } });
    const c = await comparerAnalyses("p1", "an-2", "an-1");
    expect(h.get).toHaveBeenLastCalledWith(`${BASE}/analyses/an-2/comparaison`, { params: { avec: "an-1" }, signal: undefined });
    expect(c.apparus).toEqual({ nb: 1, cles: ["k1"] });
  });
  it("lecture de detail inexploitable : LEVE", async () => {
    h.get.mockResolvedValueOnce({ data: { id: "a", statut: "BIZARRE" } });
    await expect(lireDetailAnalyse("p1", "a")).rejects.toThrow(/Réponse inattendue/);
  });
});

describe("comparaison de deux analyses", () => {
  it("categories en {nb, cles}, en nombres, en listes, en champs a plat", () => {
    expect(lireComparaison({ apparus: { nb: 2, cles: ["a", "b"] }, disparus: 1, modifies: ["m"], identiques: { total: 4 } })).toEqual({
      apparus: { nb: 2, cles: ["a", "b"] }, disparus: { nb: 1, cles: [] }, modifies: { nb: 1, cles: ["m"] }, identiques: { nb: 4, cles: [] },
    });
    expect(lireComparaison({ nbApparus: 1, clesApparus: ["a"], nbDisparus: 0, nbModifies: 0, nbIdentiques: 2 })).toMatchObject({ apparus: { nb: 1, cles: ["a"] }, identiques: { nb: 2, cles: [] } });
    expect(lireComparaison({ comparaison: { apparus: [{ cle: "z" }], disparus: [], modifies: [], identiques: [] } }).apparus).toEqual({ nb: 1, cles: ["z"] });
  });
  it("une reponse qui n'a pas les quatre categories LEVE : jamais « aucune difference »", () => {
    expect(() => lireComparaison({})).toThrow(/Réponse inattendue/);
    expect(() => lireComparaison({ apparus: 1 })).toThrow();
    expect(() => lireComparaison(null)).toThrow();
  });
});

describe("regles", () => {
  it("lit une regle versionnee ; refuse un statut inconnu", () => {
    const r = lireRegle(brut(regle({ id: "r", code: "RC-TEL", version: 2, famille: "TELECOM", toleranceProximiteM: 3, margeIncertitude: 1.5, statut: "BROUILLON" })));
    expect(r).toMatchObject({ code: "RC-TEL", version: 2, famille: "TELECOM", toleranceProximiteM: 3, margeIncertitude: 1.5, statut: "BROUILLON" });
    expect(lireRegle({ id: "r", code: "X", statut: "ACTIVE" })).toBeNull();
    expect(lireRegle({ code: "X", statut: "BROUILLON" })).toBeNull();
  });
  it("la regle par defaut (version 0, tolerance 0) garde son zero, sans seuil invente", () => {
    const r = lireRegle(brut(regle()));
    expect(r).toMatchObject({ version: 0, toleranceProximiteM: 0, famille: null });
    expect(lireRegle({ id: "r", code: "X", statut: "BROUILLON" })?.toleranceProximiteM).toBeNull();
  });
  it("liste : {regles}, liste nue, elements illisibles comptes, reponse inattendue LEVE", () => {
    expect(lireListeRegles({ regles: [brut(regle()), { id: "x" }] })).toMatchObject({ ignores: 1 });
    expect(lireListeRegles([brut(regle())]).regles).toHaveLength(1);
    expect(() => lireListeRegles({})).toThrow(/Réponse inattendue/);
  });
  it("GET /regles, POST /regles, POST /regles/:id/approuver", async () => {
    h.get.mockResolvedValueOnce({ data: { regles: [brut(regle())] } });
    expect((await listerRegles("p1")).regles).toHaveLength(1);
    expect(h.get).toHaveBeenLastCalledWith(`${BASE}/regles`, { signal: undefined });
    h.post.mockResolvedValue({ data: {} });
    await creerRegle("p1", { famille: "TELECOM", code: "RC-TEL", toleranceProximiteM: 2, margeIncertitude: 1, justification: "Tolérance convenue" });
    expect(h.post).toHaveBeenLastCalledWith(`${BASE}/regles`, { famille: "TELECOM", code: "RC-TEL", toleranceProximiteM: 2, margeIncertitude: 1, justification: "Tolérance convenue" });
    await approuverRegle("p1", "rg/2", { justification: "Approuvée par la direction", derogation: "Auteur unique disponible" });
    expect(h.post).toHaveBeenLastCalledWith(`${BASE}/regles/rg%2F2/approuver`, { justification: "Approuvée par la direction", derogation: "Auteur unique disponible" });
  });
});

describe("export CSV", () => {
  it("adresse authentifiee par l'API, nom de fichier assaini, aucune geometrie", async () => {
    expect(urlExportConflits("p1")).toBe(`${BASE}/conflits/export.csv`);
    h.download.mockResolvedValueOnce(undefined);
    await exporterConflitsCsv("p1", "KISSI VOIRIE/2026");
    expect(h.download).toHaveBeenCalledWith(`${BASE}/conflits/export.csv`, "KISSI_VOIRIE_2026-dossiers-de-conflit.csv");
  });
});

describe("contre-epreuve : un conflit infirme reste un conflit lu comme tel", () => {
  it("le statut INFIRME n'est pas confondu avec l'absence de conflit", () => {
    const c = lireConflitResume(brut({ ...conflit(), statut: "INFIRME" }));
    expect(c?.statut).toBe("INFIRME");
    expect(lireConflitResume(brut(CONFLIT_INVESTIGUER))?.statut).toBe("A_INVESTIGUER");
    expect(preuve().texte.length).toBeGreaterThan(10);
  });
});
