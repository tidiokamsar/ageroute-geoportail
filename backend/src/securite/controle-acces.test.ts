import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * CONTROLE D'ACCES COTE SERVEUR (chantier C1) : un compte a perimetre REGIONAL face a une ressource d'une autre
 * region, sur les domaines que le controle territorial (A10) ne couvrait pas : ordres de travaux, missions,
 * previsions de programmation, observations et defauts (lecture), et un INSPECTEUR face a un OT qui n'est pas le sien.
 *
 * CE QUE CE FICHIER PROUVE, ET CE QU'IL NE PROUVE PAS
 *
 * Il monte les VRAIS routeurs, le VRAI `requireRole`, les VRAIS gardes territoriales et le VRAI `perimetreDe` ; seuls
 * l'authentification (le compte est pose par le test), le module (ouvert) et la base (un faux Prisma en memoire) sont
 * simules. Il prouve donc le CABLAGE : la garde est branchee sur chaque route, le filtre de region est transmis a la
 * requete, un refus n'atteint ni le service ni l'ecriture. Il ne prouve pas que le filtre donne les bonnes lignes en
 * base : cela, c'est le banc `tests-integration/controle-acces.integration.mts` (PostGIS reel, comptes reels, relecture
 * de la base). Le test d'equivalence plus bas relie les deux : le filtre Prisma des observations et des defauts est
 * evalue sur des centaines de liens tires au hasard et comparé a la derivation TypeScript utilisee pour les ecritures.
 */

type Ligne = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const w = vi.hoisted(() => ({
  compte: { id: "u-r1", role: "GESTIONNAIRE" } as { id: string; role: string },
  /** userId -> regions du perimetre (absent = national). */
  perimetres: {} as Record<string, number[]>,
  ots: {} as Record<string, Ligne>,
  missions: {} as Record<string, Ligne>,
  previsions: {} as Record<string, Ligne>,
  troncons: {} as Record<string, number | null>,
  /** Ecritures reellement tentees sur la base (create, update, transaction). */
  ecritures: [] as string[],
  /** `where` des lectures de liste, pour verifier que le filtre de region est transmis. */
  wheres: {} as Record<string, Ligne>,
}));

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { ...w.compte };
    next();
  },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock("../utils/audit", () => ({
  logAudit: vi.fn(), construireAudit: vi.fn(() => ({ __audit: true })), logAuditTransactionnelle: vi.fn(async () => undefined),
}));
vi.mock("../lib/numero", () => ({ nextNumeroOT: async () => "OT-TEST-00001" }));

