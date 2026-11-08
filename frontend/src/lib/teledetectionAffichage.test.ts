import { describe, expect, it } from "vitest";
import { ratioContraste } from "./contraste";
import {
  actionsOffertes, acquisitionAncienne, affichageConfianceDetection, affichageRattachement, affichageTaux, affichageTotaux, arrondirEmprise,
  COULEURS_PRIORITE, COULEURS_STATUT, empriseAutour, estSourceActive, estVerdictDefinitif, formaterDate, formaterPourcentage,
  formaterResolution, infoEtatSource, libelleQualiteImage, libelleStatut, libelleType, nomProposition, ONGLETS_STATUT,
  peutDecider, peutGererSources,
} from "./teledetectionAffichage";
import type { EtatSource } from "./teledetectionApi";

/**
 * Regles d'affichage de l'ecran Observation de la Terre.
 * Ce que ces tests defendent : le taux de confirmation (jamais 0 % a zero verdict, toujours
 * accompagne de sa reserve sous le seuil, calcule depuis les effectifs), l'echelle d'etat des
 * sources (seul TRAITEMENT_OPERATIONNEL est « Active »), la separation du rattachement fiable et
 * non fiable, et le contraste des couleurs de statut (WCAG 1.4.3).
 */

const NBSP = " ";

describe("taux de confirmation terrain : 0, 1, 2, 30 et 61 verdicts", () => {
  it("0 verdict : « Aucun verdict », jamais 0 %", () => {
    const t = affichageTaux({ confirmees: 0, infirmees: 0, seuil: 30 });
    expect(t.genre).toBe("aucun");
    expect(t.valeur).toBe("Aucun verdict");
    expect(t.pourcentage).toBeNull();
    expect(t.mention).toBeNull();
    expect(t.valeur).not.toMatch(/%/);
  });

  it("1 verdict : la valeur est montree AVEC « échantillon insuffisant (n = 1) »", () => {
    const t = affichageTaux({ confirmees: 1, infirmees: 0, seuil: 30 });
    expect(t.genre).toBe("insuffisant");
    expect(t.valeur).toBe(`100,0${NBSP}%`);
    expect(t.mention).toBe("échantillon insuffisant (n = 1)");
  });

  it("2 verdicts : 1 confirmee et 1 infirmee donne 50,0 % avec la reserve", () => {
    const t = affichageTaux({ confirmees: 1, infirmees: 1, seuil: 30 });
    expect(t.valeur).toBe(`50,0${NBSP}%`);
    expect(t.mention).toBe("échantillon insuffisant (n = 2)");
  });

  it("29 verdicts : encore sous le seuil de 30", () => {
    const t = affichageTaux({ confirmees: 20, infirmees: 9, seuil: 30 });
    expect(t.genre).toBe("insuffisant");
    expect(t.mention).toBe("échantillon insuffisant (n = 29)");
  });

  it("30 verdicts : le seuil est atteint, plus de reserve", () => {
    const t = affichageTaux({ confirmees: 20, infirmees: 10, seuil: 30 });
    expect(t.genre).toBe("suffisant");
    expect(t.mention).toBeNull();
    expect(t.valeur).toBe(`66,7${NBSP}%`);
  });

  it("61 verdicts (37 confirmees, 24 infirmees) : 60,7 % et JAMAIS 86 %", () => {
    const t = affichageTaux({ confirmees: 37, infirmees: 24, seuil: 30 });
    expect(t.jugees).toBe(61);
    expect(t.pourcentage).toBeCloseTo(60.655, 2);
    expect(t.valeur).toBe(`60,7${NBSP}%`);
    expect(t.valeur).not.toContain("86");
    expect(t.mention).toBeNull();
  });

  it("le serveur peut exiger davantage : on retient le plus prudent", () => {
    const t = affichageTaux({ confirmees: 37, infirmees: 24, seuil: 30, echantillonSuffisant: false });
    expect(t.genre).toBe("insuffisant");
    expect(t.mention).toBe("échantillon insuffisant (n = 61)");
  });

  it("un seuil absent retombe sur 30, jamais sur zero (qui rendrait tout suffisant)", () => {
    expect(affichageTaux({ confirmees: 1, infirmees: 1, seuil: 0 }).seuil).toBe(30);
    expect(affichageTaux({ confirmees: 1, infirmees: 1, seuil: null }).genre).toBe("insuffisant");
  });

  it("des effectifs negatifs ou decimaux ne fabriquent pas de pourcentage aberrant", () => {
    const t = affichageTaux({ confirmees: -4, infirmees: 2.9, seuil: 30 });
    expect(t.confirmees).toBe(0);
    expect(t.infirmees).toBe(2);
    expect(t.pourcentage).toBe(0);
  });

  it("formate avec la virgule francaise et une decimale", () => {
    expect(formaterPourcentage(60.655)).toBe(`60,7${NBSP}%`);
    expect(formaterPourcentage(0)).toBe(`0,0${NBSP}%`);
  });
});

