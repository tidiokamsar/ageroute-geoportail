import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SONDAGE (lot V2) contre une base SIMULEE en memoire et un spool REEL sur disque : garde de delai d'un tour (M1), erreur transitoire qui laisse le job
 * EN_COURS (M3), copie dans entree/ a la reclamation seulement et purge du prive (M2), rotation des purges en echec (m1), relance avec purge sure (m7),
 * audit de la reclamation (m8). Le banc PostGIS `gdal-jobs.integration.mts` eprouve les memes chemins contre la vraie base et le vrai conteneur.
 */

type Job = Record<string, unknown> & { id: string; statut: string; updatedAt: Date; purgeLe: Date | null };

const h = vi.hoisted(() => {
  const etat = { jobs: [] as Job[], audits: [] as Record<string, unknown>[], crochets: {} as Record<string, ((...a: unknown[]) => unknown) | undefined> };
  type Job = Record<string, unknown> & { id: string; statut: string; updatedAt: Date; purgeLe: Date | null };
  const correspond = (j: Job, where: Record<string, unknown>): boolean => {
    for (const [k, v] of Object.entries(where)) {
      if (k === "OR") { if (!(v as Record<string, unknown>[]).some((w) => correspond(j, w))) return false; continue; }
      const val = j[k];
      if (v === null) { if (val !== null) return false; continue; }
      if (typeof v === "object" && !(v instanceof Date)) {
        const o = v as Record<string, unknown>;
        if ("in" in o && !(o.in as unknown[]).includes(val)) return false;
        if ("not" in o && (o.not === null ? val === null : val === o.not)) return false;
        if ("lte" in o && !((val as Date) <= (o.lte as Date))) return false;
        if ("gt" in o && !((val as Date) > (o.gt as Date))) return false;
        continue;
      }
      if (val !== v) return false;
    }
    return true;
  };
  const trier = (liste: Job[], orderBy?: Record<string, string>): Job[] => {
    if (!orderBy) return liste;
    const [k, sens] = Object.entries(orderBy)[0];
    return [...liste].sort((a, b) => {
      const x = a[k] as number | Date | null, y = b[k] as number | Date | null;
      const d = (x === null ? -Infinity : Number(x)) - (y === null ? -Infinity : Number(y));
      return sens === "asc" ? d : -d;
    });
  };
  const modele = {
    findMany: async (a: { where: Record<string, unknown>; orderBy?: Record<string, string>; take?: number }) => trier(etat.jobs.filter((j) => correspond(j, a.where)), a.orderBy).slice(0, a.take ?? 1000).map((j) => ({ ...j })),
    findFirst: async (a: { where: Record<string, unknown> }) => { const j = etat.jobs.find((x) => correspond(x, a.where)); return j ? { ...j } : null; },
    findUnique: async (a: { where: { id: string } }) => { const j = etat.jobs.find((x) => x.id === a.where.id); return j ? { ...j } : null; },
    count: async (a: { where: Record<string, unknown> }) => etat.jobs.filter((j) => correspond(j, a.where)).length,
    updateMany: async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let n = 0;
      for (const j of etat.jobs) if (correspond(j, a.where)) { Object.assign(j, a.data); n++; }
      return { count: n };
    },
  };
  // Seule requete SQL brute du sondage : la reclamation du plus ancien EN_ATTENTE (valeur interpolee : l'instant).
  const queryRaw = async (_s: TemplateStringsArray, ...v: unknown[]) => {
    const maintenant = v[0] as Date;
    const c = trier(etat.jobs.filter((j) => j.statut === "EN_ATTENTE" && (j.expireLe as Date) > maintenant && (j.tentatives as number) < (j.tentativesMax as number)), { createdAt: "asc" })[0];
    if (!c) return [];
    Object.assign(c, { statut: "EN_COURS", tentatives: (c.tentatives as number) + 1, reclameLe: maintenant, etape: "transmis", progression: 5, updatedAt: maintenant });
    return [{ id: c.id, tentatives: c.tentatives }];
  };
  const tx = { jobImportProjet: modele, auditLog: { create: async (a: { data: Record<string, unknown> }) => { etat.audits.push(a.data); return a.data; } }, $queryRaw: queryRaw };
  const prisma = { ...tx, $transaction: async (f: (t: typeof tx) => unknown) => f(tx) };
  return { etat, prisma };
});

vi.mock("../../lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("./spool", async (importOriginal) => {
  const m = await importOriginal<typeof import("./spool")>();
  const crochet = <K extends keyof typeof m>(nom: K) => ((...a: unknown[]) => (h.etat.crochets[nom as string] ? h.etat.crochets[nom as string]!(...a) : (m[nom] as (...x: unknown[]) => unknown)(...a))) as typeof m[K];
  return { ...m, lireStatutSpool: crochet("lireStatutSpool"), lireResultatBrut: crochet("lireResultatBrut"), purger: crochet("purger") };
});

