import { describe, expect, it } from "vitest";
import {
  TRANSITIONS, decisionsEnVigueur, evaluerTransition, transitionsPossibles, verifierModificationDossier, verifierPropositionDecision, verifierResponsable,
  verifierSeparationCloture, verifierSeparationDecision, verifierTranchage, type EntreeTransition,
} from "./etats.noyau";
import { STATUTS_CONFLIT, type OptionDecision, type StatutConflit } from "./types.noyau";

const JUSTIF = "Controle effectue avec le chef de projet";
const dec = (option: OptionDecision, proposeParId = "u-prop") => ({ id: "d1", option, proposeParId });

/** Entree complete : tout est present, la demande ne peut echouer que sur ce que le test retire. */
function entree(de: StatutConflit, vers: StatutConflit, surcharge: Partial<EntreeTransition> = {}): EntreeTransition {
  return { de, vers, role: "ADMIN", acteurId: "u-admin", justification: JUSTIF, nbPreuves: 1, decisionsApprouvees: [dec("PROTEGER")], proposeurClotureId: "u-autre", ...surcharge };
}

const VALIDES: [StatutConflit, StatutConflit][] = [
  ["A_INVESTIGUER", "POTENTIEL"], ["A_INVESTIGUER", "INFIRME"],
  ["POTENTIEL", "CONFIRME"], ["POTENTIEL", "INFIRME"], ["POTENTIEL", "A_INVESTIGUER"],
  ["CONFIRME", "TRAITEMENT_DECIDE"], ["CONFIRME", "INFIRME"],
  ["TRAITEMENT_DECIDE", "CLOTURE"], ["TRAITEMENT_DECIDE", "INFIRME"],
  ["INFIRME", "A_INVESTIGUER"],
];
const ADMIN_SEUL = new Set(["CONFIRME>INFIRME", "TRAITEMENT_DECIDE>INFIRME", "TRAITEMENT_DECIDE>CLOTURE"]);
const cle = (de: string, vers: string) => `${de}>${vers}`;

