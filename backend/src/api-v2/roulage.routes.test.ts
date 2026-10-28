import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * CONSULTATION DES RELEVES EN ROULAGE (`GET /api/v2/roulage/sessions`, `.../sessions/:id`).
 *
 * CE QUE CE FICHIER PROUVE
 *
 * Il monte le VRAI routeur, le VRAI `requireAuth` (jeton signe, compte relu par un resolveur injecte), le VRAI
 * `requireModuleAccess`, le VRAI `perimetreDe`/`regionsVisibles` ; seule la base est simulee. Il prouve donc le
 * CABLAGE : qui obtient quelle portee, quelle clause de visibilite part a la base (avec quelles valeurs), qu'une
 * entree hostile s'arrete AVANT la base, qu'un 404 est identique dans tous les cas, que rien n'est ecrit.
 *
 * CE QU'IL NE PROUVE PAS : que le SQL rend les bonnes lignes (tri, curseur, filtres, GeoJSON, longueur). La base
 * simulee applique la CLAUSE DE VISIBILITE reconnue dans le texte de la requete, rien d'autre. Cela, c'est le banc
 * `tests-integration/roulage-consultation.integration.mts` (PostGIS reel, comptes reels, releves ecrits par
 * le vrai service d'ecriture).
 */

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://127.0.0.1:1/essai";
  process.env.JWT_ACCESS_SECRET = "essai-access-secret-essai-access-secret-0000";
  process.env.JWT_REFRESH_SECRET = "essai-refresh-secret-essai-refresh-secret-000";
  process.env.CORS_ORIGIN = "http://localhost:5173";
});

interface SessionFictive {
  id: string; userId: string; agentNom: string; debutA: Date; deleted?: boolean;
  /** Regions des troncons des portions creees. */
  regionsPortions: number[]; nbSommets?: number; nbPoints?: number;
}

const w = vi.hoisted(() => ({
  /** userId -> { role, modules, regions, actif }. */
  comptes: {} as Record<string, { role: string; modules: string[]; regions: number[]; actif: boolean; email: string }>,
  sessions: [] as SessionFictive[],
  requetes: [] as { texte: string; valeurs: unknown[] }[],
}));