describe("echelle d'etat d'une source (contrat paragraphe 4)", () => {
  const tous: EtatSource[] = ["NON_CONFIGUREE", "CONFIGUREE", "AUTHENTIFIEE", "ACCESSIBLE", "PRODUIT_DISPONIBLE", "TRAITEMENT_OPERATIONNEL", "EN_ERREUR", "EN_ATTENTE_CONFIGURATION"];

  it("seul TRAITEMENT_OPERATIONNEL est « Active »", () => {
    for (const e of tous) expect(estSourceActive(e)).toBe(e === "TRAITEMENT_OPERATIONNEL");
    expect(infoEtatSource("TRAITEMENT_OPERATIONNEL").libelle).toBe("Active");
  });

  it("aucun autre etat n'a le libelle « Active », et chacun a un libelle distinct", () => {
    const libelles = tous.map((e) => infoEtatSource(e).libelle);
    expect(new Set(libelles).size).toBe(tous.length);
    for (const e of tous) if (e !== "TRAITEMENT_OPERATIONNEL") expect(infoEtatSource(e).libelle).not.toMatch(/^active$/i);
  });

  it("un etat inconnu n'est jamais presente comme actif", () => {
    const i = infoEtatSource("ACTIVE");
    expect(i.active).toBe(false);
    expect(i.connu).toBe(false);
    expect(i.libelle).toBe("État inconnu");
  });
});

describe("confiance de detection : indice non calibre ou probabilite calibree", () => {
  it("non calibree : un indice a deux decimales, pas un pourcentage", () => {
    const c = affichageConfianceDetection({ valeur: 0.87, calibree: false, signification: "s" });
    expect(c.texte).toBe("indice 0,87");
    expect(c.nature).toBe("Indice non calibré");
    expect(c.texte).not.toMatch(/%/);
  });
  it("calibree : un pourcentage de probabilite", () => {
    const c = affichageConfianceDetection({ valeur: 0.87, calibree: true, signification: "s" });
    expect(c.texte).toBe(`87${NBSP}%`);
    expect(c.nature).toBe("Probabilité calibrée");
  });
  it("sans valeur : « Non renseignée », jamais 0", () => {
    expect(affichageConfianceDetection({ valeur: null, calibree: false, signification: "" }).texte).toBe("Non renseignée");
  });
});

describe("rattachement : le troncon n'est nomme que s'il est fiable", () => {
  const troncon = { id: "t", code: "GN N0001", nom: "Conakry", regionId: 1, regionNom: "Conakry" };
  it("HAUTE et MOYENNE : troncon et zone affiches", () => {
    for (const confiance of ["HAUTE", "MOYENNE"] as const) {
      const r = affichageRattachement({ rattachee: true, troncon, rattachement: { confiance, distanceM: 5, algorithme: "a" } });
      expect(r.fiable).toBe(true);
      expect(r.titre).toBe("GN N0001 · Conakry");
      expect(r.zone).toBe("Conakry");
    }
  });
  it("FAIBLE : « Anomalie non rattachée », le troncon candidat reste visible en reserve", () => {
    const r = affichageRattachement({ rattachee: true, troncon, rattachement: { confiance: "FAIBLE", distanceM: 400, algorithme: "a" } });
    expect(r.fiable).toBe(false);
    expect(r.titre).toBe("Anomalie non rattachée");
    expect(r.reserve).toContain("GN N0001");
  });
  it("AUCUN ou sans troncon : « Anomalie non rattachée » sans reserve", () => {
    const r = affichageRattachement({ rattachee: false, troncon: null, rattachement: { confiance: "AUCUN", distanceM: null, algorithme: "a" } });
    expect(r.titre).toBe("Anomalie non rattachée");
    expect(r.reserve).toBeNull();
  });
  it("le nom accessible d'une proposition non rattachee ne cite aucun troncon", () => {
    expect(nomProposition({ type: "INONDATION", troncon: null, rattachee: false, rattachement: { confiance: "AUCUN", distanceM: null, algorithme: "" } })).toBe("inondation non rattachée");
  });
});

