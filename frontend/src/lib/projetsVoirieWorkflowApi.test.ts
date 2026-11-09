import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("./api", () => ({ api: { get: h.get, post: h.post, put: h.put, patch: h.patch, delete: h.delete } }));

import {
  ajouterPreuveWorkflow, changerStatutDemande, changerStatutRecolement, changerStatutTache, creerDemande, creerRattachement, creerRecolement, creerTache, lireComptes, lireDemande, lireFicheDemande,
  lireFicheRecolement, lireFicheTache, lireJeuxVue, lireListeReferents, lireMonProfil, lirePageConflitsVue, lirePageDemandes, lirePageRecolements, lirePageTaches, lirePreuveWorkflow, lireProfilWorkflow,
  lireRecolement, lireTache, listerConflitsVue, listerDemandes, listerJeuxVue, listerRecolements, listerReferents, listerTaches, lireDemandeFiche, lireRecolementFiche, lireTacheFiche,
  modifierDemande, modifierRecolement, modifierTache, listerComptesLecteurs, revoquerRattachement, compteSansCle, filtrerComptes, lireHistoriqueWorkflow, lireListeComptes, lirePreuves,
} from "./projetsVoirieWorkflowApi";
import { FILTRES_DEMANDES_VIDES, FILTRES_RECOLEMENTS_VIDES, FILTRES_TACHES_VIDES } from "./projetsVoirieWorkflow";
import {
  CF1, CONC_A, D1, J1, R1, T1, conflitVueServeur, demandeEnvoyee, demandeRecue, demandeServeur, ficheDemandeServeur, ficheRecolementServeur, ficheTacheServeur, historiqueModification,
  historiqueServeur, jeuVueServeur, pageServeur, preuveServeur, profilServeur, rattachementServeur, recolementServeur, tacheServeur, transRec, transTache, U_REF,
} from "../components/projets-voirie/workflow/workflowSynthetiques.testutil";

/**
 * Client du workflow (lot B3) : chaque route, la forme des requetes (URL, parametres, corps) et les lecteurs de reponse, exerces sur le JSON tel que le BACKEND le
 * rend (fixtures alignees sur docs/projets-voirie/API.md). Lecteurs TOLERANTS : champs masques (interlocuteur, auteurs, motifs, historique) restent nuls, jamais « aucun ».
 */

beforeEach(() => { for (const f of Object.values(h)) f.mockReset(); });
const W = "/v2/projets-voirie/p1/workflow";
const brut = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("lecteur du profil de workflow", () => {
  it("un gestionnaire : droits renvoyes, pas de rattachement, mention provisoire", () => {
    const p = lireProfilWorkflow(brut(profilServeur("GESTIONNAIRE")));
    expect(p).toMatchObject({ role: "GESTIONNAIRE", profil: "GESTIONNAIRE", referent: false, rattachements: [], provisoire: true });
    expect(p.droits).toContain("demande.ecrire");
    expect(p.droits).not.toContain("recolement.valider");
    expect(p.droits).not.toContain("referent.gerer");
    expect(p.socle[0]).toMatchObject({ acte: "Autoriser ou rejeter un jeu", roles: ["ADMIN", "GESTIONNAIRE"] });
    expect(p.correspondance[0].roleCahier).toBe("Referent concessionnaire");
  });
  it("un referent : profil REFERENT, role LECTEUR, rattachements avec projet et concessionnaire", () => {
    const p = lireProfilWorkflow(brut(profilServeur("REFERENT")));
    expect(p).toMatchObject({ role: "LECTEUR", profil: "REFERENT", referent: true });
    expect(p.rattachements).toEqual([{ id: "ra000001-0000-4000-8000-000000000001", projet: { id: "p1", code: "VOIRIE-SYNTH-2026", nom: "Voirie synthetique" }, concessionnaire: { id: CONC_A, nom: "Operateur synthetique A" } }]);
    expect(p.droits).toEqual(["workflow.lire", "tache.executer", "preuve.ajouter"]);
  });
  it("un lecteur n'a aucun droit ; une action inconnue de cette version est ecartee, jamais supposee permise", () => {
    expect(lireProfilWorkflow(brut(profilServeur("LECTEUR"))).droits).toEqual([]);
    expect(lireProfilWorkflow({ ...profilServeur("ADMIN"), droits: ["workflow.lire", "tout.faire"] }).droits).toEqual(["workflow.lire"]);
  });
  it("un profil inconnu reste nul ; une reponse sans droits leve une erreur de reponse inattendue", () => {
    expect(lireProfilWorkflow({ ...profilServeur("ADMIN"), profil: "SUPERVISEUR" }).profil).toBeNull();
    expect(() => lireProfilWorkflow({ role: "ADMIN" })).toThrow(/Réponse inattendue/);
    expect(() => lireProfilWorkflow(null)).toThrow(/Réponse inattendue/);
  });
  it("un rattachement dont le projet est masque n'est pas rendu", () => {
    const p = lireProfilWorkflow({ ...profilServeur("REFERENT"), rattachements: [{ id: "x", projet: null, concessionnaire: { id: CONC_A, nom: "A" } }, { id: "y", projet: { id: "p2", code: "P2", nom: "Deux" }, concessionnaire: { id: CONC_A, nom: "A" } }] });
    expect(p.rattachements.map((r) => r.id)).toEqual(["y"]);
  });
});

