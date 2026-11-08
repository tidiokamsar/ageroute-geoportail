import { describe, expect, it } from "vitest";
import {
  STATUTS_DEMANDE, TRANSITIONS_DEMANDE, evaluerModificationDemande, evaluerTransitionDemande, transitionsDemandePossibles,
  type CorpsStatutDemande, type StatutDemande,
} from "./demandes.noyau";

const AUJ = "2026-11-07";
const envoi: CorpsStatutDemande = { vers: "ENVOYEE", canalEnvoi: "courriel", dateEnvoi: "2026-11-06" };
const eval_ = (de: StatutDemande, corps: CorpsStatutDemande, dateEnvoiEnregistree: string | null = null) => evaluerTransitionDemande({ de, corps, aujourdhui: AUJ, dateEnvoiEnregistree });

describe("demande de donnees : graphe des etats", () => {
  it("six transitions exactement", () => {
    expect(TRANSITIONS_DEMANDE.map((t) => `${t.de}>${t.vers}`).sort()).toEqual([
      "BROUILLON>ANNULEE", "BROUILLON>ENVOYEE", "ENVOYEE>ANNULEE", "ENVOYEE>CLOTUREE", "ENVOYEE>RECUE", "RECUE>CLOTUREE",
    ]);
  });

  it("transitions possibles depuis chaque etat ; aucune depuis un etat terminal", () => {
    expect(transitionsDemandePossibles("BROUILLON").sort()).toEqual(["ANNULEE", "ENVOYEE"]);
    expect(transitionsDemandePossibles("ENVOYEE").sort()).toEqual(["ANNULEE", "CLOTUREE", "RECUE"]);
    expect(transitionsDemandePossibles("RECUE")).toEqual(["CLOTUREE"]);
    expect(transitionsDemandePossibles("CLOTUREE")).toEqual([]);
    expect(transitionsDemandePossibles("ANNULEE")).toEqual([]);
  });

  it("toute transition absente du graphe est refusee 409 TRANSITION_INTERDITE (sauf depuis un etat terminal : STATUT_INCOMPATIBLE)", () => {
    const corps = (vers: StatutDemande): CorpsStatutDemande => (vers === "ENVOYEE" ? envoi : vers === "RECUE" ? { vers, dateReception: AUJ } : { vers: vers as "CLOTUREE", justification: "motif suffisamment long" });
    for (const de of STATUTS_DEMANDE) {
      for (const vers of ["ENVOYEE", "RECUE", "CLOTUREE", "ANNULEE"] as const) {
        const permis = TRANSITIONS_DEMANDE.some((t) => t.de === de && t.vers === vers);
        const r = eval_(de, corps(vers), "2026-11-01");
        if (permis) expect(r.ok, `${de}>${vers}`).toBe(true);
        else expect(r, `${de}>${vers}`).toMatchObject({ ok: false, code: de === "CLOTUREE" || de === "ANNULEE" ? "STATUT_INCOMPATIBLE" : "TRANSITION_INTERDITE", status: 409 });
      }
    }
  });
});

describe("enregistrement de l'envoi (fait HORS application)", () => {
  it("accepte canal, date passee, reference et interlocuteur ; rend ce qu'il faut ecrire, sans espaces de bord", () => {
    const r = eval_("BROUILLON", { vers: "ENVOYEE", canalEnvoi: "  courrier  ", dateEnvoi: AUJ, referenceEnvoi: " N 12/2026 ", interlocuteur: "Service reseaux" });
    expect(r).toEqual({ ok: true, effet: { vers: "ENVOYEE", canalEnvoi: "courrier", dateEnvoi: AUJ, referenceEnvoi: "N 12/2026", interlocuteur: "Service reseaux" } });
  });

  it("reference et interlocuteur sont facultatifs", () => {
    expect(eval_("BROUILLON", envoi)).toMatchObject({ ok: true, effet: { referenceEnvoi: null, interlocuteur: null } });
  });

  it("canal vide ou trop long : 400 ; date d'envoi dans le futur ou impossible : 422 DATE_INVALIDE", () => {
    expect(eval_("BROUILLON", { ...envoi, canalEnvoi: "   " } as CorpsStatutDemande)).toMatchObject({ ok: false, status: 400 });
    expect(eval_("BROUILLON", { ...envoi, canalEnvoi: "x".repeat(101) } as CorpsStatutDemande)).toMatchObject({ ok: false, status: 400 });
    expect(eval_("BROUILLON", { ...envoi, dateEnvoi: "2026-11-08" } as CorpsStatutDemande)).toMatchObject({ ok: false, status: 422, code: "DATE_INVALIDE" });
    expect(eval_("BROUILLON", { ...envoi, dateEnvoi: "2026-02-30" } as CorpsStatutDemande)).toMatchObject({ ok: false, status: 422, code: "DATE_INVALIDE" });
  });

  it("une reference ou un interlocuteur avec un caractere de controle est refuse", () => {
    expect(eval_("BROUILLON", { ...envoi, referenceEnvoi: "a\u0000b" } as CorpsStatutDemande)).toMatchObject({ ok: false, status: 400 });
    expect(eval_("BROUILLON", { ...envoi, interlocuteur: "a\u0001b" } as CorpsStatutDemande)).toMatchObject({ ok: false, status: 400 });
  });
});

