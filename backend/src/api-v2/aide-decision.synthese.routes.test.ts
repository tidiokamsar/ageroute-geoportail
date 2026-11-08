import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `/api/v2/aide-decision/{synthese,dictionnaire,qualite}` : ce que ces tests defendent.
 *
 * Les VRAIS `requireAuth` (jeton signe, resolveur de compte injecte), `requireModuleAccess`, `perimetreDe`, `lancerEnLectureSeule`
 * et le vrai service d'assemblage ; seule la BASE est simulee (un Proxy en memoire qui repond au texte du SQL et enregistre
 * chaque requete et chaque ecriture). Ces tests prouvent le CABLAGE des gardes et la forme des reponses ; le contenu du SQL
 * est rejoue contre PostGIS par `tests-integration/aide-decision-kpi.integration.mts`.
 *
 *   - anonyme, jeton forge, compte inconnu : 401 ; sans module `decision` : 403 ; aucune requete SQL n'est emise ;
 *   - un compte regional ne recoit que SA region ; une region hors perimetre ou inexistante repond le MEME 404 ;
 *   - sans le module `marches` ou `programmation`, les montants ne sont pas communiques ;
 *   - une entree hostile repond 400 `{ error, code }`, jamais 500, sans toucher la base ;
 *   - la reponse est stable et ne porte aucun secret ni trace d'erreur.
 */
vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://127.0.0.1:1/essai";
  process.env.JWT_ACCESS_SECRET = "essai-access-secret-essai-access-secret-0000";
  process.env.JWT_REFRESH_SECRET = "essai-refresh-secret-essai-refresh-secret-000";
  process.env.CORS_ORIGIN = "http://localhost:5173";
});

const w = vi.hoisted(() => ({
  modules: {} as Record<string, string[]>,
  perimetres: {} as Record<string, number[]>,
  regionsExistantes: new Set<number>([1, 2, 3]),
  requetes: [] as { sql: string; valeurs: unknown[] }[],
  ecritures: [] as string[],
  etat: [] as Record<string, unknown>[],
  echecEtat: false,
}));

vi.mock("../lib/prisma", () => {
  const texteDe = (a: unknown): { sql: string; valeurs: unknown[] } =>
    Array.isArray(a) ? { sql: (a as string[]).join("?"), valeurs: [] } : { sql: (a as { sql: string }).sql, valeurs: (a as { values: unknown[] }).values };
  const queryRaw = async (a: unknown, ...v: unknown[]) => {
    const { sql, valeurs } = texteDe(a);
    const t = sql.replace(/\s+/g, " ");
    w.requetes.push({ sql: t, valeurs: [...valeurs, ...v] });
    if (/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/.test(t)) w.ecritures.push(t);
    if (t.includes("perimetres_comptes")) return (w.perimetres[String(v[0])] ?? []).map((regionId) => ({ regionId }));
    if (t.includes("SELECT id, nom FROM regions")) return [{ id: 1, nom: "Boké" }, { id: 2, nom: "Kindia" }, { id: 3, nom: "Non renseigné" }];
    if (t.includes("AS invalides FROM limites_admin")) return [{ n: 3n, invalides: 0n }];
    if (t.includes("WITH base AS")) { if (w.echecEtat) throw new Error("base indisponible"); return w.etat; }
    if (t.includes('GROUP BY s."bailleurId", b.nom')) return [{ id: 5, nom: "Bailleur A", nb: 2, sans: 0, hors: 0, gnf: 2, total: "5000" }];
    if (t.includes('FROM (SELECT 1 FROM s GROUP BY s."bailleurId") g')) return [{ n: 1 }];
    if (t.includes('SELECT s."bailleurId" AS id, COALESCE(SUM(d."montantGnf")')) return [{ id: 5, total: "1200" }];
    if (t.includes("FROM decomptes d JOIN s")) return [{ payes: 1, total: "1200", sans: 0, ret: 0, emis: 0 }];
    if (t.includes("count(*) FILTER (WHERE devise = 'GNF' AND montant IS NOT NULL)")) return [{ nb: 2, sans: 0, hors: 0, gnf: 2, total: "5000" }];
    if (t.includes('"dateFinPrevue" IS NULL')) return [{ n: 0 }];
    // Requetes du registre d'indicateurs (alias « v ») ; les detecteurs de qualite ne sont pas concernes et rendent des listes vides.
    if (/::text AS v\b/.test(t)) return [{ v: "777" }];
    if (t.includes("SUM(ST_Length")) return [{ v: 123.45 }];
    if (/count\(\*\)::int AS v\b/.test(t)) return [{ v: 3 }];
    return [];
  };
  const modele = (): Record<string, unknown> => new Proxy({}, {
    get: (_t, op: string) => async (args: { where?: { id?: unknown } } = {}) => {
      if (["create", "update", "delete", "upsert", "updateMany", "deleteMany", "createMany"].includes(op)) { w.ecritures.push(`modele.${op}`); return null; }
      return op === "findUnique" ? args : null;
    },
  });
  const prisma: Record<string, unknown> = new Proxy({}, {
    get: (_t, nom: string) => {
      if (nom === "$queryRaw") return queryRaw;
      if (nom === "$executeRaw") return async (a: unknown) => { w.requetes.push({ sql: texteDe(a).sql.replace(/\s+/g, " "), valeurs: [] }); return 0; };
      if (nom === "$transaction") return async (f: (tx: unknown) => Promise<unknown>) => f(prisma);
      if (nom === "user") return { findUnique: async ({ where }: { where: { id: string } }) => ({ modulesAutorises: w.modules[where.id] ?? [] }) };
      if (nom === "region") return { findUnique: async ({ where }: { where: { id: number } }) => (w.regionsExistantes.has(where.id) ? { id: where.id } : null) };
      return modele();
    },
  });
  return { prisma };
});

