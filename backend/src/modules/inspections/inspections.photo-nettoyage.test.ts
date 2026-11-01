import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Le fichier televerse quand l'enregistrement echoue : ce que ces tests defendent.
 *
 * LE DEFAUT
 *
 * `multer` ecrit le fichier AVANT que le gestionnaire de route ne s'execute. Les trois
 * gestionnaires de photos — inspections, ouvrages, ordres de travaux — appelaient ensuite
 * leur service et laissaient toute erreur partir a `next(err)`. Le fichier restait sur le
 * disque sans aucune ligne en base pour le referencer : un orphelin que rien ne reclame
 * et que personne ne vient nettoyer.
 *
 * Le cas le plus courant est banal : un identifiant inconnu rend 404 apres que les octets
 * soient ecrits.
 *
 * ET LE CHANGEMENT DE L'ADR 11 LE REND PLUS PROBABLE
 *
 * Depuis que l'audit des photos d'inspection rejoint la transaction metier, une panne de
 * journalisation FAIT LEVER la ou l'erreur etait avalee. Un chemin d'erreur rare devient
 * un chemin normal. L'ADR demandait precisement de verifier ce nettoyage avant d'etendre
 * la migration : ces tests sont cette verification.
 *
 * LE CAS QUI JUSTIFIE LE DRAPEAU
 *
 * Nettoyer dans tout `catch` supprimerait un fichier DEJA REFERENCE si l'ecriture a
 * reussi et que seule la reponse a echoue. Le dernier test de ce fichier defend cette
 * distinction.
 */

const h = vi.hoisted(() => ({
  /** Chemins reellement supprimes. */
  supprimes: [] as string[],
  /** Fait echouer l'ajout en base, comme une transaction annulee. */
  ajoutEchoue: false,
  /** Fait echouer la SERIALISATION de la reponse, apres une ecriture reussie. */
  reponseEchoue: false,
  inspecteurId: "u1",
}));

vi.mock("../../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: "u1", role: "INSPECTEUR" };
    next();
  },
}));
vi.mock("../../middleware/rbac.middleware", () => ({
  requireRole: () => (_r: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));
vi.mock("../../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_r: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));
vi.mock("../../middleware/quota-photos.middleware", () => ({
  plafondPhotos: () => (_r: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));

// Le middleware simule ce que fait multer : il pose le fichier AVANT le gestionnaire.
vi.mock("../../middleware/upload-photo.middleware", () => ({
  uploadPhoto: (req: express.Request, _s: express.Response, n: express.NextFunction) => {
    Object.assign(req, {
      file: { path: "/tmp/photos/televersee.jpg", filename: "televersee.jpg", size: 1024 },
    });
    n();
  },
  PHOTOS_UPLOAD_DIR: "/tmp/photos",
}));

vi.mock("node:fs/promises", () => ({
  unlink: vi.fn(async (chemin: string) => {
    h.supprimes.push(chemin);
  }),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    inspection: {
      findFirst: vi.fn(async () => ({ inspecteurId: h.inspecteurId })),
      findUnique: vi.fn(async () => null),
    },
  },
}));

vi.mock("./inspections.service", () => ({
  inspectionsService: {
    addPhoto: vi.fn(async () => {
      if (h.ajoutEchoue) throw new Error("audit_logs indisponible");
      // Une valeur non serialisable en JSON fait echouer `res.json` APRES l'ecriture :
      // c'est le seul moyen honnete d'eprouver le drapeau.
      if (h.reponseEchoue) {
        const cyclique: Record<string, unknown> = { id: "i1" };
        cyclique.soi = cyclique;
        return cyclique;
      }
      return { id: "i1", photos: ["televersee.jpg"] };
    }),
    removePhoto: vi.fn(async () => ({})),
    list: vi.fn(async () => ({ items: [], total: 0 })),
    getById: vi.fn(async () => ({})),
    create: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    remove: vi.fn(async () => ({})),
    restore: vi.fn(async () => ({})),
    bulkRemove: vi.fn(async () => ({ success: 0, failed: [] })),
    bulkRestore: vi.fn(async () => ({ success: 0, failed: [] })),
  },
}));

import { inspectionsRouter } from "./inspections.routes";

function app() {
  const a = express();
  a.use("/api/inspections", inspectionsRouter);
  a.use((err: Error, _q: express.Request, s: express.Response, _n: express.NextFunction) => {
    s.status(500).json({ message: err.message });
  });
  return a;
}

beforeEach(() => {
  h.supprimes = [];
  h.ajoutEchoue = false;
  h.reponseEchoue = false;
  h.inspecteurId = "u1";
  vi.clearAllMocks();
});

describe("Un echec d'enregistrement ne laisse pas de fichier orphelin", () => {
  it("SUPPRIME le fichier quand la transaction echoue", async () => {
    // Le cas rendu probable par l'audit transactionnel : la base annule, le service
    // leve, et le fichier ne doit pas survivre a une ecriture qui n'a pas eu lieu.
    h.ajoutEchoue = true;
    const r = await request(app()).post("/api/inspections/i1/photos");
    expect(r.status).toBe(500);
    expect(h.supprimes).toEqual(["/tmp/photos/televersee.jpg"]);
  });

  it("supprime le fichier quand l'inspection n'appartient pas a l'agent", async () => {
    // Le cas banal, et le plus frequent : un 404 apres que les octets soient ecrits.
    h.inspecteurId = "quelqu-un-d-autre";
    const r = await request(app()).post("/api/inspections/i1/photos");
    expect(r.status).toBe(500);
    expect(h.supprimes).toEqual(["/tmp/photos/televersee.jpg"]);
  });

  it("NE SUPPRIME RIEN quand l'enregistrement reussit", async () => {
    const r = await request(app()).post("/api/inspections/i1/photos");
    expect(r.status).toBe(201);
    expect(h.supprimes).toEqual([]);
  });

  it("NE SUPPRIME RIEN quand l'ecriture a reussi et que seule la reponse echoue", async () => {
    // LE CAS QUI JUSTIFIE LE DRAPEAU. Nettoyer dans tout `catch` detruirait ici un
    // fichier DEJA REFERENCE en base : la photo existerait dans la liste de l'inspection
    // et plus sur le disque, ce qui est pire que l'orphelin qu'on corrige.
    h.reponseEchoue = true;
    const r = await request(app()).post("/api/inspections/i1/photos");
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(h.supprimes).toEqual([]);
  });
});