describe("lecteur d'une demande", () => {
  it("un brouillon : ni envoi, ni reception, ni fin", () => {
    const d = lireDemande(brut(demandeServeur()));
    expect(d).toMatchObject({ id: D1, statut: "BROUILLON", objet: "Plan des fourreaux de la rue 12", echeance: "2099-12-31", echeanceDepassee: false, envoi: null, reception: null, fin: null });
    expect(d?.concessionnaire).toEqual({ id: CONC_A, nom: "Operateur synthetique A" });
    expect(d?.creePar).toEqual({ id: expect.any(String), nom: "Moussa Gestionnaire" });
  });
  it("un envoi ENREGISTRE (hors application) : date, canal, reference, interlocuteur, enregistre par", () => {
    const d = lireDemande(brut(demandeEnvoyee()));
    expect(d?.envoi).toMatchObject({ dateEnvoi: "2026-11-03", canal: "Courriel", reference: "COUR-2026-41", interlocuteur: "Service reseaux", enregistrePar: { nom: "Moussa Gestionnaire" } });
  });
  it("une reception avec un jeu lie ; un jeu masque est dit masque, pas absent", () => {
    const d = lireDemande(brut(demandeRecue()));
    expect(d?.reception).toMatchObject({ dateReception: "2026-11-05", jeu: { id: J1, version: 1, nomFichier: "reponse-synthetique.geojson", statut: "CONTROLE" }, jeuMasque: false });
    const m = lireDemande(brut(demandeRecue({ reception: { dateReception: "2026-11-05", enregistrePar: null, enregistreLe: null, jeu: null, jeuMasque: true } })));
    expect(m?.reception).toMatchObject({ jeu: null, jeuMasque: true, enregistrePar: null });
  });
  it("vue d'un referent : interlocuteur, auteurs et motif de fin masques restent NULS (jamais « aucun »)", () => {
    const d = lireDemande(brut(demandeEnvoyee({ creePar: null, envoi: { dateEnvoi: "2026-11-03", canal: "Courriel", reference: null, interlocuteur: null, enregistrePar: null, enregistreLe: "2026-11-03T09:00:00.000Z" }, fin: { type: "CLOTUREE", le: "2026-11-09T09:00:00.000Z", par: null, motif: null } })));
    expect(d?.creePar).toBeNull();
    expect(d?.envoi).toMatchObject({ interlocuteur: null, enregistrePar: null, reference: null });
    expect(d?.fin).toMatchObject({ type: "CLOTUREE", par: null, motif: null });
  });
  it("statut inconnu ou objet absent : la demande n'est pas rendue et est comptee", () => {
    expect(lireDemande({ ...demandeServeur(), statut: "ARCHIVEE" })).toBeNull();
    expect(lireDemande({ ...demandeServeur(), objet: "" })).toBeNull();
    const p = lirePageDemandes(brut(pageServeur("demandes", [demandeServeur(), { ...demandeServeur(), statut: "ARCHIVEE" }], { BROUILLON: 1, ENVOYEE: 0 }, "c-2")));
    expect(p.demandes).toHaveLength(1);
    expect(p.ignores).toBe(1);
    expect(p.suivant).toBe("c-2");
    expect(p.compteurs).toEqual({ BROUILLON: 1, ENVOYEE: 0 });
  });
  it("sans compteurs, ils sont nuls (jamais des zeros)", () => {
    expect(lirePageDemandes(brut(pageServeur("demandes", [], null))).compteurs).toBeNull();
    expect(() => lirePageDemandes({})).toThrow(/Réponse inattendue/);
  });
  it("fiche : transitions du serveur (liste de statuts), preuves, historique seulement s'il est envoye", () => {
    const f = lireFicheDemande(brut(ficheDemandeServeur(demandeEnvoyee(), ["RECUE", "CLOTUREE", "ANNULEE", "INCONNU"], [preuveServeur()], [historiqueServeur()])));
    expect(f.transitions).toEqual(["RECUE", "CLOTUREE", "ANNULEE"]);
    expect(f.preuves).toHaveLength(1);
    expect(f.historique).toHaveLength(1);
    expect(f).toMatchObject({ preuvesIgnorees: 0, historiqueIgnores: 0 });
    const referent = lireFicheDemande(brut(ficheDemandeServeur(demandeEnvoyee(), [], [])));
    expect(referent.historique).toBeNull();
    expect(referent.historiqueIgnores).toBe(0);
    expect(referent.transitions).toEqual([]);
    expect(lireFicheDemande({ demande: demandeServeur(), preuves: [] }).transitions).toBeNull();
    expect(() => lireFicheDemande({})).toThrow(/Réponse inattendue/);
  });
});

