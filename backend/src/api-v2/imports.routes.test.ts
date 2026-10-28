import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHash } from "node:crypto";

/**
 * `/api/v2/imports` -- ce que ces tests defendent.
 *
 *   - l'IMPORTATEUR vient de l'authentification, jamais du corps (mutation B5) ;
 *   - le meme fichier deux fois rend le lot existant SANS AUCUNE ECRITURE (T-06), meme envoye deux
 *     fois EN MEME TEMPS (B2), et un contenu different est un autre lot meme sous le meme nom (B6) ;
 *   - chaque ligne finit dans exactement un statut, et les compteurs se somment (A28) ;
 *   - un fichier illisible ou un CRS refuse donne un lot REJETE enregistre (201), pas un 400 ;
 *   - ce qui n'a pas la forme du format declare, n'est pas de l'UTF-8 ou depasse le plafond de lignes
 *     est refuse (400) AVANT toute ecriture ; une cellule NUL ne fait jamais un 500 ;
 *   - les erreurs sont exportables en CSV avec leur motif, formules neutralisees (T-04) ;
 *   - la liste est filtree et paginee par un curseur stable ; le detail porte etapes et actions ;
 *   - un LECTEUR ou un INSPECTEUR recoit 403 sur TOUTES les routes, et aucune route d'ecriture
 *     n'existe hors POST / ; rien n'est ecrit dans le referentiel, jamais.
 *
 * Le depot Prisma est remplace par une memoire qui imite les filtres et l'unicite de la base : ces
 * tests ne mesurent pas la base, dont les contraintes ont leur propre banc
 * (tests-integration/import.integration.mts et imports-api.integration.mts). Ils mesurent
 * l'orchestration -- ce qu'elle ecrit, dans quel ordre, et ce qu'elle refuse d'ecrire.
 */

const compte = { id: "u-gestionnaire", role: "GESTIONNAIRE" };

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: compte.id, role: compte.role };
    n();
  },
}));

// Un limiteur etroit et rapide a expirer : le 503 se prouve sans attendre quinze secondes.
vi.mock("../import/limiteur", async (original) => {
  const m = await original<typeof import("../import/limiteur")>();
  return { ...m, limiteurReceptions: new m.Limiteur(1, 400) };
});

const h = vi.hoisted(() => ({
  lots: [] as Record<string, unknown>[],
  lignes: [] as Record<string, unknown>[],
  audits: [] as Record<string, unknown>[],
  users: {} as Record<string, { id: string; nomComplet: string }>,
  transactions: 0,
}));

type Cond = Record<string, unknown>;

/** Evalue un `where` Prisma sur un objet : seulement les operateurs que ce routeur emploie. */
function evalWhere(o: Record<string, unknown>, w: Cond | undefined): boolean {
  if (!w) return true;
  return Object.entries(w).every(([k, c]) => {
    if (k === "AND") return (c as Cond[]).every((x) => evalWhere(o, x));
    if (k === "OR") return (c as Cond[]).some((x) => evalWhere(o, x));
    if (k === "NOT") return !evalWhere(o, c as Cond);
    const v = o[k];
    if (c instanceof Date) return v instanceof Date && v.getTime() === c.getTime();
    if (c !== null && typeof c === "object") {
      const op = c as Record<string, unknown>;
      const ci = op.mode === "insensitive";
      const t = (x: unknown) => (ci ? String(x).toLowerCase() : String(x));
      return Object.entries(op).every(([n, x]) => {
        if (n === "mode") return true;
        if (n === "equals") return t(v) === t(x);
        if (n === "contains") return t(v).includes(t(x).replace(/\\([\\%_])/g, "$1"));
        if (n === "startsWith") return t(v).startsWith(t(x));
        if (n === "in") return (x as unknown[]).includes(v);
        if (n === "gte") return (v as Date | number) >= (x as Date | number);
        if (n === "lt") return (v as Date | number) < (x as Date | number);
        if (n === "gt") return (v as Date | number) > (x as Date | number);
        throw new Error(`operateur non simule : ${n}`);
      });
    }
    return v === c;
  });
}

function trier<T extends Record<string, unknown>>(l: T[], orderBy: Cond | Cond[] | undefined): T[] {
  const cles = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).map((o) => Object.entries(o)[0] as [string, "asc" | "desc"]);
  return [...l].sort((a, b) => {
    for (const [k, sens] of cles) {
      const x = a[k] as number | string | Date, y = b[k] as number | string | Date;
      if (x < y) return sens === "asc" ? -1 : 1;
      if (x > y) return sens === "asc" ? 1 : -1;
    }
    return 0;
  });
}

vi.mock("../lib/prisma", () => {
  const avecRelations = (l: Record<string, unknown>) => ({ ...l, importePar: h.users[String(l.importeParId)] ?? null });
  const lotImport = {
    findUnique: async ({ where }: { where: Record<string, unknown> }) => {
      const cle = where.systemeSource_empreinteFichier as { systemeSource: string; empreinteFichier: string } | undefined;
      const lot = cle
        ? h.lots.find((l) => l.systemeSource === cle.systemeSource && l.empreinteFichier === cle.empreinteFichier)
        : h.lots.find((l) => l.id === where.id);
      return lot ? avecRelations(lot) : null;
    },
    findMany: async ({ where, orderBy, take, select }: { where?: Cond; orderBy?: Cond | Cond[]; take?: number; select?: Record<string, unknown> }) =>
      trier(h.lots.filter((l) => evalWhere(l, where)), orderBy).slice(0, take).map(avecRelations)
        // Comme Prisma : `select` ne rend QUE les champs demandes (le BigInt de la taille ne doit pas fuir).
        .map((l) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, (l as Record<string, unknown>)[k]])) : l)),
    count: async ({ where }: { where?: Cond }) => h.lots.filter((l) => evalWhere(l, where)).length,
    groupBy: async () => {
      const m = new Map<string, number>();
      for (const l of h.lots) m.set(String(l.systemeSource), (m.get(String(l.systemeSource)) ?? 0) + 1);
      return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([systemeSource, n]) => ({ systemeSource, _count: { _all: n } }));
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      // L'unicite de la base : (source, empreinte) et reference.
      if (h.lots.some((l) => (l.systemeSource === data.systemeSource && l.empreinteFichier === data.empreinteFichier) || l.reference === data.reference)) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      const lot = { id: `lot-${h.lots.length + 1}`, importeLe: new Date(1_790_000_000_000 + h.lots.length * 1000), ...data };
      h.lots.push(lot);
      return lot;
    },
  };
  const ligneImport = {
    createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
      data.forEach((d, i) => h.lignes.push({ id: `lg-${h.lignes.length + i + 1}`, ...d }));
      return { count: data.length };
    },
    findMany: async ({ where, orderBy, take }: { where?: Cond; orderBy?: Cond | Cond[]; take?: number }) =>
      trier(h.lignes.filter((l) => evalWhere(l, where)), orderBy).slice(0, take),
    count: async ({ where }: { where?: Cond }) => h.lignes.filter((l) => evalWhere(l, where)).length,
  };
  const auditLog = {
    create: async ({ data }: { data: Record<string, unknown> }) => { h.audits.push({ createdAt: new Date(1_790_000_000_000), ...data }); return data; },
    findMany: async ({ where }: { where?: Cond }) =>
      h.audits.filter((a) => evalWhere(a, where)).map((a) => ({ ...a, user: h.users[String(a.userId)] ?? null })),
  };
  const queryRaw = async (_s: TemplateStringsArray, lotId: string) => {
    const cles = new Set<string>();
    for (const l of h.lignes.filter((x) => x.lotId === lotId)) Object.keys(l.chargeOriginale as object).forEach((k) => cles.add(k));
    return [...cles].map((cle) => ({ cle }));
  };
  const prisma = {
    lotImport, ligneImport, auditLog, $queryRaw: queryRaw,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => { h.transactions += 1; return fn({ lotImport, ligneImport, auditLog }); },
  };
  return { prisma };
});

