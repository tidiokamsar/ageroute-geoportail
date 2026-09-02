import { describe, expect, it, vi } from "vitest";

vi.mock("./prisma", () => ({ prisma: {} }));

import {
  qualiteInitialeTroncon,
  estDouteuse,
  estDatee,
  libelleStatut,
  CHAMPS_DECISION,
  type QualiteValeur,
  type TronconAQualifier,
} from "./qualite";

/**
 * Ce que l'on sait d'une valeur ne doit jamais etre plus flatteur que la realite.
 *
 * Rappel des mesures qui fondent ces tests : `revetement` vaut BITUME sur les 1 690
 * troncons sans exception, `etat` vaut NON_EVALUE sur 1 043 d'entre eux, trafic,
 * criticite et cout sont vides partout, et 3 dates de constat existent sur 4 970
 * attendues.
 */

const troncon = (p: Partial<TronconAQualifier> = {}): TronconAQualifier => ({
  id: "t1",
  etat: "MOYEN",
  longueurKm: 12.5,
  revetement: "BITUME",
  traficMoyenJma: null,
  criticiteStrategique: null,
  coutRehabEstime: null,
  dateDerniereEvaluation: null,
  ...p,
});

const champ = (ecritures: ReturnType<typeof qualiteInitialeTroncon>, nom: string) =>
  ecritures.find((e) => e.champ === nom)!;

describe("Qualité initiale d'un tronçon", () => {
  it("couvre exactement les six champs de décision", () => {
    const e = qualiteInitialeTroncon(troncon());
    expect(e.map((x) => x.champ).sort()).toEqual([...CHAMPS_DECISION].sort());
  });

  it("ne qualifie AUCUNE valeur d'observée", () => {
    // Le resultat le plus dur de l'exercice, et il est exact : pas une valeur de la
    // base ne porte de date de constat, d'auteur ni de methode.
    const cas = [
      troncon(),
      troncon({ etat: "NON_EVALUE" }),
      troncon({ etat: "CRITIQUE", longueurKm: 0 }),
      troncon({ traficMoyenJma: 3200, criticiteStrategique: 4, coutRehabEstime: 1000 }),
    ];
    for (const t of cas) {
      for (const e of qualiteInitialeTroncon(t)) {
        expect(e.statut).not.toBe("OBSERVED");
      }
    }
  });

  it("marque le revêtement comme importé non vérifié, sans le remplacer", () => {
    const r = champ(qualiteInitialeTroncon(troncon()), "revetement");
    expect(r.statut).toBe("IMPORTED_UNVERIFIED");
    expect(r.confiance).toBe("LOW");
    expect(r.note).toMatch(/contredite a l'echelle du reseau/);
  });

  it("ne marque pas le revêtement CONFLICTING faute de pouvoir l'attribuer", () => {
    // La contradiction est etablie au niveau du reseau, pas troncon par troncon : un
    // seul chantier sur 488 porte un code de troncon exact. Marquer un enregistrement
    // precis supposerait un rapprochement qu'on ne sait pas faire.
    const r = champ(qualiteInitialeTroncon(troncon()), "revetement");
    expect(r.statut).not.toBe("CONFLICTING");
  });

  it("distingue un état jamais évalué d'un état importé", () => {
    const inconnu = champ(qualiteInitialeTroncon(troncon({ etat: "NON_EVALUE" })), "etat");
    expect(inconnu.statut).toBe("UNKNOWN");
    expect(inconnu.source).toBeNull();
    expect(inconnu.note).toMatch(/1 043/);

    const importe = champ(qualiteInitialeTroncon(troncon({ etat: "MAUVAIS" })), "etat");
    expect(importe.statut).toBe("IMPORTED_UNVERIFIED");
    expect(importe.note).toMatch(/non date/);
  });

  it("reporte la date d'évaluation quand elle existe", () => {
    const d = new Date("2026-03-15");
    const e = champ(qualiteInitialeTroncon(troncon({ dateDerniereEvaluation: d })), "etat");
    expect(e.observedAt).toEqual(d);
    // Datee : la reserve sur la comparabilite ne s'applique plus.
    expect(e.note).toBeNull();
  });

  it("distingue une longueur absente d'une longueur saisie", () => {
    expect(champ(qualiteInitialeTroncon(troncon({ longueurKm: 0 })), "longueurKm").statut).toBe("UNKNOWN");
    expect(champ(qualiteInitialeTroncon(troncon({ longueurKm: null })), "longueurKm").statut).toBe("UNKNOWN");
    expect(champ(qualiteInitialeTroncon(troncon({ longueurKm: 42 })), "longueurKm").statut).toBe(
      "IMPORTED_UNVERIFIED"
    );
  });

  it("rappelle que la longueur calculée n'est pas écrite en base", () => {
    const l = champ(qualiteInitialeTroncon(troncon({ longueurKm: 0 })), "longueurKm");
    expect(l.note).toMatch(/jamais ecrite ici/);
  });

  it("marque UNKNOWN les trois critères entièrement absents", () => {
    const e = qualiteInitialeTroncon(troncon());
    for (const c of ["traficMoyenJma", "criticiteStrategique", "coutRehabEstime"]) {
      expect(champ(e, c).statut).toBe("UNKNOWN");
      expect(champ(e, c).note).toMatch(/absen/i);
    }
  });

  it("reconnaît un critère qui serait renseigné un jour", () => {
    const e = qualiteInitialeTroncon(troncon({ traficMoyenJma: 3200 }));
    expect(champ(e, "traficMoyenJma").statut).toBe("IMPORTED_UNVERIFIED");
    expect(champ(e, "traficMoyenJma").note).toBeNull();
  });
});

describe("Lecture d'un statut", () => {
  const q = (p: Partial<QualiteValeur>): QualiteValeur => ({
    champ: "etat",
    statut: "OBSERVED",
    source: null,
    methode: null,
    observedAt: null,
    observedById: null,
    confiance: null,
    note: null,
    ...p,
  });

  it("tient pour douteux tout ce qui n'est pas constaté", () => {
    expect(estDouteuse(q({ statut: "OBSERVED" }))).toBe(false);
    for (const s of ["IMPORTED_UNVERIFIED", "DERIVED", "CONFLICTING", "UNKNOWN"] as const) {
      expect(estDouteuse(q({ statut: s }))).toBe(true);
    }
  });

  it("tient pour douteuse une valeur dont rien n'est enregistré", () => {
    // Absence de statut n'est pas UNKNOWN : personne n'a encore regarde.
    expect(estDouteuse(null)).toBe(true);
  });

  it("signale un constat non daté comme tel", () => {
    expect(estDatee(q({ statut: "OBSERVED" }))).toBe(false);
    expect(libelleStatut(q({ statut: "OBSERVED" }))).toMatch(/date inconnue/);
    expect(libelleStatut(q({ statut: "OBSERVED", observedAt: new Date() }))).toBe("Constaté");
  });

  it("donne un libellé à chaque statut, sans jamais rester muet", () => {
    for (const s of ["OBSERVED", "IMPORTED_UNVERIFIED", "DERIVED", "CONFLICTING", "UNKNOWN"] as const) {
      expect(libelleStatut(q({ statut: s })).length).toBeGreaterThan(5);
    }
    expect(libelleStatut(null)).toMatch(/non renseignée/i);
  });

  it("dit « importé — non vérifié », pas « renseigné »", () => {
    expect(libelleStatut(q({ statut: "IMPORTED_UNVERIFIED" }))).toBe("Importé — non vérifié");
  });
});