describe("reception, cloture, annulation", () => {
  it("reception : date passee, pas avant la date d'envoi enregistree ; le lien vers un jeu est facultatif", () => {
    expect(eval_("ENVOYEE", { vers: "RECUE", dateReception: "2026-11-06" }, "2026-11-06")).toMatchObject({ ok: true, effet: { vers: "RECUE", jeuRecuId: null, note: null } });
    expect(eval_("ENVOYEE", { vers: "RECUE", dateReception: "2026-11-05" }, "2026-11-06")).toMatchObject({ ok: false, status: 422, code: "DATE_INVALIDE" });
    expect(eval_("ENVOYEE", { vers: "RECUE", dateReception: "2026-11-08" }, "2026-11-06")).toMatchObject({ ok: false, status: 422, code: "DATE_INVALIDE" });
    expect(eval_("ENVOYEE", { vers: "RECUE", dateReception: AUJ, jeuRecuId: "00000000-0000-4000-8000-000000000001", note: " reçu par courriel " }, "2026-11-06"))
      .toMatchObject({ ok: true, effet: { jeuRecuId: "00000000-0000-4000-8000-000000000001", note: "reçu par courriel" } });
  });

  it("cloture et annulation exigent un motif de 10 caracteres (422 JUSTIFICATION_REQUISE)", () => {
    expect(eval_("RECUE", { vers: "CLOTUREE", justification: "court" })).toMatchObject({ ok: false, status: 422, code: "JUSTIFICATION_REQUISE" });
    expect(eval_("ENVOYEE", { vers: "ANNULEE", justification: "   " })).toMatchObject({ ok: false, status: 422, code: "JUSTIFICATION_REQUISE" });
    expect(eval_("ENVOYEE", { vers: "CLOTUREE", justification: "  clos faute de reponse  " })).toEqual({ ok: true, effet: { vers: "CLOTUREE", motifFin: "clos faute de reponse" } });
  });

  it("une demande close ou annulee ne change plus", () => {
    expect(eval_("CLOTUREE", { vers: "ANNULEE", justification: "motif suffisamment long" })).toMatchObject({ ok: false, status: 409, code: "STATUT_INCOMPATIBLE" });
  });
});

describe("modification selon l'etat", () => {
  const m = (statut: StatutDemande, champs: Parameters<typeof evaluerModificationDemande>[0]["champs"]) => evaluerModificationDemande({ statut, champs });

  it("brouillon : objet, description, echeance ; rien d'autre", () => {
    expect(m("BROUILLON", { objet: "Nouvel objet", description: "d", echeance: "2026-12-31" })).toEqual({ ok: true });
    expect(m("BROUILLON", { jeuRecuId: "x" })).toMatchObject({ ok: false, status: 409, code: "STATUT_INCOMPATIBLE" });
  });

  it("envoyee : l'echeance seule, avec une justification de 10 caracteres", () => {
    expect(m("ENVOYEE", { echeance: "2026-12-31", justification: "prolongation accordee" })).toEqual({ ok: true });
    expect(m("ENVOYEE", { echeance: "2026-12-31" })).toMatchObject({ ok: false, status: 422, code: "JUSTIFICATION_REQUISE" });
    expect(m("ENVOYEE", { objet: "autre objet", justification: "motif suffisamment long" })).toMatchObject({ ok: false, status: 409 });
  });

  it("recue : le lien vers le jeu recu seul", () => {
    expect(m("RECUE", { jeuRecuId: "00000000-0000-4000-8000-000000000001" })).toEqual({ ok: true });
    expect(m("RECUE", { jeuRecuId: null })).toEqual({ ok: true });
    expect(m("RECUE", { echeance: "2026-12-31" })).toMatchObject({ ok: false, status: 409 });
  });

  it("terminale : rien ; aucun champ : 400 ; echeance impossible : 422", () => {
    expect(m("CLOTUREE", { objet: "x" })).toMatchObject({ ok: false, status: 409, code: "STATUT_INCOMPATIBLE" });
    expect(m("ANNULEE", { echeance: "2026-12-31" })).toMatchObject({ ok: false, status: 409 });
    expect(m("BROUILLON", {})).toMatchObject({ ok: false, status: 400 });
    expect(m("BROUILLON", { echeance: "2026-02-30" })).toMatchObject({ ok: false, status: 422, code: "DATE_INVALIDE" });
  });
});
