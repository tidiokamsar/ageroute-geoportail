import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ECHELLE_ETAT_SOURCE, ETATS_SOURCE, SEUIL_ECHANTILLON_TAUX, STATUTS_PROPOSITION, TRANSITIONS_AUTORISEES,
  ageEnJours, calculerTauxConfirmation, codeMissionTeledetection, codeProduitCatalogue, compterSourcesParEtat, construireConstatRef,
  estDefinitif, evaluerRattachement, verifierChangementEtatSource, verifierDepecheVerification, verifierDeuxDates, verifierPerimetreProposition,
  verifierProduit, verifierProduitCatalogue, verifierPropositionDeposee, verifierTracabilite, verifierTransition, verifierVerdict,
  type ProduitCatalogueSaisi, type ProduitSaisi, type StatutProposition,
} from "./teledetection.noyau";

/**
 * Observation de la Terre (partie E) : ce que ces tests defendent.
 *   - un produit sans licence, provenance, incertitude ou version de traitement n'entre pas ;
 *   - l'optique porte sa couverture nuageuse, un palier payant son autorisation de depense ;
 *   - le terrain juge une fois, en citant son constat ; chaque transition est decidee par une table exhaustive ;
 *   - une source n'est « active » que par TRAITEMENT_OPERATIONNEL ;
 *   - zero verdict n'est pas zero pour cent ;
 *   - aucun seuil de score n'est ecrit.
 */

