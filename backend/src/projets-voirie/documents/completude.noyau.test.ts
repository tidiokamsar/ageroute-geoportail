import { describe, expect, it } from "vitest";
import {
  calculerCompletude, CONDITIONS, CONDITIONS_PAR_FONCTION, conditionsRemplies, etatsFonctions, FONCTIONS, reseauxDepuisJeux,
  type DocumentEntree, type EntreeCompletude, type EtatProjet, type Fonction, type PieceManquante, type ReseauEtat, type TypeDocumentEntree,
} from "./completude.noyau";
import { STATUTS_DOCUMENT, type StatutDocument } from "./etats.noyau";
import { evaluerEligibilite } from "../sources/eligibilite.noyau";

/**
 * « Ce que les documents permettent » (lot D1 ; CONTRAT-DOCUMENTS.md, section 6). L'INVARIANT D'INDEPENDANCE est prouve par ENUMERATION de tous les
 * etats d'un petit univers (axes 0 a 2, cinq configurations de reseaux, decisions 0 ou 1) croises avec du « bruit documentaire » (types obligatoires
 * manquants, documents attendus, DWG recus, pieces incompletes ou rejetees) : aucune piece manquante ne bloque une fonction independante.
 */
const R = (cle: string, nbSources: number): ReseauEtat => ({ cle, concessionnaireId: `c-${cle}`, concessionnaireNom: `Concessionnaire ${cle}`, typeReseau: "TELECOM", typeReseauCode: null, nbSources, comparable: nbSources >= 2 });
const CONFIG_RESEAUX: ReseauEtat[][] = [[], [R("a", 1)], [R("a", 2)], [R("a", 1), R("b", 1)], [R("a", 1), R("b", 3)]];
const ETATS: EtatProjet[] = [];
for (const nbAxesAutorises of [0, 1, 2]) for (const reseaux of CONFIG_RESEAUX) for (const nbDecisionsDeplacement of [0, 1]) ETATS.push({ nbAxesAutorises, reseaux, nbDecisionsDeplacement });

const TYPES: TypeDocumentEntree[] = [
  { code: "PLAN_AXES", libelle: "Plan des axes", actif: true, obligatoire: true, fonctionsDebloquees: ["ANALYSE_2D", "CONFLITS"], roleJeu: "AXES_TRAVAUX" },
  { code: "RESEAU_CONCESSIONNAIRE", libelle: "Reseau", actif: true, obligatoire: true, fonctionsDebloquees: ["ANALYSE_2D", "CONFLITS", "COMPARAISON_SOURCES"], roleJeu: "RESEAU_TIERS" },
  { code: "LIMITES_ROUTE", libelle: "Limites", actif: true, obligatoire: false, fonctionsDebloquees: [], roleJeu: "LIMITES_ROUTE" },
  { code: "NOTE_SYNTHETIQUE", libelle: "Note obligatoire sans fonction", actif: true, obligatoire: true, fonctionsDebloquees: [], roleJeu: null },
  { code: "ANCIEN", libelle: "Type desactive", actif: false, obligatoire: true, fonctionsDebloquees: ["RECOLEMENT"], roleJeu: null },
];
let n = 0;
const doc = (typeCode: string, statut: StatutDocument, format: string | null = null, o: Partial<DocumentEntree> = {}): DocumentEntree => {
  n++;
  return { id: `d${n}`, ligneeId: `l${n}`, version: 1, typeCode, titre: `Document ${n}`, statut, format, concessionnaireId: null, ...o };
};
/** Bruits documentaires : rien de tout cela ne doit changer l'etat d'une fonction. */
const BRUITS: DocumentEntree[][] = [
  [],
  [doc("PLAN_AXES", "ATTENDU"), doc("RESEAU_CONCESSIONNAIRE", "ATTENDU"), doc("LIMITES_ROUTE", "ATTENDU")],
  [doc("PLAN_AXES", "RECU", "DWG"), doc("RESEAU_CONCESSIONNAIRE", "INCOMPLET", "PDF"), doc("NOTE_SYNTHETIQUE", "REJETE", "PDF")],
  [doc("PLAN_AXES", "VALIDE", "PDF"), doc("RESEAU_CONCESSIONNAIRE", "A_CORRIGER", "PDF"), doc("LIMITES_ROUTE", "EXPLOITABLE", "PDF")],
  STATUTS_DOCUMENT.map((s) => doc("RESEAU_CONCESSIONNAIRE", s, s === "ATTENDU" ? null : "PDF")),
];
const entree = (etat: EtatProjet, documents: DocumentEntree[] = [], decideur = true, types = TYPES): EntreeCompletude => ({
  etat, types, documents, decideur,
  jeuxAutorisesParRole: { AXES_TRAVAUX: etat.nbAxesAutorises, RESEAU_TIERS: etat.reseaux.reduce((s, r) => s + r.nbSources, 0) },
});
const etatDe = (c: ReturnType<typeof calculerCompletude>, f: Fonction) => c.fonctions.find((x) => x.code === f)!.etat;