describe("lecteur d'une tache", () => {
  it("lit les transitions du serveur avec justification et separation", () => {
    const t = lireTache(brut(tacheServeur({ transitionsPossibles: [transTache("EN_COURS", false), transTache("TERMINEE", true, true)] })));
    expect(t).toMatchObject({ id: T1, statut: "A_FAIRE", priorite: "NORMALE", validationRequise: true, responsableEstMoi: true, partagee: false });
    expect(t?.transitions).toEqual([{ vers: "EN_COURS", justificationRequise: false, separation: false }, { vers: "TERMINEE", justificationRequise: true, separation: true }]);
  });
  it("sans transitionsPossibles : null (aucune action n'est proposee) ; liste vide : aucune action ; statut inconnu ecarte", () => {
    expect(lireTache({ ...brut(tacheServeur()), transitionsPossibles: undefined })?.transitions).toBeNull();
    expect(lireTache(brut(tacheServeur({ transitionsPossibles: [] })))?.transitions).toEqual([]);
    expect(lireTache(brut(tacheServeur({ transitionsPossibles: [transTache("DETRUITE")] })))?.transitions).toEqual([]);
    expect(lireTache({ ...brut(tacheServeur()), statut: "SUSPENDUE" })).toBeNull();
  });
  it("sans precision, la justification est exigee : le cas prudent", () => {
    expect(lireTache(brut(tacheServeur({ transitionsPossibles: [{ vers: "ANNULEE" }, "EN_COURS"] })))?.transitions).toEqual([{ vers: "ANNULEE", justificationRequise: true, separation: false }, { vers: "EN_COURS", justificationRequise: true, separation: false }]);
  });
  it("responsable masque : nul, jamais « aucun responsable »", () => {
    expect(lireTache(brut(tacheServeur({ responsable: null, responsableEstMoi: false })))).toMatchObject({ responsable: null, responsableEstMoi: false });
  });
  it("page et fiche", () => {
    const p = lirePageTaches(brut(pageServeur("taches", [tacheServeur(), { statut: "ALIEN" }], { A_FAIRE: 1 })));
    expect(p).toMatchObject({ ignores: 1, compteurs: { A_FAIRE: 1 } });
    const f = lireFicheTache(brut(ficheTacheServeur(tacheServeur(), [preuveServeur()], [historiqueServeur()])));
    expect(f.tache.id).toBe(T1);
    expect(f.historique).toHaveLength(1);
    expect(() => lireFicheTache({})).toThrow(/Réponse inattendue/);
  });
});