vi.mock("../lib/prisma", () => {
  const ecrit = (nom: string) => { w.ecritures.push(nom); };
  const sansSuppr = (l: Ligne | undefined) => (l && l.deletedAt == null ? l : null);
  const contient = (filtre: Ligne | undefined, region: number | null | undefined) =>
    !filtre || (filtre.in as number[]).includes(region as number);
  const prisma: Ligne = {
    // perimetres_comptes (territoire.service.regionsDuCompte) et tout SQL brut de statistiques.
    $queryRaw: async (strings: TemplateStringsArray, ...valeurs: unknown[]) =>
      strings.join("?").includes("perimetres_comptes") ? (w.perimetres[String(valeurs[0])] ?? []).map((regionId) => ({ regionId })) : [],
    $transaction: async (arg: unknown) => { ecrit("transaction"); return Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(prisma); },
    user: { findFirst: async () => ({ id: "agent-1", nomComplet: "Agent Un", actif: true }) },
    troncon: { findUnique: async ({ where }: Ligne) => (where.id in w.troncons ? { regionId: w.troncons[where.id] } : null) },
    ordreTravaux: {
      findUnique: async ({ where }: Ligne) => (w.ots[where.id] ? { regionId: w.ots[where.id].regionId, _count: { photos: 0 } } : null),
      findFirst: async ({ where }: Ligne) => sansSuppr(w.ots[where.id]),
      findMany: async ({ where }: Ligne) => { w.wheres.otListe = where; return []; },
      count: async ({ where }: Ligne) => { w.wheres.otCount = where; return 0; },
      groupBy: async () => [],
      create: async ({ data }: Ligne) => { ecrit("ot.create"); return { id: "ot-neuf", ...data, photos: [] }; },
      update: async ({ where, data }: Ligne) => { ecrit("ot.update"); return { ...w.ots[where.id], ...data }; },
    },
    otPhoto: {
      findFirst: async () => ({ id: "ph-1", fileName: "a.jpg", type: "AVANT", ot: { deletedAt: null } }),
      update: async () => { ecrit("photo.update"); return {}; },
    },
    otHistorique: { create: async () => { ecrit("historique.create"); return {}; } },
    mission: {
      findUnique: async ({ where }: Ligne) => (w.missions[where.id] ? { regionId: w.missions[where.id].regionId } : null),
      findMany: async ({ where }: Ligne) => { w.wheres.missionListe = where; return Object.values(w.missions).filter((m) => contient(where.regionId, m.regionId)); },
      findFirst: async ({ where }: Ligne) => {
        w.wheres.missionFiche = where;
        const m = w.missions[where.id];
        return m && contient(where.regionId, m.regionId) ? m : null;
      },
    },
    observation: { findMany: async ({ where }: Ligne) => { w.wheres.pullObservation = where; return []; } },
    defaut: { findMany: async ({ where }: Ligne) => { w.wheres.pullDefaut = where; return []; } },
    programmeBudgetaire: {
      findUnique: async ({ where }: Ligne) => (w.previsions[where.id] ? { troncon: w.previsions[where.id].tronconId ? { regionId: w.troncons[w.previsions[where.id].tronconId] } : null } : null),
      findMany: async ({ where }: Ligne) => { w.wheres.previsionListe = where; return []; },
      count: async ({ where }: Ligne) => { w.wheres.previsionCount = where; return 0; },
      findFirst: async ({ where }: Ligne) => sansSuppr(w.previsions[where.id]),
      create: async ({ data }: Ligne) => { ecrit("prevision.create"); return { id: "p-neuve", ...data, montantPrevuGnf: 1n, createdAt: new Date(), updatedAt: new Date() }; },
      update: async ({ where, data }: Ligne) => { ecrit("prevision.update"); return { ...w.previsions[where.id], ...data }; },
    },
  };
  // `$transaction(fn)` passe `tx` : les memes delegues, avec les ecritures des missions.
  prisma.mission.create = async ({ data }: Ligne) => { ecrit("mission.create"); return { id: "m-neuve", ...data }; };
  prisma.mission.updateMany = async () => { ecrit("mission.updateMany"); return { count: 1 }; };
  return { prisma };
});

import { otRouter } from "../modules/ordres-travaux/ot.routes";
import { missionsV2Router } from "../api-v2/missions.routes";
import { programmationV2Router } from "../api-v2/programmation.routes";
import { syncV2Router } from "../api-v2/sync.routes";
import { errorHandler } from "../middleware/error.middleware";
import { requireTerritoireMasque } from "../middleware/territoire.middleware";
import { et, filtreRegion, filtreRegionDefaut, filtreRegionDuTroncon, filtreRegionObservation, regionsVisibles } from "../territoire/territoire.lecture";
import { regionDefaut, regionObservation } from "../territoire/territoire.v2";

const R1 = 1, R2 = 2;
const app = express();
app.use(express.json());
app.use("/ot", otRouter);
app.use("/missions", missionsV2Router);
app.use("/programmation", programmationV2Router);
app.use("/sync", syncV2Router);
app.use(errorHandler);

const comme = (id: string, role: string, regions?: number[]) => {
  w.compte = { id, role };
  if (regions) w.perimetres[id] = regions; else delete w.perimetres[id];
};

beforeEach(() => {
  w.ecritures = []; w.wheres = {}; w.perimetres = {};
  w.troncons = { "t-r1": R1, "t-r2": R2 };
  w.ots = {
    "ot-r1": { id: "ot-r1", numero: "OT-1", titre: "OT R1", regionId: R1, statut: "BROUILLON", deletedAt: null, assigneAId: null, creeParId: "autre" },
    "ot-r2": { id: "ot-r2", numero: "OT-2", titre: "OT R2", regionId: R2, statut: "BROUILLON", deletedAt: null, assigneAId: null, creeParId: "autre" },
    "ot-sans": { id: "ot-sans", numero: "OT-3", titre: "OT sans region", regionId: null, statut: "BROUILLON", deletedAt: null, assigneAId: null, creeParId: "autre" },
    "ot-insp": { id: "ot-insp", numero: "OT-4", titre: "OT assigne", regionId: R1, statut: "ASSIGNE", deletedAt: null, assigneAId: "u-insp", creeParId: "autre" },
    "ot-cree": { id: "ot-cree", numero: "OT-5", titre: "OT cree par l'inspecteur", regionId: R1, statut: "BROUILLON", deletedAt: null, assigneAId: null, creeParId: "u-insp" },
  };
  w.missions = {
    "m-r1": { id: "m-r1", code: "M1", statut: "BROUILLON", regionId: R1, deletedAt: null },
    "m-r2": { id: "m-r2", code: "M2", statut: "BROUILLON", regionId: R2, deletedAt: null },
    "m-sans": { id: "m-sans", code: "M3", statut: "BROUILLON", regionId: null, deletedAt: null },
  };
  w.previsions = {
    "p-r1": { id: "p-r1", annee: 2027, intitule: "Prevision R1", tronconId: "t-r1", montantPrevuGnf: 1n, statut: "PROPOSE", source: "SAISIE", deletedAt: null, createdAt: new Date(), updatedAt: new Date() },
    "p-r2": { id: "p-r2", annee: 2027, intitule: "Prevision R2", tronconId: "t-r2", montantPrevuGnf: 1n, statut: "PROPOSE", source: "SAISIE", deletedAt: null, createdAt: new Date(), updatedAt: new Date() },
    "p-sans": { id: "p-sans", annee: 2027, intitule: "Prevision sans troncon", tronconId: null, montantPrevuGnf: 1n, statut: "PROPOSE", source: "SAISIE", deletedAt: null, createdAt: new Date(), updatedAt: new Date() },
  };
  comme("u-r1", "GESTIONNAIRE", [R1]);
});

