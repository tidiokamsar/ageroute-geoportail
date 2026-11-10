import { describe, expect, it } from "vitest";
import {
  REGLE_RAPPROCHEMENT_DEFAUT, baremeApprouve, corridorM, lirePrecisionParClasse, precisionRetenue, prochaineVersionRegleRapprochement,
  resoudreRegleRapprochement, verifierCreationRegleRapprochement, type RegleRapprochementLue,
} from "./regle-rapprochement.noyau";
import { verifierApprobationRegle } from "../conflits/regle.noyau";

const P = "projet-1";
/** Bareme classe vers metres d'une regle humaine (les valeurs sont celles d'un essai, pas une recommandation). */
const BAREME = { A: 0.5, B: 1, C: 2, D: 5 } as const;
let n = 0;
const regle = (s: Partial<RegleRapprochementLue>): RegleRapprochementLue => ({
  regleId: `r${++n}`, projetId: P, famille: null, code: "COR", version: 1, margeM: 2, rayonAppariementM: 10, partHorsCorridorMax: 0,
  precisionParClasseM: BAREME, statut: "APPROUVEE", approuveLe: new Date("2026-11-01T10:00:00Z"), creeParId: "auteur", approuveParId: "admin", ...s,
});
const DEFAUT = regle({ regleId: "def", projetId: null, code: "S1-CORRIDOR-0.2", version: 0, margeM: 1, precisionParClasseM: null, creeParId: null, approuveParId: null });

describe("corridor = max(pA, pB) + marge, seulement si les deux precisions sont connues", () => {
  it("deux precisions connues : le maximum plus la marge, au centimetre (jamais la somme des precisions)", () => {
    expect(corridorM(1, 1, 1)).toBe(2);
    expect(corridorM(0.5, 3.5, 1)).toBe(4.5);
    expect(corridorM(0.333, 0.1, 1)).toBe(1.33);
    expect(corridorM(2, 3, 0)).toBe(3);
  });
  it("une precision inconnue, nulle ou negative : aucun corridor (rien n'est invente)", () => {
    expect(corridorM(null, 1, 1)).toBeNull();
    expect(corridorM(1, null, 1)).toBeNull();
    expect(corridorM(0, 1, 1)).toBeNull();
    expect(corridorM(-1, 1, 1)).toBeNull();
    expect(corridorM(Number.NaN, 1, 1)).toBeNull();
  });
  it("une marge negative ou non finie compte pour zero", () => {
    expect(corridorM(1, 2, -5)).toBe(2);
    expect(corridorM(1, 2, Number.NaN)).toBe(2);
  });
});

describe("precision retenue pour un objet : descripteur, jeu, classe convertie, sinon inconnue", () => {
  const T = BAREME;
  it("le descripteur B1 l'emporte sur le jeu, qui l'emporte sur la classe", () => {
    expect(precisionRetenue({ precisionObjetM: 0.2, precisionJeuM: 3, classeObjet: "A", classeJeu: "B" }, T)).toEqual({ precisionM: 0.2, origine: "OBJET" });
    expect(precisionRetenue({ precisionObjetM: null, precisionJeuM: 3.456, classeObjet: "A", classeJeu: "B" }, T)).toEqual({ precisionM: 3.46, origine: "JEU" });
    expect(precisionRetenue({ precisionObjetM: null, precisionJeuM: null, classeObjet: "A", classeJeu: "B" }, T)).toEqual({ precisionM: 0.5, origine: "CLASSE" });
    expect(precisionRetenue({ precisionObjetM: null, precisionJeuM: null, classeObjet: null, classeJeu: "D" }, T)).toEqual({ precisionM: 5, origine: "CLASSE" });
  });
  it("sans precision ni classe, ou classe E (sans geometrie) : inconnue", () => {
    expect(precisionRetenue({ precisionObjetM: null, precisionJeuM: null, classeObjet: null, classeJeu: null }, T)).toEqual({ precisionM: null, origine: "INCONNUE" });
    expect(precisionRetenue({ precisionObjetM: null, precisionJeuM: null, classeObjet: "E", classeJeu: "B" }, T)).toEqual({ precisionM: null, origine: "INCONNUE" });
    expect(precisionRetenue({ precisionObjetM: 0, precisionJeuM: undefined, classeObjet: undefined, classeJeu: undefined }, T)).toEqual({ precisionM: null, origine: "INCONNUE" });
  });
  it("M6 : sans bareme (regle systeme), une classe seule reste une precision INCONNUE : aucune valeur n'est attribuee a A, B, C ou D", () => {
    for (const c of ["A", "B", "C", "D", "E"]) {
      expect(precisionRetenue({ precisionObjetM: null, precisionJeuM: null, classeObjet: c, classeJeu: null }, null), c).toEqual({ precisionM: null, origine: "INCONNUE" });
    }
    expect(precisionRetenue({ precisionObjetM: null, precisionJeuM: 1.5, classeObjet: "C", classeJeu: null }, null)).toEqual({ precisionM: 1.5, origine: "JEU" });
  });
  it("la table de la regle decide de la valeur d'une classe", () => {
    expect(precisionRetenue({ precisionObjetM: null, precisionJeuM: null, classeObjet: "C", classeJeu: null }, { A: 1, B: 2, C: 7, D: 9 })).toEqual({ precisionM: 7, origine: "CLASSE" });
  });
});

