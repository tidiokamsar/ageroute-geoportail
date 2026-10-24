import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// Controle territorial (A10) : compte NATIONAL ici, le sujet de ce fichier est ailleurs. Le
// controle lui-meme est eprouve par territoire/*.test.ts et api-v2/perimetres.routes.test.ts.
vi.mock("../territoire/territoire.service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  perimetreDe: async () => ({ national: true }),
}));

/**
 * `/api/v2/portions` — ce que ces tests defendent.
 *
 * LA SEPARATION DES ROLES, QUI SE TIENT OU TOMBE ICI
 *
 * Quatre operations sont des PROPOSITIONS et sortent en `A_VALIDER`. La cinquieme est une
 * DECISION. Trois choses doivent etre vraies, et chacune a deja ete contournee ailleurs
 * dans d'autres programmes :
 *
 *   - l'auteur vient de la LIGNE, jamais du corps de la requete ;
 *   - un `statutValidation` envoye a la creation est IGNORE, pas obei ;
 *   - un refus d'autorite rend 403, un refus d'etat rend 409.
 *
 * LES REFUS D'ETAT SONT DES 409, PAS DES 400
 *
 * `CHEVAUCHE_UNE_VALIDEE` ou `NON_ADJACENTES` : la requete est bien formee, c'est l'etat du
 * reseau qui s'y oppose. Un 400 ferait croire le client fautif alors qu'il doit afficher le
 * motif a l'agent.
 */

const compte = { id: "u-validateur", role: "GESTIONNAIRE" };

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: compte.id, role: compte.role };
    n();
  },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));

const h = vi.hoisted(() => ({
  portion: null as Record<string, unknown> | null,
  auteur: "u-agent" as string | null,
  regionId: 7 as number | null,
  delegation: { permis: true, motif: "DOMAINE_NON_DESIGNE" } as { permis: boolean; motif: string },
  decisions: [] as unknown[],
  creations: [] as unknown[],
  refusCreation: null as string | null,
  requetes: [] as Record<string, unknown>[],
  liste: [] as Record<string, unknown>[],
}));

vi.mock("../governance/delegation.service", () => ({
  verdictDelegation: async () => h.delegation,
}));

vi.mock("../reseau/portions.depot", () => ({
  depotPrisma: {
    portionParId: async () => h.portion,
    decider: async (id: string, statut: string, par: string, com: string | null) => {
      h.decisions.push({ id, statut, par, com });
      return { ...h.portion, statutValidation: statut };
    },
  },
  auteurDeLaPortion: async () => h.auteur,
  regionDuTronconDeLaPortion: async () => h.regionId,
  PortionIntrouvable: class extends Error {},
  DecisionConcurrente: class extends Error {},
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    portion: {
      findMany: async (args: Record<string, unknown>) => {
        h.requetes.push(args);
        return h.liste;
      },
    },
  },
}));

vi.mock("../reseau/portions.service", () => ({
  creerPortion: async (d: unknown) => {
    h.creations.push(d);
    return h.refusCreation !== null
      ? { refus: h.refusCreation }
      : { refus: null, valeur: { id: "p-neuve", statutValidation: "A_VALIDER", ...(d as object) } };
  },
  decouperPortion: async () => ({ refus: null, valeur: [] }),
  fusionnerPortions: async () => ({ refus: "NON_ADJACENTES" }),
  requalifierPortion: async () => ({ refus: null, valeur: { id: "p-req" } }),
}));

import { portionsV2Router } from "./portions.routes";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/v2/portions", portionsV2Router);
  a.use((err: unknown, _q: express.Request, s: express.Response, _n: express.NextFunction) => {
    const nom = err instanceof Error ? err.name : "";
    s.status(nom === "ZodError" ? 400 : 500).json({ erreur: nom });
  });
  return a;
}