describe("libelles et formats", () => {
  it("un type inconnu n'est jamais rendu en SNAKE_CASE brut", () => {
    expect(libelleType("INONDATION")).toBe("Inondation");
    expect(libelleType("CHANGEMENT_SURFACE_X")).toBe("Changement surface x");
    expect(libelleType("")).toBe("Type non renseigné");
  });
  it("un statut inconnu est dit inconnu", () => {
    expect(libelleStatut("EN_ATTENTE")).toBe("En attente");
    expect(libelleStatut("ZZZ")).toBe("Statut inconnu");
  });
  it("les cinq onglets du contrat, dans l'ordre", () => {
    expect(ONGLETS_STATUT.map((o) => o.statut)).toEqual(["A_VERIFIER", "EN_ATTENTE", "NON_CONCLUANTE", "CONFIRMEE", "INFIRMEE"]);
  });
  it("la date est deterministe (UTC) et dit quand elle est inconnue", () => {
    expect(formaterDate("2026-10-23T23:30:00Z")).toBe("23 oct. 2026");
    expect(formaterDate(null)).toBe("Date inconnue");
    expect(formaterDate("pas une date")).toBe("Date inconnue");
  });
  it("la resolution absente n'est jamais fabriquee", () => {
    expect(formaterResolution(null)).toBe("Résolution non renseignée");
    expect(formaterResolution(10)).toBe(`10${NBSP}m`);
  });
  it("la qualite d'image sans donnee est dite non renseignee", () => {
    expect(libelleQualiteImage({ couvertureNuagesPct: null, note: null })).toBe("Non renseignée");
    expect(libelleQualiteImage({ couvertureNuagesPct: 12, note: "ciel dégagé" })).toBe(`12${NBSP}% de nuages · ciel dégagé`);
  });
  it("acquisition ancienne : au-dela du seuil seulement, et jamais sur une valeur absente", () => {
    expect(acquisitionAncienne(31)).toBe(true);
    expect(acquisitionAncienne(30)).toBe(false);
    expect(acquisitionAncienne(null)).toBe(false);
  });
  it("emprises : cadrage autour d'un point et arrondi", () => {
    expect(empriseAutour({ lat: 9.5, lon: -13.5 }, 0.5)).toEqual([-14, 9, -13, 10]);
    expect(arrondirEmprise([-13.60412, 9.40999, -13.1, 9.8])).toEqual([-13.6, 9.41, -13.1, 9.8]);
  });
});

describe("droits d'affichage (le serveur decide)", () => {
  it("decider : ADMIN et GESTIONNAIRE seulement", () => {
    expect(peutDecider("ADMIN")).toBe(true);
    expect(peutDecider("GESTIONNAIRE")).toBe(true);
    expect(peutDecider("INSPECTEUR")).toBe(false);
    expect(peutDecider("LECTEUR")).toBe(false);
    expect(peutDecider(undefined)).toBe(false);
  });
  it("gerer les sources : ADMIN seulement", () => {
    expect(peutGererSources("ADMIN")).toBe(true);
    expect(peutGererSources("GESTIONNAIRE")).toBe(false);
  });
  it("A_VERIFIER : toutes les decisions et l'affectation tant qu'aucune mission n'existe", () => {
    const a = actionsOffertes("GESTIONNAIRE", "A_VERIFIER", null).map((x) => x.action);
    expect(a).toEqual(["CONFIRMER", "INFIRMER", "METTRE_EN_ATTENTE", "DEMANDER_INFORMATIONS", "NON_CONCLUANTE", "AFFECTER"]);
    expect(actionsOffertes("GESTIONNAIRE", "A_VERIFIER", "m-1").map((x) => x.action)).not.toContain("AFFECTER");
  });
  it("EN_ATTENTE et NON_CONCLUANTE peuvent revenir a verifier", () => {
    expect(actionsOffertes("ADMIN", "EN_ATTENTE", null).map((x) => x.action)).toContain("REMETTRE_A_VERIFIER");
    expect(actionsOffertes("ADMIN", "NON_CONCLUANTE", null).map((x) => x.action)).toContain("REMETTRE_A_VERIFIER");
  });
  it("un verdict est definitif : aucune action", () => {
    expect(estVerdictDefinitif("CONFIRMEE")).toBe(true);
    expect(actionsOffertes("ADMIN", "CONFIRMEE", null)).toEqual([]);
    expect(actionsOffertes("ADMIN", "INFIRMEE", null)).toEqual([]);
  });
  it("INSPECTEUR et LECTEUR : aucune action de decision", () => {
    expect(actionsOffertes("INSPECTEUR", "A_VERIFIER", null)).toEqual([]);
    expect(actionsOffertes("LECTEUR", "A_VERIFIER", null)).toEqual([]);
  });
  it("« Demander des informations » laisse la proposition EN_ATTENTE avec le motif INFO_DEMANDEE", () => {
    const a = actionsOffertes("ADMIN", "A_VERIFIER", null).find((x) => x.action === "DEMANDER_INFORMATIONS");
    expect(a?.vers).toBe("EN_ATTENTE");
    expect(a?.motifAttente).toBe("INFO_DEMANDEE");
  });
});

