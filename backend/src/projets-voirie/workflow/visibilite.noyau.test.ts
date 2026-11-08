import { describe, expect, it } from "vitest";
import {
  STATUTS_CONFLIT_PARTAGES, filtreConflitsVue, filtreDemandes, filtreRecolements, filtreTaches, historiqueVisible, identitesInternesVisibles, jeuLieVisible, ligneVisible, preuveVisible, sorteDe,
  type ContexteLecture,
} from "./visibilite.noyau";

const decideur: ContexteLecture = { profil: "GESTIONNAIRE", concessionnaires: [] };
const admin: ContexteLecture = { profil: "ADMIN", concessionnaires: [] };
const referent: ContexteLecture = { profil: "REFERENT", concessionnaires: ["c1"] };
const referentDeux: ContexteLecture = { profil: "REFERENT", concessionnaires: ["c1", "c2"] };
const observateur: ContexteLecture = { profil: "LECTEUR", concessionnaires: [] };
const agent: ContexteLecture = { profil: "INSPECTEUR", concessionnaires: [] };

describe("trois sortes de lecteurs", () => {
  it("decideur, referent, autre", () => {
    expect([admin, decideur, referent, observateur, agent].map(sorteDe)).toEqual(["DECIDEUR", "DECIDEUR", "REFERENT", "AUTRE", "AUTRE"]);
  });
});

describe("demandes : un referent ne voit que celles de son concessionnaire, une fois envoyees", () => {
  it("un decideur voit tout, brouillons compris", () => {
    expect(ligneVisible(filtreDemandes(decideur), { concessionnaireId: "cX", partage: false })).toBe(true);
  });
  it("un referent ne voit pas un brouillon, ni la demande d'un autre concessionnaire, ni le concessionnaire d'un autre projet", () => {
    const f = filtreDemandes(referent);
    expect(ligneVisible(f, { concessionnaireId: "c1", partage: true })).toBe(true);
    expect(ligneVisible(f, { concessionnaireId: "c1", partage: false })).toBe(false);
    expect(ligneVisible(f, { concessionnaireId: "c2", partage: true })).toBe(false);
    expect(ligneVisible(f, { concessionnaireId: null, partage: true })).toBe(false);
  });
  it("un referent de deux concessionnaires voit les deux", () => {
    const f = filtreDemandes(referentDeux);
    expect(ligneVisible(f, { concessionnaireId: "c2", partage: true })).toBe(true);
    expect(ligneVisible(f, { concessionnaireId: "c3", partage: true })).toBe(false);
  });
  it("un referent sans aucun rattachement dans ce projet ne voit rien (liste vide, jamais « tout »)", () => {
    const f = filtreDemandes({ profil: "REFERENT", concessionnaires: [] });
    expect(f.concessionnaires).toEqual([]);
    expect(ligneVisible(f, { concessionnaireId: "c1", partage: true })).toBe(false);
  });
  it("un lecteur de projet voit les demandes envoyees, pas les brouillons", () => {
    expect(ligneVisible(filtreDemandes(observateur), { concessionnaireId: "c1", partage: true })).toBe(true);
    expect(ligneVisible(filtreDemandes(observateur), { concessionnaireId: "c1", partage: false })).toBe(false);
  });
});

describe("taches : un referent ne voit que celles de son concessionnaire qu'un decideur a partagees", () => {
  it("lier une tache a un concessionnaire ne la partage pas : sans `partagee`, le referent ne la voit pas", () => {
    const f = filtreTaches(referent);
    expect(ligneVisible(f, { concessionnaireId: "c1", conflitId: null, partage: true })).toBe(true);
    expect(ligneVisible(f, { concessionnaireId: "c1", conflitId: null, partage: false })).toBe(false);
    expect(ligneVisible(f, { concessionnaireId: "c2", conflitId: null, partage: true })).toBe(false);
    expect(ligneVisible(f, { concessionnaireId: null, conflitId: null, partage: true })).toBe(false);
  });
  it("un lecteur de projet voit les taches non liees a un conflit, jamais celles d'un conflit", () => {
    const f = filtreTaches(observateur);
    expect(ligneVisible(f, { concessionnaireId: null, conflitId: null })).toBe(true);
    expect(ligneVisible(f, { concessionnaireId: "c1", conflitId: "k1" })).toBe(false);
  });
  it("un decideur voit tout", () => {
    expect(ligneVisible(filtreTaches(admin), { concessionnaireId: null, conflitId: "k1", partage: false })).toBe(true);
  });
});

