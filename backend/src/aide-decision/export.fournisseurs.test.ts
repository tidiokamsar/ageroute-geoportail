import { describe, expect, it, vi } from "vitest";

/**
 * Fournisseurs reels des exports (lot 6) : les colonnes TEXTE d'un scenario qui portent des montants en toutes lettres
 * (`justification`, `motif_exclusion_detail`) sont des colonnes financieres. Sans le droit, elles sont retirees avec les autres :
 * un fichier « sans colonne financiere » ne doit pas laisser lire l'enveloppe, le reste de l'enveloppe ou un cout dans un texte.
 *
 * La base est simulee (le scenario scelle est fabrique par les vrais noyaux) ; le retrait, le rendu et les colonnes sont les vrais.
 */
const h = vi.hoisted(() => ({ scenario: null as null | { resultatCanonique: string; intitule: string; empreinteResultat: string; creeLe: Date } }));

vi.mock("../lib/prisma", () => ({ prisma: {} }));
vi.mock("../programmation/moteur.depot", () => ({ lireScenario: async () => h.scenario }));
vi.mock("./synthese", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./synthese")>();
  return { ...actual, depotPrisma: () => ({ nomsRegions: async () => new Map([[1, "Conakry"], [2, "Kindia"]]) }) };
});

import { canonique } from "../programmation/canonique";
import { construireScenario } from "../programmation/scenario.noyau";
import { entreesSimulation } from "../programmation/contraintes.fixtures";
import { BAREMES } from "../programmation/scenario.fixtures";
import { fournisseursReels } from "./export.fournisseurs";
import { produireExport, type ContexteProduction } from "./export.service";

const r = construireScenario(entreesSimulation({ budgetGnf: 5_000_000_000n, baremes: BAREMES.filter((b) => b.typeIntervention !== "entretien_periodique") }, { obligatoires: ["a"] }));
if (!r.ok) throw new Error(r.erreurs.join(" ; "));
const scenario = r.scenario;
h.scenario = { resultatCanonique: canonique(scenario), intitule: "PAE essai", empreinteResultat: "e".repeat(64), creeLe: new Date("2026-10-26T10:00:00Z") };

const ctx = (type: "scenario" | "interventions", financier: boolean): ContexteProduction => ({
  compte: { id: "u1", role: "GESTIONNAIRE", email: "gest@ageroute.gov.gn" },
  maintenant: new Date("2026-10-29T10:00:00.000Z"), exportId: "11111111-1111-4111-8111-111111111111",
  type, format: "csv", filtres: {}, scenarioId: "s1",
  portee: { national: true, regions: null, regionNoms: [], regionDemandee: null },
  droits: { financier, marches: financier, programmation: true },
});

/** Cles de colonnes du TABLEAU du CSV (apres le bloc d'en-tete `# cle;valeur` et la ligne vide). */
const entete = (csv: string): string[] => csv.split("\n\n")[1].split("\n")[0].split(";");

/** Tous les montants GNF qui figurent dans le scenario scelle (enveloppe, couts, restes) : aucun ne doit sortir sans le droit. */
function montants(): string[] {
  const out = new Set<string>([scenario.budgetGnf, scenario.totaux.engageGnf, scenario.totaux.resteGnf]);
  for (const l of scenario.lignes) {
    if (l.cout && l.cout.ok) out.add(l.cout.montantGnf);
    if (l.budget) { out.add(l.budget.resteAvantGnf); out.add(l.budget.resteApresGnf); }
  }
  return [...out].filter((m) => m.length >= 6);
}

describe("export de scenario par POST /exports : colonnes texte portant des montants", () => {
  it("le jeu de base contient bien des montants dans les textes (sinon ce test ne prouverait rien)", () => {
    const textes = scenario.lignes.map((l) => `${l.justification} ${l.motifExclusion?.detail ?? ""}`).join(" ");
    expect(montants().some((m) => textes.includes(m))).toBe(true);
  });

  for (const type of ["scenario", "interventions"] as const) {
    it(`${type} sans droit financier : aucun montant ne sort, ni en colonne ni dans un texte`, async () => {
      const res = await produireExport(ctx(type, false), fournisseursReels);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.colonnesRetirees).toEqual(expect.arrayContaining(["justification", "motif_exclusion_detail", "cout_estime_gnf"]));
      // Le bloc d'en-tete NOMME les colonnes retirees ; le tableau, lui, ne les porte plus.
      expect(entete(res.contenu)).not.toContain("justification");
      for (const m of montants()) expect(res.contenu, `montant ${m}`).not.toContain(m);
    });

    it(`${type} avec le droit financier : la justification explicable reste dans le fichier`, async () => {
      const res = await produireExport(ctx(type, true), fournisseursReels);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.colonnesRetirees).toEqual([]);
      expect(entete(res.contenu)).toContain("justification");
    });
  }
});