import { traiterUnTour } from "./traiteur";
import { spoolIdDe } from "./contrat.noyau";

const racine = mkdtempSync(path.join(tmpdir(), "v2-traiteur-"));
const JOB = "123e4567-e89b-42d3-a456-426614174000";
const JOB2 = "223e4567-e89b-42d3-a456-426614174000";
const T0 = new Date("2026-11-08T10:00:00Z");
const statutDe = (spoolId: string, statut: "en_cours" | "termine" | "echec", code: string | null = null) =>
  JSON.stringify({ jobId: spoolId, statut, etape: statut === "en_cours" ? "conversion" : statut, code, message: null, debut: "2026-11-08T10:00:00Z", fin: statut === "en_cours" ? null : "2026-11-08T10:00:05Z", versionWorker: "0.2.0", versionContrat: 1 });

function job(id: string, over: Partial<Job> = {}): Job {
  return {
    id, projetId: "p1", creeParId: "u1", format: "DXF", statut: "EN_ATTENTE", nomFichier: "plan.dxf", sha256: "a".repeat(64), tailleOctets: 10, parametres: { epsgSource: 32629, unitesDxf: "metre" },
    etape: null, progression: 0, codeErreur: null, messageErreur: null, tentatives: 0, tentativesMax: 3, spoolId: spoolIdDe(id, 1), reclameLe: null, finLe: null,
    expireLe: new Date(T0.getTime() + 24 * 3_600_000), purgeLe: null, resume: null, jeuId: null, annuleParId: null, createdAt: T0, updatedAt: T0, ...over,
  };
}
const ecrire = (rel: string, contenu: string) => { const f = path.join(racine, ...rel.split("/")); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, contenu); };
const existe = (rel: string) => existsSync(path.join(racine, ...rel.split("/")));
const lu = (id: string) => h.etat.jobs.find((j) => j.id === id)!;

const VARIABLES = ["PROJETS_VOIRIE_GDAL", "PROJETS_VOIRIE_GDAL_SPOOL", "PROJETS_VOIRIE_GDAL_DELAI_TOUR_S", "PROJETS_VOIRIE_GDAL_CONCURRENCE"];
const avant = Object.fromEntries(VARIABLES.map((v) => [v, process.env[v]]));

beforeEach(() => {
  rmSync(racine, { recursive: true, force: true });
  for (const d of ["entree", "sortie", "prive"]) mkdirSync(path.join(racine, d), { recursive: true });
  h.etat.jobs = []; h.etat.audits = []; h.etat.crochets = {};
  process.env.PROJETS_VOIRIE_GDAL = "1";
  process.env.PROJETS_VOIRIE_GDAL_SPOOL = racine;
  process.env.PROJETS_VOIRIE_GDAL_CONCURRENCE = "2";
  delete process.env.PROJETS_VOIRIE_GDAL_DELAI_TOUR_S;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); for (const v of VARIABLES) { if (avant[v] === undefined) delete process.env[v]; else process.env[v] = avant[v]!; } });
afterAll(() => rmSync(racine, { recursive: true, force: true }));

describe("M2 : le conteneur ne voit le fichier qu'a la reclamation, et plus apres la fin du job", () => {
  it("EN_ATTENTE : rien dans entree/ ; reclamation : copie depuis prive/ puis demande.json ; la transition est AUDITEE sans acteur (m8)", async () => {
    h.etat.jobs.push(job(JOB));
    ecrire(`prive/${JOB}/fichier.dxf`, "0\nSECTION\n");
    expect(readdirSync(path.join(racine, "entree"))).toEqual([]);
    const b = await traiterUnTour(T0);
    expect(b.reclames).toBe(1);
    const j = lu(JOB);
    expect(j).toMatchObject({ statut: "EN_COURS", tentatives: 1, etape: "transmis", reclameLe: T0 });
    expect(readdirSync(path.join(racine, "entree", j.spoolId as string)).sort()).toEqual(["demande.json", "fichier.dxf"]);
    expect(existe(`prive/${JOB}/fichier.dxf`)).toBe(true); // garde pour une relance eventuelle
    const audit = h.etat.audits.find((a) => a.entityId === JOB && (a.after as Record<string, unknown>)?.statut === "EN_COURS");
    expect(audit).toMatchObject({ userId: null, action: "UPDATE", entityType: "JobImportProjet" });
    expect((audit!.after as Record<string, unknown>).tentative).toBe(1);
    expect(JSON.stringify(audit)).not.toContain(racine);
  });

  it("reclamation sans depot prive : ECHEC ENTREE_ABSENTE, rien n'est publie", async () => {
    h.etat.jobs.push(job(JOB));
    const b = await traiterUnTour(T0);
    expect(b.reclames).toBe(1);
    expect(lu(JOB)).toMatchObject({ statut: "ECHEC", codeErreur: "ENTREE_ABSENTE" });
    expect(readdirSync(path.join(racine, "entree"))).toEqual([]);
  });

  it("job utilise (TERMINE + jeuId) : purge de entree/, sortie/ ET prive/, purgeLe pose", async () => {
    const sid = spoolIdDe(JOB, 1);
    h.etat.jobs.push(job(JOB, { statut: "TERMINE", jeuId: "jeu-1", finLe: T0, tentatives: 1 }));
    ecrire(`prive/${JOB}/fichier.dxf`, "x"); ecrire(`entree/${sid}/fichier.dxf`, "x"); ecrire(`entree/${sid}/demande.json`, "{}");
    ecrire(`sortie/${sid}/statut.json`, statutDe(sid, "termine")); ecrire(`sortie/${sid}/resultat.json`, "{}"); ecrire(`sortie/${sid}/couches/entities.geojson`, "{}");
    const b = await traiterUnTour(T0);
    expect(b.purges).toBe(1);
    expect(existe(`prive/${JOB}`)).toBe(false);
    expect(existe(`entree/${sid}`)).toBe(false);
    expect(existe(`sortie/${sid}`)).toBe(false);
    expect(lu(JOB).purgeLe).toEqual(T0);
  });
});

