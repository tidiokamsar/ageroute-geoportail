import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFINITIONS, FORMAT_EXPORT, celluleCsv, construireExport, versCsv, type MetaExport } from "./export-scenario.noyau";
import { MENTION_SIMULATION } from "./deficit.noyau";
import { MENTION_CONSULTATIVE } from "../aide-decision/export.noyau";
import { construireScenario, type EntreesScenario } from "./scenario.noyau";
import { BAREMES, candidat, candidatsDeBase, entreesDeBase } from "./scenario.fixtures";
import { entreesSimulation, versionDesBaremes } from "./contraintes.fixtures";

const META: MetaExport = {
  genereLe: "2026-10-26T12:00:00.000Z",
  generePar: { id: "u-gest", email: "gestionnaire@essai.invalid" },
  scenario: { id: "s-1", intitule: "PAE 2027 essai", auteurId: "u-auteur", creeLe: "2026-10-26T10:00:00.000Z", empreinteEntrees: "a".repeat(64), empreinteResultat: "b".repeat(64) },
  perimetreDemande: { regionId: 1, classe: null },
  territoireApplique: [1],
  droitFinancier: true,
};
function scenario(e: EntreesScenario) {
  const r = construireScenario(e);
  if (!r.ok) throw new Error(r.erreurs.join(" ; "));
  return r.scenario;
}
const riche = () => scenario(entreesSimulation(
  { budgetGnf: 5_000_000_000n, baremes: BAREMES.filter((b) => b.typeIntervention !== "entretien_periodique") },
  { obligatoires: ["a"] },
));

describe("export-scenario.noyau : aucune base, aucune horloge", () => {
  it("n'importe que des noyaux purs (deficit, mention consultative commune) et des types", () => {
    const src = readFileSync(join(__dirname, "export-scenario.noyau.ts"), "utf8");
    const imports = [...src.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]).sort();
    // La mention consultative est celle de tous les exports du module (une seule constante, aide-decision/export.noyau, elle-meme pure).
    expect(imports).toEqual(["../aide-decision/export.noyau", "./deficit.noyau", "./scenario.noyau"]);
    expect(src).not.toMatch(/Date\.now|new Date\(|Math\.random/);
  });
});

describe("construireExport : ce que dit l'export", () => {
  const e = construireExport(riche(), META);

  it("la mention « simulation non engageante » est la premiere information, avec la precision sur la depense et les travaux", () => {
    expect(Object.keys(e)[0]).toBe("mention");
    expect(e.mention).toBe("SIMULATION NON ENGAGEANTE : ne constitue ni une autorisation de dépense ni un ordre de travaux.");
    expect(e.mention).toBe(MENTION_SIMULATION);
    expect(e.avertissementSansEngagement).toMatch(/Aucune estimation ni programmation ne crée de marché/);
  });

  it("date, auteur de l'export, auteur du scenario, perimetre demande et territoire applique", () => {
    expect(e.genereLe).toBe("2026-10-26T12:00:00.000Z");
    expect(e.generePar).toEqual({ id: "u-gest", email: "gestionnaire@essai.invalid" });
    expect(e.scenario).toMatchObject({ id: "s-1", auteurId: "u-auteur", creeLe: "2026-10-26T10:00:00.000Z", devise: "GNF", periode: { debut: "2027-01-01", fin: "2027-12-31" } });
    expect(e.perimetre).toEqual({ demande: { regionId: 1, classe: null }, territoireApplique: [1] });
    expect(construireExport(riche(), { ...META, territoireApplique: null }).perimetre.territoireApplique).toBe("national");
  });

  it("unites, versions (methode, parametres, baremes avec empreinte et liste), hypotheses, definitions", () => {
    expect(e.unites.montants).toMatch(/GNF/);
    expect(e.versions.parametres.version).toBe("prog-provisoire-1");
    expect(e.versions.baremes.empreinte).toMatch(/^[0-9a-f]{64}$/);
    expect(e.versions.baremes.liste.length).toBeGreaterThan(0);
    expect(e.hypotheses.logique.code).toBe("ratio_cout_impact");
    expect(e.hypotheses.obligatoires).toEqual(["a"]);
    expect(e.hypotheses.enveloppeGnf).toBe("5000000000");
    expect(e.definitions).toBe(DEFINITIONS);
    expect(e.definitions.map((d) => d.terme)).toEqual(expect.arrayContaining(["Déficit", "Coût périmé", "Longueur métier", "Ordre d'arbitrage"]));
    expect(e.format).toBe(FORMAT_EXPORT);
  });

  it("avertissements : donnees partielles, couts provisoires, couts manquants (ici RN-C sans barème d'entretien), deficit", () => {
    const codes = e.avertissements.map((a) => a.code);
    expect(codes).toEqual(expect.arrayContaining(["COUT_NON_ESTIMABLE", "COUTS_PROVISOIRES", "DEFICIT", "DEFICIT_MINORANT", "LONGUEUR_METIER_ABSENTE"]));
    expect(e.resultats.bilan.deficitMinorant).toBe(true);
    expect(e.resultats.coutsNonFiables).toEqual([{ code: "COUT_NON_ESTIMABLE", nb: 1, troncons: ["RN-C"] }]);
  });

  it("une ligne par troncon, retenu ou ecarte, avec son motif et sans cout invente pour un cout manquant", () => {
    expect(e.lignes).toHaveLength(3);
    const c = e.lignes.find((l) => l.code === "RN-C")!;
    expect(c).toMatchObject({ decision: "ECARTEE", motif: "COUT_NON_ESTIMABLE", coutGnf: null, coutFiable: false });
    const a = e.lignes.find((l) => l.code === "RN-A")!;
    expect(a).toMatchObject({ decision: "RETENUE", coutGnf: "4400000000", obligatoire: true, coutFiable: true, baremeId: "2" });
  });

  it("un scenario herite (sans bloc simulation) ne s'exporte pas", () => {
    const r = construireScenario(entreesDeBase());
    if (!r.ok) throw new Error("refus");
    expect(() => construireExport(r.scenario, META)).toThrow(/pas ete calcule par le simulateur/);
  });

  it("deterministe : memes entrees, meme export", () => {
    expect(JSON.stringify(construireExport(riche(), META))).toBe(JSON.stringify(construireExport(riche(), META)));
  });
});

