import { describe, expect, it } from "vitest";
import {
  classerErreurDocuments, controlerFichierPiece, gestePiece, lireCompletude, lireDocument, lireEcritureDocument, lireFicheDocument, lirePageDocuments,
  nombreOuNonCommunique, peutRetirerDocument, textePiece, transitionsPourCompte, TAILLE_MAX_PIECE,
} from "./projetsVoirieDocuments";

/** Regles pures et lecteurs du lot D1 (interface UI-D). Donnees 100 % SYNTHETIQUES. */

const docServeur = (over: Record<string, unknown> = {}) => ({
  id: "d1", projetId: "p1", ligneeId: "d1", version: 1, remplaceId: null, typeCode: "PLAN_AXES", type: { code: "PLAN_AXES", libelle: "Plan d'axes", actif: true },
  titre: "Plan synthetique", description: null, dateDocument: null, concessionnaire: null, statut: "EXPLOITABLE",
  piece: { reference: "REF-1", nomFichier: "plan.pdf", format: "PDF", sha256: "a".repeat(64), tailleOctets: 2048, jeuLie: false },
  jeu: null, exploitable: { possible: true, raison: null }, aide: "PDF", creePar: { id: "u1", nomComplet: "Auteur" }, createdAt: "2026-11-01T00:00:00Z",
  deposePar: { id: "u-dep", nomComplet: "Deposant" }, deposeLe: "2026-11-02T00:00:00Z", validePar: null, valideLe: null,
  derniereAction: { par: { id: "u-dep", nomComplet: "Deposant" }, le: "2026-11-02T00:00:00Z", justification: null },
  transitionsPossibles: ["VALIDE", "A_CORRIGER", "REJETE"], ...over,
});
const lu = (over: Record<string, unknown> = {}) => { const d = lireDocument(docServeur(over)); if (!d) throw new Error("illisible"); return d; };
const erreur = (status: number, data: Record<string, unknown> = {}, headers: Record<string, string> = {}) => ({ response: { status, data, headers } });

describe("transitions proposees", () => {
  it("VALIDE n'est jamais propose au deposant de la piece, avec l'explication (separation des taches)", () => {
    const t = transitionsPourCompte(lu(), "u-dep");
    expect(t.proposees.map((x) => x.statut)).toEqual(["A_CORRIGER", "REJETE"]);
    expect(t.ecartees).toEqual([{ statut: "VALIDE", raison: expect.stringMatching(/séparation des tâches/) }]);
  });
  it("une autre personne habilitee recoit VALIDE (justification exigee)", () => {
    const t = transitionsPourCompte(lu(), "u-autre");
    expect(t.proposees.find((x) => x.statut === "VALIDE")).toEqual({ statut: "VALIDE", libelle: "Valider", justificationExigee: true });
    expect(t.ecartees).toEqual([]);
  });
  it("DWG non exploitable (selon le serveur) : ni EXPLOITABLE ni VALIDE, explique", () => {
    const t = transitionsPourCompte(lu({ statut: "EN_ANALYSE", transitionsPossibles: ["EXPLOITABLE", "INCOMPLET", "A_CORRIGER", "REJETE"], exploitable: { possible: false, raison: "DWG_NON_EXPLOITABLE" } }), "u-autre");
    expect(t.proposees.map((x) => x.statut)).toEqual(["INCOMPLET", "A_CORRIGER", "REJETE"]);
    expect(t.ecartees[0].raison).toMatch(/DXF/);
  });
  it("jeu lie non autorise : EXPLOITABLE ecarte avec la raison", () => {
    const t = transitionsPourCompte(lu({ statut: "EN_ANALYSE", transitionsPossibles: ["EXPLOITABLE"], exploitable: { possible: false, raison: "JEU_NON_AUTORISE" } }), "x");
    expect(t.proposees).toEqual([]);
    expect(t.ecartees[0].raison).toMatch(/autorisez-le/);
  });
  it("lecteur : le serveur ne rend aucune transition, rien n'est propose (jamais deduit du statut)", () => {
    const d = lu({ transitionsPossibles: undefined });
    expect(d.transitionsPossibles).toBeNull();
    expect(transitionsPourCompte(d, "u-autre")).toEqual({ proposees: [], ecartees: [] });
  });
  it("un statut pose par le serveur seulement (REMPLACE, RECU) n'est jamais propose meme s'il etait rendu", () => {
    expect(transitionsPourCompte(lu({ transitionsPossibles: ["REMPLACE", "RECU", "EN_ANALYSE"] }), "x").proposees.map((p) => p.statut)).toEqual(["EN_ANALYSE"]);
  });
  it("justification exigee pour INCOMPLET, A_CORRIGER, VALIDE, REJETE seulement", () => {
    const t = transitionsPourCompte(lu({ statut: "EN_ANALYSE", transitionsPossibles: ["EXPLOITABLE", "INCOMPLET", "A_CORRIGER", "REJETE"] }), "x");
    expect(t.proposees.map((p) => [p.statut, p.justificationExigee])).toEqual([["EXPLOITABLE", false], ["INCOMPLET", true], ["A_CORRIGER", true], ["REJETE", true]]);
  });
});

