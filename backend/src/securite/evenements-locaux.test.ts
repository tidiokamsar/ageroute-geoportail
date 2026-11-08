import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `POST /api/auth/evenements-locaux` : le lot borne d'evenements de session locale que l'appareil
 * remonte a la reconnexion (chantier D4, point 5 ; `docs/securite/SESSION-HORS-LIGNE.md` section 5).
 *
 * CE QUE LA ROUTE GARANTIT, ET CE QUE CES TESTS DEFENDENT
 *
 *  - LISTE FERMEE et CHAMPS FERMES. Une route qui ecrit dans le journal d'audit sur ordre d'un client
 *    est un canal d'ecriture : sans plafond de taille, sans liste d'evenements et sans refus des champs
 *    inconnus, un client (ou un script) y deposerait n'importe quel texte, un PIN ou un payload compris.
 *  - IDEMPOTENCE par identifiant d'evenement choisi par le client : un lot rejoue (reponse perdue,
 *    reconnexion en boucle) n'ajoute AUCUNE ligne.
 *  - L'HORODATAGE CLIENT N'EST PAS FIABLE : il est conserve tel quel, marque non fiable ; l'heure qui
 *    fait foi est celle du serveur (`audit_logs.createdAt`).
 *  - ATOMICITE : un lot s'ecrit en entier ou pas du tout.
 *
 * La base est simulee ; la preuve contre une vraie base est `tests-integration/session-appareil.integration.mts`.
 */

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://127.0.0.1:1/essai";
  process.env.JWT_ACCESS_SECRET = "essai-access-secret-essai-access-secret-0000";
  process.env.JWT_REFRESH_SECRET = "essai-refresh-secret-essai-refresh-secret-000";
  process.env.CORS_ORIGIN = "http://localhost:5173";
});

const h = vi.hoisted(() => ({
  user: { id: "agent-1", role: "INSPECTEUR" } as { id: string; role: string },
  audits: [] as Array<Record<string, unknown>>,
  appareils: {} as Record<string, { id: string; userId: string; revoqueA: Date | null }>,
  auditFailureAt: 0,
}));

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { ...h.user };
    next();
  },
}));
vi.mock("../utils/audit", () => ({
  logAudit: vi.fn(),
  construireAudit: vi.fn(),
  logAuditTransactionnelle: vi.fn(async (
    tx: { auditLog: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> } },
    params: Record<string, unknown>,
  ) => tx.auditLog.create({ data: params })),
}));
vi.mock("../lib/prisma", () => ({
  prisma: {
    appareil: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
        const a = h.appareils[where.id];
        return a && a.userId === where.userId ? a : null;
      }),
    },
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
      const sauve = [...h.audits];
      const tx = {
        $executeRaw: vi.fn(async () => 0),
        auditLog: {
          findMany: vi.fn(async ({ where }: { where: { userId: string; entityType: string; entityId: { in: string[] } } }) =>
            h.audits
              .filter((a) => a.userId === where.userId && a.entityType === where.entityType && where.entityId.in.includes(a.entityId as string))
              .map((a) => ({ entityId: a.entityId }))),
          // Plafond journalier (D9, point 3) : lignes du compte, de ce type, ecrites depuis `gte`.
          count: vi.fn(async ({ where }: { where: { userId: string; entityType: string; createdAt: { gte: Date } } }) =>
            h.audits.filter((a) => a.userId === where.userId && a.entityType === where.entityType && (a.createdAt as Date) >= where.createdAt.gte).length),
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            if (h.auditFailureAt && h.audits.length + 1 === h.auditFailureAt) throw new Error("audit indisponible");
            h.audits.push({ createdAt: new Date(), ...data });
            return data;
          }),
        },
      };
      try {
        return await run(tx);
      } catch (e) {
        h.audits = sauve;
        throw e;
      }
    }),
  },
}));

