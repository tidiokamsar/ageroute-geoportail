import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Telechargement de l'APK : ce que ces tests defendent.
 *   - SANS jeton, rien n'est servi (l'APK de debug n'est plus public) ;
 *   - avec jeton : les octets du fichier, tels quels, en piece jointe, sans mise en cache ;
 *   - l'empreinte SHA-256 rendue est celle du fichier servi ;
 *   - aucun chemin ne vient de la requete : un nom de fichier dans l'URL ne sert pas un autre fichier ;
 *   - fichier absent : 404 lisible, pas une erreur serveur.
 */
vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, res: express.Response, n: express.NextFunction) => {
    if (!req.headers.authorization?.startsWith("Bearer ")) { res.status(401).json({ error: "Authentification requise" }); return; }
    (req as unknown as { user: unknown }).user = { id: "u-apk", role: "LECTEUR" };
    n();
  },
}));
const audits = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("../utils/audit", () => ({
  logAudit: vi.fn(async (p: Record<string, unknown>) => { audits.push(p); }),
}));

import { mobileV2Router, NOM_APK } from "./mobile.routes";

const JETON = { Authorization: "Bearer essai" };
const CONTENU = Buffer.from("PK\u0003\u0004 faux apk pour l'essai ".repeat(50));
let dossier = "";
const app = express();
app.use(mobileV2Router);

beforeAll(() => {
  dossier = mkdtempSync(join(tmpdir(), "bdri-apk-"));
  writeFileSync(join(dossier, NOM_APK), CONTENU);
  writeFileSync(join(dossier, "secret.txt"), "ne doit jamais etre servi");
  process.env.MOBILE_DIR = dossier;
});
afterAll(() => { rmSync(dossier, { recursive: true, force: true }); delete process.env.MOBILE_DIR; });

describe("APK reserve aux comptes connectes", () => {
  it("sans jeton : 401 sur le fichier comme sur l'empreinte", async () => {
    expect((await request(app).get("/apk")).status).toBe(401);
    expect((await request(app).get("/apk/info")).status).toBe(401);
  });

  it("avec jeton : les octets du fichier, en piece jointe, jamais mis en cache", async () => {
    const r = await request(app).get("/apk").set(JETON).buffer(true).parse((res, cb) => {
      const morceaux: Buffer[] = [];
      res.on("data", (d: Buffer) => morceaux.push(d));
      res.on("end", () => cb(null, Buffer.concat(morceaux)));
    });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/vnd.android.package-archive");
    expect(r.headers["content-disposition"]).toBe(`attachment; filename="${NOM_APK}"`);
    expect(r.headers["cache-control"]).toBe("private, no-store");
    expect(Buffer.compare(r.body as Buffer, CONTENU)).toBe(0);
  });

  it("trace QUI telecharge l'APK dans le journal d'audit", async () => {
    audits.length = 0;
    await request(app).get("/apk").set(JETON);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      userId: "u-apk", action: "SECURITY_EVENT", entityType: "ApplicationMobile", entityId: NOM_APK,
      after: { evenement: "APK_TELECHARGE", fichier: NOM_APK, tailleOctets: CONTENU.length },
    });
  });

  it("ne trace rien sans jeton, ni quand le fichier est absent, ni pour la simple empreinte", async () => {
    audits.length = 0;
    await request(app).get("/apk");
    await request(app).get("/apk/info").set(JETON);
    const ancien = process.env.MOBILE_DIR;
    process.env.MOBILE_DIR = join(dossier, "inexistant");
    try { await request(app).get("/apk").set(JETON); } finally { process.env.MOBILE_DIR = ancien; }
    expect(audits).toHaveLength(0);
  });

  it("l'empreinte rendue est le SHA-256 du fichier servi, avec sa taille", async () => {
    const r = await request(app).get("/apk/info").set(JETON);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ disponible: true, nom: NOM_APK, tailleOctets: CONTENU.length });
    expect(r.body.sha256).toBe(createHash("sha256").update(CONTENU).digest("hex"));
  });

  it("aucun chemin ne vient de la requete : ni parametre, ni parcours de repertoire", async () => {
    const r = await request(app).get("/apk").set(JETON).query({ fichier: "../secret.txt", nom: "secret.txt" });
    expect(r.status).toBe(200);
    expect(r.text ?? "").not.toContain("ne doit jamais etre servi");
    expect((await request(app).get("/apk/secret.txt").set(JETON)).status).toBe(404);
  });

  it("fichier absent : 404 lisible, et l'empreinte dit « non disponible »", async () => {
    const ancien = process.env.MOBILE_DIR;
    process.env.MOBILE_DIR = join(dossier, "inexistant");
    try {
      const r = await request(app).get("/apk").set(JETON);
      expect(r.status).toBe(404);
      expect(r.body.error).toMatch(/pas publiée/);
      expect((await request(app).get("/apk/info").set(JETON)).body).toEqual({ disponible: false });
    } finally { process.env.MOBILE_DIR = ancien; }
  });
});