describe("lecteur d'un recolement", () => {
  it("lie a un dossier de conflit : type, axe, statut ; transitions {vers, droit}", () => {
    const r = lireRecolement(brut(recolementServeur({ transitionsPossibles: [transRec("SOUMIS"), transRec("VALIDE", "VALIDER")] })));
    expect(r).toMatchObject({ id: R1, statut: "BROUILLON", revision: 1, objet: "Recolement du deplacement de la fibre FO-01", constat: "Fibre deplacee de 3 m hors chaussee", ecarts: "Ecart de 0,4 m par rapport au plan", jeu: null, jeuMasque: false });
    expect(r?.conflit).toEqual({ id: CF1, type: "INTERSECTION_CHAUSSEE", axe: "Axe A", statut: "TRAITEMENT_DECIDE" });
    expect(r?.transitions).toEqual([{ vers: "SOUMIS", droit: "ECRIRE" }, { vers: "VALIDE", droit: "VALIDER" }]);
  });
  it("lie a un jeu ; jeu masque dit masque ; soumission et decision avec valideur et derogation", () => {
    const r = lireRecolement(brut(recolementServeur({
      conflit: null, jeu: { id: J1, version: 2, nomFichier: "plan-recolement.geojson", statut: "AUTORISE", role: "RESEAU_TIERS" }, statut: "VALIDE",
      soumission: { le: "2026-11-05T09:00:00.000Z", par: { id: "u", nomComplet: "Moussa Gestionnaire" } },
      decision: { le: "2026-11-06T09:00:00.000Z", par: { id: "a", nomComplet: "Fatou Admin" }, motif: "Plan conforme", derogationSeparation: null }, transitionsPossibles: [],
    })));
    expect(r).toMatchObject({ conflit: null, jeu: { nomFichier: "plan-recolement.geojson", statut: "AUTORISE" }, soumission: { par: { nom: "Moussa Gestionnaire" } }, decision: { motif: "Plan conforme", derogationSeparation: null, par: { nom: "Fatou Admin" } }, transitions: [] });
    expect(lireRecolement(brut(recolementServeur({ jeu: null, jeuMasque: true })))?.jeuMasque).toBe(true);
  });
  it("vue d'un referent : motif, valideur et soumetteur masques restent nuls", () => {
    const r = lireRecolement(brut(recolementServeur({ statut: "REJETE", soumission: { le: "2026-11-05T09:00:00.000Z", par: null }, decision: { le: "2026-11-06T09:00:00.000Z", par: null, motif: null, derogationSeparation: null } })));
    expect(r?.soumission).toEqual({ le: "2026-11-05T09:00:00.000Z", par: null });
    expect(r?.decision).toMatchObject({ par: null, motif: null });
  });
  it("statut inconnu : non rendu et compte ; page ; fiche avec historique avant et apres", () => {
    expect(lireRecolement({ ...brut(recolementServeur()), statut: "ARCHIVE" })).toBeNull();
    const p = lirePageRecolements(brut(pageServeur("recolements", [recolementServeur(), { statut: "ALIEN" }], { BROUILLON: 1, SOUMIS: 0 })));
    expect(p).toMatchObject({ ignores: 1, compteurs: { BROUILLON: 1, SOUMIS: 0 } });
    const f = lireFicheRecolement(brut(ficheRecolementServeur(recolementServeur(), [preuveServeur()], [historiqueServeur(), historiqueModification()])));
    expect(f.historique).toHaveLength(2);
    const m = f.historique?.[1];
    expect(m).toMatchObject({ action: "MODIFICATION", justification: "Correction de l'ecart apres le releve du 06/11" });
    expect(m?.avant).toEqual({ ecarts: "Ecart de 1,2 m", constat: null });
    expect(m?.apres).toEqual({ ecarts: "Ecart de 0,4 m par rapport au plan", constat: "Fibre deplacee de 3 m hors chaussee" });
    expect(() => lireFicheRecolement({})).toThrow(/Réponse inattendue/);
  });
});

