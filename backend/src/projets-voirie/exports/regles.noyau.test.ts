import { afterEach, describe, expect, it, vi } from "vitest";
import {
  etatDerogation, selectionGeojson, verifierBeneficiaire, verifierCreationDerogation, verifierDerogationCitee, type JeuCandidat,
} from "./confidentialite.noyau";
import { CadenceMemoire, verifierCadence } from "./cadence.noyau";
import { exportCadenceMax, exportObjetsMax, niveauxExportables } from "./config";
import { journalCsv, masquerDetails } from "./journal-documents.noyau";
import { agregatsAnalyse } from "./fiche.noyau";
import { celluleCsv } from "../analyse.service";

/** Regles du lot X1 (noyaux purs) : qui sort en GeoJSON, derogation, cadence, reglages, journal des documents (injection CSV), agregats sans geometrie. */

afterEach(() => { vi.unstubAllEnvs(); });

const STATUTS = ["RECU", "CONTROLE", "AUTORISE", "REJETE", "REMPLACE", "RETIRE"] as const;
const NIVEAUX = ["PUBLIC", "INTERNE", "RESTREINT_PROJET", "CONFIDENTIEL_CONCESSIONNAIRE", "INFRASTRUCTURE_SENSIBLE"] as const;
const SENSIBLES = ["CONFIDENTIEL_CONCESSIONNAIRE", "INFRASTRUCTURE_SENSIBLE"];
const jeu = (statut: string, confidentialite: string, id = `${statut}-${confidentialite}`): JeuCandidat => ({ id, role: "RESEAU_TIERS", version: 1, statut, confidentialite });

describe("selection GeoJSON : matrice complete statut x niveau x derogation x demande", () => {
  it("seuls les jeux AUTORISE d'un niveau exportable, ou d'un niveau sensible COUVERT par la derogation, sortent ; un RETIRE n'apparait nulle part", () => {
    let cas = 0;
    for (const statut of STATUTS) for (const niveau of NIVEAUX) for (const derogation of [false, true]) for (const demande of [true, false]) {
      const j = jeu(statut, niveau);
      const s = selectionGeojson([j], { demande, niveaux: niveauxExportables(), jeuxDerogation: new Set(derogation ? [j.id] : []) });
      cas++;
      if (statut === "RETIRE") { expect(s.inclus.length + s.ecartes.length, "retire absent").toBe(0); continue; }
      const attenduInclus = statut === "AUTORISE" && demande && (SENSIBLES.includes(niveau) ? derogation : true);
      expect(s.inclus.length === 1, `${statut} ${niveau} der=${derogation} dem=${demande}`).toBe(attenduInclus);
      if (attenduInclus) expect(s.inclus[0].derogation).toBe(SENSIBLES.includes(niveau));
      else {
        const raison = statut !== "AUTORISE" ? "NON_AUTORISE" : !demande ? "GEOJSON_NON_DEMANDE" : "CONFIDENTIALITE";
        expect(s.ecartes[0].raison, `${statut} ${niveau}`).toBe(raison);
      }
    }
    expect(cas).toBe(STATUTS.length * NIVEAUX.length * 4);
  });

  it("une derogation ne couvre que les jeux qu'elle nomme ; un jeu sensible non nomme reste ecarte", () => {
    const a = jeu("AUTORISE", "INFRASTRUCTURE_SENSIBLE", "a"), b = jeu("AUTORISE", "INFRASTRUCTURE_SENSIBLE", "b");
    const s = selectionGeojson([a, b], { demande: true, niveaux: niveauxExportables(), jeuxDerogation: new Set(["a"]) });
    expect(s.inclus.map((x) => x.jeu.id)).toEqual(["a"]);
    expect(s.ecartes.map((x) => [x.jeu.id, x.raison])).toEqual([["b", "CONFIDENTIALITE"]]);
  });

  it("aucun reglage ne rend un niveau sensible exportable, meme si la liste passee le contient par erreur ; un niveau inconnu est refuse (echec ferme)", () => {
    const s = selectionGeojson([jeu("AUTORISE", "CONFIDENTIEL_CONCESSIONNAIRE"), jeu("AUTORISE", "SECRET_FUTUR")],
      { demande: true, niveaux: [...NIVEAUX, "SECRET_FUTUR"], jeuxDerogation: new Set(["AUTORISE-SECRET_FUTUR"]) });
    expect(s.inclus).toEqual([]);
    expect(s.ecartes.map((x) => x.raison)).toEqual(["CONFIDENTIALITE", "CONFIDENTIALITE"]);
  });

  it("le reglage PROJETS_VOIRIE_EXPORT_GEOJSON_NIVEAUX ne peut que RESTREINDRE la liste par defaut", () => {
    expect(niveauxExportables(undefined)).toEqual(["PUBLIC", "INTERNE", "RESTREINT_PROJET"]);
    expect(niveauxExportables("public, interne")).toEqual(["PUBLIC", "INTERNE"]);
    expect(niveauxExportables("CONFIDENTIEL_CONCESSIONNAIRE,INFRASTRUCTURE_SENSIBLE")).toEqual(["PUBLIC", "INTERNE", "RESTREINT_PROJET"]);
    expect(niveauxExportables("PUBLIC,INFRASTRUCTURE_SENSIBLE")).toEqual(["PUBLIC"]);
    expect(niveauxExportables("")).toEqual(["PUBLIC", "INTERNE", "RESTREINT_PROJET"]);
    const s = selectionGeojson([jeu("AUTORISE", "RESTREINT_PROJET")], { demande: true, niveaux: niveauxExportables("PUBLIC"), jeuxDerogation: new Set() });
    expect(s.ecartes[0].raison).toBe("NIVEAU_NON_EXPORTABLE");
  });
});