describe("Le noyau ne depend de rien", () => {
  it("n'a aucun import ni seuil de score", () => {
    const src = readFileSync(join(__dirname, "teledetection.noyau.ts"), "utf8");
    expect([...src.matchAll(/^import .*?from\s+["']/gm)]).toHaveLength(0);
    expect(src).not.toMatch(/score\s*[<>]=?\s*0?\.\d/);
  });
});

const optique: ProduitSaisi = {
  palier: 0, source: "Sentinel-2 L2A", nature: "OPTIQUE", dateAcquisition: new Date("2026-10-01"), resolutionM: 10,
  couvertureNuagesPct: 12, incertitude: "+/- 1 pixel", provenance: "scene-id", licence: "relevee a la source", versionTraitement: "v0",
};
const code = (v: { ok: boolean; code?: string }) => (v.ok ? "OK" : v.code);

describe("verifierProduit", () => {
  it("accepte un produit complet, et un radar sans couverture nuageuse", () => {
    expect(code(verifierProduit(optique))).toBe("OK");
    expect(code(verifierProduit({ ...optique, nature: "RADAR", couvertureNuagesPct: null }))).toBe("OK");
  });
  it.each([
    [{ licence: "  " }, "CHAMP_MANQUANT"],
    [{ provenance: "" }, "CHAMP_MANQUANT"],
    [{ incertitude: "" }, "CHAMP_MANQUANT"],
    [{ versionTraitement: "" }, "CHAMP_MANQUANT"],
    [{ couvertureNuagesPct: null }, "NUAGES_REQUIS"],
    [{ couvertureNuagesPct: 120 }, "NUAGES_HORS_BORNES"],
    [{ palier: 1 }, "DEPENSE_NON_AUTORISEE"],
    [{ palier: 4 }, "PALIER_INVALIDE"],
    [{ nature: "LIDAR" }, "NATURE_INVALIDE"],
    [{ resolutionM: 0 }, "RESOLUTION_INVALIDE"],
    [{ dateFin: new Date("2026-09-01") }, "PERIODE_INVERSEE"],
  ])("refuse %j -> %s", (o, attendu) => {
    expect(code(verifierProduit({ ...optique, ...o } as ProduitSaisi))).toBe(attendu);
  });
  it("un palier payant passe avec la reference de l'autorisation", () => {
    expect(code(verifierProduit({ ...optique, palier: 1, autorisationDepenseRef: "DEC-2026-001" }))).toBe("OK");
  });
});

describe("Tracabilite d'un produit de catalogue", () => {
  const cat: ProduitCatalogueSaisi = {
    ...optique, fournisseur: "COPERNICUS", identifiantFournisseur: "S2A_X", collection: "SENTINEL-2", capteur: "MSI", niveauTraitement: "L2A",
  };
  it("accepte un produit de catalogue complet, par defaut au cycle de vie CATALOGUE", () => {
    expect(code(verifierProduitCatalogue(cat))).toBe("OK");
  });
  it.each([
    [{ identifiantFournisseur: "" }, "CHAMP_MANQUANT"],
    [{ collection: " " }, "CHAMP_MANQUANT"],
    [{ capteur: "" }, "CHAMP_MANQUANT"],
    [{ niveauTraitement: "" }, "CHAMP_MANQUANT"],
    [{ empreinteSha256: "abc" }, "EMPREINTE_INVALIDE"],
    [{ empreinteSha256: "A".repeat(64) }, "EMPREINTE_INVALIDE"],
    [{ cycleVie: "TELECHARGE" }, "EMPREINTE_REQUISE"],
    [{ cycleVie: "ARCHIVE", empreinteSha256: "a".repeat(64) }, "EMPREINTE_REQUISE"],
    [{ cycleVie: "CATALOGUE", empreinteSha256: "a".repeat(64), stockageChemin: "x" }, "CATALOGUE_AVEC_STOCKAGE"],
    [{ cycleVie: "INCONNU" }, "CYCLE_VIE_INVALIDE"],
    [{ stockageChemin: "https://u:p@hote/f.zip", cycleVie: "TELECHARGE", empreinteSha256: "a".repeat(64) }, "STOCKAGE_AVEC_SECRET"],
    [{ resolutionNativeM: 0 }, "RESOLUTION_INVALIDE"],
  ])("refuse %j -> %s", (o, attendu) => {
    expect(code(verifierProduitCatalogue({ ...cat, ...o } as ProduitCatalogueSaisi))).toBe(attendu);
  });
  it("un produit telecharge avec empreinte et chemin interne passe", () => {
    expect(code(verifierProduitCatalogue({ ...cat, cycleVie: "TELECHARGE", empreinteSha256: "a".repeat(64), stockageChemin: "eo/2026/x.zip" }))).toBe("OK");
  });
  it("fournisseur et identifiant vont ensemble", () => {
    expect(code(verifierTracabilite({ fournisseur: "X" }))).toBe("FOURNISSEUR_INCOMPLET");
    expect(code(verifierTracabilite({}))).toBe("OK");
  });
  it("le code d'un produit de catalogue est deterministe", () => {
    expect(codeProduitCatalogue(" COPERNICUS ", " S2A_X ")).toBe("COPERNICUS:S2A_X");
  });
});

describe("verifierVerdict (ancienne API)", () => {
  it("le terrain confirme ou infirme, en citant son constat", () => {
    expect(code(verifierVerdict("A_VERIFIER", { statut: "CONFIRMEE", motif: "Eau constatee", constatRef: "mission:X" }))).toBe("OK");
    expect(code(verifierVerdict("A_VERIFIER", { statut: "INFIRMEE", motif: "Chaussee seche", constatRef: "observation:Y" }))).toBe("OK");
  });
  it("refuse un verdict sans constat, un verdict inconnu, une reprise", () => {
    expect(code(verifierVerdict("A_VERIFIER", { statut: "CONFIRMEE", motif: "x" }))).toBe("CONSTAT_REQUIS");
    expect(code(verifierVerdict("A_VERIFIER", { statut: "PROBABLE", motif: "x", constatRef: "y" }))).toBe("VERDICT_INVALIDE");
    expect(code(verifierVerdict("CONFIRMEE", { statut: "INFIRMEE", motif: "x", constatRef: "y" }))).toBe("VERDICT_DEJA_RENDU");
  });
  it("une proposition en attente peut encore recevoir son verdict", () => {
    expect(code(verifierVerdict("EN_ATTENTE", { statut: "CONFIRMEE", motif: "x", constatRef: "y" }))).toBe("OK");
  });
});

describe("Depeche d'une verification", () => {
  it("tant que la proposition n'a pas de verdict, une seule fois", () => {
    expect(code(verifierDepecheVerification({ statut: "A_VERIFIER", missionId: null }))).toBe("OK");
    expect(code(verifierDepecheVerification({ statut: "EN_ATTENTE", missionId: null }))).toBe("OK");
    expect(code(verifierDepecheVerification({ statut: "NON_CONCLUANTE", missionId: null }))).toBe("OK");
    expect(code(verifierDepecheVerification({ statut: "A_VERIFIER", missionId: "m" }))).toBe("MISSION_DEJA_DEPECHEE");
    expect(code(verifierDepecheVerification({ statut: "INFIRMEE", missionId: null }))).toBe("VERDICT_DEJA_RENDU");
    expect(code(verifierDepecheVerification({ statut: "CONFIRMEE", missionId: null }))).toBe("VERDICT_DEJA_RENDU");
  });
  it("code de mission stable", () => {
    expect(codeMissionTeledetection("3f2a9c1e-77aa-4b2c-9d10-000000000000")).toBe("VER-TD-3F2A9C1E");
  });
});

describe("Comparaison de deux dates", () => {
  const produit = { id: "p-new", dateAcquisition: new Date("2026-10-01") };
  it("sans reference : rien a verifier", () => expect(verifierDeuxDates(produit, null)).toEqual({ ok: true }));
  it("reference anterieure : acceptee", () => expect(verifierDeuxDates(produit, { id: "p-ref", dateAcquisition: new Date("2026-09-01") })).toEqual({ ok: true }));
  it("reference du meme jour ou posterieure : refusee", () => {
    expect(verifierDeuxDates(produit, { id: "p-ref", dateAcquisition: new Date("2026-10-01") })).toMatchObject({ ok: false, code: "REFERENCE_NON_ANTERIEURE" });
    expect(verifierDeuxDates(produit, { id: "p-ref", dateAcquisition: new Date("2026-11-01") })).toMatchObject({ ok: false, code: "REFERENCE_NON_ANTERIEURE" });
  });
  it("le produit lui-meme comme reference : refuse", () => expect(verifierDeuxDates(produit, { ...produit })).toMatchObject({ ok: false, code: "REFERENCE_IDENTIQUE" }));
});

// ===================================================================== transitions de statut

/** Oracle ECRIT A LA MAIN, independant de TRANSITIONS_AUTORISEES : contrat section 3 et brief du chantier. */
const ATTENDU: Record<StatutProposition, StatutProposition[]> = {
  A_VERIFIER: ["EN_ATTENTE", "NON_CONCLUANTE", "CONFIRMEE", "INFIRMEE"],
  EN_ATTENTE: ["A_VERIFIER", "EN_ATTENTE", "NON_CONCLUANTE", "CONFIRMEE", "INFIRMEE"],
  NON_CONCLUANTE: ["A_VERIFIER", "EN_ATTENTE", "CONFIRMEE", "INFIRMEE"],
  CONFIRMEE: [],
  INFIRMEE: [],
};
const demande = (de: StatutProposition, vers: string) => ({
  de, vers, motif: "motif", ...(vers === "EN_ATTENTE" ? { motifAttente: "INFO_DEMANDEE" } : {}), ...(vers === "CONFIRMEE" || vers === "INFIRMEE" ? { constatRef: "mission:X" } : {}),
});

describe("Table des transitions : les 25 couples, exhaustivement", () => {
  it("la table du noyau est celle de l'oracle (aucune transition en trop ni en moins)", () => {
    for (const de of STATUTS_PROPOSITION) expect([...TRANSITIONS_AUTORISEES[de]].sort()).toEqual([...ATTENDU[de]].sort());
  });
  for (const de of STATUTS_PROPOSITION) {
    for (const vers of STATUTS_PROPOSITION) {
      const permis = ATTENDU[de].includes(vers);
      it(`${de} -> ${vers} : ${permis ? "autorisee" : "interdite"}`, () => {
        const v = verifierTransition(demande(de, vers));
        if (permis) expect(v).toEqual({ ok: true });
        else expect(code(v)).toBe(estDefinitif(de) ? "VERDICT_DEFINITIF" : "TRANSITION_INTERDITE");
      });
    }
  }
  it("un statut inconnu est refuse avant tout", () => expect(code(verifierTransition({ de: "A_VERIFIER", vers: "PROBABLE", motif: "x" }))).toBe("STATUT_INVALIDE"));
});

describe("Motif, motif d'attente, constat et preuves d'une transition", () => {
  it("toute transition est motivee, dans la limite du contrat", () => {
    expect(code(verifierTransition({ de: "A_VERIFIER", vers: "NON_CONCLUANTE", motif: "  " }))).toBe("MOTIF_REQUIS");
    expect(code(verifierTransition({ de: "A_VERIFIER", vers: "NON_CONCLUANTE" }))).toBe("MOTIF_REQUIS");
    expect(code(verifierTransition({ de: "A_VERIFIER", vers: "NON_CONCLUANTE", motif: "x".repeat(1001) }))).toBe("MOTIF_TROP_LONG");
    expect(code(verifierTransition({ de: "A_VERIFIER", vers: "NON_CONCLUANTE", motif: "x".repeat(1000) }))).toBe("OK");
  });
  it("EN_ATTENTE exige INFO_DEMANDEE ou AUTRE ; les autres statuts n'en veulent pas", () => {
    expect(code(verifierTransition({ de: "A_VERIFIER", vers: "EN_ATTENTE", motif: "m" }))).toBe("MOTIF_ATTENTE_REQUIS");
    expect(code(verifierTransition({ de: "A_VERIFIER", vers: "EN_ATTENTE", motif: "m", motifAttente: "PEUT_ETRE" }))).toBe("MOTIF_ATTENTE_REQUIS");
    expect(code(verifierTransition({ de: "A_VERIFIER", vers: "EN_ATTENTE", motif: "m", motifAttente: "AUTRE" }))).toBe("OK");
    expect(code(verifierTransition({ de: "EN_ATTENTE", vers: "A_VERIFIER", motif: "m", motifAttente: "AUTRE" }))).toBe("MOTIF_ATTENTE_INTERDIT");
  });
  it("un verdict cite un constat : une reference ou au moins une observation", () => {
    expect(code(verifierTransition({ de: "A_VERIFIER", vers: "CONFIRMEE", motif: "m" }))).toBe("CONSTAT_REQUIS");
    expect(code(verifierTransition({ de: "A_VERIFIER", vers: "INFIRMEE", motif: "m", constatRef: "  " }))).toBe("CONSTAT_REQUIS");
    expect(code(verifierTransition({ de: "A_VERIFIER", vers: "INFIRMEE", motif: "m", observationIds: [] }))).toBe("CONSTAT_REQUIS");
    expect(code(verifierTransition({ de: "A_VERIFIER", vers: "CONFIRMEE", motif: "m", observationIds: ["o1"] }))).toBe("OK");
    expect(code(verifierTransition({ de: "A_VERIFIER", vers: "CONFIRMEE", motif: "m", constatRef: "mission:X" }))).toBe("OK");
  });
  it("les preuves : identifiants non blancs, sans doublon", () => {
    expect(code(verifierTransition({ de: "A_VERIFIER", vers: "NON_CONCLUANTE", motif: "m", observationIds: [" "] }))).toBe("OBSERVATION_INVALIDE");
    expect(code(verifierTransition({ de: "A_VERIFIER", vers: "NON_CONCLUANTE", motif: "m", observationIds: ["a", "a"] }))).toBe("OBSERVATION_EN_DOUBLE");
  });
  it("la reference du constat : la reference donnee, sinon les observations citees", () => {
    expect(construireConstatRef(" mission:X ", ["o1"])).toBe("mission:X");
    expect(construireConstatRef(null, ["o1", "o2"])).toBe("observation:o1;observation:o2");
    expect(construireConstatRef("", [])).toBeNull();
  });
  it("estDefinitif ne vise que les deux verdicts", () => {
    expect(STATUTS_PROPOSITION.filter(estDefinitif)).toEqual(["CONFIRMEE", "INFIRMEE"]);
  });
});

// ===================================================================== proposition deposee et rattachement

describe("verifierPropositionDeposee", () => {
  const ok = { type: "INONDATION", geometrie: { type: "Point", coordinates: [0, 0] }, limites: ["Resolution native 10 m"] };
  it("accepte une proposition complete", () => expect(code(verifierPropositionDeposee(ok))).toBe("OK"));
  it.each([
    [{ limites: [] }, "LIMITES_REQUISES"],
    [{ limites: undefined }, "LIMITES_REQUISES"],
    [{ limites: ["ok", "  "] }, "LIMITES_REQUISES"],
    [{ type: "AUTRE" }, "TYPE_INVALIDE"],
    [{ geometrie: { type: "Circle" } }, "GEOMETRIE_INVALIDE"],
    [{ score: 1.2 }, "VALEUR_HORS_BORNES"],
    [{ confianceDetection: -0.1 }, "VALEUR_HORS_BORNES"],
    [{ imageCouvertureNuagesPct: 101 }, "VALEUR_HORS_BORNES"],
    [{ imageNote: " " }, "CHAMP_MANQUANT"],
    [{ priorite: { niveau: "URGENTE", regle: "r" } }, "PRIORITE_INVALIDE"],
    [{ priorite: { niveau: "HAUTE", regle: " " } }, "PRIORITE_SANS_REGLE"],
  ])("refuse %j -> %s", (o, attendu) => {
    expect(code(verifierPropositionDeposee({ ...ok, ...o } as never))).toBe(attendu);
  });
  it("les bornes sont incluses", () => {
    expect(code(verifierPropositionDeposee({ ...ok, score: 0, confianceDetection: 1, imageCouvertureNuagesPct: 100, priorite: { niveau: "FAIBLE", regle: "r" } }))).toBe("OK");
  });
});

describe("evaluerRattachement", () => {
  const c = (id: string, d: number) => ({ tronconId: id, code: id.toUpperCase(), distanceM: d });
  it("sans tolerance : aucun rattachement tente, et c'est dit", () => {
    expect(evaluerRattachement(null, [c("a", 1)])).toMatchObject({ retenu: null, confiance: "AUCUN", algorithme: "NON_DEMANDE", concurrents: [] });
  });
  it("aucun troncon dans la tolerance : AUCUN", () => {
    expect(evaluerRattachement(100, [])).toMatchObject({ retenu: null, confiance: "AUCUN", algorithme: "PLUS_PROCHE_DANS_TOLERANCE_V1" });
  });
  it("un seul troncon : HAUTE s'il est dans la premiere moitie de la tolerance, sinon MOYENNE", () => {
    expect(evaluerRattachement(100, [c("a", 50)]).confiance).toBe("HAUTE");
    expect(evaluerRattachement(100, [c("a", 50.1)]).confiance).toBe("MOYENNE");
  });
  it("un concurrent proche : FAIBLE ; nettement plus loin (au moins le double) : MOYENNE", () => {
    expect(evaluerRattachement(100, [c("a", 22), c("b", 33)]).confiance).toBe("FAIBLE");
    expect(evaluerRattachement(100, [c("a", 22), c("b", 44)]).confiance).toBe("MOYENNE");
    expect(evaluerRattachement(100, [c("a", 5.6), c("b", 50)]).confiance).toBe("MOYENNE");
  });
  it("deux troncons a la meme distance (carrefour) : FAIBLE, y compris a distance nulle", () => {
    expect(evaluerRattachement(100, [c("a", 0), c("b", 0)]).confiance).toBe("FAIBLE");
    expect(evaluerRattachement(100, [c("a", 10), c("b", 10)]).confiance).toBe("FAIBLE");
  });
  it("le troncon retenu est le premier, les autres sont les concurrents, bornes a 5", () => {
    const r = evaluerRattachement(1000, [c("a", 1), ...Array.from({ length: 8 }, (_, i) => c(`x${i}`, 100 + i))]);
    expect(r.retenu?.tronconId).toBe("a");
    expect(r.concurrents).toHaveLength(5);
    expect(r.concurrents[0].tronconId).toBe("x0");
  });
});

// ===================================================================== sources

describe("Echelle d'etat d'une source", () => {
  const src = (etat: string, requiertIdentifiants = false) => ({ etat, requiertIdentifiants });
  it("huit etats : six echelons et deux etats lateraux, « active » est le dernier echelon", () => {
    expect(ETATS_SOURCE).toHaveLength(8);
    expect(ECHELLE_ETAT_SOURCE[ECHELLE_ETAT_SOURCE.length - 1]).toBe("TRAITEMENT_OPERATIONNEL");
  });
  it("un changement d'etat porte le message du test", () => {
    expect(code(verifierChangementEtatSource(src("NON_CONFIGUREE"), { vers: "ACCESSIBLE" }))).toBe("MESSAGE_REQUIS");
    expect(code(verifierChangementEtatSource(src("NON_CONFIGUREE"), { vers: "ACCESSIBLE", message: " " }))).toBe("MESSAGE_REQUIS");
    expect(code(verifierChangementEtatSource(src("NON_CONFIGUREE"), { vers: "ACCESSIBLE", message: "200 OK" }))).toBe("OK");
  });
  it("un etat inconnu est refuse", () => expect(code(verifierChangementEtatSource(src("NON_CONFIGUREE"), { vers: "ACTIVE", message: "m" }))).toBe("ETAT_INVALIDE"));
  it("un test de connectivite ne mene jamais a TRAITEMENT_OPERATIONNEL", () => {
    for (const etat of ["NON_CONFIGUREE", "CONFIGUREE", "AUTHENTIFIEE", "ACCESSIBLE", "EN_ERREUR", "EN_ATTENTE_CONFIGURATION"]) {
      expect(code(verifierChangementEtatSource(src(etat, true), { vers: "TRAITEMENT_OPERATIONNEL", message: "m", preuveTraitement: "run" }))).toBe("ECHELON_NON_ATTEINT");
    }
  });
  it("TRAITEMENT_OPERATIONNEL se gagne depuis PRODUIT_DISPONIBLE, avec la preuve d'un traitement reel", () => {
    expect(code(verifierChangementEtatSource(src("PRODUIT_DISPONIBLE"), { vers: "TRAITEMENT_OPERATIONNEL", message: "m" }))).toBe("PREUVE_TRAITEMENT_REQUISE");
    expect(code(verifierChangementEtatSource(src("PRODUIT_DISPONIBLE"), { vers: "TRAITEMENT_OPERATIONNEL", message: "m", preuveTraitement: "run-1" }))).toBe("OK");
  });
  it("AUTHENTIFIEE et EN_ATTENTE_CONFIGURATION n'existent que pour une source qui exige des identifiants", () => {
    expect(code(verifierChangementEtatSource(src("NON_CONFIGUREE", false), { vers: "AUTHENTIFIEE", message: "m" }))).toBe("ETAT_NON_APPLICABLE");
    expect(code(verifierChangementEtatSource(src("NON_CONFIGUREE", false), { vers: "EN_ATTENTE_CONFIGURATION", message: "m" }))).toBe("ETAT_NON_APPLICABLE");
    expect(code(verifierChangementEtatSource(src("NON_CONFIGUREE", true), { vers: "AUTHENTIFIEE", message: "m" }))).toBe("OK");
  });
  it("descendre apres un echec est admis, y compris depuis l'etat « actif »", () => {
    expect(code(verifierChangementEtatSource(src("TRAITEMENT_OPERATIONNEL"), { vers: "EN_ERREUR", message: "503" }))).toBe("OK");
    expect(code(verifierChangementEtatSource(src("PRODUIT_DISPONIBLE"), { vers: "ACCESSIBLE", message: "fenetre vide" }))).toBe("OK");
  });
});

// ===================================================================== indicateurs

describe("Taux de confirmation terrain", () => {
  it("zero verdict : valeur NULLE (jamais 0), echantillon insuffisant", () => {
    expect(calculerTauxConfirmation(0, 0)).toMatchObject({ valeur: null, jugees: 0, echantillonSuffisant: false, seuil: 30 });
  });
  it("un verdict : taux 1 mais echantillon insuffisant", () => {
    expect(calculerTauxConfirmation(1, 0)).toMatchObject({ valeur: 1, jugees: 1, echantillonSuffisant: false });
    expect(calculerTauxConfirmation(0, 1)).toMatchObject({ valeur: 0, jugees: 1, echantillonSuffisant: false });
  });
  it("deux verdicts : confirmees / (confirmees + infirmees)", () => {
    expect(calculerTauxConfirmation(1, 1)).toMatchObject({ valeur: 0.5, jugees: 2, echantillonSuffisant: false });
  });
  it("le seuil de 30 verdicts : 29 insuffisant, 30 suffisant", () => {
    expect(calculerTauxConfirmation(20, 9).echantillonSuffisant).toBe(false);
    const t = calculerTauxConfirmation(20, 10);
    expect(t.echantillonSuffisant).toBe(true);
    expect(t.valeur).toBeCloseTo(2 / 3, 12);
  });
  it("un seuil explicite remplace le defaut", () => expect(calculerTauxConfirmation(1, 1, 2).echantillonSuffisant).toBe(true));
  it("la definition dit que ce n'est pas la precision statistique", () => {
    expect(calculerTauxConfirmation(1, 1).definition).toMatch(/pas la precision statistique/);
  });
  it("le seuil de l'application est celui de la migration (30, PROVISOIRE)", () => {
    const sql = readFileSync(join(__dirname, "../../prisma/migrations/20261028120000_eo_qualite_methodes/migration.sql"), "utf8");
    expect(SEUIL_ECHANTILLON_TAUX).toBe(30);
    expect(sql).toMatch(/eo_seuil_echantillon_taux\(\) RETURNS integer[\s\S]*?SELECT 30 /);
  });
});

describe("Comptage des sources", () => {
  it("tous les etats figurent, avec des comptes reels ; seule TRAITEMENT_OPERATIONNEL est « active »", () => {
    const c = compterSourcesParEtat(["NON_CONFIGUREE", "NON_CONFIGUREE", "EN_ATTENTE_CONFIGURATION", "EN_ATTENTE_CONFIGURATION"]);
    expect(c.total).toBe(4);
    expect(c.actives).toBe(0);
    expect(Object.keys(c.parEtat)).toHaveLength(8);
    expect(c.parEtat.NON_CONFIGUREE).toBe(2);
    expect(c.parEtat.TRAITEMENT_OPERATIONNEL).toBe(0);
  });
  it("une source operationnelle est active", () => {
    expect(compterSourcesParEtat(["TRAITEMENT_OPERATIONNEL", "ACCESSIBLE"]).actives).toBe(1);
  });
  it("aucune source : total nul, aucune active", () => expect(compterSourcesParEtat([])).toMatchObject({ total: 0, actives: 0 }));
});

describe("Age de la derniere acquisition", () => {
  const now = new Date("2026-10-25T12:00:00Z");
  it("en jours entiers, arrondi inferieur", () => {
    expect(ageEnJours(now, new Date("2026-10-12T00:00:00Z"))).toBe(13);
    expect(ageEnJours(now, new Date("2026-10-25T00:00:00Z"))).toBe(0);
  });
  it("sans date : nul ; date future : 0", () => {
    expect(ageEnJours(now, null)).toBeNull();
    expect(ageEnJours(now, new Date("2027-01-01"))).toBe(0);
  });
});

// ===================================================================== perimetre

describe("Perimetre territorial d'une proposition", () => {
  const r12 = { national: false as const, regions: new Set([1, 2]) };
  it("sans perimetre ou national : tout est permis, y compris une proposition non rattachee", () => {
    expect(verifierPerimetreProposition(undefined, null)).toEqual({ ok: true });
    expect(verifierPerimetreProposition({ national: true }, null)).toEqual({ ok: true });
    expect(verifierPerimetreProposition({ national: true }, 7)).toEqual({ ok: true });
  });
  it("un compte regional : ses regions seulement", () => {
    expect(verifierPerimetreProposition(r12, 1)).toEqual({ ok: true });
    expect(code(verifierPerimetreProposition(r12, 3))).toBe("HORS_PERIMETRE");
  });
  it("une proposition non rattachee n'est decidee que par un compte national", () => {
    expect(code(verifierPerimetreProposition(r12, null))).toBe("HORS_PERIMETRE");
  });
  // Mutation survivante M18 (constat EO-FIX-BACK 10) : sans la branche « region inconnue », `Set.has(null)` etant faux, le refus survivait
  // par la branche suivante et AUCUN test ne le voyait. On defend la branche elle-meme : sa raison, et le fait qu'elle precede le test d'appartenance.
  it("la region INCONNUE a son propre refus (raison « aucun troncon »), meme si le perimetre contenait une valeur nulle ou zero", () => {
    const v = verifierPerimetreProposition(r12, null);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.motif).toMatch(/aucun troncon/);
    const piege = { national: false as const, regions: new Set<number>([0]) as ReadonlySet<number> };
    expect(code(verifierPerimetreProposition(piege, null))).toBe("HORS_PERIMETRE");
    expect(verifierPerimetreProposition(piege, 0)).toEqual({ ok: true });
    // un jeu de regions qui contiendrait NULL par erreur (Set heterogene venu de la base) n'ouvre pas les propositions non rattachees
    const sale = { national: false as const, regions: new Set([1, null as unknown as number]) as ReadonlySet<number> };
    expect(code(verifierPerimetreProposition(sale, null))).toBe("HORS_PERIMETRE");
  });
});
