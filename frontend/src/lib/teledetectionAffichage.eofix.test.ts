import { describe, expect, it } from "vitest";
import {
  actionsOffertes, affichageResolution, CONSTAT_REF_MAX, definitionAction, etatConstat, exigeConstat, limitesNonRenseignees,
  messageObservationsMasquees, MESSAGE_LIMITES_NON_RENSEIGNEES,
} from "./teledetectionAffichage";

/** EO-FIX-FRONT : regles pures ajoutees au noyau d'affichage (constat d'un verdict, actions depuis EN_ATTENTE, limites, origines). */

describe("constat exige par un verdict (EO-FIX-FRONT 1)", () => {
  it("Confirmer et Infirmer exigent un constat ; les autres actions non", () => {
    expect(exigeConstat("CONFIRMER")).toBe(true);
    expect(exigeConstat("INFIRMER")).toBe(true);
    for (const a of ["METTRE_EN_ATTENTE", "DEMANDER_INFORMATIONS", "NON_CONCLUANTE", "REMETTRE_A_VERIFIER", "AFFECTER"] as const) expect(exigeConstat(a), a).toBe(false);
  });
  it("un verdict est suffisant avec une observation OU une reference non vide, jamais avec rien ni avec des espaces", () => {
    expect(etatConstat({ action: "CONFIRMER", nbObservations: 0, reference: "" }).suffisant).toBe(false);
    expect(etatConstat({ action: "CONFIRMER", nbObservations: 0, reference: "   " }).suffisant).toBe(false);
    expect(etatConstat({ action: "INFIRMER", nbObservations: 0, reference: "" }).raison).toMatch(/observation.*référence du constat/);
    expect(etatConstat({ action: "CONFIRMER", nbObservations: 1, reference: "" })).toEqual({ suffisant: true, raison: null });
    expect(etatConstat({ action: "INFIRMER", nbObservations: 0, reference: " REF-1 " })).toEqual({ suffisant: true, raison: null });
  });
  it("la reference est bornee comme le serveur (200 caracteres)", () => {
    expect(CONSTAT_REF_MAX).toBe(200);
    expect(etatConstat({ action: "CONFIRMER", nbObservations: 0, reference: "x".repeat(200) }).suffisant).toBe(true);
    const trop = etatConstat({ action: "CONFIRMER", nbObservations: 3, reference: "x".repeat(201) });
    expect(trop.suffisant).toBe(false);
    expect(trop.raison).toMatch(/200 caractères/);
  });
  it("mise en attente et non concluante n'exigent aucun constat", () => {
    for (const a of ["METTRE_EN_ATTENTE", "DEMANDER_INFORMATIONS", "NON_CONCLUANTE", "REMETTRE_A_VERIFIER"] as const) {
      expect(etatConstat({ action: a, nbObservations: 0, reference: "" }), a).toEqual({ suffisant: true, raison: null });
    }
  });
});

describe("actions offertes depuis EN_ATTENTE (F3)", () => {
  it("« Mettre en attente » et « Demander des informations » restent offertes (EN_ATTENTE vers EN_ATTENTE est permis par le serveur)", () => {
    const a = actionsOffertes("GESTIONNAIRE", "EN_ATTENTE", null).map((x) => x.action);
    expect(a).toEqual(["CONFIRMER", "INFIRMER", "METTRE_EN_ATTENTE", "DEMANDER_INFORMATIONS", "NON_CONCLUANTE", "REMETTRE_A_VERIFIER", "AFFECTER"]);
    expect(definitionAction("METTRE_EN_ATTENTE")).toMatchObject({ vers: "EN_ATTENTE", motifAttente: "AUTRE" });
    expect(definitionAction("DEMANDER_INFORMATIONS")).toMatchObject({ vers: "EN_ATTENTE", motifAttente: "INFO_DEMANDEE" });
  });
});

describe("limites non renseignees, observations masquees, origine des valeurs de repli (EO-FIX-FRONT 8)", () => {
  it("limites null ou drapeau : non renseignees ; tableau (meme vide) : renseignees", () => {
    expect(limitesNonRenseignees({ limites: null })).toBe(true);
    expect(limitesNonRenseignees({ limites: undefined })).toBe(true);
    expect(limitesNonRenseignees({ limites: ["x"], limitesNonRenseignees: true })).toBe(true);
    expect(limitesNonRenseignees({ limites: [] })).toBe(false);
    expect(limitesNonRenseignees({ limites: ["x"], limitesNonRenseignees: false })).toBe(false);
    expect(MESSAGE_LIMITES_NON_RENSEIGNEES).toBe("Limites non renseignées pour cette proposition");
    expect(MESSAGE_LIMITES_NON_RENSEIGNEES).not.toMatch(/aucune/i);
  });
  it("observations masquees : accord au singulier, vide si rien ou valeur illisible", () => {
    expect(messageObservationsMasquees(1)).toBe("1 observation hors de votre périmètre n'est pas affichée");
    expect(messageObservationsMasquees(2)).toBe("2 observations hors de votre périmètre ne sont pas affichées");
    expect(messageObservationsMasquees(1234)).toMatch(/^1\s234 observations hors de votre périmètre/);
    for (const v of [0, -1, NaN, null, undefined]) expect(messageObservationsMasquees(v as number), String(v)).toBe("");
  });
  it("resolution : native du produit = « Résolution native », repli = intitule et note qui le disent", () => {
    expect(affichageResolution({ resolutionM: 10, resolutionOrigine: "NATIVE_PRODUIT", capteurOrigine: "PRODUIT" })).toMatchObject({ intitule: "Résolution native", note: null, native: true });
    expect(affichageResolution({ resolutionM: 10 })).toMatchObject({ intitule: "Résolution native", note: null }); // origine non dite : rien d'invente
    const livre = affichageResolution({ resolutionM: 20, resolutionOrigine: "PRODUIT_LIVRE" });
    expect(livre).toMatchObject({ intitule: "Résolution du produit livré", native: false });
    expect(livre.note).toMatch(/ce n'est pas la résolution native/);
    const capteur = affichageResolution({ resolutionM: 10, capteur: "Capteur X", capteurOrigine: "SOURCE" });
    expect(capteur.note).toMatch(/capteur de la source/);
    expect(affichageResolution({ resolutionM: null, resolutionOrigine: "PRODUIT_LIVRE" }).note).toBeNull(); // pas de valeur : pas de note
  });
});
