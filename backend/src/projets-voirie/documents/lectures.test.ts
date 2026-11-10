import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { bornerDecroissant, detailsHistoriqueVisibles, vueDocument, type LigneDocument } from "./vues";
import { traduireErreurBase } from "./documents.service";
import { ErreurMetier } from "../erreurs";

/** Revue D1 : m4 (historique), m5 (jeu illisible), m7 (troncatures), m8 (delais des lectures), m9 (erreurs de la base). */
const maintenant = new Date("2026-11-10T10:00:00.000Z");
const ligne = (o: Partial<LigneDocument> = {}): LigneDocument => ({
  id: "d1", projetId: "p", ligneeId: "d1", version: 1, remplaceId: null, typeCode: "PLAN_AXES", titre: "Plan", description: null, dateDocument: null,
  concessionnaireId: null, statut: "VALIDE", reference: null, nomFichier: "axes.xml", format: "LANDXML", sha256: null, tailleOctets: null, jeuId: "j1",
  creeParId: "u1", createdAt: maintenant, deposeParId: "u1", deposeLe: maintenant, valideParId: "u2", valideLe: maintenant, derniereActionParId: "u2",
  derniereActionLe: maintenant, derniereJustification: "Valide par la direction", updatedAt: maintenant, deletedAt: null, ...o,
});
const ctx = (role: string, statutJeu: string) => ({ role, type: null, concessionnaire: null, jeu: { id: "j1", statut: statutJeu, role: "AXES_TRAVAUX", version: 1, format: "LANDXML" }, personnes: new Map() });

describe("m5 : ce qu'une vue dit d'un jeu que le compte ne voit pas", () => {
  it("lecteur, jeu REMPLACE ou RETIRE : ni jeu, ni nom, ni format, ni lien, ni exploitabilite (qui trahirait le statut du jeu)", () => {
    for (const s of ["REMPLACE", "RETIRE", "CONTROLE"]) {
      const v = vueDocument(ligne(), ctx("LECTEUR", s));
      expect([v.jeu, v.piece.nomFichier, v.piece.format, v.piece.jeuLie, v.exploitable], s).toEqual([null, null, null, null, null]);
    }
    const ok = vueDocument(ligne(), ctx("LECTEUR", "AUTORISE"));
    expect([ok.jeu?.id, ok.piece.jeuLie, ok.exploitable]).toEqual(["j1", true, { possible: true, raison: null }]);
  });
  it("decideur, jeu RETIRE : jeu masque, exploitabilite nulle ; le lien reste signale", () => {
    const v = vueDocument(ligne(), ctx("GESTIONNAIRE", "RETIRE"));
    expect([v.jeu, v.piece.jeuLie, v.exploitable]).toEqual([null, true, null]);
  });
});

describe("m4 : details d'historique d'un jeu illisible", () => {
  it("jeuId, nomFichier et format retires quand le jeu n'est pas lisible ; inchanges sinon ; rien d'autre n'est touche", () => {
    const d = { format: "LANDXML", jeuId: "j1", nomFichier: "axes.xml", remplaceId: "d0", reference: "r" };
    expect(detailsHistoriqueVisibles(d, false)).toEqual({ remplaceId: "d0", reference: "r", jeuMasque: true });
    expect(detailsHistoriqueVisibles(d, true)).toEqual(d);
    expect(detailsHistoriqueVisibles({ format: "PDF", sha256: "a" }, false)).toEqual({ format: "PDF", sha256: "a" });
  });
});

describe("m7 : troncature du bon cote", () => {
  it("lignes lues en ordre decroissant : les plus recentes sont gardees, rendues en ordre croissant, troncature signalee", () => {
    expect(bornerDecroissant([5, 4, 3, 2, 1], 3)).toEqual({ lignes: [3, 4, 5], tronque: true });
    expect(bornerDecroissant([2, 1], 3)).toEqual({ lignes: [1, 2], tronque: false });
  });
});

describe("m8 : toutes les lectures des documents passent par une transaction READ ONLY a delais cote base", () => {
  it("listerDocuments, ficheDocument et la completude appellent lectureBornee (ou poserDelais) ; aucune lecture directe par le client global", () => {
    const src = readFileSync(join(__dirname, "documents.service.ts"), "utf8");
    for (const f of ["listerDocuments", "ficheDocument"]) {
      const corps = src.slice(src.indexOf(`export async function ${f}`), src.indexOf("\nexport ", src.indexOf(`export async function ${f}`) + 10));
      expect(corps, f).toMatch(/lectureBornee\(/);
      expect(corps, f).not.toMatch(/\bprisma\./);
    }
    expect(src).toMatch(/SET TRANSACTION READ ONLY[\s\S]{0,200}poserDelais/);
    expect(readFileSync(join(__dirname, "completude.service.ts"), "utf8")).toMatch(/poserDelais/);
  });
});

describe("m9 : une violation de contrainte ou de declencheur devient une erreur typee, jamais un 500", () => {
  const inconnue = (code: string) => new Prisma.PrismaClientUnknownRequestError(`Error occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${code}", message: "x", severity: "ERROR" }) })`, { clientVersion: "5.22.0" });
  const connue = (code: string) => new Prisma.PrismaClientKnownRequestError("raw", { code: "P2010", clientVersion: "5.22.0", meta: { code, message: "x" } });
  const statutDe = (e: unknown) => { try { traduireErreurBase(e); } catch (x) { return x instanceof ErreurMetier ? `${x.status}:${x.code}` : "autre"; } return "rien"; };
  it("23503 (code de referentiel retire entre-temps), 23514 (contrainte ou declencheur), 23001 (piece figee) : 409 type ; 23505 : 409 VERSION_EN_COURS ; une autre erreur est relancee telle quelle", () => {
    expect(statutDe(inconnue("23503"))).toBe("409:REFERENCE_INVALIDE");
    expect(statutDe(connue("23514"))).toBe("409:CONTRAINTE_DOCUMENT");
    expect(statutDe(inconnue("23001"))).toBe("409:CONTRAINTE_DOCUMENT");
    expect(statutDe(new Prisma.PrismaClientKnownRequestError("u", { code: "P2002", clientVersion: "5.22.0" }))).toBe("409:VERSION_EN_COURS");
    expect(statutDe(new Error("autre"))).toBe("autre");
    // Formes reelles de Prisma 5.22 relevees par le banc : cle etrangere P2003, contrainte P2004.
    expect(statutDe(new Prisma.PrismaClientKnownRequestError("Foreign key constraint violated", { code: "P2003", clientVersion: "5.22.0" }))).toBe("409:REFERENCE_INVALIDE");
    expect(statutDe(new Prisma.PrismaClientKnownRequestError("A constraint failed", { code: "P2004", clientVersion: "5.22.0" }))).toBe("409:CONTRAINTE_DOCUMENT");
  });
});