describe("versCsv : tableur francophone, sans injection de formule", () => {
  const csv = versCsv(construireExport(riche(), META));

  it("commence par le BOM puis la mention ; point-virgule ; une ligne d'entete et une ligne par troncon", () => {
    expect(csv.startsWith("﻿SIMULATION NON ENGAGEANTE : ne constitue ni une autorisation de dépense ni un ordre de travaux.\n")).toBe(true);
    const lignes = csv.split("\n");
    const iEntete = lignes.findIndex((l) => l.startsWith("Code;Nom;Région;"));
    expect(iEntete).toBeGreaterThan(5);
    expect(lignes.slice(iEntete + 1).filter((l) => l.trim() !== "")).toHaveLength(3);
    expect(csv).toMatch(/Mention;Statut;SIMULATION NON ENGAGEANTE/);
  });

  it("porte la date, l'auteur, la version des baremes, les hypotheses et les avertissements", () => {
    expect(csv).toContain("Export;Généré le;2026-10-26T12:00:00.000Z");
    expect(csv).toContain("Export;Généré par;gestionnaire@essai.invalid");
    expect(csv).toContain("Versions;Barèmes (empreinte);");
    expect(csv).toContain("Hypothèses;Enveloppe (GNF);5000000000");
    expect(csv).toMatch(/Avertissement;ALERTE COUT_NON_ESTIMABLE;/);
    expect(csv).toContain("Bilan;Déficit minorant;oui");
    expect(csv).toContain("Kilomètres (longueur métier);longueur métier absente");
    expect(csv).toMatch(/Définition;Déficit;/);
  });

  it("neutralise les formules mais laisse les nombres signes intacts", () => {
    expect(celluleCsv("=CMD()")).toBe("'=CMD()");
    expect(celluleCsv("+1+2")).toBe("'+1+2");
    expect(celluleCsv("@x")).toBe("'@x");
    expect(celluleCsv("-1200")).toBe("-1200");
    expect(celluleCsv("-12.5")).toBe("-12.5");
    expect(celluleCsv("a;b")).toBe('"a;b"');
    expect(celluleCsv('dit "oui"')).toBe('"dit ""oui"""');
    expect(celluleCsv(null)).toBe("");
  });

  it("un nom de troncon hostile n'ouvre pas de formule dans le tableur", () => {
    const e = entreesSimulation({ candidats: [...candidatsDeBase(), candidat("h", { code: "=HYPERLINK(1)", nom: "@cmd", etat: "MAUVAIS", traficMoyenJma: 2500, nbPointsNoirs: 2 })] });
    const out = versCsv(construireExport(scenario(e), META));
    expect(out).toContain("'=HYPERLINK(1)");
    expect(out).not.toMatch(/(^|;)=HYPERLINK/m);
  });

  it("le solde signe d'un deficit reste lisible", () => {
    expect(csv).toMatch(/Bilan;Solde signé \(GNF\);-?\d+/);
    const e = entreesSimulation({ budgetGnf: 5_000_000_000n }, { baremes: versionDesBaremes() });
    expect(versCsv(construireExport(scenario(e), META))).toContain("Bilan;Solde signé (GNF);-3700000000");
  });
});

// ---------------------------------------------------------------------------------------------
// Droit financier : l'export d'un scenario suit la MEME regle de retrait que POST /exports
// ---------------------------------------------------------------------------------------------

