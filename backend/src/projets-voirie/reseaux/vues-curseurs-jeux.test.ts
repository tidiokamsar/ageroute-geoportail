import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { retenirJeux } from "./comptage.noyau";
import { avecTraductionBase, statutsLisibles, traduireErreurBase } from "./commun";
import { decoderCurseurObjet, encoderCurseurObjet } from "./curseurs.noyau";
import type { LigneObjet, LigneRelation } from "./reseaux.depot";
import { vueObjet, vueRelation } from "./vues";
import { ErreurMetier } from "../erreurs";

const objet = (o: Partial<LigneObjet> = {}): LigneObjet => ({
  objetId: "12", jeuId: "j1", nom: "Circuit synthetique", typeGeom: "LIGNE", longueurM: 60.004, ordre: 0,
  projetId: "p1", role: "RESEAU_TIERS", statutJeu: "AUTORISE", versionJeu: 2, nomFichier: "circuits.geojson", confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE",
  natureJeu: "CIRCUIT_LOGIQUE", typeReseau: "TELECOM", classeJeu: null, precisionHJeu: null, precisionVJeu: null, methodeJeu: null,
  dateDonneesJeu: new Date("2026-10-24T00:00:00Z"), dateConstatJeu: null, concessionnaireId: "c1", concessionnaireNom: "Operateur synthetique",
  aDescripteur: false, dNature: null, dTypeObjet: null, dClasse: null, dPrecisionH: null, dPrecisionV: null, dMethode: null, dDateConstat: null, dConfiance: null,
  dStatutQualite: null, dProfondeur: null, dAltitude: null, dReference: null, dJustification: null, dDeclareLe: null, dUpdatedAt: null, dDeclarePar: null, dModifiePar: null,
  ...o,
});

