import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  analyser: vi.fn(),
  perimetre: { national: true } as { national: true } | { national: false; regions: Set<number> },
  regions: {} as Record<string, number | null>,
  creerPortion: vi.fn(),
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock("../lib/prisma", () => ({ prisma: {} }));
vi.mock("../geo/trace.service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  analyserTraceDetaillee: h.analyser,
}));
vi.mock("../territoire/territoire.service", () => ({
  perimetreDe: async () => h.perimetre,
  regionDuTroncon: async (id: string) => (id in h.regions ? h.regions[id] : 1),
}));
vi.mock("../reseau/portions.service", () => ({ creerPortion: h.creerPortion }));
vi.mock("../reseau/portions.depot", () => ({ depotDans: () => ({ marque: "depot-tx" }) }));
vi.mock("../utils/audit", () => ({
  logAuditTransactionnelle: vi.fn(async (_tx: unknown, p: Record<string, unknown>) => { h.audits.push(p); }),
}));

import { RefusTrace } from "../geo/trace.service";
import { ecrireSessionRoulage, pasAdaptatifM, preparerSessionRoulage, type ContexteSession, type PlanSession } from "./session.service";

/**
 * Ce que ces tests defendent : la LOGIQUE d'acceptation d'une session (ce qui est valide, rattache,
 * refuse, cree) avec une base simulee. Le SQL lui-meme -- projections, insertions, contraintes -- est
 * eprouve contre PostGIS par tests-integration/roulage.integration.mts.
 */

const T0 = 1_790_000_000_000;
const SESSION = "00000001-0000-4000-8000-000000000001";
const OP = "00000001-0000-4000-8000-0000000000aa";
const ctx: ContexteSession = { userId: "agent-1", appareilId: "app-1", operationId: OP, entityId: SESSION };
const M1 = "00000002-0000-4000-8000-000000000001";
const E1 = "00000003-0000-4000-8000-000000000001";

const repere = (s: number, lat: number | null = 9.64, lon: number | null = -13.6) => ({ tMs: T0 + s * 1000, lat, lon, precisionM: 5, ageFixMs: 0, positionPerimee: false });

/** Charge de n secondes a 1 Hz, vers l'est, segments donnes par `segmentDe`. */
function charge(n: number, extra: Record<string, unknown> = {}, segmentDe: (s: number) => number = () => 0) {
  return {
    versionContrat: 1, sessionId: SESSION, missionId: null, debutMs: T0, finMs: T0 + (n - 1) * 1000,
    provenanceParametres: "PROVISOIRE_NON_CALIBRE", parametres: { trouMs: 5000 },
    points: Array.from({ length: n }, (_, s) => [T0 + s * 1000, 9.64, -13.6 + s * 9e-5, 5, 10, segmentDe(s)]),
    marqueurs: [], evenements: [], trous: [], interruptions: [], pauses: [],
    compteurs: { rejets: {}, sansPrecision: 0, alertes: 0 },
    ...extra,
  };
}

/** Resultat d'analyse simule : un point retenu toutes les `pas` secondes, rattaches selon `troncon(s)`. */
function analyseSimulee(troncon: (s: number) => string | null, abscisse: (s: number) => number | null, pas = 1) {
  return async (_depot: unknown, lecture: { points: { tMs: number; lat: number; lon: number; precisionM: number | null }[] }) => {
    const retenus = lecture.points.filter((_, i) => i % pas === 0);
    const apparies = retenus.map((p, i) => {
      const s = Math.round((p.tMs - T0) / 1000);
      return { index: i, horodatageMs: p.tMs, tronconId: troncon(s), code: null, abscisseM: abscisse(s), distanceM: 2, precisionInsuffisante: false, rupture: null, transitionNonVerifiee: false };
    });
    const rattaches = apparies.filter((a) => a.tronconId !== null).length;
    return {
      analyse: {
        parametres: { reseau: "reference", distanceMaxM: 50, pasMinM: 15, incertitudeParDefautM: 15, pointsMax: 3000, graphe: null },
        indicateurs: { pointsLus: lecture.points.length, pointsIgnores: 0, pointsRetenus: retenus.length, retiresParPas: 0, pointsRattaches: rattaches, tauxRattachement: rattaches / retenus.length, pointsPrecisionInsuffisante: 0, transitionsNonVerifiees: 1, chaines: 1, distanceParcourueM: 100 * retenus.length, dureeS: null, vitesseMoyenneKmH: null, longueurSurReseauM: 0 },
        passages: [{}], horsReferentiel: [], trace: [], rattache: [], avertissements: [],
      },
      retenus, apparies,
    };
  };
}