describe("invariant d'independance : une fonction ne depend QUE de ses conditions", () => {
  it("pour tous les etats et tous les bruits documentaires : DISPONIBLE si et seulement si toutes ses conditions sont remplies", () => {
    let verifies = 0;
    for (const etat of ETATS) {
      const c = conditionsRemplies(etat);
      for (const bruit of BRUITS) for (const decideur of [true, false]) {
        const r = calculerCompletude(entree(etat, bruit, decideur));
        for (const f of FONCTIONS) {
          const cond = CONDITIONS_PAR_FONCTION[f];
          const attendu = cond === null ? "NON_LIVREE" : cond.every((x) => c[x].remplie) ? "DISPONIBLE" : "INDISPONIBLE";
          expect(etatDe(r, f), `${f} ${JSON.stringify(etat)}`).toBe(attendu);
          verifies++;
        }
      }
    }
    expect(verifies).toBe(ETATS.length * BRUITS.length * 2 * FONCTIONS.length);
  });

  it("changer UNE condition ne change que les fonctions qui en dependent (toutes paires d'etats qui ne different que par une condition)", () => {
    let paires = 0;
    for (const a of ETATS) for (const b of ETATS) {
      const ca = conditionsRemplies(a), cb = conditionsRemplies(b);
      const differentes = CONDITIONS.filter((x) => ca[x].remplie !== cb[x].remplie);
      if (differentes.length !== 1) continue;
      paires++;
      const fa = etatsFonctions(a), fb = etatsFonctions(b);
      for (const f of FONCTIONS) {
        if (!(CONDITIONS_PAR_FONCTION[f] ?? []).includes(differentes[0])) expect(fa[f], `${f} ne depend pas de ${differentes[0]}`).toBe(fb[f]);
      }
    }
    expect(paires).toBeGreaterThan(20);
  });

  it("les cas du contrat : axes + reseau suffisent a l'analyse 2D et aux conflits, sans decision ni seconde source ni limites ; la comparaison n'exige que deux sources ; le recolement qu'une decision", () => {
    const r = calculerCompletude(entree({ nbAxesAutorises: 1, reseaux: [R("a", 1)], nbDecisionsDeplacement: 0 }, BRUITS[2]));
    expect([etatDe(r, "ANALYSE_2D"), etatDe(r, "CONFLITS"), etatDe(r, "COMPARAISON_SOURCES"), etatDe(r, "RECOLEMENT"), etatDe(r, "EXPORT_DOSSIER")])
      .toEqual(["DISPONIBLE", "DISPONIBLE", "INDISPONIBLE", "INDISPONIBLE", "NON_LIVREE"]);
    const s = calculerCompletude(entree({ nbAxesAutorises: 0, reseaux: [R("a", 2)], nbDecisionsDeplacement: 0 }));
    expect([etatDe(s, "ANALYSE_2D"), etatDe(s, "COMPARAISON_SOURCES")]).toEqual(["INDISPONIBLE", "DISPONIBLE"]);
    const d = calculerCompletude(entree({ nbAxesAutorises: 0, reseaux: [], nbDecisionsDeplacement: 1 }));
    expect([etatDe(d, "ANALYSE_2D"), etatDe(d, "RECOLEMENT")]).toEqual(["INDISPONIBLE", "DISPONIBLE"]);
  });
});

