import { describe, expect, it } from "vitest";
import {
  STATUTS_TACHE, TRANSITIONS_TACHE, alertesRapprochement, champsContractuels, enRetard, estTerminee,
  manquesPourCloture, motifAbandonValide, transitionTachePermise, type TachePourRapprochement,
} from "./taches-internes.regles";

/**
 * TI-01 / A29 : les regles des taches internes, sans base.
 *
 * La base refuse deja une tache cloturee sans preuves (contraintes, `taches_internes.test.sql`, 22
 * assertions). Ces tests defendent ce qu'elle ne peut pas dire : POURQUOI, dans quel ordre, et ce
 * qui n'est pas un refus de la base (transitions, retard, alertes).
 */
const d = (s: string) => new Date(s);
const preuves = (avant: string | null, apres: string | null) => ({
  avantChemin: avant ? "a.jpg" : null, avantPriseLe: avant ? d(avant) : null,
  apresChemin: apres ? "b.jpg" : null, apresPriseLe: apres ? d(apres) : null,
});

describe("transitions", () => {
  it("OUVERTE -> EN_COURS -> CLOTUREE, ou ABANDONNEE depuis n'importe quel etat non terminal", () => {
    expect(transitionTachePermise("OUVERTE", "EN_COURS")).toBe(true);
    expect(transitionTachePermise("EN_COURS", "CLOTUREE")).toBe(true);
    expect(transitionTachePermise("OUVERTE", "ABANDONNEE")).toBe(true);
    expect(transitionTachePermise("EN_COURS", "ABANDONNEE")).toBe(true);
  });

  it("une intervention courte se cloture directement depuis OUVERTE (les preuves restent exigees)", () => {
    expect(transitionTachePermise("OUVERTE", "CLOTUREE")).toBe(true);
  });

  it("CLOTUREE et ABANDONNEE sont TERMINALES : rien n'en sort, pas meme vers l'autre", () => {
    for (const fin of ["CLOTUREE", "ABANDONNEE"] as const) {
      expect(TRANSITIONS_TACHE[fin]).toEqual([]);
      for (const vers of STATUTS_TACHE) expect(transitionTachePermise(fin, vers)).toBe(false);
      expect(estTerminee(fin)).toBe(true);
    }
  });

  it("on ne revient pas en arriere : EN_COURS ne redevient pas OUVERTE", () => {
    expect(transitionTachePermise("EN_COURS", "OUVERTE")).toBe(false);
    expect(estTerminee("OUVERTE")).toBe(false);
  });
});

describe("ce qui manque pour cloturer", () => {
  it("rien ne manque avec les deux preuves, apres posterieure ou egale a avant", () => {
    expect(manquesPourCloture(preuves("2026-10-20T08:00:00Z", "2026-10-20T09:30:00Z"))).toEqual([]);
    expect(manquesPourCloture(preuves("2026-10-20T08:00:00Z", "2026-10-20T08:00:00Z"))).toEqual([]);
  });

  it("nomme chaque preuve absente, dans l'ordre ou l'agent les corrige", () => {
    expect(manquesPourCloture(preuves(null, null))).toEqual(["PREUVE_AVANT_ABSENTE", "PREUVE_APRES_ABSENTE"]);
    expect(manquesPourCloture(preuves("2026-10-20T08:00:00Z", null))).toEqual(["PREUVE_APRES_ABSENTE"]);
    expect(manquesPourCloture(preuves(null, "2026-10-20T08:00:00Z"))).toEqual(["PREUVE_AVANT_ABSENTE"]);
  });

  it("detecte la paire inversee : « apres » prise avant « avant »", () => {
    expect(manquesPourCloture(preuves("2026-10-20T10:00:00Z", "2026-10-20T09:00:00Z"))).toEqual(["PREUVE_APRES_ANTERIEURE_A_AVANT"]);
  });

  it("un fichier sans date de prise ne compte pas comme une preuve", () => {
    const sansDate = { avantChemin: "a.jpg", avantPriseLe: null, apresChemin: "b.jpg", apresPriseLe: d("2026-10-20T09:00:00Z") };
    expect(manquesPourCloture(sansDate)).toEqual(["PREUVE_AVANT_ABSENTE"]);
  });
});

describe("abandon", () => {
  it("exige un motif non blanc", () => {
    expect(motifAbandonValide("Route coupee par une crue")).toBe(true);
    for (const v of ["", "   ", "\n\t", null, undefined]) expect(motifAbandonValide(v)).toBe(false);
  });
});