describe("vue d'un objet : heritage du jeu, jamais de valeur inventee, aucune geometrie", () => {
  it("sans descripteur : nature du jeu (origine JEU), classe inconnue, precisions nulles, vertical ABSENTE, source et confidentialite du jeu", () => {
    const v = vueObjet(objet());
    expect(v).toMatchObject({ id: "12", nature: "CIRCUIT_LOGIQUE", origineNature: "JEU", typeObjet: null, longueurM: 60, descripteur: null });
    expect(v.qualite).toMatchObject({ classePrecision: null, origineClasse: "INCONNUE", precisionHorizontaleM: null, precisionVerticaleM: null, statutQualite: "INCONNU", niveauConfiance: null });
    expect(v.vertical).toMatchObject({ etat: "ABSENTE", evaluable: false, conclusion3D: null, profondeurM: null, altitudeM: null });
    expect(v.source).toMatchObject({ jeuId: "j1", version: 2, confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE", dateDonnees: "2026-10-24", concessionnaire: { id: "c1", nom: "Operateur synthetique" } });
    expect(JSON.stringify(v)).not.toMatch(/"coordinates"|"geometry"|"geom"|LINESTRING/);
  });

  it("un jeu de nature inconnue donne une nature INCONNUE, jamais devinee", () => {
    expect(vueObjet(objet({ natureJeu: "INCONNUE" }))).toMatchObject({ nature: "INCONNUE", origineNature: "INCONNUE" });
  });

  it("avec descripteur : l'objet l'emporte sur le jeu, champ par champ ; la classe du jeu reste celle du jeu pour les objets sans descripteur", () => {
    const v = vueObjet(objet({
      classeJeu: "C", precisionHJeu: 5, methodeJeu: "plan de conception", aDescripteur: true, dNature: "ACTIF_PHYSIQUE", dTypeObjet: "GAINE", dClasse: "A", dPrecisionH: 0.1,
      dMethode: "GNSS RTK", dConfiance: "ELEVE", dStatutQualite: "OBSERVE", dProfondeur: 1.2, dReference: "terrain naturel", dJustification: "Releve contradictoire", dDeclarePar: "Personne A",
    }));
    expect(v).toMatchObject({ nature: "ACTIF_PHYSIQUE", origineNature: "OBJET", typeObjet: "GAINE" });
    expect(v.qualite).toMatchObject({ classePrecision: "A", origineClasse: "OBJET", precisionHorizontaleM: 0.1, methodeCollecte: "GNSS RTK", niveauConfiance: "ELEVE", statutQualite: "OBSERVE" });
    expect(v.vertical).toMatchObject({ etat: "FOURNIE", profondeurM: 1.2, evaluable: false, conclusion3D: null });
    expect(vueObjet(objet({ classeJeu: "C", methodeJeu: "plan de conception" })).qualite).toMatchObject({ classePrecision: "C", origineClasse: "JEU", methodeCollecte: "plan de conception" });
  });

  it("un descripteur qui ne donne que la nature n'efface pas la classe du jeu (heritee) mais ne cree pas de profondeur", () => {
    const v = vueObjet(objet({ classeJeu: "B", precisionHJeu: 3, aDescripteur: true, dNature: "CIRCUIT_LOGIQUE", dJustification: "Nature declaree par la personne" }));
    expect(v.qualite).toMatchObject({ classePrecision: "B", origineClasse: "JEU", precisionHorizontaleM: 3 });
    expect(v.vertical.etat).toBe("ABSENTE");
  });
});

describe("vue d'une relation", () => {
  const relation = (o: Partial<LigneRelation> = {}): LigneRelation => ({
    id: "r1", projetId: "p1", typeRelation: "PORTE_PAR", statut: "PROPOSEE", origine: "AUTOMATIQUE", proposition: { toleranceM: 2 }, decideLe: null, justificationDecision: null,
    decidePar: null, creePar: "Personne A", createdAt: new Date(), updatedAt: new Date(),
    sourceObjetId: "1", sourceNom: "Circuit", sourceJeuId: "j1", sourceStatutJeu: "AUTORISE", sourceGeom: "LIGNE", sourceNature: "CIRCUIT_LOGIQUE", sourceType: null,
    cibleObjetId: "2", cibleNom: "Gaine", cibleJeuId: "j2", cibleStatutJeu: "AUTORISE", cibleGeom: "LIGNE", cibleNature: "ACTIF_PHYSIQUE", cibleType: "GAINE", ...o,
  });
  it("une proposition n'a pas de decision ; seul un compte qui decide recoit les actions possibles", () => {
    expect(vueRelation(relation(), true)).toMatchObject({ decision: null, actionsPossibles: ["valider", "refuser"], statut: "PROPOSEE" });
    expect(vueRelation(relation(), false).actionsPossibles).toEqual([]);
  });
  it("une relation validee porte son auteur et sa justification et s'offre a la revocation", () => {
    const v = vueRelation(relation({ statut: "VALIDEE", decideLe: new Date("2026-11-01T10:00:00Z"), decidePar: "Personne B", justificationDecision: "Releve contradictoire" }), true);
    expect(v.decision).toMatchObject({ par: "Personne B", justification: "Releve contradictoire" });
    expect(v.actionsPossibles).toEqual(["revoquer"]);
    expect(JSON.stringify(v)).not.toMatch(/"coordinates"|"geometry"/);
  });
});

describe("curseur des objets", () => {
  it("un curseur produit par le serveur se relit", () => {
    expect(decoderCurseurObjet(encoderCurseurObjet("123456789012345678"))).toBe("123456789012345678");
  });
  it("tout ce qui n'est pas un identifiant d'objet valide est refuse (jamais envoye a la base)", () => {
    const forge = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    for (const c of ["", "pas-un-curseur", forge({ i: "0" }), forge({ i: "01" }), forge({ i: "-1" }), forge({ i: "1234567890123456789" }), forge({ i: 12 }), forge({ i: "1; DROP TABLE x" }), forge({ i: "1\u0000" }), forge([]), forge(null), forge({})]) {
      expect(decoderCurseurObjet(c), JSON.stringify(c)).toBeNull();
    }
  });
});

describe("jeux a compter", () => {
  const jeu = (id: string, statut: string, role = "RESEAU_TIERS", conc: string | null = "c1", t = 0) => ({ id, role, concessionnaireId: conc, statut, createdAt: new Date(2026, 9, 1 + t) });
  it("par defaut, seuls les jeux AUTORISE", () => {
    const r = retenirJeux([jeu("a", "AUTORISE"), jeu("b", "CONTROLE", "RESEAU_TIERS", "c2"), jeu("c", "REMPLACE"), jeu("d", "REJETE"), jeu("e", "RETIRE")], false);
    expect(r.map((j) => j.id)).toEqual(["a"]);
  });
  it("quarantaine incluse : le jeu en controle REMPLACE le jeu autorise de meme cle (jamais deux fois le meme reseau)", () => {
    const r = retenirJeux([jeu("a", "AUTORISE"), jeu("b", "CONTROLE", "RESEAU_TIERS", "c1", 1), jeu("z", "AUTORISE", "RESEAU_TIERS", "c2")], true);
    expect(r.map((j) => j.id)).toEqual(["b", "z"]);
  });
  it("un jeu en controle d'une autre cle s'ajoute ; le role AUTRE retient tous ses fichiers", () => {
    const r = retenirJeux([jeu("a", "AUTORISE"), jeu("b", "CONTROLE", "RESEAU_TIERS", "c2"), jeu("x", "AUTORISE", "AUTRE", null), jeu("y", "AUTORISE", "AUTRE", null, 1)], true);
    expect(r.map((j) => j.id)).toEqual(["a", "b", "x", "y"]);
  });
});

describe("lisibilite par role", () => {
  it("un lecteur ne lit que les jeux AUTORISE ; ADMIN et GESTIONNAIRE tous sauf RETIRE ; personne ne lit RETIRE", () => {
    expect(statutsLisibles("LECTEUR")).toEqual(["AUTORISE"]);
    expect(statutsLisibles("INSPECTEUR")).toEqual(["AUTORISE"]);
    for (const r of ["ADMIN", "GESTIONNAIRE"]) expect(statutsLisibles(r)).toEqual(["RECU", "CONTROLE", "AUTORISE", "REJETE", "REMPLACE"]);
    for (const r of ["ADMIN", "GESTIONNAIRE", "LECTEUR", "INSPECTEUR", "AUTRE"]) expect(statutsLisibles(r)).not.toContain("RETIRE");
  });
});

describe("refus de la base traduits en erreurs typees (jamais un 500 pour une donnee incoherente)", () => {
  const erreurBase = (code: string, message: string) => new Prisma.PrismaClientKnownRequestError("Raw query failed", { code: "P2010", clientVersion: "5", meta: { code, message } });
  it("contrainte CHECK, declencheur de refus, cle etrangere : 422 INCOHERENCE_REFUSEE avec le message de la base", () => {
    for (const code of ["23514", "23001", "23503"]) {
      try { traduireErreurBase(erreurBase(code, 'ERROR: reseau_relations : les deux objets doivent appartenir au projet de la relation')); expect.unreachable(); } catch (e) {
        expect(e).toBeInstanceOf(ErreurMetier);
        expect(e).toMatchObject({ status: 422, code: "INCOHERENCE_REFUSEE" });
        expect((e as Error).message).toMatch(/appartenir au projet/);
      }
    }
  });
  it("unicite : 409 DEJA_ENREGISTRE ; toute autre erreur est relancee telle quelle ; une ErreurMetier traverse sans etre transformee", async () => {
    expect(() => traduireErreurBase(erreurBase("23505", "duplicate key"))).toThrowError(expect.objectContaining({ status: 409, code: "DEJA_ENREGISTRE" }));
    const autre = new Error("panne");
    expect(() => traduireErreurBase(autre)).toThrow(autre);
    const metier = new ErreurMetier(404, "OBJET_INTROUVABLE", "x");
    await expect(avecTraductionBase(async () => { throw metier; })).rejects.toBe(metier);
    await expect(avecTraductionBase(async () => { throw erreurBase("23514", "ERROR: x"); })).rejects.toMatchObject({ status: 422 });
    await expect(avecTraductionBase(async () => 7)).resolves.toBe(7);
  });
});
