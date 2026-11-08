import { describe, expect, it } from "vitest";
import {
  STATUTS_TACHE, TRANSITIONS_TACHE, evaluerTransitionTache, responsableHabilite, transitionsTachePossibles, type EntreeTransitionTache, type StatutTache,
} from "./taches.noyau";

const base: EntreeTransitionTache = {
  de: "A_FAIRE", vers: "EN_COURS", validationRequise: false, acteurId: "resp", role: "INSPECTEUR", responsableId: "resp",
  peutGerer: false, peutExecuter: true, justification: undefined, derogation: undefined, aValiderParId: null,
};
const t = (e: Partial<EntreeTransitionTache>) => evaluerTransitionTache({ ...base, ...e });
const JUSTIF = "travail realise sur le terrain";

describe("graphe des taches", () => {
  it("huit transitions, dont deux seulement dependent de la validation requise", () => {
    expect(TRANSITIONS_TACHE.map((x) => `${x.de}>${x.vers}`).sort()).toEqual([
      "A_FAIRE>ANNULEE", "A_FAIRE>EN_COURS", "A_VALIDER>ANNULEE", "A_VALIDER>EN_COURS", "A_VALIDER>TERMINEE", "EN_COURS>ANNULEE", "EN_COURS>A_VALIDER", "EN_COURS>TERMINEE",
    ]);
  });

  it("sans validation requise : EN_COURS vers TERMINEE ; A_VALIDER est interdit (la tache n'en a pas besoin)", () => {
    expect(t({ de: "EN_COURS", vers: "TERMINEE", justification: JUSTIF })).toMatchObject({ ok: true });
    expect(t({ de: "EN_COURS", vers: "A_VALIDER", justification: JUSTIF })).toMatchObject({ ok: false, status: 409, code: "TRANSITION_INTERDITE" });
  });

  it("avec validation requise : EN_COURS vers A_VALIDER ; TERMINEE directement est interdit", () => {
    expect(t({ de: "EN_COURS", vers: "A_VALIDER", validationRequise: true, justification: JUSTIF })).toMatchObject({ ok: true });
    expect(t({ de: "EN_COURS", vers: "TERMINEE", validationRequise: true, justification: JUSTIF })).toMatchObject({ ok: false, status: 409, code: "TRANSITION_INTERDITE" });
  });

  it("une transition absente du graphe, ou une tache terminale : 409", () => {
    expect(t({ de: "A_FAIRE", vers: "TERMINEE", justification: JUSTIF })).toMatchObject({ ok: false, status: 409, code: "TRANSITION_INTERDITE" });
    expect(t({ de: "EN_COURS", vers: "A_FAIRE", justification: JUSTIF })).toMatchObject({ ok: false, code: "TRANSITION_INTERDITE" });
    for (const de of ["TERMINEE", "ANNULEE"] as StatutTache[]) {
      expect(t({ de, vers: "EN_COURS", peutGerer: true, justification: JUSTIF })).toMatchObject({ ok: false, status: 409, code: "STATUT_INCOMPATIBLE" });
    }
  });
});

describe("qui fait avancer une tache", () => {
  it("le responsable demarre sa tache sans justification", () => {
    expect(t({})).toMatchObject({ ok: true, justification: null, derogation: null });
  });

  it("une autre personne sans droit de gestion n'a pas le droit (403 ACTION_NON_AUTORISEE)", () => {
    expect(t({ acteurId: "autre" })).toMatchObject({ ok: false, status: 403, code: "ACTION_NON_AUTORISEE" });
  });

  it("sans le droit `tache.executer`, meme le responsable est refuse", () => {
    expect(t({ peutExecuter: false })).toMatchObject({ ok: false, status: 403, code: "ACTION_NON_AUTORISEE" });
  });

  it("un gestionnaire des taches fait avancer la tache d'un autre", () => {
    expect(t({ acteurId: "chef", role: "GESTIONNAIRE", peutGerer: true, peutExecuter: true })).toMatchObject({ ok: true });
  });

  it("annuler, refuser une validation et valider exigent le droit de gestion, meme pour le responsable", () => {
    for (const [de, vers, validationRequise] of [["EN_COURS", "ANNULEE", false], ["A_VALIDER", "EN_COURS", true], ["A_VALIDER", "TERMINEE", true]] as const) {
      expect(t({ de, vers, validationRequise, justification: JUSTIF }), `${de}>${vers}`).toMatchObject({ ok: false, status: 403, code: "ACTION_NON_AUTORISEE" });
    }
  });

  it("une justification de 10 caracteres est exigee partout sauf au demarrage (422)", () => {
    expect(t({ de: "EN_COURS", vers: "TERMINEE", justification: "court" })).toMatchObject({ ok: false, status: 422, code: "JUSTIFICATION_REQUISE" });
    expect(t({ de: "EN_COURS", vers: "ANNULEE", peutGerer: true, justification: undefined })).toMatchObject({ ok: false, status: 422 });
    expect(t({ de: "EN_COURS", vers: "TERMINEE", justification: "  " + JUSTIF + "  " })).toMatchObject({ ok: true, justification: JUSTIF });
  });
});