interface DepotOpts { projection?: (k: number, tronconId: string) => { abscisseM: number; distanceM: number } | null; mission?: boolean; role?: string; codes?: { revetement?: string[]; etat?: string[]; praticabilite?: string[] } }
function depot(o: DepotOpts = {}) {
  const demandesProjection: { ids: string[]; lats: string[]; lons: string[] }[] = [];
  const d = {
    $queryRaw: vi.fn(async (_s: TemplateStringsArray, ids: string[], lats: string[], lons: string[]) => {
      demandesProjection.push({ ids, lats, lons });
      return ids.flatMap((id, k) => {
        const p = o.projection ? o.projection(k, id) : { abscisseM: 100 + k, distanceM: 3 };
        return p ? [{ k, abscisseM: p.abscisseM, distanceM: p.distanceM, longueurM: 1000 }] : [];
      });
    }),
    mission: { findFirst: vi.fn(async () => (o.mission === false ? null : { id: "m" })) },
    user: { findUnique: vi.fn(async () => ({ role: o.role ?? "INSPECTEUR" })) },
    referentielRevetement: { findMany: vi.fn(async () => (o.codes?.revetement ?? []).map((code) => ({ code }))) },
    referentielEtatChaussee: { findMany: vi.fn(async () => (o.codes?.etat ?? ["MAUVAIS"]).map((code) => ({ code }))) },
    referentielPraticabilite: { findMany: vi.fn(async () => (o.codes?.praticabilite ?? []).map((code) => ({ code }))) },
  };
  return { d: d as never, demandesProjection, brut: d };
}

const marqueur = (s: number) => ({ id: M1, code: "NID_DE_POULE", note: null, repere: repere(s), latenceLogicielleMs: 0.4 });
const evenement = (debut: number, fin: number, extra: Record<string, unknown> = {}) => ({
  id: E1, code: "ETAT_CHAUSSEE", note: null, statut: "CLOS", qualification: { etat: "MAUVAIS" }, debut: repere(debut), fin: repere(fin),
  couvertureGnss: 1, distanceDirecteM: 100, avertissements: [], motifAbandon: null, ...extra,
});

beforeEach(() => {
  h.analyser.mockReset();
  h.creerPortion.mockReset();
  h.audits.length = 0;
  h.perimetre = { national: true };
  h.regions = {};
});

