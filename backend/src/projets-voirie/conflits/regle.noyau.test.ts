import { describe, expect, it } from "vitest";
import {
  CODE_REGLE_DEFAUT, REGLE_PAR_DEFAUT, distanceProximiteM, prochaineVersionRegle, resoudreRegle, verifierApprobationRegle, type RegleLue,
} from "./regle.noyau";

const P = "projet-1";
let n = 0;
const regle = (s: Partial<RegleLue>): RegleLue => ({
  regleId: `r${++n}`, projetId: P, famille: null, code: "TOL", version: 1, toleranceProximiteM: 2, margeIncertitude: 1, statut: "APPROUVEE",
  approuveLe: new Date("2026-11-01T10:00:00Z"), ...s,
});
const DEFAUT: RegleLue = regle({ regleId: "def", projetId: null, famille: null, code: CODE_REGLE_DEFAUT, version: 0, toleranceProximiteM: 0 });

describe("resolution de la regle applicable", () => {
  it("sans aucune regle : la regle de repli du code (version 0, tolerance 0, aucun seuil invente)", () => {
    const r = resoudreRegle([], P, "TELECOM");
    expect(r.portee).toBe("DEFAUT");
    expect(r.regle).toEqual(REGLE_PAR_DEFAUT);
    expect(REGLE_PAR_DEFAUT).toMatchObject({ code: "RC-2D-0.1", version: 0, toleranceProximiteM: 0, margeIncertitude: 1 });
  });

  it("la regle par defaut de la base est la derniere recours (portee DEFAUT)", () => {
    const r = resoudreRegle([DEFAUT], P, "TELECOM");
    expect(r.portee).toBe("DEFAUT");
    expect(r.regle.regleId).toBe("def");
  });

  it("ordre de precedence : projet+famille, projet, generale+famille, generale, defaut", () => {
    const pf = regle({ famille: "TELECOM", code: "PF" });
    const p = regle({ famille: null, code: "P" });
    const gf = regle({ projetId: null, famille: "TELECOM", code: "GF" });
    const g = regle({ projetId: null, famille: null, code: "G" });
    const tout = [DEFAUT, g, gf, p, pf];
    expect(resoudreRegle(tout, P, "TELECOM")).toMatchObject({ portee: "PROJET_FAMILLE", regle: { code: "PF" } });
    expect(resoudreRegle(tout, P, "EAU_POTABLE")).toMatchObject({ portee: "PROJET", regle: { code: "P" } });
    expect(resoudreRegle([DEFAUT, g, gf], P, "TELECOM")).toMatchObject({ portee: "GENERALE_FAMILLE", regle: { code: "GF" } });
    expect(resoudreRegle([DEFAUT, g, gf], P, "GAZ_HYDROCARBURES")).toMatchObject({ portee: "GENERALE", regle: { code: "G" } });
    expect(resoudreRegle([DEFAUT], P, "GAZ_HYDROCARBURES").portee).toBe("DEFAUT");
  });

  it("une regle d'un autre projet ne s'applique pas", () => {
    expect(resoudreRegle([DEFAUT, regle({ projetId: "autre", famille: "TELECOM" })], P, "TELECOM").portee).toBe("DEFAUT");
  });

  it("un brouillon et une regle retiree ne s'appliquent jamais", () => {
    const l = [DEFAUT, regle({ statut: "BROUILLON", approuveLe: null }), regle({ statut: "RETIREE" })];
    expect(resoudreRegle(l, P, "TELECOM").portee).toBe("DEFAUT");
  });

  it("la plus recente approuvee l'emporte, puis la version la plus haute ; le resultat ne depend pas de l'ordre de lecture", () => {
    const v1 = regle({ code: "TOL", version: 1, approuveLe: new Date("2026-11-01T10:00:00Z") });
    const v2 = regle({ code: "TOL", version: 2, toleranceProximiteM: 5, approuveLe: new Date("2026-11-02T10:00:00Z") });
    expect(resoudreRegle([v1, v2], P, null).regle.version).toBe(2);
    expect(resoudreRegle([v2, v1], P, null).regle.version).toBe(2);
    const memeJour = new Date("2026-11-03T10:00:00Z");
    const a = regle({ code: "AAA", version: 1, approuveLe: memeJour }), b = regle({ code: "BBB", version: 3, approuveLe: memeJour });
    expect(resoudreRegle([a, b], P, null).regle.code).toBe("BBB");
    expect(resoudreRegle([b, a], P, null).regle.code).toBe("BBB");
  });

  it("une famille nulle (jeu sans famille) ne retient pas une regle de famille", () => {
    expect(resoudreRegle([DEFAUT, regle({ famille: "TELECOM" })], P, null).portee).toBe("DEFAUT");
  });
});