import { importsV2Router } from "./imports.routes";
import { LIMITE_LIGNES } from "../import/import.service";
import { limiteurReceptions } from "../import/limiteur";

const app = express();
app.use("/api/v2/imports", importsV2Router);
// Une erreur inattendue doit se LIRE dans la sortie du test, pas seulement devenir un 500 muet.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { console.error(err); res.status(500).json({ error: "interne" }); });

const ENTETE = "systeme_source;type_objet;identifiant_source;code_route;geometrie";
const CSV_OK = [
  ENTETE,
  'ONR_BDR;troncon;RN1-001;RN1;"{""type"":""LineString"",""coordinates"":[[-13.58,9.64],[-13.57,9.65]]}"',
  'ONR_BDR;troncon;RN1-002;RN1;"{""type"":""LineString"",""coordinates"":[[-13.57,9.65],[-13.56,9.66]]}"',
  "ONR_BDR;troncon;;RN1;",
  'ONR_BDR;troncon;RN1-001;RN1;"{""type"":""LineString"",""coordinates"":[[-13.58,9.64],[-13.57,9.65]]}"',
  "",
].join("\n");

const BASE = { systemeSource: "ONR_BDR", format: "csv", methodeSource: "export L2R", versionMapping: "v0", autorisationRef: "AUT-2026-01" };

/** Envoie un fichier ; `champs` ecrase (ou, a `undefined`, retire) un champ du formulaire. */
function envoyer(contenu: string | Buffer, champs: Record<string, string | undefined> = {}, nom = "lot.csv") {
  const r = request(app).post("/api/v2/imports");
  for (const [k, v] of Object.entries({ ...BASE, ...champs })) if (v !== undefined) r.field(k, v);
  return r.attach("fichier", Buffer.isBuffer(contenu) ? contenu : Buffer.from(contenu, "utf8"), nom);
}

const ligneCsv = (id: string, src = "ONR_BDR", extra = "") => `${src};comptage;${id};RN1;${extra}`;
const csvDe = (lignes: string[]) => `${ENTETE}\n${lignes.join("\n")}\n`;