// ============================================================================================ Garde de lecture/ecriture par identifiant

describe("requireTerritoireMasque : une ressource hors perimetre n'existe pas pour le compte", () => {
  const monter = (regions: () => Promise<(number | null)[]>) => {
    const a = express();
    const appelee = vi.fn();
    a.use((req, _res, next) => { (req as unknown as { user: unknown }).user = { ...w.compte }; next(); });
    a.get("/x/:id", requireTerritoireMasque(async () => { appelee(); return regions(); }, { corps: { error: "introuvable" } }), (_q, s) => { s.json({ ok: true }); });
    return { a, appelee };
  };

  it("compte national : passe SANS lire la region de la ressource", async () => {
    comme("u-nat", "GESTIONNAIRE");
    const { a, appelee } = monter(async () => [R2]);
    expect((await request(a).get("/x/1")).status).toBe(200);
    expect(appelee).not.toHaveBeenCalled();
  });
  it("compte regional : region dans le perimetre passe ; autre region et region inconnue donnent le meme 404 que 'introuvable'", async () => {
    expect((await request(monter(async () => [R1]).a).get("/x/1")).status).toBe(200);
    const hors = await request(monter(async () => [R2]).a).get("/x/1");
    const inconnue = await request(monter(async () => [null]).a).get("/x/1");
    expect([hors.status, inconnue.status]).toEqual([404, 404]);
    expect(hors.body).toEqual({ error: "introuvable" });
    expect(inconnue.body).toEqual(hors.body);
  });
  it("ressource inexistante (D9, point 5) : un compte REGIONAL recoit le MEME 404 (statut et corps) qu'une ressource d'une autre region ; un compte national passe, la route rend son propre 404", async () => {
    const inexistante = await request(monter(async () => []).a).get("/x/1");
    const hors = await request(monter(async () => [R2]).a).get("/x/1");
    expect(inexistante.status).toBe(404);
    expect(inexistante.text).toBe(hors.text);
    comme("u-nat", "GESTIONNAIRE");
    expect((await request(monter(async () => []).a).get("/x/1")).status).toBe(200);
  });
  it("une ressource touchant DEUX regions dont une hors perimetre est refusee en entier", async () => {
    expect((await request(monter(async () => [R1, R2]).a).get("/x/1")).status).toBe(404);
  });
});

// ============================================================================================ Filtres de lecture

describe("filtres de lecture par region", () => {
  it("compte national : aucun filtre (comportement d'avant)", async () => {
    comme("u-nat", "GESTIONNAIRE");
    expect(await regionsVisibles(w.compte)).toBeNull();
    expect(await filtreRegion(w.compte)).toEqual({});
    expect(await filtreRegionDuTroncon(w.compte)).toEqual({});
  });
  it("ADMIN : national, meme avec des lignes de perimetre en base", async () => {
    comme("u-adm", "ADMIN", [R1]);
    expect(await regionsVisibles(w.compte)).toBeNull();
  });
  it("compte regional : filtre `in` sur ses regions ; la region de la prevision est celle de son troncon", async () => {
    comme("u-bi", "GESTIONNAIRE", [R1, R2]);
    expect(await filtreRegion(w.compte)).toEqual({ regionId: { in: [R1, R2] } });
    expect(await filtreRegionDuTroncon(w.compte)).toEqual({ troncon: { regionId: { in: [R1, R2] } } });
  });
  it("`et` ne perd aucun des deux fragments, y compris deux cles OR", () => {
    expect(et({}, { a: 1 })).toEqual({ a: 1 });
    expect(et({ a: 1 }, {})).toEqual({ a: 1 });
    expect(et({ OR: [1] }, { OR: [2] })).toEqual({ AND: [{ OR: [1] }, { OR: [2] }] });
  });
});