describe("M1 : garde de delai d'un tour", () => {
  it("une lecture du spool qui ne revient JAMAIS (descripteur bloquant simule) est abandonnee dans le budget du tour, comptee en erreur, et le tour suivant repart", async () => {
    process.env.PROJETS_VOIRIE_GDAL_DELAI_TOUR_S = "1";
    h.etat.jobs.push(job(JOB, { statut: "EN_COURS", tentatives: 1, reclameLe: T0 }));
    h.etat.crochets.lireStatutSpool = () => new Promise(() => { /* ne se resout jamais */ });
    const debut = Date.now();
    const b = await traiterUnTour(T0);
    const duree = Date.now() - debut;
    expect(b.erreurs).toBe(1);
    expect(duree).toBeGreaterThanOrEqual(900);
    expect(duree).toBeLessThan(5_000);
    expect(lu(JOB).statut).toBe("EN_COURS");
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/ErreurDelai \(DELAI_SONDAGE_DEPASSE\)/));
    // le verrou de tour est retombe : un tour suivant s'execute (sans crochet, il lit l'absence de statut et ne fait rien)
    delete h.etat.crochets.lireStatutSpool;
    const b2 = await traiterUnTour(T0);
    expect(b2.erreurs).toBe(0);
  });
});

describe("M3 : une erreur transitoire a la validation laisse le job EN_COURS ; un ecart de la sortie donne ECHEC", () => {
  const enCoursTermine = () => {
    const sid = spoolIdDe(JOB, 1);
    h.etat.jobs.push(job(JOB, { statut: "EN_COURS", tentatives: 1, reclameLe: T0 }));
    ecrire(`prive/${JOB}/fichier.dxf`, "x"); ecrire(`entree/${sid}/fichier.dxf`, "x");
    ecrire(`sortie/${sid}/statut.json`, statutDe(sid, "termine"));
    return sid;
  };

  it("EMFILE (descripteurs epuises) puis EACCES a la relecture du resultat : erreurs comptees, job toujours EN_COURS, aucun code d'erreur", async () => {
    enCoursTermine();
    for (const code of ["EMFILE", "EACCES"]) {
      h.etat.crochets.lireResultatBrut = () => Promise.reject(Object.assign(new Error("panne"), { code }));
      const b = await traiterUnTour(T0);
      expect(b.erreurs, code).toBe(1);
      expect(b.echecs, code).toBe(0);
      expect(lu(JOB), code).toMatchObject({ statut: "EN_COURS", codeErreur: null });
    }
    expect(h.etat.audits.filter((a) => (a.after as Record<string, unknown>)?.statut === "ECHEC")).toHaveLength(0);
  });

  it("resultat.json absent alors que le statut dit termine (rupture du contrat du worker) : ECHEC SORTIE_INVALIDE", async () => {
    enCoursTermine();
    const b = await traiterUnTour(T0);
    expect(b.echecs).toBe(1);
    expect(lu(JOB)).toMatchObject({ statut: "ECHEC", codeErreur: "SORTIE_INVALIDE" });
  });
});

