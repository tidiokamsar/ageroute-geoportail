import { describe, expect, it } from "vitest";
import {
  NON_COMMUNIQUE, apercuArchive, beneficiairesProposables, classerErreurExports, derogationsUtilisables, jeuDerogeable, jeuxParStatut, lireAgregat,
  lireDerogations, lireJournalExports, lireTableauDeBord, nomFichierExport, valeurAgregat, verifierSaisieDerogation,
  type Derogation, type Lisibilite,
} from "./projetsVoirieExports";

/** Regles pures et lecteurs du lot X1 (interface UI-D). Donnees 100 % SYNTHETIQUES. */

const erreur = (status: number, data: Record<string, unknown> = {}, headers: Record<string, string> = {}) => ({ response: { status, data, headers } });
const jeu = (id: string, statut: string, confidentialite: string) => ({ id, statut, confidentialite, libelle: id });

describe("prevision de l'archive (contrat 4.3 et 5)", () => {
  const jeux = [
    jeu("axes", "AUTORISE", "RESTREINT_PROJET"), jeu("pub", "AUTORISE", "PUBLIC"), jeu("int", "AUTORISE", "INTERNE"),
    jeu("telecom", "AUTORISE", "CONFIDENTIEL_CONCESSIONNAIRE"), jeu("eau", "AUTORISE", "INFRASTRUCTURE_SENSIBLE"),
    jeu("ctrl", "CONTROLE", "PUBLIC"), jeu("retire", "RETIRE", "PUBLIC"), jeu("futur", "AUTORISE", "NIVEAU_FUTUR"),
  ];
  it("sans derogation : niveaux sensibles et niveau inconnu exclus (CONFIDENTIALITE), non autorise exclu, retire absent", () => {
    const a = apercuArchive(jeux, { geojson: true, jeuxDerogation: new Set() });
    expect(a.inclus.map((x) => x.jeu.id)).toEqual(["axes", "pub", "int"]);
    expect(a.ecartes.map((x) => [x.jeu.id, x.raison])).toEqual([["telecom", "CONFIDENTIALITE"], ["eau", "CONFIDENTIALITE"], ["ctrl", "NON_AUTORISE"], ["futur", "CONFIDENTIALITE"]]);
    expect([...a.inclus, ...a.ecartes].some((x) => x.jeu.id === "retire")).toBe(false);
  });
  it("derogation : seuls les jeux qu'elle nomme sortent, marques ; jamais un niveau inconnu ni un jeu non autorise", () => {
    const a = apercuArchive(jeux, { geojson: true, jeuxDerogation: new Set(["telecom", "futur", "ctrl"]) });
    expect(a.inclus.filter((x) => x.derogation).map((x) => x.jeu.id)).toEqual(["telecom"]);
    expect(a.ecartes.find((x) => x.jeu.id === "eau")?.raison).toBe("CONFIDENTIALITE");
    expect(a.ecartes.find((x) => x.jeu.id === "futur")?.raison).toBe("CONFIDENTIALITE");
    expect(a.ecartes.find((x) => x.jeu.id === "ctrl")?.raison).toBe("NON_AUTORISE");
  });
  it("GeoJSON non demande : rien n'est inclus", () => {
    const a = apercuArchive(jeux, { geojson: false, jeuxDerogation: new Set(["telecom"]) });
    expect(a.inclus).toEqual([]);
    expect(a.ecartes.filter((x) => x.raison === "GEOJSON_NON_DEMANDE").length).toBe(6);
  });
  it("jeu derogeable : AUTORISE et sensible seulement", () => {
    expect(jeuDerogeable({ statut: "AUTORISE", confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE" })).toBe(true);
    expect(jeuDerogeable({ statut: "AUTORISE", confidentialite: "INTERNE" })).toBe(false);
    expect(jeuDerogeable({ statut: "CONTROLE", confidentialite: "INFRASTRUCTURE_SENSIBLE" })).toBe(false);
  });
});

describe("derogations : saisie, beneficiaire, etat", () => {
  const comptes = [
    { id: "moi", nom: "Admin Moi", email: null, role: "ADMIN" as const, modules: null },
    { id: "a2", nom: "Admin Deux", email: null, role: "ADMIN" as const, modules: [] },
    { id: "g1", nom: "Gestion Un", email: null, role: "GESTIONNAIRE" as const, modules: ["projets-voirie"] },
    { id: "g2", nom: "Gestion Deux", email: null, role: "GESTIONNAIRE" as const, modules: ["autre"] },
  ];
  it("l'administrateur qui accorde n'est jamais propose ; un gestionnaire sans cle est montre, non proposable", () => {
    const b = beneficiairesProposables(comptes, "moi");
    expect(b.map((x) => x.compte.id)).toEqual(["a2", "g1", "g2"]);
    expect(b.find((x) => x.compte.id === "g2")).toMatchObject({ proposable: false, raison: expect.stringMatching(/clé du module/) });
    expect(b.find((x) => x.compte.id === "a2")?.proposable).toBe(true);
  });
  it("saisie : jeux, beneficiaire (pas soi), justification 20, duree 1 a 168", () => {
    const ok = { jeuxIds: ["j1"], beneficiaireId: "g1", justification: "x".repeat(20), dureeHeures: 24 };
    expect(verifierSaisieDerogation(ok, "moi")).toEqual([]);
    expect(verifierSaisieDerogation({ ...ok, beneficiaireId: "moi" }, "moi")).toEqual([expect.stringMatching(/séparation des tâches/)]);
    expect(verifierSaisieDerogation({ ...ok, jeuxIds: [] }, "moi")[0]).toMatch(/au moins un jeu/);
    expect(verifierSaisieDerogation({ ...ok, jeuxIds: Array.from({ length: 21 }, (_, i) => `j${i}`) }, "moi")[0]).toMatch(/au plus 20/);
    expect(verifierSaisieDerogation({ ...ok, justification: "x".repeat(19) }, "moi")[0]).toMatch(/20 caractères/);
    expect(verifierSaisieDerogation({ ...ok, dureeHeures: 169 }, "moi")[0]).toMatch(/1 à 168/);
    expect(verifierSaisieDerogation({ ...ok, dureeHeures: 0 }, "moi")[0]).toMatch(/1 à 168/);
    expect(verifierSaisieDerogation({ ...ok, dureeHeures: null }, "moi")[0]).toMatch(/1 à 168/);
    expect(verifierSaisieDerogation({ ...ok, beneficiaireId: null }, "moi")[0]).toMatch(/bénéficiaire/);
  });
  it("lecture : etat du serveur (DISPONIBLE, RESERVEE, UTILISEE, EXPIREE) ; inconnu = null, jamais disponible", () => {
    const ds = lireDerogations({ derogations: ["DISPONIBLE", "RESERVEE", "UTILISEE", "EXPIREE", "REVOQUEE"].map((etat, i) => ({ id: `d${i}`, etat, jeuxIds: ["j"], beneficiaire: { id: "g1", nomComplet: "G" } })) });
    expect(ds.map((d) => d.etat)).toEqual(["DISPONIBLE", "RESERVEE", "UTILISEE", "EXPIREE", null]);
    expect(ds[4].etatBrut).toBe("REVOQUEE");
  });
  it("utilisables par le beneficiaire : les siennes, DISPONIBLE seulement (horloge du serveur)", () => {
    const d = (id: string, b: string, etat: Derogation["etat"]): Derogation => ({ id, projetId: "p", jeuxIds: [], beneficiaire: { id: b, nomComplet: null }, accordeePar: null, justification: null, createdAt: null, expireLe: null, utiliseeLe: null, exportId: null, etat, etatBrut: etat });
    expect(derogationsUtilisables([d("1", "moi", "DISPONIBLE"), d("2", "autre", "DISPONIBLE"), d("3", "moi", "EXPIREE"), d("4", "moi", "RESERVEE"), d("5", "moi", null)], "moi").map((x) => x.id)).toEqual(["1"]);
    expect(derogationsUtilisables([d("1", "moi", "DISPONIBLE")], undefined)).toEqual([]);
  });
});

describe("journal et nom de fichier", () => {
  it("journal : statut de tentative lu ; ancien journal sans statut mais avec empreinte = remis", () => {
    const j = lireJournalExports({ exports: [{ id: "e1", statut: "ECHEC", codeEchec: "EXPORT_TROP_VOLUMINEUX" }, { id: "e2", sha256: "a".repeat(64), nbFichiers: 9 }, { id: "e3", statut: "AUTRE" }, { x: 1 }] });
    expect(j.map((t) => [t.id, t.statut])).toEqual([["e1", "ECHEC"], ["e2", "REMIS"], ["e3", null]]);
    expect(() => lireJournalExports({})).toThrow(/Réponse inattendue/);
  });
  it("nom de fichier : celui de Content-Disposition, assaini ; sinon un nom par defaut", () => {
    expect(nomFichierExport('attachment; filename="dossier-pv-01-2026-11-10.zip"', "PV-01")).toBe("dossier-pv-01-2026-11-10.zip");
    expect(nomFichierExport('attachment; filename="../../etc/passwd"', "PV-01")).toBe("dossier-pv-01.zip");
    expect(nomFichierExport(undefined, "PV 01")).toBe("dossier-pv_01.zip");
  });
});

describe("tableaux de bord : rien de non communique n'est zero", () => {
  const decideur: Lisibilite = { jeux: "TOUS_SAUF_RETIRE", conflits: "TOUS", documentsEnCours: true, referents: true };
  const lecteur: Lisibilite = { jeux: "AUTORISE_SEULEMENT", conflits: "DOSSIERS_VISIBLES", documentsEnCours: false, referents: false };
  it("agregat lecteur : pieces en attente et referents null", () => {
    const a = lireAgregat({ projets: 3, jeux: { AUTORISE: 4 }, conflits: { POTENTIEL: 1 }, documentsManquants: { typesObligatoiresNonFournis: 2, projetsIncomplets: 1, piecesEnAttente: null, piecesEnAttenteParStatut: null }, referentsActifs: null });
    expect(a.documentsManquants.piecesEnAttente).toBeNull();
    expect(a.referentsActifs).toBeNull();
    expect(valeurAgregat(a.documentsManquants.piecesEnAttente)).toBe(NON_COMMUNIQUE);
    expect(valeurAgregat(0)).toBe("0");
  });
  it("jeux par statut : decideur, 0 pour un statut absent ; lecteur, seul AUTORISE compte, le reste non communique", () => {
    const a = lireAgregat({ jeux: { AUTORISE: 4, CONTROLE: 2 } });
    expect(jeuxParStatut(a, decideur)).toEqual([{ statut: "RECU", n: 0 }, { statut: "CONTROLE", n: 2 }, { statut: "AUTORISE", n: 4 }, { statut: "REJETE", n: 0 }, { statut: "REMPLACE", n: 0 }]);
    const l = jeuxParStatut(lireAgregat({ jeux: { AUTORISE: 4 } }), lecteur);
    expect(l.find((x) => x.statut === "AUTORISE")?.n).toBe(4);
    expect(l.filter((x) => x.statut !== "AUTORISE").every((x) => x.n === null)).toBe(true);
  });
  it("lisibilite absente : echec ferme (la plus restreinte)", () => {
    const t = lireTableauDeBord({ portee: "NATIONAL", total: {}, parRegion: [] });
    expect(t.lisibilite).toEqual(lecteur);
  });
  it("national : regions ; territoire : enfants, rattaches directement, non ventiles ; structure absente : leve", () => {
    const n = lireTableauDeBord({ portee: "NATIONAL", lisibilite: decideur, total: { projets: 2 }, parRegion: [{ regionId: 4, region: "Region Test", projets: 2 }, { regionId: null, region: null, projets: 0 }] });
    expect(n.lignes.map((l) => [l.cle, l.libelle])).toEqual([["4", "Region Test"], ["sans-region", "Sans région"]]);
    const t = lireTableauDeBord({ portee: "TERRITOIRE", lisibilite: decideur, total: {}, territoire: { id: "t1", code: "T1", nom: "Territoire Test", niveau: "REGION", ancetres: [{ id: "n", nom: "Nation" }] }, enfants: [{ territoireId: "t2", code: "T2", nom: "Sous", niveau: "COMMUNE", projets: 1 }], rattachesDirectement: { projets: 1 }, nonVentiles: { projets: 0 }, tronque: true });
    expect(t.territoire?.ancetres).toEqual([{ id: "n", nom: "Nation" }]);
    expect(t.lignes[0]).toMatchObject({ cle: "t2", libelle: "Sous", niveau: "COMMUNE" });
    expect(t.rattachesDirectement?.projets).toBe(1);
    expect(t.tronque).toBe(true);
    expect(() => lireTableauDeBord({ portee: "AUTRE", total: {} })).toThrow(/Réponse inattendue/);
  });
});

describe("erreurs typees", () => {
  it.each([
    [400, { code: "JUSTIFICATION_INVALIDE" }, "validation", /20 caractères/],
    [403, { code: "CONFIDENTIALITE_ABAISSEMENT_RESERVE" }, "droit", /administrateur/],
    [404, { code: "DEROGATION_INTROUVABLE" }, "introuvable", /son bénéficiaire/],
    [404, { code: "TERRITOIRE_INTROUVABLE" }, "introuvable", /périmètre/],
    [409, { code: "DEROGATION_INDISPONIBLE", etat: "UTILISEE" }, "conflit", /usage unique/],
    [409, { code: "DEROGATION_INDISPONIBLE", etat: "EXPIREE" }, "conflit", /expiré/],
    [409, { code: "DEROGATION_INDISPONIBLE", etat: "RESERVEE" }, "conflit", /export en cours/],
    [409, { code: "SEPARATION_DES_TACHES" }, "conflit", /jamais le bénéficiaire/],
    [409, { code: "DEROGATION_INUTILE" }, "conflit", /sans dérogation/],
    [422, { code: "BENEFICIAIRE_HORS_PERIMETRE" }, "validation", /région de ce projet/],
    [422, { code: "BENEFICIAIRE_NON_HABILITE" }, "validation", /clé du module/],
    [504, { code: "EXPORT_TROP_LONG" }, "serveur", /délai/],
    [504, { code: "TABLEAU_DE_BORD_TROP_LONG" }, "serveur", /délai/],
  ])("%s %o", (status, data, genre, motif) => {
    const e = classerErreurExports(erreur(status, data as Record<string, unknown>));
    expect(e.genre).toBe(genre);
    expect(e.message).toMatch(motif);
  });
  it("422 volumes : objets, sommets ou octets avec leurs plafonds", () => {
    expect(classerErreurExports(erreur(422, { code: "EXPORT_TROP_VOLUMINEUX", objets: 60000, objetsMax: 50000 })).message).toMatch(/60 000 objets pour 50 000 au plus/);
    expect(classerErreurExports(erreur(422, { code: "EXPORT_TROP_VOLUMINEUX", sommets: 1200000, sommetsMax: 1000000 })).message).toMatch(/1 200 000 sommets/);
    expect(classerErreurExports(erreur(422, { code: "EXPORT_TROP_VOLUMINEUX", octetsEstimes: 80 * 1024 * 1024, octetsMax: 64 * 1024 * 1024 })).message).toMatch(/80 Mo estimés pour 64 Mo au plus/);
  });
  it("429 cadence : retryAfterS du corps ou en-tete Retry-After", () => {
    expect(classerErreurExports(erreur(429, { code: "EXPORT_TROP_FREQUENT", retryAfterS: 600 })).message).toMatch(/600 secondes/);
    expect(classerErreurExports(erreur(429, { code: "TABLEAU_DE_BORD_TROP_FREQUENT" }, { "retry-after": "7" })).message).toMatch(/7 secondes/);
    expect(classerErreurExports(erreur(429, {}, { "retry-after": "3" })).message).toMatch(/3 secondes/);
  });
  it("503 occupe, 504 du mandataire sans code, delai du navigateur, hors ligne", () => {
    expect(classerErreurExports(erreur(503, { code: "SERVICE_OCCUPE" })).message).toMatch(/attendez sa fin/);
    expect(classerErreurExports(erreur(504)).message).toMatch(/mandataire/);
    expect(classerErreurExports({ code: "ECONNABORTED", message: "timeout" })).toMatchObject({ code: "DELAI_NAVIGATEUR", message: expect.stringMatching(/libérée, non consommée/) });
    expect(classerErreurExports(new Error("Network Error")).genre).toBe("reseau");
  });
});
