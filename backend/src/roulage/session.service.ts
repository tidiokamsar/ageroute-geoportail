/**
 * Acceptation d'une session de roulage envoyee par un telephone (paragraphe 7.13).
 *
 * DEUX TEMPS, ET C'EST VOULU
 *
 * 1. `preparerSessionRoulage` : valide la charge (zod), ANALYSE la trace par le HMM existant
 *    (`geo/trace.service.ts`), place les marqueurs et les evenements lineaires, verifie le territoire
 *    et les codes de referentiel. Il ne fait que LIRE la base et s'execute AVANT la transaction du
 *    protocole de synchronisation : une analyse de plusieurs secondes ne doit pas tenir une transaction
 *    d'ecriture ouverte.
 * 2. `ecrireSessionRoulage` : dans la transaction du protocole, ecrit la session, les marqueurs, cree
 *    les portions par `creerPortion` (le MEME service que la route en ligne : aucune regle n'est
 *    reimplementee), puis les evenements et leurs liens, et audite.
 *
 * CE QUE CE MODULE NE FAIT PAS
 *
 * - Il ne calcule aucun IRI et refuse une charge qui en porte un (voir `contrat.ts`).
 * - Il ne valide rien : les portions creees sont des propositions A_VALIDER, comme toute saisie de terrain.
 * - Il ne controle pas le territoire des MARQUEURS, qui ne sont pas des ecritures patrimoniales ; il le
 *   controle pour chaque troncon qui recevrait une portion.
 * - Les seuils de rattachement (fenetre temporelle, distance maximale, pas) sont PROVISOIRES.
 */
import { AuditAction } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { logAuditTransactionnelle } from "../utils/audit";
import { analyserTraceDetaillee, RefusTrace, type AnalyseTrace, type DepotTrace } from "../geo/trace.service";
import { DISTANCE_MAX_PAR_DEFAUT_M } from "../geo/appariement.noyau";
import { distanceM, PAS_MIN_PAR_DEFAUT_M, POINTS_MAX, type PointBrut } from "../geo/trace.import.noyau";
import { creerPortion } from "../reseau/portions.service";
import { depotDans } from "../reseau/portions.depot";
import { perimetreDe, regionDuTroncon } from "../territoire/territoire.service";
import { verifierTerritoire } from "../territoire/territoire.noyau";
import { payloadSessionRoulage, type EvenementPayload, type MarqueurPayload, type PayloadSessionRoulage } from "./contrat";
import {
  bornesPortion, FENETRE_RATTACHEMENT_MS, planifierEvenement, positionAuTemps, tronconAuTemps,
  type PassagePlan, type PointRattache, type PositionTrace, type SensParcours,
} from "./rattachement.noyau";

type ClientTx = Parameters<typeof depotDans>[0];

/** Distance maximale entre une position et le troncon sur lequel on la projette, en metres. Provisoire. */
export const DISTANCE_MAX_PROJECTION_M = DISTANCE_MAX_PAR_DEFAUT_M;

export interface OptionsSessionRoulage {
  reseau?: "reference" | "tout";
  /** Tolerance de fusion des extremites pour le graphe. FOURNIE par l'appelant, jamais supposee. */
  toleranceFusionM?: number;
  fenetreMs?: number;
}

export interface ContexteSession {
  userId: string;
  appareilId: string;
  operationId: string;
  entityId: string;
}

// ------------------------------------------------------------------ types du plan

interface MarqueurResolu {
  m: MarqueurPayload;
  statut: "RATTACHE" | "NON_RATTACHE";
  motif: string | null;
  tronconId: string | null;
  abscisseM: number | null;
  distanceM: number | null;
  positionTrace: { lat: number; lon: number } | null;
}

export interface TronconEvenement {
  rang: number;
  tronconId: string;
  debutM: number | null;
  finM: number | null;
  sens: SensParcours | null;
  /** D'ou viennent les bornes : projection de la position de l'evenement, ou point rattache du HMM. */
  methodeEntree: "PROJECTION" | "POINT" | null;
  methodeSortie: "PROJECTION" | "POINT" | null;
  /** `A_CREER` avant l'ecriture ; `CREEE` ou `REFUSEE` apres. */
  etat: "A_CREER" | "CREEE" | "REFUSEE";
  refus: string | null;
  portionId: string | null;
}