describe("lecteur d'une preuve, de l'historique, des referents, des jeux et des dossiers", () => {
  it("une preuve : reference, nom, empreinte, taille declaree ; jamais de contenu de fichier", () => {
    const p = lirePreuveWorkflow(brut(preuveServeur()));
    expect(p).toMatchObject({ type: "PLAN_RECOLEMENT", reference: "ARCH-12 / javascript-non", nomFichier: "recolement-fo01.pdf", sha256: "ab".repeat(32), tailleOctets: 204800, partagee: true, auteurProfil: "GESTIONNAIRE" });
    expect(Object.keys(p ?? {})).not.toContain("contenu");
    expect(lirePreuveWorkflow({ ...preuveServeur(), type: "VIDEO" })).toBeNull();
    expect(lirePreuveWorkflow({ ...preuveServeur(), texte: "" })).toBeNull();
    expect(lirePreuveWorkflow(brut(preuveServeur({ auteur: null })))?.auteur).toBeNull();
  });
  it("u2 : une preuve ou une entree d'historique illisible est ECARTEE ET COMPTEE (jamais tue), dans la fiche aussi", () => {
    const p = lirePreuves(brut([preuveServeur(), { ...preuveServeur({ id: "00000000-0000-4000-8000-000000000099" }), type: "VIDEO" }, "n'importe quoi", null]));
    expect(p.preuves).toHaveLength(1);
    expect(p.ignores).toBe(3);
    expect(lirePreuves(undefined)).toEqual({ preuves: [], ignores: 0 });
    const hi = lireHistoriqueWorkflow(brut([historiqueServeur(), { action: "SANS_ID" }, { id: "00000000-0000-4000-8000-000000000098" }, 42]));
    expect(hi.historique).toHaveLength(1);
    expect(hi.ignores).toBe(3);
    expect(lireHistoriqueWorkflow(undefined)).toEqual({ historique: null, ignores: 0 });
    const f = lireFicheDemande(brut(ficheDemandeServeur(demandeEnvoyee(), [], [preuveServeur(), { type: "VIDEO" }], [historiqueServeur(), {}])));
    expect(f).toMatchObject({ preuvesIgnorees: 1, historiqueIgnores: 1 });
    expect(lireFicheTache(brut(ficheTacheServeur(tacheServeur(), [{}], [{}, {}])))).toMatchObject({ preuvesIgnorees: 1, historiqueIgnores: 2 });
    expect(lireFicheRecolement(brut(ficheRecolementServeur(recolementServeur(), [{}], [])))).toMatchObject({ preuvesIgnorees: 1, historiqueIgnores: 0 });
  });
  it("un rattachement actif et un rattachement revoque", () => {
    const l = lireListeReferents(brut({ rattachements: [rattachementServeur(), rattachementServeur({ id: "ra000002-0000-4000-8000-000000000002", actif: false, revocation: { le: "2026-11-09T08:00:00.000Z", par: { id: "a", nomComplet: "Fatou Admin" }, motif: "Fin de mission du referent" } }), { id: "" }] }));
    expect(l.rattachements).toHaveLength(2);
    expect(l.ignores).toBe(1);
    expect(l.rattachements[0]).toMatchObject({ actif: true, revocation: null, motif: "Referent designe par le concessionnaire", compte: { nom: "Ibrahima Referent" }, concessionnaire: { nom: "Operateur synthetique A" } });
    expect(l.rattachements[1]).toMatchObject({ actif: false, revocation: { motif: "Fin de mission du referent", par: { nom: "Fatou Admin" } } });
  });
  it("jeux : metadonnees seules (aucune geometrie, empreinte ni auteur)", () => {
    const j = lireJeuxVue(brut({ jeux: [jeuVueServeur()] }));
    expect(j[0]).toMatchObject({ id: J1, nomFichier: "reponse-synthetique.geojson", version: 1, nbObjets: 8, classePrecision: null, statut: "CONTROLE" });
    expect(Object.keys(j[0])).not.toEqual(expect.arrayContaining(["geometrie", "sha256", "auteur"]));
    expect(() => lireJeuxVue({})).toThrow(/Réponse inattendue/);
  });
  it("dossiers (vue concessionnaire) : sans geometrie, sans mesure, sans cout ; statut ou type inconnu non rendu et compte", () => {
    const p = lirePageConflitsVue(brut({ conflits: [conflitVueServeur(), { id: "x", type: "NOUVEAU", statut: "CLOTURE" }], curseurSuivant: "s" }));
    expect(p.conflits).toHaveLength(1);
    expect(p.ignores).toBe(1);
    expect(p.suivant).toBe("s");
    expect(p.conflits[0]).toMatchObject({ id: CF1, type: "INTERSECTION_CHAUSSEE", statut: "TRAITEMENT_DECIDE", objet: "Fibre FO-01", decisionRetenue: { option: "DEPLACER_RESEAU", dateDebutPrevue: "2027-01-10", dateFinPrevue: "2027-01-20" } });
    expect(JSON.stringify(p)).not.toMatch(/coordinates|mesure|cout|justification/i);
    expect(lirePageConflitsVue(brut({ conflits: [conflitVueServeur({ decisionRetenue: null })] })).conflits[0].decisionRetenue).toBeNull();
  });
  it("comptes de la page Utilisateurs : identifiant, nom, courriel, cles de module (nulles si absentes), total de la page", () => {
    expect(lireComptes({ data: [{ id: U_REF, nomComplet: "Ibrahima Referent", email: "i@example.test", role: "LECTEUR" }, { nomComplet: "sans id" }], total: 1 })).toEqual([{ id: U_REF, nom: "Ibrahima Referent", email: "i@example.test", modules: null }]);
    expect(lireComptes({ data: [{ id: U_REF, nomComplet: "x", email: null, modulesAutorises: ["projets-voirie", 3, "troncons"] }] })[0].modules).toEqual(["projets-voirie", "troncons"]);
    expect(() => lireComptes({})).toThrow(/Réponse inattendue/);
    expect(lireListeComptes({ data: [], total: 230 })).toEqual({ comptes: [], total: 230 });
    expect(lireListeComptes([]).total).toBeNull();
  });
  it("u1 : un compte sans la cle de module n'est pas proposable (le serveur repondrait 422 COMPTE_SANS_MODULE) ; cles inconnues du serveur : propose, le serveur tranche", () => {
    expect(compteSansCle({ id: U_REF, nom: null, email: null, modules: ["troncons"] })).toBe(true);
    expect(compteSansCle({ id: U_REF, nom: null, email: null, modules: [] })).toBe(true);
    expect(compteSansCle({ id: U_REF, nom: null, email: null, modules: ["projets-voirie"] })).toBe(false);
    expect(compteSansCle({ id: U_REF, nom: null, email: null, modules: null })).toBe(false);
  });
  it("u1 : la recherche est faite COTE CLIENT (nom ou courriel, sans accents ni casse), la saisie ne part jamais dans une requete", () => {
    const c = (nom: string | null, email: string | null) => ({ id: U_REF, nom, email, modules: null });
    const liste = [c("Ibrahima Référent", "ibrahima@example.test"), c("Fanta Diallo", "fanta@example.test"), c(null, "sans-nom@example.test")];
    expect(filtrerComptes(liste, " refer ").map((x) => x.nom)).toEqual(["Ibrahima Référent"]);
    expect(filtrerComptes(liste, "FANTA@").map((x) => x.nom)).toEqual(["Fanta Diallo"]);
    expect(filtrerComptes(liste, "sans-nom")).toHaveLength(1);
    expect(filtrerComptes(liste, "")).toHaveLength(3);
    expect(filtrerComptes(liste, "zzz")).toEqual([]);
  });
});