describe("contraste des couleurs de statut, de priorite et d'etat de source (WCAG 1.4.3, 4,5:1)", () => {
  const couples = [
    ...Object.entries(COULEURS_STATUT).map(([k, c]) => [`statut ${k}`, c] as const),
    ...Object.entries(COULEURS_PRIORITE).map(([k, c]) => [`priorite ${k}`, c] as const),
    ...(["NON_CONFIGUREE", "CONFIGUREE", "AUTHENTIFIEE", "ACCESSIBLE", "PRODUIT_DISPONIBLE", "TRAITEMENT_OPERATIONNEL", "EN_ERREUR", "EN_ATTENTE_CONFIGURATION"] as const)
      .map((e) => [`source ${e}`, infoEtatSource(e).couleur] as const),
  ];
  it.each(couples)("%s : texte sur fond >= 4,5:1", (_nom, c) => {
    expect(ratioContraste(c.texte, c.fond)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(couples)("%s : texte sur blanc >= 4,5:1 (pastille posee sur une carte blanche)", (_nom, c) => {
    expect(ratioContraste(c.texte, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("totaux : compteur d'onglet et total filtre", () => {
  const base = { libelleOnglet: "À vérifier" };

  it("toujours le total filtre du serveur, avec les filtres appliques quand il y en a", () => {
    expect(affichageTotaux({ ...base, total: 12, compteurOnglet: 12, autresFiltres: [] }).totalFiltre).toBe("Total filtré renvoyé par le serveur : 12");
    expect(affichageTotaux({ ...base, total: 12, compteurOnglet: 12, autresFiltres: ["type", "source"] }).totalFiltre)
      .toBe("Total filtré renvoyé par le serveur : 12 (filtres appliqués : type, source)");
  });

  it("chiffres egaux ou compteur indisponible : aucune explication a donner", () => {
    expect(affichageTotaux({ ...base, total: 5, compteurOnglet: 5, autresFiltres: [] }).explication).toBeNull();
    expect(affichageTotaux({ ...base, total: 5, compteurOnglet: null, autresFiltres: ["type"] }).explication).toBeNull();
  });

  it("ecart avec des filtres supplementaires : l'ecran nomme ces filtres comme cause", () => {
    const e = affichageTotaux({ ...base, total: 3, compteurOnglet: 24, autresFiltres: ["type", "priorité"] }).explication!;
    expect(e).toContain("« À vérifier » (24)");
    expect(e).toContain("ne suit que la région et la période");
    expect(e).toContain("type, priorité");
    expect(e).toContain("(3)");
  });

  it("ecart SANS filtre supplementaire : dit la seule cause connue (deux lectures distinctes), n'en invente pas d'autre", () => {
    const e = affichageTotaux({ ...base, total: 4, compteurOnglet: 5, autresFiltres: [] }).explication!;
    expect(e).toContain("deux lectures distinctes du serveur");
    expect(e).not.toContain("applique en plus");
  });

  it("total 0 face a un compteur non nul : l'ecart est explique, pas laisse seul", () => {
    expect(affichageTotaux({ ...base, total: 0, compteurOnglet: 24, autresFiltres: ["recherche"] }).explication).toContain("recherche");
  });
});
