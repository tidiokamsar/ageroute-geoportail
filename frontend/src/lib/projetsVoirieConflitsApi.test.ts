import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), download: vi.fn() }));
vi.mock("./api", () => ({ api: { get: h.get, post: h.post, patch: h.patch, delete: h.delete } }));
vi.mock("./download", () => ({ downloadViaApi: h.download }));

import {
  acquitterReexamen, ajouterPreuve, approuverDecision, approuverRegle, attribuerConflit, changerStatutConflit, comparerAnalyses, creerRegle, exporterConflitsCsv, lancerAnalyseConflits,
  lireAnalyseConflit, lireComparaison, lireConflit, lireConflitResume, lireDetailAnalyse, lireFicheConflit, lireGeom, lireListeRegles, lirePageAnalyses, lirePageConflits,
  lirePersonne, lireRegle, lireTransitions, listerAnalyses, listerConflits, listerRegles, proposerDecision, refuserDecision, transitionsAffichees, urlExportConflits,
} from "./projetsVoirieConflitsApi";
import { FILTRES_VIDES } from "./projetsVoirieConflits";
import {
  ANALYSE_1, CONFLIT_INVESTIGUER, analyseConflit, brut, conflit, decision, fiche, pageConflits, regle, serveurAnalyse, serveurComparaison, serveurConflit, serveurDetailAnalyse, serveurFiche,
  serveurLancement, serveurListeAnalyses, serveurPage, serveurRegle, serveurRegles, transition, REGLES,
} from "../components/projets-voirie/conflitsSynthetiques.testutil";

/**
 * Client des dossiers de conflit : chaque route du contrat (section 6), la forme des requetes (URL, parametres, corps) et les lecteurs de reponse, exerces
 * sur le JSON tel que le BACKEND le rend (convertisseurs `serveur*`, forme relevee dans le code du lot, commit 2a5e9cb). Refus du sens douteux : jamais de
 * zero ni de statut invente.
 */

beforeEach(() => { for (const f of Object.values(h)) f.mockReset(); });

const BASE = "/v2/projets-voirie/p1";