describe("retard", () => {
  const aujourdhui = d("2026-10-22T15:00:00Z");
  it("une echeance passee sur une tache non terminee est en retard", () => {
    expect(enRetard(d("2026-10-21"), "OUVERTE", aujourdhui)).toBe(true);
    expect(enRetard(d("2026-10-21"), "EN_COURS", aujourdhui)).toBe(true);
  });
  it("l'echeance du jour n'est pas en retard ; une echeance future non plus ; sans echeance non plus", () => {
    expect(enRetard(d("2026-10-22"), "OUVERTE", aujourdhui)).toBe(false);
    expect(enRetard(d("2026-10-23"), "OUVERTE", aujourdhui)).toBe(false);
    expect(enRetard(null, "OUVERTE", aujourdhui)).toBe(false);
  });
  it("une tache terminee n'est jamais en retard, cloturee tard ou abandonnee", () => {
    expect(enRetard(d("2026-01-01"), "CLOTUREE", aujourdhui)).toBe(false);
    expect(enRetard(d("2026-01-01"), "ABANDONNEE", aujourdhui)).toBe(false);
  });
});

describe("frontiere DigitalRoad dans les demandes", () => {
  it("repere les champs contractuels, avec ou sans accent, en majuscules ou compose", () => {
    expect(champsContractuels({ intitule: "x", montant: 12 })).toEqual(["montant"]);
    expect(champsContractuels({ coûtEstimé: 3, Prix_unitaire: 2, numeroMarche: "M1", entrepriseId: "e" })).toEqual(["coûtEstimé", "Prix_unitaire", "numeroMarche", "entrepriseId"]);
    expect(champsContractuels({ montantGNF: 1, paiement: 2, decompteId: "d", bailleur: "b", facture: "f" })).toHaveLength(5);
  });
  it("laisse passer les champs d'une tache interne, quantite constatee comprise", () => {
    expect(champsContractuels({ nature: "CANTONNAGE", intitule: "x", quantite: 40, unite: "m3", tronconId: "t", echeanceLe: "2026-10-30" })).toEqual([]);
  });
  it("ne plante pas sur autre chose qu'un objet", () => {
    for (const v of [null, undefined, "montant", 12, ["montant"]]) expect(champsContractuels(v)).toEqual([]);
  });
});

describe("rapprochement en lecture", () => {
  const aujourdhui = d("2026-10-22T00:00:00Z");
  const t = (extra: Partial<TachePourRapprochement> = {}): TachePourRapprochement => ({
    id: "t1", reference: "TI-2026-00001", statut: "OUVERTE", echeanceLe: null, responsableActif: true, defaut: null, ...extra,
  });
  const defaut = (etat: "ACTIF" | "TRAITE" | "DISPARU", deletedAt: Date | null = null) => ({ id: "d1", etat, deletedAt });

  it("une situation saine ne leve aucune alerte", () => {
    expect(alertesRapprochement([t(), t({ statut: "CLOTUREE", defaut: defaut("TRAITE") }), t({ statut: "ABANDONNEE", defaut: defaut("ACTIF") })], aujourdhui)).toEqual([]);
  });

  it("echeance depassee non cloturee", () => {
    const a = alertesRapprochement([t({ echeanceLe: d("2026-10-01") })], aujourdhui);
    expect(a.map((x) => x.code)).toEqual(["ECHUE_NON_CLOTUREE"]);
    expect(a[0].detail).toContain("2026-10-01");
  });

  it("tache cloturee sur un defaut encore ACTIF : le terrain dit fait, le patrimoine dit non", () => {
    const a = alertesRapprochement([t({ statut: "CLOTUREE", defaut: defaut("ACTIF") })], aujourdhui);
    expect(a.map((x) => x.code)).toEqual(["CLOTUREE_DEFAUT_ENCORE_ACTIF"]);
    expect(a[0].defautId).toBe("d1");
  });

  it("defaut TRAITE ou DISPARU alors que la tache est encore ouverte", () => {
    expect(alertesRapprochement([t({ defaut: defaut("TRAITE") })], aujourdhui).map((x) => x.code)).toEqual(["DEFAUT_TRAITE_TACHE_NON_CLOTUREE"]);
    expect(alertesRapprochement([t({ statut: "EN_COURS", defaut: defaut("DISPARU") })], aujourdhui)).toHaveLength(1);
  });

  it("un defaut supprime logiquement n'est pas un defaut actif", () => {
    expect(alertesRapprochement([t({ statut: "CLOTUREE", defaut: defaut("ACTIF", d("2026-10-10")) })], aujourdhui)).toEqual([]);
  });

  it("responsable inactif sur une tache non terminee seulement", () => {
    expect(alertesRapprochement([t({ responsableActif: false })], aujourdhui).map((x) => x.code)).toEqual(["RESPONSABLE_INACTIF"]);
    expect(alertesRapprochement([t({ responsableActif: false, statut: "CLOTUREE" })], aujourdhui)).toEqual([]);
  });

  it("cumule plusieurs alertes sur une meme tache, sans en inventer", () => {
    const a = alertesRapprochement([t({ echeanceLe: d("2026-10-01"), responsableActif: false, defaut: defaut("TRAITE") })], aujourdhui);
    expect(a.map((x) => x.code).sort()).toEqual(["DEFAUT_TRAITE_TACHE_NON_CLOTUREE", "ECHUE_NON_CLOTUREE", "RESPONSABLE_INACTIF"]);
  });
});