describe("table de precision par classe (JSON de la base ou corps de requete)", () => {
  it("accepte une table complete A a D, positive, arrondie au centimetre ; refuse E, une cle en trop, une valeur absente, nulle ou negative", () => {
    expect(lirePrecisionParClasse({ A: 0.5, B: 1, C: 2, D: 5 })).toEqual({ A: 0.5, B: 1, C: 2, D: 5 });
    expect(lirePrecisionParClasse({ A: 0.555, B: 1, C: 2, D: 5 })).toEqual({ A: 0.56, B: 1, C: 2, D: 5 });
    expect(lirePrecisionParClasse({ A: 0.5, B: 1, C: 2, D: 5, E: 10 })).toBeNull();
    expect(lirePrecisionParClasse({ A: 0.5, B: 1, C: 2 })).toBeNull();
    expect(lirePrecisionParClasse({ A: 0, B: 1, C: 2, D: 5 })).toBeNull();
    expect(lirePrecisionParClasse({ A: -1, B: 1, C: 2, D: 5 })).toBeNull();
    expect(lirePrecisionParClasse({ A: "1", B: 1, C: 2, D: 5 })).toBeNull();
    expect(lirePrecisionParClasse(null)).toBeNull();
    expect(lirePrecisionParClasse([1, 2])).toBeNull();
  });
});

describe("resolution de la regle effective (meme ordre que RC-3)", () => {
  it("sans regle : la regle de repli du code (marge 1 m, rayon 10 m, part 0) ; M6 : AUCUN bareme par classe", () => {
    const r = resoudreRegleRapprochement([], P, "TELECOM");
    expect(r.portee).toBe("DEFAUT");
    expect(r.regle).toEqual(REGLE_RAPPROCHEMENT_DEFAUT);
    expect(REGLE_RAPPROCHEMENT_DEFAUT).toMatchObject({ code: "S1-CORRIDOR-0.2", version: 0, margeM: 1, rayonAppariementM: 10, partHorsCorridorMax: 0, precisionParClasseM: null });
    expect(baremeApprouve(REGLE_RAPPROCHEMENT_DEFAUT)).toBeNull();
  });
  it("projet+famille, projet, generale+famille, generale, defaut ; brouillon et retiree jamais appliquees", () => {
    const pf = regle({ famille: "TELECOM", code: "PF" });
    const p = regle({ code: "P" });
    const gf = regle({ projetId: null, famille: "TELECOM", code: "GF" });
    const g = regle({ projetId: null, code: "G" });
    const brouillon = regle({ famille: "TELECOM", code: "B", statut: "BROUILLON", approuveLe: null, margeM: 99 });
    const retiree = regle({ famille: "TELECOM", code: "R", statut: "RETIREE", margeM: 99 });
    const tout = [DEFAUT, g, gf, p, pf, brouillon, retiree];
    expect(resoudreRegleRapprochement(tout, P, "TELECOM")).toMatchObject({ portee: "PROJET_FAMILLE", regle: { code: "PF" } });
    expect(resoudreRegleRapprochement(tout, P, "EAU_POTABLE")).toMatchObject({ portee: "PROJET", regle: { code: "P" } });
    expect(resoudreRegleRapprochement([DEFAUT, g, gf], P, "TELECOM")).toMatchObject({ portee: "GENERALE_FAMILLE", regle: { code: "GF" } });
    expect(resoudreRegleRapprochement([DEFAUT, g, gf], P, "GAZ_HYDROCARBURES")).toMatchObject({ portee: "GENERALE", regle: { code: "G" } });
    expect(resoudreRegleRapprochement([DEFAUT, brouillon, retiree], P, "TELECOM")).toMatchObject({ portee: "DEFAUT", regle: { regleId: "def" } });
  });
  it("la plus recemment approuvee l'emporte, puis la version la plus haute", () => {
    const v1 = regle({ code: "X", version: 1, approuveLe: new Date("2026-11-02T00:00:00Z") });
    const v2 = regle({ code: "X", version: 2, approuveLe: new Date("2026-11-01T00:00:00Z") });
    expect(resoudreRegleRapprochement([v1, v2], P, null).regle.version).toBe(1);
    const v3 = regle({ code: "X", version: 3, approuveLe: new Date("2026-11-02T00:00:00Z") });
    expect(resoudreRegleRapprochement([v1, v3], P, null).regle.version).toBe(3);
  });
});