/**
 * EQUIVALENCE : le filtre Prisma des observations et des defauts doit retenir EXACTEMENT les lignes dont la derivation de
 * region (celle des ecritures, `territoire.v2.regionObservation` / `regionDefaut`) tombe dans le perimetre. On evalue le
 * sous-ensemble de la syntaxe `where` que ces filtres emploient (OR, AND, `null`, `{ not: null }`, `{ in: [...] }` et
 * filtre de relation) sur des centaines de liens tires au hasard (graine fixe), et on compare. Une divergence ici voudrait
 * dire qu'un compte voit en lecture ce qu'il n'ecrirait pas, ou l'inverse.
 */
describe("equivalence filtre de lecture / derivation de region des ecritures", () => {
  type Rel = { regionId: number | null };
  const evaluer = (filtre: Ligne, ligne: Ligne): boolean => {
    return Object.entries(filtre).every(([cle, cond]) => {
      if (cle === "OR") return (cond as Ligne[]).some((f) => evaluer(f, ligne));
      if (cle === "AND") return (cond as Ligne[]).every((f) => evaluer(f, ligne));
      const v = ligne[cle];
      if (cond === null) return v === null || v === undefined;
      if (typeof cond === "object" && "not" in (cond as Ligne)) return (cond as Ligne).not === null ? v !== null && v !== undefined : v !== (cond as Ligne).not;
      if (typeof cond === "object" && "in" in (cond as Ligne)) return (cond as { in: unknown[] }).in.includes(v);
      if (typeof cond === "object") return v !== null && v !== undefined && evaluer(cond as Ligne, v as Ligne); // filtre de relation
      return v === cond;
    });
  };

  // PRNG deterministe (mulberry32) : un echec doit se rejouer.
  const prng = (graine: number) => () => { graine |= 0; graine = (graine + 0x6D2B79F5) | 0; let t = Math.imul(graine ^ (graine >>> 15), 1 | graine); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  it("observations et defauts : 600 combinaisons de liens, regions R1/R2/inconnue, perimetre {R1} puis {R1,R2}", async () => {
    const hasard = prng(20261025);
    const region = (): number | null => [R1, R2, null][Math.floor(hasard() * 3)];
    const lien = (): string | null => (hasard() < 0.5 ? "x" : null);
    const regionsPossibles: (readonly number[])[] = [[R1], [R1, R2]];
    let comparees = 0, retenues = 0;
    // Le faux Prisma est partage : ce test le remplace, et le restitue a la fin (sinon il polluerait les tests suivants).
    const rpOrig = (await import("../lib/prisma")).prisma as unknown as Ligne;
    const sauve = { observation: rpOrig.observation, defaut: rpOrig.defaut, ouvrage: rpOrig.ouvrage, chantier: rpOrig.chantier, troncon: rpOrig.troncon.findUnique, mission: rpOrig.mission.findUnique };
    try {

    for (let i = 0; i < 600; i++) {
      // Une relation n'existe que si son cle etrangere est renseignee (comme en base) ; les regions de ces objets sont tirees a part.
      const regTr = region(), regOu = region(), regCh = region(), regMi = region();
      const obs: Ligne = { tronconId: lien(), ouvrageId: lien(), chantierId: lien(), missionId: lien() };
      obs.troncon = obs.tronconId ? ({ regionId: regTr } as Rel) : null; obs.ouvrage = obs.ouvrageId ? ({ regionId: regOu } as Rel) : null;
      obs.chantier = obs.chantierId ? ({ regionId: regCh } as Rel) : null; obs.mission = obs.missionId ? ({ regionId: regMi } as Rel) : null;
      const defaut: Ligne = { tronconId: lien(), ouvrageId: lien(), missionId: lien(), observation: obs };
      defaut.troncon = defaut.tronconId ? ({ regionId: regTr } as Rel) : null; defaut.ouvrage = defaut.ouvrageId ? ({ regionId: regOu } as Rel) : null; defaut.mission = defaut.missionId ? ({ regionId: regMi } as Rel) : null;
      // Faux Prisma de la derivation : memes lignes, lues par identifiant.
      const rp = (await import("../lib/prisma")).prisma as unknown as Ligne;
      rp.observation = { findUnique: async () => ({ tronconId: obs.tronconId && "o-t", ouvrageId: obs.ouvrageId && "o-o", chantierId: obs.chantierId && "o-c", missionId: obs.missionId && "o-m" }) };
      rp.defaut = { findUnique: async () => ({ tronconId: defaut.tronconId && "o-t", ouvrageId: defaut.ouvrageId && "o-o", missionId: defaut.missionId && "o-m", observationId: "obs-1" }) };
      w.troncons = { "o-t": regTr };
      rp.troncon.findUnique = async ({ where }: Ligne) => (where.id in w.troncons ? { regionId: w.troncons[where.id] } : null);
      rp.ouvrage = { findUnique: async () => ({ regionId: regOu }) };
      rp.chantier = { findUnique: async () => ({ regionId: regCh }) };
      rp.mission.findUnique = async () => ({ regionId: regMi });

      for (const regions of regionsPossibles) {
        const attenduObs = (await regionObservation("obs-1"));
        const attenduDef = (await regionDefaut("def-1"));
        const dedans = (r: number | null | undefined) => r !== null && r !== undefined && regions.includes(r);
        expect(evaluer(filtreRegionObservation(regions), obs), `observation ${JSON.stringify(obs)} / ${regions}`).toBe(dedans(attenduObs));
        expect(evaluer(filtreRegionDefaut(regions), defaut), `defaut ${JSON.stringify(defaut)} / ${regions}`).toBe(dedans(attenduDef));
        comparees += 2; if (dedans(attenduObs)) retenues++;
      }
    }
    } finally {
      rpOrig.observation = sauve.observation; rpOrig.defaut = sauve.defaut; rpOrig.ouvrage = sauve.ouvrage; rpOrig.chantier = sauve.chantier;
      rpOrig.troncon.findUnique = sauve.troncon; rpOrig.mission.findUnique = sauve.mission;
    }
    expect(comparees).toBe(2400);
    expect(retenues).toBeGreaterThan(100); // le tirage couvre bien le cas « retenue »
  });
});

// ============================================================================================ F1. Ordres de travaux

describe("ordres de travaux : un compte regional ne voit et n'ecrit que sa region", () => {
  it("lecture : la liste transmet le filtre de region ; un compte national n'en a pas", async () => {
    await request(app).get("/ot");
    expect(w.wheres.otListe).toMatchObject({ regionId: { in: [R1] } });
    comme("u-nat", "GESTIONNAIRE");
    await request(app).get("/ot");
    expect(w.wheres.otListe.regionId).toBeUndefined();
  });

  it("lecture : la fiche d'un OT d'une autre region (ou sans region) est un 404 identique a un OT inconnu", async () => {
    const hors = await request(app).get("/ot/ot-r2");
    const sans = await request(app).get("/ot/ot-sans");
    const inconnu = await request(app).get("/ot/ot-inconnu");
    expect([hors.status, sans.status, inconnu.status]).toEqual([404, 404, 404]);
    expect(hors.body).toEqual(inconnu.body);
    expect((await request(app).get("/ot/ot-r1")).status).toBe(200);
  });

  it("ecriture : modifier, assigner, changer le statut, convertir, archiver, retirer une photo d'un OT d'une autre region : 404, aucune ecriture", async () => {
    const reponses = [
      await request(app).put("/ot/ot-r2").send({ titre: "pirate" }),
      await request(app).post("/ot/ot-r2/assigner").send({ assigneAId: "00000000-0000-4000-8000-000000000001" }),
      await request(app).post("/ot/ot-r2/statut").send({ statut: "ANNULE" }),
      await request(app).post("/ot/ot-r2/convertir-chantier"),
      await request(app).delete("/ot/ot-r2/photos/ph-1"),
      await request(app).delete("/ot/ot-r2"),
    ];
    expect(reponses.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404]);
    expect(w.ecritures).toEqual([]);
  });

  it("ecriture : un OT sans region est refuse au compte regional (region inconnue)", async () => {
    expect((await request(app).put("/ot/ot-sans").send({ titre: "x1x" })).status).toBe(404);
    expect(w.ecritures).toEqual([]);
  });

  it("creation : region R2, troncon de R2 ou aucune region : 403 sans ecriture ; region R1 ou troncon de R1 : 201", async () => {
    const r2 = await request(app).post("/ot").send({ titre: "Hors zone", typeIntervention: "AUTRE", regionId: R2 });
    const t2 = await request(app).post("/ot").send({ titre: "Hors zone t2", typeIntervention: "AUTRE", tronconId: "3f1d2b9e-0000-4000-8000-0000000000a2" });
    const sans = await request(app).post("/ot").send({ titre: "Sans region", typeIntervention: "AUTRE" });
    expect(r2.status).toBe(403); expect(r2.body.code).toBe("HORS_PERIMETRE");
    expect(sans.status).toBe(403); expect(sans.body.code).toBe("REGION_INCONNUE");
    expect([t2.status]).toEqual([403]); // troncon inconnu du faux Prisma : region inconnue, refusee aussi
    expect(w.ecritures).toEqual([]);
    const ok = await request(app).post("/ot").send({ titre: "Dans la zone", typeIntervention: "AUTRE", regionId: R1 });
    expect(ok.status).toBe(201);
  });

  it("modification : deplacer un OT de sa region vers une autre est refuse (la region d'apres compte)", async () => {
    const r = await request(app).put("/ot/ot-r1").send({ regionId: R2 });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("HORS_PERIMETRE");
    expect(w.ecritures).toEqual([]);
    expect((await request(app).put("/ot/ot-r1").send({ description: "complement" })).status).toBe(200);
  });

  it("non-regression : un compte national modifie l'OT de n'importe quelle region, sans lecture de perimetre", async () => {
    comme("u-nat", "GESTIONNAIRE");
    expect((await request(app).put("/ot/ot-r2").send({ description: "complement national" })).status).toBe(200);
    expect((await request(app).put("/ot/ot-sans").send({ description: "complement national" })).status).toBe(200);
  });

  it("INSPECTEUR : ne modifie pas un OT qui n'est ni le sien ni assigne a lui (404, comme un OT inconnu) ; assigne ou cree par lui : 200", async () => {
    comme("u-insp", "INSPECTEUR", [R1]);
    const autre = await request(app).put("/ot/ot-r1").send({ coutReelGnf: 1 });
    const photo = await request(app).delete("/ot/ot-r1/photos/ph-1");
    const statut = await request(app).post("/ot/ot-r1/statut").send({ statut: "ANNULE" });
    expect([autre.status, photo.status, statut.status]).toEqual([404, 404, 404]);
    expect(w.ecritures).toEqual([]);
    expect((await request(app).put("/ot/ot-insp").send({ description: "constat" })).status).toBe(200);
    expect((await request(app).put("/ot/ot-cree").send({ description: "brouillon complete" })).status).toBe(200);
  });

  it("INSPECTEUR : un OT qui n'est pas le sien est INDISCERNABLE d'un OT inconnu, statut ET corps, y compris avec un corps invalide (D9, point 5)", async () => {
    comme("u-insp", "INSPECTEUR"); // national : rien ne masque l'existence par la region, seule la regle du proprietaire joue
    const essais: Array<[string, (id: string) => string, Ligne | undefined]> = [
      ["put", (id) => `/ot/${id}`, { coutReelGnf: 1 }],
      ["put", (id) => `/ot/${id}`, { statut: 123 }], // corps invalide : ne doit pas reveler l'existence
      ["post", (id) => `/ot/${id}/statut`, {}], // corps invalide
      ["post", (id) => `/ot/${id}/statut`, { statut: "ANNULE" }],
      ["post", (id) => `/ot/${id}/statut`, { statut: "TERMINE" }], // transition interdite : 400 pour un OT existant et ouvert
      ["delete", (id) => `/ot/${id}/photos/ph-1`, undefined],
    ];
    for (const [verbe, chemin, corps] of essais) {
      const envoyer = (id: string) => {
        const r = (request(app) as unknown as Record<string, (u: string) => request.Test>)[verbe](chemin(id));
        return corps === undefined ? r : r.send(corps);
      };
      const autrui = await envoyer("ot-r1"); // existe, ni assigne ni cree par u-insp
      const inconnu = await envoyer("ot-inconnu");
      expect([verbe, chemin("x"), JSON.stringify(corps), autrui.status]).toEqual([verbe, chemin("x"), JSON.stringify(corps), 404]);
      expect(autrui.status).toBe(inconnu.status);
      expect(autrui.text).toBe(inconnu.text);
    }
    expect(w.ecritures).toEqual([]);
  });

  it("COMPTE REGIONAL : OT d'une autre region et OT inconnu sont indiscernables (statut ET corps) sur chaque route, corps invalide compris (D9, point 5)", async () => {
    const essais: Array<[string, (id: string) => string, Ligne | undefined]> = [
      ["get", (id) => `/ot/${id}`, undefined],
      ["put", (id) => `/ot/${id}`, { statut: 123 }],
      ["post", (id) => `/ot/${id}/statut`, {}],
      ["post", (id) => `/ot/${id}/assigner`, {}],
      ["post", (id) => `/ot/${id}/convertir-chantier`, undefined],
      ["delete", (id) => `/ot/${id}/photos/ph-1`, undefined],
      ["delete", (id) => `/ot/${id}`, undefined],
    ];
    for (const [verbe, chemin, corps] of essais) {
      const envoyer = (id: string) => {
        const r = (request(app) as unknown as Record<string, (u: string) => request.Test>)[verbe](chemin(id));
        return corps === undefined ? r : r.send(corps);
      };
      const autreRegion = await envoyer("ot-r2");
      const inconnu = await envoyer("ot-inconnu");
      const sansRegion = await envoyer("ot-sans");
      expect([verbe, chemin("x"), autreRegion.status]).toEqual([verbe, chemin("x"), 404]);
      expect(inconnu.status).toBe(autreRegion.status);
      expect(inconnu.text).toBe(autreRegion.text);
      expect(sansRegion.text).toBe(autreRegion.text);
    }
    expect(w.ecritures).toEqual([]);
  });

  it("non-regression : dans SA region, un corps invalide reste un 400 et un OT existant reste lisible", async () => {
    expect((await request(app).post("/ot/ot-r1/statut").send({})).status).toBe(400);
    expect((await request(app).get("/ot/ot-r1")).status).toBe(200);
  });

  it("INSPECTEUR : la regle ne touche ni le GESTIONNAIRE ni l'ADMIN", async () => {
    expect((await request(app).put("/ot/ot-r1").send({ description: "responsable" })).status).toBe(200);
    comme("u-adm", "ADMIN");
    expect((await request(app).put("/ot/ot-r1").send({ description: "admin" })).status).toBe(200);
  });
});

