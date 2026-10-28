import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VALEURS_AMORCAGE_PROVISOIRES, validerParametres, validerValeurs, parametresAmorcage } from "./parametres.noyau";
import { BLOC_PRIORITE_AMORCAGE, CRITERES_TECHNIQUES, MODELE_PRIORITE, dateCalendaireValide, validerBlocPriorite } from "./priorite.parametres";

/**
 * Ce que ces tests defendent : le bloc de priorite est une CLE OPTIONNELLE des valeurs d'une version (aucune table, aucune
 * migration), validee avec TOUTES ses erreurs, et son ajout ne change ni le jeu d'amorcage ni la contrainte de la base.
 */
describe("bloc d'amorcage", () => {
  it("est valide pour son propre validateur, et PROVISOIRE (aucune source) : ses poids ne sont pas des coefficients officiels", () => {
    const r = validerBlocPriorite(BLOC_PRIORITE_AMORCAGE);
    expect(r.ok).toBe(true);
    expect(BLOC_PRIORITE_AMORCAGE.modele).toBe(MODELE_PRIORITE);
    expect(Object.keys(BLOC_PRIORITE_AMORCAGE.poids)).toEqual([...CRITERES_TECHNIQUES]);
  });

  it("exclut explicitement (poids nul) les deux criteres sans donnee structuree", () => {
    expect(BLOC_PRIORITE_AMORCAGE.poids.ACCESSIBILITE_SERVICE).toBe(0);
    expect(BLOC_PRIORITE_AMORCAGE.poids.MATURITE_FAISABILITE).toBe(0);
  });

  it("n'est PAS dans les valeurs d'amorcage seme par la migration (le semis reste identique)", () => {
    expect("priorite" in VALEURS_AMORCAGE_PROVISOIRES).toBe(false);
    expect("priorite" in parametresAmorcage().valeurs).toBe(false);
  });
});

describe("validerBlocPriorite", () => {
  const base = () => structuredClone(BLOC_PRIORITE_AMORCAGE) as unknown as Record<string, unknown>;

  it("rend TOUTES les erreurs d'un coup", () => {
    const b = base();
    (b.poids as Record<string, unknown>).ETAT_GRAVITE = -1;
    (b.poids as Record<string, unknown>).CRITERE_INVENTE = 3;
    b.couvertureMinimale = 1.5;
    b.registrePointsNoirsMinimum = 0;
    b.urgenceAnciennetePlafondJours = 0;
    b.validiteDe = "2026-02-30";
    b.cleInconnue = 1;
    const r = validerBlocPriorite(b);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const t = r.erreurs.join(" | ");
      for (const m of ["poids.ETAT_GRAVITE", "critere inconnu CRITERE_INVENTE", "couvertureMinimale", "registrePointsNoirsMinimum", "urgenceAnciennetePlafondJours", "validiteDe", "cle inconnue cleInconnue"]) expect(t).toContain(m);
    }
  });

  it("refuse une somme de poids nulle, un modele inconnu, une periode inversee, un non-objet", () => {
    const zero = base();
    for (const c of CRITERES_TECHNIQUES) (zero.poids as Record<string, number>)[c] = 0;
    expect(validerBlocPriorite(zero).ok).toBe(false);
    expect(validerBlocPriorite({ ...base(), modele: "autre-modele" }).ok).toBe(false);
    expect(validerBlocPriorite({ ...base(), validiteDe: "2027-01-01", validiteA: "2026-01-01" }).ok).toBe(false);
    for (const x of [null, 3, "x", [], undefined]) expect(validerBlocPriorite(x).ok).toBe(false);
  });

  it("refuse les cles manquantes et les poids non numeriques (NaN, texte)", () => {
    const manque = base(); delete manque.poids;
    expect(validerBlocPriorite(manque).ok).toBe(false);
    expect(validerBlocPriorite({ ...base(), poids: { ...(base().poids as object), ETAT_GRAVITE: "40" } }).ok).toBe(false);
    expect(validerBlocPriorite({ ...base(), poids: { ...(base().poids as object), ETAT_GRAVITE: Number.NaN } }).ok).toBe(false);
  });

  it("accepte une periode de validite bornee d'un seul cote", () => {
    expect(validerBlocPriorite({ ...base(), validiteDe: "2026-01-01" }).ok).toBe(true);
    expect(validerBlocPriorite({ ...base(), validiteA: "2026-12-31" }).ok).toBe(true);
  });

  it("dateCalendaireValide refuse les jours inexistants", () => {
    expect(dateCalendaireValide("2024-02-29")).toBe(true);
    expect(dateCalendaireValide("2026-02-29")).toBe(false);
    expect(dateCalendaireValide("2026-13-01")).toBe(false);
    expect(dateCalendaireValide("26-01-01")).toBe(false);
    expect(dateCalendaireValide(20260101)).toBe(false);
  });
});

describe("integration aux valeurs du moteur (parametres.noyau.ts, ajout additif)", () => {
  const valeurs = () => ({ ...structuredClone(VALEURS_AMORCAGE_PROVISOIRES) }) as unknown as Record<string, unknown>;

  it("les valeurs SANS bloc restent valides (versions anterieures)", () => {
    expect(validerValeurs(valeurs()).ok).toBe(true);
  });

  it("les valeurs AVEC un bloc valide sont valides et le conservent", () => {
    const r = validerValeurs({ ...valeurs(), priorite: BLOC_PRIORITE_AMORCAGE });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.valeurs.priorite).toEqual(BLOC_PRIORITE_AMORCAGE);
  });

  it("un bloc invalide fait refuser la version entiere, avec la raison", () => {
    const r = validerValeurs({ ...valeurs(), priorite: { ...BLOC_PRIORITE_AMORCAGE, couvertureMinimale: 0 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erreurs.join(" ")).toContain("priorite.couvertureMinimale");
  });

  it("toute autre cle inconnue reste refusee (seule `priorite` est ajoutee)", () => {
    const r = validerValeurs({ ...valeurs(), autre: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erreurs.join(" ")).toContain("cle inconnue : autre");
  });

  it("validerParametres accepte un jeu complet portant le bloc", () => {
    const p = parametresAmorcage(); p.valeurs.priorite = structuredClone(BLOC_PRIORITE_AMORCAGE);
    expect(validerParametres(p)).toEqual({ ok: true });
  });

  it("la contrainte de la base (pp_valeurs_completes) n'exige que les dix cles du risque : une cle de plus est admise", () => {
    const sql = readFileSync(join(__dirname, "../../prisma/migrations/20261023100000_moteur_programmation/migration.sql"), "utf8");
    const m = /"valeurs" \?& ARRAY\[([^\]]+)\]/.exec(sql);
    expect(m, "contrainte pp_valeurs_completes introuvable").not.toBeNull();
    expect(m![1]).not.toContain("priorite");
    expect(m![1].split(",").length).toBe(10);
  });
});