const UUID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  compte.id = "u-validateur";
  compte.role = "GESTIONNAIRE";
  h.portion = { id: UUID, statutValidation: "A_VALIDER", tronconId: UUID };
  h.auteur = "u-agent";
  h.regionId = 7;
  h.delegation = { permis: true, motif: "DOMAINE_NON_DESIGNE" };
  h.decisions.length = 0;
  h.creations.length = 0;
  h.refusCreation = null;
  h.requetes.length = 0;
  h.liste = [];
});

describe("Creer une portion", () => {
  it("la cree en PROPOSITION et rend 201", async () => {
    const r = await request(app()).post("/api/v2/portions")
      .send({ tronconId: UUID, debutM: 0, finM: 8000, revetement: "LATERITE" });
    expect(r.status).toBe(201);
    expect(r.body.statutValidation).toBe("A_VALIDER");
  });

  it("IGNORE un statutValidation envoye par le client", async () => {
    // Le contournement le plus simple de toute la separation des roles, et il doit etre
    // impossible : le schema ne connait pas ce champ, donc zod le retire.
    await request(app()).post("/api/v2/portions")
      .send({ tronconId: UUID, debutM: 0, finM: 8000, statutValidation: "VALIDE" });
    expect(h.creations[0]).not.toHaveProperty("statutValidation");
  });

  it("rend 409 et un message actionnable quand une validee couvre deja ces metres", async () => {
    h.refusCreation = "CHEVAUCHE_UNE_VALIDEE";
    const r = await request(app()).post("/api/v2/portions")
      .send({ tronconId: UUID, debutM: 0, finM: 8000 });
    expect(r.status).toBe(409);
    expect(r.body.motif).toBe("CHEVAUCHE_UNE_VALIDEE");
    expect(r.body.message).toMatch(/Requalifiez/);
  });

  it("rend 400 sur des bornes absentes, et n'appelle pas le service", async () => {
    const r = await request(app()).post("/api/v2/portions").send({ tronconId: UUID });
    expect(r.status).toBe(400);
    expect(h.creations).toHaveLength(0);
  });
});

describe("Fusionner", () => {
  it("rend 409 pour un refus d'etat, pas 400", async () => {
    const r = await request(app()).post("/api/v2/portions/fusion").send({ idA: UUID, idB: UUID });
    expect(r.status).toBe(409);
    expect(r.body.motif).toBe("NON_ADJACENTES");
  });
});

describe("Valider : la separation des roles", () => {
  it("REFUSE l'auto-validation en 403, meme avec le bon role", async () => {
    // L'auteur vient de la ligne. Un agent qui a releve ne tranche pas son propre releve.
    h.auteur = compte.id;
    const r = await request(app()).post(`/api/v2/portions/${UUID}/validation`)
      .send({ decision: "VALIDE" });
    expect(r.status).toBe(403);
    expect(r.body.motif).toBe("AUTO_VALIDATION");
    expect(h.decisions).toHaveLength(0);
  });

  it("IGNORE un auteurId envoye par le client", async () => {
    // S'il etait pris en compte, n'importe qui desactiverait le controle en envoyant un
    // autre identifiant, sans laisser de trace.
    h.auteur = compte.id;
    const r = await request(app()).post(`/api/v2/portions/${UUID}/validation`)
      .send({ decision: "VALIDE", auteurId: "quelqu-un-d-autre" });
    expect(r.status).toBe(403);
    expect(r.body.motif).toBe("AUTO_VALIDATION");
  });

  it("REFUSE un role non validateur en 403", async () => {
    compte.role = "INSPECTEUR";
    const r = await request(app()).post(`/api/v2/portions/${UUID}/validation`)
      .send({ decision: "VALIDE" });
    expect(r.status).toBe(403);
    expect(r.body.motif).toBe("ROLE_INSUFFISANT");
  });

  it("REFUSE un validateur hors delegation en 403", async () => {
    // Paragraphe 35 : des qu'un validateur est designe pour le domaine, lui seul tranche.
    h.delegation = { permis: false, motif: "HORS_DELEGATION" };
    const r = await request(app()).post(`/api/v2/portions/${UUID}/validation`)
      .send({ decision: "VALIDE" });
    expect(r.status).toBe(403);
    expect(r.body.motif).toBe("HORS_DELEGATION");
  });

  it("ACCEPTE un validateur habilite et inscrit l'AUTORITE de la decision", async () => {
    // « Personne n'est designe » et « vous etes designe » autorisent la meme action pour
    // des raisons opposees. Sans cette mention, un audit ne saura pas laquelle s'appliquait.
    h.delegation = { permis: true, motif: "DELEGATION_COUVRANTE" };
    const r = await request(app()).post(`/api/v2/portions/${UUID}/validation`)
      .send({ decision: "VALIDE", commentaire: "Constat confirme" });
    expect(r.status).toBe(200);
    expect(r.body.statutValidation).toBe("VALIDE");
    expect(r.body.autorite).toBe("DELEGATION_COUVRANTE");
    expect(h.decisions[0]).toMatchObject({ statut: "VALIDE", par: compte.id, com: "Constat confirme" });
  });

  it("rend 409 quand la portion n'est plus dans l'etat attendu", async () => {
    h.portion = { id: UUID, statutValidation: "VALIDE", tronconId: UUID };
    const r = await request(app()).post(`/api/v2/portions/${UUID}/validation`)
      .send({ decision: "VALIDE" });
    expect(r.status).toBe(409);
    expect(h.decisions).toHaveLength(0);
  });

  it("rend 404 sur une portion introuvable", async () => {
    h.portion = null;
    const r = await request(app()).post(`/api/v2/portions/${UUID}/validation`)
      .send({ decision: "VALIDE" });
    expect(r.status).toBe(404);
  });
});

