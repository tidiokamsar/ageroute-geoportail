import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ETIQUETTE_PROVISOIRE, VALEURS_AMORCAGE_PROVISOIRES, VERSION_AMORCAGE,
  etiquetteParametres, parametresAmorcage, sontProvisoires, validerParametres, validerValeurs, versionValide,
} from "./parametres.noyau";

/**
 * Ce que ces tests defendent : aucune valeur n'est presentee comme officielle. Les valeurs
 * d'amorcage naissent non approuvees, le disent, et tout jeu incoherent est refuse avec TOUTES
 * ses erreurs (pas une correction silencieuse).
 */
describe("parametres d'amorcage", () => {
  it("naissent PROVISOIRES : aucune approbation, etiquette explicite", () => {
    const p = parametresAmorcage();
    expect(p.version).toBe(VERSION_AMORCAGE);
    expect(p.source).toBe("amorcage_provisoire");
    expect(p.approuveeLe).toBeNull();
    expect(p.approuveeParId).toBeNull();
    expect(sontProvisoires(p)).toBe(true);
    expect(etiquetteParametres(p)).toBe(ETIQUETTE_PROVISOIRE);
    expect(ETIQUETTE_PROVISOIRE).toBe("PROVISOIRE, non approuvé");
  });

  it("sont valides pour le validateur lui-meme", () => {
    expect(validerParametres(parametresAmorcage())).toEqual({ ok: true });
  });

  it("une approbation change l'etiquette, et exige date ET approbateur", () => {
    const p = { ...parametresAmorcage(), approuveeLe: "2026-10-23T08:00:00.000Z", approuveeParId: "u1" };
    expect(sontProvisoires(p)).toBe(false);
    expect(etiquetteParametres(p)).toBe("paramètres approuvés");
    const seule = validerParametres({ ...parametresAmorcage(), approuveeLe: "2026-10-23T08:00:00.000Z" });
    expect(seule.ok).toBe(false);
  });

  it("le semis de la migration reproduit exactement les valeurs du code", () => {
    const sql = readFileSync(join(__dirname, "../../prisma/migrations/20261023100000_moteur_programmation/migration.sql"), "utf8");
    const bloc = /-- DEBUT-VALEURS-AMORCAGE\r?\n([\s\S]*?)-- FIN-VALEURS-AMORCAGE/.exec(sql);
    expect(bloc, "bloc DEBUT/FIN-VALEURS-AMORCAGE absent de la migration").not.toBeNull();
    const m = /\$valeurs\$([\s\S]*?)\$valeurs\$/.exec(bloc![1]);
    expect(m, "litteral $valeurs$ absent du bloc").not.toBeNull();
    expect(JSON.parse(m![1])).toEqual(VALEURS_AMORCAGE_PROVISOIRES);
    expect(sql).toContain(`'${VERSION_AMORCAGE}'`);
  });
});

describe("validerValeurs", () => {
  const base = () => structuredClone(VALEURS_AMORCAGE_PROVISOIRES) as unknown as Record<string, unknown>;

  it("rend toutes les erreurs d'un coup", () => {
    const v = base();
    (v.poidsRisque as Record<string, unknown>).ETAT = -1;
    v.traficPlafondJma = 0;
    v.facteursMinimum = 9;
    v.couvertureMinimale = 1.5;
    v.horizonAnnees = 0;
    const r = validerValeurs(v);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erreurs.length).toBeGreaterThanOrEqual(5);
  });

  it("refuse une somme de poids nulle, un poids inconnu, une cle inconnue ou manquante", () => {
    const zero = base();
    zero.poidsRisque = { ETAT: 0, TRAFIC_IMPORTANCE: 0, SECURITE: 0, CLIMAT: 0, POPULATION: 0 };
    expect(validerValeurs(zero).ok).toBe(false);
    const inconnu = base();
    (inconnu.poidsRisque as Record<string, unknown>).BRUIT = 5;
    expect(validerValeurs(inconnu).ok).toBe(false);
    const extra = base();
    extra.truc = 1;
    expect(validerValeurs(extra).ok).toBe(false);
    const manque = base();
    delete manque.horizonAnnees;
    expect(validerValeurs(manque).ok).toBe(false);
  });

  it("un etat plus degrade ne peut pas etre moins risque ; NON_EVALUE n'a pas de risque", () => {
    const v = base();
    v.etatVersRisque = { BON: 10, MOYEN: 70, MAUVAIS: 65, CRITIQUE: 90 };
    expect(validerValeurs(v).ok).toBe(false);
    const w = base();
    (w.etatVersRisque as Record<string, number>).NON_EVALUE = 0;
    const r = validerValeurs(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erreurs.join(" ")).toMatch(/NON_EVALUE/);
  });

  it("les seuils de classe de trafic sont strictement croissants", () => {
    const v = base();
    v.seuilsClasseTrafic = { t1MaxJma: 2000, t2MaxJma: 2000 };
    expect(validerValeurs(v).ok).toBe(false);
  });

  it("seuilRisqueMinimal : null ou 0 a 100", () => {
    const v = base();
    v.seuilRisqueMinimal = 101;
    expect(validerValeurs(v).ok).toBe(false);
    v.seuilRisqueMinimal = 30;
    expect(validerValeurs(v).ok).toBe(true);
  });
});

describe("versionValide", () => {
  it("accepte un identifiant lisible, refuse le reste", () => {
    expect(versionValide("prog-2027.1")).toBe(true);
    expect(versionValide("Prog")).toBe(false);
    expect(versionValide("ab")).toBe(false);
    expect(versionValide("-abc")).toBe(false);
    expect(versionValide("a b c")).toBe(false);
  });
});