beforeEach(() => {
  h.lots.length = 0; h.lignes.length = 0; h.audits.length = 0; h.transactions = 0;
  h.users = { "u-gestionnaire": { id: "u-gestionnaire", nomComplet: "Aminata Camara" }, "u-autre": { id: "u-autre", nomComplet: "Autre Agent" } };
  compte.id = "u-gestionnaire"; compte.role = "GESTIONNAIRE";
});

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

  it("la reponse porte les champs additifs du contrat : avertissements, metadonneesDifferentes, memeEmpreinteAutresSources", async () => {
    const r = await envoyer(CSV_OK);
    expect(r.body).toMatchObject({ avertissements: [], metadonneesDifferentes: [], memeEmpreinteAutresSources: [] });
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

  it("MUTATION B5 : un importeParId falsifie dans le corps est ignore, l'importateur reste l'utilisateur authentifie", async () => {
    const r = await envoyer(CSV_OK, { importeParId: "u-autre", importeur: "u-autre" });
    expect(r.status).toBe(201);
    expect(h.lots[0].importeParId).toBe("u-gestionnaire");
    expect(h.audits[0].userId).toBe("u-gestionnaire");
  });

  it("l'empreinte est calculee sur les octets recus, et une reference stable IMP-AAAA-NNNNN est posee", async () => {
    const r = await envoyer(CSV_OK);
    expect(h.lots[0].empreinteFichier).toBe(createHash("sha256").update(Buffer.from(CSV_OK, "utf8")).digest("hex"));
    expect(r.body.reference).toMatch(/^IMP-\d{4}-\d{5}$/);
    expect(h.lots[0].tailleOctets).toBe(BigInt(Buffer.byteLength(CSV_OK, "utf8")));
  });

  it("MUTATION B6 : l'empreinte porte sur TOUS les octets -- deux fichiers de 5 000 octets qui ne different que par le dernier sont deux lots", async () => {
    const base = csvDe([ligneCsv("A1", "ONR_BDR", `${"x".repeat(5000)}`)]);
    const a = await envoyer(`${base}#a`);
    const b = await envoyer(`${base}#b`);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);
    expect(h.lots).toHaveLength(2);
    expect(h.lots[0].empreinteFichier).not.toBe(h.lots[1].empreinteFichier);
  });

  it("meme nom de fichier, contenu different : deux lots", async () => {
    const a = await envoyer(csvDe([ligneCsv("A1")]), {}, "releve.csv");
    const b = await envoyer(csvDe([ligneCsv("A2")]), {}, "releve.csv");
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(h.lots.map((l) => l.nomFichier)).toEqual(["releve.csv", "releve.csv"]);
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

  it("MUTATION B2 : deux envois SIMULTANES du meme fichier donnent un 201 et un 200, un seul lot", async () => {
    const [a, b] = await Promise.all([envoyer(CSV_OK), envoyer(CSV_OK, {}, "copie.csv")]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.id).toBe(b.body.id);
    expect(h.lots).toHaveLength(1);
    expect(h.lignes).toHaveLength(4);
    expect(h.audits).toHaveLength(1);
  });

  it("le meme fichier renvoye avec d'AUTRES metadonnees : 200, les anciennes sont conservees ET dites", async () => {
    await envoyer(CSV_OK);
    const b = await envoyer(CSV_OK, { autorisationRef: "AUT-2026-99", versionMapping: "v2", methodeSource: "saisie manuelle" });
    expect(b.status).toBe(200);
    expect(b.body.metadonneesDifferentes).toEqual([
      { champ: "autorisationRef", recu: "AUT-2026-99", conserve: "AUT-2026-01" },
      { champ: "versionMapping", recu: "v2", conserve: "v0" },
      { champ: "methodeSource", recu: "saisie manuelle", conserve: "export L2R" },
    ]);
    expect(h.lots[0]).toMatchObject({ autorisationRef: "AUT-2026-01", versionMapping: "v0", methodeSource: "export L2R" });
    // Memes metadonnees : rien a dire.
    expect((await envoyer(CSV_OK)).body.metadonneesDifferentes).toEqual([]);
  });

  it("le meme fichier pour une autre source est un autre lot, SIGNALE (memeEmpreinteAutresSources)", async () => {
    const a = await envoyer(CSV_OK);
    const r = await envoyer(CSV_OK, { systemeSource: "ANASUR_COLLECT", autorisationRef: "AUT-2026-02" });
    expect(r.status).toBe(201);
    expect(h.lots).toHaveLength(2);
    expect(r.body.memeEmpreinteAutresSources).toEqual([{ reference: a.body.reference, systemeSource: "ONR_BDR" }]);
  });

  it("une source qui ne differe que par la casse est signalee en avertissement, et la valeur stockee n'est pas modifiee", async () => {
    await envoyer(CSV_OK);
    const r = await envoyer(CSV_OK, { systemeSource: "onr_bdr" });
    expect(r.status).toBe(201);
    expect(h.lots[1].systemeSource).toBe("onr_bdr");
    expect(r.body.avertissements.join(" ")).toMatch(/casse ou les espaces/);
  });

  it("un systeme_source de ligne different de celui du lot est un avertissement, jamais corrige ni bloquant", async () => {
    const r = await envoyer(csvDe([ligneCsv("A1", "ONR_BDR"), ligneCsv("A2", "AUTRE_SYSTEME"), ligneCsv("A3", "AUTRE_SYSTEME")]));
    expect(r.status).toBe(201);
    expect(r.body.statut).toBe("VALIDE_SCHEMA");
    expect(r.body.compteurs.validees).toBe(3);
    expect(r.body.avertissements[0]).toMatch(/2 lignes portent un systeme_source different.*AUTRE_SYSTEME/);
    expect((h.lignes[1].chargeOriginale as Record<string, unknown>).systeme_source).toBe("AUTRE_SYSTEME");
  });

  it("des coordonnees hors du pays sont un AVERTISSEMENT : la ligne reste VALIDEE, rien n'est corrige", async () => {
    const paris = '"{""type"":""Point"",""coordinates"":[2.35,48.85]}"';
    const r = await envoyer(csvDe([`ONR_BDR;ouvrage;P1;RN1;${paris}`]));
    expect(r.body.compteurs.validees).toBe(1);
    expect(r.body.avertissements.join(" ")).toMatch(/hors de l'etendue attendue du pays/);
  });

  it("un CRS refuse rejette le LOT, enregistre avec son motif : c'est un 201, pas un 400", async () => {
    const gj = JSON.stringify({ type: "FeatureCollection", crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32628" } }, features: [] });
    const r = await envoyer(gj, { format: "geojson" }, "lot.geojson");
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

  it("une colonne dupliquee dans l'en-tete rejette le lot (la derniere valeur gagnait en silence)", async () => {
    const r = await envoyer("systeme_source;type_objet;identifiant_source;type_objet\nONR_BDR;comptage;A;troncon\n");
    expect(r.body.statut).toBe("REJETE");
    expect(r.body.motifRejetLot).toMatch(/plusieurs fois.*type_objet/);
  });
});

describe("Refus de la demande (400, rien d'ecrit, code stable)", () => {
  const rien = () => expect([h.lots.length, h.lignes.length, h.audits.length, h.transactions]).toEqual([0, 0, 0, 0]);

  it("un champ manque ou le format n'est pas admis : CHAMPS_INVALIDES", async () => {
    const sansAutorisation = await envoyer(CSV_OK, { autorisationRef: undefined });
    expect(sansAutorisation.status).toBe(400);
    expect(sansAutorisation.body.code).toBe("CHAMPS_INVALIDES");
    expect(sansAutorisation.body.details.autorisationRef).toBeDefined();
    const gpkg = await envoyer("x", { format: "gpkg" }, "a.gpkg");
    expect(gpkg.status).toBe(400);
    expect(gpkg.body.code).toBe("CHAMPS_INVALIDES");
    rien();
  });

  it("FICHIER_MANQUANT", async () => {
    const r = await request(app).post("/api/v2/imports").field("systemeSource", "ONR_BDR").field("format", "csv")
      .field("methodeSource", "x").field("versionMapping", "v0").field("autorisationRef", "AUT-2026-01");
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: "FICHIER_MANQUANT" });
    expect(r.body.error).toMatch(/fichier manquant/);
    rien();
  });

  it("FICHIER_VIDE", async () => {
    const r = await envoyer("");
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("FICHIER_VIDE");
    rien();
  });

  it.each([
    ["x", "trop court"],
    ["n/a", "trop court"],
    ["AUT\n2026", "retour a la ligne"],
    ["AUT-2026\u0000x", "NUL"],
    ["AUT-‮2026", "caractere de direction"],
  ])("autorisationRef %j (%s) est refusee avec le detail du champ", async (ref) => {
    const r = await envoyer(CSV_OK, { autorisationRef: ref });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("CHAMPS_INVALIDES");
    expect(r.body.details.autorisationRef).toBeDefined();
    rien();
  });

  it("un caractere de controle dans la source, la methode ou la version est refuse, jamais un 500", async () => {
    for (const champ of ["systemeSource", "methodeSource", "versionMapping", "auteurSource"]) {
      const r = await envoyer(CSV_OK, { [champ]: "a\u0000b" });
      expect(r.status, champ).toBe(400);
      expect(r.body.details[champ], champ).toBeDefined();
    }
    rien();
  });

  it("une dateSource hors plage (-100000-01-01, +275760-09-13) est refusee, jamais un 500", async () => {
    for (const d of ["-100000-01-01", "+275760-09-13", "1500-01-01"]) {
      const r = await envoyer(CSV_OK, { dateSource: d });
      expect(r.status, d).toBe(400);
      expect(r.body.details.dateSource, d).toBeDefined();
    }
    expect((await envoyer(CSV_OK, { dateSource: "2026-09-15" })).status).toBe(201);
  });

  it("FORMAT_INCOHERENT : un CSV declare geojson, un GeoJSON declare csv, un binaire -- rien n'est enregistre", async () => {
    const csvEnGeojson = await envoyer(CSV_OK, { format: "geojson" });
    expect(csvEnGeojson.status).toBe(400);
    expect(csvEnGeojson.body.code).toBe("FORMAT_INCOHERENT");
    const gj = JSON.stringify({ type: "FeatureCollection", features: [] });
    const geojsonEnCsv = await envoyer(gj, { format: "csv" });
    expect(geojsonEnCsv.status).toBe(400);
    expect(geojsonEnCsv.body.code).toBe("FORMAT_INCOHERENT");
    const binaire = await envoyer(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 1, 2]), { format: "csv" });
    expect(binaire.status).toBe(400);
    expect(binaire.body.code).toBe("FORMAT_INCOHERENT");
    rien();
  });

  it("le piege E1 est ferme : apres le 400, les memes octets avec le BON format donnent un vrai lot", async () => {
    expect((await envoyer(CSV_OK, { format: "geojson" })).status).toBe(400);
    const r = await envoyer(CSV_OK, { format: "csv" });
    expect(r.status).toBe(201);
    expect(r.body.statut).toBe("VALIDE_SCHEMA");
  });

  it("ENCODAGE_NON_UTF8 : un octet Latin-1 n'est jamais remplace en silence ; UTF-16 est nomme ; le BOM UTF-8 passe", async () => {
    const latin1 = Buffer.concat([Buffer.from(`${ENTETE}\nONR_BDR;comptage;E1;RN1;caf`), Buffer.from([0xe9]), Buffer.from("\n")]);
    const r = await envoyer(latin1);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("ENCODAGE_NON_UTF8");
    expect(r.body.error).toMatch(/reenregistrez le fichier en UTF-8.*position/);
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(CSV_OK, "utf16le")]);
    const r16 = await envoyer(utf16);
    expect(r16.status).toBe(400);
    expect(r16.body.code).toBe("ENCODAGE_NON_UTF8");
    expect(r16.body.error).toMatch(/UTF-16/);
    rien();
    const bom = await envoyer(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(CSV_OK, "utf8")]));
    expect(bom.status).toBe(201);
    expect(bom.body.compteurs.validees).toBe(2);
  });

  it("TROP_DE_LIGNES : un de plus que le plafond est refuse sans rien ecrire ; le plafond exact passe", async () => {
    const lignes = (n: number) => Array.from({ length: n }, (_, i) => ligneCsv(`L${i}`));
    const trop = await envoyer(csvDe(lignes(LIMITE_LIGNES + 1)));
    expect(trop.status).toBe(400);
    expect(trop.body.code).toBe("TROP_DE_LIGNES");
    const geo = { type: "FeatureCollection", features: Array.from({ length: LIMITE_LIGNES + 1 }, () => null) };
    const tropGeo = await envoyer(JSON.stringify(geo), { format: "geojson" }, "n.geojson");
    expect(tropGeo.status).toBe(400);
    expect(tropGeo.body.code).toBe("TROP_DE_LIGNES");
    rien();
    const exact = await envoyer(csvDe(lignes(LIMITE_LIGNES)));
    expect(exact.status).toBe(201);
    expect(exact.body.compteurs.lues).toBe(LIMITE_LIGNES);
    expect(h.lignes).toHaveLength(LIMITE_LIGNES);
  }, 30_000);

  it("TELEVERSEMENT_INVALIDE : un corps multipart tronque", async () => {
    const r = await request(app).post("/api/v2/imports").set("Content-Type", "multipart/form-data; boundary=zzz")
      .send("--zzz\r\nContent-Disposition: form-data; name=\"systemeSource\"\r\n\r\nONR");
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("TELEVERSEMENT_INVALIDE");
  });
});