import { _installerResolveurCompte } from "../middleware/auth.middleware";
import { signAccessToken } from "../utils/jwt";
import { errorHandler } from "../middleware/error.middleware";
import { aideDecisionSyntheseRouter } from "./aide-decision.synthese.routes";
import jwt from "jsonwebtoken";

const app = express();
app.use("/api/v2/aide-decision", aideDecisionSyntheseRouter);
app.use(errorHandler);

const COMPTES: Record<string, { id: string; role: string; modules: string[]; regions?: number[] }> = {
  ADMIN: { id: "u-admin", role: "ADMIN", modules: [] },
  LECTEUR_DECISION: { id: "u-lect", role: "LECTEUR", modules: ["decision"] },
  LECTEUR_COMPLET: { id: "u-lect-c", role: "LECTEUR", modules: ["decision", "marches", "programmation"] },
  LECTEUR_SANS_DECISION: { id: "u-lect-s", role: "LECTEUR", modules: ["dashboard", "marches", "programmation", "chantiers"] },
  LECTEUR_VIDE: { id: "u-lect-v", role: "LECTEUR", modules: [] },
  // Droit sur les montants contractuels = ADMIN, marches OU chantiers (droitMontantsContractuels, regle unique PROVISOIRE).
  LECTEUR_DECISION_CHANTIERS: { id: "u-lect-dc", role: "LECTEUR", modules: ["decision", "chantiers"] },
  LECTEUR_DECISION_PROGRAMMATION: { id: "u-lect-dp", role: "LECTEUR", modules: ["decision", "programmation"] },
  GEST_NATIONAL: { id: "u-gest-n", role: "GESTIONNAIRE", modules: ["decision", "marches", "programmation"] },
  GEST_R1: { id: "u-gest-1", role: "GESTIONNAIRE", modules: ["decision", "marches", "programmation"], regions: [1] },
  GEST_R12: { id: "u-gest-12", role: "GESTIONNAIRE", modules: ["decision", "marches", "programmation"], regions: [1, 2] },
};
const jeton = (c: string) => signAccessToken({ sub: COMPTES[c].id, role: COMPTES[c].role as never, email: `${c}@essai.invalid` });
const matrice: string[] = [];

const LIGNE_ETAT = (o: Record<string, unknown>) => ({ regionId: 1, etat: "BON", sv: null, prov: "OBSERVED", obs: true, lc: true, nb: 4, km: 40, derniere: null, ancienne: null, ...o });

