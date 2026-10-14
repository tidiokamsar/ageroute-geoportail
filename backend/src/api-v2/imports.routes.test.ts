import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHash } from "node:crypto";

/**
 * `/api/v2/imports` -- ce que ces tests defendent.
 *
 *   - l'IMPORTATEUR vient de l'authentification, jamais du corps ;
 *   - le meme fichier deux fois rend le lot existant SANS AUCUNE ECRITURE (T-06) ;
 *   - chaque ligne finit dans exactement un statut, et les compteurs se somment (A28) ;
 *   - un fichier illisible ou un CRS refuse donne un lot REJETE enregistre (201), pas un 400 ;
 *   - les erreurs sont exportables en CSV avec leur motif (T-04) ;
 *   - un LECTEUR recoit 403 ; rien n'est ecrit dans le referentiel, jamais.
 *
 * Le depot Prisma est remplace par une memoire : ces tests ne mesurent pas la base, dont les
 * contraintes ont leur propre banc (prisma/tests/lots_import.test.sql). Ils mesurent
 * l'orchestration -- ce qu'elle ecrit, dans quel ordre, et ce qu'elle refuse d'ecrire.
 */

const compte = { id: "u-gestionnaire", role: "GESTIONNAIRE" };

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: compte.id, role: compte.role };
    n();
  },
}));

const h = vi.hoisted(() => ({
  lots: [] as Record<string, unknown>[],
  lignes: [] as Record<string, unknown>[],
  audits: [] as Record<string, unknown>[],
  transactions: 0,
}));

vi.mock("../lib/prisma", () => {
  const lotImport = {
    findUnique: async ({ where }: { where: Record<string, unknown> }) => {
      const cle = where.systemeSource_empreinteFichier as { systemeSource: string; empreinteFichier: string } | undefined;
      if (cle) return h.lots.find((l) => l.systemeSource === cle.systemeSource && l.empreinteFichier === cle.empreinteFichier) ?? null;
      return h.lots.find((l) => l.id === where.id) ?? null;
    },
    findMany: async () => h.lots,
    count: async ({ where }: { where: { reference: { startsWith: string } } }) =>
      h.lots.filter((l) => String(l.reference).startsWith(where.reference.startsWith)).length,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const lot = { id: `lot-${h.lots.length + 1}`, importeLe: new Date(), ...data };
      h.lots.push(lot);
      return lot;
    },
  };
  const ligneImport = {
    createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
      data.forEach((d, i) => h.lignes.push({ id: `lg-${h.lignes.length + i + 1}`, ...d }));
      return { count: data.length };
    },
    findMany: async ({ where }: { where: { lotId: string; statut: { in: string[] } } }) =>
      h.lignes.filter((l) => l.lotId === where.lotId && where.statut.in.includes(String(l.statut)))
        .sort((a, b) => Number(a.numeroLigne) - Number(b.numeroLigne)),
  };
  const auditLog = { create: async ({ data }: { data: Record<string, unknown> }) => { h.audits.push(data); return data; } };
  const prisma = {
    lotImport, ligneImport, auditLog,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => { h.transactions += 1; return fn({ lotImport, ligneImport, auditLog }); },
  };
  return { prisma };
});

import { importsV2Router } from "./imports.routes";

const app = express();
app.use("/api/v2/imports", importsV2Router);

const CSV_OK = [
  "systeme_source;type_objet;identifiant_source;code_route;geometrie",
  'ONR_BDR;troncon;RN1-001;RN1;"{""type"":""LineString"",""coordinates"":[[-13.58,9.64],[-13.57,9.65]]}"',
  'ONR_BDR;troncon;RN1-002;RN1;"{""type"":""LineString"",""coordinates"":[[-13.57,9.65],[-13.56,9.66]]}"',
  "ONR_BDR;troncon;;RN1;",
  'ONR_BDR;troncon;RN1-001;RN1;"{""type"":""LineString"",""coordinates"":[[-13.58,9.64],[-13.57,9.65]]}"',
  "",
].join("\n");

function envoyer(csv: string, extra: Record<string, string> = {}, nom = "lot.csv") {
  return request(app).post("/api/v2/imports")
    .field("systemeSource", "ONR_BDR").field("format", "csv").field("methodeSource", "export L2R")
    .field("versionMapping", "v0").field("autorisationRef", "AUT-2026-01")
    .field(Object.keys(extra)[0] ?? "x", Object.values(extra)[0] ?? "")
    .attach("fichier", Buffer.from(csv, "utf8"), nom);
}