describe("retrait, geste de piece", () => {
  it("retrait : ADMIN toujours, GESTIONNAIRE sauf piece VALIDE, lecteur jamais", () => {
    expect(peutRetirerDocument(lu({ statut: "VALIDE" }), "ADMIN").possible).toBe(true);
    expect(peutRetirerDocument(lu({ statut: "VALIDE" }), "GESTIONNAIRE")).toEqual({ possible: false, raison: expect.stringMatching(/administrateur/) });
    expect(peutRetirerDocument(lu({ statut: "RECU" }), "GESTIONNAIRE").possible).toBe(true);
    expect(peutRetirerDocument(lu(), "LECTEUR")).toEqual({ possible: false, raison: null });
    expect(peutRetirerDocument(lu(), undefined).possible).toBe(false);
  });
  it("depot sur un document attendu, nouvelle version sinon", () => {
    expect(gestePiece(lu({ statut: "ATTENDU" }))).toBe("DEPOT");
    for (const s of ["RECU", "EN_ANALYSE", "EXPLOITABLE", "VALIDE", "REJETE", "REMPLACE"]) expect(gestePiece(lu({ statut: s }))).toBe("VERSION");
  });
});

describe("fichier d'une piece (controle local, jamais lu)", () => {
  it("vide et trop gros refuses ; PDF et DWG reconnus par l'extension (indice) ; autre extension : avertissement, pas de refus", () => {
    expect(controlerFichierPiece(null).ok).toBe(false);
    expect(controlerFichierPiece({ name: "a.pdf", size: 0 }).message).toMatch(/vide/);
    expect(controlerFichierPiece({ name: "a.pdf", size: TAILLE_MAX_PIECE + 1 }).message).toMatch(/25 Mo/);
    expect(controlerFichierPiece({ name: "Plan.PDF", size: 10 })).toMatchObject({ ok: true, format: "PDF" });
    expect(controlerFichierPiece({ name: "plan.dwg", size: 10 })).toMatchObject({ ok: true, format: "DWG" });
    expect(controlerFichierPiece({ name: "plan.geojson", size: 10 })).toMatchObject({ ok: true, format: null, avertissement: expect.stringMatching(/jeu de données/) });
  });
});