vi.mock("../lib/prisma", () => {
  const visibles = (texte: string, valeurs: unknown[]): SessionFictive[] => {
    const vivantes = w.sessions.filter((s) => !s.deleted);
    if (!texte.includes('s."deletedAt" IS NULL')) throw new Error("une lecture de releve DOIT exclure les releves supprimes");
    if (texte.includes("/* portee:tous */")) return vivantes;
    const siens = /\/\* portee:siens \*\/ s\."userId" = \$(\d+)/.exec(texte);
    if (siens) return vivantes.filter((s) => s.userId === valeurs[Number(siens[1]) - 1]);
    const regions = /\/\* portee:regions \*\/ \(s\."userId" = \$(\d+) OR EXISTS[\s\S]*?ANY\(\$(\d+)::text\[\]::int\[\]\)/.exec(texte);
    if (regions) {
      const uid = valeurs[Number(regions[1]) - 1];
      const rs = (valeurs[Number(regions[2]) - 1] as string[]).map(Number);
      return vivantes.filter((s) => s.userId === uid || s.regionsPortions.some((r) => rs.includes(r)));
    }
    throw new Error("clause de visibilite absente de la requete");
  };
  const ligneResume = (s: SessionFictive) => ({
    id: s.id, debutA: s.debutA, finA: new Date(s.debutA.getTime() + 600_000), dureeS: 600, nbPoints: s.nbPoints ?? 600,
    nbMarqueurs: 2, nbEvenements: 1, tauxRattachement: 0.9, longueurM: 5300.5, missionId: null, userId: s.userId, agentNom: s.agentNom,
    nbTronconsTraverses: 2, createdAt: new Date(s.debutA.getTime() + 900_000),
  });
  const prisma = {
    user: {
      // requireModuleAccess -> lib/access.modulesAutorisesDe
      findUnique: async ({ where }: { where: { id: string } }) => {
        const c = w.comptes[where.id];
        return c ? { modulesAutorises: c.modules } : null;
      },
    },
    $queryRaw: async (premier: unknown, ...reste: unknown[]) => {
      // Appel par gabarit : `regionsDuCompte` (perimetres_comptes).
      if (Array.isArray(premier)) {
        const texte = (premier as string[]).join("?");
        w.requetes.push({ texte, valeurs: reste });
        if (texte.includes("perimetres_comptes")) return (w.comptes[String(reste[0])]?.regions ?? []).map((regionId) => ({ regionId }));
        throw new Error(`requete par gabarit inattendue : ${texte}`);
      }
      const q = premier as { text: string; values: unknown[] };
      w.requetes.push({ texte: q.text, valeurs: q.values });
      const t = q.text;
      if (t.includes('SELECT 1 AS "ok"')) {
        const id = q.values.find((v) => typeof v === "string" && w.sessions.some((s) => s.id === v));
        return visibles(t, q.values).some((s) => s.id === id) ? [{ ok: 1 }] : [];
      }
      if (t.includes('count(*)::int AS "n" FROM "sessions_roulage"')) return [{ n: visibles(t, q.values).length }];
      if (t.includes('"pointsDisponibles"')) {
        const id = q.values.find((v) => typeof v === "string" && w.sessions.some((s) => s.id === v));
        const s = visibles(t, q.values).find((x) => x.id === id);
        return s ? [{
          ...ligneResume(s), versionContrat: 1, provenanceParametres: "PROVISOIRE_NON_CALIBRE", parametres: { trouMs: 5000 },
          compteurs: { rejets: {}, sansPrecision: 0, alertes: 0 }, trous: [], interruptions: [], pauses: [],
          analyse: { indicateurs: { pointsRecus: s.nbPoints ?? 600 } }, pointsDisponibles: true, nbSommets: s.nbSommets ?? 600,
        }] : [];
      }
      if (t.includes('ORDER BY s."debutA" DESC')) {
        const limite = Number(q.values[q.values.length - 1]);
        const triees = visibles(t, q.values).sort((a, b) => b.debutA.getTime() - a.debutA.getTime() || (a.id < b.id ? -1 : 1));
        return triees.slice(0, limite).map(ligneResume);
      }
      if (t.includes('SELECT m."id", m."code"')) {
        return [{
          id: "m1", code: "NID_DE_POULE", note: null, poseA: new Date("2026-10-25T10:01:00.000Z"), lat: 9.64, lon: -13.6, sourcePosition: "TRACE",
          precisionM: 5, positionPerimee: false, statut: "RATTACHE", motif: null, tronconId: "t1", tronconCode: "RN1", abscisseM: 120.4,
        }];
      }
      if (t.includes('SELECT e."id", e."code"')) {
        return [{
          id: "e1", code: "ETAT_CHAUSSEE", note: null, statutAppareil: "CLOS", qualification: { etat: "MAUVAIS" },
          debutA: new Date("2026-10-25T10:02:00.000Z"), finA: new Date("2026-10-25T10:03:00.000Z"), statutRattachement: "PORTIONS_CREEES", motif: null,
        }];
      }
      if (t.includes('SELECT lp."evenementId"')) {
        return [{ evenementId: "e1", rang: 0, portionId: "p1", tronconId: "t1", tronconCode: "RN1", tronconNom: "Route 1", debutM: 100, finM: 600, sens: "CROISSANT" }];
      }
      if (t.includes("ST_Simplify")) {
        const tolerance = Number(q.values.find((v) => typeof v === "number"));
        // La plus fine tolerance laisse trop de sommets ; la deuxieme passe sous le plafond.
        return [{ n: tolerance < 0.00002 ? 5_400 : 4_100, g: JSON.stringify({ type: "MultiLineString", coordinates: [[[-13.6, 9.64], [-13.5, 9.64]]] }) }];
      }
      if (t.includes('ST_AsGeoJSON(s."geom"')) return [{ g: JSON.stringify({ type: "MultiLineString", coordinates: [[[-13.6, 9.64], [-13.5, 9.64]]] }) }];
      if (t.includes("jsonb_path_query_array")) return [{ points: JSON.stringify([[1790000000000, 9.64, -13.6, 5, 10, 0]]) }];
      throw new Error(`requete inattendue : ${t.slice(0, 120)}`);
    },
  };
  return { prisma };
});

import { _installerResolveurCompte } from "../middleware/auth.middleware";
import { errorHandler } from "../middleware/error.middleware";
import { signAccessToken } from "../utils/jwt";
import { roulageV2Router } from "./roulage.routes";
import { decoderCurseur } from "../roulage/consultation.noyau";

const ID = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const COMPTE = { insA: ID(101), insB: ID(102), lect: ID(103), gestNat: ID(104), gestR1: ID(105), gestR2: ID(106), admin: ID(107), sansModule: ID(108), inactif: ID(109) };
const S = { s1: ID(1), s2: ID(2), s3: ID(3), s4: ID(4), supprime: ID(5), absent: ID(6) };

function app() {
  const a = express();
  a.use("/api/v2/roulage", roulageV2Router);
  a.use(errorHandler);
  return a;
}
const jeton = (userId: string) => signAccessToken({ sub: userId, role: (w.comptes[userId]?.role ?? "LECTEUR") as never, email: "x@ageroute.invalid" });
const avec = (userId: string) => ({ Authorization: `Bearer ${jeton(userId)}` });
const lister = (userId: string, requete = "") => request(app()).get(`/api/v2/roulage/sessions${requete}`).set(avec(userId));
const detail = (userId: string, id: string, requete = "") => request(app()).get(`/api/v2/roulage/sessions/${id}${requete}`).set(avec(userId));
const ids = (r: { body: { items: { id: string }[] } }) => r.body.items.map((i) => i.id).sort();

beforeEach(() => {
  const modules = ["inspections"];
  w.comptes = {
    [COMPTE.insA]: { role: "INSPECTEUR", modules, regions: [], actif: true, email: "a@x.invalid" },
    [COMPTE.insB]: { role: "INSPECTEUR", modules, regions: [], actif: true, email: "b@x.invalid" },
    [COMPTE.lect]: { role: "LECTEUR", modules, regions: [], actif: true, email: "l@x.invalid" },
    [COMPTE.gestNat]: { role: "GESTIONNAIRE", modules, regions: [], actif: true, email: "gn@x.invalid" },
    [COMPTE.gestR1]: { role: "GESTIONNAIRE", modules, regions: [1], actif: true, email: "g1@x.invalid" },
    [COMPTE.gestR2]: { role: "GESTIONNAIRE", modules, regions: [2], actif: true, email: "g2@x.invalid" },
    [COMPTE.admin]: { role: "ADMIN", modules: [], regions: [], actif: true, email: "ad@x.invalid" },
    [COMPTE.sansModule]: { role: "INSPECTEUR", modules: ["geoportail"], regions: [], actif: true, email: "sm@x.invalid" },
    [COMPTE.inactif]: { role: "INSPECTEUR", modules, regions: [], actif: false, email: "in@x.invalid" },
  };
  const t = (h: number) => new Date(`2026-10-2${h}T08:00:00.000Z`);
  w.sessions = [
    { id: S.s1, userId: COMPTE.insA, agentNom: "Agent A", debutA: t(5), regionsPortions: [1, 2] },
    { id: S.s2, userId: COMPTE.insA, agentNom: "Agent A", debutA: t(4), regionsPortions: [2] },
    { id: S.s3, userId: COMPTE.insB, agentNom: "Agent B", debutA: t(3), regionsPortions: [1] },
    { id: S.s4, userId: COMPTE.insA, agentNom: "Agent A", debutA: t(2), regionsPortions: [] },
    { id: S.supprime, userId: COMPTE.insA, agentNom: "Agent A", debutA: t(1), regionsPortions: [1, 2], deleted: true },
  ];
  w.requetes = [];
  // Le compte vient du resolveur injecte (comme en production il vient de `users`) ; requireAuth, lui, est le vrai.
  _installerResolveurCompte(async (userId) => {
    const c = w.comptes[userId];
    return c ? { actif: c.actif, lockedUntil: null, role: c.role as never, email: c.email } : null;
  });
});

describe("authentification et module", () => {
  it("refuse sans jeton et avec un jeton invalide, sans toucher aux releves", async () => {
    expect((await request(app()).get("/api/v2/roulage/sessions")).status).toBe(401);
    expect((await request(app()).get(`/api/v2/roulage/sessions/${S.s1}`)).status).toBe(401);
    expect((await request(app()).get("/api/v2/roulage/sessions").set("Authorization", "Bearer pas.un.jeton")).status).toBe(401);
    expect(w.requetes).toEqual([]);
  });

  it("refuse un compte desactive (COMPTE_INACTIF) et un compte inconnu", async () => {
    const r = await lister(COMPTE.inactif);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("COMPTE_INACTIF");
    expect((await lister(ID(999))).status).toBe(401);
    expect(w.requetes).toEqual([]);
  });

  it("refuse un compte sans le module `inspections` (403), liste et detail, sans lire un seul releve", async () => {
    expect((await lister(COMPTE.sansModule)).status).toBe(403);
    expect((await detail(COMPTE.sansModule, S.s1)).status).toBe(403);
    expect(w.requetes).toEqual([]);
  });

  it("l'ADMIN passe sans module (jamais bloque), les comptes de collecte avec", async () => {
    expect((await lister(COMPTE.admin)).status).toBe(200);
    expect((await lister(COMPTE.insA)).status).toBe(200);
  });
});

describe("liste : qui voit quoi", () => {
  const cas: [string, string, string[]][] = [
    ["INSPECTEUR proprietaire : ses releves", COMPTE.insA, [S.s1, S.s2, S.s4]],
    ["INSPECTEUR d'un autre agent : seulement les siens", COMPTE.insB, [S.s3]],
    ["LECTEUR sans releve : liste vide", COMPTE.lect, []],
    ["GESTIONNAIRE national : tous", COMPTE.gestNat, [S.s1, S.s2, S.s3, S.s4]],
    ["GESTIONNAIRE de la region 1 : ceux qui traversent la region 1", COMPTE.gestR1, [S.s1, S.s3]],
    ["GESTIONNAIRE de la region 2 : ceux qui traversent la region 2", COMPTE.gestR2, [S.s1, S.s2]],
    ["ADMIN : tous", COMPTE.admin, [S.s1, S.s2, S.s3, S.s4]],
  ];
  it.each(cas)("%s", async (_nom, compte, attendus) => {
    const r = await lister(compte);
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual([...attendus].sort());
    // Le total ne compte que ce que le compte voit : il n'est pas un oracle sur les releves des autres.
    expect(r.body.total).toBe(attendus.length);
    expect(r.body.suivant).toBeNull();
  });

  it("un releve sans troncon rattache n'est vu que de son auteur et d'un compte national", async () => {
    expect(ids(await lister(COMPTE.gestR1))).not.toContain(S.s4);
    expect(ids(await lister(COMPTE.gestR2))).not.toContain(S.s4);
    expect(ids(await lister(COMPTE.insA))).toContain(S.s4);
    expect(ids(await lister(COMPTE.gestNat))).toContain(S.s4);
  });

  it("un releve supprime logiquement n'est vu de personne, ADMIN compris", async () => {
    for (const c of [COMPTE.insA, COMPTE.gestNat, COMPTE.gestR1, COMPTE.admin]) expect(ids(await lister(c))).not.toContain(S.supprime);
  });

  it("la clause envoyee a la base porte l'identifiant et les regions en PARAMETRES, jamais dans le texte", async () => {
    await lister(COMPTE.insA);
    await lister(COMPTE.gestR1);
    await lister(COMPTE.admin);
    const sessions = w.requetes.filter((r) => r.texte.includes('FROM "sessions_roulage"'));
    expect(sessions.length).toBe(6);
    for (const r of sessions) {
      expect(r.texte).not.toContain(COMPTE.insA);
      expect(r.texte).not.toContain(COMPTE.gestR1);
    }
    expect(sessions[0].texte).toContain("/* portee:siens */");
    expect(sessions[0].valeurs).toContain(COMPTE.insA);
    expect(sessions[2].texte).toContain("/* portee:regions */");
    expect(sessions[2].valeurs).toContainEqual(["1"]);
    expect(sessions[4].texte).toContain("/* portee:tous */");
  });

  it("un INSPECTEUR n'a pas son perimetre relu : une seule lecture de releves, aucune de perimetres_comptes", async () => {
    await lister(COMPTE.insA);
    expect(w.requetes.some((r) => r.texte.includes("perimetres_comptes"))).toBe(false);
  });
});

describe("liste : forme de la reponse", () => {
  it("rend exactement les champs du contrat, sans e-mail ni champ sensible", async () => {
    const r = await lister(COMPTE.insA, "?limite=1");
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["items", "suivant", "total"]);
    expect(Object.keys(r.body.items[0]).sort()).toEqual([
      "agent", "creeLe", "debutA", "dureeS", "finA", "id", "longueurM", "missionId", "nbEvenements", "nbMarqueurs", "nbPoints",
      "nbTronconsTraverses", "tauxRattachement",
    ]);
    expect(r.body.items[0].agent).toEqual({ id: COMPTE.insA, nom: "Agent A" });
    expect(JSON.stringify(r.body)).not.toMatch(/@|passwordHash|totp/i);
    expect(r.body.items[0].debutA).toBe("2026-10-25T08:00:00.000Z");
    expect(r.headers["cache-control"]).toBe("private, no-store");
  });

  it("pagine par curseur : limite+1 lignes demandees, `suivant` designe la derniere ligne rendue", async () => {
    const r = await lister(COMPTE.admin, "?limite=2");
    expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([S.s1, S.s2]);
    expect(r.body.total).toBe(4);
    const decode = decoderCurseur(r.body.suivant);
    expect(decode).toEqual({ ok: true, curseur: { debutA: "2026-10-24T08:00:00.000Z", id: S.s2 } });
    const requete = w.requetes.find((q) => q.texte.includes('ORDER BY s."debutA" DESC'))!;
    expect(requete.valeurs[requete.valeurs.length - 1]).toBe(3);

    // La page suivante transmet le curseur comme PARAMETRES (date et identifiant), pas dans le texte.
    w.requetes = [];
    await lister(COMPTE.admin, `?limite=2&curseur=${encodeURIComponent(r.body.suivant)}`);
    const suite = w.requetes.find((q) => q.texte.includes('ORDER BY s."debutA" DESC'))!;
    expect(suite.valeurs).toContain("2026-10-24T08:00:00.000Z");
    expect(suite.valeurs).toContain(S.s2);
    expect(suite.texte).not.toContain(S.s2);
    expect(suite.texte).toContain('s."debutA" < ');
  });

  it("`suivant` est nul quand la page contient tout ce qui reste", async () => {
    expect((await lister(COMPTE.admin, "?limite=4")).body.suivant).toBeNull();
    expect((await lister(COMPTE.admin, "?limite=3")).body.suivant).not.toBeNull();
  });

  it("transmet les filtres comme parametres (userId, depuis, jusqua)", async () => {
    await lister(COMPTE.admin, `?userId=${COMPTE.insA}&depuis=2026-10-01&jusqua=2026-10-25`);
    const q = w.requetes.find((x) => x.texte.includes('ORDER BY s."debutA" DESC'))!;
    expect(q.valeurs).toContain(COMPTE.insA);
    expect(q.valeurs).toContain("2026-10-01T00:00:00.000Z");
    expect(q.valeurs).toContain("2026-10-26T00:00:00.000Z");
    expect(q.texte).not.toContain(COMPTE.insA);
  });

  it("le filtre userId s'ajoute a la visibilite, il ne l'elargit pas", async () => {
    const q = async () => w.requetes.find((x) => x.texte.includes('ORDER BY s."debutA" DESC'))!;
    await lister(COMPTE.insB, `?userId=${COMPTE.insA}`);
    expect((await q()).texte).toContain("/* portee:siens */");
  });
});