beforeEach(() => { h.lots.length = 0; h.lignes.length = 0; h.audits.length = 0; h.transactions = 0; compte.role = "GESTIONNAIRE"; });

describe("Reception d'un lot (POST)", () => {
  it("enregistre le lot et chaque ligne dans exactement un statut, compteurs sommes (A28)", async () => {
    const r = await envoyer(CSV_OK);
    expect(r.status).toBe(201);
    expect(r.body.statut).toBe("VALIDE_SCHEMA");
    expect(r.body.dejaRecu).toBe(false);
    // 4 lignes : 2 valides, 1 rejetee (identifiant manquant), 1 ignoree (doublon de la ligne 1).
    expect(r.body.compteurs).toEqual({ lues: 4, validees: 2, importees: 0, rejetees: 1, enConflit: 0, ignorees: 1 });
    expect(h.lignes.map((l) => l.statut)).toEqual(["VALIDEE", "VALIDEE", "REJETEE", "IGNOREE"]);
    expect(h.lignes[2].motifRejet).toMatch(/identifiant_source manquant/);
    expect(h.lignes[3].motifRejet).toMatch(/doublon dans le lot.*ligne 1, conservee/);
    // La charge originale est conservee telle que recue.
    expect((h.lignes[0].chargeOriginale as Record<string, unknown>).identifiant_source).toBe("RN1-001");
  });

  it("l'importateur est l'utilisateur authentifie, et l'ecriture est auditee dans la transaction", async () => {
    await envoyer(CSV_OK);
    expect(h.lots[0].importeParId).toBe("u-gestionnaire");
    expect(h.transactions).toBe(1);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0].action).toBe("CREATE");
    expect(h.audits[0].entityType).toBe("LotImport");
    expect((h.audits[0].after as Record<string, unknown>).empreinteFichier).toBe(createHash("sha256").update(CSV_OK).digest("hex"));
  });

  it("l'empreinte est calculee sur les octets recus, et une reference stable IMP-AAAA-NNNNN est posee", async () => {
    const r = await envoyer(CSV_OK);
    expect(h.lots[0].empreinteFichier).toBe(createHash("sha256").update(Buffer.from(CSV_OK, "utf8")).digest("hex"));
    expect(r.body.reference).toMatch(/^IMP-\d{4}-\d{5}$/);
    expect(h.lots[0].tailleOctets).toBe(BigInt(Buffer.byteLength(CSV_OK, "utf8")));
  });

  it("le meme fichier deux fois rend le lot existant avec 200, et N'ECRIT RIEN (T-06)", async () => {
    const a = await envoyer(CSV_OK);
    const ecrituresApres1 = { lots: h.lots.length, lignes: h.lignes.length, audits: h.audits.length, tx: h.transactions };
    const b = await envoyer(CSV_OK, {}, "autre-nom.csv");
    expect(b.status).toBe(200);
    expect(b.body.dejaRecu).toBe(true);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.compteurs).toEqual(a.body.compteurs);
    expect({ lots: h.lots.length, lignes: h.lignes.length, audits: h.audits.length, tx: h.transactions }).toEqual(ecrituresApres1);
  });

  it("le meme fichier pour une autre source est un autre lot : l'idempotence est par source", async () => {
    await envoyer(CSV_OK);
    const r = await request(app).post("/api/v2/imports")
      .field("systemeSource", "ANASUR_COLLECT").field("format", "csv").field("methodeSource", "tablette")
      .field("versionMapping", "v0").field("autorisationRef", "AUT-2026-02")
      .attach("fichier", Buffer.from(CSV_OK, "utf8"), "lot.csv");
    expect(r.status).toBe(201);
    expect(h.lots).toHaveLength(2);
  });

  it("un CRS refuse rejette le LOT, enregistre avec son motif : c'est un 201, pas un 400", async () => {
    const gj = JSON.stringify({ type: "FeatureCollection", crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32628" } }, features: [] });
    const r = await request(app).post("/api/v2/imports")
      .field("systemeSource", "ONR_BDR").field("format", "geojson").field("methodeSource", "export")
      .field("versionMapping", "v0").field("autorisationRef", "AUT-2026-01")
      .attach("fichier", Buffer.from(gj, "utf8"), "lot.geojson");
    expect(r.status).toBe(201);
    expect(r.body.statut).toBe("REJETE");
    expect(r.body.motifRejetLot).toMatch(/32628.*refuse/);
    expect(r.body.compteurs.lues).toBe(0);
    expect(h.lots).toHaveLength(1);
    expect(h.lignes).toHaveLength(0);
    // Un lot rejete est quand meme un evenement : il est audite.
    expect(h.audits).toHaveLength(1);
  });

  it("un CSV dont aucune ligne n'est conforme donne un lot REJETE, toutes les lignes REJETEES", async () => {
    const r = await envoyer("systeme_source;type_objet;identifiant_source\nONR_BDR;route;X\nONR_BDR;troncon;\n");
    expect(r.status).toBe(201);
    expect(r.body.statut).toBe("REJETE");
    expect(r.body.motifRejetLot).toMatch(/aucune ligne conforme/);
    expect(r.body.compteurs).toEqual({ lues: 2, validees: 0, importees: 0, rejetees: 2, enConflit: 0, ignorees: 0 });
  });

  it("un CSV sans colonne obligatoire rejette le lot en disant laquelle", async () => {
    const r = await envoyer("systeme_source;libelle\nONR_BDR;x\n");
    expect(r.body.statut).toBe("REJETE");
    expect(r.body.motifRejetLot).toMatch(/colonne obligatoire absente.*type_objet/);
  });

  it("refuse la DEMANDE (400) quand un champ manque ou le format n'est pas admis", async () => {
    const sansAutorisation = await request(app).post("/api/v2/imports")
      .field("systemeSource", "ONR_BDR").field("format", "csv").field("methodeSource", "x").field("versionMapping", "v0")
      .attach("fichier", Buffer.from(CSV_OK), "a.csv");
    expect(sansAutorisation.status).toBe(400);
    expect(sansAutorisation.body.details.autorisationRef).toBeDefined();

    const gpkg = await request(app).post("/api/v2/imports")
      .field("systemeSource", "ONR_BDR").field("format", "gpkg").field("methodeSource", "x").field("versionMapping", "v0").field("autorisationRef", "A")
      .attach("fichier", Buffer.from("x"), "a.gpkg");
    expect(gpkg.status).toBe(400);

    const sansFichier = await request(app).post("/api/v2/imports")
      .field("systemeSource", "ONR_BDR").field("format", "csv").field("methodeSource", "x").field("versionMapping", "v0").field("autorisationRef", "A");
    expect(sansFichier.status).toBe(400);
    expect(sansFichier.body.error).toMatch(/fichier manquant/);
    expect(h.lots).toHaveLength(0);
  });

  it("un LECTEUR recoit 403 et rien n'est ecrit", async () => {
    compte.role = "LECTEUR";
    const r = await envoyer(CSV_OK);
    expect(r.status).toBe(403);
    expect(h.lots).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });
});