describe("lecteurs", () => {
  it("document : jeu illisible (null) et jeuLie inconnu restent null, jamais deduits", () => {
    const d = lu({ jeu: null, exploitable: null, piece: { reference: null, nomFichier: null, format: null, sha256: null, tailleOctets: null, jeuLie: null }, statut: "VALIDE" });
    expect(d.exploitable).toBeNull();
    expect(d.piece.jeuLie).toBeNull();
    expect(textePiece(d)).toBe("pièce non communiquée à votre compte");
  });
  it("texte de piece : reference, fichier, jeu lie, attendu", () => {
    expect(textePiece(lu())).toBe("référence REF-1 ; fichier plan.pdf (PDF, 2 Ko)");
    expect(textePiece(lu({ statut: "ATTENDU", piece: { jeuLie: false } }))).toBe("aucune pièce : document attendu");
    expect(textePiece(lu({ piece: { jeuLie: true, nomFichier: "x.geojson" }, jeu: { id: "j1", statut: "CONTROLE", role: "AXES_TRAVAUX", version: 2, format: "GEOJSON" } }))).toBe("jeu de données lié (version 2, controle)");
    expect(textePiece(lu({ piece: { jeuLie: true }, jeu: null }))).toBe("jeu de données lié, non lisible par votre compte");
  });
  it("document de statut inconnu : ecarte et compte (jamais affiche avec un statut invente)", () => {
    const p = lirePageDocuments({ documents: [docServeur(), docServeur({ id: "d2", statut: "ARCHIVE" })], curseurSuivant: "c2" });
    expect(p.documents.map((d) => d.id)).toEqual(["d1"]);
    expect(p).toMatchObject({ ignores: 1, suivant: "c2" });
  });
  it("reponse sans structure : leve (aucune valeur deduite)", () => {
    expect(() => lirePageDocuments({})).toThrow(/Réponse inattendue/);
    expect(() => lireFicheDocument({ versions: [] })).toThrow(/Réponse inattendue/);
    expect(() => lireCompletude({ piecesManquantes: [] })).toThrow(/Réponse inattendue/);
    expect(() => lireEcritureDocument({ avertissements: [] }, "POST x")).toThrow(/Réponse inattendue/);
  });
  it("fiche : historique absent (lecteur) = null ; present (decideur) = liste ; troncatures lues", () => {
    expect(lireFicheDocument({ document: docServeur(), versions: [{ id: "d1", version: 1, statut: "VALIDE", createdAt: "x" }] }).historique).toBeNull();
    const f = lireFicheDocument({ document: docServeur(), versions: [], versionsTronquees: true, historiqueTronque: true, historique: [{ id: 3, action: "DEPOT", statutAvant: "ATTENDU", statutApres: "RECU", par: { id: "u", nomComplet: "U" }, details: { jeuMasque: true }, le: "2026-11-01" }] });
    expect(f.historique?.[0]).toMatchObject({ action: "DEPOT", details: { jeuMasque: true } });
    expect(f).toMatchObject({ versionsTronquees: true, historiqueTronque: true });
  });
  it("ecriture : avertissements DWG et remplace lus", () => {
    const r = lireEcritureDocument({ document: docServeur(), remplace: { id: "d0", version: 1, statut: "REMPLACE" }, avertissements: [{ code: "DWG_NON_EXPLOITABLE", message: "m" }, { x: 1 }] }, "POST");
    expect(r.avertissements).toEqual([{ code: "DWG_NON_EXPLOITABLE", message: "m" }]);
    expect(r.remplace).toEqual({ id: "d0", version: 1, statut: "REMPLACE" });
  });
  it("completude : fonctions, conditions, pieces (trois natures), troncature, piece illisible comptee", () => {
    const c = lireCompletude({
      calculeLe: "2026-11-10T00:00:00Z",
      fonctions: [
        { code: "ANALYSE_2D", libelle: "Analyse 2D", etat: "DISPONIBLE", conditions: [{ code: "PLAN_AXES_AUTORISE", remplie: true, nb: 1 }] },
        { code: "RECOLEMENT", etat: "INDISPONIBLE", conditions: [{ code: "DECISION_DEPLACEMENT", remplie: false, nb: 0 }] },
        { code: "FUTURE", etat: "NON_LIVREE", conditions: [] }, { code: "X", etat: "BIZARRE" },
      ],
      piecesManquantes: [
        { nature: "CONDITION", code: "SECONDE_SOURCE", reseau: { concessionnaire: "Op A", typeReseau: "TELECOM" }, fonctions: ["COMPARAISON_SOURCES"], suffiraitPour: ["COMPARAISON_SOURCES"], typesDocument: [{ code: "RC", libelle: "Réseau" }] },
        { nature: "TYPE_OBLIGATOIRE", typeDocument: { code: "PV", libelle: "Procès-verbal" }, roleJeu: null, fonctions: [], suffiraitPour: [] },
        { nature: "DOCUMENT", document: { id: "d9", version: 2, titre: "T", statut: "INCOMPLET" }, fonctions: ["CONFLITS"] },
        { nature: "INCONNUE" },
      ],
      documents: { total: 7, parStatut: { VALIDE: 2, ATTENDU: 5, FAUX: 1 }, tronque: true },
    });
    expect(c.fonctions.map((f) => [f.code, f.etat])).toEqual([["ANALYSE_2D", "DISPONIBLE"], ["RECOLEMENT", "INDISPONIBLE"], ["FUTURE", "NON_LIVREE"], ["X", "INDISPONIBLE"]]);
    // Libelles accentues du client quand le code est connu ; sinon celui du serveur, sinon le code.
    expect(c.fonctions[0].libelle).toBe("Analyse 2D (longueurs dans la chaussée et l'emprise)");
    expect(c.fonctions[2].libelle).toBe("FUTURE");
    expect(c.piecesManquantes.map((p) => p.nature)).toEqual(["CONDITION", "TYPE_OBLIGATOIRE", "DOCUMENT"]);
    expect(c.piecesIgnorees).toBe(1);
    expect(c.documents).toEqual({ total: 7, parStatut: { VALIDE: 2, ATTENDU: 5 }, tronque: true });
  });
  it("nombre non communique n'est jamais zero", () => {
    expect(nombreOuNonCommunique(null)).toBe("non communiqué");
    expect(nombreOuNonCommunique(0)).toBe("0");
  });
});

