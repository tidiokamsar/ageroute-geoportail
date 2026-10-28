import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `/api/v2/baremes` — ce que ces tests defendent (lot 6, aide a la decision).
 *
 * SEUL CE QUI CHANGE LE CALCUL DESAPPROUVE. Un libelle ou un commentaire corrige ne neutralise pas un prix approuve ;
 * un prix, une unite, une devise, une validite, un millesime, une largeur ou une source modifies, si. Un champ renvoye
 * a l'identique n'est pas une modification (l'ecran envoie des corps complets).
 *
 * L'HISTORIQUE EST ECRIT DANS LA MEME TRANSACTION. Si l'audit echoue, ni la ligne ni l'historique ne bougent.
 *
 * ON N'APPROUVE PAS SON PROPRE PRIX. L'auteur de la version vient de l'historique en base ; ADMIN compris.
 *
 * ON N'APPROUVE PAS UN PRIX ILLISIBLE, NI SANS MOTIF NI SANS COMMENTAIRE.
 *
 * UN SCENARIO DEJA CALCULE NE BOUGE PAS : il embarque la copie des baremes qu'il a utilises.
 */
type Ligne = {
  id: number; familleRevetement: string; etatDepart: string; typeIntervention: string;
  coutKmGnf: bigint; code: string | null; libelle: string | null; source: string; version: number;
  approuveLe: Date | null; approuveParId: string | null; anneeReference: number | null;
  largeurChausseeM: string | null; commentaire: string | null; uniteCout: string; devise: string; actif: boolean;
  validDe: Date | null; validA: Date | null; approuvePar: { email: string } | null;
};
type Hist = { id: number; baremeId: number; version: number; evenement: string; champsModifies: string[]; modifieCalcul: boolean;
  approbationReinitialisee: boolean; statutApprobation: string; valeursAvant: unknown; valeursApres: unknown;
  auteurId: string | null; auteurEmail: string; motif: string; commentaire?: string | null; creeLe: Date };

const ligneInitiale = (): Ligne => ({
  id: 3, familleRevetement: "bitume", etatDepart: "CRITIQUE", typeIntervention: "reconstruction",
  coutKmGnf: 3_500_000_000n, code: "BIT-CRIT-RECO", libelle: "Reconstruction bitume",
  source: "standard_initial", version: 1, approuveLe: null, approuveParId: null,
  anneeReference: null, largeurChausseeM: null, commentaire: null, uniteCout: "KM", devise: "GNF", actif: true,
  validDe: null, validA: null, approuvePar: null,
});

const h = vi.hoisted(() => ({
  compte: { id: "u-gest", role: "GESTIONNAIRE", email: "gest@ageroute.gov.gn" } as { id: string; role: string; email: string },
  emails: { "u-gest": "gest@ageroute.gov.gn", "u-adm1": "adm1@ageroute.gov.gn", "u-adm2": "adm2@ageroute.gov.gn" } as Record<string, string>,
  db: { ligne: null as unknown as Ligne, hist: [] as Hist[], audits: [] as Array<{ action: string; before?: unknown; after?: unknown; entityType: string }> },
  auditEchoue: false,
  ligneInitiale: null as unknown as () => Ligne,
}));

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { ...h.compte };
    n();
  },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));