describe("distance de proximite", () => {
  it("tolerance + precision declaree x marge ; une precision non declaree n'est jamais inventee", () => {
    const r = { toleranceProximiteM: 2, margeIncertitude: 1.5 };
    expect(distanceProximiteM(r, 4)).toBe(8);
    expect(distanceProximiteM(r, null)).toBe(2);
    expect(distanceProximiteM(r, 0)).toBe(2);
    expect(distanceProximiteM(r, -3)).toBe(2);
    expect(distanceProximiteM(r, Number.NaN)).toBe(2);
  });
  it("regle par defaut : aucune bande sans precision declaree", () => {
    expect(distanceProximiteM(REGLE_PAR_DEFAUT, null)).toBe(0);
    expect(distanceProximiteM(REGLE_PAR_DEFAUT, 3)).toBe(3);
  });
  it("marge 0 : la precision ne compte pas", () => {
    expect(distanceProximiteM({ toleranceProximiteM: 1, margeIncertitude: 0 }, 10)).toBe(1);
  });
});

describe("versions et approbation", () => {
  it("version suivante : 1 pour la premiere, sinon 1 + la plus haute", () => {
    expect(prochaineVersionRegle([])).toBe(1);
    expect(prochaineVersionRegle([1, 2, 5])).toBe(6);
    expect(prochaineVersionRegle([0])).toBe(1);
  });

  const appro = (s: Partial<Parameters<typeof verifierApprobationRegle>[0]> = {}) => verifierApprobationRegle({
    statut: "BROUILLON", creeParId: "u-auteur", acteurId: "u-admin", justification: "Valide avec la direction technique", derogation: undefined, ...s,
  });

  it("un brouillon est approuve par un autre compte avec une justification", () => {
    expect(appro()).toEqual({ ok: true, derogation: null });
  });
  it("une regle deja approuvee ou retiree : 409 REGLE_IMMUABLE", () => {
    for (const statut of ["APPROUVEE", "RETIREE"] as const) expect(appro({ statut })).toMatchObject({ ok: false, status: 409, code: "REGLE_IMMUABLE" });
  });
  it("justification de moins de 10 caracteres : 422 JUSTIFICATION_REQUISE", () => {
    for (const j of [undefined, "", "court", "   123456789  "]) expect(appro({ justification: j })).toMatchObject({ ok: false, status: 422, code: "JUSTIFICATION_REQUISE" });
  });
  it("l'auteur ne peut pas approuver sa propre regle sans derogation motivee : 409 SEPARATION_DES_TACHES ; avec derogation, elle est rendue pour etre tracee", () => {
    expect(appro({ acteurId: "u-auteur" })).toMatchObject({ ok: false, status: 409, code: "SEPARATION_DES_TACHES" });
    expect(appro({ acteurId: "u-auteur", derogation: "court" })).toMatchObject({ ok: false, code: "SEPARATION_DES_TACHES" });
    expect(appro({ acteurId: "u-auteur", derogation: "Un seul administrateur disponible" })).toEqual({ ok: true, derogation: "Un seul administrateur disponible" });
  });
  it("une regle systeme (sans auteur) n'a pas de separation a verifier", () => {
    expect(appro({ creeParId: null, statut: "BROUILLON" })).toEqual({ ok: true, derogation: null });
  });
});