describe("erreurs typees", () => {
  it.each([
    [400, "JUSTIFICATION_INVALIDE", "validation", /justification d'au moins 10/],
    [400, "CHAMPS_INVALIDES", "validation", /caractère de contrôle/],
    [400, "PIECE_EXCLUSIVE", "validation", /ne vont pas ensemble/],
    [403, "ROLE_INSUFFISANT", "droit", /réservé à un administrateur/],
    [404, "DOCUMENT_INTROUVABLE", "introuvable", /pas visible de votre compte/],
    [404, "PROJET_INTROUVABLE", "introuvable", /périmètre/],
    [409, "SEPARATION_DES_TACHES", "conflit", /ne la valide pas/],
    [409, "DOCUMENT_NON_EXPLOITABLE", "conflit", /DXF/],
    [409, "TRANSITION_INTERDITE", "conflit", /Rechargez/],
    [409, "VERSION_NON_COURANTE", "conflit", /dernière/],
    [413, "FICHIER_TROP_GROS", "trop-gros", /25 Mo/],
    [415, "FORMAT_DOCUMENT_NON_PRIS_EN_CHARGE", "validation", /ni un PDF ni un DWG/],
    [503, "SERVICE_OCCUPE", "serveur", /réessayez/],
    [504, "DOCUMENTS_LECTURE_TROP_LONGUE", "serveur", /délai/],
  ])("%s %s", (status, code, genre, motif) => {
    const e = classerErreurDocuments(erreur(status, { code }));
    expect(e.genre).toBe(genre);
    expect(e.message).toMatch(motif);
  });
  it("413 et 415 sans code (mandataire) : messages de piece", () => {
    expect(classerErreurDocuments(erreur(413)).message).toMatch(/25 Mo/);
    expect(classerErreurDocuments(erreur(415)).message).toMatch(/ni un PDF ni un DWG/);
  });
  it("429 avec Retry-After (en-tete) et 503 avec retryAfterS", () => {
    expect(classerErreurDocuments(erreur(429, {}, { "retry-after": "12" })).message).toMatch(/12 secondes/);
    expect(classerErreurDocuments(erreur(503, { code: "SERVICE_OCCUPE", retryAfterS: 5 })).message).toMatch(/5 secondes/);
  });
  it("504 sans code et 422 inconnu : messages generiques sans deduction", () => {
    expect(classerErreurDocuments(erreur(504)).message).toMatch(/trop de temps/);
    expect(classerErreurDocuments(erreur(422, { error: "Texte du serveur" })).message).toBe("Texte du serveur");
  });
  it("hors ligne : erreur de reseau", () => {
    expect(classerErreurDocuments(new Error("Network Error")).genre).toBe("reseau");
  });
});