describe("liste : entrees hostiles = 400, jamais 500, et la base n'est pas atteinte", () => {
  const hostiles = [
    "?limite=0", "?limite=101", "?limite=-3", "?limite=abc", "?limite=1.5", "?limite=1e2", "?limite=", "?limite=1&limite=2", "?limite[a]=1",
    "?depuis=2026-02-30", "?jusqua=2026-13-01", "?depuis=hier", "?depuis=", "?depuis=2026-10-25T10:00:00", "?depuis=2026-10-25&jusqua=2026-10-01",
    "?depuis=2026-10-25&depuis=2026-10-26", "?jusqua[x]=1",
    "?curseur=pas-un-curseur", "?curseur=", "?curseur=eyJkIjoiMjAyNi0wMi0zMFQxMDowMDowMC4wMDBaIiwiaSI6IngifQ", `?curseur=${"A".repeat(400)}`,
    "?userId=x'%3B%20DROP%20TABLE%20users%3B--", "?userId=", "?userId=a%20b", `?userId=${"a".repeat(65)}`,
  ];
  it.each(hostiles)("%s", async (requete) => {
    const r = await lister(COMPTE.gestR1, requete);
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(typeof r.body.error).toBe("string");
    expect(["PARAMETRE_INVALIDE", "CURSEUR_INVALIDE"]).toContain(r.body.code);
    expect(w.requetes).toEqual([]);
  });

  it("un curseur forge porte son propre code", async () => {
    expect((await lister(COMPTE.admin, "?curseur=pas-un-curseur")).body.code).toBe("CURSEUR_INVALIDE");
  });
});