describe("preparerSessionRoulage : refus", () => {
  it("charge invalide : PAYLOAD_INVALIDE, sans toucher la base ni l'analyse", async () => {
    const { d, brut } = depot();
    const r = await preparerSessionRoulage({ ...charge(10), points: "x" }, ctx, {}, d);
    expect(r).toEqual({ ok: false, motif: "PAYLOAD_INVALIDE" });
    expect(h.analyser).not.toHaveBeenCalled();
    expect(brut.mission.findFirst).not.toHaveBeenCalled();
  });

  it("une charge qui porte un IRI est refusee", async () => {
    const { d } = depot();
    expect(await preparerSessionRoulage({ ...charge(10), iri: [{ iriMParKm: 3 }] }, ctx, {}, d)).toEqual({ ok: false, motif: "PAYLOAD_INVALIDE" });
  });

  it("identifiant d'entite different de la session de la charge : ENTITE_INCOHERENTE", async () => {
    const { d } = depot();
    expect(await preparerSessionRoulage(charge(10), { ...ctx, entityId: "autre" }, {}, d)).toEqual({ ok: false, motif: "ENTITE_INCOHERENTE" });
  });

  it("mission qui n'est ni assignee ni creee par l'agent : MISSION_NON_AUTORISEE", async () => {
    const { d, brut } = depot({ mission: false });
    const r = await preparerSessionRoulage(charge(10, { missionId: "00000009-0000-4000-8000-000000000001" }), ctx, {}, d);
    expect(r).toEqual({ ok: false, motif: "MISSION_NON_AUTORISEE" });
    expect(brut.mission.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ OR: [{ assigneId: "agent-1" }, { createurId: "agent-1" }] }) }));
  });
});

describe("analyse de la trace", () => {
  it("chaque segment est analyse SEPARE : jamais relie au suivant", async () => {
    h.analyser.mockImplementation(analyseSimulee(() => "A", (s) => s * 10));
    const { d } = depot();
    const r = await preparerSessionRoulage(charge(60, {}, (s) => (s < 30 ? 0 : 1)), ctx, {}, d);
    expect(r.ok).toBe(true);
    expect(h.analyser).toHaveBeenCalledTimes(2);
    const [premier, second] = h.analyser.mock.calls.map((c) => c[1].points.length);
    expect(premier).toBe(30);
    expect(second).toBe(30);
    if (r.ok) expect(r.plan.analyse.indicateurs).toMatchObject({ segments: 2, segmentsAnalyses: 2, segmentsIgnores: 0, pointsRecus: 60 });
  });

  it("un segment d'un seul point est ignore, et le dit", async () => {
    h.analyser.mockImplementation(analyseSimulee(() => "A", (s) => s * 10));
    const { d } = depot();
    const r = await preparerSessionRoulage(charge(31, {}, (s) => (s < 30 ? 0 : 1)), ctx, {}, d);
    if (!r.ok) throw new Error("prep");
    expect(r.plan.analyse.indicateurs).toMatchObject({ segments: 2, segmentsAnalyses: 1, segmentsIgnores: 1 });
    expect(h.analyser).toHaveBeenCalledTimes(1);
  });

  it("TROP_DE_POINTS : le pas est double et l'analyse retentee ; TRACE_TROP_COURTE : segment ignore", async () => {
    let appels = 0;
    h.analyser.mockImplementation(async (...a: Parameters<ReturnType<typeof analyseSimulee>>) => {
      appels += 1;
      if (appels === 1) throw new RefusTrace("TROP_DE_POINTS", "trop");
      return analyseSimulee(() => "A", (s) => s * 10)(...a);
    });
    const { d } = depot();
    const r = await preparerSessionRoulage(charge(20), ctx, {}, d);
    expect(r.ok).toBe(true);
    const pas = h.analyser.mock.calls.map((c) => c[2].pasMinM);
    expect(pas[1]).toBe(pas[0] * 2);

    h.analyser.mockReset();
    h.analyser.mockRejectedValue(new RefusTrace("TRACE_TROP_COURTE", "courte"));
    const r2 = await preparerSessionRoulage(charge(20), ctx, {}, d);
    if (!r2.ok) throw new Error("prep");
    expect(r2.plan.analyse.indicateurs.segmentsIgnores).toBe(1);
  });

  it("une autre erreur d'analyse n'est pas avalee", async () => {
    h.analyser.mockRejectedValue(new RefusTrace("GRAPHE_TROP_GRAND", "grand"));
    const { d } = depot();
    await expect(preparerSessionRoulage(charge(20), ctx, {}, d)).rejects.toThrow("grand");
  });

  it("le taux de rattachement est celui des points retenus ; les transitions non verifiees sont signalees sans graphe", async () => {
    h.analyser.mockImplementation(analyseSimulee((s) => (s < 15 ? "A" : null), (s) => (s < 15 ? s * 10 : null)));
    const { d } = depot();
    const r = await preparerSessionRoulage(charge(20), ctx, {}, d);
    if (!r.ok) throw new Error("prep");
    expect(r.plan.tauxRattachement).toBe(0.75);
    expect(r.plan.analyse.indicateurs.transitionsNonVerifiees).toBe(1);
    expect(r.plan.analyse.avertissements.join(" ")).toMatch(/non verifies sur le reseau/);
  });

  it("le pas de nettoyage s'adapte a la longueur : 15 m par defaut, davantage pour une trace qui depasserait POINTS_MAX", () => {
    const court = Array.from({ length: 100 }, (_, i) => ({ lat: 9.64, lon: -13.6 + i * 1e-4, tMs: i, precisionM: 5 }));
    expect(pasAdaptatifM(court)).toBe(15);
    // 120 km a 1 Hz.
    const long = Array.from({ length: 7200 }, (_, i) => ({ lat: 9.64, lon: -13.6 + i * 0.00015, tMs: i * 1000, precisionM: 5 }));
    expect(pasAdaptatifM(long)).toBeGreaterThan(15);
    expect(pasAdaptatifM(long) * 3000).toBeGreaterThanOrEqual(Math.floor(7200 * 0.00015 * 111_320 * Math.cos((9.64 * Math.PI) / 180) * 0.9));
  });
});

