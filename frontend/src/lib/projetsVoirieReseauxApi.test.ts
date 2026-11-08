import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("./api", () => ({ api: { get: h.get, post: h.post, put: h.put, patch: h.patch, delete: h.delete } }));

import {
  declarerDescripteurObjet, declarerRelationReseau, lireComptage, lireComptageReseau, lireFicheObjet, lireFicheObjetReseau, lireObjetReseau, lirePageObjetsReseau, lirePageRelationsReseau,
  lireRelationReseau, lireResultatProposition, listerObjetsReseau, listerRelationsReseau, proposerAssociationsReseau, transitionRelationReseau,
} from "./projetsVoirieReseauxApi";
import { FILTRES_OBJETS_VIDES, FILTRES_RELATIONS_VIDES, SAISIE_DESCRIPTEUR_VIDE, corpsDescripteur } from "./projetsVoirieReseaux";
import {
  JEU_RESEAU, comptageServeur, ficheObjetServeur, objetEquipement, objetInfrastructure, objetQualifie, objetServeur, pageObjetsServeur, pageRelationsServeur, relationProposee,
  relationValidee, resultatPropositionServeur, TRACE_PARTAGEE,
} from "../components/projets-voirie/reseaux/reseauxSynthetiques.testutil";

/**
 * Client des reseaux (lot B1) : chaque route de l'API, la forme des requetes (URL, parametres, corps) et les lecteurs de reponse, exerces sur le JSON tel que
 * le BACKEND le rend (fixtures alignees sur docs/projets-voirie/API.md). Lecteurs TOLERANTS : champs absents ou masques restent nuls, jamais zero.
 */

beforeEach(() => { for (const f of Object.values(h)) f.mockReset(); });
const BASE = "/v2/projets-voirie/p1/reseau";
const brut = <T,>(v: T): unknown => JSON.parse(JSON.stringify(v));

