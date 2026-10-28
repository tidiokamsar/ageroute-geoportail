import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `POST /api/v2/observations/:id/photos` : la preuve photo d'une observation. Ce que ces tests defendent :
 *   - la photo est rattachee a l'observation, avec sa position PAR PAIRE, son cap et sa date, et l'ecriture est auditee ;
 *   - le meme fichier renvoye apres une reponse perdue ne cree RIEN : 200 et la ligne existante (idempotence par SHA-256) ;
 *   - le meme fichier deja rattache a une AUTRE observation est refuse (409) ;
 *   - 404 identique pour « n'existe pas » et « n'est pas a vous » : l'existence n'est pas revelee, meme au plafond ;
 *   - le plafond par objet est refuse AVANT l'ecriture du fichier ;
 *   - une photo refusee ne laisse pas de fichier sur le disque.
 */
const h = vi.hoisted(() => ({
  compte: { id: "agent-1", role: "INSPECTEUR" },
  observation: { id: "o1", agentId: "agent-1" } as { id: string; agentId: string } | null,
  photosDeLObservation: 0,
  mediaExistant: null as Record<string, unknown> | null,
  medias: [] as Record<string, unknown>[],
  audits: [] as Record<string, unknown>[],
  supprimes: [] as string[],
  p2002: false,
}));

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => { (req as unknown as { user: unknown }).user = { ...h.compte }; n(); },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));
vi.mock("../territoire/territoire.v2", () => ({
  territoireObservation: (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));
vi.mock("../middleware/upload-photo.middleware", () => ({
  uploadPhoto: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    Object.assign(req, { file: { path: "uploads/photos/photo-test.jpg", filename: "photo-test.jpg", originalname: "photo.jpg", mimetype: "image/jpeg", size: 12 } });
    next();
  },
  PHOTOS_UPLOAD_DIR: "uploads/photos",
}));
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => Buffer.from("photo-test-bytes")),
  unlink: vi.fn(async (chemin: string) => { h.supprimes.push(chemin); }),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ size: 12 })),
}));
vi.mock("../governance/validation", () => ({ validationPermise: () => ({ ok: true }), EXPLICATIONS: {} }));
vi.mock("../governance/delegation.service", () => ({ verdictDelegation: vi.fn(async () => ({ ok: true })) }));
vi.mock("../lib/qualite", () => ({ enregistrerQualite: vi.fn(async () => undefined) }));
vi.mock("../utils/audit", () => ({
  logAuditTransactionnelle: vi.fn(async (_tx: unknown, p: Record<string, unknown>) => { h.audits.push(p); }),
}));
vi.mock("../lib/prisma", () => ({
  prisma: {
    mission: { findMany: vi.fn(async () => []) },
    observation: {
      findFirst: vi.fn(async (args: { select?: Record<string, unknown>; where: { agentId?: string } }) => {
        const o = h.observation;
        if (!o) return null;
        if (args.where.agentId && args.where.agentId !== o.agentId) return null;
        if (args.select && "_count" in args.select) return { _count: { medias: h.photosDeLObservation } };
        return o;
      }),
    },
    mediaObservation: {
      findUnique: vi.fn(async () => h.mediaExistant),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      mediaObservation: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (h.p2002) throw Object.assign(new Error("unique"), { code: "P2002" });
          const m = { id: "m1", ...data };
          h.medias.push(m);
          return m;
        }),
      },
    })),
  },
}));

import { observationsV2Router } from "./observations.routes";

const app = express();
app.use(express.json());
app.use("/api/v2/observations", observationsV2Router);

beforeEach(() => {
  h.compte = { id: "agent-1", role: "INSPECTEUR" };
  h.observation = { id: "o1", agentId: "agent-1" };
  h.photosDeLObservation = 0; h.mediaExistant = null; h.medias = []; h.audits = []; h.supprimes = []; h.p2002 = false;
});