describe("detail", () => {
  it("rend le contrat complet pour le proprietaire, sans les points bruts", async () => {
    const r = await detail(COMPTE.insA, S.s1);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual([
      "agent", "analyse", "creeLe", "debutA", "dureeS", "evenements", "finA", "geometrie", "id", "longueurM", "marqueurs", "missionId",
      "nbEvenements", "nbMarqueurs", "nbPoints", "nbTronconsTraverses", "parametres", "simplifiee", "tauxRattachement", "trace",
    ]);
    expect(r.body.geometrie.type).toBe("MultiLineString");
    expect(r.body.simplifiee).toBe(false);
    expect(r.body.marqueurs[0]).toMatchObject({ id: "m1", code: "NID_DE_POULE", lat: 9.64, lon: -13.6, precisionM: 5, positionPerimee: false, statut: "RATTACHE" });
    expect(r.body.marqueurs[0].poseA).toBe("2026-10-25T10:01:00.000Z");
    expect(r.body.evenements[0]).toMatchObject({
      id: "e1", code: "ETAT_CHAUSSEE", statutAppareil: "CLOS", qualification: { etat: "MAUVAIS" }, statutRattachement: "PORTIONS_CREEES",
      debutA: "2026-10-25T10:02:00.000Z", finA: "2026-10-25T10:03:00.000Z",
      portions: [{ rang: 0, tronconId: "t1", tronconCode: "RN1", tronconNom: "Route 1", debutM: 100, finM: 600, sens: "CROISSANT" }],
    });
    expect(Object.keys(r.body.analyse).sort()).toEqual(["compteurs", "interruptions", "pauses", "serveur", "trous"]);
    expect(r.body.parametres).toEqual({ provenance: "PROVISOIRE_NON_CALIBRE", versionContrat: 1, seuils: { trouMs: 5000 } });
    expect(r.body.trace).toEqual({ nbPoints: 600, pointsDisponibles: true });
    expect(JSON.stringify(r.body)).not.toMatch(/@|passwordHash|totp/i);
    expect(r.headers["cache-control"]).toBe("private, no-store");
    // Les points bruts ne sont ni demandes a la base ni renvoyes par defaut.
    expect(w.requetes.some((q) => q.texte.includes("jsonb_path_query_array"))).toBe(false);
  });

  it("?avecPoints=1 renvoie les points, bornes a 20 000 et dit s'ils sont tronques", async () => {
    const r = await detail(COMPTE.insA, S.s1, "?avecPoints=1");
    expect(r.status).toBe(200);
    expect(r.body.trace.points).toEqual([[1790000000000, 9.64, -13.6, 5, 10, 0]]);
    expect(r.body.trace.tronque).toBe(false);
    const q = w.requetes.find((x) => x.texte.includes("jsonb_path_query_array"))!;
    expect(q.valeurs).toContain(19_999);

    w.sessions.push({ id: ID(50), userId: COMPTE.insA, agentNom: "Agent A", debutA: new Date("2026-10-20T08:00:00.000Z"), regionsPortions: [], nbPoints: 30_000 });
    const gros = await detail(COMPTE.insA, ID(50), "?avecPoints=1");
    expect(gros.body.trace.tronque).toBe(true);
    expect(gros.body.trace.nbPoints).toBe(30_000);
  });

  it("simplifie la geometrie au-dela de 5 000 sommets, avec la plus fine tolerance qui suffit, et le dit", async () => {
    w.sessions.push({ id: ID(51), userId: COMPTE.insA, agentNom: "Agent A", debutA: new Date("2026-10-20T08:00:00.000Z"), regionsPortions: [], nbSommets: 7_200 });
    const r = await detail(COMPTE.insA, ID(51));
    expect(r.status).toBe(200);
    expect(r.body.simplifiee).toBe(true);
    const essais = w.requetes.filter((q) => q.texte.includes("ST_Simplify")).map((q) => q.valeurs.find((v) => typeof v === "number"));
    expect(essais).toEqual([0.00001, 0.00002]);
  });

  it("une session sans geometrie rend `geometrie: null`", async () => {
    w.sessions.push({ id: ID(52), userId: COMPTE.insA, agentNom: "Agent A", debutA: new Date("2026-10-20T08:00:00.000Z"), regionsPortions: [], nbSommets: 0 });
    const r = await detail(COMPTE.insA, ID(52));
    expect(r.body.geometrie).toBeNull();
    expect(r.body.simplifiee).toBe(false);
  });

  const visibles: [string, string, string, number][] = [
    ["le proprietaire", COMPTE.insA, S.s1, 200],
    ["un autre agent", COMPTE.insB, S.s1, 404],
    ["un LECTEUR sans releve", COMPTE.lect, S.s1, 404],
    ["le GESTIONNAIRE national", COMPTE.gestNat, S.s4, 200],
    ["le GESTIONNAIRE de la region 1 sur un releve qui la traverse", COMPTE.gestR1, S.s1, 200],
    ["le GESTIONNAIRE de la region 1 sur un releve de la seule region 2", COMPTE.gestR1, S.s2, 404],
    ["le GESTIONNAIRE de la region 2 sur un releve de la seule region 1", COMPTE.gestR2, S.s3, 404],
    ["le GESTIONNAIRE regional sur un releve sans troncon", COMPTE.gestR1, S.s4, 404],
    ["l'ADMIN", COMPTE.admin, S.s3, 200],
  ];
  it.each(visibles)("%s", async (_nom, compte, id, statut) => {
    expect((await detail(compte, id)).status).toBe(statut);
  });

  it("ORACLE FERME : inexistant, supprime, hors portee, id mal forme, avec ou sans parametres invalides = le MEME 404", async () => {
    const vises: [string, string, string][] = [
      ["inexistant", COMPTE.admin, S.absent],
      ["supprime (meme pour l'ADMIN)", COMPTE.admin, S.supprime],
      ["hors portee (autre agent)", COMPTE.insB, S.s1],
      ["hors portee (autre region)", COMPTE.gestR1, S.s2],
      ["id mal forme", COMPTE.admin, "pas-un-uuid"],
      ["id injection", COMPTE.admin, encodeURIComponent("1' OR '1'='1")],
      ["id traversee", COMPTE.admin, encodeURIComponent("../../etc/passwd")],
      ["id vide-ish", COMPTE.admin, "%20"],
      ["id trop long", COMPTE.admin, "a".repeat(500)],
    ];
    const parametres = ["", "?avecPoints=zzz", "?avecPoints=1&avecPoints=1", "?limite=999&curseur=%00", "?avecPoints[a]=1"];
    let reference: unknown;
    for (const [nom, compte, id] of vises) {
      for (const p of parametres) {
        const r = await detail(compte, id, p);
        expect(r.status, `${nom} ${p}`).toBe(404);
        reference ??= r.body;
        expect(r.body, `${nom} ${p}`).toEqual(reference);
      }
    }
    expect(reference).toEqual({ error: "Releve introuvable", code: "RELEVE_INTROUVABLE" });
  });

  it("un parametre invalide sur un releve VISIBLE est un 400 (et pas un 404)", async () => {
    for (const p of ["?avecPoints=zzz", "?avecPoints=2", "?avecPoints=1&avecPoints=0", "?avecPoints[a]=1"]) {
      const r = await detail(COMPTE.insA, S.s1, p);
      expect(r.status, p).toBe(400);
      expect(r.body.code).toBe("PARAMETRE_INVALIDE");
    }
  });
});

describe("aucune ecriture", () => {
  it("n'expose aucune route d'ecriture et n'envoie aucune requete d'ecriture", async () => {
    for (const verbe of ["post", "put", "patch", "delete"] as const) {
      const r = await request(app())[verbe](`/api/v2/roulage/sessions/${S.s1}`).set(avec(COMPTE.admin));
      expect(r.status, verbe).toBe(404);
      const l = await request(app())[verbe]("/api/v2/roulage/sessions").set(avec(COMPTE.admin));
      expect(l.status, verbe).toBe(404);
    }
    await lister(COMPTE.gestR1);
    await detail(COMPTE.insA, S.s1, "?avecPoints=1");
    for (const q of w.requetes) expect(q.texte, q.texte).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/i);
  });
});