vi.mock("../middleware/rbac.middleware", () => ({
  requireRole: (...roles: string[]) => (req: express.Request, res: express.Response, n: express.NextFunction) => {
    if (!roles.includes(req.user?.role ?? "")) { res.status(403).json({ error: "Acces refuse pour votre role" }); return; }
    n();
  },
}));
vi.mock("../lib/prisma", () => {
  const avecApprobateur = (l: Ligne) => ({ ...l, approuvePar: l.approuveParId ? { email: h.emails[l.approuveParId] ?? "?" } : null });
  const baremeIntervention = {
    findMany: vi.fn(async () => [avecApprobateur(h.db.ligne)]),
    findUnique: vi.fn(async ({ where }: { where: { id: number } }) => (where.id === h.db.ligne.id ? avecApprobateur(h.db.ligne) : null)),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { Object.assign(h.db.ligne, data); return avecApprobateur(h.db.ligne); }),
  };
  const baremeHistorique = {
    findMany: vi.fn(async ({ where }: { where: { baremeId: number; version?: number; modifieCalcul?: boolean } }) =>
      h.db.hist.filter((x) => x.baremeId === where.baremeId
        && (where.version === undefined || x.version === where.version)
        && (where.modifieCalcul === undefined || x.modifieCalcul === where.modifieCalcul)).reverse()),
    create: vi.fn(async ({ data }: { data: Omit<Hist, "id" | "creeLe"> }) => {
      const x = { ...data, id: h.db.hist.length + 1, creeLe: new Date("2026-10-29T10:00:00Z") } as Hist;
      h.db.hist.push(x); return x;
    }),
  };
  return {
    prisma: {
      baremeIntervention, baremeHistorique,
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        // Meme contrat qu'une vraie transaction : tout est annule si la fonction leve.
        const instantane = structuredClone(h.db);
        try {
          return await fn({ baremeIntervention, baremeHistorique, $queryRaw: vi.fn(async () => []) });
        } catch (e) {
          h.db.ligne = instantane.ligne; h.db.hist = instantane.hist; h.db.audits = instantane.audits;
          throw e;
        }
      }),
    },
  };
});
vi.mock("../utils/audit", () => ({
  logAuditTransactionnelle: vi.fn(async (_tx: unknown, p: { action: string; entityType: string; before?: unknown; after?: unknown }) => {
    if (h.auditEchoue) throw new Error("audit en panne");
    h.db.audits.push({ action: p.action, entityType: p.entityType, before: p.before, after: p.after });
  }),
}));

import {
  baremesV2Router, appliquerModification, comparer, validiteCoherente, valeursDe, CHAMPS_CALCUL, CHAMPS_DESCRIPTIFS,
} from "./baremes.routes";

const app = express();
app.use(express.json(), baremesV2Router);
app.use((err: Error, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: err.message }); });

const MOTIF = "Mise a jour du prix selon l'arrete de reference";
const COMMENTAIRE = "Prix relu contre le bordereau de l'ONR";
// CONTRAT MODIFIE (revue) : `versionAttendue` est OBLIGATOIRE pour approuver (verrou optimiste : on approuve la version lue, pas celle qui a pu changer
// entre-temps). Ces tests l envoyaient en option ; le client (BaremesPage) l envoie deja.
const corpsApprobation = (o: Record<string, unknown> = {}) => ({ motif: MOTIF, commentaire: COMMENTAIRE, versionAttendue: h.db.ligne.version, ...o });

function approuvee(par = "u-adm1") {
  h.db.ligne.anneeReference = 2026; h.db.ligne.largeurChausseeM = "6.5";
  h.db.ligne.approuveLe = new Date("2026-10-20T08:00:00Z"); h.db.ligne.approuveParId = par;
}

beforeEach(() => {
  h.db.ligne = ligneInitiale(); h.db.hist = []; h.db.audits = []; h.auditEchoue = false;
  h.compte = { id: "u-gest", role: "GESTIONNAIRE", email: "gest@ageroute.gov.gn" };
});

