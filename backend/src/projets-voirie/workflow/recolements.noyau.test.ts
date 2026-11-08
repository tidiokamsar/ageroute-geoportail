import { describe, expect, it } from "vitest";
import {
  STATUTS_RECOLEMENT, TRANSITIONS_RECOLEMENT, TYPES_PREUVE_SUFFISANTE, concessionnaireDuRecolement, conflitEligible, evaluerTransitionRecolement, transitionsRecolementPossibles,
  type EntreeTransitionRecolement, type StatutRecolement,
} from "./recolements.noyau";

const base: EntreeTransitionRecolement = {
  de: "SOUMIS", vers: "VALIDE", acteurId: "valideur", role: "ADMIN", peutEcrire: true, peutValider: true, justification: "recolement conforme au constat", derogation: undefined,
  objet: "Recolement du tronçon deplace", constat: "Le reseau a ete deplace de 4 m vers le nord.", nbPreuvesSuffisantes: 1, auteursIds: ["createur", "soumetteur"],
};
const r = (e: Partial<EntreeTransitionRecolement>) => evaluerTransitionRecolement({ ...base, ...e });

describe("recolement : graphe des etats", () => {
  it("cinq transitions exactement ; VALIDE est terminal", () => {
    expect(TRANSITIONS_RECOLEMENT.map((t) => `${t.de}>${t.vers}`).sort()).toEqual(["BROUILLON>SOUMIS", "REJETE>BROUILLON", "SOUMIS>BROUILLON", "SOUMIS>REJETE", "SOUMIS>VALIDE"]);
    for (const vers of STATUTS_RECOLEMENT) expect(r({ de: "VALIDE", vers: vers as StatutRecolement }), vers).toMatchObject({ ok: false, status: 409, code: "STATUT_INCOMPATIBLE" });
  });

  it("une transition absente du graphe : 409 TRANSITION_INTERDITE", () => {
    expect(r({ de: "BROUILLON", vers: "VALIDE" })).toMatchObject({ ok: false, status: 409, code: "TRANSITION_INTERDITE" });
    expect(r({ de: "REJETE", vers: "SOUMIS" })).toMatchObject({ ok: false, code: "TRANSITION_INTERDITE" });
    expect(r({ de: "BROUILLON", vers: "REJETE" })).toMatchObject({ ok: false, code: "TRANSITION_INTERDITE" });
  });

  it("transitions proposees selon les droits", () => {
    expect(transitionsRecolementPossibles({ de: "SOUMIS", peutEcrire: true, peutValider: false }).map((x) => x.vers)).toEqual(["BROUILLON"]);
    expect(transitionsRecolementPossibles({ de: "SOUMIS", peutEcrire: false, peutValider: true }).map((x) => x.vers).sort()).toEqual(["REJETE", "VALIDE"]);
    expect(transitionsRecolementPossibles({ de: "VALIDE", peutEcrire: true, peutValider: true })).toEqual([]);
  });
});

describe("soumettre, retirer, rouvrir", () => {
  const soumettre = (e: Partial<EntreeTransitionRecolement>) => r({ de: "BROUILLON", vers: "SOUMIS", role: "GESTIONNAIRE", peutValider: false, ...e });

  it("exige le droit d'ecrire (403) et une justification de 10 caracteres (422)", () => {
    expect(soumettre({ peutEcrire: false })).toMatchObject({ ok: false, status: 403, code: "ACTION_NON_AUTORISEE" });
    expect(soumettre({ justification: "court" })).toMatchObject({ ok: false, status: 422, code: "JUSTIFICATION_REQUISE" });
    expect(soumettre({})).toMatchObject({ ok: true });
  });

  it("un recolement sans objet ou sans constat ne se soumet pas (422 CHAMPS_INCOMPLETS)", () => {
    expect(soumettre({ constat: null })).toMatchObject({ ok: false, status: 422, code: "CHAMPS_INCOMPLETS" });
    expect(soumettre({ constat: "   " })).toMatchObject({ ok: false, code: "CHAMPS_INCOMPLETS" });
    expect(soumettre({ objet: " " })).toMatchObject({ ok: false, code: "CHAMPS_INCOMPLETS" });
  });

  it("retirer (SOUMIS vers BROUILLON) et rouvrir (REJETE vers BROUILLON) relevent du droit d'ecrire, sans exiger de constat", () => {
    expect(r({ de: "SOUMIS", vers: "BROUILLON", peutValider: false, constat: null })).toMatchObject({ ok: true });
    expect(r({ de: "REJETE", vers: "BROUILLON", peutValider: false, constat: null })).toMatchObject({ ok: true });
  });
});