interface EvenementResolu {
  e: EvenementPayload;
  statutRattachement: "PORTIONS_CREEES" | "PORTIONS_PARTIELLES" | "PORTIONS_REFUSEES" | "NON_RATTACHE" | "ABANDONNE";
  motif: string | null;
  troncons: TronconEvenement[];
}

export interface AnalyseSession {
  parametres: { reseau: string; pasMinM: number[]; distanceMaxM: number; fenetreRattachementMs: number; distanceMaxProjectionM: number; graphe: boolean };
  indicateurs: {
    pointsRecus: number;
    segments: number;
    segmentsAnalyses: number;
    segmentsIgnores: number;
    pointsRetenus: number;
    pointsRattaches: number;
    tauxRattachement: number | null;
    transitionsNonVerifiees: number;
    passages: number;
    horsReferentiel: number;
    distanceParcourueM: number;
  };
  avertissements: string[];
}

export interface PlanSession {
  payload: PayloadSessionRoulage;
  analyse: AnalyseSession;
  tauxRattachement: number | null;
  wktTrace: string;
  marqueurs: MarqueurResolu[];
  evenements: EvenementResolu[];
}

export type PreparationSession = { ok: true; plan: PlanSession } | { ok: false; motif: string };

export interface ResultatEcriture {
  sessionId: string;
  marqueurs: number;
  marqueursRattaches: number;
  evenements: number;
  portionsCreees: number;
  portionsRefusees: number;
}

// ------------------------------------------------------------------ preparation

const arrondi = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