// ============================================================================================ F2. Missions

describe("missions : un compte regional ne voit et n'ecrit que sa region", () => {
  it("lecture : la liste ne contient que les missions de ses regions ; le national voit tout", async () => {
    const r = await request(app).get("/missions");
    expect(r.status).toBe(200);
    expect((r.body as Ligne[]).map((m) => m.id)).toEqual(["m-r1"]);
    comme("u-nat", "GESTIONNAIRE");
    expect(((await request(app).get("/missions")).body as Ligne[]).length).toBe(3);
  });
  it("lecture : la fiche d'une mission d'une autre region ou sans region est un 404 identique a une mission inconnue", async () => {
    const a = await request(app).get("/missions/m-r2"); const b = await request(app).get("/missions/m-sans"); const c = await request(app).get("/missions/m-inconnue");
    expect([a.status, b.status, c.status]).toEqual([404, 404, 404]);
    expect(a.body).toEqual(c.body);
    expect((await request(app).get("/missions/m-r1")).status).toBe(200);
  });
  it("ecriture : changer le statut d'une mission d'une autre region : 404, aucune ecriture", async () => {
    const r = await request(app).post("/missions/m-r2/statut").send({ statut: "PLANIFIEE" });
    expect(r.status).toBe(404);
    expect(w.ecritures).toEqual([]);
    expect((await request(app).post("/missions/m-r1/statut").send({ statut: "PLANIFIEE" })).status).toBe(200);
  });
  it("missions : aucun oracle d'existence (D9, point 5) : la mission d'une autre region et la mission inconnue rendent le meme statut ET le meme corps, avec un corps valide comme invalide", async () => {
    for (const corps of [{ statut: "PLANIFIEE" }, {}, { statut: "N_IMPORTE_QUOI" }]) {
      const autre = await request(app).post("/missions/m-r2/statut").send(corps);
      const inconnue = await request(app).post("/missions/m-inconnue/statut").send(corps);
      expect(inconnue.status).toBe(autre.status);
      expect(inconnue.text).toBe(autre.text);
    }
  });
  it("creation : region R2 ou sans region : 403 sans ecriture ; region R1 : 201 ; le national cree sans region", async () => {
    const corps = { code: "M-NEUVE", intitule: "Mission neuve", type: "INSPECTION" };
    const r2 = await request(app).post("/missions").send({ ...corps, regionId: R2 });
    const sans = await request(app).post("/missions").send(corps);
    expect(r2.status).toBe(403); expect(r2.body.code).toBe("HORS_PERIMETRE");
    expect(sans.status).toBe(403); expect(sans.body.code).toBe("REGION_INCONNUE");
    expect(w.ecritures).toEqual([]);
    expect((await request(app).post("/missions").send({ ...corps, regionId: R1 })).status).toBe(201);
    comme("u-nat", "GESTIONNAIRE");
    expect((await request(app).post("/missions").send(corps)).status).toBe(201);
  });
});