describe("noyau : ce qui change le calcul", () => {
  const base = valeursDe(ligneInitiale());
  it("les champs de calcul et descriptifs sont deux ensembles disjoints, sans oubli", () => {
    expect([...CHAMPS_CALCUL].sort()).toEqual(["anneeReference", "coutKmGnf", "devise", "largeurChausseeM", "source", "uniteCout", "validA", "validDe"]);
    expect([...CHAMPS_DESCRIPTIFS].sort()).toEqual(["commentaire", "libelle"]);
  });
  it("un libelle ou un commentaire ne change pas le calcul", () => {
    const d = comparer(base, appliquerModification(base, { libelle: "Autre libelle", commentaire: "note" }));
    expect(d.champs.sort()).toEqual(["commentaire", "libelle"]);
    expect(d.changeLeCalcul).toBe(false);
  });
  it.each([
    ["prix", { coutKmGnf: "3600000000" }],
    ["millesime", { anneeReference: 2026 }],
    ["largeur", { largeurChausseeM: 6.5 }],
    ["debut de validite", { validDe: "2026-01-01" }],
    ["fin de validite", { validA: "2027-12-31" }],
    ["source", { source: "arrete_2026" }],
  ])("un changement de %s change le calcul", (_nom, m) => {
    expect(comparer(base, appliquerModification(base, m)).changeLeCalcul).toBe(true);
  });
  it("une valeur renvoyee a l'identique n'est pas une modification (6.50 = 6.5)", () => {
    const avec = appliquerModification(base, { largeurChausseeM: 6.5 });
    expect(comparer(avec, appliquerModification(avec, { largeurChausseeM: 6.5, coutKmGnf: "3500000000", libelle: "Reconstruction bitume" })).champs).toEqual([]);
  });
  it("la fenetre de validite doit etre ordonnee", () => {
    expect(validiteCoherente({ validDe: "2026-01-01", validA: "2025-12-31" })).toBe(false);
    expect(validiteCoherente({ validDe: "2026-01-01", validA: null })).toBe(true);
  });
});

describe("GET /api/v2/baremes et historique", () => {
  it("rend les lignes avec coût en chaîne, devise, unité, validité et statut d'approbation", async () => {
    const r = await request(app).get("/");
    expect(r.status).toBe(200);
    expect(r.body.data[0]).toMatchObject({ coutKmGnf: "3500000000", devise: "GNF", uniteCout: "KM", validDe: null, validA: null, statutApprobation: "NON_APPROUVE", version: 1 });
  });
  it("l'historique d'une ligne inconnue est un 404", async () => {
    expect((await request(app).get("/99/historique")).status).toBe(404);
    expect((await request(app).get("/abc/historique")).status).toBe(404);
  });
});

