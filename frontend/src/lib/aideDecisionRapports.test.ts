import { describe, expect, it } from "vitest";
import {
  MENTION_CONSULTATIVE, TYPES_RAPPORT, aDroitFinancier, apercuParametres, corpsExport, definitionType, libelleTypeJournal, nomFichierExport,
  peutExporter, repartitionFiltres, resumeFiltresJournal, verdictExport,
} from "./aideDecisionRapports";

/**
 * Noyau de l'onglet Rapports : droit d'exporter et sa RAISON, corps de la demande (sans filtre = tout le perimetre autorise),
 * filtres appliques / non appliques / indisponibles, apercu des parametres.
 */
const admin = { role: "ADMIN", modulesAutorises: [] };
const gest = { role: "GESTIONNAIRE", modulesAutorises: ["rapports", "programmation", "marches", "decision"] };

describe("peutExporter : toujours une raison quand c'est non", () => {
  it("anonyme, lecteur, gestionnaire sans module rapports : refus avec raison", () => {
    for (const c of [null, undefined, { role: "LECTEUR", modulesAutorises: ["rapports"] }, { role: "GESTIONNAIRE", modulesAutorises: ["decision"] }, { role: "GESTIONNAIRE", modulesAutorises: [] }]) {
      const v = peutExporter(c, "reseau_regions");
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.raison.length).toBeGreaterThan(15);
    }
  });
  it("une liste de modules VIDE vaut aucun module (regle du serveur), sauf ADMIN", () => {
    expect(peutExporter({ role: "GESTIONNAIRE", modulesAutorises: [] }, "synthese").ok).toBe(false);
    expect(peutExporter(admin, "synthese").ok).toBe(true);
  });
  it("interventions et scenario exigent AUSSI le module programmation", () => {
    const sans = { role: "GESTIONNAIRE", modulesAutorises: ["rapports"] };
    expect(peutExporter(sans, "synthese").ok).toBe(true);
    const v = peutExporter(sans, "scenario");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.raison).toMatch(/Programmation/);
    expect(peutExporter(gest, "scenario").ok).toBe(true);
  });
  it("droit financier = module marches (ADMIN toujours)", () => {
    expect(aDroitFinancier(admin)).toBe(true);
    expect(aDroitFinancier(gest)).toBe(true);
    expect(aDroitFinancier({ role: "GESTIONNAIRE", modulesAutorises: ["rapports"] })).toBe(false);
  });
});

describe("verdictExport", () => {
  it("un scenario est exige pour les types qui en portent un", () => {
    const v = verdictExport(gest, "interventions", {}, null);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.raison).toMatch(/scénario/);
    expect(verdictExport(gest, "interventions", {}, "id-1").ok).toBe(true);
  });
  it("une periode incoherente bloque l'export avec sa raison", () => {
    const v = verdictExport(gest, "reseau_regions", { depuis: "2026-05-02", jusqua: "2026-05-01" }, null);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.raison).toMatch(/début est postérieure|période/);
  });
});

describe("corpsExport", () => {
  it("MUTATION DE CONTROLE : sans filtre, aucun champ `filtres` (tout le perimetre autorise) ; avec filtres, ils partent", () => {
    expect(corpsExport("reseau_regions", "csv", {}, null)).toEqual({ type: "reseau_regions", format: "csv" });
    expect(corpsExport("reseau_regions", "json", { regionId: 3, classe: ["RN"] }, null)).toEqual({ type: "reseau_regions", format: "json", filtres: { regionId: 3, classe: ["RN"] } });
  });
  it("n'envoie que des filtres valides (une valeur bricolee est ecartee)", () => {
    const c = corpsExport("synthese", "csv", { regionId: -4, classe: ["RN", "<script>"] } as never, null);
    expect(c.filtres).toEqual({ classe: ["RN"] });
  });
  it("le scenario n'est envoye que pour les types qui en portent un", () => {
    expect(corpsExport("scenario", "csv", {}, "abc").scenarioId).toBe("abc");
    expect(corpsExport("synthese", "csv", {}, "abc").scenarioId).toBeUndefined();
  });
});