describe("Une cellule NUL ou un contenu non enregistrable ne fait jamais un 500", () => {
  it("un NUL dans une cellule rejette la LIGNE avec son motif ; la charge conservee n'en contient plus", async () => {
    const r = await envoyer(csvDe([ligneCsv("A1"), ligneCsv("A2", "ONR_BDR", "avant\u0000apres")]));
    expect(r.status).toBe(201);
    expect(r.body.compteurs).toMatchObject({ lues: 2, validees: 1, rejetees: 1 });
    expect(h.lignes[1].statut).toBe("REJETEE");
    expect(h.lignes[1].motifRejet).toMatch(/NUL.*non enregistrable/);
    expect(JSON.stringify(h.lignes[1].chargeOriginale)).not.toContain("\\u0000");
    expect(JSON.stringify(h.lignes[1].chargeOriginale)).toContain("␀");
  });

  it("un NUL dans un identifiant ou le systeme_source d'une ligne GeoJSON : ligne rejetee, jamais 500", async () => {
    const gj = { type: "FeatureCollection", features: [
      { type: "Feature", geometry: null, properties: { systeme_source: "ONR_BDR", type_objet: "comptage", identifiant_source: "A\u0000B" } },
      { type: "Feature", geometry: null, properties: { systeme_source: "ONR\u0000", type_objet: "comptage", identifiant_source: "C" } },
      { type: "Feature", geometry: null, properties: { systeme_source: "ONR_BDR", type_objet: "comptage", identifiant_source: "D" } },
    ] };
    const r = await envoyer(JSON.stringify(gj), { format: "geojson" }, "a.geojson");
    expect(r.status).toBe(201);
    expect(h.lignes.map((l) => l.statut)).toEqual(["REJETEE", "REJETEE", "VALIDEE"]);
  });

  it("un substitut UTF-16 isole (\\ud800) dans un GeoJSON : ligne rejetee", async () => {
    const brut = '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":null,"properties":{"systeme_source":"ONR_BDR","type_objet":"comptage","identifiant_source":"S1","note":"\\ud800"}}]}';
    const r = await envoyer(brut, { format: "geojson" }, "s.geojson");
    expect(r.status).toBe(201);
    expect(h.lignes[0].statut).toBe("REJETEE");
    expect(h.lignes[0].motifRejet).toMatch(/substitut/);
  });

  it("une propriete GeoJSON tres profonde est tronquee et la ligne rejetee : pas de RangeError", async () => {
    let profond: unknown = "fond";
    for (let i = 0; i < 3000; i += 1) profond = [profond];
    const gj = { type: "FeatureCollection", features: [{ type: "Feature", geometry: null, properties: { systeme_source: "ONR_BDR", type_objet: "comptage", identifiant_source: "P1", cache: profond }, }] };
    const r = await envoyer(JSON.stringify(gj), { format: "geojson" }, "p.geojson");
    expect(r.status).toBe(201);
    expect(h.lignes[0].statut).toBe("REJETEE");
    expect(h.lignes[0].motifRejet).toMatch(/imbriquee/);
  });

  it("un NUL dans l'en-tete CSV rejette le lot avec son motif", async () => {
    const r = await envoyer("systeme_source;type_objet;identifiant_source;co\u0000l\nONR_BDR;comptage;A;x\n");
    expect(r.status).toBe(201);
    expect(r.body.statut).toBe("REJETE");
    expect(r.body.motifRejetLot).toMatch(/en-tete/);
  });

  it("un motif ne recopie qu'un extrait de la valeur fautive (amplification par echo)", async () => {
    const enorme = "z".repeat(200_000);
    const r = await envoyer(csvDe([`ONR_BDR;${enorme};I1;RN1;`]));
    expect(r.status).toBe(201);
    expect(String(h.lignes[0].motifRejet).length).toBeLessThan(400);
    expect(h.lignes[0].motifRejet).toMatch(/200000 caracteres/);
    expect((h.lignes[0].chargeOriginale as Record<string, string>).type_objet).toHaveLength(200_000);
  });
});