describe("recolements", () => {
  it("un referent ne voit que ceux de son concessionnaire, une fois soumis", () => {
    const f = filtreRecolements(referent);
    expect(ligneVisible(f, { concessionnaireId: "c1", conflitId: "k1", partage: true })).toBe(true);
    expect(ligneVisible(f, { concessionnaireId: "c1", conflitId: "k1", partage: false })).toBe(false);
    expect(ligneVisible(f, { concessionnaireId: "c2", conflitId: "k1", partage: true })).toBe(false);
  });
  it("un lecteur de projet : soumis et non lie a un conflit seulement", () => {
    const f = filtreRecolements(observateur);
    expect(ligneVisible(f, { concessionnaireId: "c1", conflitId: null, partage: true })).toBe(true);
    expect(ligneVisible(f, { concessionnaireId: "c1", conflitId: "k1", partage: true })).toBe(false);
    expect(ligneVisible(f, { concessionnaireId: "c1", conflitId: null, partage: false })).toBe(false);
  });
});

describe("preuves, historique, identites internes", () => {
  it("un decideur lit toutes les preuves ; les autres, les preuves partagees", () => {
    expect(preuveVisible(decideur, { partagee: false })).toBe(true);
    expect(preuveVisible(referent, { partagee: false })).toBe(false);
    expect(preuveVisible(referent, { partagee: true })).toBe(true);
    expect(preuveVisible(observateur, { partagee: false })).toBe(false);
  });
  it("historique et identites internes : decideurs seulement", () => {
    expect([admin, decideur].every(historiqueVisible)).toBe(true);
    expect([referent, observateur, agent].some(historiqueVisible)).toBe(false);
    expect([referent, observateur, agent].some(identitesInternesVisibles)).toBe(false);
  });
});

describe("jeu lie : meme regle que le socle", () => {
  it("un jeu RETIRE n'est montre a personne, un jeu autre qu'AUTORISE qu'aux decideurs, un jeu AUTORISE a tous", () => {
    for (const c of [admin, decideur, referent, observateur]) expect(jeuLieVisible(c, "RETIRE")).toBe(false);
    for (const s of ["RECU", "CONTROLE", "REJETE", "REMPLACE"]) {
      expect(jeuLieVisible(decideur, s), s).toBe(true);
      expect(jeuLieVisible(referent, s), s).toBe(false);
      expect(jeuLieVisible(observateur, s), s).toBe(false);
    }
    for (const c of [admin, decideur, referent, observateur]) expect(jeuLieVisible(c, "AUTORISE")).toBe(true);
  });
});

describe("vue concessionnaire des dossiers de conflit", () => {
  it("un referent : son concessionnaire, dossiers confirmes par une personne, jeux autorises", () => {
    expect(filtreConflitsVue(referent)).toEqual({ concessionnaires: ["c1"], statuts: STATUTS_CONFLIT_PARTAGES, jeuxAutorisesSeulement: true });
    expect(STATUTS_CONFLIT_PARTAGES).toEqual(["CONFIRME", "TRAITEMENT_DECIDE", "CLOTURE"]);
    for (const interne of ["A_INVESTIGUER", "POTENTIEL", "INFIRME"]) expect(STATUTS_CONFLIT_PARTAGES, interne).not.toContain(interne);
  });
  it("un decideur : tous les dossiers ; les autres lecteurs : aucun (liste de concessionnaires vide)", () => {
    expect(filtreConflitsVue(decideur)).toEqual({ concessionnaires: null, statuts: null, jeuxAutorisesSeulement: false });
    expect(filtreConflitsVue(observateur).concessionnaires).toEqual([]);
    expect(filtreConflitsVue(agent).concessionnaires).toEqual([]);
  });
});