describe("Consultation et erreurs exportables", () => {
  it("GET /:id rend le lot, GET /:id/erreurs.csv rend les lignes rejetees et ignorees avec motif (T-04)", async () => {
    const r = await envoyer(CSV_OK);
    const lot = await request(app).get(`/api/v2/imports/${r.body.id}`);
    expect(lot.status).toBe(200);
    expect(lot.body.reference).toBe(r.body.reference);

    const err = await request(app).get(`/api/v2/imports/${r.body.id}/erreurs.csv`);
    expect(err.status).toBe(200);
    expect(err.headers["content-type"]).toMatch(/text\/csv/);
    const lignes = err.text.trim().split("\n");
    expect(lignes[0]).toBe("numero_ligne;statut;motif;identifiant_source;charge_originale");
    expect(lignes).toHaveLength(3);
    expect(lignes[1]).toMatch(/^3;REJETEE;identifiant_source manquant/);
    expect(lignes[2]).toMatch(/^4;IGNOREE;doublon dans le lot/);
  });

  it("GET /:id inconnu rend 404", async () => {
    const r = await request(app).get("/api/v2/imports/inconnu");
    expect(r.status).toBe(404);
  });
});

describe("Ce que l'orchestration ne fait pas, et le dit", () => {
  it("n'expose aucune fonction d'application : une promesse dans une API est une dette", async () => {
    const mod = await import("../import/import.service");
    expect(Object.keys(mod).some((k) => /appliquer|apply/i.test(k))).toBe(false);
  });

  it("n'a jamais de ligne IMPORTEE ni de compteur importees non nul a l'etape 1", async () => {
    await envoyer(CSV_OK);
    expect(h.lignes.every((l) => l.statut !== "IMPORTEE")).toBe(true);
    expect(h.lots[0].lignesImportees).toBe(0);
  });
});
