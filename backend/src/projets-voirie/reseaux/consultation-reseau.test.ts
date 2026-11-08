import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Revue de la vague 1, m4 : la lecture des relations et le comptage rendent des noms, natures, longueurs et concessionnaires de jeux sensibles :
 * ils sont TRACES (route `reseau`) avant la remise des donnees, comme la lecture des objets. La base et la trace sont simulees : ce qui est prouve
 * ici, c'est QUELS jeux le service declare consultes ; l'ecriture reelle de la trace est prouvee par le banc `reseau-physique-logique`.
 */
vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://127.0.0.1:1/essai";
  process.env.JWT_ACCESS_SECRET = "essai-access-secret-essai-access-secret-0000";
  process.env.JWT_REFRESH_SECRET = "essai-refresh-secret-essai-refresh-secret-000";
});

const { etat } = vi.hoisted(() => ({
  etat: { traces: [] as { jeux: { id: string; confidentialite: string; nbObjets: number }[]; ctx: unknown }[], relations: [] as unknown[], jeux: [] as unknown[], ordre: [] as string[] },
}));

vi.mock("../consultation", () => ({
  tracerConsultation: async (_a: unknown, jeux: { id: string; confidentialite: string; nbObjets: number }[], ctx: unknown) => { etat.ordre.push("trace"); etat.traces.push({ jeux, ctx }); return jeux.length; },
}));

const tx = { $executeRaw: async () => 0, $queryRaw: async () => [] };
vi.mock("../../lib/prisma", () => ({
  prisma: {
    projetVoirie: { findFirst: async () => ({ id: "p1", code: "X", nom: "X" }) },
    jeuDonneesProjet: { findMany: async () => etat.jeux },
    $transaction: async (f: (t: typeof tx) => unknown) => f(tx),
  },
}));

const groupe = () => ({ nb: 0, nbLineaires: 0, sommeM: 0, fusionneM: 0, parType: {}, tracesPartagees: { nbGroupes: 0, nbObjets: 0 } });
vi.mock("./reseaux.depot", () => ({
  listerRelations: async () => { etat.ordre.push("lecture"); return etat.relations; },
  mesurerComptage: async () => ({ parNature: { ACTIF_PHYSIQUE: groupe(), CIRCUIT_LOGIQUE: groupe(), EQUIPEMENT: groupe(), INCONNUE: groupe() }, supports: { circuits: 0, avecSupportValide: 0, avecPropositionSeulement: 0 } }),
  mesurerQualite: async () => ({ parClasse: { A: 0, B: 0, C: 0, D: 0, E: 0, inconnue: 0 }, sansProfondeur: 0, sansAltitude: 0, avecDonneesVerticales: 0, objets: 0 }),
}));

import { jeuxConsultesParRelations } from "./consultation-reseau";
import { comptageProjet } from "./comptage.service";
import { listerRelationsProjet } from "./relations.service";
import type { LigneRelation } from "./reseaux.depot";

const relation = (o: Partial<LigneRelation> = {}): LigneRelation => ({
  id: "r1", projetId: "p1", typeRelation: "PORTE_PAR", statut: "VALIDEE", origine: "MANUELLE", proposition: null, decideLe: null, justificationDecision: null,
  decidePar: null, creePar: "A", createdAt: new Date(), updatedAt: new Date(),
  sourceObjetId: "1", sourceNom: "Circuit", sourceJeuId: "jc", sourceStatutJeu: "AUTORISE", sourceConfidentialite: "CONFIDENTIEL_CONCESSIONNAIRE", sourceGeom: "LIGNE", sourceNature: "CIRCUIT_LOGIQUE", sourceType: null,
  cibleObjetId: "2", cibleNom: "Gaine", cibleJeuId: "ji", cibleStatutJeu: "AUTORISE", cibleConfidentialite: "INFRASTRUCTURE_SENSIBLE", cibleGeom: "LIGNE", cibleNature: "ACTIF_PHYSIQUE", cibleType: "GAINE", ...o,
});
const CHEF = { id: "u1", role: "GESTIONNAIRE" };
const LECTEUR = { id: "u2", role: "LECTEUR" };