import { authRouter } from "../modules/auth/auth.routes";
import {
  EVENEMENTS_LOCAUX, EVENEMENTS_LOCAUX_MAX_PAR_LOT, EVENEMENTS_LOCAUX_LOTS_PAR_FENETRE, EVENEMENTS_LOCAUX_MAX_PAR_JOUR,
  _reinitialiserLimiteEvenementsLocaux,
} from "../modules/auth/evenements-locaux";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const evt = (n: number, evenement = "OUVERTURE_HORS_LIGNE", extra: Record<string, unknown> = {}) => ({
  id: uuid(n), evenement, horodatageClient: "2026-10-24T08:15:00.000Z", ...extra,
});

function app() {
  const a = express();
  a.set("trust proxy", 1);
  a.use(express.json());
  a.use("/api/auth", authRouter);
  a.use((e: Error, _q: express.Request, s: express.Response, _n: express.NextFunction) => {
    s.status(e.name === "ZodError" ? 400 : 500).json({ erreur: e.name });
  });
  return a;
}
const envoyer = (corps: unknown, a = app()) => request(a).post("/api/auth/evenements-locaux").send(corps as object);
const lignes = () => h.audits.filter((a) => a.entityType === "EvenementLocal");

beforeEach(() => {
  h.user = { id: "agent-1", role: "INSPECTEUR" };
  h.audits = [];
  h.appareils = {};
  h.auditFailureAt = 0;
  _reinitialiserLimiteEvenementsLocaux();
  vi.clearAllMocks();
});

describe("ecriture dans le journal d'audit", () => {
  it("enregistre une ligne SECURITY_EVENT par evenement, avec l'horodatage client marque NON FIABLE et l'IP vue par le serveur", async () => {
    h.appareils[uuid(900)] = { id: uuid(900), userId: "agent-1", revoqueA: null };
    const r = await envoyer({ appareilId: uuid(900), evenements: [evt(1), evt(2, "ECHEC_DEVERROUILLAGE", { occurrences: 3 })] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ recus: 2, enregistres: 2, dejaConnus: 0 });
    expect(lignes()).toHaveLength(2);
    expect(lignes()[0]).toMatchObject({
      userId: "agent-1", action: "SECURITY_EVENT", entityType: "EvenementLocal", entityId: uuid(1),
      after: {
        evenement: "OUVERTURE_HORS_LIGNE", horodatageClient: "2026-10-24T08:15:00.000Z", horodatageClientFiable: false,
        appareilId: uuid(900), appareilReconnu: true, occurrences: 1,
      },
    });
    expect(lignes()[1]).toMatchObject({ after: { evenement: "ECHEC_DEVERROUILLAGE", occurrences: 3 } });
    expect(typeof lignes()[0].ipAddress).toBe("string");
  });

  it("les huit evenements de la conception sont acceptes, et seulement eux", async () => {
    expect([...EVENEMENTS_LOCAUX]).toEqual([
      "OUVERTURE_HORS_LIGNE", "DEVERROUILLAGE", "ECHEC_DEVERROUILLAGE", "VERROU_INACTIVITE",
      "SESSION_LOCALE_FERMEE", "SESSION_LOCALE_EXPIREE", "PIN_REINITIALISE", "EFFACEMENT_LOCAL",
    ]);
    const r = await envoyer({ evenements: EVENEMENTS_LOCAUX.map((e, i) => evt(i + 1, e)) });
    expect(r.status).toBe(200);
    expect(r.body.enregistres).toBe(8);
  });

  it("un appareil qui n'est PAS celui du compte n'est jamais attribue : appareilId nul, appareilReconnu faux", async () => {
    h.appareils[uuid(901)] = { id: uuid(901), userId: "agent-2", revoqueA: null };
    await envoyer({ appareilId: uuid(901), evenements: [evt(1)] });
    expect(lignes()[0].after).toMatchObject({ appareilId: null, appareilReconnu: false });
  });

  it("un appareil REVOQUE du compte peut encore remonter ses evenements (information d'audit), marque comme tel", async () => {
    h.appareils[uuid(902)] = { id: uuid(902), userId: "agent-1", revoqueA: new Date() };
    const r = await envoyer({ appareilId: uuid(902), evenements: [evt(1, "SESSION_LOCALE_FERMEE")] });
    expect(r.status).toBe(200);
    expect(lignes()[0].after).toMatchObject({ appareilId: uuid(902), appareilReconnu: true, appareilRevoque: true });
  });

  it("aucune donnee de contenu : la ligne ne porte que les champs prevus", async () => {
    await envoyer({ evenements: [evt(1)] });
    expect(Object.keys(lignes()[0].after as object).sort()).toEqual([
      "appareilId", "appareilReconnu", "appareilRevoque", "evenement", "horodatageClient", "horodatageClientFiable", "occurrences",
    ]);
  });
});