// ============================================================================================ F3. Programmation

describe("programmation manuelle : la region d'une prevision est celle de son troncon", () => {
  it("lecture : la liste et les totaux transmettent le filtre de region du troncon ; le national n'en a pas", async () => {
    await request(app).get("/programmation"); await request(app).get("/programmation/totaux");
    expect(w.wheres.previsionListe).toMatchObject({ troncon: { regionId: { in: [R1] } } });
    expect(w.wheres.previsionCount).toMatchObject({ troncon: { regionId: { in: [R1] } } });
    comme("u-nat", "GESTIONNAIRE");
    await request(app).get("/programmation");
    expect(w.wheres.previsionListe.troncon).toBeUndefined();
  });
  it("ecriture : modifier ou supprimer une prevision d'une autre region ou sans troncon : 404, aucune ecriture", async () => {
    const reponses = [
      await request(app).patch("/programmation/p-r2").send({ statut: "RETENU" }),
      await request(app).patch("/programmation/p-sans").send({ statut: "RETENU" }),
      await request(app).post("/programmation/p-r2/supprimer"),
      await request(app).post("/programmation/p-sans/supprimer"),
    ];
    expect(reponses.map((r) => r.status)).toEqual([404, 404, 404, 404]);
    expect(reponses[0].body.code).toBe("INTROUVABLE");
    expect(w.ecritures).toEqual([]);
    expect((await request(app).patch("/programmation/p-r1").send({ statut: "RETENU" })).status).toBe(200);
  });
  it("ecriture : rattacher ou detacher une prevision de sa region vers un troncon hors perimetre, ou sans troncon : 403", async () => {
    const vers = await request(app).patch("/programmation/p-r1").send({ tronconId: "t-r2" });
    const detache = await request(app).patch("/programmation/p-r1").send({ tronconId: null });
    expect(vers.status).toBe(403); expect(vers.body.code).toBe("HORS_PERIMETRE");
    expect(detache.status).toBe(403); expect(detache.body.code).toBe("REGION_INCONNUE");
    expect(w.ecritures).toEqual([]);
  });
  it("creation : troncon de R2 ou sans troncon : 403 sans ecriture ; troncon de R1 : 201 ; le national cree sans troncon", async () => {
    const corps = { annee: 2027, intitule: "Prevision neuve", montantPrevuGnf: "10" };
    const r2 = await request(app).post("/programmation").send({ ...corps, tronconId: "t-r2" });
    const sans = await request(app).post("/programmation").send(corps);
    expect(r2.status).toBe(403); expect(r2.body.code).toBe("HORS_PERIMETRE");
    expect(sans.status).toBe(403); expect(sans.body.code).toBe("REGION_INCONNUE");
    expect(w.ecritures).toEqual([]);
    expect((await request(app).post("/programmation").send({ ...corps, tronconId: "t-r1" })).status).toBe(201);
    comme("u-nat", "GESTIONNAIRE");
    expect((await request(app).post("/programmation").send(corps)).status).toBe(201);
  });
});