beforeEach(() => {
  w.requetes = []; w.ecritures = []; w.echecEtat = false;
  w.etat = [
    LIGNE_ETAT({ etat: "MAUVAIS", nb: 1, km: 10 }),
    LIGNE_ETAT({ etat: "BON", nb: 4, km: 30 }),
    LIGNE_ETAT({ regionId: 2, etat: "CRITIQUE", nb: 2, km: 60 }),
    LIGNE_ETAT({ regionId: 2, etat: "NON_EVALUE", prov: "UNKNOWN", obs: false, nb: 5, km: 50 }),
  ];
  w.modules = {}; w.perimetres = {};
  for (const c of Object.values(COMPTES)) { w.modules[c.id] = c.modules; if (c.regions) w.perimetres[c.id] = c.regions; }
  _installerResolveurCompte(async (id) => {
    const c = Object.values(COMPTES).find((x) => x.id === id);
    return c ? { actif: true, lockedUntil: null, role: c.role as never, email: `${id}@essai.invalid` } : null;
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterAll(() => { console.log("MATRICE\n" + matrice.join("\n")); _installerResolveurCompte(null); });

async function appel(compte: string | null, url: string, entetes: Record<string, string> = {}) {
  let r = request(app).get(url);
  if (compte) r = r.set("Authorization", `Bearer ${jeton(compte)}`);
  for (const [k, v] of Object.entries(entetes)) r = r.set(k, v);
  const rep = await r;
  matrice.push(`${(compte ?? "ANONYME").padEnd(22)} GET ${url.padEnd(46)} -> ${rep.status}`);
  return rep;
}

const URLS = ["/api/v2/aide-decision/synthese", "/api/v2/aide-decision/dictionnaire", "/api/v2/aide-decision/qualite"];

describe("matrice d'acces", () => {
  it.each(URLS)("ANONYME : 401 sur %s, aucune requete SQL", async (u) => {
    const r = await appel(null, u);
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ code: "NON_AUTHENTIFIE" });
    expect(w.requetes).toEqual([]);
  });

  it.each(URLS)("JETON FORGE : 401 sur %s (mauvaise signature, texte libre, alg none, jeton expire)", async (u) => {
    const forges = [
      jwt.sign({ sub: "u-admin", role: "ADMIN", email: "x@x.invalid" }, "un-autre-secret-un-autre-secret-0000"),
      "abc.def.ghi",
      "n'importe quoi",
      `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"sub":"u-admin","role":"ADMIN"}').toString("base64url")}.`,
      jwt.sign({ sub: "u-admin", role: "ADMIN", email: "x@x.invalid" }, process.env.JWT_ACCESS_SECRET!, { expiresIn: -10 }),
    ];
    for (const j of forges) {
      const r = await request(app).get(u).set("Authorization", `Bearer ${j}`);
      expect(r.status, j.slice(0, 20)).toBe(401);
    }
    matrice.push(`${"FORGE (5 variantes)".padEnd(22)} GET ${u.padEnd(46)} -> 401`);
    expect(w.requetes).toEqual([]);
  });

  it.each(URLS)("COMPTE INCONNU avec un jeton valide : 401 sur %s", async (u) => {
    const j = signAccessToken({ sub: "fantome", role: "ADMIN" as never, email: "f@x.invalid" });
    const r = await request(app).get(u).set("Authorization", `Bearer ${j}`);
    expect(r.status).toBe(401);
    expect(w.requetes).toEqual([]);
  });

  it.each(URLS)("SANS le module decision (meme avec marches, programmation, chantiers) : 403 sur %s, aucune requete de donnees", async (u) => {
    for (const c of ["LECTEUR_SANS_DECISION", "LECTEUR_VIDE"]) {
      const r = await appel(c, u);
      expect(r.status, c).toBe(403);
      expect(r.body).toEqual({ error: "Accès à ce module non autorisé pour votre compte" });
    }
    expect(w.requetes.filter((q) => !q.sql.includes("perimetres_comptes"))).toEqual([]);
  });

  it.each(URLS)("LECTEUR avec le module decision : 200 sur %s", async (u) => {
    expect((await appel("LECTEUR_DECISION", u)).status).toBe(200);
  });

  it("aucune ecriture n'est jamais emise (lecture seule)", async () => {
    for (const c of ["ADMIN", "GEST_R1", "LECTEUR_DECISION"]) for (const u of URLS) await appel(c, u);
    expect(w.ecritures).toEqual([]);
    const lectureSeule = w.requetes.filter((q) => /READ ONLY/.test(q.sql));
    expect(lectureSeule.length).toBeGreaterThan(0); // les detecteurs ouvrent bien une transaction READ ONLY
  });

  it("la reponse n'est jamais mise en cache (donnees territoriales et financieres)", async () => {
    for (const u of URLS) expect((await appel("ADMIN", u)).headers["cache-control"]).toBe("no-store");
  });
});

describe("perimetre territorial", () => {
  it("un compte NATIONAL (ou ADMIN) recoit le pays entier, dit comme tel", async () => {
    for (const c of ["ADMIN", "GEST_NATIONAL"]) {
      const r = await appel(c, URLS[0]);
      expect(r.status).toBe(200);
      expect(r.body.perimetre).toEqual({ national: true, libelle: "Ensemble du pays", regionId: null, regions: [] });
      expect(r.body.avertissements.join(" ")).not.toMatch(/Aucun total national/);
    }
  });

  it("un compte REGIONAL ne recoit que sa region : les lectures sont bornees a [1], le libelle la nomme, aucun total national", async () => {
    const r = await appel("GEST_R1", URLS[0]);
    expect(r.status).toBe(200);
    expect(r.body.perimetre).toMatchObject({ national: false, regionId: 1, libelle: "Région Boké" });
    expect(r.body.avertissements[0]).toMatch(/Aucun total national n'est communiqué/);
    const lectureEtat = w.requetes.find((q) => q.sql.includes("WITH base AS"))!;
    expect(lectureEtat.valeurs).toContainEqual(["1"]);
    expect(lectureEtat.valeurs).not.toContain(null);
    // Aucune lecture bornee par region n'est partie avec une borne nulle (= pays entier) : chaque borne liee vaut ["1"] ou 1.
    const bornees = w.requetes.filter((x) => /::text\[\] IS NULL OR|::int IS NULL OR t\."regionId"/.test(x.sql));
    expect(bornees.length).toBeGreaterThan(5);
    for (const q of bornees) {
      const lie = /::int IS NULL OR t\."regionId"/.test(q.sql) ? q.valeurs.includes(1) : q.valeurs.some((v) => Array.isArray(v) && v.length === 1 && v[0] === "1");
      expect(lie, q.sql.slice(0, 90)).toBe(true);
      // Les lectures du registre et des indicateurs ne portent aucune borne nulle (les detecteurs ont un curseur nul legitime).
      if (!/::int IS NULL OR t."regionId"/.test(q.sql)) expect(q.valeurs.includes(null), q.sql.slice(0, 90)).toBe(false);
    }
    expect(r.body.budget.contractuel.etat).toBe("PARTIEL");
    expect(r.body.kpis.find((k: { code: string }) => k.code === "marches_recenses").etat).toBe("PARTIEL");
  });

  it("un compte a deux regions : « Régions du périmètre », jamais « pays » ; le filtre regionId le reduit a une region", async () => {
    const deux = await appel("GEST_R12", URLS[0]);
    expect(deux.body.perimetre).toMatchObject({ national: false, regionId: null, libelle: "Régions du périmètre : Boké, Kindia" });
    const une = await appel("GEST_R12", `${URLS[0]}?regionId=2`);
    expect(une.status).toBe(200);
    expect(une.body.perimetre).toMatchObject({ regionId: 2, libelle: "Région Kindia" });
  });

  it("region HORS perimetre et region INEXISTANTE : exactement le meme 404, sur les deux routes", async () => {
    const horsPerimetre = await appel("GEST_R1", `${URLS[0]}?regionId=2`);
    const inexistant = await appel("ADMIN", `${URLS[0]}?regionId=999`);
    const inexistantRegional = await appel("GEST_R1", `${URLS[0]}?regionId=999`);
    for (const r of [horsPerimetre, inexistant, inexistantRegional]) {
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: "Région introuvable", code: "INTROUVABLE" });
    }
    const q1 = await appel("GEST_R1", `${URLS[2]}?regionId=2`);
    const q2 = await appel("ADMIN", `${URLS[2]}?regionId=999`);
    expect(q1.status).toBe(404);
    expect(q1.body).toEqual(q2.body);
  });

  it("une region hors perimetre n'est jamais interrogee (aucune requete de donnees)", async () => {
    w.requetes = [];
    await appel("GEST_R1", `${URLS[0]}?regionId=2`);
    expect(w.requetes.filter((q) => !q.sql.includes("perimetres_comptes"))).toEqual([]);
  });

  it("un ADMIN peut cibler une region existante", async () => {
    const r = await appel("ADMIN", `${URLS[0]}?regionId=2`);
    expect(r.status).toBe(200);
    expect(r.body.perimetre).toMatchObject({ national: false, regionId: 2, libelle: "Région Kindia" });
    expect(r.body.filtres.appliques).toEqual({ regionId: 2 });
  });

  it("le perimetre vient du COMPTE, pas de la requete : un compte regional ne l'elargit par aucun parametre", async () => {
    for (const q of ["?national=true", "?regions=1,2,3", "?regionId=1&national=true", "?perimetre=pays"]) {
      const r = await appel("GEST_R1", `${URLS[0]}${q}`);
      expect(r.status, q).toBe(400); // cle inconnue : refusee, pas ignoree
    }
    const ok = await appel("GEST_R1", `${URLS[0]}?regionId=1`);
    expect(ok.status).toBe(200);
    expect(ok.body.perimetre.regionId).toBe(1);
  });
});

describe("droits financiers", () => {
  it("LECTEUR avec seulement `decision` : indicateurs d'etat servis, MONTANTS non communiques", async () => {
    const r = await appel("LECTEUR_DECISION", URLS[0]);
    expect(r.status).toBe(200);
    expect(r.body.budget.contractuel).toMatchObject({ etat: "NON_AUTORISE", valeurGnf: null });
    expect(r.body.budget.decaisse).toMatchObject({ etat: "NON_AUTORISE", valeurGnf: null });
    expect(r.body.budget.previsionnel).toMatchObject({ etat: "NON_AUTORISE", valeurGnf: null });
    expect(r.body.budget.parBailleur).toMatchObject({ etat: "NON_AUTORISE", lignes: [] });
    expect(JSON.stringify(r.body)).not.toMatch(/"5000"|"1200"|"777"/);
    expect(r.body.kpis.find((k: { code: string }) => k.code === "reseau_degrade_pct").valeur).not.toBeNull();
  });

  it("LECTEUR avec marches et programmation : montants servis, en chaines", async () => {
    const r = await appel("LECTEUR_COMPLET", URLS[0]);
    expect(r.body.budget.contractuel).toMatchObject({ etat: "DISPONIBLE", valeurGnf: "5000" });
    expect(r.body.budget.decaisse).toMatchObject({ valeurGnf: "1200" });
    expect(r.body.budget.previsionnel).toMatchObject({ valeurGnf: "777" });
    expect(r.body.budget.parBailleur.lignes[0]).toMatchObject({ bailleur: "Bailleur A", contractuelGnf: "5000", decaisseGnf: "1200" });
    expect(typeof r.body.budget.contractuel.valeurGnf).toBe("string");
  });

  it("REGLE UNIQUE : `decision` + `programmation` ne donnent AUCUN montant contractuel (previsionnel seul) ; `decision` + `chantiers` donnent le contractuel", async () => {
    const prog = await appel("LECTEUR_DECISION_PROGRAMMATION", URLS[0]);
    expect(prog.body.budget.contractuel).toMatchObject({ etat: "NON_AUTORISE", valeurGnf: null });
    expect(prog.body.budget.decaisse).toMatchObject({ etat: "NON_AUTORISE", valeurGnf: null });
    expect(prog.body.budget.parBailleur).toMatchObject({ etat: "NON_AUTORISE", lignes: [] });
    expect(prog.body.budget.previsionnel).toMatchObject({ valeurGnf: "777" }); // estimation de programmation : module `programmation`
    const ch = await appel("LECTEUR_DECISION_CHANTIERS", URLS[0]);
    expect(ch.body.budget.contractuel).toMatchObject({ etat: "DISPONIBLE", valeurGnf: "5000" });
    expect(ch.body.budget.previsionnel).toMatchObject({ etat: "NON_AUTORISE", valeurGnf: null });
  });

  it("le budget engage reste NON_DISPONIBLE pour tout le monde, ADMIN compris", async () => {
    for (const c of ["ADMIN", "LECTEUR_COMPLET", "GEST_NATIONAL"]) {
      const r = await appel(c, URLS[0]);
      expect(r.body.budget.engage).toMatchObject({ etat: "NON_DISPONIBLE", valeurGnf: null });
      expect(r.body.budget.engage.avertissement).toMatch(/B-08, ADR-003/);
    }
  });
});

describe("contenu", () => {
  it("synthese : un compte sans etat valide ne recoit aucun taux (NON_DISPONIBLE), et les non evalues sont a part", async () => {
    w.etat = [LIGNE_ETAT({ etat: "NON_EVALUE", prov: "UNKNOWN", obs: false, nb: 10, km: 100 })];
    const r = await appel("ADMIN", URLS[0]);
    const k = r.body.kpis.find((x: { code: string }) => x.code === "reseau_degrade_pct");
    expect(k).toMatchObject({ valeur: null, etat: "NON_DISPONIBLE" });
    expect(r.body.couverture.partNonEvaluee).toBe(1);
  });

  it("synthese : numerateur et denominateur sur les memes troncons (10 km mauvais + 60 km critiques sur 100 km valides = 70 %)", async () => {
    const r = await appel("ADMIN", URLS[0]);
    expect(r.body.kpis.find((x: { code: string }) => x.code === "reseau_degrade_pct").valeur).toBe(70);
    expect(r.body.repartitionEtat.nonEvalue).toMatchObject({ km: 50, troncons: 5 });
  });

  it("dictionnaire : les indicateurs, leurs parametres PROVISOIRES ; les parametres de requete sont ignores", async () => {
    const r = await appel("LECTEUR_DECISION", `${URLS[1]}?x=1&classe[a]=b`);
    expect(r.status).toBe(200);
    expect(r.body.statutDefinition).toBe("PROVISOIRE");
    expect(r.body.indicateurs.map((i: { code: string }) => i.code)).toContain("reseau_degrade_pct");
    expect(r.body.parametres.classesDegradees).toEqual(["MAUVAIS", "CRITIQUE"]);
    expect(w.requetes.filter((q) => !q.sql.includes("perimetres_comptes"))).toEqual([]); // le dictionnaire ne lit aucune donnee
  });

  it("qualite : comptes par code et gravite, couverture par region, ce qui n'est pas couvert", async () => {
    const r = await appel("GEST_NATIONAL", URLS[2]);
    expect(r.status).toBe(200);
    expect(r.body.detecteurs.etat).toBe("DISPONIBLE");
    expect(r.body.detecteurs.parGravite).toEqual({ BLOQUANTE: 0, A_TRAITER: 0, A_SURVEILLER: 0 });
    expect(r.body.couvertureParRegion.map((c: { regionNom: string }) => c.regionNom)).toEqual(["Boké", "Kindia"]);
    expect(r.body.couvertureParRegion[1]).toMatchObject({ troncons: 7, tronconsNonEvalues: 5, tauxNonEvalues: 0.7143 });
    expect(r.body.nonCouvert.join(" ")).toMatch(/Contradictions entre le referentiel/);
    expect(r.body.statutDefinition).toBe("PROVISOIRE");
  });

  it("qualite d'un compte regional : couverture de sa region seulement", async () => {
    const r = await appel("GEST_R1", URLS[2]);
    expect(r.body.couvertureParRegion.map((c: { regionId: number }) => c.regionId)).toEqual([1]);
    expect(r.body.perimetre).toMatchObject({ national: false, regionId: 1 });
  });
});

describe("entrees hostiles : 400 lisible, jamais 500, jamais de requete de donnees", () => {
  const HOSTILES = [
    "?regionId=abc", "?regionId=-1", "?regionId=0", "?regionId=1.5", "?regionId=1e9", "?regionId=99999999999999999999",
    "?regionId=1&regionId=2", "?regionId[$gt]=0", "?regionId[]=1",
    "?classe=AUTOROUTE", "?classe=", "?classe=RN,,RR", "?classe[a]=b", "?classe[]=RN&classe[]=XX", `?classe=${"R".repeat(300)}`,
    "?etat=bon", "?statutChantier=ANNULE",
    "?depuis=2026-13-45", "?depuis=hier", "?jusqua=1999-01-01", "?depuis=2026-03-01&jusqua=2026-02-01",
    "?depuis=2026-01-01'%3B%20DROP%20TABLE%20troncons%3B--",
    "?inconnu=1", "?constructor[prototype][x]=1", "?regionId=%00", "?classe=%E0%A4%A",
  ];
  it.each(HOSTILES)("synthese %s", async (q) => {
    const r = await appel("ADMIN", `${URLS[0]}${q}`);
    expect(r.status, q).toBe(400);
    expect(r.body).toMatchObject({ error: "Filtres invalides", code: "FILTRE_INVALIDE" });
    expect(r.body.details.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.body)).not.toMatch(/stack|at Object|node_modules/);
  });
  it.each(HOSTILES.slice(0, 12))("qualite %s", async (q) => {
    const r = await appel("ADMIN", `${URLS[2]}${q}`);
    expect(r.status, q).toBe(400);
    expect(r.body.code).toBe("FILTRE_INVALIDE");
  });
  it("?__proto__[x]=1 est neutralise par l'analyseur de requete : reponse normale, aucune pollution de prototype", async () => {
    const r = await appel("ADMIN", `${URLS[0]}?__proto__[x]=1`);
    expect(r.status).toBe(200);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
  it("aucune requete de donnees n'est emise pour une entree refusee", async () => {
    w.requetes = [];
    for (const q of HOSTILES.slice(0, 8)) await request(app).get(`${URLS[0]}${q}`).set("Authorization", `Bearer ${jeton("ADMIN")}`);
    expect(w.requetes.filter((x) => !x.sql.includes("perimetres_comptes"))).toEqual([]);
  });
  it("un en-tete hostile ou un corps sur GET ne change rien", async () => {
    const r = await request(app).get(URLS[0]).set("Authorization", `Bearer ${jeton("ADMIN")}`).set("X-Region-Id", "1; DROP TABLE x").send({ regionId: 1 });
    expect(r.status).toBe(200);
    expect(r.body.perimetre.national).toBe(true);
  });
  it("les filtres valides mais non appliques sont dits, sans erreur", async () => {
    const r = await appel("ADMIN", `${URLS[0]}?etat=BON&statutChantier=EN_COURS&depuis=2026-01-01&jusqua=2026-02-01&classe=RN,RR`);
    expect(r.status).toBe(200);
    expect(r.body.filtres.nonAppliques.map((f: { nom: string }) => f.nom)).toEqual(["etat", "statutChantier", "periode"]);
    expect(r.body.filtres.appliques).toEqual({ classe: ["RN", "RR"] });
  });
});

describe("pannes", () => {
  it("la lecture de l'etat en echec : 500 JSON { error, code }, sans trace ni message interne", async () => {
    w.echecEtat = true;
    const r = await appel("ADMIN", URLS[0]);
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "Erreur interne du serveur", code: "ERREUR_INTERNE" });
    expect(JSON.stringify(r.body)).not.toMatch(/base indisponible/);
  });
});

describe("stabilite", () => {
  const sansHorodatage = (corps: unknown) => JSON.stringify(corps).replace(/"\d{4}-\d{2}-\d{2}T[\d:.]+Z"/g, '"T"');
  it("deux appels sur les memes donnees rendent la meme reponse (hors horodatage), pour chaque compte", async () => {
    for (const c of ["ADMIN", "GEST_R1", "LECTEUR_DECISION"]) {
      for (const u of URLS) {
        const a = await appel(c, u);
        const b = await appel(c, u);
        expect(sansHorodatage(b.body), `${c} ${u}`).toBe(sansHorodatage(a.body));
      }
    }
  });
  it("la reponse ne contient ni secret, ni identifiant de compte, ni adresse", async () => {
    const r = await appel("ADMIN", URLS[0]);
    const t = JSON.stringify(r.body);
    expect(t).not.toMatch(/u-admin|essai\.invalid|password|secret|postgresql:/i);
  });
});