describe("appels : URL, parametres et corps", () => {
  it("GET mon-profil", async () => {
    h.get.mockResolvedValue({ data: brut(profilServeur("ADMIN")) });
    expect((await lireMonProfil()).droits).toHaveLength(9);
    expect(h.get).toHaveBeenCalledWith("/v2/projets-voirie/workflow/mon-profil", { signal: undefined });
  });
  it("GET demandes, taches, recolements : filtres valides et curseur", async () => {
    h.get.mockResolvedValue({ data: brut(pageServeur("demandes", [], null)) });
    await listerDemandes("p1", { ...FILTRES_DEMANDES_VIDES, statut: "ENVOYEE", echeanceDepassee: true }, "c1");
    expect(h.get).toHaveBeenLastCalledWith(`${W}/demandes`, { params: { limite: 25, statut: "ENVOYEE", echeanceDepassee: "true", curseur: "c1" }, signal: undefined });
    h.get.mockResolvedValue({ data: brut(pageServeur("taches", [], null)) });
    await listerTaches("p1", { ...FILTRES_TACHES_VIDES, statut: "A_VALIDER" }, null);
    expect(h.get).toHaveBeenLastCalledWith(`${W}/taches`, { params: { limite: 25, statut: "A_VALIDER" }, signal: undefined });
    h.get.mockResolvedValue({ data: brut(pageServeur("recolements", [], null)) });
    await listerRecolements("p1", { ...FILTRES_RECOLEMENTS_VIDES, statut: "SOUMIS" }, null);
    expect(h.get).toHaveBeenLastCalledWith(`${W}/recolements`, { params: { limite: 25, statut: "SOUMIS" }, signal: undefined });
  });
  it("GET fiches", async () => {
    h.get.mockResolvedValueOnce({ data: brut(ficheDemandeServeur(demandeServeur(), ["ENVOYEE"])) });
    await lireDemandeFiche("p1", D1);
    expect(h.get).toHaveBeenLastCalledWith(`${W}/demandes/${D1}`, { signal: undefined });
    h.get.mockResolvedValueOnce({ data: brut(ficheTacheServeur(tacheServeur())) });
    await lireTacheFiche("p1", T1);
    expect(h.get).toHaveBeenLastCalledWith(`${W}/taches/${T1}`, { signal: undefined });
    h.get.mockResolvedValueOnce({ data: brut(ficheRecolementServeur(recolementServeur())) });
    await lireRecolementFiche("p1", R1);
    expect(h.get).toHaveBeenLastCalledWith(`${W}/recolements/${R1}`, { signal: undefined });
  });
  it("POST demande (brouillon), PATCH demande", async () => {
    h.post.mockResolvedValue({ data: {} }); h.patch.mockResolvedValue({ data: {} });
    await creerDemande("p1", { concessionnaireId: CONC_A, objet: "Plan", description: null, echeance: null });
    expect(h.post).toHaveBeenLastCalledWith(`${W}/demandes`, { concessionnaireId: CONC_A, objet: "Plan", description: null, echeance: null });
    await modifierDemande("p1", D1, { echeance: "2027-01-01", justification: "Report accorde par le concessionnaire" });
    expect(h.patch).toHaveBeenLastCalledWith(`${W}/demandes/${D1}`, { echeance: "2027-01-01", justification: "Report accorde par le concessionnaire" });
  });
  it("POST statut d'une demande : ENVOYEE enregistre canal, date, reference, interlocuteur ; RECUE ; CLOTUREE", async () => {
    h.post.mockResolvedValue({ data: {} });
    await changerStatutDemande("p1", D1, { vers: "ENVOYEE", canalEnvoi: "Courriel", dateEnvoi: "2026-11-03", referenceEnvoi: "COUR-41", interlocuteur: null });
    expect(h.post).toHaveBeenLastCalledWith(`${W}/demandes/${D1}/statut`, { vers: "ENVOYEE", canalEnvoi: "Courriel", dateEnvoi: "2026-11-03", referenceEnvoi: "COUR-41", interlocuteur: null });
    await changerStatutDemande("p1", D1, { vers: "RECUE", dateReception: "2026-11-05", jeuRecuId: J1, note: null });
    expect(h.post).toHaveBeenLastCalledWith(`${W}/demandes/${D1}/statut`, { vers: "RECUE", dateReception: "2026-11-05", jeuRecuId: J1, note: null });
    await changerStatutDemande("p1", D1, { vers: "CLOTUREE", justification: "Aucune reponse apres relance" });
    expect(h.post).toHaveBeenLastCalledWith(`${W}/demandes/${D1}/statut`, { vers: "CLOTUREE", justification: "Aucune reponse apres relance" });
  });
  it("taches : creation, modification, statut avec derogation", async () => {
    h.post.mockResolvedValue({ data: {} }); h.patch.mockResolvedValue({ data: {} });
    const c = { titre: "Verifier", description: null, responsableId: U_REF, echeance: null, priorite: "HAUTE" as const, validationRequise: true, conflitId: null, demandeId: D1, partagee: true };
    await creerTache("p1", c);
    expect(h.post).toHaveBeenLastCalledWith(`${W}/taches`, c);
    await modifierTache("p1", T1, { titre: "Verifier la gaine", responsableId: U_REF, justification: "Changement d'affectation" });
    expect(h.patch).toHaveBeenLastCalledWith(`${W}/taches/${T1}`, { titre: "Verifier la gaine", responsableId: U_REF, justification: "Changement d'affectation" });
    await changerStatutTache("p1", T1, { vers: "TERMINEE", justification: "Valide par un tiers", derogation: "Seul compte habilite" });
    expect(h.post).toHaveBeenLastCalledWith(`${W}/taches/${T1}/statut`, { vers: "TERMINEE", justification: "Valide par un tiers", derogation: "Seul compte habilite" });
  });
  it("recolements : creation, modification avec justification, statut", async () => {
    h.post.mockResolvedValue({ data: {} }); h.patch.mockResolvedValue({ data: {} });
    const c = { conflitId: CF1, jeuId: null, objet: "Recolement", constat: null, ecarts: null, dateRecolement: null };
    await creerRecolement("p1", c);
    expect(h.post).toHaveBeenLastCalledWith(`${W}/recolements`, c);
    await modifierRecolement("p1", R1, { ecarts: "Ecart de 0,4 m", justification: "Correction apres releve" });
    expect(h.patch).toHaveBeenLastCalledWith(`${W}/recolements/${R1}`, { ecarts: "Ecart de 0,4 m", justification: "Correction apres releve" });
    await changerStatutRecolement("p1", R1, { vers: "VALIDE", justification: "Plan conforme au releve", derogation: "Dernier compte habilite" });
    expect(h.post).toHaveBeenLastCalledWith(`${W}/recolements/${R1}/statut`, { vers: "VALIDE", justification: "Plan conforme au releve", derogation: "Dernier compte habilite" });
  });
  it("preuves : une URL par objet, un corps de texte et d'empreinte seulement", async () => {
    h.post.mockResolvedValue({ data: {} });
    const corps = { type: "COURRIER" as const, texte: "Courrier", reference: "C-1", nomFichier: null, sha256: null, tailleOctets: null, partagee: false };
    await ajouterPreuveWorkflow("p1", "DEMANDE", D1, corps);
    expect(h.post).toHaveBeenLastCalledWith(`${W}/demandes/${D1}/preuves`, corps);
    await ajouterPreuveWorkflow("p1", "TACHE", T1, corps);
    expect(h.post).toHaveBeenLastCalledWith(`${W}/taches/${T1}/preuves`, corps);
    await ajouterPreuveWorkflow("p1", "RECOLEMENT", R1, corps);
    expect(h.post).toHaveBeenLastCalledWith(`${W}/recolements/${R1}/preuves`, corps);
  });
  it("referents : liste, rattachement, revocation avec les avertissements du serveur", async () => {
    h.get.mockResolvedValue({ data: brut({ rattachements: [rattachementServeur()] }) });
    expect((await listerReferents("p1")).rattachements).toHaveLength(1);
    expect(h.get).toHaveBeenLastCalledWith(`${W}/referents`, { signal: undefined });
    h.post.mockResolvedValue({ data: {} });
    await creerRattachement("p1", { userId: U_REF, concessionnaireId: CONC_A, motif: "Referent designe par le concessionnaire" });
    expect(h.post).toHaveBeenLastCalledWith(`${W}/referents`, { userId: U_REF, concessionnaireId: CONC_A, motif: "Referent designe par le concessionnaire" });
    h.post.mockResolvedValue({ data: { rattachement: {}, avertissements: ["Ce compte garde la clé de module projets-voirie."] } });
    expect(await revoquerRattachement("p1", "ra1", "Fin de mission du referent")).toEqual(["Ce compte garde la clé de module projets-voirie."]);
    expect(h.post).toHaveBeenLastCalledWith(`${W}/referents/ra1/revoquer`, { motif: "Fin de mission du referent" });
    h.post.mockResolvedValue({ data: {} });
    expect(await revoquerRattachement("p1", "ra1", "Fin de mission du referent")).toEqual([]);
  });
  it("jeux et dossiers (vue concessionnaire) ; recherche de comptes lecteurs actifs", async () => {
    h.get.mockResolvedValue({ data: brut({ jeux: [jeuVueServeur()] }) });
    expect(await listerJeuxVue("p1")).toHaveLength(1);
    expect(h.get).toHaveBeenLastCalledWith(`${W}/jeux`, { signal: undefined });
    h.get.mockResolvedValue({ data: brut({ conflits: [conflitVueServeur()], curseurSuivant: null }) });
    await listerConflitsVue("p1", ["TRAITEMENT_DECIDE", "CLOTURE"], "c3");
    expect(h.get).toHaveBeenLastCalledWith(`${W}/conflits`, { params: { limite: 25, statut: "TRAITEMENT_DECIDE,CLOTURE", curseur: "c3" }, signal: undefined });
    await listerConflitsVue("p1", [], null);
    expect(h.get).toHaveBeenLastCalledWith(`${W}/conflits`, { params: { limite: 25 }, signal: undefined });
    h.get.mockResolvedValue({ data: { data: [], total: 0 } });
    expect(await listerComptesLecteurs()).toEqual({ comptes: [], total: 0 });
    // u1 : une seule page de lecteurs actifs, AUCUN terme de recherche dans les parametres (rien de saisi n'entre dans une URL ni dans les journaux du relais)
    expect(h.get).toHaveBeenLastCalledWith("/users", { params: { role: "LECTEUR", actif: "true", pageSize: 200 }, signal: undefined });
    expect(JSON.stringify(h.get.mock.calls.at(-1))).not.toMatch(/search|ibra/);
  });
});

describe("garde statique du client", () => {
  const src = readFileSync(path.resolve(__dirname, "projetsVoirieWorkflowApi.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  it("aucune route d'envoi, de message, d'ordre, de deplacement, de suppression ni de telechargement de fichier : seules les routes du lot B3", () => {
    const routes = [...src.matchAll(/`\$\{(?:BASE|W\(projetId\))\}([^`]*)`/g)].map((m) => m[1].replace(/\/\$\{id\(\w+\)\}/g, ""));
    expect(routes.length).toBeGreaterThanOrEqual(20);
    expect(routes.filter((r) => /envoyer|envoi\b|message|mail|notifier|ordre|ordonner|deplacer|executer|supprimer|fichier|upload|telecharg/i.test(r))).toEqual([]);
    expect(src).not.toMatch(/api\.delete|multipart|FormData|\/api\/public/);
  });
  it("le module n'importe aucun client de messagerie", () => {
    expect(src).not.toMatch(/nodemailer|mailto:|sendMail|navigator\.sendBeacon|XMLHttpRequest|fetch\(/);
  });
});