describe("idempotence par identifiant d'evenement client", () => {
  it("rejouer le MEME lot n'ajoute aucune ligne", async () => {
    const lot = { evenements: [evt(1), evt(2, "DEVERROUILLAGE")] };
    await envoyer(lot);
    const r = await envoyer(lot);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ recus: 2, enregistres: 0, dejaConnus: 2 });
    expect(lignes()).toHaveLength(2);
  });

  it("un lot partiellement connu n'ajoute que ce qui manque", async () => {
    await envoyer({ evenements: [evt(1)] });
    const r = await envoyer({ evenements: [evt(1), evt(2), evt(3)] });
    expect(r.body).toEqual({ recus: 3, enregistres: 2, dejaConnus: 1 });
    expect(lignes()).toHaveLength(3);
  });

  it("un identifiant repete DANS le lot n'est ecrit qu'une fois", async () => {
    const r = await envoyer({ evenements: [evt(1), evt(1)] });
    expect(r.body).toEqual({ recus: 2, enregistres: 1, dejaConnus: 1 });
    expect(lignes()).toHaveLength(1);
  });

  it("l'identifiant est propre au compte : un autre compte peut utiliser la meme valeur sans effacer ni masquer la premiere", async () => {
    await envoyer({ evenements: [evt(1)] });
    h.user = { id: "agent-2", role: "INSPECTEUR" };
    const r = await envoyer({ evenements: [evt(1)] });
    expect(r.body.enregistres).toBe(1);
    expect(lignes().map((l) => l.userId).sort()).toEqual(["agent-1", "agent-2"]);
  });

  it("atomique : un echec en cours de lot n'en laisse aucune ligne, et un rejeu complet reussit ensuite", async () => {
    h.auditFailureAt = 2;
    const lot = { evenements: [evt(1), evt(2), evt(3)] };
    const r = await envoyer(lot);
    expect(r.status).toBe(500);
    expect(lignes()).toHaveLength(0);
    h.auditFailureAt = 0;
    const rejeu = await envoyer(lot);
    expect(rejeu.body).toEqual({ recus: 3, enregistres: 3, dejaConnus: 0 });
  });
});