describe("Nom de fichier : affichable, jamais un chemin", () => {
  it("un nom accentue arrive intact (multer decodait en latin1)", async () => {
    await envoyer(CSV_OK, {}, "relevé-été.csv");
    expect(h.lots[0].nomFichier).toBe("relevé-été.csv");
  });

  it("separateurs de chemin, caracteres de controle et retours a la ligne sont retires", async () => {
    await envoyer(CSV_OK, {}, '../../etc/passwd"\r\nX-Evil: 1.csv');
    expect(h.lots[0].nomFichier).not.toMatch(/[\r\n/\\]/);
    expect(h.lots[0].nomFichier).toMatch(/^passwd.*X-Evil: 1.csv$/);
    expect(h.lots[0].nomFichier).not.toContain("etc");
  });

  it("un nom de 100 000 caracteres est borne a 255", async () => {
    const r = await envoyer(csvDe([ligneCsv("N1")]), {}, `${"n".repeat(100_000)}.csv`).catch((e: unknown) => e);
    // Le client HTTP ou multer peut refuser un en-tete aussi long : ce qui compte est qu'aucun 500 n'en sorte.
    if ((r as { status?: number }).status === 201) expect(String(h.lots[0].nomFichier).length).toBeLessThanOrEqual(255);
    else expect([400, undefined]).toContain((r as { status?: number }).status);
  });
});