describe("Lister les portions", () => {
  it("rend les COURANTES par defaut, sans l'historique", async () => {
    // Le point qui compte. Melanger l'etat courant et ses versions anterieures ferait
    // apparaitre plusieurs portions sur les memes metres, et un validateur ne saurait plus
    // laquelle trancher.
    await request(app()).get("/api/v2/portions?statut=A_VALIDER");
    expect(h.requetes[0].where).toMatchObject({
      deletedAt: null,
      remplaceeLe: null,
      statutValidation: "A_VALIDER",
    });
  });

  it("inclut l'historique quand on le DEMANDE explicitement", async () => {
    await request(app()).get("/api/v2/portions?historique=true");
    expect(h.requetes[0].where).not.toHaveProperty("remplaceeLe");
  });

  it("filtre par troncon et par region", async () => {
    await request(app()).get(`/api/v2/portions?tronconId=${UUID}&regionId=7`);
    expect(h.requetes[0].where).toMatchObject({
      tronconId: UUID,
      troncon: { regionId: 7 },
    });
  });

  it("rend les plus RECENTES d'abord : un validateur traite ce qui vient d'arriver", async () => {
    await request(app()).get("/api/v2/portions");
    expect(h.requetes[0].orderBy).toEqual({ createdAt: "desc" });
  });

  it("ne rend un curseur que si la page est PLEINE", async () => {
    // Un curseur rendu sur une page incomplete ferait boucler le client sur une page vide.
    h.liste = Array.from({ length: 3 }, (_, i) => ({ id: `p-${i}` }));
    const court = await request(app()).get("/api/v2/portions?limite=50");
    expect(court.body.curseurSuivant).toBeNull();

    h.liste = Array.from({ length: 2 }, (_, i) => ({ id: `p-${i}` }));
    const plein = await request(app()).get("/api/v2/portions?limite=2");
    expect(plein.body.curseurSuivant).toBe("p-1");
  });

  it("REFUSE une limite absurde plutot que de servir toute la table", async () => {
    const r = await request(app()).get("/api/v2/portions?limite=100000");
    expect(r.status).toBe(400);
    expect(h.requetes).toHaveLength(0);
  });

  it("REFUSE un statut inconnu plutot que de l'ignorer en silence", async () => {
    const r = await request(app()).get("/api/v2/portions?statut=PEUT_ETRE");
    expect(r.status).toBe(400);
  });
});