/** Pas de nettoyage choisi pour qu'un segment tienne sous `POINTS_MAX` : le pas par defaut, ou plus si la trace est longue. */
export function pasAdaptatifM(points: readonly PointBrut[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += distanceM(points[i - 1], points[i]);
  return Math.max(PAS_MIN_PAR_DEFAUT_M, Math.ceil(total / (POINTS_MAX * 0.9)));
}

function wkt(segments: PointBrut[][]): string {
  const lignes = segments.filter((s) => s.length >= 2).map((s) => `(${s.map((p) => `${p.lon.toFixed(7)} ${p.lat.toFixed(7)}`).join(",")})`);
  return lignes.length ? `MULTILINESTRING(${lignes.join(",")})` : "";
}

export async function preparerSessionRoulage(
  entree: unknown,
  ctx: ContexteSession,
  options: OptionsSessionRoulage = {},
  depot: DepotTrace & Pick<typeof prisma, "mission" | "user" | "referentielRevetement" | "referentielEtatChaussee" | "referentielPraticabilite"> = prisma as never,
): Promise<PreparationSession> {
  const parse = payloadSessionRoulage.safeParse(entree);
  // Le detail zod n'est pas renvoye : il nommerait des champs internes. Le motif suffit a ne pas reessayer.
  if (!parse.success) return { ok: false, motif: "PAYLOAD_INVALIDE" };
  const payload = parse.data;
  if (payload.sessionId !== ctx.entityId) return { ok: false, motif: "ENTITE_INCOHERENTE" };

  if (payload.missionId) {
    const mission = await depot.mission.findFirst({
      where: { id: payload.missionId, deletedAt: null, OR: [{ assigneId: ctx.userId }, { createurId: ctx.userId }] },
      select: { id: true },
    });
    if (!mission) return { ok: false, motif: "MISSION_NON_AUTORISEE" };
  }

  const fenetreMs = options.fenetreMs ?? FENETRE_RATTACHEMENT_MS;
  const avertissements = new Set<string>();

  // ---- 1. Analyse de la trace, segment par segment : un segment n'est jamais relie au suivant.
  const parSegment = new Map<number, PointBrut[]>();
  for (const [tMs, lat, lon, precisionM, , segment] of payload.points) {
    const liste = parSegment.get(segment) ?? [];
    liste.push({ lat, lon, tMs, precisionM });
    parSegment.set(segment, liste);
  }
  const retenusTous: PointRattache[] = [];
  const pasUtilises: number[] = [];
  let segmentsAnalyses = 0;
  let segmentsIgnores = 0;
  let pointsRetenus = 0;
  let pointsRattaches = 0;
  let transitions = 0;
  let passages = 0;
  let horsRef = 0;
  let distanceParcourue = 0;
  let distanceMaxM = DISTANCE_MAX_PAR_DEFAUT_M;
  let reseau = options.reseau ?? "reference";
  let graphe = false;

  for (const [segment, points] of [...parSegment.entries()].sort((a, b) => a[0] - b[0])) {
    if (points.length < 2) { segmentsIgnores += 1; continue; }
    let pas = pasAdaptatifM(points);
    let detail: Awaited<ReturnType<typeof analyserTraceDetaillee>> | null = null;
    for (let essai = 0; essai < 4 && detail === null; essai += 1) {
      try {
        detail = await analyserTraceDetaillee(depot, { points }, { pasMinM: pas, reseau: options.reseau, toleranceFusionM: options.toleranceFusionM });
      } catch (err) {
        if (!(err instanceof RefusTrace)) throw err;
        if (err.code === "TROP_DE_POINTS") { pas *= 2; continue; }
        if (err.code === "TRACE_TROP_COURTE") break;
        throw err;
      }
    }
    if (detail === null) { segmentsIgnores += 1; avertissements.add(`Segment ${segment} ignore : trop court apres nettoyage.`); continue; }
    segmentsAnalyses += 1;
    pasUtilises.push(pas);
    const a: AnalyseTrace = detail.analyse;
    pointsRetenus += a.indicateurs.pointsRetenus;
    pointsRattaches += a.indicateurs.pointsRattaches;
    transitions += a.indicateurs.transitionsNonVerifiees;
    passages += a.passages.length;
    horsRef += a.horsReferentiel.length;
    distanceParcourue += a.indicateurs.distanceParcourueM;
    distanceMaxM = a.parametres.distanceMaxM;
    reseau = a.parametres.reseau;
    graphe = graphe || a.parametres.graphe !== null;
    for (const w of a.avertissements) avertissements.add(w);
    detail.retenus.forEach((p, i) => {
      retenusTous.push({
        tMs: p.tMs as number, segment, tronconId: detail!.apparies[i].tronconId, abscisseM: detail!.apparies[i].abscisseM,
      });
    });
  }
  retenusTous.sort((a, b) => a.tMs - b.tMs);
  const brut: PositionTrace[] = payload.points.map(([tMs, lat, lon, , , segment]) => ({ tMs, lat, lon, segment }));

  // ---- 2. Placement des marqueurs et des evenements, et demandes de projection.
  interface Demande { tronconId: string; lat: number; lon: number }
  const demandes: Demande[] = [];
  const demander = (d: Demande) => { demandes.push(d); return demandes.length - 1; };

  const marqueursPlan = payload.marqueurs.map((m) => {
    const t = tronconAuTemps(m.repere.tMs, retenusTous, fenetreMs);
    const pos = positionAuTemps(m.repere.tMs, brut, fenetreMs) ?? (m.repere.lat !== null && m.repere.lon !== null ? { lat: m.repere.lat, lon: m.repere.lon } : null);
    if (!t) return { m, refus: "AUCUN_POINT_RATTACHE_A_PROXIMITE" as string | null, tronconId: null, pos, k: -1 };
    if (!pos) return { m, refus: "POSITION_INCONNUE" as string | null, tronconId: t.tronconId, pos, k: -1 };
    return { m, refus: null as string | null, tronconId: t.tronconId, pos, k: demander({ tronconId: t.tronconId, lat: pos.lat, lon: pos.lon }) };
  });

  interface PlanEvt { e: EvenementPayload; refus: string | null; passages: PassagePlan[]; kDebut: number; kFin: number }
  const evenementsPlan: PlanEvt[] = payload.evenements.map((e) => {
    if (e.statut === "ABANDONNE" || e.fin === null) return { e, refus: "ABANDONNE", passages: [], kDebut: -1, kFin: -1 };
    const plan = planifierEvenement(e.debut.tMs, e.fin.tMs, retenusTous, fenetreMs);
    if (plan.refus !== null) return { e, refus: plan.refus, passages: [], kDebut: -1, kFin: -1 };
    const premier = plan.passages[0];
    const dernier = plan.passages[plan.passages.length - 1];
    const posDebut = positionAuTemps(e.debut.tMs, brut, fenetreMs) ?? (e.debut.lat !== null && e.debut.lon !== null ? { lat: e.debut.lat, lon: e.debut.lon } : null);
    const posFin = positionAuTemps(e.fin.tMs, brut, fenetreMs) ?? (e.fin.lat !== null && e.fin.lon !== null ? { lat: e.fin.lat, lon: e.fin.lon } : null);
    return {
      e, refus: null, passages: plan.passages,
      kDebut: posDebut ? demander({ tronconId: premier.tronconId, ...posDebut }) : -1,
      kFin: posFin ? demander({ tronconId: dernier.tronconId, ...posFin }) : -1,
    };
  });

  const projections = await projeter(depot, demandes);

  // ---- 3. Territoire et codes de referentiel (lectures).
  const idsTroncons = new Set<string>();
  for (const p of evenementsPlan) for (const x of p.passages) idsTroncons.add(x.tronconId);
  const refusTerritoire = new Map<string, string>();
  if (idsTroncons.size > 0) {
    const u = await depot.user.findUnique({ where: { id: ctx.userId }, select: { role: true } });
    if (!u) return { ok: false, motif: "COMPTE_INTROUVABLE" };
    const perimetre = await perimetreDe({ id: ctx.userId, role: u.role });
    for (const id of idsTroncons) {
      const v = verifierTerritoire(perimetre, [await regionDuTroncon(id)]);
      if (!v.ok) refusTerritoire.set(id, v.code);
    }
  }
  const codesConnus = await codesDeReferentiel(depot, payload.evenements);

  // ---- 4. Assemblage.
  const marqueurs: MarqueurResolu[] = marqueursPlan.map((x) => {
    const base = { m: x.m, positionTrace: x.pos ? { lat: x.pos.lat, lon: x.pos.lon } : null };
    if (x.refus) return { ...base, statut: "NON_RATTACHE", motif: x.refus, tronconId: x.tronconId, abscisseM: null, distanceM: null };
    const pr = projections[x.k];
    if (!pr) return { ...base, statut: "NON_RATTACHE", motif: "TRONCON_SANS_GEOMETRIE", tronconId: x.tronconId, abscisseM: null, distanceM: null };
    if (pr.distanceM > DISTANCE_MAX_PROJECTION_M) {
      return { ...base, statut: "NON_RATTACHE", motif: "TROP_LOIN_DU_TRONCON", tronconId: x.tronconId, abscisseM: null, distanceM: arrondi(pr.distanceM) };
    }
    return { ...base, statut: "RATTACHE", motif: null, tronconId: x.tronconId, abscisseM: arrondi(pr.abscisseM), distanceM: arrondi(pr.distanceM) };
  });

  const evenements: EvenementResolu[] = evenementsPlan.map((p) => {
    if (p.refus === "ABANDONNE") return { e: p.e, statutRattachement: "ABANDONNE", motif: p.e.motifAbandon, troncons: [] };
    if (p.refus) return { e: p.e, statutRattachement: "NON_RATTACHE", motif: p.refus, troncons: [] };
    const q = p.e.qualification;
    const inconnu = q
      ? (["revetement", "etat", "praticabilite"] as const).find((c) => q[c] != null && !codesConnus[c].has(q[c] as string))
      : undefined;
    const troncons: TronconEvenement[] = p.passages.map((ps, rang) => {
      const pd = rang === 0 && p.kDebut >= 0 ? projections[p.kDebut] : null;
      const pf = rang === p.passages.length - 1 && p.kFin >= 0 ? projections[p.kFin] : null;
      const bonDebut = pd && pd.distanceM <= DISTANCE_MAX_PROJECTION_M ? pd : null;
      const bonFin = pf && pf.distanceM <= DISTANCE_MAX_PROJECTION_M ? pf : null;
      const entree = bonDebut ? bonDebut.abscisseM : ps.entreeM;
      const sortie = bonFin ? bonFin.abscisseM : ps.sortieM;
      const base: TronconEvenement = {
        rang, tronconId: ps.tronconId, debutM: null, finM: null, sens: null,
        methodeEntree: entree === null ? null : bonDebut ? "PROJECTION" : "POINT",
        methodeSortie: sortie === null ? null : bonFin ? "PROJECTION" : "POINT",
        etat: "REFUSEE", refus: null, portionId: null,
      };
      if (entree === null || sortie === null) return { ...base, refus: "ABSCISSE_INCONNUE" };
      const b = bornesPortion(arrondi(entree), arrondi(sortie));
      const avecBornes = { ...base, debutM: b.debutM, finM: b.finM, sens: b.sens };
      const terr = refusTerritoire.get(ps.tronconId);
      if (terr) return { ...avecBornes, refus: terr };
      if (inconnu) return { ...avecBornes, refus: `CODE_REFERENTIEL_INCONNU:${inconnu}` };
      return { ...avecBornes, etat: "A_CREER" };
    });
    return { e: p.e, statutRattachement: "PORTIONS_REFUSEES", motif: null, troncons };
  });

  const tauxRattachement = pointsRetenus > 0 ? Math.round((pointsRattaches / pointsRetenus) * 1000) / 1000 : null;
  if (transitions > 0 && !graphe) {
    avertissements.add(`${transitions} changement(s) de troncon non verifies sur le reseau (graphe non demande) : lire le taux de rattachement avec cette reserve.`);
  }
  const analyse: AnalyseSession = {
    parametres: { reseau, pasMinM: pasUtilises, distanceMaxM, fenetreRattachementMs: fenetreMs, distanceMaxProjectionM: DISTANCE_MAX_PROJECTION_M, graphe },
    indicateurs: {
      pointsRecus: payload.points.length,
      segments: parSegment.size,
      segmentsAnalyses,
      segmentsIgnores,
      pointsRetenus,
      pointsRattaches,
      tauxRattachement,
      transitionsNonVerifiees: transitions,
      passages,
      horsReferentiel: horsRef,
      distanceParcourueM: distanceParcourue,
    },
    avertissements: [...avertissements].slice(0, 50),
  };
  const segmentsPourGeom = [...parSegment.entries()].sort((a, b) => a[0] - b[0]).map(([, pts]) => pts);
  return { ok: true, plan: { payload, analyse, tauxRattachement, wktTrace: wkt(segmentsPourGeom), marqueurs, evenements } };
}

interface Projection { abscisseM: number; distanceM: number; longueurM: number }

/**
 * Projette des positions sur des troncons : abscisse = fraction x longueur geodesique, la MEME definition
 * que `geo/appariement.ts` et que la derivation de geometrie des portions. Un nombre part en TEXTE puis
 * est converti cote SQL (Prisma type un tableau de nombres d'apres son premier element).
 */
async function projeter(depot: Pick<DepotTrace, "$queryRaw">, demandes: readonly { tronconId: string; lat: number; lon: number }[]): Promise<(Projection | null)[]> {
  const sortie: (Projection | null)[] = demandes.map(() => null);
  if (demandes.length === 0) return sortie;
  const lignes = await depot.$queryRaw<{ k: number; abscisseM: number; distanceM: number; longueurM: number }[]>`
    WITH x AS (
      SELECT * FROM unnest(${demandes.map((d) => d.tronconId)}::text[], ${demandes.map((d) => String(d.lat))}::text[]::float8[], ${demandes.map((d) => String(d.lon))}::text[]::float8[])
        WITH ORDINALITY AS u(id, lat, lon, k)
    )
    SELECT (x.k - 1)::int AS "k",
           ST_LineLocatePoint(t."geom", p.pt) * ST_Length(t."geom"::geography) AS "abscisseM",
           ST_Distance(t."geom"::geography, p.pt::geography) AS "distanceM",
           ST_Length(t."geom"::geography) AS "longueurM"
      FROM x
      JOIN "troncons" t ON t."id" = x.id AND t."deletedAt" IS NULL AND t."geom" IS NOT NULL AND ST_GeometryType(t."geom") = 'ST_LineString'
      CROSS JOIN LATERAL (SELECT ST_SetSRID(ST_MakePoint(x.lon, x.lat), 4326) AS pt) p`;
  for (const l of lignes) sortie[Number(l.k)] = { abscisseM: Number(l.abscisseM), distanceM: Number(l.distanceM), longueurM: Number(l.longueurM) };
  return sortie;
}

type CodesConnus = { revetement: Set<string>; etat: Set<string>; praticabilite: Set<string> };

async function codesDeReferentiel(
  depot: Pick<typeof prisma, "referentielRevetement" | "referentielEtatChaussee" | "referentielPraticabilite">,
  evenements: readonly EvenementPayload[],
): Promise<CodesConnus> {
  const demandes = { revetement: new Set<string>(), etat: new Set<string>(), praticabilite: new Set<string>() };
  for (const e of evenements) {
    if (e.statut === "ABANDONNE" || !e.qualification) continue;
    for (const c of ["revetement", "etat", "praticabilite"] as const) {
      const v = e.qualification[c];
      if (v != null) demandes[c].add(v);
    }
  }
  const lire = async (d: Set<string>, f: (codes: string[]) => Promise<{ code: string }[]>) => new Set((d.size ? await f([...d]) : []).map((x) => x.code));
  return {
    revetement: await lire(demandes.revetement, (c) => depot.referentielRevetement.findMany({ where: { code: { in: c }, actif: true }, select: { code: true } })),
    etat: await lire(demandes.etat, (c) => depot.referentielEtatChaussee.findMany({ where: { code: { in: c }, actif: true }, select: { code: true } })),
    praticabilite: await lire(demandes.praticabilite, (c) => depot.referentielPraticabilite.findMany({ where: { code: { in: c }, actif: true }, select: { code: true } })),
  };
}

// ------------------------------------------------------------------ ecriture

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Ecrit la session dans la transaction du protocole de synchronisation.
 *
 * L'ordre n'est pas libre : session, marqueurs, puis les PORTIONS (dont l'issue fixe le statut des
 * evenements), puis les evenements, puis leurs liens. Tout est ou rien ; l'audit est dans la transaction.
 */
export async function ecrireSessionRoulage(tx: ClientTx, plan: PlanSession, ctx: ContexteSession): Promise<ResultatEcriture> {
  const p = plan.payload;
  const t = tx as unknown as { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number> };
  const json = (x: unknown) => JSON.stringify(x);

  await t.$executeRaw`
    INSERT INTO "sessions_roulage" ("id", "clientOperationId", "userId", "appareilId", "missionId", "debutA", "finA", "versionContrat",
      "provenanceParametres", "parametres", "nbPoints", "points", "trous", "interruptions", "pauses", "compteurs", "analyse",
      "tauxRattachement", "geom", "updatedAt")
    VALUES (${p.sessionId}, ${ctx.operationId}, ${ctx.userId}, ${ctx.appareilId}, ${p.missionId},
      (${iso(p.debutMs)}::timestamptz AT TIME ZONE 'UTC'), (${iso(p.finMs)}::timestamptz AT TIME ZONE 'UTC'), ${p.versionContrat},
      ${p.provenanceParametres}, ${json(p.parametres)}::jsonb, ${p.points.length}, ${json(p.points)}::jsonb, ${json(p.trous)}::jsonb,
      ${json(p.interruptions)}::jsonb, ${json(p.pauses)}::jsonb, ${json(p.compteurs)}::jsonb, ${json(plan.analyse)}::jsonb,
      ${plan.tauxRattachement}::float8,
      CASE WHEN ${plan.wktTrace} = '' THEN NULL ELSE ST_GeomFromText(${plan.wktTrace}, 4326) END, now())`;

  if (plan.marqueurs.length > 0) {
    const lignes = plan.marqueurs.map((x) => ({
      id: x.m.id, code: x.m.code, note: x.m.note, poseA: iso(x.m.repere.tMs), lat: x.m.repere.lat, lon: x.m.repere.lon,
      precisionM: x.m.repere.precisionM, ageFixMs: x.m.repere.ageFixMs, positionPerimee: x.m.repere.positionPerimee,
      latenceLogicielleMs: x.m.latenceLogicielleMs, statut: x.statut, motif: x.motif, tronconId: x.tronconId,
      abscisseM: x.abscisseM, distanceM: x.distanceM, positionTraceLat: x.positionTrace?.lat ?? null, positionTraceLon: x.positionTrace?.lon ?? null,
    }));
    await t.$executeRaw`
      INSERT INTO "marqueurs_roulage" ("sessionId", "id", "code", "note", "poseA", "lat", "lon", "precisionM", "ageFixMs", "positionPerimee",
        "latenceLogicielleMs", "statut", "motif", "tronconId", "abscisseM", "distanceM", "positionTraceLat", "positionTraceLon", "geom")
      SELECT ${p.sessionId}, m."id", m."code", m."note", (m."poseA"::timestamptz AT TIME ZONE 'UTC'), m."lat", m."lon", m."precisionM", m."ageFixMs",
             m."positionPerimee", m."latenceLogicielleMs", m."statut", m."motif", m."tronconId", m."abscisseM", m."distanceM",
             m."positionTraceLat", m."positionTraceLon",
             CASE WHEN m."positionTraceLat" IS NOT NULL THEN ST_SetSRID(ST_MakePoint(m."positionTraceLon", m."positionTraceLat"), 4326) END
        FROM jsonb_to_recordset(${json(lignes)}::jsonb) AS m("id" text, "code" text, "note" text, "poseA" text, "lat" float8, "lon" float8,
          "precisionM" float8, "ageFixMs" int, "positionPerimee" boolean, "latenceLogicielleMs" float8, "statut" text, "motif" text,
          "tronconId" text, "abscisseM" float8, "distanceM" float8, "positionTraceLat" float8, "positionTraceLon" float8)`;
  }

  // Les portions : le MEME service que la route en ligne, dans CETTE transaction.
  const depotPortions = depotDans(tx);
  let creees = 0;
  let refusees = 0;
  for (const ev of plan.evenements) {
    for (const tr of ev.troncons) {
      if (tr.etat !== "A_CREER") { refusees += 1; continue; }
      const q = ev.e.qualification;
      const r = await creerPortion({
        tronconId: tr.tronconId,
        debutM: tr.debutM as number,
        finM: tr.finM as number,
        revetement: q?.revetement ?? null,
        etat: q?.etat ?? null,
        praticabilite: q?.praticabilite ?? null,
        largeurM: q?.largeurM ?? null,
        source: `roulage:${p.sessionId}`,
        observeeLe: new Date(ev.e.debut.tMs),
        // Cle d'idempotence derivee de l'operation du protocole, de l'evenement et du rang.
        clientOperationId: `${ctx.operationId}:${ev.e.id}:${tr.rang}`,
      }, ctx.userId, depotPortions);
      if (r.refus !== null) { tr.etat = "REFUSEE"; tr.refus = r.refus; refusees += 1; continue; }
      tr.etat = "CREEE";
      tr.portionId = r.valeur.id;
      creees += 1;
    }
    if (ev.statutRattachement !== "ABANDONNE" && ev.statutRattachement !== "NON_RATTACHE") {
      const nbCreees = ev.troncons.filter((x) => x.etat === "CREEE").length;
      ev.statutRattachement = nbCreees === 0 ? "PORTIONS_REFUSEES" : nbCreees === ev.troncons.length ? "PORTIONS_CREEES" : "PORTIONS_PARTIELLES";
      if (nbCreees === 0 && ev.troncons.length > 0) ev.motif = ev.troncons[0].refus;
    }
  }

  if (plan.evenements.length > 0) {
    const lignes = plan.evenements.map((ev) => ({
      id: ev.e.id, code: ev.e.code, note: ev.e.note, statutAppareil: ev.e.statut, qualification: ev.e.qualification,
      debutA: iso(ev.e.debut.tMs), finA: ev.e.fin ? iso(ev.e.fin.tMs) : null, debut: ev.e.debut, fin: ev.e.fin,
      couvertureGnss: ev.e.couvertureGnss, distanceDirecteM: ev.e.distanceDirecteM, avertissements: ev.e.avertissements,
      motifAbandon: ev.e.motifAbandon, statutRattachement: ev.statutRattachement, motif: ev.motif, troncons: ev.troncons,
    }));
    await t.$executeRaw`
      INSERT INTO "evenements_roulage" ("sessionId", "id", "code", "note", "statutAppareil", "qualification", "debutA", "finA", "debut", "fin",
        "couvertureGnss", "distanceDirecteM", "avertissements", "motifAbandon", "statutRattachement", "motif", "troncons")
      SELECT ${p.sessionId}, e."id", e."code", e."note", e."statutAppareil", e."qualification", (e."debutA"::timestamptz AT TIME ZONE 'UTC'),
             (e."finA"::timestamptz AT TIME ZONE 'UTC'), e."debut", e."fin", e."couvertureGnss", e."distanceDirecteM", e."avertissements",
             e."motifAbandon", e."statutRattachement", e."motif", e."troncons"
        FROM jsonb_to_recordset(${json(lignes)}::jsonb) AS e("id" text, "code" text, "note" text, "statutAppareil" text, "qualification" jsonb,
          "debutA" text, "finA" text, "debut" jsonb, "fin" jsonb, "couvertureGnss" float8, "distanceDirecteM" float8, "avertissements" jsonb,
          "motifAbandon" text, "statutRattachement" text, "motif" text, "troncons" jsonb)`;

    const liens = plan.evenements.flatMap((ev) => ev.troncons.filter((x) => x.etat === "CREEE").map((x) => ({
      evenementId: ev.e.id, rang: x.rang, portionId: x.portionId, tronconId: x.tronconId, debutM: x.debutM, finM: x.finM, sens: x.sens,
    })));
    if (liens.length > 0) {
      await t.$executeRaw`
        INSERT INTO "evenements_roulage_portions" ("sessionId", "evenementId", "rang", "portionId", "tronconId", "debutM", "finM", "sens")
        SELECT ${p.sessionId}, l."evenementId", l."rang", l."portionId", l."tronconId", l."debutM", l."finM", l."sens"
          FROM jsonb_to_recordset(${json(liens)}::jsonb) AS l("evenementId" text, "rang" int, "portionId" text, "tronconId" text,
            "debutM" float8, "finM" float8, "sens" text)`;
    }
  }

  const marqueursRattaches = plan.marqueurs.filter((m) => m.statut === "RATTACHE").length;
  // UN AUDIT PAR SESSION, dans la transaction : les identifiants de tout ce qui a ete ecrit y sont. Les
  // portions ont chacune leur ligne d'audit (posee par le depot) ; la trace brute, trop volumineuse pour
  // un journal d'audit, n'y figure que par son effectif.
  await logAuditTransactionnelle(tx, {
    userId: ctx.userId,
    action: AuditAction.CREATE,
    entityType: "SessionRoulage",
    entityId: p.sessionId,
    after: {
      operationId: ctx.operationId, appareilId: ctx.appareilId, missionId: p.missionId, nbPoints: p.points.length,
      tauxRattachement: plan.tauxRattachement,
      marqueurs: plan.marqueurs.map((m) => ({ id: m.m.id, code: m.m.code, statut: m.statut, tronconId: m.tronconId })),
      evenements: plan.evenements.map((e) => ({
        id: e.e.id, code: e.e.code, statut: e.statutRattachement,
        portions: e.troncons.filter((x) => x.etat === "CREEE").map((x) => x.portionId),
      })),
    },
  });

  return {
    sessionId: p.sessionId,
    marqueurs: plan.marqueurs.length,
    marqueursRattaches,
    evenements: plan.evenements.length,
    portionsCreees: creees,
    portionsRefusees: refusees,
  };
}