describe("valider : un tiers, avec une preuve qui compte", () => {
  it("un tiers valide, avec preuve et justification", () => {
    expect(r({})).toEqual({ ok: true, justification: "recolement conforme au constat", derogation: null });
  });

  it("exige le droit de valider (403) : le droit d'ecrire ne suffit pas", () => {
    expect(r({ peutValider: false, role: "GESTIONNAIRE" })).toMatchObject({ ok: false, status: 403, code: "ACTION_NON_AUTORISEE" });
  });

  it("exige au moins une preuve qui n'est pas une simple note (409 PREUVE_REQUISE)", () => {
    expect(r({ nbPreuvesSuffisantes: 0 })).toMatchObject({ ok: false, status: 409, code: "PREUVE_REQUISE" });
    expect(TYPES_PREUVE_SUFFISANTE).not.toContain("NOTE");
  });

  it("le createur ne valide pas son recolement (409 SEPARATION_DES_TACHES)", () => {
    expect(r({ acteurId: "createur" })).toMatchObject({ ok: false, status: 409, code: "SEPARATION_DES_TACHES" });
  });

  it("la personne qui l'a soumis, ni l'auteur d'une modification, ne valident pas", () => {
    expect(r({ acteurId: "soumetteur" })).toMatchObject({ ok: false, code: "SEPARATION_DES_TACHES" });
    expect(r({ acteurId: "modificateur", auteursIds: ["createur", "soumetteur", "modificateur"] })).toMatchObject({ ok: false, code: "SEPARATION_DES_TACHES" });
  });

  it("derogation motivee d'un ADMIN : accordee et rendue pour la trace ; d'un GESTIONNAIRE ou trop courte : refusee", () => {
    expect(r({ acteurId: "createur", derogation: "aucun autre valideur disponible ce mois" })).toEqual({ ok: true, justification: "recolement conforme au constat", derogation: "aucun autre valideur disponible ce mois" });
    expect(r({ acteurId: "createur", role: "GESTIONNAIRE", derogation: "aucun autre valideur disponible ce mois" })).toMatchObject({ ok: false, code: "SEPARATION_DES_TACHES" });
    expect(r({ acteurId: "createur", derogation: "court" })).toMatchObject({ ok: false, code: "SEPARATION_DES_TACHES" });
  });

  it("rejeter exige le droit de valider et une justification, mais pas de preuve ni de tiers", () => {
    expect(r({ vers: "REJETE", nbPreuvesSuffisantes: 0, acteurId: "createur" })).toMatchObject({ ok: true });
    expect(r({ vers: "REJETE", peutValider: false })).toMatchObject({ ok: false, status: 403 });
    expect(r({ vers: "REJETE", justification: "non" })).toMatchObject({ ok: false, status: 422 });
  });

  it("l'ordre des controles est stable : droit, puis justification, puis preuve, puis separation", () => {
    expect(r({ peutValider: false, justification: "x", nbPreuvesSuffisantes: 0, acteurId: "createur" })).toMatchObject({ code: "ACTION_NON_AUTORISEE" });
    expect(r({ justification: "x", nbPreuvesSuffisantes: 0, acteurId: "createur" })).toMatchObject({ code: "JUSTIFICATION_REQUISE" });
    expect(r({ nbPreuvesSuffisantes: 0, acteurId: "createur" })).toMatchObject({ code: "PREUVE_REQUISE" });
    expect(r({ acteurId: "createur" })).toMatchObject({ code: "SEPARATION_DES_TACHES" });
  });
});

describe("un recolement se rattache a un conflit dont un deplacement est decide", () => {
  const decision = (o: Partial<{ option: string; statut: string; approuveLe: Date | null }> = {}) => ({ id: "d1", option: "DEPLACER_RESEAU", statut: "APPROUVEE", proposeParId: "u", approuveLe: new Date("2026-11-03T10:00:00Z"), ...o });
  const e = (o: Partial<Parameters<typeof conflitEligible>[0]> = {}) => conflitEligible({ statut: "TRAITEMENT_DECIDE", decisions: [decision()], dernierPassageConfirmeLe: new Date("2026-11-02T10:00:00Z"), ...o });

  it("eligible : TRAITEMENT_DECIDE (ou CLOTURE) avec une decision DEPLACER_RESEAU approuvee en vigueur", () => {
    expect(e()).toEqual({ ok: true });
    expect(e({ statut: "CLOTURE" })).toEqual({ ok: true });
  });

  it("tout autre statut de conflit : 422 CONFLIT_NON_ELIGIBLE", () => {
    for (const statut of ["A_INVESTIGUER", "POTENTIEL", "CONFIRME", "INFIRME"]) expect(e({ statut }), statut).toMatchObject({ ok: false, status: 422, code: "CONFLIT_NON_ELIGIBLE" });
  });

  it("sans decision de deplacement approuvee (autre option, proposee, refusee) : 422", () => {
    expect(e({ decisions: [decision({ option: "PROTEGER" })] })).toMatchObject({ ok: false, code: "CONFLIT_NON_ELIGIBLE" });
    expect(e({ decisions: [decision({ statut: "PROPOSEE" })] })).toMatchObject({ ok: false, code: "CONFLIT_NON_ELIGIBLE" });
    expect(e({ decisions: [decision({ statut: "REFUSEE" })] })).toMatchObject({ ok: false, code: "CONFLIT_NON_ELIGIBLE" });
    expect(e({ decisions: [] })).toMatchObject({ ok: false, code: "CONFLIT_NON_ELIGIBLE" });
  });

  it("une approbation anterieure a la derniere confirmation du dossier est perimee (meme regle que la cloture de RC-3)", () => {
    expect(e({ dernierPassageConfirmeLe: new Date("2026-11-04T10:00:00Z") })).toMatchObject({ ok: false, code: "CONFLIT_NON_ELIGIBLE" });
  });

  it("concessionnaire du recolement : celui du conflit, sinon celui du jeu ; s'ils different : 422 CONCESSIONNAIRE_INCOHERENT", () => {
    expect(concessionnaireDuRecolement("c1", null)).toEqual({ ok: true, concessionnaireId: "c1" });
    expect(concessionnaireDuRecolement(null, "c2")).toEqual({ ok: true, concessionnaireId: "c2" });
    expect(concessionnaireDuRecolement("c1", "c1")).toEqual({ ok: true, concessionnaireId: "c1" });
    expect(concessionnaireDuRecolement(null, null)).toEqual({ ok: true, concessionnaireId: null });
    expect(concessionnaireDuRecolement("c1", "c2")).toMatchObject({ ok: false, status: 422, code: "CONCESSIONNAIRE_INCOHERENT" });
  });
});