describe("PATCH /api/v2/baremes/:id", () => {
  it("pose millésime et largeur, passe à la version 2 et écrit l'historique avec le motif", async () => {
    const r = await request(app).patch("/3").send({ anneeReference: 2026, largeurChausseeM: 6.5, motif: MOTIF });
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(2);
    expect(r.body.anneeReference).toBe(2026);
    expect(r.body.approuveLe).toBeNull();
    expect(h.db.hist).toHaveLength(1);
    expect(h.db.hist[0]).toMatchObject({ evenement: "MODIFICATION", version: 2, modifieCalcul: true, auteurId: "u-gest", motif: MOTIF, statutApprobation: "NON_APPROUVE" });
    expect(h.db.hist[0].champsModifies.sort()).toEqual(["anneeReference", "largeurChausseeM"]);
    expect((h.db.hist[0].valeursAvant as { anneeReference: number | null }).anneeReference).toBeNull();
    expect((h.db.hist[0].valeursApres as { anneeReference: number }).anneeReference).toBe(2026);
  });

  it("l'audit porte les valeurs avant et après, le libellé, le commentaire et le motif", async () => {
    await request(app).patch("/3").send({ libelle: "Nouveau libelle", commentaire: "note", motif: MOTIF });
    expect(h.db.audits).toHaveLength(1);
    const a = h.db.audits[0] as { action: string; entityType: string; before: Record<string, unknown>; after: Record<string, unknown> };
    expect(a.action).toBe("UPDATE");
    expect(a.entityType).toBe("BaremeIntervention");
    expect(a.before.libelle).toBe("Reconstruction bitume");
    expect(a.after.libelle).toBe("Nouveau libelle");
    expect(a.after.commentaire).toBe("note");
    expect(a.after.motif).toBe(MOTIF);
  });

  it("un libellé ou un commentaire corrigé NE désapprouve PAS un prix approuvé, ne touche pas la version", async () => {
    approuvee();
    const r = await request(app).patch("/3").send({ libelle: "Reconstruction bitume (RN)", commentaire: "precision de redaction", motif: MOTIF });
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(1);
    expect(r.body.approuveLe).not.toBeNull();
    expect(r.body.statutApprobation).toBe("APPROUVE");
    expect(h.db.hist[0]).toMatchObject({ modifieCalcul: false, approbationReinitialisee: false, statutApprobation: "APPROUVE", version: 1 });
  });

  it("MUTATION DE CONTROLE : un changement de prix sur une ligne approuvée la désapprouve et incrémente", async () => {
    approuvee();
    const r = await request(app).patch("/3").send({ coutKmGnf: "3700000000", motif: MOTIF });
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(2);
    expect(r.body.approuveLe).toBeNull();
    expect(r.body.approuvePar).toBeNull();
    expect(h.db.hist[0]).toMatchObject({ modifieCalcul: true, approbationReinitialisee: true, statutApprobation: "NON_APPROUVE" });
  });

  it.each(["uniteCout", "devise", "validDe", "validA", "source", "anneeReference", "largeurChausseeM"] as const)(
    "un changement de %s sur une ligne approuvée la désapprouve", async (champ) => {
      approuvee();
      const valeur = { uniteCout: undefined, devise: undefined, validDe: "2026-01-01", validA: "2027-12-31", source: "arrete_2026", anneeReference: 2027, largeurChausseeM: 7 }[champ];
      if (valeur === undefined) return; // unite et devise n'ont qu'une valeur admise : voir le test de refus ci-dessous
      const r = await request(app).patch("/3").send({ [champ]: valeur, motif: MOTIF });
      expect(r.status).toBe(200);
      expect(r.body.approuveLe).toBeNull();
    });

  it("refuse une unité ou une devise hors liste fermée (le moteur de coût ne sait lire que KM et GNF)", async () => {
    expect((await request(app).patch("/3").send({ devise: "USD", motif: MOTIF })).status).toBe(400);
    expect((await request(app).patch("/3").send({ uniteCout: "M2", motif: MOTIF })).status).toBe(400);
  });

  it("le motif est obligatoire", async () => {
    expect((await request(app).patch("/3").send({ anneeReference: 2026 })).status).toBe(400);
    expect((await request(app).patch("/3").send({ anneeReference: 2026, motif: "  " })).status).toBe(400);
    expect(h.db.hist).toHaveLength(0);
  });

  it("refuse un corps sans changement de valeur : rien n'est écrit, pas de version fantôme", async () => {
    const r = await request(app).patch("/3").send({ coutKmGnf: "3500000000", libelle: "Reconstruction bitume", motif: MOTIF });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("AUCUN_CHANGEMENT");
    expect(h.db.hist).toHaveLength(0);
    expect(h.db.ligne.version).toBe(1);
  });

  it("refuse un coût non chaîne, nul, un corps vide, un champ inconnu, une validité inversée", async () => {
    expect((await request(app).patch("/3").send({ coutKmGnf: 3500000000, motif: MOTIF })).status).toBe(400);
    expect((await request(app).patch("/3").send({ coutKmGnf: "0", motif: MOTIF })).status).toBe(400);
    expect((await request(app).patch("/3").send({ motif: MOTIF })).status).toBe(400);
    expect((await request(app).patch("/3").send({ familleRevetement: "pave", motif: MOTIF })).status).toBe(400);
    const r = await request(app).patch("/3").send({ validDe: "2027-01-01", validA: "2026-01-01", motif: MOTIF });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("VALIDITE_INCOHERENTE");
  });

  it("409 si la version lue n'est plus la version courante", async () => {
    h.db.ligne.version = 4;
    const r = await request(app).patch("/3").send({ anneeReference: 2026, versionAttendue: 3, motif: MOTIF });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("CONFLIT_VERSION");
  });

  it("l'historique est écrit dans la MÊME transaction : si l'audit échoue, ni la ligne ni l'historique ne bougent", async () => {
    h.auditEchoue = true;
    const r = await request(app).patch("/3").send({ anneeReference: 2026, motif: MOTIF });
    expect(r.status).toBe(500);
    expect(h.db.ligne.anneeReference).toBeNull();
    expect(h.db.ligne.version).toBe(1);
    expect(h.db.hist).toHaveLength(0);
  });

  it("un LECTEUR ne modifie pas (matrice des rôles)", async () => {
    h.compte = { id: "u-l", role: "LECTEUR", email: "l@x.gn" };
    expect((await request(app).patch("/3").send({ anneeReference: 2026, motif: MOTIF })).status).toBe(403);
  });

  it("ligne inconnue : 404", async () => {
    expect((await request(app).patch("/99").send({ anneeReference: 2026, motif: MOTIF })).status).toBe(404);
  });
});