// ============================================================================================ F4 (suite). Redescente de synchronisation

describe("sync/pull : la redescente suit le meme perimetre que les listes", () => {
  it("compte regional : le filtre de region est ajoute pour les observations ET pour les defauts, tombstones compris", async () => {
    await request(app).post("/sync/pull").send({ entityType: "Observation" });
    await request(app).post("/sync/pull").send({ entityType: "Defaut" });
    expect(JSON.stringify(w.wheres.pullObservation)).toContain(`"regionId":{"in":[${R1}]}`);
    expect(JSON.stringify(w.wheres.pullDefaut)).toContain(`"regionId":{"in":[${R1}]}`);
    expect(w.wheres.pullObservation.deletedAt).toBeUndefined(); // les lignes supprimees restent redescendues (tombstones)
  });
  it("compte national : aucun filtre de region (comportement d'avant)", async () => {
    comme("u-nat", "GESTIONNAIRE");
    await request(app).post("/sync/pull").send({ entityType: "Observation" });
    expect(JSON.stringify(w.wheres.pullObservation)).not.toContain("regionId");
  });
  it("agent regional : affectation ET region se cumulent (AND), aucune des deux ne remplace l'autre", async () => {
    comme("u-insp", "INSPECTEUR", [R1]);
    await request(app).post("/sync/pull").send({ entityType: "Observation" });
    const brut = JSON.stringify(w.wheres.pullObservation);
    expect(brut).toContain('"AND"');
    expect(brut).toContain('"agentId":"u-insp"');
    expect(brut).toContain(`"regionId":{"in":[${R1}]}`);
  });
});