describe("versions et approbation", () => {
  it("version suivante : 1 sans version, sinon la plus grande plus un", () => {
    expect(prochaineVersionRegleRapprochement([])).toBe(1);
    expect(prochaineVersionRegleRapprochement([1, 3, 2])).toBe(4);
  });
  it("creation : justification de 10 caracteres, bornes des parametres", () => {
    expect(verifierCreationRegleRapprochement({ margeM: 1, rayonAppariementM: 10, partHorsCorridorMax: 0, justification: "court" })).toMatchObject({ ok: false, status: 422, code: "JUSTIFICATION_REQUISE" });
    expect(verifierCreationRegleRapprochement({ margeM: 101, rayonAppariementM: 10, partHorsCorridorMax: 0, justification: "Tolerance validee par la direction" })).toMatchObject({ ok: false, status: 400 });
    expect(verifierCreationRegleRapprochement({ margeM: 1, rayonAppariementM: 0, partHorsCorridorMax: 0, justification: "Tolerance validee par la direction" })).toMatchObject({ ok: false, status: 400 });
    expect(verifierCreationRegleRapprochement({ margeM: 1, rayonAppariementM: 10, partHorsCorridorMax: 1.5, justification: "Tolerance validee par la direction" })).toMatchObject({ ok: false, status: 400 });
    expect(verifierCreationRegleRapprochement({ margeM: 1, rayonAppariementM: 10, partHorsCorridorMax: 0.1, justification: "Tolerance validee par la direction" })).toEqual({ ok: true });
  });
  it("approbation : meme noyau que RC-3 (brouillon seulement, justification, auteur sans derogation refuse)", () => {
    expect(verifierApprobationRegle({ statut: "APPROUVEE", creeParId: "a", acteurId: "b", justification: "Relue et approuvee", derogation: undefined })).toMatchObject({ ok: false, code: "REGLE_IMMUABLE" });
    expect(verifierApprobationRegle({ statut: "BROUILLON", creeParId: "a", acteurId: "a", justification: "Relue et approuvee", derogation: undefined })).toMatchObject({ ok: false, code: "SEPARATION_DES_TACHES" });
    expect(verifierApprobationRegle({ statut: "BROUILLON", creeParId: "a", acteurId: "b", justification: "Relue et approuvee", derogation: undefined })).toEqual({ ok: true, derogation: null });
  });
});

describe("M6 (decision de l'architecte) : un bareme classe vers metres n'est applique que s'il est approuve par un ADMIN autre que l'auteur", () => {
  it("regle humaine approuvee par une autre personne : bareme applicable", () => {
    expect(baremeApprouve(regle({}))).toEqual(BAREME);
  });
  it("regle systeme, auto-approuvee (meme avec derogation), brouillon, retiree ou sans table : aucun bareme", () => {
    expect(baremeApprouve(regle({ creeParId: null, approuveParId: null }))).toBeNull();
    expect(baremeApprouve(regle({ creeParId: "admin", approuveParId: "admin" }))).toBeNull();
    expect(baremeApprouve(regle({ statut: "BROUILLON", approuveParId: null }))).toBeNull();
    expect(baremeApprouve(regle({ statut: "RETIREE" }))).toBeNull();
    expect(baremeApprouve(regle({ precisionParClasseM: null }))).toBeNull();
  });
  it("lecture : une table vide est l'absence de bareme (jamais une valeur par defaut)", () => {
    expect(lirePrecisionParClasse({})).toBeNull();
  });
});