describe("pieces manquantes : la fonction que chacune debloquerait", () => {
  const conditions = (p: PieceManquante[]) => p.filter((x): x is Extract<PieceManquante, { nature: "CONDITION" }> => x.nature === "CONDITION");

  it("rien d'autorise : axes, reseau, seconde source (generique), decision ; aucune piece ne suffit seule a l'analyse 2D (deux conditions)", () => {
    const r = calculerCompletude(entree({ nbAxesAutorises: 0, reseaux: [], nbDecisionsDeplacement: 0 }));
    const p = conditions(r.piecesManquantes);
    expect(p.map((x) => x.code)).toEqual(["PLAN_AXES_AUTORISE", "RESEAU_AUTORISE", "SECONDE_SOURCE", "DECISION_DEPLACEMENT"]);
    expect(p[0]).toMatchObject({ fonctions: ["ANALYSE_2D", "CONFLITS"], suffiraitPour: [], typesDocument: [{ code: "PLAN_AXES", libelle: "Plan des axes" }] });
    expect(p[1]).toMatchObject({ fonctions: ["ANALYSE_2D", "CONFLITS"], suffiraitPour: [], typesDocument: [{ code: "RESEAU_CONCESSIONNAIRE", libelle: "Reseau" }] });
    expect(p[2]).toMatchObject({ reseau: null, fonctions: ["COMPARAISON_SOURCES"], suffiraitPour: ["COMPARAISON_SOURCES"] });
    expect(p[3]).toMatchObject({ fonctions: ["RECOLEMENT"], suffiraitPour: ["RECOLEMENT"], typesDocument: [] });
  });

  it("reseau present sans axes : le plan d'axes SUFFIRAIT pour l'analyse 2D et les conflits ; une seconde source par reseau a source unique", () => {
    const r = calculerCompletude(entree({ nbAxesAutorises: 0, reseaux: [R("a", 1), R("b", 1)], nbDecisionsDeplacement: 1 }));
    const p = conditions(r.piecesManquantes);
    expect(p.find((x) => x.code === "PLAN_AXES_AUTORISE")).toMatchObject({ suffiraitPour: ["ANALYSE_2D", "CONFLITS"] });
    const secondes = p.filter((x) => x.code === "SECONDE_SOURCE");
    expect(secondes.map((x) => x.reseau?.concessionnaire)).toEqual(["Concessionnaire a", "Concessionnaire b"]);
    expect(secondes.every((x) => x.suffiraitPour.join() === "COMPARAISON_SOURCES")).toBe(true);
    expect(p.some((x) => x.code === "DECISION_DEPLACEMENT")).toBe(false);
  });

  it("tout est disponible : aucune piece de condition ; les fonctions deja disponibles ne sont jamais listees comme debloquees", () => {
    const r = calculerCompletude(entree({ nbAxesAutorises: 1, reseaux: [R("a", 2)], nbDecisionsDeplacement: 1 }, BRUITS[4]));
    expect(conditions(r.piecesManquantes)).toEqual([]);
    for (const p of r.piecesManquantes) {
      if (p.nature !== "DOCUMENT") expect(p.suffiraitPour).toEqual([]);
      expect(p.fonctions).toEqual([]);
    }
  });

  it("type obligatoire : fourni par un jeu AUTORISE de son role ou par un document VALIDE ; sinon manquant, avec les fonctions encore indisponibles ; un type inactif n'est jamais exige", () => {
    const sansRien = calculerCompletude(entree({ nbAxesAutorises: 0, reseaux: [], nbDecisionsDeplacement: 0 }));
    const types = sansRien.piecesManquantes.filter((p) => p.nature === "TYPE_OBLIGATOIRE").map((p) => p.nature === "TYPE_OBLIGATOIRE" ? p.typeDocument.code : "");
    expect(types).toEqual(["PLAN_AXES", "RESEAU_CONCESSIONNAIRE", "NOTE_SYNTHETIQUE"]);
    const parJeu = calculerCompletude(entree({ nbAxesAutorises: 1, reseaux: [R("a", 1)], nbDecisionsDeplacement: 0 }));
    expect(parJeu.piecesManquantes.filter((p) => p.nature === "TYPE_OBLIGATOIRE").map((p) => p.nature === "TYPE_OBLIGATOIRE" ? p.typeDocument.code : "")).toEqual(["NOTE_SYNTHETIQUE"]);
    const parDoc = calculerCompletude(entree({ nbAxesAutorises: 0, reseaux: [], nbDecisionsDeplacement: 0 }, [doc("NOTE_SYNTHETIQUE", "VALIDE", "PDF"), doc("PLAN_AXES", "EXPLOITABLE", "PDF")]));
    const restants = parDoc.piecesManquantes.filter((p) => p.nature === "TYPE_OBLIGATOIRE").map((p) => p.nature === "TYPE_OBLIGATOIRE" ? p.typeDocument.code : "");
    // EXPLOITABLE ne vaut pas validation : le plan d'axes manque encore ; la note VALIDE est fournie.
    expect(restants).toEqual(["PLAN_AXES", "RESEAU_CONCESSIONNAIRE"]);
    const note = sansRien.piecesManquantes.find((p) => p.nature === "TYPE_OBLIGATOIRE" && p.typeDocument.code === "NOTE_SYNTHETIQUE");
    expect(note).toMatchObject({ fonctions: [], suffiraitPour: [] });
  });

  it("decideur : documents en cours rattaches aux pieces et listes ; lecteur : jamais de document hors VALIDE (l'appelant ne lui en transmet pas) ni de liste de documents", () => {
    const docs = [doc("PLAN_AXES", "RECU", "DWG"), doc("RESEAU_CONCESSIONNAIRE", "ATTENDU", null, { concessionnaireId: "c-a" }), doc("RESEAU_CONCESSIONNAIRE", "ATTENDU", null, { concessionnaireId: "c-z" })];
    const d = calculerCompletude(entree({ nbAxesAutorises: 0, reseaux: [R("a", 1)], nbDecisionsDeplacement: 0 }, docs, true));
    const axes = d.piecesManquantes.find((p) => p.nature === "CONDITION" && p.code === "PLAN_AXES_AUTORISE");
    expect(axes && axes.nature === "CONDITION" ? axes.documents?.map((x) => [x.statut, x.format]) : null).toEqual([["RECU", "DWG"]]);
    const seconde = d.piecesManquantes.find((p) => p.nature === "CONDITION" && p.code === "SECONDE_SOURCE");
    // Seconde source du reseau du concessionnaire c-a : seul le document de ce concessionnaire (ou sans concessionnaire) y est rattache.
    expect(seconde && seconde.nature === "CONDITION" ? seconde.documents?.length : -1).toBe(1);
    expect(d.piecesManquantes.filter((p) => p.nature === "DOCUMENT")).toHaveLength(3);
    const l = calculerCompletude(entree({ nbAxesAutorises: 0, reseaux: [R("a", 1)], nbDecisionsDeplacement: 0 }, [], false));
    expect(l.piecesManquantes.some((p) => p.nature === "DOCUMENT" || ("documents" in p))).toBe(false);
  });

  it("une version REJETE remplacee par une version plus recente n'est plus une piece manquante (seule la derniere version de la lignee compte)", () => {
    const v1 = doc("PLAN_AXES", "REJETE", "PDF", { ligneeId: "L", version: 1 });
    const v2 = doc("PLAN_AXES", "VALIDE", "PDF", { ligneeId: "L", version: 2 });
    const r = calculerCompletude(entree({ nbAxesAutorises: 0, reseaux: [], nbDecisionsDeplacement: 0 }, [v1, v2]));
    expect(r.piecesManquantes.filter((p) => p.nature === "DOCUMENT")).toEqual([]);
    expect(r.documents).toEqual({ total: 2, parStatut: { REJETE: 1, VALIDE: 1 } });
  });
});