describe("POST /api/v2/baremes/:id/approuver", () => {
  const poser = async () => {
    h.compte = { id: "u-gest", role: "GESTIONNAIRE", email: "gest@ageroute.gov.gn" };
    await request(app).patch("/3").send({ anneeReference: 2026, largeurChausseeM: 6.5, motif: MOTIF });
  };

  it("refuse d'approuver un prix sans millésime ni largeur, en disant ce qui manque", async () => {
    h.compte = { id: "u-adm1", role: "ADMIN", email: "adm1@ageroute.gov.gn" };
    const r = await request(app).post("/3/approuver").send(corpsApprobation());
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("PRIX_ILLISIBLE");
    expect(r.body.error).toContain("millésime");
    expect(r.body.error).toContain("largeur");
  });

  it("approuve une ligne lisible posée par un AUTRE compte, l'historise et l'audite comme VALIDATE avant/après", async () => {
    await poser();
    h.compte = { id: "u-adm1", role: "ADMIN", email: "adm1@ageroute.gov.gn" };
    const r = await request(app).post("/3/approuver").send(corpsApprobation());
    expect(r.status).toBe(200);
    expect(r.body.approuveLe).not.toBeNull();
    expect(r.body.approuvePar).toBe("adm1@ageroute.gov.gn");
    const dernier = h.db.hist[h.db.hist.length - 1];
    expect(dernier).toMatchObject({ evenement: "APPROBATION", statutApprobation: "APPROUVE", auteurId: "u-adm1", motif: MOTIF, commentaire: COMMENTAIRE });
    const a = h.db.audits[h.db.audits.length - 1] as { action: string; before: { approuveLe: unknown }; after: { approuveLe: unknown; approuvePar: string; commentaire: string } };
    expect(a.action).toBe("VALIDATE");
    expect(a.before.approuveLe).toBeNull();
    expect(a.after.approuveLe).not.toBeNull();
    expect(a.after.approuvePar).toBe("adm1@ageroute.gov.gn");
    expect(a.after.commentaire).toBe(COMMENTAIRE);
  });

  it("MUTATION DE CONTROLE : un ADMIN n'approuve PAS le prix qu'il a posé lui-même (AUTO_VALIDATION, 403)", async () => {
    h.compte = { id: "u-adm1", role: "ADMIN", email: "adm1@ageroute.gov.gn" };
    await request(app).patch("/3").send({ anneeReference: 2026, largeurChausseeM: 6.5, motif: MOTIF });
    const r = await request(app).post("/3/approuver").send(corpsApprobation());
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("AUTO_VALIDATION");
    expect(r.body.error).toContain("un autre compte doit approuver");
    expect(h.db.ligne.approuveLe).toBeNull();
    expect(h.db.hist.filter((x) => x.evenement === "APPROBATION")).toHaveLength(0);
  });

  it("une modification de libellé par l'approbateur ne l'exclut pas (il n'a pas posé le prix)", async () => {
    await poser();
    h.compte = { id: "u-adm1", role: "ADMIN", email: "adm1@ageroute.gov.gn" };
    await request(app).patch("/3").send({ libelle: "Libelle corrige", motif: MOTIF });
    expect((await request(app).post("/3/approuver").send(corpsApprobation())).status).toBe(200);
  });

  it("une ligne d'origine sans historique (standard_initial) n'a pas d'auteur : un ADMIN peut l'approuver une fois lisible", async () => {
    h.db.ligne.anneeReference = 2026; h.db.ligne.largeurChausseeM = "6.5";
    h.compte = { id: "u-adm1", role: "ADMIN", email: "adm1@ageroute.gov.gn" };
    expect((await request(app).post("/3/approuver").send(corpsApprobation())).status).toBe(200);
  });

  it("l'auteur d'une version antérieure ne bloque pas l'approbation d'une version qu'un autre a posée", async () => {
    h.compte = { id: "u-adm1", role: "ADMIN", email: "adm1@ageroute.gov.gn" };
    await request(app).patch("/3").send({ anneeReference: 2025, largeurChausseeM: 6, motif: MOTIF });
    h.compte = { id: "u-gest", role: "GESTIONNAIRE", email: "gest@ageroute.gov.gn" };
    await request(app).patch("/3").send({ anneeReference: 2026, motif: MOTIF });
    h.compte = { id: "u-adm1", role: "ADMIN", email: "adm1@ageroute.gov.gn" };
    expect((await request(app).post("/3/approuver").send(corpsApprobation())).status).toBe(200);
  });

  it("motif et commentaire sont obligatoires", async () => {
    await poser();
    h.compte = { id: "u-adm1", role: "ADMIN", email: "adm1@ageroute.gov.gn" };
    expect((await request(app).post("/3/approuver").send({})).status).toBe(400);
    expect((await request(app).post("/3/approuver").send({ motif: MOTIF })).status).toBe(400);
    expect((await request(app).post("/3/approuver").send({ commentaire: COMMENTAIRE })).status).toBe(400);
    expect(h.db.ligne.approuveLe).toBeNull();
  });

  it("409 si la version est déjà approuvée ou si la version lue a changé", async () => {
    await poser();
    h.compte = { id: "u-adm1", role: "ADMIN", email: "adm1@ageroute.gov.gn" };
    expect((await request(app).post("/3/approuver").send(corpsApprobation())).status).toBe(200);
    const deja = await request(app).post("/3/approuver").send(corpsApprobation());
    expect(deja.status).toBe(409);
    expect(deja.body.code).toBe("DEJA_APPROUVEE");
    const conflit = await request(app).post("/3/approuver").send({ motif: MOTIF, commentaire: COMMENTAIRE, versionAttendue: 1 });
    expect(conflit.status).toBe(409);
    expect(conflit.body.code).toBe("CONFLIT_VERSION");
  });

  it("un GESTIONNAIRE n'approuve jamais (matrice des rôles : approbation = ADMIN)", async () => {
    await poser();
    expect((await request(app).post("/3/approuver").send(corpsApprobation())).status).toBe(403);
  });

  it("l'historique d'une ligne rend les événements du plus récent au plus ancien, avec auteur, motif et valeurs", async () => {
    await poser();
    h.compte = { id: "u-adm1", role: "ADMIN", email: "adm1@ageroute.gov.gn" };
    await request(app).post("/3/approuver").send(corpsApprobation());
    const r = await request(app).get("/3/historique");
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: { evenement: string }) => x.evenement)).toEqual(["APPROBATION", "MODIFICATION"]);
    expect(r.body.data[1].auteur.email).toBe("gest@ageroute.gov.gn");
    expect(r.body.data[1].valeursApres.anneeReference).toBe(2026);
    expect(r.body.bareme.statutApprobation).toBe("APPROUVE");
  });
});