describe("Consultation : liste, meta, sources", () => {
  async function remplir() {
    // Trois sources, cinq lots, des statuts differents.
    await envoyer(csvDe([ligneCsv("A1")]), {}, "alpha.csv");
    await envoyer(csvDe([ligneCsv("A2")]), {}, "Beta-Releve.csv");
    await envoyer("systeme_source;type_objet;identifiant_source\nONR_BDR;route;X\n", {}, "rejet.csv");
    await envoyer(csvDe([ligneCsv("B1", "ANASUR_COLLECT")]), { systemeSource: "ANASUR_COLLECT", autorisationRef: "AUT-2026-02" }, "gamma.csv");
    await envoyer(csvDe([ligneCsv("C1", "onr_bdr")]), { systemeSource: "onr_bdr" }, "delta.csv");
  }

  it("GET /meta annonce formats, plafonds et statuts", async () => {
    const r = await request(app).get("/api/v2/imports/meta");
    expect(r.status).toBe(200);
    expect(r.body.formats.map((f: { code: string }) => f.code)).toEqual(["csv", "geojson"]);
    expect(r.body.formats.every((f: { libelle: string; aide: string }) => f.libelle && f.aide)).toBe(true);
    expect(r.body.tailleMaxOctets).toBe(25 * 1024 * 1024);
    expect(r.body.limiteLignes).toBe(LIMITE_LIGNES);
    expect(r.body.statuts).toEqual(["RECU", "VALIDE_SCHEMA", "IMPORTE_TEST", "IMPORTE", "REJETE"]);
  });

  it("GET /sources rend les valeurs distinctes deja recues, avec leur nombre de lots", async () => {
    await remplir();
    const r = await request(app).get("/api/v2/imports/sources");
    expect(r.body.sources).toEqual([
      { valeur: "ANASUR_COLLECT", nombreLots: 1 }, { valeur: "ONR_BDR", nombreLots: 3 }, { valeur: "onr_bdr", nombreLots: 1 },
    ]);
  });

  it("GET / rend les lots du plus recent au plus ancien, avec importePar nominatif et les champs du contrat", async () => {
    await remplir();
    const r = await request(app).get("/api/v2/imports");
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(5);
    expect(r.body.suivant).toBeNull();
    expect(r.body.lots.map((l: { nomFichier: string }) => l.nomFichier)).toEqual(["delta.csv", "gamma.csv", "rejet.csv", "Beta-Releve.csv", "alpha.csv"]);
    const l = r.body.lots[0];
    expect(Object.keys(l).sort()).toEqual([
      "autorisationRef", "format", "id", "importeLe", "importePar", "lignesEnConflit", "lignesIgnorees", "lignesImportees", "lignesLues",
      "lignesRejetees", "lignesValidees", "motifRejetLot", "nomFichier", "reference", "statut", "systemeSource", "tailleOctets", "versionMapping",
    ].sort());
    expect(l.importePar).toEqual({ id: "u-gestionnaire", nomComplet: "Aminata Camara" });
    expect(typeof l.tailleOctets).toBe("string");
    expect(r.body.lots[2].motifRejetLot).toMatch(/aucune ligne conforme/);
    expect(r.body.lots[0].motifRejetLot).toBeNull();
  });

  it("MUTATION filtre ignore : chaque filtre reduit reellement la liste et le total", async () => {
    await remplir();
    const get = async (q: string) => (await request(app).get(`/api/v2/imports?${q}`)).body;
    expect((await get("statut=REJETE")).total).toBe(1);
    expect((await get("statut=REJETE")).lots).toHaveLength(1);
    expect((await get("statut=IMPORTE")).total).toBe(0);
    // La source est comparee sans tenir compte de la casse dans le FILTRE (pas dans le stockage).
    expect((await get("source=ONR_BDR")).total).toBe(4);
    expect((await get("source=anasur_collect")).total).toBe(1);
    expect((await get("q=BETA")).lots.map((l: { nomFichier: string }) => l.nomFichier)).toEqual(["Beta-Releve.csv"]);
    expect((await get("q=anasur")).total).toBe(1);
    const toutes = await get("q=imp-");
    expect(toutes.total).toBe(5);
    expect((await get("statut=VALIDE_SCHEMA&source=ONR_BDR")).total).toBe(3);
  });

  it("du / au : jour entier inclusif pour une date seule, instant pour une date-heure", async () => {
    await remplir();   // importeLe : 2026-09-21T... + 1 s par lot (voir le depot simule)
    const premier = new Date(1_790_000_000_000);
    const jour = premier.toISOString().slice(0, 10);
    const apres = new Date(premier.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
    expect((await request(app).get(`/api/v2/imports?du=${jour}&au=${jour}`)).body.total).toBe(5);
    expect((await request(app).get(`/api/v2/imports?du=${apres}`)).body.total).toBe(0);
    const t2 = new Date(premier.getTime() + 2000).toISOString();
    expect((await request(app).get(`/api/v2/imports?du=${t2}`)).body.total).toBe(3);
    expect((await request(app).get(`/api/v2/imports?au=${t2}`)).body.total).toBe(3);
    expect((await request(app).get(`/api/v2/imports?au=${new Date(premier.getTime() + 1999).toISOString()}`)).body.total).toBe(2);
  });

  it("pagination par curseur : pages disjointes, ordre stable, total constant, meme apres un lot concurrent", async () => {
    await remplir();
    const p1 = (await request(app).get("/api/v2/imports?limite=2")).body;
    expect(p1.lots).toHaveLength(2);
    expect(p1.total).toBe(5);
    expect(typeof p1.suivant).toBe("string");
    // Un lot arrive entre les deux pages : il est le plus recent, il ne decale pas la suite.
    await envoyer(csvDe([ligneCsv("Z9")]), {}, "arrive-entre-deux.csv");
    const p2 = (await request(app).get(`/api/v2/imports?limite=2&curseur=${p1.suivant}`)).body;
    const p3 = (await request(app).get(`/api/v2/imports?limite=2&curseur=${p2.suivant}`)).body;
    const ids = [...p1.lots, ...p2.lots, ...p3.lots].map((l: { id: string }) => l.id);
    expect(new Set(ids).size).toBe(5);
    expect(ids).toHaveLength(5);
    expect(p3.suivant).toBeNull();
    expect(p2.total).toBe(6);
    expect(p2.lots.map((l: { nomFichier: string }) => l.nomFichier)).toEqual(["rejet.csv", "Beta-Releve.csv"]);
  });

  it.each([
    ["curseur=n-importe-quoi!", "CURSEUR_INVALIDE"],
    [`curseur=${Buffer.from("{}").toString("base64url")}`, "CURSEUR_INVALIDE"],
    [`curseur=${Buffer.from(JSON.stringify({ t: "demain", i: "x" })).toString("base64url")}`, "CURSEUR_INVALIDE"],
    ["limite=0", "PARAMETRES_INVALIDES"],
    ["limite=101", "PARAMETRES_INVALIDES"],
    ["limite=abc", "PARAMETRES_INVALIDES"],
    ["statut=INCONNU", "PARAMETRES_INVALIDES"],
    ["du=hier", "PARAMETRES_INVALIDES"],
    ["au=2026-02-30", "PARAMETRES_INVALIDES"],
    ["inconnu=1", "PARAMETRES_INVALIDES"],
    ["statut=RECU&statut=REJETE", "PARAMETRES_INVALIDES"],
  ])("la requete %s est refusee en 400 %s", async (qs, code) => {
    const r = await request(app).get(`/api/v2/imports?${qs}`);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe(code);
  });

  it("un parametre vide est ignore (formulaire de filtres non rempli)", async () => {
    await remplir();
    const r = await request(app).get("/api/v2/imports?statut=&source=&q=&du=&au=&curseur=&limite=");
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(5);
  });
});

describe("Detail d'un lot : etapes, actions, controle, historique", () => {
  it("un lot VALIDE_SCHEMA avec rejets : controle terminee avec reserves, echantillon et import NON_DISPONIBLES avec leur raison", async () => {
    const lot = (await envoyer(CSV_OK)).body;
    const r = await request(app).get(`/api/v2/imports/${lot.id}`);
    expect(r.status).toBe(200);
    // Compatibilite : les champs d'avant sont toujours la.
    expect(r.body).toMatchObject({ id: lot.id, reference: lot.reference, systemeSource: "ONR_BDR", statut: "VALIDE_SCHEMA", format: "csv", lignesLues: 4 });
    expect(r.body.tailleOctets).toBe(String(Buffer.byteLength(CSV_OK)));
    expect(r.body.importePar).toEqual({ id: "u-gestionnaire", nomComplet: "Aminata Camara" });
    expect(r.body.empreinte).toEqual({ algorithme: "sha256", valeur: createHash("sha256").update(CSV_OK).digest("hex") });
    expect(r.body.etapes.map((e: { id: string; etat: string }) => [e.id, e.etat])).toEqual([
      ["reception", "TERMINEE"], ["controle_schema", "TERMINEE_AVEC_RESERVES"], ["echantillon", "NON_DISPONIBLE"], ["import_autorise", "NON_DISPONIBLE"],
    ]);
    expect(r.body.etapes[2].raison).toMatch(/decision DSI requise/);
    expect(r.body.etapes[3].raison).toMatch(/rien n'a ete cree/);
    expect(r.body.actionsPermises).toEqual([
      { code: "TELECHARGER_ERREURS", permise: true, raison: null },
      { code: "VOIR_APERCU", permise: true, raison: null },
    ]);
    expect(r.body.controle).toMatchObject({
      motifRejetLot: null,
      compteurs: { lues: 4, validees: 2, rejetees: 1, enConflit: 0, ignorees: 1, importees: 0 },
      colonnes: { reconnues: ["systeme_source", "type_objet", "identifiant_source", "code_route", "geometrie"], inconnues: [] },
      avertissements: [],
    });
    expect(r.body.controle.premiersRejets).toEqual([
      expect.objectContaining({ numeroLigne: 3, statut: "REJETEE" }), expect.objectContaining({ numeroLigne: 4, statut: "IGNOREE" }),
    ]);
    expect(r.body.historique).toEqual([
      { date: expect.any(String), action: "CREATE", acteur: "Aminata Camara", details: expect.stringMatching(/^Lot IMP-\d{4}-\d{5} enregistre : statut VALIDE_SCHEMA, 4 lignes lues\.$/) },
    ]);
    // Aucun contenu de fichier ni adresse dans l'historique.
    expect(JSON.stringify(r.body.historique)).not.toMatch(/RN1-001|empreinte|ipAddress/);
  });

  it("colonnes inconnues = cles de la charge moins le pivot ; _ligne_brute n'en est pas une", async () => {
    const r1 = await envoyer(`${ENTETE};zone;aaa\nONR_BDR;comptage;A;RN1;;N;1\nONR_BDR;comptage;B;RN1;;trop\n`);
    const r = await request(app).get(`/api/v2/imports/${r1.body.id}`);
    expect(r.body.controle.colonnes.inconnues).toEqual(["aaa", "zone"]);
  });

  it("un lot REJETE : controle ECHEC avec son motif, echantillon et import NON_COMMENCEES, apercu et erreurs selon les lignes", async () => {
    const lot = (await envoyer("systeme_source;libelle\nONR_BDR;x\n")).body;
    const r = await request(app).get(`/api/v2/imports/${lot.id}`);
    expect(r.body.etapes.map((e: { etat: string }) => e.etat)).toEqual(["TERMINEE", "ECHEC", "NON_COMMENCEE", "NON_COMMENCEE"]);
    expect(r.body.etapes[1].raison).toMatch(/colonne obligatoire absente/);
    expect(r.body.controle.colonnes).toBeNull();
    expect(r.body.actionsPermises.every((a: { permise: boolean; raison: string | null }) => !a.permise && a.raison)).toBe(true);
  });

  it("un lot sans rejet : controle TERMINEE, pas de telechargement d'erreurs", async () => {
    const lot = (await envoyer(csvDe([ligneCsv("A1"), ligneCsv("A2")]))).body;
    const r = await request(app).get(`/api/v2/imports/${lot.id}`);
    expect(r.body.etapes[1].etat).toBe("TERMINEE");
    expect(r.body.actionsPermises[0]).toMatchObject({ code: "TELECHARGER_ERREURS", permise: false });
    expect(r.body.actionsPermises[0].raison).toMatch(/rien a telecharger/);
  });

  it("GET /:id inconnu ou id demesure rend 404", async () => {
    expect((await request(app).get("/api/v2/imports/inconnu")).status).toBe(404);
    expect((await request(app).get(`/api/v2/imports/${"x".repeat(500)}`)).status).toBe(404);
    expect((await request(app).get("/api/v2/imports/inconnu/apercu")).status).toBe(404);
    expect((await request(app).get("/api/v2/imports/inconnu/erreurs.csv")).status).toBe(404);
  });
});

describe("Apercu : borne, tronque, rendu tel quel", () => {
  async function lotAvec(lignes: string[]) {
    return (await envoyer(csvDe(lignes))).body;
  }

  it("rend les lignes avec leur statut, motif et charge ; <script> est rendu TEL QUEL (c'est au client d'echapper)", async () => {
    const lot = (await envoyer(`${ENTETE};note\n${ligneCsv("A1", "ONR_BDR", ";<script>alert(1)</script>")}\n${ligneCsv("A2", "ONR_BDR", ";ok")}\nONR_BDR;route;X;RN1;;x\n`)).body;
    const r = await request(app).get(`/api/v2/imports/${lot.id}/apercu`);
    expect(r.status).toBe(200);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-type"]).toMatch(/application\/json/);
    expect(r.body.lignes).toHaveLength(3);
    expect(r.body.lignes[0]).toMatchObject({ numeroLigne: 1, statut: "VALIDEE", motifRejet: null, identifiantSource: "A1" });
    expect(r.body.lignes[0].charge.note).toBe("<script>alert(1)</script>");
    expect(r.text).toContain("<script>alert(1)</script>");
    expect(r.body.lignes[2]).toMatchObject({ statut: "REJETEE", identifiantSource: null });
    expect(r.body.lignes[2].motifRejet).toMatch(/type_objet/);
    expect(r.body.suivant).toBeNull();
    expect(r.body.tronque).toBe(false);
  });

  it("MUTATION apercu non borne : limite max 50, 51 est refuse ; pagination par numero de ligne", async () => {
    const lot = await lotAvec(Array.from({ length: 60 }, (_, i) => ligneCsv(`L${i}`)));
    expect((await request(app).get(`/api/v2/imports/${lot.id}/apercu?limite=51`)).status).toBe(400);
    expect((await request(app).get(`/api/v2/imports/${lot.id}/apercu?limite=0`)).status).toBe(400);
    const defaut = (await request(app).get(`/api/v2/imports/${lot.id}/apercu`)).body;
    expect(defaut.lignes).toHaveLength(20);
    expect(defaut.suivant).toBe(20);
    const max = (await request(app).get(`/api/v2/imports/${lot.id}/apercu?limite=50`)).body;
    expect(max.lignes).toHaveLength(50);
    const suite = (await request(app).get(`/api/v2/imports/${lot.id}/apercu?limite=50&apres=${max.suivant}`)).body;
    expect(suite.lignes.map((l: { numeroLigne: number }) => l.numeroLigne)).toEqual(Array.from({ length: 10 }, (_, i) => 51 + i));
    expect(suite.suivant).toBeNull();
  });

  it("filtre par statut", async () => {
    const lot = await lotAvec([ligneCsv("A1"), `ONR_BDR;route;X;RN1;`, ligneCsv("A1")]);
    const r = await request(app).get(`/api/v2/imports/${lot.id}/apercu?statut=REJETEE`);
    expect(r.body.lignes.map((l: { numeroLigne: number }) => l.numeroLigne)).toEqual([2]);
    const i = await request(app).get(`/api/v2/imports/${lot.id}/apercu?statut=IGNOREE`);
    expect(i.body.lignes.map((l: { numeroLigne: number }) => l.numeroLigne)).toEqual([3]);
    expect((await request(app).get(`/api/v2/imports/${lot.id}/apercu?statut=IMPORTEE`)).status).toBe(400);
  });

  it("valeurs tronquees a 200 caracteres, colonnes plafonnees a 40, et `tronque` le dit", async () => {
    const colonnes = Array.from({ length: 45 }, (_, i) => `c${i}`);
    const entete = ["systeme_source", "type_objet", "identifiant_source", ...colonnes].join(";");
    const ligne = ["ONR_BDR", "comptage", "T1", ...colonnes.map((_, i) => (i === 0 ? "y".repeat(500) : "v"))].join(";");
    const lot = (await envoyer(`${entete}\n${ligne}\n`)).body;
    const r = (await request(app).get(`/api/v2/imports/${lot.id}/apercu`)).body;
    expect(Object.keys(r.lignes[0].charge)).toHaveLength(40);
    expect(r.lignes[0].charge.c0).toHaveLength(200);
    expect(r.tronque).toBe(true);
  });
});

describe("Erreurs exportables (T-04)", () => {
  it("rend les lignes rejetees et ignorees avec motif", async () => {
    const r0 = await envoyer(CSV_OK);
    const err = await request(app).get(`/api/v2/imports/${r0.body.id}/erreurs.csv`);
    expect(err.status).toBe(200);
    expect(err.headers["content-type"]).toMatch(/text\/csv/);
    expect(err.headers["x-lignes-en-erreur"]).toBe("2");
    const lignes = err.text.trim().split("\n");
    expect(lignes[0]).toBe("numero_ligne;statut;motif;identifiant_source;charge_originale");
    expect(lignes).toHaveLength(3);
    expect(lignes[1]).toMatch(/^3;REJETEE;identifiant_source manquant/);
    expect(lignes[2]).toMatch(/^4;IGNOREE;doublon dans le lot/);
  });

  it("neutralise les formules : toute cellule texte qui commence par = + - @ est precedee d'une apostrophe, colonnes intactes", async () => {
    const dangereux = ["=HYPERLINK(\"http://x\",\"a\")", "+cmd|' /C calc'!A0", "-2+3+cmd", "@SUM(1+1)", "=1+1"];
    // Chaque identifiant dangereux apparait deux fois : la seconde ligne est IGNOREE et exportee.
    const lignes = dangereux.flatMap((d) => [`ONR_BDR;comptage;"${d.replace(/"/g, '""')}";RN1;`, `ONR_BDR;comptage;"${d.replace(/"/g, '""')}";RN1;`]);
    const lot = (await envoyer(csvDe(lignes))).body;
    const err = await request(app).get(`/api/v2/imports/${lot.id}/erreurs.csv`);
    const { lireCsv } = await import("../import/pivot.noyau");
    const relu = lireCsv(err.text);
    expect(relu.lignes).toHaveLength(5);
    for (const l of relu.lignes) {
      expect(l.identifiant_source).toMatch(/^'[=+\-@]/);
      expect(l.statut).toBe("IGNOREE");
      expect(Object.keys(l)).toEqual(["numero_ligne", "statut", "motif", "identifiant_source", "charge_originale"]);
    }
    // Aucune cellule du fichier ne commence par un declencheur de formule.
    for (const l of relu.lignes) for (const v of Object.values(l)) expect(v).not.toMatch(/^[=+\-@]/);
  });
});

describe("Aucune route de ce routeur n'ecrit dans le referentiel, et seuls ADMIN et GESTIONNAIRE y entrent", () => {
  type Couche = { route?: { path: string; methods: Record<string, boolean> } };
  const routes = (importsV2Router.stack as unknown as Couche[]).filter((c) => c.route)
    .flatMap((c) => Object.keys(c.route!.methods).map((m) => ({ methode: m.toUpperCase(), chemin: c.route!.path })));

  it("le parcours de router.stack trouve les routes attendues, et aucune d'ecriture hors POST /", () => {
    expect(routes.length).toBeGreaterThanOrEqual(7);
    const ecritures = routes.filter((r) => r.methode !== "GET");
    expect(ecritures).toEqual([{ methode: "POST", chemin: "/" }]);
    // /meta et /sources avant /:id.
    const ordre = routes.filter((r) => r.methode === "GET").map((r) => r.chemin);
    expect(ordre.indexOf("/meta")).toBeLessThan(ordre.indexOf("/:id"));
    expect(ordre.indexOf("/sources")).toBeLessThan(ordre.indexOf("/:id"));
  });

  it.each(["LECTEUR", "INSPECTEUR", "ADMINISTRATEUR_INCONNU"])("MUTATION garde de role retiree : %s recoit 403 sur TOUTES les routes", async (role) => {
    compte.role = role;
    const lot = (await (async () => { compte.role = "GESTIONNAIRE"; const r = await envoyer(CSV_OK); compte.role = role; return r; })()).body;
    for (const r of routes) {
      const chemin = `/api/v2/imports${r.chemin.replace(":id", lot.id)}`;
      const rep = r.methode === "GET" ? await request(app).get(chemin) : await request(app).post(chemin);
      expect(rep.status, `${r.methode} ${r.chemin}`).toBe(403);
    }
    expect(h.lots).toHaveLength(1);
  });

  it("un ADMIN a les memes droits qu'un GESTIONNAIRE", async () => {
    compte.role = "ADMIN";
    expect((await envoyer(CSV_OK)).status).toBe(201);
    expect((await request(app).get("/api/v2/imports")).status).toBe(200);
  });
});

describe("Service occupe : 503 + Retry-After, aucun lot cree", () => {
  it("quand la place n'arrive pas dans le delai, la reponse est un 503 SERVICE_OCCUPE", async () => {
    let liberer!: () => void;
    const occupe = limiteurReceptions.executer(() => new Promise<void>((r) => { liberer = r; }));
    try {
      const r = await envoyer(csvDe([ligneCsv("A1")]));
      expect(r.status).toBe(503);
      expect(r.body.code).toBe("SERVICE_OCCUPE");
      expect(r.headers["retry-after"]).toBe("10");
      expect(h.lots).toHaveLength(0);
      expect(h.audits).toHaveLength(0);
    } finally { liberer(); await occupe; }
    // Une fois la place rendue, l'envoi aboutit.
    expect((await envoyer(csvDe([ligneCsv("A1")]))).status).toBe(201);
  });

  it("un fichier deja recu est rendu meme quand le service est occupe (la relecture ne prend pas de place)", async () => {
    await envoyer(csvDe([ligneCsv("A1")]));
    let liberer!: () => void;
    const occupe = limiteurReceptions.executer(() => new Promise<void>((r) => { liberer = r; }));
    try {
      const r = await envoyer(csvDe([ligneCsv("A1")]));
      expect(r.status).toBe(200);
    } finally { liberer(); await occupe; }
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