describe("marqueurs", () => {
  it("rattache au troncon du point le plus proche dans le temps, a l'abscisse PROJETEE depuis la trace brute", async () => {
    h.analyser.mockImplementation(analyseSimulee(() => "A", (s) => s * 10));
    const { d, demandesProjection } = depot({ projection: () => ({ abscisseM: 55.55, distanceM: 3.24 }) });
    const r = await preparerSessionRoulage(charge(30, { marqueurs: [marqueur(5)] }), ctx, {}, d);
    if (!r.ok) throw new Error("prep");
    expect(r.plan.marqueurs[0]).toMatchObject({ statut: "RATTACHE", tronconId: "A", abscisseM: 55.6, distanceM: 3.2, motif: null });
    expect(demandesProjection[0].ids).toEqual(["A"]);
    // La position projetee est celle de la TRACE a l'instant du marqueur, et non le dernier fix du marqueur.
    expect(Number(demandesProjection[0].lons[0])).toBeCloseTo(-13.6 + 5 * 9e-5, 9);
  });

  it("trop loin du troncon : NON_RATTACHE, avec la distance mesuree", async () => {
    h.analyser.mockImplementation(analyseSimulee(() => "A", (s) => s * 10));
    const { d } = depot({ projection: () => ({ abscisseM: 40, distanceM: 120 }) });
    const r = await preparerSessionRoulage(charge(30, { marqueurs: [marqueur(5)] }), ctx, {}, d);
    if (!r.ok) throw new Error("prep");
    expect(r.plan.marqueurs[0]).toMatchObject({ statut: "NON_RATTACHE", motif: "TROP_LOIN_DU_TRONCON", abscisseM: null, distanceM: 120 });
  });

  it("marqueur dans un secteur que le HMM n'a rattache a aucun troncon : NON_RATTACHE, jamais colle au troncon voisin", async () => {
    h.analyser.mockImplementation(analyseSimulee((s) => (s < 10 ? "A" : null), (s) => (s < 10 ? s * 10 : null)));
    const { d } = depot();
    const r = await preparerSessionRoulage(charge(40, { marqueurs: [marqueur(30)] }), ctx, {}, d);
    if (!r.ok) throw new Error("prep");
    expect(r.plan.marqueurs[0]).toMatchObject({ statut: "NON_RATTACHE", motif: "AUCUN_POINT_RATTACHE_A_PROXIMITE", tronconId: null });
  });

  it("troncon sans geometrie exploitable (projection vide) : NON_RATTACHE", async () => {
    h.analyser.mockImplementation(analyseSimulee(() => "A", (s) => s * 10));
    const { d } = depot({ projection: () => null });
    const r = await preparerSessionRoulage(charge(30, { marqueurs: [marqueur(5)] }), ctx, {}, d);
    if (!r.ok) throw new Error("prep");
    expect(r.plan.marqueurs[0]).toMatchObject({ statut: "NON_RATTACHE", motif: "TRONCON_SANS_GEOMETRIE" });
  });
});

