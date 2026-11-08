import { describe, expect, it } from "vitest";
import {
  CHAMPS_FINANCIERS_CHANTIER, MODULES_MONTANTS_CONTRACTUELS, droitMontantsContractuels, masquerFinancesChantier, masquerFinancesChantiers,
} from "./chantiers.confidentialite";
import type { ModuleKey } from "../../lib/modules";

const modules = (...m: ModuleKey[]) => new Set<ModuleKey>(m);

describe("droitMontantsContractuels (D-C1-1, regle unique et provisoire)", () => {
  it("ADMIN (null : aucune restriction), module marches ou module chantiers : droit", () => {
    expect(droitMontantsContractuels(null)).toBe(true);
    for (const m of ["chantiers", "marches"] as const) expect(droitMontantsContractuels(modules(m)), m).toBe(true);
    expect(droitMontantsContractuels(modules("decision", "marches"))).toBe(true);
  });

  // CONTRAT MODIFIE, ET POURQUOI : l'ancienne liste (chantiers, marches, programmation, decision) donnait le droit a un compte qui n'avait que
  // `decision` ou `programmation`, alors que la synthese, le suivi contractuel et les exports n'exigeaient que `marches` : un compte
  // `decision` seul lisait entreprise et montant des chantiers qu'il ne pouvait pas lire par les marches. `decision` donne la lecture de
  // l'ecran ; `programmation` donne les estimations (previsionnel, scenarios), jamais un montant contractuel.
  it("decision ou programmation seuls (ou avec rapports) : PAS de droit, c'etait la faille", () => {
    expect(droitMontantsContractuels(modules("decision"))).toBe(false);
    expect(droitMontantsContractuels(modules("programmation"))).toBe(false);
    expect(droitMontantsContractuels(modules("decision", "programmation", "rapports"))).toBe(false);
  });

  it("aucun module, ou des modules sans lien avec les montants : pas de droit", () => {
    expect(droitMontantsContractuels(modules())).toBe(false);
    expect(droitMontantsContractuels(modules("geoportail", "dashboard", "troncons", "rapports", "inspections", "documents"))).toBe(false);
  });

  it("la liste exportee est exactement marches et chantiers (une seule source)", () => {
    expect([...MODULES_MONTANTS_CONTRACTUELS].sort()).toEqual(["chantiers", "marches"]);
  });
});

describe("masquerFinancesChantier", () => {
  const ligne = { id: "c1", intitule: "Travaux", statut: "EN_COURS", avancementPct: 40, region: "Kindia", montantGnf: "5000000", bailleur: "AFD", numContrat: "N-1", entreprise: "SOGEA", geometry: "{}" };

  it("remplace par null les quatre champs financiers et laisse le reste intact (la carte continue de fonctionner)", () => {
    const m = masquerFinancesChantier(ligne);
    for (const c of CHAMPS_FINANCIERS_CHANTIER) expect(m[c as keyof typeof m], c).toBeNull();
    expect(m).toMatchObject({ id: "c1", intitule: "Travaux", statut: "EN_COURS", avancementPct: 40, region: "Kindia", geometry: "{}" });
  });

  it("ne modifie pas la ligne d'origine", () => {
    masquerFinancesChantier(ligne);
    expect(ligne.montantGnf).toBe("5000000");
  });

  it("n'ajoute pas de champ financier absent de la ligne (liste sans localisation : pas de montant a masquer)", () => {
    const m = masquerFinancesChantier({ id: "c2", intitule: "x", entreprise: "SOGEA" });
    expect(m).toEqual({ id: "c2", intitule: "x", entreprise: null });
    expect("montantGnf" in m).toBe(false);
  });

  it("masque aussi un montant bigint (ligne Prisma) sans le convertir en zero", () => {
    expect(masquerFinancesChantier({ montantGnf: 5n }).montantGnf).toBeNull();
  });

  it("une liste : toutes les lignes", () => {
    expect(masquerFinancesChantiers([ligne, ligne]).every((l) => l.montantGnf === null)).toBe(true);
  });
});