describe("les scénarios déjà calculés ne sont jamais altérés rétroactivement", () => {
  it("un scénario embarque la copie des barèmes : modifier la ligne vivante ne change ni ses entrées scellées ni son résultat", async () => {
    const { entreesDeBase } = await import("../programmation/scenario.fixtures");
    const { entreesVersJson, entreesDepuisJson, construireScenario } = await import("../programmation/scenario.noyau");
    const entrees = entreesDeBase();
    const stocke = JSON.stringify(entreesVersJson(entrees));
    const construit = construireScenario(entrees);
    const resultatAvant = JSON.stringify(construit, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

    // La ligne vivante change de prix (même modification que la route) : la copie stockée n'est pas liée à elle.
    // On prend un barème RÉELLEMENT cité par une ligne chiffrée du scénario, pour que la contre-épreuve mesure quelque chose.
    const cite = construit.ok ? construit.scenario.lignes.find((l) => l.cout?.ok)?.cout : undefined;
    expect(cite && cite.ok).toBeTruthy();
    const vivante = entrees.baremes.find((b) => cite && cite.ok && String(b.id) === String(cite.bareme.id))!;
    expect(vivante).toBeDefined();
    const avant = valeursDe({ ...ligneInitiale(), coutKmGnf: vivante.coutKmGnf, id: Number(vivante.id) });
    const apres = appliquerModification(avant, { coutKmGnf: (vivante.coutKmGnf * 2n).toString() });
    expect(comparer(avant, apres).changeLeCalcul).toBe(true);
    const vivanteModifiee = { ...vivante, coutKmGnf: BigInt(apres.coutKmGnf) };

    // Le texte stocké relu porte toujours l'ancien prix, et rejoue le même résultat.
    const relu = entreesDepuisJson(JSON.parse(stocke));
    expect(relu.ok).toBe(true);
    if (!relu.ok) return;
    expect(relu.entrees.baremes.find((b) => String(b.id) === String(vivante.id))?.coutKmGnf).toBe(vivante.coutKmGnf);
    expect(relu.entrees.baremes.find((b) => String(b.id) === String(vivante.id))?.coutKmGnf).not.toBe(vivanteModifiee.coutKmGnf);
    const rejoue = JSON.stringify(construireScenario(relu.entrees), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(rejoue).toBe(resultatAvant);

    // Contre-épreuve : un scénario recalculé avec le nouveau prix donne un autre résultat (le test mesure bien quelque chose).
    const nouveau = construireScenario({ ...entrees, baremes: entrees.baremes.map((b) => (b.id === vivante.id ? vivanteModifiee : b)) });
    expect(JSON.stringify(nouveau, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toBe(resultatAvant);
  });
});

// ---------------------------------------------------------------------------------------------
// Revue (item 8) : versionAttendue obligatoire, identifiant borne, identites minimales
// ---------------------------------------------------------------------------------------------

describe("approbation : la version lue est OBLIGATOIRE", () => {
  const poserPuisAdmin = async () => {
    h.compte = { id: "u-gest", role: "GESTIONNAIRE", email: "gest@ageroute.gov.gn" };
    await request(app).patch("/3").send({ anneeReference: 2026, largeurChausseeM: 6.5, motif: MOTIF });
    h.compte = { id: "u-adm1", role: "ADMIN", email: "adm1@ageroute.gov.gn" };
  };

  it("sans versionAttendue : 400 CORPS_INVALIDE, rien n'est approuve, historique et audit inchanges", async () => {
    await poserPuisAdmin();
    const avant = { hist: h.db.hist.length, audits: h.db.audits.length };
    const r = await request(app).post("/3/approuver").send({ motif: MOTIF, commentaire: COMMENTAIRE });
    expect([r.status, r.body.code]).toEqual([400, "CORPS_INVALIDE"]);
    expect(JSON.stringify(r.body.details)).toContain("versionAttendue");
    expect(h.db.ligne.approuveLe).toBeNull();
    expect([h.db.hist.length, h.db.audits.length]).toEqual([avant.hist, avant.audits]);
  });

  it("versionAttendue invalide (0, negative, decimale, chaine) : 400 ; la bonne version approuve ; une version perimee : 409", async () => {
    await poserPuisAdmin();
    for (const v of [0, -1, 1.5, "2", null]) {
      expect((await request(app).post("/3/approuver").send(corpsApprobation({ versionAttendue: v }))).status, String(v)).toBe(400);
    }
    expect((await request(app).post("/3/approuver").send(corpsApprobation({ versionAttendue: 1 }))).status).toBe(409);
    expect((await request(app).post("/3/approuver").send(corpsApprobation())).status).toBe(200);
  });
});

describe("identifiant de ligne : borne int4, 400 propre", () => {
  it.each(["2147483648", "9007199254740993", "99999999999999999999"])("GET /%s/historique : 400 ID_HORS_PLAGE (jamais une erreur SQL 500)", async (id) => {
    const r = await request(app).get(`/${id}/historique`);
    expect([r.status, r.body.code]).toEqual([400, "ID_HORS_PLAGE"]);
  });

  it("PATCH et approbation d'un identifiant hors plage : 400, avant toute lecture en base", async () => {
    expect((await request(app).patch("/2147483648").send({ anneeReference: 2026, motif: MOTIF })).status).toBe(400);
    h.compte = { id: "u-adm1", role: "ADMIN", email: "adm1@ageroute.gov.gn" };
    expect((await request(app).post("/2147483648/approuver").send(corpsApprobation())).status).toBe(400);
  });

  it("la borne haute valide (2147483647) est une ligne inconnue : 404 ; un identifiant mal forme reste 404", async () => {
    expect((await request(app).get("/2147483647/historique")).status).toBe(404);
    for (const id of ["abc", "-1", "0", "1.5", "1e3", "0x10"]) expect((await request(app).get(`/${id}/historique`)).status, id).toBe(404);
  });
});

describe("identites : un compte qui ne gere pas les barèmes ne voit pas les e-mails des auteurs", () => {
  const approuverPuisLire = async () => {
    h.compte = { id: "u-gest", role: "GESTIONNAIRE", email: "gest@ageroute.gov.gn" };
    await request(app).patch("/3").send({ anneeReference: 2026, largeurChausseeM: 6.5, motif: MOTIF });
    h.compte = { id: "u-adm1", role: "ADMIN", email: "adm1@ageroute.gov.gn" };
    expect((await request(app).post("/3/approuver").send(corpsApprobation())).status).toBe(200);
  };

  it.each(["LECTEUR", "INSPECTEUR"])("%s : historique et liste sans aucune adresse e-mail, mais avec un identifiant minimal et les faits (version, motif, valeurs)", async (role) => {
    await approuverPuisLire();
    h.compte = { id: "u-l", role, email: "lecteur@x.gn" };
    const hist = await request(app).get("/3/historique");
    const liste = await request(app).get("/");
    expect(hist.status).toBe(200);
    for (const corps of [hist.text, liste.text]) {
      expect(corps).not.toContain("@");
      expect(corps).not.toContain("gest@ageroute");
      expect(corps).not.toContain("adm1@ageroute");
    }
    // l'identifiant minimal : premiere lettre + marque, et l'identifiant opaque conserve ; les faits restent lisibles
    expect(hist.body.data[1].auteur).toEqual({ id: "u-gest", email: "g***" });
    expect(hist.body.data[0].auteur).toEqual({ id: "u-adm1", email: "a***" });
    expect(hist.body.data[1].valeursApres.anneeReference).toBe(2026);
    expect(hist.body.data[0].motif).toBe(MOTIF);
    expect(hist.body.bareme.approuvePar).toBe("a***");
    expect(liste.body.data[0].approuvePar).toBe("a***");
    // la valeur « approuvePar » enregistree dans l'evenement d'approbation est elle aussi masquee
    expect(JSON.stringify(hist.body.data[0].valeursApres)).not.toContain("adm1@");
    expect(hist.body.data[0].valeursApres.approuvePar).toBe("a***");
  });

  it.each(["ADMIN", "GESTIONNAIRE"])("%s : identites completes, comme avant", async (role) => {
    await approuverPuisLire();
    h.compte = { id: "u-x", role, email: "x@x.gn" };
    const hist = await request(app).get("/3/historique");
    expect(hist.body.data[1].auteur.email).toBe("gest@ageroute.gov.gn");
    expect(hist.body.data[0].valeursApres.approuvePar).toBe("adm1@ageroute.gov.gn");
    expect(hist.body.bareme.approuvePar).toBe("adm1@ageroute.gov.gn");
    expect((await request(app).get("/")).body.data[0].approuvePar).toBe("adm1@ageroute.gov.gn");
  });

  it("la reponse d'une modification ou d'une approbation (reservees ADMIN / GESTIONNAIRE) garde l'identite complete", async () => {
    h.compte = { id: "u-gest", role: "GESTIONNAIRE", email: "gest@ageroute.gov.gn" };
    await request(app).patch("/3").send({ anneeReference: 2026, largeurChausseeM: 6.5, motif: MOTIF });
    h.compte = { id: "u-adm1", role: "ADMIN", email: "adm1@ageroute.gov.gn" };
    const r = await request(app).post("/3/approuver").send(corpsApprobation());
    expect(r.body.approuvePar).toBe("adm1@ageroute.gov.gn");
  });
});
