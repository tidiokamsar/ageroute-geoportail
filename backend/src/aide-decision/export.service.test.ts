import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { produireExport, type ContexteProduction, type Fournisseurs, type ProduitExport } from "./export.service";
import { MENTION_CONSULTATIVE } from "./export.noyau";

/**
 * Orchestration d'un export (lot 6) : filtres/date/mention presents dans le fichier, aucune colonne financiere sans droit,
 * plafond, scenario requis, empreinte du fichier remis. Les jeux viennent de fournisseurs factices : aucune base.
 */
const produit = (n = 2): ProduitExport => ({
  jeu: {
    colonnes: [
      { cle: "troncon_code", libelle: "Troncon", unite: null },
      { cle: "risque_score", libelle: "Risque", unite: "points 0-100" },
      { cle: "cout_estime_gnf", libelle: "Cout", unite: "GNF", financier: true },
    ],
    lignes: Array.from({ length: n }, (_, i) => ({ troncon_code: `RN-${i}`, risque_score: 50 + i, cout_estime_gnf: "3500000000" })),
  },
  sources: [{ code: "scenarios_programmation", libelle: "Scenario scelle", dateReference: "2026-10-20T00:00:00.000Z" }],
  definitions: [{ code: "risque_score", libelle: "Risque", definition: "def", formule: "f", unite: "points", statutDefinition: "PROVISOIRE", origine: "moteur" }],
  avertissements: ["Scenario provisoire : bareme non approuve"],
});

const fournisseurs = (n = 2): Fournisseurs & { appels: string[] } => {
  const appels: string[] = [];
  return {
    appels,
    synthese: vi.fn(async () => { appels.push("synthese"); return produit(n); }),
    reseauRegions: vi.fn(async () => { appels.push("reseauRegions"); return produit(n); }),
    interventions: vi.fn(async () => { appels.push("interventions"); return produit(n); }),
    scenario: vi.fn(async (_c, _f, id) => { appels.push("scenario"); return id === "absent" ? null : produit(n); }),
  };
};

const ctx = (o: Partial<ContexteProduction> = {}): ContexteProduction => ({
  compte: { id: "u1", role: "GESTIONNAIRE", email: "gest@ageroute.gov.gn" },
  maintenant: new Date("2026-10-29T10:00:00.000Z"), exportId: "11111111-1111-4111-8111-111111111111",
  type: "reseau_regions", format: "csv", filtres: {}, scenarioId: null,
  portee: { national: false, regions: [3], regionNoms: ["Kindia"], regionDemandee: null },
  droits: { financier: false, marches: false, programmation: true }, ...o,
});

describe("produireExport", () => {
  it("le fichier porte filtres appliques ET non appliques, date, auteur, perimetre, sources, definitions, avertissements et mention", async () => {
    const r = await produireExport(ctx({ filtres: { regionId: 3, depuis: "2026-01-01" } }), fournisseurs());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.contenu).toContain("# genere_le;2026-10-29T10:00:00.000Z");
    expect(r.contenu).toContain("# auteur;gest@ageroute.gov.gn (GESTIONNAIRE)");
    expect(r.contenu).toContain("# perimetre;Regions du compte : Kindia");
    expect(r.contenu).toContain("# filtres_appliques;regionId=3");
    expect(r.contenu).toContain("# filtre_non_applique;depuis :");
    expect(r.contenu).toContain("# source;Scenario scelle [scenarios_programmation] reference : 2026-10-20");
    expect(r.contenu).toContain("# definition risque_score;");
    expect(r.contenu).toContain("# avertissement;Scenario provisoire");
    expect(r.contenu).toContain(`# mention;Consultatif, non engageant`);
    expect(r.entete.mention).toBe(MENTION_CONSULTATIVE);
  });

  it("MUTATION DE CONTROLE : un export sans filtres le dit (« aucun filtre ») au lieu de se taire", async () => {
    const r = await produireExport(ctx(), fournisseurs());
    expect(r.ok && r.contenu).toContain("# filtres_appliques;aucun filtre");
  });

  it("sans droit financier : la colonne financiere disparait de l'en-tete et des lignes, et le fichier le dit", async () => {
    const r = await produireExport(ctx(), fournisseurs());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.colonnesRetirees).toEqual(["cout_estime_gnf"]);
    expect(r.contenu).not.toContain("cout_estime_gnf;");
    expect(r.contenu).not.toContain("3500000000");
    expect(r.contenu).toContain("# colonnes_financieres_retirees;cout_estime_gnf");
    expect(r.entete.avertissements.join(" ")).toMatch(/sans droit financier/);
  });

  it("avec le droit financier : le cout est present, rien n'est retire", async () => {
    const r = await produireExport(ctx({ droits: { financier: true, marches: true, programmation: true } }), fournisseurs());
    expect(r.ok && r.contenu).toContain("3500000000");
    expect(r.ok && r.colonnesRetirees).toEqual([]);
  });

  it("refuse au-dela du plafond (413), aucun fichier tronque", async () => {
    const r = await produireExport(ctx({ limiteLignes: 5 }), fournisseurs(6));
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.statut).toBe(413); expect(r.code).toBe("EXPORT_TROP_VOLUMINEUX"); }
    const ok = await produireExport(ctx({ limiteLignes: 5 }), fournisseurs(5));
    expect(ok.ok).toBe(true);
  });

  it("interventions et scenario exigent un scenarioId (400), un scenario absent est un 404", async () => {
    const f = fournisseurs();
    const sans = await produireExport(ctx({ type: "interventions" }), f);
    expect(sans.ok).toBe(false);
    if (!sans.ok) { expect(sans.statut).toBe(400); expect(sans.code).toBe("SCENARIO_REQUIS"); }
    expect(f.appels).toEqual([]);
    const absent = await produireExport(ctx({ type: "scenario", scenarioId: "absent" }), f);
    expect(absent.ok).toBe(false);
    if (!absent.ok) expect(absent.statut).toBe(404);
  });

  it("route chaque type vers son fournisseur", async () => {
    const f = fournisseurs();
    await produireExport(ctx({ type: "synthese" }), f);
    await produireExport(ctx({ type: "reseau_regions" }), f);
    await produireExport(ctx({ type: "interventions", scenarioId: "s" }), f);
    await produireExport(ctx({ type: "scenario", scenarioId: "s" }), f);
    expect(f.appels).toEqual(["synthese", "reseauRegions", "interventions", "scenario"]);
  });

  it("JSON : metadonnees et lignes, empreinte et taille du fichier remis", async () => {
    const r = await produireExport(ctx({ format: "json" }), fournisseurs());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const j = JSON.parse(r.contenu);
    expect(j.metadonnees.type).toBe("reseau_regions");
    expect(j.metadonnees.nbLignes).toBe(2);
    expect(r.contentType).toContain("application/json");
    expect(r.empreinteSha256).toBe(createHash("sha256").update(Buffer.from(r.contenu, "utf8")).digest("hex"));
    expect(r.tailleOctets).toBe(Buffer.byteLength(r.contenu, "utf8"));
    expect(r.nomFichier).toBe("aide-decision-reseau_regions-20261029-100000.json");
  });

  it("un compte national dit « National » et ne porte pas de liste de regions", async () => {
    const r = await produireExport(ctx({ portee: { national: true, regions: null, regionNoms: [], regionDemandee: null } }), fournisseurs());
    expect(r.ok && r.entete.perimetre).toEqual({ libelle: "National (toutes les regions)", national: true, regionIds: null });
  });
});