describe("lecteur d'un conflit (liste)", () => {
  it("lit la vue du serveur : responsable { id, nomComplet }, objet, bbox sans geometrie, echeance depassee calculee par le serveur", () => {
    const c = lireConflitResume(brut(serveurConflit(conflit())));
    expect(c).toMatchObject({
      id: "cf-1", cle: "cle-aaaa", type: "INTERSECTION_CHAUSSEE", statut: "POTENTIEL", risque: "MOYEN", classePrecision: "B", verticalEvalue: false, aReexaminer: false,
      axe: "Axe A", concessionnaire: { id: "c1", nom: "Operateur synthetique A" }, typeReseau: "TELECOM", objet: { id: "2", nom: "Fibre FO-01" },
      responsable: { id: "u-resp", nom: "Awa Responsable" }, echeance: "2099-12-31", echeanceDepassee: false, geometrieMasquee: false,
      mesure: { longueurChausseeM: 74.01, longueurEmpriseM: 145.02, distanceMinM: 0, nbCroisements: 2, longueurPieceM: 145.02 },
      premiereAnalyse: { id: "an-1", numero: null }, derniereAnalyse: { id: "an-2", numero: null },
    });
    expect(c?.bbox).toEqual(conflit().bbox);
    expect(c?.geom).toBeNull();
  });
  it("classePrecision nulle = « INCONNUE » (jamais une classe inventee) ; echeanceDepassee absente = null", () => {
    const c = lireConflitResume(brut(serveurConflit(CONFLIT_INVESTIGUER)));
    expect(c).toMatchObject({ classePrecision: "INCONNUE", echeanceDepassee: true, risque: null, responsable: null });
    expect(lireConflitResume({ id: "x", type: "PROXIMITE", statut: "POTENTIEL" })?.echeanceDepassee).toBeNull();
  });
  it("une valeur absente reste null : jamais zero, jamais « vertical evalue »", () => {
    const c = lireConflitResume({ id: "x", type: "PROXIMITE", statut: "POTENTIEL" });
    expect(c).toMatchObject({ axe: null, risque: null, responsable: null, echeance: null, classePrecision: "INCONNUE", verticalEvalue: null, geom: null, bbox: null, aReexaminer: false, motifReexamen: null, objet: null });
    expect(c?.mesure).toEqual({ longueurChausseeM: null, longueurEmpriseM: null, distanceMinM: null, nbCroisements: null, longueurPieceM: null });
    expect(lireConflitResume({ id: "x", type: "PROXIMITE", statut: "POTENTIEL", verticalEvalue: true })?.verticalEvalue).toBe(true);
  });
  it("accepte les decimaux en chaine, un id numerique, la geometrie nue ou en Feature", () => {
    const c = lireConflitResume({ id: 7, type: "PROXIMITE", statut: "A_INVESTIGUER", mesure: { longueurChausseeM: "12.50", distanceMinM: "0.00" }, geometrie: { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [-10, 9] } } });
    expect(c?.id).toBe("7");
    expect(c?.mesure).toMatchObject({ longueurChausseeM: 12.5, distanceMinM: 0, longueurEmpriseM: null });
    expect(c?.geom).toEqual({ type: "Point", coordinates: [-10, 9] });
  });
  it("geometrie masquee par le serveur : drapeau lu, bbox nulle", () => {
    const c = lireConflitResume(brut(serveurConflit(conflit({ geometrieMasquee: true }))));
    expect(c).toMatchObject({ geometrieMasquee: true, bbox: null });
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
  it("lirePersonne : { id, nomComplet }, { id, nom }, identifiant seul, rien", () => {
    expect(lirePersonne({ id: "u", nomComplet: "A B" })).toEqual({ id: "u", nom: "A B" });
    expect(lirePersonne({ id: "u", nom: "C" })).toEqual({ id: "u", nom: "C" });
    expect(lirePersonne("u")).toEqual({ id: "u", nom: null });
    expect(lirePersonne(null)).toBeNull();
    expect(lirePersonne({})).toBeNull();
  });
});

describe("liste des conflits", () => {
  it("lit {conflits, compteurs, total, curseurSuivant} et compte les elements illisibles", () => {
    const p = lirePageConflits({ conflits: [brut(serveurConflit(conflit())), { id: "z", type: "?", statut: "?" }, 5], curseurSuivant: "c2", total: 9, compteurs: { POTENTIEL: 1, CONFIRME: "2", X: 9 } });
    expect(p.conflits).toHaveLength(1);
    expect(p.ignores).toBe(2);
    expect(p.suivant).toBe("c2");
    expect(p.compteurs).toEqual({ POTENTIEL: 1, CONFIRME: 2 });
  });
  it("compteurs a zero du serveur : conserves (un zero du serveur est un zero) ; pas de compteurs : null", () => {
    expect(lirePageConflits(brut(serveurPage(pageConflits([], { compteurs: { A_INVESTIGUER: 0, POTENTIEL: 0, CONFIRME: 0, INFIRME: 0, TRAITEMENT_DECIDE: 0, CLOTURE: 0 } })))).compteurs?.CONFIRME).toBe(0);
    expect(lirePageConflits({ conflits: [] })).toMatchObject({ conflits: [], suivant: null, compteurs: null, ignores: 0 });
  });
  it("une reponse inattendue LEVE : jamais une liste vide", () => {
    expect(() => lirePageConflits({ foo: 1 })).toThrow(/Réponse inattendue/);
    expect(() => lirePageConflits("x")).toThrow();
    expect(() => lirePageConflits(null)).toThrow();
  });
  it("GET /:id/conflits : parametres du contrat, curseur, identifiant encode", async () => {
    h.get.mockResolvedValueOnce({ data: brut(serveurPage(pageConflits())) });
    const page = await listerConflits("p/1", { ...FILTRES_VIDES, statut: "CONFIRME", aReexaminer: true, q: "fibre" }, "cur");
    expect(h.get).toHaveBeenCalledWith("/v2/projets-voirie/p%2F1/conflits", { params: { statut: "CONFIRME", aReexaminer: "true", q: "fibre", curseur: "cur" }, signal: undefined });
    expect(page.conflits).toHaveLength(4);
    expect(page.compteurs?.CONFIRME).toBe(2);
  });
});

describe("fiche d'un conflit", () => {
  const complete = () => fiche({ decisions: [decision()] });

  it("lit la fiche du serveur : geometrie de `conflit.geometrie`, mesure, regle, largeurs, sources, historique chronologique, preuves, decisions, transitions", () => {
    const f = lireFicheConflit(brut(serveurFiche({ ...complete(), historique: [fiche().historique[1], fiche().historique[0]] })));
    expect(f.geom?.type).toBe("LineString");
    expect(f.premiereAnalyse).toEqual({ id: "an-1", numero: 1 });
    expect(f.derniereAnalyse).toEqual({ id: "an-2", numero: 2 });
    expect(f.regle).toMatchObject({ code: "RC-2D-0.1", version: 0, portee: "GENERALE", toleranceProximiteM: 0, margeIncertitude: 1, versionAlgorithme: "2D-UTM-1" });
    expect(f.largeurs).toEqual({ empriseM: 15, chausseeM: 7 });
    expect(f.sources).toHaveLength(2);
    expect(f.sources[0]).toMatchObject({ version: 2, role: "RESEAU_TIERS", classePrecision: "B", concessionnaire: "Operateur synthetique A", precisionHorizontaleM: 2, dateDonnees: "2026-10-24" });
    expect(f.historique.map((x) => x.action)).toEqual(["CREATION", "STATUT"]);
    expect(f.historique[0].acteur).toBeNull();
    expect(f.historique[0].analyse).toEqual({ id: "an-1", numero: 1 });
    expect(f.historique[1]).toMatchObject({ ancienStatut: "A_INVESTIGUER", nouveauStatut: "POTENTIEL", acteur: { nom: "Moussa Gestionnaire" }, analyse: null });
    expect(f.preuves[0]).toMatchObject({ type: "CONTACT_CONCESSIONNAIRE", reference: "Courrier 42/2026", auteur: { nom: "Moussa Gestionnaire" } });
    expect(f.decisions[0]).toMatchObject({ option: "PROTEGER", statut: "PROPOSEE", coutEstime: 12000, coutReel: null, deviseCout: "GNF" });
    expect(f.tronconsProches).toEqual([{ code: "RN1-012", nom: "Kissidougou - Faranah" }]);
  });
  it("geometrie masquee : la fiche n'a pas de geometrie et le dit", () => {
    const f = lireFicheConflit(brut(serveurFiche(fiche({ geometrieMasquee: true }))));
    expect(f.geom).toBeNull();
    expect(f.geometrieMasquee).toBe(true);
  });
  it("couts : estime et reel sont DISTINCTS ; une chaine decimale est lue ; un cout absent est null, jamais 0 ; rien n'est somme", () => {
    const f = lireFicheConflit(brut(serveurFiche(fiche({ decisions: [decision({ id: "d1", coutEstime: 1000, coutReel: 0 }), decision({ id: "d2", coutEstime: null, coutReel: null })] }))));
    expect(f.decisions[0]).toMatchObject({ coutEstime: 1000, coutReel: 0 });
    expect(f.decisions[1]).toMatchObject({ coutEstime: null, coutReel: null });
    const s = brut(serveurFiche(fiche())) as { decisions: unknown[] };
    s.decisions = [{ id: "d9", option: "A_ETUDIER", statut: "PROPOSEE", coutEstime: "12500.50", coutReel: "" }];
    const d = lireFicheConflit(s).decisions[0];
    expect(d.coutEstime).toBe(12500.5);
    expect(d.coutReel).toBeNull();
    expect(Object.keys(d)).not.toContain("coutTotal");
  });
  it("ignore une decision ou une preuve d'etat inconnu plutot que d'inventer un etat", () => {
    const s = brut(serveurFiche(fiche())) as { decisions: unknown[]; preuves: unknown[] };
    s.decisions = [{ id: "d", option: "EXECUTER", statut: "PROPOSEE" }, { id: "e", option: "PROTEGER", statut: "EXECUTEE" }];
    s.preuves = [{ id: "p", type: "RUMEUR", texte: "x" }];
    const f = lireFicheConflit(s);
    expect(f.decisions).toEqual([]);
    expect(f.preuves).toEqual([]);
  });
  it("transitions du serveur : { vers, preuveRequise, decisionRequise, cloture, bloquee } ; vide = aucune (lecteur) ; absent = null (affichage de secours)", () => {
    expect(lireTransitions([{ vers: "CONFIRME", justificationRequise: true, preuveRequise: true, decisionRequise: false, cloture: false, bloquee: "PREUVE_REQUISE" }, { vers: "INCONNU" }]))
      .toEqual([{ vers: "CONFIRME", preuveRequise: true, decisionRequise: false, cloture: false, bloquee: "PREUVE_REQUISE" }]);
    expect(lireTransitions([{ vers: "CLOTURE", cloture: true, bloquee: null }])).toEqual([{ vers: "CLOTURE", preuveRequise: false, decisionRequise: false, cloture: true, bloquee: null }]);
    expect(lireTransitions([{ vers: "TRAITEMENT_DECIDE", bloquee: "AUTRE_CHOSE" }])?.[0].bloquee).toBeNull();
    expect(lireTransitions(["POTENTIEL", "INCONNU"])?.map((t) => t.vers)).toEqual(["POTENTIEL"]);
    expect(lireTransitions([])).toEqual([]);
    expect(lireTransitions(undefined)).toBeNull();
    expect(lireTransitions("POTENTIEL")).toBeNull();
  });
  it("une fiche sans `transitionsPossibles` donne transitions = null ; avec une liste vide, []", () => {
    expect(lireFicheConflit(brut(serveurFiche(fiche({ transitions: null })))).transitions).toBeNull();
    expect(lireFicheConflit(brut(serveurFiche(fiche({ transitions: [] })))).transitions).toEqual([]);
  });
  it("transitionsAffichees : le serveur d'abord (meme vide), la table de secours seulement s'il est muet", () => {
    expect(transitionsAffichees({ statut: "POTENTIEL", transitions: [] }, "ADMIN")).toEqual({ liste: [], deSecours: false });
    const secours = transitionsAffichees({ statut: "POTENTIEL", transitions: null }, "GESTIONNAIRE");
    expect(secours.liste.map((t) => t.vers)).toEqual(["CONFIRME", "INFIRME", "A_INVESTIGUER"]);
    expect(secours.liste[0]).toMatchObject({ preuveRequise: true, bloquee: null });
    expect(secours.deSecours).toBe(true);
    expect(transitionsAffichees({ statut: "POTENTIEL", transitions: null }, "LECTEUR").liste).toEqual([]);
    expect(transitionsAffichees({ statut: "TRAITEMENT_DECIDE", transitions: null }, "ADMIN").liste[1]).toMatchObject({ vers: "CLOTURE", cloture: true });
    expect(transition("CONFIRME").bloquee).toBeNull();
  });
  it("une reponse inattendue LEVE (jamais une fiche vide)", () => {
    expect(() => lireFicheConflit("x")).toThrow(/Réponse inattendue/);
    expect(() => lireFicheConflit({ id: "x" })).toThrow();
    expect(() => lireFicheConflit({ conflit: { id: "x", type: "PROXIMITE", statut: "NOUVEAU" } })).toThrow();
    expect(() => lireFicheConflit(brut(serveurConflit(conflit())))).toThrow();
  });
  it("GET /:id/conflits/:cid", async () => {
    h.get.mockResolvedValueOnce({ data: brut(serveurFiche(fiche())) });
    const f = await lireConflit("p1", "cf/1");
    expect(h.get).toHaveBeenCalledWith(`${BASE}/conflits/cf%2F1`, { signal: undefined });
    expect(f.id).toBe("cf-1");
  });
});

describe("ecritures : une route par geste, corps du backend", () => {
  it("PATCH attribution : seuls les champs fournis partent, null efface (responsable, echeance, risque, action)", async () => {
    h.patch.mockResolvedValue({ data: {} });
    await attribuerConflit("p1", "cf-1", { responsableId: "u1", echeance: "2026-12-01", risque: "ELEVE", actionProposee: "Vérifier" });
    expect(h.patch).toHaveBeenCalledWith(`${BASE}/conflits/cf-1`, { responsableId: "u1", echeance: "2026-12-01", risque: "ELEVE", actionProposee: "Vérifier" });
    await attribuerConflit("p1", "cf-1", { responsableId: null, risque: null });
    expect(h.patch).toHaveBeenLastCalledWith(`${BASE}/conflits/cf-1`, { responsableId: null, risque: null });
  });
  it("PATCH d'acquittement d'un re-examen : { aReexaminer: false, justification } (seule la valeur false existe)", async () => {
    h.patch.mockResolvedValue({ data: {} });
    await acquitterReexamen("p1", "cf-1", "Réexaminé après la nouvelle analyse");
    expect(h.patch).toHaveBeenCalledWith(`${BASE}/conflits/cf-1`, { aReexaminer: false, justification: "Réexaminé après la nouvelle analyse" });
  });
  it("POST statut : { vers, justification, derogation?, recolementAValider? }", async () => {
    h.post.mockResolvedValue({ data: {} });
    await changerStatutConflit("p1", "cf-1", { vers: "CONFIRME", justification: "Preuve au dossier" });
    expect(h.post).toHaveBeenCalledWith(`${BASE}/conflits/cf-1/statut`, { vers: "CONFIRME", justification: "Preuve au dossier" });
    await changerStatutConflit("p1", "cf-1", { vers: "CLOTURE", justification: "Clos par l'administrateur", derogation: "Seul compte habilité", recolementAValider: true });
    expect(h.post).toHaveBeenLastCalledWith(`${BASE}/conflits/cf-1/statut`, { vers: "CLOTURE", justification: "Clos par l'administrateur", derogation: "Seul compte habilité", recolementAValider: true });
  });
  it("POST preuves, decisions, approuver, refuser", async () => {
    h.post.mockResolvedValue({ data: {} });
    await ajouterPreuve("p1", "cf-1", { type: "NOTE", texte: "Vu sur place", reference: "Plan 3" });
    expect(h.post).toHaveBeenLastCalledWith(`${BASE}/conflits/cf-1/preuves`, { type: "NOTE", texte: "Vu sur place", reference: "Plan 3" });
    await proposerDecision("p1", "cf-1", { option: "DEPLACER_RESEAU", justification: "Le réseau est sous la future chaussée", coutEstime: 5000, deviseCout: "GNF", coutReel: 0, dateDebutPrevue: "2027-01-10", dateFinPrevue: "2027-01-20" });
    expect(h.post).toHaveBeenLastCalledWith(`${BASE}/conflits/cf-1/decisions`, { option: "DEPLACER_RESEAU", justification: "Le réseau est sous la future chaussée", coutEstime: 5000, deviseCout: "GNF", coutReel: 0, dateDebutPrevue: "2027-01-10", dateFinPrevue: "2027-01-20" });
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
  it("lit une analyse du serveur : resume (totaux, nouveaux, retrouves, disparus...), regles, jeux, acteur, duree en ms ; refuse un statut inconnu", () => {
    const a = lireAnalyseConflit(brut(serveurAnalyse(analyseConflit())));
    expect(a).toMatchObject({ id: "an-2", numero: 2, statut: "TERMINEE", versionAlgorithme: "2D-UTM-1", dureeMs: 1840, declenchePar: { nom: "Moussa Gestionnaire" }, erreur: null });
    expect(a?.resume).toMatchObject({
      total: 4, axes: 3, jeuxReseau: 1, axesNonCouverts: 1, nouveaux: 1, retrouves: 2, identiques: 1, modifies: 1, disparus: 1, reapparus: 0, marquesAReexaminer: 2, parType: { PROXIMITE: 2 },
    });
    expect(a?.resume.limites).toHaveLength(2);
    expect(a?.regles[0]).toMatchObject({ code: "RC-2D-0.1", version: 0, portee: "GENERALE", toleranceProximiteM: 0 });
    expect(a?.jeux[0]).toMatchObject({ version: 2, role: "RESEAU_TIERS", nomFichier: "reseau-synthetique.kml", classePrecision: "B" });
    expect(lireAnalyseConflit({ id: "a", statut: "EN_COURS" })).toBeNull();
    expect(lireAnalyseConflit({ statut: "TERMINEE" })).toBeNull();
  });
  it("analyse en echec : `resume.erreur` donne la cause, aucun chiffre n'est invente", () => {
    const a = lireAnalyseConflit(brut(serveurAnalyse(analyseConflit({ statut: "ECHEC", erreur: { code: "ANALYSE_TROP_LONGUE", message: "délai dépassé" } }))));
    expect(a?.statut).toBe("ECHEC");
    expect(a?.erreur).toEqual({ code: "ANALYSE_TROP_LONGUE", message: "délai dépassé" });
    expect(a?.resume).toMatchObject({ total: 0, nouveaux: null, retrouves: null, disparus: null, limites: [] });
  });
  it("total : `totaux.conflitsTrouves`, sinon `nbConflitsTrouves` ; une valeur absente reste null", () => {
    expect(lireAnalyseConflit({ id: "a", statut: "TERMINEE", nbConflitsTrouves: 7, resume: {} })?.resume.total).toBe(7);
    expect(lireAnalyseConflit({ id: "a", statut: "TERMINEE" })?.resume).toMatchObject({ total: null, nouveaux: null, disparus: null });
  });
  it("enveloppes : la reponse de POST /analyses est { analyse, resume }, le detail { analyse }", () => {
    expect(lireAnalyseConflit(brut(serveurLancement(analyseConflit())))?.numero).toBe(2);
    expect(lireAnalyseConflit(brut(serveurDetailAnalyse(analyseConflit())))?.id).toBe("an-2");
  });
  it("page d'analyses : { analyses, curseurSuivant } ; elements illisibles ignores ; reponse inattendue LEVE", () => {
    const p = lirePageAnalyses({ analyses: [brut(serveurAnalyse(analyseConflit())), brut(serveurAnalyse(ANALYSE_1)), { id: "?" }], curseurSuivant: "n2" });
    expect(p.analyses).toHaveLength(2);
    expect(p.suivant).toBe("n2");
    expect(() => lirePageAnalyses({ x: 1 })).toThrow(/Réponse inattendue/);
  });
  it("POST /:id/analyses : corps vide", async () => {
    h.post.mockResolvedValueOnce({ data: brut(serveurLancement(analyseConflit())) });
    const r = await lancerAnalyseConflits("p1");
    expect(h.post).toHaveBeenCalledWith(`${BASE}/analyses`, {});
    expect(r.analyse?.numero).toBe(2);
    h.post.mockResolvedValueOnce({ data: {} });
    expect((await lancerAnalyseConflits("p1")).analyse).toBeNull();
  });
  it("GET analyses (curseur), analyses/:aid, comparaison?avec=", async () => {
    h.get.mockResolvedValueOnce({ data: brut(serveurListeAnalyses([ANALYSE_1])) });
    expect((await listerAnalyses("p1", null)).analyses).toHaveLength(1);
    expect(h.get).toHaveBeenLastCalledWith(`${BASE}/analyses`, { params: undefined, signal: undefined });
    h.get.mockResolvedValueOnce({ data: brut(serveurListeAnalyses([ANALYSE_1])) });
    await listerAnalyses("p1", "n2");
    expect(h.get).toHaveBeenLastCalledWith(`${BASE}/analyses`, { params: { curseur: "n2" }, signal: undefined });
    h.get.mockResolvedValueOnce({ data: brut(serveurDetailAnalyse(analyseConflit())) });
    expect((await lireDetailAnalyse("p1", "an-2")).numero).toBe(2);
    expect(h.get).toHaveBeenLastCalledWith(`${BASE}/analyses/an-2`, { signal: undefined });
    h.get.mockResolvedValueOnce({ data: brut(serveurComparaison()) });
    const c = await comparerAnalyses("p1", "an-2", "an-1");
    expect(h.get).toHaveBeenLastCalledWith(`${BASE}/analyses/an-2/comparaison`, { params: { avec: "an-1" }, signal: undefined });
    expect(c.apparus.nb).toBe(1);
  });
  it("lecture de detail inexploitable : LEVE", async () => {
    h.get.mockResolvedValueOnce({ data: { analyse: { id: "a", statut: "BIZARRE" } } });
    await expect(lireDetailAnalyse("p1", "a")).rejects.toThrow(/Réponse inattendue/);
  });
});

describe("comparaison de deux analyses", () => {
  it("lit reference, comparee, et chaque categorie { nb, cles, conflits (axe, type, statut), detailsTronques }", () => {
    const c = lireComparaison(brut(serveurComparaison()));
    expect(c.reference).toEqual({ id: "an-1", numero: 1 });
    expect(c.comparee).toEqual({ id: "an-2", numero: 2 });
    expect(c.apparus).toEqual({ nb: 1, cles: ["cle-bbbb"], conflits: [{ id: "cf-2", cle: "cle-bbbb", type: "PROXIMITE", axe: "Axe B", statut: "A_INVESTIGUER", aReexaminer: false }], detailsTronques: false });
    expect(c.disparus.conflits[0]).toMatchObject({ id: "cf-4", aReexaminer: true });
    expect(c.identiques).toMatchObject({ nb: 2, cles: ["k1", "k2"], conflits: [] });
  });
  it("detail tronque : le drapeau est lu, le nombre reste celui du serveur", () => {
    const c = lireComparaison(brut(serveurComparaison({ apparus: { nb: 1500, cles: [], conflits: [], detailsTronques: true } })));
    expect(c.apparus).toMatchObject({ nb: 1500, detailsTronques: true });
  });
  it("une reponse qui n'a pas les quatre categories LEVE : jamais « aucune difference »", () => {
    expect(() => lireComparaison({})).toThrow(/Réponse inattendue/);
    expect(() => lireComparaison({ apparus: { nb: 1, cles: [] } })).toThrow();
    expect(() => lireComparaison(null)).toThrow();
    expect(() => lireComparaison({ apparus: 1, disparus: 1, modifies: 1, identiques: 1 })).toThrow();
  });
});

describe("regles", () => {
  it("lit une regle du serveur (portee, systeme, motif et derogation d'approbation) ; refuse un statut inconnu", () => {
    const r = lireRegle(brut(serveurRegle(REGLES[1])));
    expect(r).toMatchObject({
      code: "RC-TEL", version: 1, portee: "PROJET", famille: "TELECOM", toleranceProximiteM: 2, margeIncertitude: 1.5, statut: "APPROUVEE", systeme: false,
      creePar: { nom: "Moussa Gestionnaire" }, approuvePar: { nom: "Fatou Admin" }, motifApprobation: "Validée avec la direction", derogationApprobation: null,
    });
    expect(lireRegle({ id: "r", code: "X", statut: "ACTIVE" })).toBeNull();
    expect(lireRegle({ code: "X", statut: "BROUILLON" })).toBeNull();
  });
  it("la regle par defaut (version 0, tolerance 0) garde son zero, sans seuil invente ; creee par le systeme", () => {
    const r = lireRegle(brut(serveurRegle(regle())));
    expect(r).toMatchObject({ version: 0, toleranceProximiteM: 0, famille: null, systeme: true, portee: "GENERALE", creePar: null });
    expect(lireRegle({ id: "r", code: "X", statut: "BROUILLON" })?.toleranceProximiteM).toBeNull();
  });
  it("liste : { regles, effectives }, elements illisibles comptes, reponse inattendue LEVE", () => {
    const l = lireListeRegles(brut({ ...serveurRegles(REGLES), regles: [...serveurRegles(REGLES).regles, { id: "x" }] }));
    expect(l.regles).toHaveLength(3);
    expect(l.ignores).toBe(1);
    expect(l.effectives).toHaveLength(6);
    expect(l.effectives.find((e) => e.famille === "TELECOM")).toMatchObject({ code: "RC-TEL", version: 1, portee: "PROJET", toleranceProximiteM: 2 });
    expect(l.effectives.find((e) => e.famille === "EAU_POTABLE")).toMatchObject({ code: "RC-2D-0.1", version: 0, portee: "GENERALE" });
    expect(() => lireListeRegles({})).toThrow(/Réponse inattendue/);
  });
  it("GET /regles, POST /regles, POST /regles/:id/approuver", async () => {
    h.get.mockResolvedValueOnce({ data: brut(serveurRegles(REGLES)) });
    expect((await listerRegles("p1")).regles).toHaveLength(3);
    expect(h.get).toHaveBeenLastCalledWith(`${BASE}/regles`, { signal: undefined });
    h.post.mockResolvedValue({ data: {} });
    await creerRegle("p1", { famille: "TELECOM", code: "RC-TEL", toleranceProximiteM: 2, margeIncertitude: 1, justification: "Tolérance convenue" });
    expect(h.post).toHaveBeenLastCalledWith(`${BASE}/regles`, { famille: "TELECOM", code: "RC-TEL", toleranceProximiteM: 2, margeIncertitude: 1, justification: "Tolérance convenue" });
    await approuverRegle("p1", "rg/2", { justification: "Approuvée par la direction", derogation: "Auteur unique disponible" });
    expect(h.post).toHaveBeenLastCalledWith(`${BASE}/regles/rg%2F2/approuver`, { justification: "Approuvée par la direction", derogation: "Auteur unique disponible" });
  });
});

describe("export CSV", () => {
  it("adresse authentifiee par l'API ; les filtres de la liste sont transmis (le backend les accepte), sans curseur ni tri ; aucune geometrie", async () => {
    expect(urlExportConflits("p1")).toBe(`${BASE}/conflits/export.csv`);
    expect(urlExportConflits("p1", FILTRES_VIDES)).toBe(`${BASE}/conflits/export.csv`);
    expect(urlExportConflits("p1", { ...FILTRES_VIDES, statut: "CONFIRME", aReexaminer: true, tri: "risque" })).toBe(`${BASE}/conflits/export.csv?statut=CONFIRME&aReexaminer=true`);
    h.download.mockResolvedValueOnce(undefined);
    await exporterConflitsCsv("p1", "KISSI VOIRIE/2026");
    expect(h.download).toHaveBeenCalledWith(`${BASE}/conflits/export.csv`, "KISSI_VOIRIE_2026-dossiers-de-conflit.csv");
  });
});

describe("contre-epreuve : un conflit infirme reste un conflit lu comme tel", () => {
  it("le statut INFIRME n'est pas confondu avec l'absence de conflit", () => {
    expect(lireConflitResume(brut(serveurConflit(conflit({ statut: "INFIRME" }))))?.statut).toBe("INFIRME");
    expect(lireConflitResume(brut(serveurConflit(CONFLIT_INVESTIGUER)))?.statut).toBe("A_INVESTIGUER");
  });
});