describe("filtres appliques / non appliques / indisponibles", () => {
  it("la periode est un filtre NON applique a l'etat du reseau, avec sa raison (jamais retire en silence)", () => {
    const r = repartitionFiltres("reseau_regions", { regionId: 3, depuis: "2026-01-01" }, "Kindia");
    expect(r.appliques).toEqual([{ cle: "regionId", libelle: "Région", valeur: "Kindia" }]);
    expect(r.nonAppliques[0]).toMatchObject({ cle: "depuis" });
    expect(r.nonAppliques[0].raison).toMatch(/instantané/);
  });
  it("l'etat s'applique aux scenarios, pas a l'etat du reseau", () => {
    expect(repartitionFiltres("scenario", { etat: ["CRITIQUE"] }).appliques).toHaveLength(1);
    expect(repartitionFiltres("reseau_regions", { etat: ["CRITIQUE"] }).nonAppliques).toHaveLength(1);
  });
  it("prefecture, axe, bailleur, gravite, type d'intervention sont toujours annonces indisponibles", () => {
    expect(repartitionFiltres("synthese", {}).sansDonnee.map((f) => f.cle)).toEqual(["prefecture", "axe", "bailleur", "gravite", "intervention"]);
  });
  it("tous les types definissent une raison pour chaque filtre qu'ils n'appliquent pas", () => {
    for (const t of TYPES_RAPPORT) {
      for (const cle of ["regionId", "classe", "etat", "statutChantier", "depuis", "jusqua"] as const) {
        if (!t.filtresPrisEnCharge.includes(cle)) expect(t.raisonsNonAppliques[cle], `${t.type}.${cle}`).toBeTruthy();
      }
    }
  });
});

describe("apercuParametres", () => {
  it("periode : instantane quand elle n'est pas appliquee ; perimetre : celui du compte ; droit financier dit", () => {
    const a = apercuParametres("reseau_regions", {}, { role: "GESTIONNAIRE", modulesAutorises: ["rapports"] });
    expect(a.periode).toMatch(/Instantané/);
    expect(a.perimetre).toMatch(/périmètre territorial/);
    expect(a.financier).toMatch(/Sans droit financier/);
    expect(apercuParametres("synthese", {}, admin).perimetre).toBe("Toutes les régions");
    expect(apercuParametres("synthese", {}, admin).financier).toMatch(/seront incluses/);
  });
  it("sources et unites sont renseignees pour chaque type", () => {
    for (const t of TYPES_RAPPORT) {
      const a = apercuParametres(t.type, {}, admin);
      expect(a.sources.length).toBeGreaterThan(0);
      expect(a.unites).toMatch(/km/);
    }
  });
});

describe("fichier et journal", () => {
  it("nom de fichier du serveur, assaini ; repli si absent", () => {
    expect(nomFichierExport('attachment; filename="aide-decision-x-2026.csv"', "repli.csv")).toBe("aide-decision-x-2026.csv");
    expect(nomFichierExport('attachment; filename="../../etc/passwd"', "repli.csv")).not.toContain("/");
    expect(nomFichierExport(undefined, "repli.csv")).toBe("repli.csv");
  });
  it("libelles de journal et resume de filtres (un export sans filtre le dit)", () => {
    expect(libelleTypeJournal("selection:troncons")).toMatch(/Sélection/);
    expect(libelleTypeJournal("scenario")).toBe("Scénario de programmation");
    expect(resumeFiltresJournal({})).toMatch(/aucun filtre/);
    expect(resumeFiltresJournal({ regionId: 3, classe: ["RN", "RR"] })).toBe("regionId = 3 ; classe = RN, RR");
  });
  it("la mention consultative et la definition de chaque type existent", () => {
    expect(MENTION_CONSULTATIVE).toMatch(/non engageant/);
    expect(definitionType("scenario").necessiteScenario).toBe(true);
  });
});
