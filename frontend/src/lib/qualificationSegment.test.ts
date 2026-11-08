import { describe, expect, it } from "vitest";
import {
  construireQualification, libelleMission, libelleQualification, lireReferentiels, memeQualification, missionsRattachables,
  saisieDepuisQualification, SAISIE_VIDE, valeursActives, type ReferentielsQualification,
} from "./qualificationSegment";

/**
 * Ce que ces tests defendent : une qualification ne contient QUE ce que l'agent a choisi parmi les valeurs ACTIVES
 * du referentiel du serveur ; la praticabilite reste ecartee tant que le serveur n'a pas defini son vocabulaire ;
 * et la liste de missions n'offre que celles que le serveur acceptera (assignee ou creee par l'agent).
 * Les codes ci-dessous sont des codes d'ESSAI, propres a ces tests : aucun n'est une valeur du referentiel reel.
 */
const refs: ReferentielsQualification = {
  revetements: [{ code: "R_UN", libelle: "Revêtement un", actif: true }, { code: "R_VIEUX", libelle: "Ancien", actif: false }],
  etats: [{ code: "E_UN", libelle: "État un", actif: true }],
  praticabilites: [{ code: "P_UN", libelle: "Praticabilité un", actif: true }],
  praticabiliteNonDefinie: false,
};

describe("construireQualification", () => {
  it("ne retient que les champs choisis, et rend null quand rien n'est choisi (aucune valeur par defaut)", () => {
    expect(construireQualification(SAISIE_VIDE, refs)).toBeNull();
    expect(construireQualification({ ...SAISIE_VIDE, etat: "E_UN" }, refs)).toEqual({ etat: "E_UN" });
    expect(construireQualification({ revetement: "R_UN", etat: "E_UN", praticabilite: "P_UN" }, refs)).toEqual({ revetement: "R_UN", etat: "E_UN", praticabilite: "P_UN" });
  });

  it("ecarte un code inconnu ou INACTIF : jamais de valeur inventee ni perimee", () => {
    expect(construireQualification({ revetement: "R_VIEUX", etat: "NIMPORTE", praticabilite: "" }, refs)).toBeNull();
    expect(construireQualification({ revetement: "R_VIEUX", etat: "E_UN", praticabilite: "" }, refs)).toEqual({ etat: "E_UN" });
  });

  it("ecarte la praticabilite tant que le serveur n'a pas defini ce vocabulaire", () => {
    const sansPraticabilite = { ...refs, praticabilites: [], praticabiliteNonDefinie: true };
    expect(construireQualification({ revetement: "", etat: "", praticabilite: "P_UN" }, sansPraticabilite)).toBeNull();
    // meme si une valeur trainait dans la liste, le drapeau du serveur l'emporte
    expect(construireQualification({ revetement: "", etat: "", praticabilite: "P_UN" }, { ...refs, praticabiliteNonDefinie: true })).toBeNull();
  });

  it("sans referentiel charge, rien n'est retenu", () => {
    expect(construireQualification({ revetement: "R_UN", etat: "E_UN", praticabilite: "P_UN" }, null)).toBeNull();
  });
});

describe("lireReferentiels", () => {
  it("accepte la forme de GET /v2/referentiels et refuse une reponse mal formee", () => {
    const ok = lireReferentiels({ revetements: [{ code: "A", libelle: "a", actif: true, ordre: 1 }], etats: [], praticabilites: [], praticabiliteNonDefinie: true });
    expect(ok).toEqual({ revetements: [{ code: "A", libelle: "a", actif: true }], etats: [], praticabilites: [], praticabiliteNonDefinie: true });
    expect(lireReferentiels(null)).toBeNull();
    expect(lireReferentiels({ revetements: [], etats: [] })).toBeNull();
    expect(lireReferentiels({ revetements: [{ code: "", libelle: "x", actif: true }], etats: [], praticabilites: [], praticabiliteNonDefinie: false })).toBeNull();
    expect(lireReferentiels({ revetements: [], etats: [], praticabilites: [], praticabiliteNonDefinie: "oui" })).toBeNull();
  });
});

describe("mise en forme", () => {
  it("valeursActives ecarte les valeurs inactives", () => {
    expect(valeursActives(refs.revetements).map((v) => v.code)).toEqual(["R_UN"]);
    expect(valeursActives(undefined)).toEqual([]);
  });

  it("le libelle dit les libelles du referentiel, le code brut si le libelle est inconnu, et « non qualifié » sans rien", () => {
    expect(libelleQualification({ revetement: "R_UN", etat: "E_UN" }, refs)).toBe("Revêtement un, État un");
    expect(libelleQualification({ etat: "CODE_RETIRE" }, refs)).toBe("CODE_RETIRE");
    expect(libelleQualification(null, refs)).toBe("non qualifié");
    expect(libelleQualification({}, refs)).toBe("non qualifié");
  });

  it("memeQualification traite l'absence et null comme equivalents", () => {
    expect(memeQualification(null, {})).toBe(true);
    expect(memeQualification({ etat: "E_UN" }, { etat: "E_UN", revetement: null })).toBe(true);
    expect(memeQualification({ etat: "E_UN" }, { etat: "E_DEUX" })).toBe(false);
    expect(memeQualification(null, { etat: "E_UN" })).toBe(false);
  });

  it("saisieDepuisQualification reprend une qualification posee (reprise de session)", () => {
    expect(saisieDepuisQualification({ etat: "E_UN" })).toEqual({ revetement: "", etat: "E_UN", praticabilite: "" });
    expect(saisieDepuisQualification(null)).toEqual(SAISIE_VIDE);
  });
});

describe("missionsRattachables", () => {
  const m = (id: string, statut: string, assigneId: string | null, createurId: string) => ({ id, code: `M-${id}`, intitule: `Patrouille ${id}`, statut, assigneId, createurId });

  it("ne garde que les missions assignees a l'agent ou creees par lui : le serveur refuserait toute la session pour une autre", () => {
    const liste = [m("1", "EN_COURS", "agent", "chef"), m("2", "EN_COURS", "autre", "chef"), m("3", "PLANIFIEE", null, "agent"), m("4", "EN_COURS", null, "chef")];
    expect(missionsRattachables(liste, "agent").map((x) => x.id)).toEqual(["1", "3"]);
  });

  it("ecarte les missions annulees, les lignes mal formees et une reponse qui n'est pas une liste", () => {
    expect(missionsRattachables([m("1", "ANNULEE", "agent", "agent"), { id: 5 }, null, m("2", "TERMINEE", "agent", "agent")], "agent").map((x) => x.id)).toEqual(["2"]);
    expect(missionsRattachables({ erreur: true }, "agent")).toEqual([]);
  });

  it("le libelle porte le code, l'intitule et le statut lisible", () => {
    expect(libelleMission(m("1", "SYNC_EN_ATTENTE", "agent", "agent"))).toBe("M-1 : Patrouille 1 (sync en attente)");
  });
});