describe("lot BORNE : tout ce qui sort des bornes est refuse en entier, sans rien ecrire", () => {
  const refuse = async (corps: unknown) => {
    const r = await envoyer(corps);
    expect(r.status).toBe(400);
    expect(lignes()).toHaveLength(0);
  };

  it("evenement hors liste", () => refuse({ evenements: [evt(1, "SUPPRESSION_ADMIN")] }));
  it("lot vide", () => refuse({ evenements: [] }));
  it("lot trop grand", () => refuse({ evenements: Array.from({ length: EVENEMENTS_LOCAUX_MAX_PAR_LOT + 1 }, (_, i) => evt(i + 1)) }));
  it("identifiant d'evenement qui n'est pas un UUID (cle d'idempotence bricolee)", () => refuse({ evenements: [{ ...evt(1), id: "evt-1" }] }));
  it("horodatage client trop long", () => refuse({ evenements: [{ ...evt(1), horodatageClient: "2026-10-24T08:15:00.000Z".padEnd(200, "0") }] }));
  it("horodatage client qui n'est pas une date", () => refuse({ evenements: [{ ...evt(1), horodatageClient: "hier soir" }] }));
  it("champ inconnu sur un evenement (un PIN, un payload, un commentaire libre)", () => refuse({ evenements: [{ ...evt(1), pin: "123456" }] }));
  it("champ inconnu sur le lot", () => refuse({ evenements: [evt(1)], payload: { donnees: "x" } }));
  it("occurrences hors bornes", () => refuse({ evenements: [evt(1, "ECHEC_DEVERROUILLAGE", { occurrences: 100_000 })] }));
  it("identifiant d'appareil qui n'est pas un UUID", () => refuse({ appareilId: "mon-telephone", evenements: [evt(1)] }));

  it("le lot de taille maximale passe", async () => {
    const r = await envoyer({ evenements: Array.from({ length: EVENEMENTS_LOCAUX_MAX_PAR_LOT }, (_, i) => evt(i + 1)) });
    expect(r.status).toBe(200);
    expect(r.body.enregistres).toBe(EVENEMENTS_LOCAUX_MAX_PAR_LOT);
  });
});

describe("horodatage client : ISO 8601 stricte (D9, point 3)", () => {
  const refuse = async (horodatageClient: string) => {
    const r = await envoyer({ evenements: [{ ...evt(1), horodatageClient }] });
    expect(r.status).toBe(400);
    expect(lignes()).toHaveLength(0);
  };

  it("refuse la forme du relecteur : du HTML de 30 caracteres que Date.parse acceptait", async () => {
    const piege = "<img src=x onerror=alert(1)> 1";
    expect(Number.isNaN(Date.parse(piege))).toBe(false); // c'est bien ce qui passait avant
    expect(piege.length).toBeLessThanOrEqual(40);
    await refuse(piege);
  });
  it("refuse une date sans heure, une date en toutes lettres, un nombre, une date sans fuseau", async () => {
    await refuse("2026-10-24");
    await refuse("Oct 24 2026 08:15");
    await refuse("1700000000000");
    await refuse("2026-10-24T08:15:00");
    await refuse("2026-10-24T08:15:00.000Z <b>");
  });
  it("accepte ce que le client emet (toISOString) et un decalage explicite", async () => {
    const r = await envoyer({ evenements: [
      { ...evt(1), horodatageClient: new Date(Date.UTC(2026, 9, 24, 8, 15, 0, 123)).toISOString() },
      { ...evt(2), horodatageClient: "2026-10-24T09:15:00+01:00" },
      { ...evt(3), horodatageClient: "2026-10-24T08:15:00Z" },
    ] });
    expect(r.status).toBe(200);
    expect(r.body.enregistres).toBe(3);
  });
});