describe("revue D1, M1 : retrait de la derniere version", () => {
  it("une version REMPLACE dont la remplacante a ete retiree est la derniere version de la lignee : la piece reste manquante (decideur), avec les fonctions de son type", () => {
    // v1 EN_ANALYSE puis v2 deposee (v1 REMPLACE), puis v2 retiree : l'appelant ne transmet que les lignes non retirees, donc v1 seule.
    const v1 = doc("PLAN_AXES", "REMPLACE", "DWG", { ligneeId: "L-ret", version: 1 });
    const r = calculerCompletude(entree({ nbAxesAutorises: 0, reseaux: [R("a", 1)], nbDecisionsDeplacement: 0 }, [v1]));
    const p = r.piecesManquantes.find((x) => x.nature === "DOCUMENT");
    expect(p && p.nature === "DOCUMENT" ? [p.document.id, p.document.statut, p.fonctions] : null).toEqual([v1.id, "REMPLACE", ["ANALYSE_2D", "CONFLITS"]]);
    const axes = r.piecesManquantes.find((x) => x.nature === "CONDITION" && x.code === "PLAN_AXES_AUTORISE");
    expect(axes && axes.nature === "CONDITION" ? axes.documents?.map((d) => d.id) : null).toEqual([v1.id]);
  });
});