describe("evenements lineaires", () => {
  const deuxTroncons = analyseSimulee((s) => (s <= 20 ? "A" : "B"), (s) => (s <= 20 ? s * 10 : (s - 21) * 10));

  it("a cheval sur deux troncons : deux passages ; les bornes extremes viennent de la PROJECTION, celles du milieu des points du HMM", async () => {
    h.analyser.mockImplementation(deuxTroncons);
    const { d, demandesProjection } = depot({ projection: (k, id) => (id === "A" ? { abscisseM: 87.4, distanceM: 2 } : { abscisseM: 41.1, distanceM: 2 }) });
    const r = await preparerSessionRoulage(charge(40, { evenements: [evenement(10, 25)] }), ctx, {}, d);
    if (!r.ok) throw new Error("prep");
    const ev = r.plan.evenements[0];
    expect(demandesProjection[0].ids).toEqual(["A", "B"]);
    expect(ev.troncons).toHaveLength(2);
    expect(ev.troncons[0]).toMatchObject({ tronconId: "A", debutM: 87.4, finM: 200, sens: "CROISSANT", methodeEntree: "PROJECTION", methodeSortie: "POINT", etat: "A_CREER" });
    expect(ev.troncons[1]).toMatchObject({ tronconId: "B", debutM: 0, finM: 41.1, sens: "CROISSANT", methodeEntree: "POINT", methodeSortie: "PROJECTION", etat: "A_CREER" });
  });

  it("une projection trop loin du troncon est ECARTEE : on retombe sur l'abscisse du point rattache, et on le dit (methode POINT)", async () => {
    h.analyser.mockImplementation(deuxTroncons);
    const { d } = depot({ projection: () => ({ abscisseM: 999, distanceM: 400 }) });
    const r = await preparerSessionRoulage(charge(40, { evenements: [evenement(5, 15)] }), ctx, {}, d);
    if (!r.ok) throw new Error("prep");
    expect(r.plan.evenements[0].troncons[0]).toMatchObject({ debutM: 50, finM: 150, methodeEntree: "POINT", methodeSortie: "POINT" });
  });

  it("sens decroissant : bornes ordonnees, sens DECROISSANT", async () => {
    h.analyser.mockImplementation(analyseSimulee(() => "A", (s) => 1000 - s * 10));
    const { d } = depot({ projection: () => null });
    const r = await preparerSessionRoulage(charge(40, { evenements: [evenement(5, 15)] }), ctx, {}, d);
    if (!r.ok) throw new Error("prep");
    expect(r.plan.evenements[0].troncons[0]).toMatchObject({ debutM: 850, finM: 950, sens: "DECROISSANT" });
  });

  it("evenement abandonne : conserve, ABANDONNE, aucune portion", async () => {
    h.analyser.mockImplementation(deuxTroncons);
    const { d } = depot();
    const ab = evenement(5, 15, { statut: "ABANDONNE", fin: null, motifAbandon: "ABANDONNE_PAR_AGENT" });
    const r = await preparerSessionRoulage(charge(40, { evenements: [ab] }), ctx, {}, d);
    if (!r.ok) throw new Error("prep");
    expect(r.plan.evenements[0]).toMatchObject({ statutRattachement: "ABANDONNE", motif: "ABANDONNE_PAR_AGENT", troncons: [] });
  });

  it("evenement hors reseau : NON_RATTACHE avec son motif, aucune portion devinee", async () => {
    h.analyser.mockImplementation(analyseSimulee((s) => (s < 10 ? "A" : null), (s) => (s < 10 ? s * 10 : null)));
    const { d } = depot();
    const r = await preparerSessionRoulage(charge(60, { evenements: [evenement(30, 50)] }), ctx, {}, d);
    if (!r.ok) throw new Error("prep");
    expect(r.plan.evenements[0]).toMatchObject({ statutRattachement: "NON_RATTACHE", motif: "AUCUN_POINT_RATTACHE_AU_DEBUT", troncons: [] });
  });

  it("territoire (A10) : un troncon hors du perimetre regional de l'agent refuse SA portion, pas les autres", async () => {
    h.analyser.mockImplementation(deuxTroncons);
    h.perimetre = { national: false, regions: new Set([1]) };
    h.regions = { A: 1, B: 2 };
    const { d } = depot();
    const r = await preparerSessionRoulage(charge(40, { evenements: [evenement(10, 25)] }), ctx, {}, d);
    if (!r.ok) throw new Error("prep");
    const [a, b] = r.plan.evenements[0].troncons;
    expect(a.etat).toBe("A_CREER");
    expect(b).toMatchObject({ etat: "REFUSEE", refus: "HORS_PERIMETRE" });
  });

  it("region inconnue d'un troncon : refusee a un compte regional", async () => {
    h.analyser.mockImplementation(deuxTroncons);
    h.perimetre = { national: false, regions: new Set([1]) };
    h.regions = { A: null };
    const { d } = depot();
    const r = await preparerSessionRoulage(charge(40, { evenements: [evenement(2, 8)] }), ctx, {}, d);
    if (!r.ok) throw new Error("prep");
    expect(r.plan.evenements[0].troncons[0]).toMatchObject({ etat: "REFUSEE", refus: "REGION_INCONNUE" });
  });

  it("code de referentiel inconnu ou inactif : toutes les portions de l'evenement sont refusees (pas de violation de cle etrangere)", async () => {
    h.analyser.mockImplementation(deuxTroncons);
    const { d } = depot({ codes: { etat: [] } });
    const r = await preparerSessionRoulage(charge(40, { evenements: [evenement(10, 25)] }), ctx, {}, d);
    if (!r.ok) throw new Error("prep");
    expect(r.plan.evenements[0].troncons.map((t) => [t.etat, t.refus])).toEqual([
      ["REFUSEE", "CODE_REFERENTIEL_INCONNU:etat"], ["REFUSEE", "CODE_REFERENTIEL_INCONNU:etat"],
    ]);
  });

  it("aucune requete de referentiel ni de territoire quand aucun evenement n'est a ecrire", async () => {
    h.analyser.mockImplementation(deuxTroncons);
    const { d, brut } = depot();
    await preparerSessionRoulage(charge(40), ctx, {}, d);
    expect(brut.user.findUnique).not.toHaveBeenCalled();
    expect(brut.referentielEtatChaussee.findMany).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ ecriture

function planEcriture(): PlanSession {
  const payload = charge(10) as unknown as PlanSession["payload"];
  const m = (statut: "RATTACHE" | "NON_RATTACHE") => ({
    m: { id: M1, code: "NID_DE_POULE", note: null, repere: repere(3), latenceLogicielleMs: 0.2 },
    statut, motif: statut === "RATTACHE" ? null : "TROP_LOIN_DU_TRONCON", tronconId: "A", abscisseM: statut === "RATTACHE" ? 12 : null, distanceM: 3, positionTrace: { lat: 9.64, lon: -13.6 },
  });
  const tr = (rang: number, etat: "A_CREER" | "REFUSEE") => ({
    rang, tronconId: rang === 0 ? "A" : "B", debutM: 10 + rang, finM: 90 + rang, sens: "CROISSANT" as const,
    methodeEntree: "PROJECTION" as const, methodeSortie: "POINT" as const, etat, refus: etat === "REFUSEE" ? "HORS_PERIMETRE" : null, portionId: null,
  });
  return {
    payload, analyse: { parametres: { reseau: "reference", pasMinM: [15], distanceMaxM: 50, fenetreRattachementMs: 10000, distanceMaxProjectionM: 50, graphe: false }, indicateurs: { pointsRecus: 10, segments: 1, segmentsAnalyses: 1, segmentsIgnores: 0, pointsRetenus: 10, pointsRattaches: 9, tauxRattachement: 0.9, transitionsNonVerifiees: 0, passages: 1, horsReferentiel: 0, distanceParcourueM: 100 }, avertissements: [] },
    tauxRattachement: 0.9, wktTrace: "MULTILINESTRING((-13.6 9.64,-13.599 9.64))",
    marqueurs: [m("RATTACHE"), { ...m("NON_RATTACHE"), m: { ...m("NON_RATTACHE").m, id: "00000002-0000-4000-8000-000000000002" } }],
    evenements: [
      { e: { id: E1, code: "ETAT_CHAUSSEE", note: null, statut: "CLOS", qualification: { etat: "MAUVAIS", largeurM: 6 }, debut: repere(1), fin: repere(8), couvertureGnss: 1, distanceDirecteM: 90, avertissements: [], motifAbandon: null }, statutRattachement: "PORTIONS_REFUSEES", motif: null, troncons: [tr(0, "A_CREER"), tr(1, "A_CREER")] },
      { e: { id: "00000003-0000-4000-8000-000000000002", code: "AUTRE", note: null, statut: "ABANDONNE", qualification: null, debut: repere(2), fin: null, couvertureGnss: null, distanceDirecteM: null, avertissements: [], motifAbandon: "x" }, statutRattachement: "ABANDONNE", motif: "x", troncons: [] },
      { e: { id: "00000003-0000-4000-8000-000000000003", code: "AUTRE", note: null, statut: "CLOS", qualification: null, debut: repere(2), fin: repere(6), couvertureGnss: 1, distanceDirecteM: 40, avertissements: [], motifAbandon: null }, statutRattachement: "PORTIONS_REFUSEES", motif: null, troncons: [tr(0, "REFUSEE")] },
    ],
  };
}

function txSimule() {
  const appels: { sql: string; valeurs: unknown[] }[] = [];
  const tx = { $executeRaw: vi.fn(async (s: TemplateStringsArray, ...v: unknown[]) => { appels.push({ sql: s.join("?"), valeurs: v }); return 1; }) };
  return { tx: tx as never, appels };
}

describe("ecrireSessionRoulage", () => {
  it("ecrit session, marqueurs, evenements et liens ; cree les portions par creerPortion (meme service que la route) avec une cle d'idempotence derivee", async () => {
    let n = 0;
    h.creerPortion.mockImplementation(async () => ({ refus: null, valeur: { id: `portion-${(n += 1)}` } }));
    const { tx, appels } = txSimule();
    const plan = planEcriture();
    const r = await ecrireSessionRoulage(tx, plan, ctx);

    expect(r).toEqual({ sessionId: SESSION, marqueurs: 2, marqueursRattaches: 1, evenements: 3, portionsCreees: 2, portionsRefusees: 1 });
    expect(appels.map((a) => /INSERT INTO "(\w+)"/.exec(a.sql)![1])).toEqual(["sessions_roulage", "marqueurs_roulage", "evenements_roulage", "evenements_roulage_portions"]);

    expect(h.creerPortion).toHaveBeenCalledTimes(2);
    const [demande0, auteur] = h.creerPortion.mock.calls[0];
    expect(demande0).toMatchObject({
      tronconId: "A", debutM: 10, finM: 90, etat: "MAUVAIS", largeurM: 6, revetement: null, praticabilite: null,
      source: `roulage:${SESSION}`, clientOperationId: `${OP}:${E1}:0`,
    });
    expect(demande0.observeeLe.getTime()).toBe(T0 + 1000);
    expect(auteur).toBe("agent-1");
    expect(h.creerPortion.mock.calls[1][0].clientOperationId).toBe(`${OP}:${E1}:1`);
  });

  it("le statut des evenements reflete l'issue des portions : creees, partielles, refusees, abandonne", async () => {
    let n = 0;
    h.creerPortion.mockImplementation(async (d: { tronconId: string }) => (d.tronconId === "B" ? { refus: "CHEVAUCHE_UNE_VALIDEE" } : { refus: null, valeur: { id: `p${(n += 1)}` } }));
    const { tx } = txSimule();
    const plan = planEcriture();
    const r = await ecrireSessionRoulage(tx, plan, ctx);
    expect(plan.evenements.map((e) => e.statutRattachement)).toEqual(["PORTIONS_PARTIELLES", "ABANDONNE", "PORTIONS_REFUSEES"]);
    expect(plan.evenements[0].troncons.map((t) => [t.etat, t.refus, t.portionId])).toEqual([["CREEE", null, "p1"], ["REFUSEE", "CHEVAUCHE_UNE_VALIDEE", null]]);
    expect(plan.evenements[2].motif).toBe("HORS_PERIMETRE");
    expect(r).toMatchObject({ portionsCreees: 1, portionsRefusees: 2 });
  });

  it("les liens evenement -> portion ne contiennent QUE les portions creees", async () => {
    h.creerPortion.mockImplementation(async (d: { tronconId: string }) => (d.tronconId === "B" ? { refus: "TROP_COURTE" } : { refus: null, valeur: { id: "p-ok" } }));
    const { tx, appels } = txSimule();
    await ecrireSessionRoulage(tx, planEcriture(), ctx);
    const liens = JSON.parse(appels[3].valeurs.find((v) => typeof v === "string" && v.startsWith("[")) as string);
    expect(liens).toEqual([{ evenementId: E1, rang: 0, portionId: "p-ok", tronconId: "A", debutM: 10, finM: 90, sens: "CROISSANT" }]);
  });

  it("toute ecriture est auditee : UNE ligne pour la session, avec les identifiants de ce qui a ete ecrit, sans la trace brute", async () => {
    h.creerPortion.mockResolvedValue({ refus: null, valeur: { id: "p1" } });
    const { tx } = txSimule();
    await ecrireSessionRoulage(tx, planEcriture(), ctx);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({ userId: "agent-1", action: "CREATE", entityType: "SessionRoulage", entityId: SESSION });
    const apres = h.audits[0].after as Record<string, unknown>;
    expect(apres.nbPoints).toBe(10);
    expect(apres).not.toHaveProperty("points");
    expect(JSON.stringify(apres)).toContain("p1");
  });

  it("sans marqueur ni evenement : seule la session est ecrite", async () => {
    const { tx, appels } = txSimule();
    const plan = { ...planEcriture(), marqueurs: [], evenements: [] };
    await ecrireSessionRoulage(tx, plan, ctx);
    expect(appels).toHaveLength(1);
    expect(h.creerPortion).not.toHaveBeenCalled();
  });

  it("la trace est transmise telle quelle (jsonb) et la geometrie par WKT parametre, jamais concatenee dans le SQL", async () => {
    const { tx, appels } = txSimule();
    const plan = { ...planEcriture(), marqueurs: [], evenements: [] };
    await ecrireSessionRoulage(tx, plan, ctx);
    expect(appels[0].sql).not.toContain("MULTILINESTRING");
    expect(appels[0].valeurs).toContain(plan.wktTrace);
    expect(appels[0].valeurs).toContain(JSON.stringify(plan.payload.points));
  });
});
