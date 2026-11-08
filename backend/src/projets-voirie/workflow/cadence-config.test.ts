import { afterEach, describe, expect, it, vi } from "vitest";
import { FENETRE_CADENCE_S, verifierCadenceCreation, verifierQuota } from "./cadence.noyau";
import {
  creationsParMinute, demandesParProjetMax, matriceEffective, preuvesParObjetMax, recolementObligatoire, recolementsParProjetMax, tachesParProjetMax,
} from "./config";
import { MATRICE_DEFAUT } from "./profils.noyau";

afterEach(() => vi.unstubAllEnvs());

const MAINT = new Date("2026-11-07T12:00:00.000Z");
const il_y_a = (s: number) => new Date(MAINT.getTime() - s * 1000);

describe("cadence de creation : au plus N creations par compte et par projet sur une fenetre glissante", () => {
  it("sous le plafond : accepte", () => {
    expect(verifierCadenceCreation({ creationsRecentes: [il_y_a(1), il_y_a(2)], maintenant: MAINT, plafond: 3 })).toEqual({ ok: true });
    expect(verifierCadenceCreation({ creationsRecentes: [], maintenant: MAINT, plafond: 1 })).toEqual({ ok: true });
  });

  it("au plafond : 429 CADENCE_CREATION avec le delai a attendre (la plus ancienne qui compte sort de la fenetre)", () => {
    const r = verifierCadenceCreation({ creationsRecentes: [il_y_a(50), il_y_a(20), il_y_a(5)], maintenant: MAINT, plafond: 3 });
    expect(r).toMatchObject({ ok: false, status: 429, code: "CADENCE_CREATION", retryAfterS: 10 });
  });

  it("au-dela du plafond : il faut attendre que assez de creations sortent, pas seulement la premiere", () => {
    // 5 creations, plafond 3 : il en faut 3 hors de la fenetre ; la plus recente de ces trois a 30 s -> 30 s a attendre.
    const r = verifierCadenceCreation({ creationsRecentes: [il_y_a(55), il_y_a(45), il_y_a(30), il_y_a(10), il_y_a(1)], maintenant: MAINT, plafond: 3 });
    expect(r).toMatchObject({ ok: false, retryAfterS: 30 });
  });

  it("les creations hors de la fenetre ne comptent pas ; le delai n'est jamais inferieur a une seconde", () => {
    expect(verifierCadenceCreation({ creationsRecentes: [il_y_a(61), il_y_a(300), il_y_a(3600)], maintenant: MAINT, plafond: 1 })).toEqual({ ok: true });
    const r = verifierCadenceCreation({ creationsRecentes: [il_y_a(59.9)], maintenant: MAINT, plafond: 1 });
    expect(r).toMatchObject({ ok: false, retryAfterS: 1 });
    expect(FENETRE_CADENCE_S).toBe(60);
  });

  it("une horloge qui recule (creation « dans le futur ») compte comme recente : on ne laisse jamais passer faute de pouvoir mesurer", () => {
    expect(verifierCadenceCreation({ creationsRecentes: [new Date(MAINT.getTime() + 5000)], maintenant: MAINT, plafond: 1 })).toMatchObject({ ok: false, code: "CADENCE_CREATION" });
  });

  it("fenetre personnalisee", () => {
    expect(verifierCadenceCreation({ creationsRecentes: [il_y_a(5)], maintenant: MAINT, plafond: 1, fenetreS: 10 })).toMatchObject({ ok: false, retryAfterS: 5 });
    expect(verifierCadenceCreation({ creationsRecentes: [il_y_a(11)], maintenant: MAINT, plafond: 1, fenetreS: 10 })).toEqual({ ok: true });
  });
});

describe("quota par projet ou par objet", () => {
  it("sous le maximum : accepte ; au maximum : 422 QUOTA_ATTEINT", () => {
    expect(verifierQuota({ nb: 199, max: 200, libelle: "preuves" })).toEqual({ ok: true });
    expect(verifierQuota({ nb: 200, max: 200, libelle: "preuves" })).toMatchObject({ ok: false, status: 422, code: "QUOTA_ATTEINT" });
    expect(verifierQuota({ nb: 201, max: 200, libelle: "preuves" })).toMatchObject({ ok: false, code: "QUOTA_ATTEINT" });
  });
});

describe("reglages par variable d'environnement : bornes et defauts", () => {
  it("defauts : 30 creations par minute, 2000 demandes, 5000 taches, 500 recolements, 200 preuves ; recolement non obligatoire", () => {
    expect([creationsParMinute(), demandesParProjetMax(), tachesParProjetMax(), recolementsParProjetMax(), preuvesParObjetMax()]).toEqual([30, 2000, 5000, 500, 200]);
    expect(recolementObligatoire()).toBe(false);
  });

  it("une valeur valide est prise en compte, bornes comprises", () => {
    vi.stubEnv("PROJETS_VOIRIE_WORKFLOW_CREATIONS_PAR_MINUTE", "600");
    vi.stubEnv("PROJETS_VOIRIE_WORKFLOW_PREUVES_MAX", "10");
    expect(creationsParMinute()).toBe(600);
    expect(preuvesParObjetMax()).toBe(10);
  });

  it("hors bornes, illisible, vide, decimal ou negatif : le defaut (un plafond ne peut etre ni supprime ni absurde)", () => {
    for (const v of ["0", "-5", "abc", "", " ", "1.5", "601", "999999999", "NaN", "Infinity"]) {
      vi.stubEnv("PROJETS_VOIRIE_WORKFLOW_CREATIONS_PAR_MINUTE", v);
      expect(creationsParMinute(), v).toBe(30);
    }
    for (const v of ["9", "5001", "0"]) {
      vi.stubEnv("PROJETS_VOIRIE_WORKFLOW_PREUVES_MAX", v);
      expect(preuvesParObjetMax(), v).toBe(200);
    }
  });

  it("recolement obligatoire : seulement la valeur « 1 »", () => {
    for (const v of ["", "0", "true", "oui", "2", " 1"]) { vi.stubEnv("PROJETS_VOIRIE_RECOLEMENT_OBLIGATOIRE", v); expect(recolementObligatoire(), v).toBe(false); }
    vi.stubEnv("PROJETS_VOIRIE_RECOLEMENT_OBLIGATOIRE", "1");
    expect(recolementObligatoire()).toBe(true);
  });

  it("matrice effective : defaut sans variable ; la variable est relue quand elle change", () => {
    expect(matriceEffective().matrice).toEqual(MATRICE_DEFAUT);
    vi.stubEnv("PROJETS_VOIRIE_WORKFLOW_MATRICE", JSON.stringify({ "recolement.valider": ["GESTIONNAIRE"] }));
    expect(matriceEffective().matrice["recolement.valider"]).toEqual(["ADMIN", "GESTIONNAIRE"]);
    vi.stubEnv("PROJETS_VOIRIE_WORKFLOW_MATRICE", "n'importe quoi");
    expect(matriceEffective().matrice).toEqual(MATRICE_DEFAUT);
    expect(matriceEffective().avertissements.length).toBe(1);
  });
});