describe("lecteur d'un objet de reseau", () => {
  it("un objet SANS descripteur : nature heritee du jeu, classe non renseignee, vertical absent, profondeur et altitude nulles (jamais 0)", () => {
    const o = lireObjetReseau(brut(objetServeur()));
    expect(o).toMatchObject({
      id: "10", nom: "Fibre FO-01", nature: "CIRCUIT_LOGIQUE", origineNature: "JEU", typeObjet: null, typeGeom: "LIGNE", longueurM: 60.01, descripteur: null,
      source: { jeuId: JEU_RESEAU, version: 1, role: "RESEAU_TIERS", statut: "AUTORISE", nomFichier: "circuits-synthetiques.geojson", concessionnaire: { nom: "Operateur synthetique A" }, confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE" },
      qualite: { classePrecision: null, origineClasse: "INCONNUE", precisionHorizontaleM: null, statutQualite: "INCONNU" },
      vertical: { etat: "ABSENTE", profondeurM: null, altitudeM: null, referenceVerticale: null, evaluable: false },
    });
    expect(o?.vertical.motifs).toContain("Profondeur et altitude absentes : aucune conclusion 3D.");
  });
  it("un objet qualifie : classe declaree, profondeur fournie avec sa reference, descripteur (auteur, justification)", () => {
    const o = lireObjetReseau(brut(objetQualifie()));
    expect(o).toMatchObject({
      typeObjet: "FIBRE", origineNature: "OBJET",
      qualite: { classePrecision: "A", origineClasse: "OBJET", precisionHorizontaleM: 0.1, methodeCollecte: "GNSS RTK", dateConstat: "2026-10-01", niveauConfiance: "ELEVE", statutQualite: "OBSERVE" },
      vertical: { etat: "FOURNIE", profondeurM: 1.2, altitudeM: null, referenceVerticale: "terrain naturel", evaluable: false },
      descripteur: { justification: "Controle effectue avec le chef de projet", declarePar: "Sekou Gestionnaire", modifiePar: null },
    });
  });
  it("une classe qui n'est pas une lettre A a E (« INCONNUE », valeur inattendue) devient non renseignee : jamais inventee", () => {
    for (const c of ["INCONNUE", "Z", 3, "", null]) {
      expect(lireObjetReseau(brut(objetServeur({ qualite: { ...objetServeur().qualite, classePrecision: c } })))?.qualite.classePrecision).toBeNull();
    }
    expect(lireObjetReseau(brut(objetServeur({ qualite: { ...objetServeur().qualite, classePrecision: "E" } })))?.qualite.classePrecision).toBe("E");
  });
  it("une profondeur a zero est une valeur fournie ; une profondeur absente, masquee ou illisible reste nulle", () => {
    const v = (profondeurM: unknown) => lireObjetReseau(brut(objetServeur({ vertical: { etat: "INCOMPLETE", profondeurM, altitudeM: null, referenceVerticale: null, motifs: [], evaluable: false } })))?.vertical.profondeurM;
    expect(v(0)).toBe(0);
    expect(v("1.50")).toBe(1.5);
    expect(v(null)).toBeNull();
    expect(v(undefined)).toBeNull();
    expect(v("abc")).toBeNull();
  });
  it("champs masques ou absents : source nulle, vertical sans etat (le serveur ne le dit pas), descripteur nul", () => {
    const o = lireObjetReseau({ id: "7", nature: "INCONNUE" });
    expect(o).toMatchObject({ id: "7", nom: null, typeGeom: null, longueurM: null, source: null, origineNature: "INCONNUE", typeObjet: null, descripteur: null });
    expect(o?.vertical).toMatchObject({ etat: null, profondeurM: null, altitudeM: null, evaluable: null, motifs: [] });
    expect(o?.qualite).toMatchObject({ classePrecision: null, precisionHorizontaleM: null, niveauConfiance: null, statutQualite: null });
  });
  it("une nature inconnue de cette version ou un identifiant absent : l'objet n'est pas rendu", () => {
    expect(lireObjetReseau({ id: "7", nature: "NOUVELLE" })).toBeNull();
    expect(lireObjetReseau({ nature: "EQUIPEMENT" })).toBeNull();
    expect(lireObjetReseau("x")).toBeNull();
  });
  it("l'identifiant d'un objet (bigint rendu en texte) ou un nombre est lu comme texte", () => {
    expect(lireObjetReseau({ id: 12, nature: "EQUIPEMENT" })?.id).toBe("12");
  });
  it("l'API ne rend aucune geometrie : le modele n'en porte pas", () => {
    const o = lireObjetReseau(brut(objetServeur({ geometrie: { type: "Point", coordinates: [1, 2] }, geom: { type: "Point", coordinates: [1, 2] } })));
    expect(JSON.stringify(o)).not.toMatch(/coordinates/);
  });
});

describe("lecteur des pages", () => {
  it("la liste des objets compte, sans la masquer, ce qu'elle ne sait pas lire ; le curseur est celui du serveur", () => {
    const p = lirePageObjetsReseau(brut(pageObjetsServeur([objetServeur(), { id: "9", nature: "ALIEN" }, objetEquipement()], "c-suivant")));
    expect(p.objets.map((o) => o.id)).toEqual(["10", "30"]);
    expect(p.ignores).toBe(1);
    expect(p.suivant).toBe("c-suivant");
    expect(lirePageObjetsReseau(brut(pageObjetsServeur([]))).suivant).toBeNull();
  });
  it("une reponse qui n'est pas une liste leve une erreur de reponse inattendue (jamais un vide)", () => {
    expect(() => lirePageObjetsReseau({})).toThrow(/Réponse inattendue/);
    expect(() => lirePageObjetsReseau([])).toThrow(/Réponse inattendue/);
    expect(() => lirePageRelationsReseau({ objets: [] })).toThrow(/Réponse inattendue/);
    expect(() => lireFicheObjetReseau({ relations: [] })).toThrow(/Réponse inattendue/);
    expect(() => lireComptageReseau({})).toThrow(/Réponse inattendue/);
    expect(() => lireResultatProposition({})).toThrow(/Réponse inattendue/);
  });
});

describe("lecteur d'une relation", () => {
  it("une relation PROPOSEE automatique porte le calcul de la proposition (sans geometrie) et les actions offertes par le serveur", () => {
    const r = lireRelationReseau(brut(relationProposee()));
    expect(r).toMatchObject({
      typeRelation: "PORTE_PAR", statut: "PROPOSEE", origine: "AUTOMATIQUE", decision: null, actionsPossibles: ["valider", "refuser"], creePar: "Sekou Gestionnaire",
      source: { objetId: "10", nom: "Fibre FO-01", nature: "CIRCUIT_LOGIQUE", typeGeom: "LIGNE" }, cible: { objetId: "20", nom: "Gaine G-01", nature: "ACTIF_PHYSIQUE", typeObjet: "GAINE" },
      proposition: { methode: "SUPERPOSITION", version: "ASSOC-0.1", toleranceM: 2, couverture: 0.96, couvertureMin: 0.9, longueurCircuitM: 60.01, longueurDansToleranceM: 57.6, provisoire: true },
    });
  });
  it("une relation manuelle a une proposition vide = nulle, une decision, et revoquer comme seule action", () => {
    const r = lireRelationReseau(brut(relationValidee()));
    expect(r).toMatchObject({ statut: "VALIDEE", origine: "MANUELLE", proposition: null, actionsPossibles: ["revoquer"], decision: { par: "Sekou Gestionnaire", justification: "Vanne visible dans la chambre au releve" } });
  });
  it("un lecteur n'a aucune action : liste vide ; une action inconnue est ecartee", () => {
    expect(lireRelationReseau(brut(relationProposee({ actionsPossibles: [] })))?.actionsPossibles).toEqual([]);
    expect(lireRelationReseau(brut(relationProposee({ actionsPossibles: ["valider", "deplacer", "executer"] })))?.actionsPossibles).toEqual(["valider"]);
    expect(lireRelationReseau(brut({ ...relationProposee(), actionsPossibles: undefined }))?.actionsPossibles).toEqual([]);
  });
  it("un statut ou un type inconnu : la relation n'est pas rendue et est comptee", () => {
    expect(lireRelationReseau({ ...relationProposee(), statut: "ANNULEE" })).toBeNull();
    expect(lireRelationReseau({ ...relationProposee(), typeRelation: "AUTRE" })).toBeNull();
    const p = lirePageRelationsReseau(brut(pageRelationsServeur([relationProposee(), { ...relationProposee(), statut: "ANNULEE" }], "x")));
    expect(p).toMatchObject({ ignores: 1, suivant: "x" });
    expect(p.relations).toHaveLength(1);
  });
  it("un objet d'extremite masque reste nul (jamais un nom invente)", () => {
    const r = lireRelationReseau(brut(relationProposee({ cible: null })));
    expect(r?.cible).toBeNull();
    expect(r?.source?.nom).toBe("Fibre FO-01");
  });
});

describe("lecteur de la fiche d'un objet", () => {
  it("objet, relations (avec leur role SOURCE ou CIBLE) et circuits a la trace identique", () => {
    const f = lireFicheObjetReseau(brut(ficheObjetServeur(objetServeur(), [{ ...relationProposee(), role: "SOURCE" }, { ...relationValidee(), role: "CIBLE" }], TRACE_PARTAGEE)));
    expect(f.objet.id).toBe("10");
    expect(f.relations.map((r) => r.role)).toEqual(["SOURCE", "CIBLE"]);
    expect(f.tracePartagee).toMatchObject({ nbAutresObjets: 2 });
    expect(f.tracePartagee?.libelle).toMatch(/ils restent séparés/);
  });
  it("la trace partagee n'est pas calculee pour un point : nulle, jamais « 0 autre objet »", () => {
    expect(lireFicheObjetReseau(brut(ficheObjetServeur(objetEquipement(), [], null))).tracePartagee).toBeNull();
    expect(lireFicheObjetReseau(brut(ficheObjetServeur(objetEquipement(), [], { libelle: "x" }))).tracePartagee?.nbAutresObjets).toBeNull();
  });
  it("les relations illisibles sont comptees", () => {
    const f = lireFicheObjetReseau(brut(ficheObjetServeur(objetServeur(), [relationProposee(), { statut: "ALIEN" }])));
    expect(f.relations).toHaveLength(1);
    expect(f.ignoresRelations).toBe(1);
  });
});

describe("lecteur du resultat d'une proposition", () => {
  it("le bilan, les parametres provisoires et les avertissements du serveur", () => {
    const r = lireResultatProposition(brut(resultatPropositionServeur()));
    expect(r).toMatchObject({
      statut: "PROPOSITIONS_A_VALIDER", nbIdsCrees: 4,
      parametres: { version: "ASSOC-0.1", provisoire: true, couvertureMin: 0.9, parCircuitMax: 5, projection: "EPSG:32629", tolerancesParClasseM: { A: 0.5, B: 1, C: 2, D: 5, INCONNUE: 2 } },
      bilan: { circuitsExamines: 8, infrastructuresExaminees: 3, classeEExclusCircuits: 1, classeEExclusInfrastructures: 0, propositionsCalculees: 4, creees: 4, dejaConnues: 0, tronque: false },
    });
    expect(r.avertissements[0]).toMatch(/PROPOSITIONS/);
  });
  it("un compteur absent reste nul (jamais 0) ; tronque seulement s'il est vrai", () => {
    const r = lireResultatProposition({ bilan: { tronque: true } });
    expect(r.bilan).toMatchObject({ creees: null, dejaConnues: null, circuitsExamines: null, tronque: true });
    expect(r.nbIdsCrees).toBeNull();
  });
});

describe("lecteur du comptage : aucune grandeur n'en additionne une autre", () => {
  it("lit chaque grandeur separement (KIS-LOGIC-01 : 8 circuits, somme 410,05 m, trace fusionnee 290,04 m)", () => {
    const c = lireComptageReseau(brut(comptageServeur()));
    expect(c.infrastructures).toMatchObject({ nombreDeclare: 4, nombreLineaires: 3, longueurSommeM: 180.03, longueurTraceFusionneM: 180.03 });
    expect(c.circuits).toMatchObject({ nombreDeclare: 8, sommeLongueursCircuitsM: 410.05, longueurTraceFusionneM: 290.04, tracesPartagees: { groupes: 1, circuitsConcernes: 3 }, supportPhysique: { avecSupportValide: 0, avecPropositionSeulement: 2, sansSupportConnu: 6 } });
    expect(c.equipements.nombreDeclare).toBe(1);
    expect(c.natureInconnue.nombreObjets).toBe(0);
    expect(c.libelles.sommeLongueursCircuitsM).toMatch(/ce n'est pas une longueur de câble/);
    expect(c.jeux[0]).toMatchObject({ nomFichier: "circuits-synthetiques.geojson", nbObjets: 8, longueurTotaleM: 410.05, longueurTraceFusionneM: 290.04, concessionnaire: "Operateur synthetique A" });
    expect(c.qualite).toMatchObject({ objets: 12, objetsAvecDonneesVerticales: 1, sansProfondeur: 11, sansAltitude: 12, evaluables: 0 });
  });
  it("le modele n'expose aucun total qui melange les natures", () => {
    const c = lireComptageReseau(brut(comptageServeur()));
    expect(Object.keys(c)).not.toEqual(expect.arrayContaining(["total", "totalObjets", "nombreTotal"]));
    expect(JSON.stringify(c)).not.toMatch(/"total/i);
  });
  it("une grandeur absente reste nulle, jamais zero", () => {
    const c = lireComptageReseau({ infrastructuresPhysiques: {}, circuitsLogiques: {} });
    expect(c.infrastructures).toMatchObject({ nombreDeclare: null, longueurSommeM: null, longueurTraceFusionneM: null });
    expect(c.circuits).toMatchObject({ nombreDeclare: null, sommeLongueursCircuitsM: null, tracesPartagees: { groupes: null, circuitsConcernes: null }, supportPhysique: { avecSupportValide: null, sansSupportConnu: null } });
    expect(c.equipements.nombreDeclare).toBeNull();
    expect(c.qualite).toBeNull();
    expect(c.jeux).toEqual([]);
    expect(c.avertissements).toEqual([]);
  });
});

describe("appels : URL, parametres et corps", () => {
  it("GET objets : filtres valides et curseur ; aucun corps", async () => {
    h.get.mockResolvedValue({ data: brut(pageObjetsServeur([objetServeur()], "suite")) });
    const p = await listerObjetsReseau("p1", { ...FILTRES_OBJETS_VIDES, nature: "CIRCUIT_LOGIQUE", q: "fo" }, "c1");
    expect(h.get).toHaveBeenCalledWith(`${BASE}/objets`, { params: { limite: 50, nature: "CIRCUIT_LOGIQUE", q: "fo", curseur: "c1" }, signal: undefined });
    expect(p.suivant).toBe("suite");
  });
  it("GET fiche d'un objet : l'identifiant est encode", async () => {
    h.get.mockResolvedValue({ data: brut(ficheObjetServeur(objetServeur(), [relationProposee()], TRACE_PARTAGEE)) });
    const f = await lireFicheObjet("p1", "10");
    expect(h.get).toHaveBeenCalledWith(`${BASE}/objets/10`, { signal: undefined });
    expect(f.relations).toHaveLength(1);
  });
  it("PUT descripteur : le corps complet (valeurs omises = nulles) ; l'objet a jour est lu", async () => {
    h.put.mockResolvedValue({ data: brut({ objet: objetQualifie() }) });
    const corps = corpsDescripteur({ ...SAISIE_DESCRIPTEUR_VIDE, classePrecision: "A", justification: "Controle avec le chef de projet" });
    const o = await declarerDescripteurObjet("p1", "4", corps);
    expect(h.put).toHaveBeenCalledWith(`${BASE}/objets/4/descripteur`, corps);
    expect(h.put.mock.calls[0][1]).toMatchObject({ profondeurM: null, altitudeM: null, precisionHorizontaleM: null, nature: null });
    expect(o.qualite.classePrecision).toBe("A");
  });
  it("PUT descripteur : une reponse sans objet leve une erreur de reponse inattendue", async () => {
    h.put.mockResolvedValue({ data: {} });
    await expect(declarerDescripteurObjet("p1", "4", corpsDescripteur({ ...SAISIE_DESCRIPTEUR_VIDE, justification: "Controle avec le chef de projet" }))).rejects.toThrow(/Réponse inattendue/);
  });
  it("GET relations : statut, type, origine, objetId", async () => {
    h.get.mockResolvedValue({ data: brut(pageRelationsServeur([relationProposee()])) });
    await listerRelationsReseau("p1", { ...FILTRES_RELATIONS_VIDES, statut: "PROPOSEE", origine: "AUTOMATIQUE" }, null);
    expect(h.get).toHaveBeenCalledWith(`${BASE}/relations`, { params: { limite: 50, statut: "PROPOSEE", origine: "AUTOMATIQUE" }, signal: undefined });
  });
  it("POST relation (declaration manuelle) et les trois transitions : { justification } seule", async () => {
    h.post.mockResolvedValue({ data: {} });
    await declarerRelationReseau("p1", { type: "PORTE_PAR", sourceObjetId: "10", cibleObjetId: "20", justification: "Constat de terrain du 05/11" });
    expect(h.post).toHaveBeenLastCalledWith(`${BASE}/relations`, { type: "PORTE_PAR", sourceObjetId: "10", cibleObjetId: "20", justification: "Constat de terrain du 05/11" });
    for (const a of ["valider", "refuser", "revoquer"] as const) {
      await transitionRelationReseau("p1", "rel-1", a, "Justification suffisante");
      expect(h.post).toHaveBeenLastCalledWith(`${BASE}/relations/rel-1/${a}`, { justification: "Justification suffisante" });
    }
  });
  it("POST proposer : corps vide sans jeu (tolerances et seuil du serveur, jamais fixes par l'interface) ; { jeuId } sinon", async () => {
    h.post.mockResolvedValue({ data: brut(resultatPropositionServeur()) });
    const r = await proposerAssociationsReseau("p1", null);
    expect(h.post).toHaveBeenLastCalledWith(`${BASE}/associations/proposer`, {});
    expect(r.bilan.creees).toBe(4);
    await proposerAssociationsReseau("p1", JEU_RESEAU);
    expect(h.post).toHaveBeenLastCalledWith(`${BASE}/associations/proposer`, { jeuId: JEU_RESEAU });
  });
  it("GET comptage : jeuId et inclureNonAutorises seulement s'ils sont demandes", async () => {
    h.get.mockResolvedValue({ data: brut(comptageServeur()) });
    await lireComptage("p1", { jeuId: null, inclureNonAutorises: false });
    expect(h.get).toHaveBeenLastCalledWith(`${BASE}/comptage`, { params: {}, signal: undefined });
    await lireComptage("p1", { jeuId: JEU_RESEAU, inclureNonAutorises: true });
    expect(h.get).toHaveBeenLastCalledWith(`${BASE}/comptage`, { params: { jeuId: JEU_RESEAU, inclureNonAutorises: "true" }, signal: undefined });
  });
});

describe("garde statique du client", () => {
  const src = readFileSync(path.resolve(__dirname, "projetsVoirieReseauxApi.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const routes = [...src.matchAll(/`\$\{BASE\}([^`]*)`/g)].map((m) => m[1].replace(/\/\$\{id\(\w+\)\}/g, "").replace(/\/\$\{action\}/, "/:action"));
  it("seules les routes du lot B1 sont appelees : aucune geometrie, aucun ordre, aucun deplacement, aucune suppression, aucune API publique", () => {
    expect(routes.sort()).toEqual(["/reseau/associations/proposer", "/reseau/comptage", "/reseau/objets", "/reseau/objets", "/reseau/objets/descripteur", "/reseau/relations", "/reseau/relations", "/reseau/relations/:action"].sort());
    expect(routes.filter((r) => /deplacer|ordre|ordonner|executer|export|geometrie|public/i.test(r))).toEqual([]);
    expect(src).not.toMatch(/api\.delete|\/api\/public|\.delete\(/);
  });
});

describe("objets de la fixture : coherence", () => {
  it("l'infrastructure et l'equipement se lisent comme leur nature", () => {
    expect(lireObjetReseau(brut(objetInfrastructure()))).toMatchObject({ nature: "ACTIF_PHYSIQUE", typeObjet: "GAINE" });
    expect(lireObjetReseau(brut(objetEquipement()))).toMatchObject({ nature: "EQUIPEMENT", typeGeom: "POINT", longueurM: null });
  });
});
