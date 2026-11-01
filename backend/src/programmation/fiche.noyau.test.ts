import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_FICHE, contenuFiche, figer, verifierFiche, type ContexteFiche } from "./fiche.noyau";
import { construireScenario, type Scenario } from "./scenario.noyau";
import { canonique, sha256Hex } from "./canonique";
import { entreesDeBase } from "./scenario.fixtures";
import { parametresAmorcage } from "./parametres.noyau";

/**
 * Fiche d'intervention FIGEE. Ce que ces tests defendent :
 *   - rejouabilite : memes entrees, meme fiche, memes octets, meme empreinte (A22) ;
 *   - la fiche embarque une COPIE INTEGRALE des parametres : elle se relit seule ;
 *   - toute alteration d'un octet est detectee ;
 *   - une ligne ecartee ne se fige pas ;
 *   - rien dans le contenu n'est horodate (l'instant du gel est pose par la base, hors contenu).
 */
describe("Le noyau ne depend d'aucune base", () => {
  it("n'importe que des noyaux purs et la canonicalisation", () => {
    const src = readFileSync(join(__dirname, "fiche.noyau.ts"), "utf8");
    const imports = [...src.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]).sort();
    expect(imports).toEqual(["./canonique", "./parametres.noyau", "./scenario.noyau"]);
  });
});

function scenario(budget = 10_000_000_000n): Scenario {
  const r = construireScenario(entreesDeBase({ budgetGnf: budget }));
  if (!r.ok) throw new Error("scenario invalide");
  return r.scenario;
}
const ctx = (o: Partial<ContexteFiche> = {}): ContexteFiche => ({
  scenarioId: "scn-1", empreinteScenario: sha256Hex(canonique(scenario())), sourceFinancement: null, parametres: parametresAmorcage(), ...o,
});

function fiche(code: string, c: ContexteFiche = ctx()) {
  const s = scenario();
  const l = s.lignes.find((x) => x.troncon.code === code)!;
  const r = contenuFiche(l, s, c);
  if (!r.ok) throw new Error(r.motif);
  return r.contenu;
}

describe("contenuFiche", () => {
  it("porte patrimoine, plage lineaire, traitement, quantites, cout et classe de precision, score, justification", () => {
    const f = fiche("RN-A") as Record<string, any>;
    expect(f.schema).toBe(SCHEMA_FICHE);
    expect(f.patrimoine).toMatchObject({ code: "RN-A", plage: { debutM: 0, finM: 4000, unite: "m" } });
    expect(f.traitement.traitement.code).toBe("rehabilitation");
    expect(f.quantites).toEqual({ longueurM: 4000, unite: "m", niveauMesure: "REFERENTIEL" });
    expect(f.cout).toMatchObject({ ok: true, montantGnf: "4400000000", classePrecision: "RESEAU_30", margePct: 30, provisoire: true });
    expect(f.score.risque.score).toBe(60.625);
    expect(f.score.risqueAttendu.score).toBe(65.375);
    expect(f.justification).toMatch(/^Retenue/);
    expect(f.financement.source).toBeNull();
    expect(f.etiquette).toBe("PROVISOIRE, non approuvé");
    expect(f.avertissement).toMatch(/ne crée de marché, contrat/);
  });

  it("recopie les parametres EN ENTIER, avec leur version et leur etiquette", () => {
    const f = fiche("RN-A") as Record<string, any>;
    expect(f.parametres.version).toBe("prog-provisoire-1");
    expect(f.parametres.etiquette).toBe("PROVISOIRE, non approuvé");
    expect(f.parametres.valeurs).toEqual(parametresAmorcage().valeurs);
  });

  it("la source de financement est declaree par l'agent, jamais deduite", () => {
    const f = fiche("RN-A", ctx({ sourceFinancement: "FER" })) as Record<string, any>;
    expect(f.financement.source).toBe("FER");
  });

  it("aucun instant dans le contenu : ni date de gel, ni horodatage", () => {
    const texte = canonique(fiche("RN-A"));
    expect(texte).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it("refuse de figer une ligne ecartee", () => {
    const s = scenario(5_000_000_000n);
    const ecartee = s.lignes.find((l) => l.decision === "ECARTEE")!;
    const r = contenuFiche(ecartee, s, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.code).toBe("LIGNE_NON_RETENUE"); expect(r.motif).toContain("BUDGET_INSUFFISANT"); }
  });

  it("refuse une ligne retenue incomplete", () => {
    const s = scenario();
    const l = { ...s.lignes.find((x) => x.decision === "RETENUE")!, cout: null };
    const r = contenuFiche(l, s, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("LIGNE_INCOMPLETE");
  });
});

describe("figer : rejouabilite", () => {
  it("memes entrees => meme texte canonique, meme empreinte, meme reference, octet pour octet", () => {
    const a = figer(fiche("RN-A"));
    const b = figer(fiche("RN-A"));
    expect(a.contenuCanonique).toBe(b.contenuCanonique);
    expect(a.empreinteSha256).toBe(b.empreinteSha256);
    expect(Buffer.from(a.contenuCanonique, "utf8").equals(Buffer.from(b.contenuCanonique, "utf8"))).toBe(true);
    expect(a.empreinteSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.reference).toBe(`FI-2027-${a.empreinteSha256.slice(0, 10).toUpperCase()}`);
  });

  it("un scenario reconstruit depuis des entrees melangees donne la meme fiche", () => {
    const e = entreesDeBase();
    const r = construireScenario({ ...e, candidats: [...e.candidats].reverse(), baremes: [...e.baremes].reverse() });
    if (!r.ok) throw new Error("invalide");
    const l = r.scenario.lignes.find((x) => x.troncon.code === "RN-A")!;
    const c = contenuFiche(l, r.scenario, ctx());
    if (!c.ok) throw new Error(c.motif);
    expect(figer(c.contenu).empreinteSha256).toBe(figer(fiche("RN-A")).empreinteSha256);
  });

  it("une valeur de parametre differente change l'empreinte (le gel dit sous quels parametres)", () => {
    const p = parametresAmorcage();
    p.valeurs.horizonAnnees = 2;
    expect(figer(fiche("RN-A", ctx({ parametres: p }))).empreinteSha256).not.toBe(figer(fiche("RN-A")).empreinteSha256);
  });

  it("deux troncons donnent deux empreintes", () => {
    expect(figer(fiche("RN-A")).empreinteSha256).not.toBe(figer(fiche("RN-C")).empreinteSha256);
  });
});

describe("verifierFiche", () => {
  it("accepte une fiche intacte", () => {
    const f = figer(fiche("RN-A"));
    expect(verifierFiche(f.contenuCanonique, f.empreinteSha256)).toEqual({ ok: true });
  });

  it("detecte la modification d'un seul octet", () => {
    const f = figer(fiche("RN-A"));
    const altere = f.contenuCanonique.replace("4400000000", "4400000001");
    expect(altere).not.toBe(f.contenuCanonique);
    const v = verifierFiche(altere, f.empreinteSha256);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("EMPREINTE_DIFFERENTE");
  });

  it("detecte un texte non canonique, meme de contenu equivalent", () => {
    const f = figer(fiche("RN-A"));
    const joli = JSON.stringify(JSON.parse(f.contenuCanonique), null, 2);
    const v = verifierFiche(joli, sha256Hex(joli));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("TEXTE_NON_CANONIQUE");
  });

  it("detecte un autre schema", () => {
    const t = canonique({ schema: "autre/1", annee: 2027 });
    const v = verifierFiche(t, sha256Hex(t));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("SCHEMA_INCONNU");
  });
});