/** Tous les montants GNF du scenario scelle (enveloppe, bilan, couts, restes, plafonds, prix de bareme) : aucun ne doit sortir sans le droit. */
function montantsDe(s: ReturnType<typeof riche>): string[] {
  const out = new Set<string>([s.budgetGnf, s.totaux.engageGnf, s.totaux.resteGnf]);
  const sim = s.simulation!;
  for (const v of Object.values(sim.bilan)) if (typeof v === "string") out.add(v);
  for (const d of sim.distributionRegionale) { out.add(d.engageGnf); out.add(d.besoinGnf); }
  for (const b of sim.baremes.liste) out.add(b.coutKmGnf);
  for (const l of s.lignes) {
    if (l.cout && l.cout.ok) out.add(l.cout.montantGnf);
    if (l.budget) { out.add(l.budget.resteAvantGnf); out.add(l.budget.resteApresGnf); }
  }
  for (const e of sim.contraintes.equilibre ?? []) { out.add(e.plancherGnf); out.add(e.depenseGnf); }
  return [...out].filter((m) => m.length >= 6 && m !== "0");
}

describe("construireExport sans droit financier : le meme retrait que POST /exports", () => {
  const s = riche();
  const sans = construireExport(s, { ...META, droitFinancier: false });
  const avec = construireExport(s, { ...META, droitFinancier: true });

  it("le jeu de base contient bien des montants, y compris dans des textes (sinon ce test ne prouverait rien)", () => {
    const plein = JSON.stringify(avec);
    const m = montantsDe(s);
    expect(m.length).toBeGreaterThan(5);
    for (const x of m) expect(plein, x).toContain(x);
    expect(avec.lignes.some((l) => l.justification !== null && m.some((x) => (l.justification as string).includes(x)))).toBe(true);
  });

  it("aucun montant ne sort, ni en JSON ni en CSV : enveloppe, bilan, couts, restes, prix de bareme, justification, texte du deficit", () => {
    const json = JSON.stringify(sans);
    const csv = versCsv(sans);
    for (const m of montantsDe(s)) {
      expect(json, `JSON : ${m}`).not.toContain(m);
      expect(csv, `CSV : ${m}`).not.toContain(m);
    }
  });

  it("le fichier DIT qu'il est incomplet : droit absent, champs retires nommes, avertissement", () => {
    expect(sans.droitFinancier).toBe(false);
    expect(sans.champsFinanciersRetires.length).toBeGreaterThan(5);
    expect(sans.champsFinanciersRetires).toEqual(expect.arrayContaining(["resultats.bilan (montants)", "lignes[].coutGnf", "lignes[].justification"]));
    expect(avec.droitFinancier).toBe(true);
    expect(avec.champsFinanciersRetires).toEqual([]);
    expect(versCsv(sans)).toMatch(/Droit financier;Montants;retirés/);
  });

  it("ce qui n'est pas un montant reste : lignes, rangs, motifs (codes), risque, longueurs, nombres, mentions", () => {
    expect(sans.lignes).toHaveLength(avec.lignes.length);
    expect(sans.lignes.map((l) => [l.code, l.decision, l.rangRetenu, l.motif, l.risque, l.longueurM]))
      .toEqual(avec.lignes.map((l) => [l.code, l.decision, l.rangRetenu, l.motif, l.risque, l.longueurM]));
    expect(sans.resultats.nbInterventionsRetenues).toBe(avec.resultats.nbInterventionsRetenues);
    expect(sans.resultats.bilan.deficitMinorant).toBe(true);
    expect(sans.resultats.contraintesInsatisfaisables.map((c) => c.code)).toEqual(avec.resultats.contraintesInsatisfaisables.map((c) => c.code));
    expect(sans.avertissements.map((a) => a.code)).toEqual(avec.avertissements.map((a) => a.code));
    expect(sans.mention).toBe(MENTION_SIMULATION);
  });

  it("MENTION CONSULTATIVE commune a tous les exports du module, avec ou sans droit, en JSON et en CSV", () => {
    for (const e of [sans, avec]) {
      expect(e.mentionConsultative).toBe(MENTION_CONSULTATIVE);
      expect(versCsv(e)).toContain(`Mention;Consultatif;${MENTION_CONSULTATIVE}`);
    }
  });

  it("avec le droit, l'export est complet comme avant (enveloppe, deficit, justification)", () => {
    expect(avec.hypotheses.enveloppeGnf).toBe("5000000000");
    expect(avec.resultats.bilan).toMatchObject({ deficitGnf: expect.any(String), soldeGnf: expect.any(String) });
    expect(avec.lignes.every((l) => typeof l.justification === "string")).toBe(true);
    expect(versCsv(avec)).toContain("Bilan;Déficit (GNF);");
  });
});