// Le televersement est simule par le mock de `uploadPhoto` (il pose `req.file`) : les metadonnees arrivent en corps JSON.
const envoyer = (corps: Record<string, string> = {}) => request(app).post("/api/v2/observations/o1/photos").send(corps);
const fichierRetire = () => h.supprimes.some((c) => c.split("\\").join("/").endsWith("uploads/photos/photo-test.jpg"));

describe("POST /observations/:id/photos", () => {
  it("rattache la photo avec position, precision, cap et date du cliche, et audite l'ecriture", async () => {
    const r = await envoyer({ lat: "9.5", lon: "-13.7", precisionM: "5", cap: "90", capturedA: "2026-10-25T09:30:00.000Z" });
    expect(r.status).toBe(201);
    expect(h.medias).toHaveLength(1);
    expect(h.medias[0]).toMatchObject({ observationId: "o1", type: "PHOTO", lat: 9.5, lon: -13.7, precisionM: 5, cap: 90, mimeType: "image/jpeg", tailleOctets: 12 });
    expect(String(h.medias[0].sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(h.audits[0]).toMatchObject({ userId: "agent-1", action: "CREATE", entityType: "MediaObservation", entityId: "m1" });
    expect(h.supprimes).toEqual([]);
  });

  it("sans position : acceptee, position nulle (jamais inventee)", async () => {
    const r = await envoyer();
    expect(r.status).toBe(201);
    expect(h.medias[0]).toMatchObject({ lat: null, lon: null, precisionM: null, cap: null });
  });

  it("le meme fichier renvoye apres une reponse perdue : 200 et la ligne existante, rien de cree, fichier ecarte", async () => {
    h.mediaExistant = { id: "m0", observationId: "o1", sha256: "x" };
    const r = await envoyer();
    expect(r.status).toBe(200);
    expect(r.body.id).toBe("m0");
    expect(h.medias).toHaveLength(0);
    expect(fichierRetire()).toBe(true);
  });

  it("une course sur l'unicite du SHA-256 : 409, et le fichier ecrit est retire", async () => {
    h.p2002 = true;
    const r = await envoyer();
    expect(r.status).toBe(409);
    expect(fichierRetire()).toBe(true);
  });

  it("le meme fichier deja rattache a une AUTRE observation : 409, le fichier du disque est retire", async () => {
    h.mediaExistant = { id: "m0", observationId: "autre", sha256: "x" };
    const r = await envoyer();
    expect(r.status).toBe(409);
    expect(fichierRetire()).toBe(true);
  });

  it("l'observation d'un autre agent : 404, comme une observation inexistante, et le fichier est retire", async () => {
    h.compte = { id: "agent-2", role: "INSPECTEUR" };
    const r = await envoyer();
    expect(r.status).toBe(404);
    expect(h.medias).toHaveLength(0);
    expect(fichierRetire()).toBe(true);
    h.observation = null;
    expect((await envoyer()).status).toBe(404);
  });

  it("un gestionnaire peut joindre une photo a l'observation d'un agent", async () => {
    h.compte = { id: "chef-1", role: "GESTIONNAIRE" };
    expect((await envoyer()).status).toBe(201);
  });

  it("latitude sans longitude : 400, aucun enregistrement, fichier retire", async () => {
    const r = await envoyer({ lat: "9.5" });
    expect(r.status).toBe(400);
    expect(h.medias).toHaveLength(0);
    expect(fichierRetire()).toBe(true);
  });

  it("un champ inconnu est refuse (schema strict)", async () => {
    expect((await envoyer({ auteur: "moi" })).status).toBe(400);
  });

  it("au plafond par objet : 409 avec le nombre deja present ; pour l'observation d'un autre agent : 404, sans motif", async () => {
    h.photosDeLObservation = 30;
    const r = await envoyer();
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ motif: "PLAFOND_PAR_OBJET", dejaPresentes: 30 });
    h.compte = { id: "agent-2", role: "INSPECTEUR" };
    const autre = await envoyer();
    expect(autre.status).toBe(404);
    expect(autre.body.motif).toBeUndefined();
  });
});