describe("valider une tache : separation des taches (noyau commun avec RC-3)", () => {
  const valider = (e: Partial<EntreeTransitionTache>) => t({ de: "A_VALIDER", vers: "TERMINEE", validationRequise: true, acteurId: "chef", role: "GESTIONNAIRE", peutGerer: true, justification: JUSTIF, aValiderParId: "resp", ...e });

  it("un tiers valide sans derogation", () => {
    expect(valider({})).toMatchObject({ ok: true, derogation: null });
  });

  it("la personne qui a soumis a validation ne valide pas (409 SEPARATION_DES_TACHES)", () => {
    expect(valider({ aValiderParId: "chef", responsableId: "resp" })).toMatchObject({ ok: false, status: 409, code: "SEPARATION_DES_TACHES" });
  });

  it("le responsable ne valide pas sa propre tache, meme si c'est un autre qui l'a soumise", () => {
    expect(valider({ acteurId: "resp", aValiderParId: "chef", responsableId: "resp" })).toMatchObject({ ok: false, code: "SEPARATION_DES_TACHES" });
  });

  it("derogation motivee d'un ADMIN : accordee et tracee ; d'un GESTIONNAIRE : refusee", () => {
    expect(valider({ acteurId: "resp", role: "ADMIN", derogation: "pas d'autre validateur disponible" })).toMatchObject({ ok: true, derogation: "pas d'autre validateur disponible" });
    expect(valider({ acteurId: "resp", role: "GESTIONNAIRE", derogation: "pas d'autre validateur disponible" })).toMatchObject({ ok: false, code: "SEPARATION_DES_TACHES" });
    expect(valider({ acteurId: "resp", role: "ADMIN", derogation: "court" })).toMatchObject({ ok: false, code: "SEPARATION_DES_TACHES" });
  });
});

describe("transitions proposees a l'interface", () => {
  const p = (e: Partial<Parameters<typeof transitionsTachePossibles>[0]>) => transitionsTachePossibles({ de: "EN_COURS", validationRequise: false, acteurId: "resp", responsableId: "resp", peutGerer: false, peutExecuter: true, ...e });

  it("le responsable voit terminer ; un gestionnaire voit en plus annuler", () => {
    expect(p({}).map((x) => x.vers)).toEqual(["TERMINEE"]);
    expect(p({ peutGerer: true }).map((x) => x.vers).sort()).toEqual(["ANNULEE", "TERMINEE"]);
  });
  it("avec validation requise : A_VALIDER, et la validation est marquee comme soumise a la separation", () => {
    expect(p({ validationRequise: true }).map((x) => x.vers)).toEqual(["A_VALIDER"]);
    expect(p({ de: "A_VALIDER", validationRequise: true, peutGerer: true }).find((x) => x.vers === "TERMINEE")).toMatchObject({ separation: true, justificationRequise: true });
  });
  it("un tiers sans droit n'a rien ; une tache terminale non plus", () => {
    expect(p({ acteurId: "autre" })).toEqual([]);
    expect(p({ de: "TERMINEE", peutGerer: true })).toEqual([]);
    expect(STATUTS_TACHE).toContain("A_VALIDER");
  });
});

describe("responsable habilite", () => {
  const r = (e: Partial<Parameters<typeof responsableHabilite>[0]>) => responsableHabilite({ role: "GESTIONNAIRE", referentDuConcessionnaire: false, aDesRattachements: false, tacheConcessionnaireId: null, ...e });

  it("ADMIN, GESTIONNAIRE et INSPECTEUR peuvent etre responsables", () => {
    for (const role of ["ADMIN", "GESTIONNAIRE", "INSPECTEUR"]) expect(r({ role }), role).toEqual({ ok: true });
  });
  it("un LECTEUR non rattache ne peut pas l'etre : il ne modifie rien", () => {
    expect(r({ role: "LECTEUR" })).toMatchObject({ ok: false, status: 422, code: "RESPONSABLE_NON_HABILITE" });
  });
  it("un referent n'est responsable que d'une tache de SON concessionnaire", () => {
    const ref = { role: "LECTEUR", aDesRattachements: true };
    expect(r({ ...ref, tacheConcessionnaireId: "c1", referentDuConcessionnaire: true })).toEqual({ ok: true });
    expect(r({ ...ref, tacheConcessionnaireId: "c2", referentDuConcessionnaire: false })).toMatchObject({ ok: false, code: "RESPONSABLE_NON_HABILITE" });
    expect(r({ ...ref, tacheConcessionnaireId: null, referentDuConcessionnaire: false })).toMatchObject({ ok: false, code: "RESPONSABLE_NON_HABILITE" });
  });
});