describe("m1 : une purge qui echoue n'affame pas les autres", () => {
  it("la purge en echec est journalisee sans chemin, le job passe en queue (updatedAt), purgeLe reste vide, les autres jobs sont purges au meme tour", async () => {
    const sidA = spoolIdDe(JOB, 1), sidB = spoolIdDe(JOB2, 1);
    h.etat.jobs.push(job(JOB, { statut: "ECHEC", finLe: T0, codeErreur: "CRS_CONFLIT", updatedAt: new Date(T0.getTime() - 2000) }));
    h.etat.jobs.push(job(JOB2, { statut: "ANNULE", finLe: T0, updatedAt: new Date(T0.getTime() - 1000) }));
    ecrire(`sortie/${sidA}/statut.json`, statutDe(sidA, "echec", "CRS_CONFLIT"));
    ecrire(`sortie/${sidB}/statut.json`, statutDe(sidB, "echec", "CRS_CONFLIT"));
    h.etat.crochets.purger = (_s: unknown, spoolId: unknown) => (spoolId === sidA ? Promise.reject(Object.assign(new Error(`EACCES: ${racine}`), { code: "EACCES" })) : Promise.resolve());
    const b = await traiterUnTour(T0);
    expect(b.purges).toBe(1);
    expect(b.erreurs).toBe(1);
    expect(lu(JOB)).toMatchObject({ purgeLe: null, updatedAt: T0 });
    expect(lu(JOB2).purgeLe).toEqual(T0);
    const avertissements = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(avertissements.some((l) => /purge .*EACCES/.test(l))).toBe(true);
    expect(avertissements.some((l) => l.includes(racine))).toBe(false);
  });
});

describe("m7 : relance controlee", () => {
  it("INTERROMPU : nouveau dossier -t2, job EN_ATTENTE, ancienne tentative purgee (le conteneur a rendu la main), depot prive conserve pour la copie suivante", async () => {
    const sid1 = spoolIdDe(JOB, 1), sid2 = spoolIdDe(JOB, 2);
    h.etat.jobs.push(job(JOB, { statut: "EN_COURS", tentatives: 1, reclameLe: T0 }));
    ecrire(`prive/${JOB}/fichier.dxf`, "x"); ecrire(`entree/${sid1}/fichier.dxf`, "x"); ecrire(`entree/${sid1}/demande.json`, "{}");
    ecrire(`sortie/${sid1}/statut.json`, statutDe(sid1, "echec", "INTERROMPU")); ecrire(`sortie/${sid1}/resultat.json`, "{}");
    const b = await traiterUnTour(T0);
    expect(b.relances).toBe(1);
    // la relance (EN_ATTENTE, nouveau dossier) est auditee ; le meme tour reclame ensuite le job relance
    expect(h.etat.audits.find((a) => a.entityId === JOB && (a.after as Record<string, unknown>)?.statut === "EN_ATTENTE")).toMatchObject({ after: { relance: 1, raison: "INTERROMPU" } });
    expect(lu(JOB).spoolId).toBe(sid2);
    expect(existe(`entree/${sid1}`)).toBe(false);
    expect(existe(`sortie/${sid1}`)).toBe(false);
    expect(existe(`prive/${JOB}/fichier.dxf`)).toBe(true);
    // le tour a ensuite reclame le job relance : copie dans le NOUVEAU dossier
    expect(b.reclames).toBe(1);
    expect(readdirSync(path.join(racine, "entree", sid2)).sort()).toEqual(["demande.json", "fichier.dxf"]);
    expect(lu(JOB)).toMatchObject({ statut: "EN_COURS", tentatives: 2 });
  });

  it("relance sans depot prive : ECHEC ENTREE_ABSENTE (jamais une relance qui ne pourra pas etre transmise)", async () => {
    const sid1 = spoolIdDe(JOB, 1);
    h.etat.jobs.push(job(JOB, { statut: "EN_COURS", tentatives: 1, reclameLe: T0 }));
    ecrire(`sortie/${sid1}/statut.json`, statutDe(sid1, "echec", "INTERROMPU"));
    const b = await traiterUnTour(T0);
    expect(b.echecs).toBe(1);
    expect(lu(JOB)).toMatchObject({ statut: "ECHEC", codeErreur: "ENTREE_ABSENTE" });
  });

  it("job perdu (echeance depassee, le conteneur ecrit encore selon le spool) : la relance purge, l'echeance etant passee ; apres tentativesMax : JOB_PERDU", async () => {
    const sid = spoolIdDe(JOB, 3);
    h.etat.jobs.push(job(JOB, { statut: "EN_COURS", tentatives: 3, spoolId: sid, reclameLe: new Date(T0.getTime() - 3_600_000) }));
    ecrire(`prive/${JOB}/fichier.dxf`, "x");
    ecrire(`sortie/${sid}/statut.json`, statutDe(sid, "en_cours"));
    const b = await traiterUnTour(T0);
    expect(b.echecs).toBe(1);
    expect(lu(JOB)).toMatchObject({ statut: "ECHEC", codeErreur: "JOB_PERDU" });
  });
});