beforeEach(() => { etat.traces = []; etat.relations = []; etat.jeux = []; etat.ordre = []; });

describe("jeuxConsultesParRelations : les DEUX bouts de chaque relation", () => {
  it("un jeu par bout, avec sa confidentialite, objets distincts comptes une fois", () => {
    const j = jeuxConsultesParRelations([relation(), relation({ id: "r2", cibleObjetId: "3" }), relation({ id: "r3", sourceObjetId: "1", cibleObjetId: "2" })]);
    expect(j).toEqual([
      { id: "jc", confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE", nbObjets: 1 },
      { id: "ji", confidentialite: "INFRASTRUCTURE_SENSIBLE", nbObjets: 2 },
    ]);
  });
  it("un objet consulte dont le jeu n'apparait dans aucune relation est ajoute ; dans une relation, il est deja compte", () => {
    const sup = [{ id: "jx", confidentialite: "INTERNE", nbObjets: 1 }, { id: "jc", confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE", nbObjets: 1 }];
    expect(jeuxConsultesParRelations([relation()], sup).map((x) => [x.id, x.nbObjets])).toEqual([["jc", 1], ["ji", 1], ["jx", 1]]);
    expect(jeuxConsultesParRelations([], sup)).toEqual(sup);
  });
});

describe("m4 : la liste des relations est tracee", () => {
  it("les jeux sensibles des deux bouts sont declares consultes (route reseau), AVANT la reponse ; pour un lecteur comme pour un decideur", async () => {
    etat.relations = [relation()];
    for (const acteur of [CHEF, LECTEUR]) {
      etat.traces = []; etat.ordre = [];
      const r = await listerRelationsProjet(acteur, "p1", { limite: 50 });
      expect(r.relations).toHaveLength(1);
      expect(etat.traces).toHaveLength(1);
      expect(etat.traces[0].jeux.map((j) => j.id).sort()).toEqual(["jc", "ji"]);
      expect(etat.traces[0].ctx).toMatchObject({ route: "reseau" });
      expect(etat.ordre).toEqual(["lecture", "trace"]);
    }
  });
});

describe("m4 : le comptage est trace", () => {
  it("chaque jeu retenu (nom de fichier, concessionnaire, longueurs rendus) est declare consulte ; les jeux non sensibles sont filtres par la trace elle-meme", async () => {
    etat.jeux = [
      { id: "j1", role: "RESEAU_TIERS", statut: "AUTORISE", concessionnaireId: "c1", createdAt: new Date(), version: 1, nomFichier: "a.geojson", concessionnaire: { id: "c1", nom: "Op" }, typeReseau: "TELECOM", natureObjets: "CIRCUIT_LOGIQUE", confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE", dateDonnees: null, nbObjets: 8, longueurTotaleM: 100, longueurTraceFusionneM: 60 },
      { id: "j2", role: "RESEAU_TIERS", statut: "AUTORISE", concessionnaireId: "c2", createdAt: new Date(), version: 1, nomFichier: "b.geojson", concessionnaire: { id: "c2", nom: "Op2" }, typeReseau: "EAU_POTABLE", natureObjets: "EQUIPEMENT", confidentialite: "INTERNE", dateDonnees: null, nbObjets: 2, longueurTotaleM: 0, longueurTraceFusionneM: 0 },
    ];
    await comptageProjet(LECTEUR, "p1", { inclureNonAutorises: false });
    expect(etat.traces).toHaveLength(1);
    expect(etat.traces[0].jeux).toEqual([
      { id: "j1", confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE", nbObjets: 8 },
      { id: "j2", confidentialite: "INTERNE", nbObjets: 2 },
    ]);
    expect(etat.traces[0].ctx).toMatchObject({ route: "reseau" });
  });
});