describe("debit reduit et plafond JOURNALIER par compte (D9, point 3)", () => {
  const ancien = (n: number, heures: number) => ({
    userId: "agent-1", action: "SECURITY_EVENT", entityType: "EvenementLocal", entityId: uuid(10_000 + n),
    createdAt: new Date(Date.now() - heures * 3_600_000),
  });

  it("le debit court est de 5 lots par 15 minutes : le sixieme est coupe (429 TROP_DE_REQUETES)", async () => {
    expect(EVENEMENTS_LOCAUX_LOTS_PAR_FENETRE).toBe(5);
    const a = app();
    const statuts: number[] = [];
    for (let i = 0; i < 7; i++) statuts.push((await request(a).post("/api/auth/evenements-locaux").send({ evenements: [evt(i + 1)] })).status);
    expect(statuts).toEqual([200, 200, 200, 200, 200, 429, 429]);
    const r = await request(a).post("/api/auth/evenements-locaux").send({ evenements: [evt(99)] });
    expect(r.body.code).toBe("TROP_DE_REQUETES");
  });

  it("le plafond journalier vaut 500 lignes par compte (PROVISOIRE), soit 288 fois moins que les 144 000 d'avant", () => {
    expect(EVENEMENTS_LOCAUX_MAX_PAR_JOUR).toBe(500);
  });

  it("un lot qui ferait depasser le plafond est refuse EN ENTIER : 429 explicite, aucune ligne ecrite, reste annonce", async () => {
    for (let i = 0; i < EVENEMENTS_LOCAUX_MAX_PAR_JOUR - 5; i++) h.audits.push(ancien(i, 1));
    const r = await envoyer({ evenements: Array.from({ length: 6 }, (_, i) => evt(i + 1)) });
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ code: "PLAFOND_JOURNALIER_ATTEINT", plafondJournalier: EVENEMENTS_LOCAUX_MAX_PAR_JOUR, restantSurLes24Heures: 5 });
    expect(lignes()).toHaveLength(EVENEMENTS_LOCAUX_MAX_PAR_JOUR - 5);
  });

  it("un lot qui tient exactement dans le reste passe, et le suivant est refuse", async () => {
    for (let i = 0; i < EVENEMENTS_LOCAUX_MAX_PAR_JOUR - 5; i++) h.audits.push(ancien(i, 1));
    expect((await envoyer({ evenements: Array.from({ length: 5 }, (_, i) => evt(i + 1)) })).status).toBe(200);
    const apres = await envoyer({ evenements: [evt(50)] });
    expect(apres.status).toBe(429);
    expect(apres.body.restantSurLes24Heures).toBe(0);
  });

  it("le rejeu d'un lot DEJA connu n'ajoute rien et passe meme au plafond (idempotence avant plafond)", async () => {
    await envoyer({ evenements: [evt(1), evt(2)] });
    for (let i = 0; i < EVENEMENTS_LOCAUX_MAX_PAR_JOUR; i++) h.audits.push(ancien(i, 1));
    const r = await envoyer({ evenements: [evt(1), evt(2)] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ recus: 2, enregistres: 0, dejaConnus: 2 });
  });

  it("fenetre GLISSANTE de 24 heures : les lignes de plus de 24 heures ne comptent plus", async () => {
    for (let i = 0; i < EVENEMENTS_LOCAUX_MAX_PAR_JOUR; i++) h.audits.push(ancien(i, 25));
    const r = await envoyer({ evenements: [evt(1)] });
    expect(r.status).toBe(200);
    expect(r.body.enregistres).toBe(1);
  });

  it("le plafond est PAR COMPTE : un compte au plafond ne coupe pas un autre compte", async () => {
    for (let i = 0; i < EVENEMENTS_LOCAUX_MAX_PAR_JOUR; i++) h.audits.push(ancien(i, 1));
    expect((await envoyer({ evenements: [evt(1)] })).status).toBe(429);
    h.user = { id: "agent-2", role: "INSPECTEUR" };
    expect((await envoyer({ evenements: [evt(1)] })).status).toBe(200);
  });
});

describe("limitation de debit adaptee : par COMPTE, pas par adresse", () => {
  it("un compte qui boucle est coupe (429) sans toucher un autre compte derriere la meme adresse", async () => {
    const a = app();
    let dernier = 200;
    for (let i = 0; i < 40 && dernier !== 429; i++) {
      dernier = (await request(a).post("/api/auth/evenements-locaux").set("X-Forwarded-For", "10.1.1.1").send({ evenements: [evt(i + 1)] })).status;
    }
    expect(dernier).toBe(429);

    h.user = { id: "agent-3", role: "INSPECTEUR" };
    const autre = await request(a).post("/api/auth/evenements-locaux").set("X-Forwarded-For", "10.1.1.1").send({ evenements: [evt(500)] });
    expect(autre.status).toBe(200);
  });
});
