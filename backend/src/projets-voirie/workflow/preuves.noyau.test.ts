import { describe, expect, it } from "vitest";
import { TYPES_PERMIS, TYPES_PREUVE_WORKFLOW, evaluerAjoutPreuve, validerChampsPreuve, type EntreeAjoutPreuve } from "./preuves.noyau";

const base: EntreeAjoutPreuve = {
  profil: "GESTIONNAIRE", peutAjouter: true, acteurId: "u1", cible: { type: "DEMANDE", statut: "ENVOYEE" }, typePreuve: "NOTE", partageeDemandee: undefined,
};
const e = (o: Partial<EntreeAjoutPreuve>) => evaluerAjoutPreuve({ ...base, ...o });

describe("droit d'ajouter une preuve", () => {
  it("sans le droit `preuve.ajouter` : 403 (un lecteur, un auditeur)", () => {
    expect(e({ peutAjouter: false, profil: "LECTEUR" })).toMatchObject({ ok: false, status: 403, code: "ACTION_NON_AUTORISEE" });
  });

  it("un decideur ajoute a n'importe quel objet non terminal ; `partagee` est son choix, faux par defaut (note interne)", () => {
    expect(e({})).toEqual({ ok: true, partagee: false });
    expect(e({ partageeDemandee: true })).toEqual({ ok: true, partagee: true });
    for (const type of TYPES_PREUVE_WORKFLOW) expect(e({ typePreuve: type }), type).toMatchObject({ ok: true });
  });

  it("jamais a un objet terminal : demande close ou annulee, tache terminee ou annulee, recolement valide (409)", () => {
    for (const [type, statut] of [["DEMANDE", "CLOTUREE"], ["DEMANDE", "ANNULEE"], ["TACHE", "TERMINEE"], ["TACHE", "ANNULEE"], ["RECOLEMENT", "VALIDE"]] as const) {
      expect(e({ cible: { type, statut } }), `${type} ${statut}`).toMatchObject({ ok: false, status: 409, code: "STATUT_INCOMPATIBLE" });
    }
  });
});

describe("agent de terrain (INSPECTEUR)", () => {
  const a = (o: Partial<EntreeAjoutPreuve>) => e({ profil: "INSPECTEUR", cible: { type: "TACHE", statut: "EN_COURS", responsableId: "u1" }, typePreuve: "RELEVE_TERRAIN", ...o });

  it("ajoute un releve a SA tache ; la preuve n'est jamais partagee", () => {
    expect(a({})).toEqual({ ok: true, partagee: false });
    expect(a({ partageeDemandee: true })).toEqual({ ok: true, partagee: false });
  });
  it("pas a la tache d'un autre, ni a une demande ou un recolement (403)", () => {
    expect(a({ cible: { type: "TACHE", statut: "EN_COURS", responsableId: "u2" } })).toMatchObject({ ok: false, status: 403 });
    expect(a({ cible: { type: "DEMANDE", statut: "ENVOYEE" } })).toMatchObject({ ok: false, status: 403 });
    expect(a({ cible: { type: "RECOLEMENT", statut: "SOUMIS" } })).toMatchObject({ ok: false, status: 403 });
  });
  it("types limites : note, reference, releve ; pas un courrier ni une reponse de concessionnaire (403)", () => {
    expect(TYPES_PERMIS.INSPECTEUR).toEqual(["NOTE", "REFERENCE_DOCUMENT", "RELEVE_TERRAIN"]);
    for (const typePreuve of ["COURRIER", "REPONSE_CONCESSIONNAIRE", "PLAN_RECOLEMENT"] as const) expect(a({ typePreuve }), typePreuve).toMatchObject({ ok: false, status: 403 });
  });
});