describe("tableau 4 : les transitions", () => {
  it("le tableau compte exactement dix transitions, toutes entre statuts connus", () => {
    expect(TRANSITIONS).toHaveLength(10);
    expect(TRANSITIONS.map((t) => cle(t.de, t.vers)).sort()).toEqual(VALIDES.map(([a, b]) => cle(a, b)).sort());
  });

  it("sur les 36 couples (de, vers), seules les 10 transitions du tableau passent ; les 26 autres sont 409 TRANSITION_INTERDITE", () => {
    let interdites = 0, valides = 0;
    for (const de of STATUTS_CONFLIT) {
      for (const vers of STATUTS_CONFLIT) {
        const v = evaluerTransition(entree(de, vers, { recolementAValider: true }));
        if (VALIDES.some(([a, b]) => a === de && b === vers)) { expect(v.ok, cle(de, vers)).toBe(true); valides += 1; }
        else {
          expect(v.ok, cle(de, vers)).toBe(false);
          if (!v.ok) { expect(v.status).toBe(409); expect(v.code).toBe("TRANSITION_INTERDITE"); }
          interdites += 1;
        }
      }
    }
    expect(valides).toBe(10);
    expect(interdites).toBe(26);
  });

  it("aucune sortie de CLOTURE, et un statut ne passe pas vers lui-meme", () => {
    for (const vers of STATUTS_CONFLIT) {
      const v = evaluerTransition(entree("CLOTURE", vers));
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.code).toBe("TRANSITION_INTERDITE");
    }
    for (const s of STATUTS_CONFLIT) expect(evaluerTransition(entree(s, s)).ok).toBe(false);
  });

  it("la transition interdite est refusee AVANT le role : un lecteur recoit 409, pas 403", () => {
    const v = evaluerTransition(entree("CLOTURE", "POTENTIEL", { role: "LECTEUR" }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("TRANSITION_INTERDITE");
  });
});

describe("roles : qui peut quoi", () => {
  it("un ADMIN peut toute transition du tableau (preuve, decision et mention fournies)", () => {
    for (const [de, vers] of VALIDES) expect(evaluerTransition(entree(de, vers, { recolementAValider: true })).ok, cle(de, vers)).toBe(true);
  });

  it("un GESTIONNAIRE peut les transitions ADMIN/GESTIONNAIRE et recoit 403 ROLE_INSUFFISANT sur les trois reservees a l'ADMIN", () => {
    for (const [de, vers] of VALIDES) {
      const v = evaluerTransition(entree(de, vers, { role: "GESTIONNAIRE", acteurId: "u-gest" }));
      if (ADMIN_SEUL.has(cle(de, vers))) {
        expect(v.ok, cle(de, vers)).toBe(false);
        if (!v.ok) { expect(v.status).toBe(403); expect(v.code).toBe("ROLE_INSUFFISANT"); }
      } else expect(v.ok, cle(de, vers)).toBe(true);
    }
  });

  it("un LECTEUR, un INSPECTEUR, un role inconnu et un acteur non identifie n'agissent jamais (403)", () => {
    for (const role of ["LECTEUR", "INSPECTEUR", "SUPER", ""]) {
      for (const [de, vers] of VALIDES) {
        const v = evaluerTransition(entree(de, vers, { role }));
        expect(v.ok, `${role} ${cle(de, vers)}`).toBe(false);
        if (!v.ok) expect(v.status).toBe(403);
      }
    }
    const anonyme = evaluerTransition(entree("A_INVESTIGUER", "POTENTIEL", { acteurId: null }));
    expect(anonyme.ok).toBe(false);
    if (!anonyme.ok) expect(anonyme.status).toBe(403);
  });
});

describe("justification", () => {
  it("chaque transition exige 10 caracteres au moins, apres retrait des espaces de bord : 422 JUSTIFICATION_REQUISE", () => {
    for (const [de, vers] of VALIDES) {
      for (const j of [undefined, "", "          ", "neuf cars", "  123456789  "]) {
        const v = evaluerTransition(entree(de, vers, { justification: j, recolementAValider: true }));
        expect(v.ok, `${cle(de, vers)} [${j}]`).toBe(false);
        if (!v.ok) { expect(v.status).toBe(422); expect(v.code).toBe("JUSTIFICATION_REQUISE"); }
      }
      expect(evaluerTransition(entree(de, vers, { justification: "  1234567890  ", recolementAValider: true })).ok, cle(de, vers)).toBe(true);
    }
  });

  it("la justification retenue est celle rognee", () => {
    const v = evaluerTransition(entree("A_INVESTIGUER", "POTENTIEL", { justification: `   ${JUSTIF}   ` }));
    expect(v.ok && v.justification).toBe(JUSTIF);
  });
});

describe("preuve requise pour CONFIRME, decision approuvee requise pour TRAITEMENT_DECIDE", () => {
  it("POTENTIEL vers CONFIRME sans preuve : 409 PREUVE_REQUISE ; avec une preuve : passe", () => {
    const sans = evaluerTransition(entree("POTENTIEL", "CONFIRME", { nbPreuves: 0 }));
    expect(sans.ok).toBe(false);
    if (!sans.ok) { expect(sans.status).toBe(409); expect(sans.code).toBe("PREUVE_REQUISE"); }
    expect(evaluerTransition(entree("POTENTIEL", "CONFIRME", { nbPreuves: 1 })).ok).toBe(true);
  });

  it("la preuve n'est exigee que pour CONFIRME", () => {
    for (const [de, vers] of VALIDES.filter(([, v]) => v !== "CONFIRME")) {
      expect(evaluerTransition(entree(de, vers, { nbPreuves: 0, recolementAValider: true })).ok, cle(de, vers)).toBe(true);
    }
  });

  it("CONFIRME vers TRAITEMENT_DECIDE sans decision approuvee : 409 DECISION_REQUISE ; avec : passe", () => {
    const sans = evaluerTransition(entree("CONFIRME", "TRAITEMENT_DECIDE", { decisionsApprouvees: [] }));
    expect(sans.ok).toBe(false);
    if (!sans.ok) { expect(sans.status).toBe(409); expect(sans.code).toBe("DECISION_REQUISE"); }
    expect(evaluerTransition(entree("CONFIRME", "TRAITEMENT_DECIDE")).ok).toBe(true);
  });

  it("le role est controle avant la preuve, la justification avant la preuve", () => {
    const r = evaluerTransition(entree("POTENTIEL", "CONFIRME", { role: "LECTEUR", nbPreuves: 0, justification: "" }));
    expect(!r.ok && r.code).toBe("ROLE_INSUFFISANT");
    const j = evaluerTransition(entree("POTENTIEL", "CONFIRME", { nbPreuves: 0, justification: "" }));
    expect(!j.ok && j.code).toBe("JUSTIFICATION_REQUISE");
  });
});

describe("cloture : mention du recolement et separation des taches", () => {
  const cloture = (s: Partial<EntreeTransition> = {}) => evaluerTransition(entree("TRAITEMENT_DECIDE", "CLOTURE", s));

  it("sans deplacement de reseau decide, aucune mention n'est exigee", () => {
    const v = cloture({ decisionsApprouvees: [dec("PROTEGER"), dec("A_ETUDIER")] });
    expect(v.ok && v.recolementMentionne).toBe(false);
  });

  it("avec une decision DEPLACER_RESEAU approuvee, la mention du recolement est exigee (422) ; fournie, elle est enregistree", () => {
    const sans = cloture({ decisionsApprouvees: [dec("DEPLACER_RESEAU")] });
    expect(sans.ok).toBe(false);
    if (!sans.ok) { expect(sans.status).toBe(422); expect(sans.code).toBe("MENTION_RECOLEMENT_REQUISE"); }
    const faux = cloture({ decisionsApprouvees: [dec("DEPLACER_RESEAU")], recolementAValider: false });
    expect(faux.ok).toBe(false);
    const avec = cloture({ decisionsApprouvees: [dec("DEPLACER_RESEAU")], recolementAValider: true });
    expect(avec.ok && avec.recolementMentionne).toBe(true);
  });

  it("la personne qui a place le dossier en traitement decide ne le cloture pas : 409 SEPARATION_DES_TACHES", () => {
    const v = cloture({ acteurId: "u-admin", proposeurClotureId: "u-admin" });
    expect(v.ok).toBe(false);
    if (!v.ok) { expect(v.status).toBe(409); expect(v.code).toBe("SEPARATION_DES_TACHES"); }
  });

  it("... sauf derogation motivee d'un ADMIN, qui est alors rendue pour etre tracee", () => {
    const v = cloture({ acteurId: "u-admin", proposeurClotureId: "u-admin", derogation: "Seul administrateur disponible ce jour" });
    expect(v.ok && v.derogation).toBe("Seul administrateur disponible ce jour");
    const courte = cloture({ acteurId: "u-admin", proposeurClotureId: "u-admin", derogation: "urgent" });
    expect(courte.ok).toBe(false);
  });

  it("une personne differente cloture sans derogation (et aucune derogation n'est enregistree si elle en donne une inutilement)", () => {
    const v = cloture({ acteurId: "u-admin", proposeurClotureId: "u-gest", derogation: "inutile mais fournie" });
    expect(v.ok && v.derogation).toBe(null);
  });

  it("proposeur inconnu (dossier ancien) : pas de blocage", () => {
    expect(cloture({ proposeurClotureId: null }).ok).toBe(true);
  });

  it("verifierSeparationCloture seul : un non-ADMIN avec derogation est refuse", () => {
    const v = verifierSeparationCloture({ acteurId: "u1", role: "GESTIONNAIRE", proposeurClotureId: "u1", derogation: "motif assez long" });
    expect(v.ok).toBe(false);
  });
});

describe("separation des taches des decisions", () => {
  const base = { proposeurId: "u-prop", acteurId: "u-autre", role: "GESTIONNAIRE", nbHabilites: 3, derogation: undefined as string | undefined };

  it("une personne differente tranche sans derogation, pour toutes les options", () => {
    for (const option of ["PROTEGER", "ADAPTER_PROJET", "DEPLACER_RESEAU", "SANS_INTERVENTION", "A_ETUDIER"] as OptionDecision[]) {
      const v = verifierSeparationDecision({ ...base, option });
      expect(v.ok && v.derogation, option).toBe(null);
    }
  });

  it("la meme personne sans derogation : 409 SEPARATION_DES_TACHES, pour toutes les options", () => {
    for (const option of ["PROTEGER", "ADAPTER_PROJET", "DEPLACER_RESEAU", "SANS_INTERVENTION", "A_ETUDIER"] as OptionDecision[]) {
      for (const nbHabilites of [1, 2, 5]) {
        const v = verifierSeparationDecision({ ...base, option, acteurId: "u-prop", role: "ADMIN", nbHabilites });
        expect(v.ok, `${option} ${nbHabilites}`).toBe(false);
        if (!v.ok) { expect(v.status).toBe(409); expect(v.code).toBe("SEPARATION_DES_TACHES"); }
      }
    }
  });

  it("DEPLACER_RESEAU, meme personne : derogation d'un ADMIN seulement, meme s'il n'y a qu'un compte habilite", () => {
    const motif = "Responsable absent, decision urgente";
    expect(verifierSeparationDecision({ ...base, option: "DEPLACER_RESEAU", acteurId: "u-prop", role: "ADMIN", nbHabilites: 1, derogation: motif })).toEqual({ ok: true, derogation: motif });
    for (const nbHabilites of [1, 2]) {
      const v = verifierSeparationDecision({ ...base, option: "DEPLACER_RESEAU", acteurId: "u-prop", role: "GESTIONNAIRE", nbHabilites, derogation: motif });
      expect(v.ok).toBe(false);
    }
  });

  it("autres options, meme personne : avec au moins deux comptes habilites seul un ADMIN deroge ; avec un seul compte la derogation motivee suffit", () => {
    const motif = "Seul compte habilite sur le projet";
    expect(verifierSeparationDecision({ ...base, option: "PROTEGER", acteurId: "u-prop", role: "GESTIONNAIRE", nbHabilites: 1, derogation: motif })).toEqual({ ok: true, derogation: motif });
    expect(verifierSeparationDecision({ ...base, option: "PROTEGER", acteurId: "u-prop", role: "GESTIONNAIRE", nbHabilites: 2, derogation: motif }).ok).toBe(false);
    expect(verifierSeparationDecision({ ...base, option: "PROTEGER", acteurId: "u-prop", role: "ADMIN", nbHabilites: 2, derogation: motif })).toEqual({ ok: true, derogation: motif });
  });

  it("une derogation trop courte ne vaut rien", () => {
    expect(verifierSeparationDecision({ ...base, option: "PROTEGER", acteurId: "u-prop", role: "ADMIN", nbHabilites: 1, derogation: "urgent" }).ok).toBe(false);
  });
});

describe("proposition et tranchage d'une decision", () => {
  const prop = (s: Partial<Parameters<typeof verifierPropositionDecision>[0]> = {}) => verifierPropositionDecision({
    statutConflit: "CONFIRME", option: "PROTEGER", justification: JUSTIF, dateDebutPrevue: null, dateFinPrevue: null, responsableId: null, ...s,
  });

  it("une decision ne se propose que pour un conflit CONFIRME : 409 STATUT_INCOMPATIBLE pour les cinq autres statuts", () => {
    for (const s of STATUTS_CONFLIT.filter((x) => x !== "CONFIRME")) {
      const v = prop({ statutConflit: s });
      expect(v.ok, s).toBe(false);
      if (!v.ok) { expect(v.status).toBe(409); expect(v.code).toBe("STATUT_INCOMPATIBLE"); }
    }
    expect(prop().ok).toBe(true);
  });

  it("justification trop courte : 422", () => {
    const v = prop({ justification: "court" });
    expect(!v.ok && v.code).toBe("JUSTIFICATION_REQUISE");
  });

  it("DEPLACER_RESEAU exige un responsable (422 RESPONSABLE_REQUIS) puis un planning complet (422 PLANNING_REQUIS) : AT-09", () => {
    const sansResp = prop({ option: "DEPLACER_RESEAU", dateDebutPrevue: "2026-12-01", dateFinPrevue: "2026-12-15" });
    expect(!sansResp.ok && sansResp.code).toBe("RESPONSABLE_REQUIS");
    const sansPlan = prop({ option: "DEPLACER_RESEAU", responsableId: "u1" });
    expect(!sansPlan.ok && sansPlan.code).toBe("PLANNING_REQUIS");
    const demi = prop({ option: "DEPLACER_RESEAU", responsableId: "u1", dateDebutPrevue: "2026-12-01" });
    expect(!demi.ok && demi.code).toBe("PLANNING_REQUIS");
    expect(prop({ option: "DEPLACER_RESEAU", responsableId: "u1", dateDebutPrevue: "2026-12-01", dateFinPrevue: "2026-12-15" }).ok).toBe(true);
  });

  it("les autres options n'exigent ni responsable ni planning, mais des dates inversees sont refusees", () => {
    expect(prop({ option: "A_ETUDIER" }).ok).toBe(true);
    const v = prop({ option: "PROTEGER", dateDebutPrevue: "2026-12-15", dateFinPrevue: "2026-12-01" });
    expect(v.ok).toBe(false);
  });

  it("trancher : seule une decision PROPOSEE se tranche (409 DECISION_DEJA_TRANCHEE) ; motif de 10 caracteres (422)", () => {
    for (const s of ["APPROUVEE", "REFUSEE", "ANNULEE"]) {
      const v = verifierTranchage({ statutDecision: s, motif: JUSTIF });
      expect(!v.ok && v.code, s).toBe("DECISION_DEJA_TRANCHEE");
    }
    expect(verifierTranchage({ statutDecision: "PROPOSEE", motif: "court" })).toMatchObject({ ok: false, code: "JUSTIFICATION_REQUISE", status: 422 });
    expect(verifierTranchage({ statutDecision: "PROPOSEE", motif: `  ${JUSTIF} ` })).toEqual({ ok: true, motif: JUSTIF });
  });
});

describe("transitions possibles pour la fiche", () => {
  const poss = (de: StatutConflit, role: string, nbPreuves = 0, nbDecisionsApprouvees = 0) => transitionsPossibles({ de, role, nbPreuves, nbDecisionsApprouvees });

  it("un compte qui ne decide pas n'a aucune action", () => {
    for (const role of ["LECTEUR", "INSPECTEUR", ""]) for (const s of STATUTS_CONFLIT) expect(poss(s, role)).toEqual([]);
  });

  it("les actions proposees sont celles du tableau pour le role, rien d'autre (aucune action « deplacer » ni « ordonner »)", () => {
    expect(poss("A_INVESTIGUER", "GESTIONNAIRE").map((x) => x.vers).sort()).toEqual(["INFIRME", "POTENTIEL"]);
    expect(poss("POTENTIEL", "GESTIONNAIRE").map((x) => x.vers).sort()).toEqual(["A_INVESTIGUER", "CONFIRME", "INFIRME"]);
    expect(poss("CONFIRME", "GESTIONNAIRE").map((x) => x.vers)).toEqual(["TRAITEMENT_DECIDE"]);
    expect(poss("CONFIRME", "ADMIN").map((x) => x.vers).sort()).toEqual(["INFIRME", "TRAITEMENT_DECIDE"]);
    expect(poss("TRAITEMENT_DECIDE", "GESTIONNAIRE")).toEqual([]);
    expect(poss("TRAITEMENT_DECIDE", "ADMIN").map((x) => x.vers).sort()).toEqual(["CLOTURE", "INFIRME"]);
    expect(poss("CLOTURE", "ADMIN")).toEqual([]);
    expect(poss("INFIRME", "ADMIN").map((x) => x.vers)).toEqual(["A_INVESTIGUER"]);
  });

  it("une transition bloquee dit pourquoi", () => {
    expect(poss("POTENTIEL", "ADMIN", 0).find((x) => x.vers === "CONFIRME")?.bloquee).toBe("PREUVE_REQUISE");
    expect(poss("POTENTIEL", "ADMIN", 2).find((x) => x.vers === "CONFIRME")?.bloquee).toBe(null);
    expect(poss("CONFIRME", "ADMIN", 0, 0).find((x) => x.vers === "TRAITEMENT_DECIDE")?.bloquee).toBe("DECISION_REQUISE");
    expect(poss("CONFIRME", "ADMIN", 0, 1).find((x) => x.vers === "TRAITEMENT_DECIDE")?.bloquee).toBe(null);
    expect(poss("TRAITEMENT_DECIDE", "ADMIN").find((x) => x.vers === "CLOTURE")?.cloture).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------
// Revue RC-3 : m3 (approbation perimee), m4 (dossier clos, responsable d'un deplacement), responsable habilite
// ------------------------------------------------------------------------------------------------

const T0 = new Date("2026-11-01T10:00:00.000Z");
const apres = (min: number) => new Date(T0.getTime() + min * 60_000);
const decDate = (option: OptionDecision, approuveLe: Date | null | undefined) => ({ id: "d1", option, proposeParId: "u-prop", approuveLe });

describe("m3 : une approbation anterieure au dernier passage a CONFIRME est perimee", () => {
  it("decisionsEnVigueur : sans date de reference toutes comptent ; avec une reference, seules celles approuvees apres (ou a l'instant meme)", () => {
    const toutes = [decDate("PROTEGER", apres(-30)), decDate("A_ETUDIER", apres(0)), decDate("SANS_INTERVENTION", apres(10))];
    expect(decisionsEnVigueur(toutes, null)).toHaveLength(3);
    expect(decisionsEnVigueur(toutes, undefined)).toHaveLength(3);
    expect(decisionsEnVigueur(toutes, T0).map((d) => d.option)).toEqual(["A_ETUDIER", "SANS_INTERVENTION"]);
  });

  it("avec une reference, une decision dont la date d'approbation est inconnue ne compte pas (prudence)", () => {
    expect(decisionsEnVigueur([decDate("PROTEGER", null), decDate("A_ETUDIER", undefined)], T0)).toHaveLength(0);
  });

  it("CONFIRME vers TRAITEMENT_DECIDE avec la seule approbation d'une confirmation ANTERIEURE : 409 DECISION_REQUISE (avant la correction : passait)", () => {
    const v = evaluerTransition(entree("CONFIRME", "TRAITEMENT_DECIDE", { decisionsApprouvees: [decDate("PROTEGER", apres(-60))], dernierPassageConfirmeLe: T0 }));
    expect(v.ok).toBe(false);
    if (!v.ok) { expect(v.status).toBe(409); expect(v.code).toBe("DECISION_REQUISE"); expect(v.message).toMatch(/confirmation antérieure/); }
  });

  it("... avec une approbation POSTERIEURE a la derniere confirmation : passe ; avec les deux, la recente suffit", () => {
    expect(evaluerTransition(entree("CONFIRME", "TRAITEMENT_DECIDE", { decisionsApprouvees: [decDate("PROTEGER", apres(5))], dernierPassageConfirmeLe: T0 })).ok).toBe(true);
    expect(evaluerTransition(entree("CONFIRME", "TRAITEMENT_DECIDE", { decisionsApprouvees: [decDate("PROTEGER", apres(-60)), decDate("A_ETUDIER", apres(5))], dernierPassageConfirmeLe: T0 })).ok).toBe(true);
  });

  it("sans decision du tout, le message reste celui d'origine", () => {
    const v = evaluerTransition(entree("CONFIRME", "TRAITEMENT_DECIDE", { decisionsApprouvees: [], dernierPassageConfirmeLe: T0 }));
    expect(!v.ok && v.code === "DECISION_REQUISE" && /Une décision approuvée est requise/.test(v.message)).toBe(true);
  });

  it("cloture : une approbation DEPLACER_RESEAU perimee n'impose pas la mention du recolement, une approbation en vigueur l'impose", () => {
    const perimee = evaluerTransition(entree("TRAITEMENT_DECIDE", "CLOTURE", { decisionsApprouvees: [decDate("DEPLACER_RESEAU", apres(-60)), decDate("PROTEGER", apres(5))], dernierPassageConfirmeLe: T0 }));
    expect(perimee.ok).toBe(true);
    const vigueur = evaluerTransition(entree("TRAITEMENT_DECIDE", "CLOTURE", { decisionsApprouvees: [decDate("DEPLACER_RESEAU", apres(5))], dernierPassageConfirmeLe: T0 }));
    expect(!vigueur.ok && vigueur.code === "MENTION_RECOLEMENT_REQUISE").toBe(true);
  });

  it("transitionsPossibles / la fiche : le calcul de `bloquee` suit le nombre de decisions EN VIGUEUR que le service lui passe", () => {
    const t = transitionsPossibles({ de: "CONFIRME", role: "ADMIN", nbPreuves: 1, nbDecisionsApprouvees: decisionsEnVigueur([decDate("PROTEGER", apres(-60))], T0).length });
    expect(t.find((x) => x.vers === "TRAITEMENT_DECIDE")?.bloquee).toBe("DECISION_REQUISE");
  });
});

describe("m4 : un dossier clos ne se modifie plus, le responsable d'un deplacement decide ne s'efface pas", () => {
  const base = { statut: "CONFIRME" as StatutConflit, modifieChampsHumains: true, retireLeResponsable: false, deplacementPropose: false };

  it("dossier CLOTURE : toute modification d'un champ humain est refusee, 409 STATUT_INCOMPATIBLE ; un acquittement seul (aucun champ humain) passe", () => {
    const v = verifierModificationDossier({ ...base, statut: "CLOTURE" });
    expect(!v.ok && v.status === 409 && v.code === "STATUT_INCOMPATIBLE").toBe(true);
    expect(verifierModificationDossier({ ...base, statut: "CLOTURE", modifieChampsHumains: false }).ok).toBe(true);
  });

  it("les autres statuts (y compris INFIRME) se modifient comme avant", () => {
    for (const s of STATUTS_CONFLIT.filter((x) => x !== "CLOTURE")) expect(verifierModificationDossier({ ...base, statut: s }).ok, s).toBe(true);
  });

  it("retirer le responsable alors qu'un deplacement de reseau est propose ou approuve : 422 RESPONSABLE_REQUIS ; sans deplacement, ou en designant un autre, passe", () => {
    const v = verifierModificationDossier({ ...base, retireLeResponsable: true, deplacementPropose: true });
    expect(!v.ok && v.status === 422 && v.code === "RESPONSABLE_REQUIS").toBe(true);
    expect(verifierModificationDossier({ ...base, retireLeResponsable: true, deplacementPropose: false }).ok).toBe(true);
    expect(verifierModificationDossier({ ...base, retireLeResponsable: false, deplacementPropose: true }).ok).toBe(true);
  });

  it("un dossier clos est refuse avant le controle du responsable", () => {
    const v = verifierModificationDossier({ ...base, statut: "CLOTURE", retireLeResponsable: true, deplacementPropose: true });
    expect(!v.ok && v.code === "STATUT_INCOMPATIBLE").toBe(true);
  });
});

describe("responsable habilite : compte actif avec la cle du module", () => {
  it("un compte inactif, ou sans la cle `projets-voirie` (hors ADMIN), est refuse : 422 RESPONSABLE_NON_HABILITE", () => {
    const inactif = verifierResponsable({ actif: false, role: "GESTIONNAIRE", modulesAutorises: ["projets-voirie"] });
    expect(!inactif.ok && inactif.status === 422 && inactif.code === "RESPONSABLE_NON_HABILITE").toBe(true);
    const sansCle = verifierResponsable({ actif: true, role: "GESTIONNAIRE", modulesAutorises: ["troncons"] });
    expect(!sansCle.ok && sansCle.status === 422 && sansCle.code === "RESPONSABLE_NON_HABILITE").toBe(true);
    expect(verifierResponsable({ actif: true, role: "LECTEUR", modulesAutorises: [] }).ok).toBe(false);
  });

  it("un compte actif avec la cle passe ; un ADMIN passe sans la cle (il n'a aucune restriction de module)", () => {
    expect(verifierResponsable({ actif: true, role: "GESTIONNAIRE", modulesAutorises: ["projets-voirie", "troncons"] }).ok).toBe(true);
    expect(verifierResponsable({ actif: true, role: "ADMIN", modulesAutorises: [] }).ok).toBe(true);
  });
});