describe("reseaux depuis les jeux autorises : identite decidee par l'eligibilite du lot S1 (revue D1, M2)", () => {
  const j = (id: string, o: Partial<{ role: string; concessionnaireId: string | null; typeReseau: string | null; typeReseauCode: string | null; jour: number }> = {}) => ({
    id, projetId: "p", role: o.role ?? "RESEAU_TIERS", statut: "AUTORISE", concessionnaireId: o.concessionnaireId === undefined ? "c1" : o.concessionnaireId, concessionnaireNom: "C1",
    typeReseau: o.typeReseau === undefined ? "TELECOM" : o.typeReseau, typeReseauCode: o.typeReseauCode ?? null, methodeAcquisition: null, remplaceId: null,
    createdAt: new Date(Date.UTC(2026, 10, o.jour ?? 1)),
  });
  it("regroupe ce que l'eligibilite S1 declare comparable ; ignore les autres roles ; un reseau sans concessionnaire reste seul", () => {
    const r = reseauxDepuisJeux([j("a"), j("b", { jour: 2 }), j("c", { typeReseau: "EAU_POTABLE", jour: 3 }), j("x", { role: "AXES_TRAVAUX", concessionnaireId: null, typeReseau: null }),
      j("s1", { concessionnaireId: null, jour: 4 }), j("s2", { concessionnaireId: null, jour: 5 })]);
    expect(r.map((x) => [x.concessionnaireId, x.typeReseau, x.nbSources])).toEqual([["c1", "TELECOM", 2], ["c1", "EAU_POTABLE", 1], [null, "TELECOM", 1], [null, "TELECOM", 1]]);
  });
  it("deux types configurables de la meme famille : la completude dit exactement ce que l'eligibilite S1 dit (comparable si et seulement si elle accepte la paire)", () => {
    const a = j("a", { typeReseauCode: "FIBRE_SYNTH" }), b = j("b", { typeReseauCode: "CUIVRE_SYNTH", jour: 2 });
    const r = reseauxDepuisJeux([a, b]);
    const accepte = evaluerEligibilite(a, b).ok;
    expect(r.some((x) => x.comparable === undefined)).toBe(false);
    expect(r.length === 1 && r[0].nbSources === 2).toBe(accepte);
    expect(r.map((x) => x.typeReseauCode)).toEqual(accepte ? ["FIBRE_SYNTH"] : ["FIBRE_SYNTH", "CUIVRE_SYNTH"]);
  });
});

describe("revue D1, m5 : piece VALIDE liee a un jeu retire", () => {
  it("ne fournit plus son type obligatoire (le type redevient une piece manquante)", () => {
    const etat = { nbAxesAutorises: 0, reseaux: [], nbDecisionsDeplacement: 0 };
    const fournie = calculerCompletude(entree(etat, [doc("NOTE_SYNTHETIQUE", "VALIDE", "PDF")]));
    const retire = calculerCompletude(entree(etat, [doc("NOTE_SYNTHETIQUE", "VALIDE", "LANDXML", { jeuRetire: true })]));
    const manque = (c: ReturnType<typeof calculerCompletude>) => c.piecesManquantes.some((p) => p.nature === "TYPE_OBLIGATOIRE" && p.typeDocument.code === "NOTE_SYNTHETIQUE");
    expect([manque(fournie), manque(retire)]).toEqual([false, true]);
  });
});