describe("referent concessionnaire", () => {
  const r = (o: Partial<EntreeAjoutPreuve>) => e({ profil: "REFERENT", typePreuve: "REPONSE_CONCESSIONNAIRE", ...o });

  it("ajoute sa reponse a une demande envoyee ou recue ; la preuve est toujours partagee", () => {
    expect(r({})).toEqual({ ok: true, partagee: true });
    expect(r({ partageeDemandee: false })).toEqual({ ok: true, partagee: true });
    expect(r({ cible: { type: "DEMANDE", statut: "RECUE" } })).toMatchObject({ ok: true });
  });
  it("etats permis : tache non terminale, recolement soumis ou rejete ; jamais un brouillon", () => {
    expect(r({ cible: { type: "TACHE", statut: "A_FAIRE", responsableId: null }, typePreuve: "NOTE" })).toMatchObject({ ok: true });
    expect(r({ cible: { type: "RECOLEMENT", statut: "SOUMIS" }, typePreuve: "PLAN_RECOLEMENT" })).toMatchObject({ ok: true });
    expect(r({ cible: { type: "RECOLEMENT", statut: "REJETE" }, typePreuve: "PLAN_RECOLEMENT" })).toMatchObject({ ok: true });
    expect(r({ cible: { type: "RECOLEMENT", statut: "BROUILLON" } })).toMatchObject({ ok: false, status: 409 });
    expect(r({ cible: { type: "DEMANDE", statut: "BROUILLON" } })).toMatchObject({ ok: false, status: 409 });
  });
  it("types limites : pas de releve de terrain ni de courrier d'AGEROUTE (403)", () => {
    expect(TYPES_PERMIS.REFERENT).toEqual(["NOTE", "REFERENCE_DOCUMENT", "REPONSE_CONCESSIONNAIRE", "PLAN_RECOLEMENT"]);
    for (const typePreuve of ["RELEVE_TERRAIN", "COURRIER"] as const) expect(r({ typePreuve }), typePreuve).toMatchObject({ ok: false, status: 403 });
  });
});

describe("champs d'une preuve : references et empreintes, jamais un fichier", () => {
  const h = "b".repeat(64);
  it("normalise : espaces retires, SHA-256 en minuscules, champs vides ramenes a null", () => {
    const r = validerChampsPreuve({ texte: "  Plan de recolement recu  ", reference: " Courrier 12/2026 ", nomFichier: " plan.pdf ", sha256: ` ${h.toUpperCase()} `, tailleOctets: 123456 });
    expect(r).toEqual({ ok: true, valeurs: { texte: "Plan de recolement recu", reference: "Courrier 12/2026", nomFichier: "plan.pdf", sha256: h, tailleOctets: 123456 } });
    expect(validerChampsPreuve({ texte: "note", reference: "  ", nomFichier: "", sha256: null, tailleOctets: null })).toEqual({ ok: true, valeurs: { texte: "note", reference: null, nomFichier: null, sha256: null, tailleOctets: null } });
  });
  it("texte obligatoire de 1 a 4000 caracteres, sans caractere de controle", () => {
    expect(validerChampsPreuve({ texte: "   " })).toMatchObject({ ok: false, status: 400 });
    expect(validerChampsPreuve({ texte: "x".repeat(4001) })).toMatchObject({ ok: false, status: 400 });
    expect(validerChampsPreuve({ texte: "a\u0000b" })).toMatchObject({ ok: false, status: 400 });
    expect(validerChampsPreuve({ texte: "x".repeat(4000) })).toMatchObject({ ok: true });
  });
  it("reference : 500 caracteres au plus, jamais un schema executable (400 REFERENCE_INVALIDE)", () => {
    expect(validerChampsPreuve({ texte: "t", reference: "x".repeat(501) })).toMatchObject({ ok: false, status: 400, code: "CHAMPS_INVALIDES" });
    for (const reference of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", " JAVASCRIPT:x"]) {
      expect(validerChampsPreuve({ texte: "t", reference }), reference).toMatchObject({ ok: false, status: 400, code: "REFERENCE_INVALIDE" });
    }
  });
  it("empreinte : SHA-256 en hexadecimal seulement ; taille : entier de 0 a 2^31 - 1 ; nom de fichier : 255 caracteres", () => {
    expect(validerChampsPreuve({ texte: "t", sha256: "pas-un-hash" })).toMatchObject({ ok: false, status: 400 });
    expect(validerChampsPreuve({ texte: "t", tailleOctets: -1 })).toMatchObject({ ok: false });
    expect(validerChampsPreuve({ texte: "t", tailleOctets: 1.5 })).toMatchObject({ ok: false });
    expect(validerChampsPreuve({ texte: "t", tailleOctets: 2_147_483_648 })).toMatchObject({ ok: false });
    expect(validerChampsPreuve({ texte: "t", tailleOctets: 2_147_483_647 })).toMatchObject({ ok: true });
    expect(validerChampsPreuve({ texte: "t", nomFichier: "n".repeat(256) })).toMatchObject({ ok: false });
  });
});