describe("derogation : citee par un export, creee par un ADMIN", () => {
  const maintenant = new Date("2026-11-10T10:00:00Z");
  const d = { id: "d1", projetId: "p1", beneficiaireId: "u1", jeuxIds: ["j1"], utiliseeLe: null, expireLe: new Date("2026-11-11T10:00:00Z") };

  it("valide pour SON projet et SON beneficiaire seulement ; inconnue, autre projet, autre compte : le MEME 404", () => {
    expect(verifierDerogationCitee(d, { projetId: "p1", acteurId: "u1", maintenant })).toEqual({ ok: true });
    for (const [der, c] of [[null, { projetId: "p1", acteurId: "u1" }], [d, { projetId: "p2", acteurId: "u1" }], [d, { projetId: "p1", acteurId: "u2" }]] as const) {
      const v = verifierDerogationCitee(der, { ...c, maintenant });
      expect(v).toMatchObject({ ok: false, status: 404, code: "DEROGATION_INTROUVABLE", message: "Dérogation introuvable pour ce projet et ce compte." });
    }
  });

  it("usage unique et expiration : utilisee ou expiree, 409 DEROGATION_INDISPONIBLE avec l'etat (l'echeance exacte est expiree)", () => {
    expect(verifierDerogationCitee({ ...d, utiliseeLe: new Date("2026-11-10T09:00:00Z") }, { projetId: "p1", acteurId: "u1", maintenant })).toMatchObject({ status: 409, extra: { etat: "UTILISEE" } });
    expect(verifierDerogationCitee({ ...d, expireLe: maintenant }, { projetId: "p1", acteurId: "u1", maintenant })).toMatchObject({ status: 409, extra: { etat: "EXPIREE" } });
    expect(etatDerogation({ utiliseeLe: null, expireLe: new Date(maintenant.getTime() + 1) }, maintenant)).toBe("DISPONIBLE");
    expect(etatDerogation({ utiliseeLe: maintenant, expireLe: new Date(0) }, maintenant)).toBe("UTILISEE");
  });

  it("creation : justification (20 caracteres), duree bornee, jeux distincts du projet, AUTORISE, d'un niveau sensible ; sinon le code du refus", () => {
    const trouves = new Map([
      ["s", { id: "s", statut: "AUTORISE", confidentialite: "INFRASTRUCTURE_SENSIBLE" }],
      ["c", { id: "c", statut: "CONTROLE", confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE" }],
      ["p", { id: "p", statut: "AUTORISE", confidentialite: "INTERNE" }],
      ["r", { id: "r", statut: "RETIRE", confidentialite: "INFRASTRUCTURE_SENSIBLE" }],
    ]);
    const base = { trouves, justification: "Transmission au maitre d'oeuvre pour etudes d'execution", dureeH: 24, dureeMaxH: 168 };
    const code = (o: Partial<typeof base> & { demandes: string[] }) => {
      const v = verifierCreationDerogation({ ...base, ...o });
      return v.ok ? "OK" : `${v.status}:${v.code}`;
    };
    expect(code({ demandes: ["s"] })).toBe("OK");
    expect(code({ demandes: ["s"], justification: "trop court" })).toBe("400:JUSTIFICATION_INVALIDE");
    expect(code({ demandes: ["s"], justification: "  " + "x".repeat(19) + "   " })).toBe("400:JUSTIFICATION_INVALIDE");
    expect(code({ demandes: ["s"], dureeH: 0 })).toBe("400:CHAMPS_INVALIDES");
    expect(code({ demandes: ["s"], dureeH: 169 })).toBe("400:CHAMPS_INVALIDES");
    expect(code({ demandes: ["s", "s"] })).toBe("400:CHAMPS_INVALIDES");
    expect(code({ demandes: [] })).toBe("400:CHAMPS_INVALIDES");
    expect(code({ demandes: ["inconnu"] })).toBe("404:JEU_INTROUVABLE");
    expect(code({ demandes: ["r"] })).toBe("404:JEU_INTROUVABLE");
    expect(code({ demandes: ["c"] })).toBe("409:JEU_NON_AUTORISE");
    expect(code({ demandes: ["s", "p"] })).toBe("409:DEROGATION_INUTILE");
  });

  it("beneficiaire : actif, ADMIN ou GESTIONNAIRE avec la cle du module, perimetre couvrant la region du projet", () => {
    const ok = { actif: true, role: "GESTIONNAIRE", modules: ["projets-voirie"], perimetreCouvre: true };
    expect(verifierBeneficiaire(ok)).toEqual({ ok: true });
    expect(verifierBeneficiaire({ ...ok, role: "ADMIN", modules: [] })).toEqual({ ok: true });
    for (const b of [null, { ...ok, actif: false }, { ...ok, role: "LECTEUR" }, { ...ok, role: "INSPECTEUR" }, { ...ok, modules: ["troncons"] }]) {
      expect(verifierBeneficiaire(b)).toMatchObject({ status: 422, code: "BENEFICIAIRE_NON_HABILITE" });
    }
    expect(verifierBeneficiaire({ ...ok, perimetreCouvre: false })).toMatchObject({ status: 422, code: "BENEFICIAIRE_HORS_PERIMETRE" });
  });
});

describe("cadence par compte (fenetre glissante)", () => {
  const t0 = new Date("2026-11-10T10:00:00Z");
  const avant = (s: number) => new Date(t0.getTime() - s * 1000);
  it("refuse au plafond, avec le delai jusqu'a la sortie du plus ancien qui compte ; ignore ce qui est hors fenetre ; un horodatage futur compte", () => {
    expect(verifierCadence({ horodatages: [avant(10), avant(20)], maintenant: t0, fenetreS: 60, plafond: 3 })).toEqual({ ok: true });
    expect(verifierCadence({ horodatages: [avant(10), avant(20), avant(50)], maintenant: t0, fenetreS: 60, plafond: 3 })).toEqual({ ok: false, retryAfterS: 10 });
    expect(verifierCadence({ horodatages: [avant(10), avant(20), avant(70)], maintenant: t0, fenetreS: 60, plafond: 3 })).toEqual({ ok: true });
    expect(verifierCadence({ horodatages: [new Date(t0.getTime() + 3_600_000)], maintenant: t0, fenetreS: 60, plafond: 1 })).toEqual({ ok: false, retryAfterS: 60 });
  });
  it("en memoire : un refus n'enregistre rien ; comptes independants ; taille bornee", () => {
    const c = new CadenceMemoire(2);
    expect(c.tenter("a", t0, 60, 2).ok).toBe(true);
    expect(c.tenter("a", t0, 60, 2).ok).toBe(true);
    expect(c.tenter("a", t0, 60, 2)).toEqual({ ok: false, retryAfterS: 60 });
    expect(c.tenter("b", t0, 60, 2).ok).toBe(true);
    expect(c.tenter("a", new Date(t0.getTime() + 61_000), 60, 2).ok).toBe(true);
    c.tenter("c", t0, 60, 2);
    expect(c.taille).toBe(2);
  });
  it("reglages bornes : defaut, valeur valide, valeur hors bornes ou illisible", () => {
    expect([exportCadenceMax(), exportObjetsMax()]).toEqual([10, 50_000]);
    vi.stubEnv("PROJETS_VOIRIE_EXPORT_CADENCE_MAX", "3");
    vi.stubEnv("PROJETS_VOIRIE_EXPORT_OBJETS_MAX", "10");
    expect([exportCadenceMax(), exportObjetsMax()]).toEqual([3, 50_000]);
    vi.stubEnv("PROJETS_VOIRIE_EXPORT_CADENCE_MAX", "abc");
    expect(exportCadenceMax()).toBe(10);
  });
});

describe("journal des documents : injection de formules et jeux non lisibles", () => {
  const DANGEREUX = ["=HYPERLINK(\"http://x\",\"y\")", "+1+1", "-2+3", "@SUM(A1:A2)", "\tcache", "\rretour", "=cmd|' /C calc'!A0"];
  it("chaque cellule qui commence par = + - @ tabulation ou retour est neutralisee (apostrophe), separateurs et guillemets proteges", () => {
    for (const s of DANGEREUX) expect(celluleCsv(s).replace(/^"/, "").startsWith("'"), s).toBe(true);
    expect(celluleCsv("a;b")).toBe('"a;b"');
    expect(celluleCsv('dit "non"')).toBe('"dit ""non"""');
    expect(celluleCsv(-3.5)).toBe("-3,5");
  });

  it("le CSV du journal neutralise titres, justifications, references et noms venant des utilisateurs", () => {
    const docs = [{ id: "d1", ligneeId: "d1", version: 1, typeCode: "AUTRE", titre: DANGEREUX[0], statut: "RECU", piece: { reference: DANGEREUX[3], nomFichier: null, format: null, sha256: null } }];
    const histo = [{ id: 1, documentId: "d1", version: 1, action: "CREATION", statutAvant: null, statutApres: "RECU", par: { id: "u", nomComplet: "+Agent" }, justification: DANGEREUX[1], details: { reference: DANGEREUX[3] }, le: new Date("2026-11-10T00:00:00Z") }];
    const csv = journalCsv(docs, histo, new Set());
    const cellules = csv.replace(/^﻿/, "").split("\r\n")[1].split(";");
    for (const c of cellules) expect(/^"?[=+\-@\t\r]/.test(c), c).toBe(false);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+Agent");
  });

  it("details d'historique : identifiant, nom de fichier et format d'un jeu non lisible (retire) masques ; un jeu lisible reste designe", () => {
    expect(masquerDetails({ jeuId: "jr", nomFichier: "x.geojson", format: "GEOJSON", sha256: null }, new Set(["ja"]))).toEqual({ sha256: null, jeuMasque: true });
    expect(masquerDetails({ jeuId: "ja", nomFichier: "x.geojson" }, new Set(["ja"]))).toEqual({ jeuId: "ja", nomFichier: "x.geojson" });
    expect(masquerDetails(null, new Set())).toEqual({});
    const csv = journalCsv([], [{ id: 1, documentId: "d", version: 1, action: "DEPOT", statutAvant: "ATTENDU", statutApres: "RECU", par: { id: "u", nomComplet: "A" }, justification: null, details: { jeuId: "jr", nomFichier: "secret.geojson", format: "GEOJSON" }, le: new Date(0) }], new Set());
    expect(csv).not.toContain("secret.geojson");
  });
});

describe("agregats d'analyse : jamais de geometrie ni de liste d'objets", () => {
  it("les couches de croisements et de zones et les objets par axe sont retires ; une cle inconnue n'entre pas", () => {
    const reponse = {
      projet: { id: "p" }, parametres: { largeurEmpriseM: 15 }, reseaux: { parType: [] }, cleFuture: { coordinates: [[0, 0]] },
      conflits: {
        total: { chausseeM: 12 }, parConcessionnaire: [],
        parAxe: [{ axe: "Axe 1", empriseM: 3, objets: [{ nom: "objet secret", objetId: "1" }], objetsTronques: false }],
        croisements: { type: "FeatureCollection", features: [{ geometry: { type: "Point", coordinates: [1, 2] } }], nbTotal: 1 },
        zones: { chaussee: { type: "Polygon", coordinates: [] } },
      },
    };
    const a = agregatsAnalyse(reponse);
    const texte = JSON.stringify(a);
    expect(texte).not.toMatch(/coordinates|objet secret|Polygon|Feature/);
    expect(a).not.toHaveProperty("cleFuture");
    expect((a.conflits as { parAxe: unknown[] }).parAxe).toEqual([{ axe: "Axe 1", empriseM: 3, nbObjetsListes: 1 }]);
    expect((a.conflits as { croisements: unknown }).croisements).toEqual({ nbTotal: 1, geometries: "non exportees" });
  });
});
