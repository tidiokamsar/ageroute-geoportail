import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * A7 cote file locale : « hors ligne, 50 observations, 0 doublon, 0 perte ».
 *
 * CE QUE CES TESTS FONT ET NE FONT PAS
 *
 * La vraie file (`offlineSync.ts`) est rejouee contre un SERVEUR SIMULE ECRIT DANS CE FICHIER. Il applique les
 * regles du protocole telles que `backend/src/field/sync.service.ts` les code pour une CREATE d'Observation :
 *
 *   - schema strict du payload (`observation-sync-payload.ts`) : sinon REJETE PAYLOAD_INVALIDE:Observation,
 *     definitif (sans `reessayerDansMs`), trace une fois, jamais reevalue ;
 *   - operationId deja traite : le resultat PRECEDENT est rendu (SYNCHRONISE -> REJOUEE, CONFLIT -> le meme
 *     conflit, REJETE definitif -> le meme refus), via `resultatPrecedent` ; un refus retentable
 *     (REFERENCE_INCONNUE, ENTITE_INTROUVABLE) est reevalue (`rejetRetentable`) ;
 *   - operationId d'un autre compte : REJETE OPERATION_NON_AUTORISEE ;
 *   - meme entityId sous un operationId NEUF : CONFLIT DEJA_EXISTANTE, avec un conflitId (`decider`) ;
 *   - mission non autorisee : REJETE MISSION_NON_AUTORISEE, definitif ;
 *   - reference inconnue (tronconId) : REJETE REFERENCE_INCONNUE:tronconId avec `reessayerDansMs` ;
 *   - sinon : ecrit UNE ligne, SYNCHRONISE avec entityId.
 *
 * C'est une COPIE de regles lues dans le code, pas le code : elle peut diverger. Le serveur reel est eprouve
 * contre PostGIS par `backend/tests-integration/sync.integration.mts` (67 verifications) ; l'accord entre les
 * deux n'est pas mecanise.
 *
 * Ce n'est PAS une preuve sur appareil. IndexedDB (ici un Map), le service worker, l'evenement `online` d'un
 * telephone et la perte de reseau reelle ne s'eprouvent que sur un appareil. Aucun essai n'a ete fait avec 50
 * observations reelles.
 */

type Panne = "aucune" | "coupure" | "reponse_perdue" | "http500";

const sim = vi.hoisted(() => {
  const S = {
    /** operationId -> trace du serveur (une ligne par operation, comme `operations_sync`). */
    operations: new Map<string, { statut: string; motif?: string; entityId: string; userId: string; conflitId?: string }>(),
    /** entityId -> ligne creee. Un doublon ferait apparaitre deux lignes pour une meme saisie. */
    observations: [] as { id: string; clientOperationId: string }[],
    conflits: [] as { id: string; operationId: string; resolution: string | null }[],
    /** Ce qui existe deja ailleurs (pour provoquer un conflit de creation). */
    entitesExistantes: new Set<string>(),
    troncons: new Set<string>(),
    /** Missions que le compte n'a pas le droit d'utiliser. */
    missionsInterdites: new Set<string>(),
    appels: 0,
    /** Ordre dans lequel le serveur a RECU les operations (y compris rejeux). */
    recues: [] as string[],
    panne: (_appel: number): Panne => "aucune",
    utilisateur: "u1",
  };

  const ENUM_TYPE = ["DEGRADATION", "CHAUSSEE", "ASSAINISSEMENT", "SIGNALISATION", "OUVRAGE", "SECURITE", "TRAFIC", "ENVIRONNEMENT", "CHANTIER", "INCIDENT", "AUTRE"] as const;
  return { S, ENUM_TYPE };
});

// Copie du schema strict de creation (backend/src/field/observation-sync-payload.ts, `creationObservation`).
const creationObservation = z.object({
  type: z.enum(sim.ENUM_TYPE),
  gravite: z.enum(["FAIBLE", "MOYENNE", "FORTE"]).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  missionId: z.string().uuid().nullable().optional(),
  tronconId: z.string().min(1).max(128).nullable().optional(),
  ouvrageId: z.string().min(1).max(128).nullable().optional(),
  chantierId: z.string().min(1).max(128).nullable().optional(),
  pk: z.number().finite().nonnegative().nullable().optional(),
  lat: z.number().finite().min(-90).max(90).nullable().optional(),
  lon: z.number().finite().min(-180).max(180).nullable().optional(),
  precisionM: z.number().finite().nonnegative().max(100_000).nullable().optional(),
  observeA: z.string().datetime(),
}).strict();

type Op = { operationId: string; entityType: string; entityId: string; operation: string; baseVersion: number | null; payload: Record<string, unknown> };
type ResultatSim = { operationId: string; statut: "SYNCHRONISE" | "REJOUEE" | "CONFLIT" | "REJETE"; entityId?: string; motif?: string; conflitId?: string; reessayerDansMs?: number };

const RETENTABLE = (motif: string | undefined) => motif === "ENTITE_INTROUVABLE" || (motif?.startsWith("REFERENCE_INCONNUE") ?? false);

/** Le serveur simule : applique UNE operation (sync.service.ts, appliquerUneFois, branche Observation CREATE). */
function appliquerSim(op: Op): ResultatSim {
  const { S } = sim;
  if (op.entityType !== "Observation") return { operationId: op.operationId, statut: "REJETE", motif: `TYPE_NON_SUPPORTE:${op.entityType}` };

  const deja = S.operations.get(op.operationId);
  if (deja) {
    if (deja.userId !== S.utilisateur) return { operationId: op.operationId, statut: "REJETE", motif: "OPERATION_NON_AUTORISEE" };
    if (deja.statut === "CONFLIT") return { operationId: op.operationId, statut: "CONFLIT", motif: deja.motif, conflitId: deja.conflitId };
    if (deja.statut === "REJETE" && !RETENTABLE(deja.motif)) return { operationId: op.operationId, statut: "REJETE", motif: deja.motif };
    if (deja.statut === "SYNCHRONISE") return { operationId: op.operationId, statut: "REJOUEE", entityId: deja.entityId };
    // refus retentable : reevalue ci-dessous
  }

  const trace = (statut: string, motif?: string, conflitId?: string) =>
    S.operations.set(op.operationId, { statut, motif, entityId: op.entityId, userId: S.utilisateur, conflitId });

  if (op.operation !== "CREATE") return { operationId: op.operationId, statut: "REJETE", motif: `OPERATION_NON_SUPPORTEE:Observation:${op.operation}` };
  const analyse = creationObservation.safeParse(op.payload);
  if (!analyse.success) {
    trace("REJETE", "PAYLOAD_INVALIDE:Observation");
    return { operationId: op.operationId, statut: "REJETE", motif: "PAYLOAD_INVALIDE:Observation" };
  }
  const p = analyse.data;

  if (S.entitesExistantes.has(op.entityId) || S.observations.some((o) => o.id === op.entityId && o.clientOperationId !== op.operationId)) {
    const conflit = { id: `conflit-${S.conflits.length + 1}`, operationId: op.operationId, resolution: null as string | null };
    S.conflits.push(conflit);
    trace("CONFLIT", "DEJA_EXISTANTE", conflit.id);
    return { operationId: op.operationId, statut: "CONFLIT", motif: "DEJA_EXISTANTE", conflitId: conflit.id };
  }
  if (p.missionId && S.missionsInterdites.has(p.missionId)) {
    trace("REJETE", "MISSION_NON_AUTORISEE");
    return { operationId: op.operationId, statut: "REJETE", motif: "MISSION_NON_AUTORISEE" };
  }
  if (p.tronconId && !S.troncons.has(p.tronconId)) {
    trace("REJETE", "REFERENCE_INCONNUE:tronconId");
    return { operationId: op.operationId, statut: "REJETE", motif: "REFERENCE_INCONNUE:tronconId", reessayerDansMs: 8_000 };
  }

  S.observations.push({ id: op.entityId, clientOperationId: op.operationId });
  trace("SYNCHRONISE");
  return { operationId: op.operationId, statut: "SYNCHRONISE", entityId: op.entityId };
}

/** Un responsable tranche le conflit en faveur du serveur (route `/resolve`, SERVEUR). */
function trancherServeur(conflitId: string) {
  const { S } = sim;
  const c = S.conflits.find((x) => x.id === conflitId)!;
  c.resolution = "SERVEUR";
  const op = S.operations.get(c.operationId)!;
  S.operations.set(c.operationId, { ...op, statut: "REJETE", motif: "CONFLIT_RESOLU_VERSION_SERVEUR" });
}

function erreurReseau(): Error {
  return Object.assign(new Error("Network Error"), { isAxiosError: true, code: "ERR_NETWORK", response: undefined });
}

vi.mock("./api", () => ({
  api: {
    post: vi.fn(async (url: string, corps: { operations?: Op[] }) => {
      const { S } = sim;
      if (url === "/v2/devices") return { data: { id: "device-u1" } };
      if (url !== "/v2/sync/push") throw new Error(`appel inattendu ${url}`);
      S.appels += 1;
      const panne = S.panne(S.appels);
      if (panne === "coupure") throw erreurReseau();   // la requete n'arrive jamais
      if (panne === "http500") {
        throw Object.assign(new Error("Request failed with status code 500"), { isAxiosError: true, response: { status: 500, data: { message: "erreur interne" } } });
      }
      const op = corps.operations![0];
      S.recues.push(op.operationId);
      const resultat = appliquerSim(op);
      if (panne === "reponse_perdue") throw erreurReseau();   // le serveur a traite, la reponse ne revient pas
      return { data: { resultats: [resultat] } };
    }),
  },
}));

// ------------------------------------------------------------------ magasin local simule (IndexedDB = Map)
type Local = {
  localId: string; ownerUserId?: string; payload: Record<string, unknown>; createdAt: string;
  status: string; errorMessage?: string; tentatives?: number; refusDefinitif?: boolean; conflitId?: string; motifConflit?: string;
};
const file = new Map<string, Local>();
const retraitEchoue = { fois: 0 };
vi.mock("./offlineDb", () => ({
  getAllPending: vi.fn(async () => []),
  getAllPendingDefauts: vi.fn(async () => []),
  getAllPendingPortions: vi.fn(async () => []),
  getAllPendingObservations: vi.fn(async () => [...file.values()].map((o) => structuredClone(o))),
  updatePendingObservation: vi.fn(async (i: Local) => { file.set(i.localId, structuredClone(i)); }),
  removePendingObservation: vi.fn(async (id: string) => {
    if (retraitEchoue.fois > 0) { retraitEchoue.fois -= 1; throw new Error("stockage local indisponible"); }
    file.delete(id);
  }),
  updatePendingInspection: vi.fn(async () => undefined),
  removePendingInspection: vi.fn(async () => undefined),
  updatePendingDefaut: vi.fn(async () => undefined),
  removePendingDefaut: vi.fn(async () => undefined),
  updatePendingPortion: vi.fn(async () => undefined),
  removePendingPortion: vi.fn(async () => undefined),
}));

import { api } from "./api";
import { configurerUtilisateurSync, getSyncState, refreshPendingCount, relancerObservation, syncPendingOfflineData } from "./offlineSync";

const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

function deposer(n: number, over: Partial<Local> = {}, payload: Record<string, unknown> = {}): string {
  const localId = uuid(n);
  file.set(localId, {
    localId, ownerUserId: "u1", status: "pending",
    createdAt: new Date(Date.UTC(2026, 9, 20, 8, 0, n)).toISOString(),
    payload: {
      type: "DEGRADATION", gravite: "MOYENNE", description: `observation ${n}`,
      lat: 9.5 + n * 1e-5, lon: -13.7, precisionM: 5, observeA: new Date(Date.UTC(2026, 9, 20, 8, 0, n)).toISOString(), ...payload,
    },
    ...over,
  });
  return localId;
}
const deposerN = (nombre: number) => Array.from({ length: nombre }, (_, i) => deposer(i + 1));

const parStatut = () => {
  const m: Record<string, number> = {};
  for (const o of file.values()) m[o.status] = (m[o.status] ?? 0) + 1;
  return m;
};

/** Doublons : plusieurs lignes serveur pour un meme operationId OU pour un meme entityId. */
const doublons = () => {
  const { S } = sim;
  const cles = new Set<string>(); const ids = new Set<string>(); let d = 0;
  for (const o of S.observations) {
    if (cles.has(o.clientOperationId) || ids.has(o.id)) d += 1;
    cles.add(o.clientOperationId); ids.add(o.id);
  }
  return d;
};

/** Journal des mesures, une ligne par etape : ce qui reste dans la file, ce que le serveur porte, les doublons. */
const journal: { etape: string; enFile: number; parStatut: Record<string, number>; serveur: number; doublons: number; appels: number; compteur: number }[] = [];
async function mesurer(etape: string) {
  await refreshPendingCount();
  const ligne = {
    etape, enFile: file.size, parStatut: parStatut(), serveur: sim.S.observations.length,
    doublons: doublons(), appels: sim.S.appels, compteur: getSyncState().pendingCount,
  };
  journal.push(ligne);
  return ligne;
}

afterAll(() => {
  // Mesure consignee : « ce qui reste dans la file a chaque etape ».
  console.info(`A7 client (serveur simule) :\n${journal.map((l) =>
    `  ${l.etape.padEnd(58)} file=${String(l.enFile).padStart(2)} ${JSON.stringify(l.parStatut).padEnd(34)} serveur=${String(l.serveur).padStart(2)} doublons=${l.doublons} appels=${l.appels}`).join("\n")}`);
});

beforeEach(() => {
  file.clear();
  retraitEchoue.fois = 0;
  const { S } = sim;
  S.operations.clear(); S.observations.length = 0; S.conflits.length = 0; S.entitesExistantes.clear();
  S.troncons = new Set(["troncon-connu"]); S.missionsInterdites.clear(); S.appels = 0; S.recues.length = 0;
  S.panne = () => "aucune"; S.utilisateur = "u1";
  vi.mocked(api.post).mockClear();
  localStorage.clear();
  configurerUtilisateurSync("u1");
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

describe("A7 client : 50 observations, 0 doublon, 0 perte", () => {
  it("reseau sain : 50 envoyees, file vide, 50 lignes serveur, aucun doublon", async () => {
    deposerN(50);
    expect((await mesurer("depart : 50 en file")).enFile).toBe(50);
    await syncPendingOfflineData();
    const l = await mesurer("reseau sain, une passe");
    expect(l).toMatchObject({ enFile: 0, serveur: 50, doublons: 0, compteur: 0 });
  });

  it("coupure au milieu (appels 21 a 25) : 45 passent, 5 RESTENT en file, la reprise ne fait que le reste", async () => {
    deposerN(50);
    sim.S.panne = (a) => (a > 20 && a <= 25 ? "coupure" : "aucune");
    await syncPendingOfflineData();
    const l1 = await mesurer("coupure appels 21-25, passe 1");
    expect(l1).toMatchObject({ enFile: 5, serveur: 45, doublons: 0, compteur: 5 });
    // Un reseau muet n'est PAS un echec de la saisie : aucune n'est abandonnee, aucune tentative comptee.
    expect([...file.values()].every((o) => o.status === "error" && (o.tentatives ?? 0) === 0)).toBe(true);

    const appelsAvant = sim.S.appels;
    await syncPendingOfflineData();
    const l2 = await mesurer("reprise, passe 2");
    expect(l2).toMatchObject({ enFile: 0, serveur: 50, doublons: 0 });
    expect(sim.S.appels - appelsAvant).toBe(5);   // seules les 5 restantes sont renvoyees
  });

  it("REPONSES PERDUES (le serveur a ecrit, la reponse ne revient pas) : tout reste en file, puis les rejeux ne creent AUCUN doublon", async () => {
    deposerN(50);
    sim.S.panne = (a) => (a >= 10 && a < 15 ? "reponse_perdue" : "aucune");
    await syncPendingOfflineData();
    const l1 = await mesurer("5 reponses perdues, passe 1");
    // Le serveur a ecrit les 50 ; le telephone n'en sait que 45 : 5 restent en file alors qu'elles sont deja la-bas.
    expect(l1).toMatchObject({ enFile: 5, serveur: 50, doublons: 0 });

    await syncPendingOfflineData();
    const l2 = await mesurer("rejeu des 5 (REJOUEE), passe 2");
    expect(l2).toMatchObject({ enFile: 0, serveur: 50, doublons: 0 });
  });

  it("RETRAIT LOCAL QUI ECHOUE apres confirmation du serveur : l'observation reste en file, le rejeu la rend REJOUEE sans doublon", async () => {
    deposerN(50);
    retraitEchoue.fois = 3;
    await syncPendingOfflineData();
    const l1 = await mesurer("3 retraits de file en echec, passe 1");
    expect(l1).toMatchObject({ enFile: 3, serveur: 50, doublons: 0 });
    await syncPendingOfflineData();
    expect(await mesurer("rejeu, passe 2")).toMatchObject({ enFile: 0, serveur: 50, doublons: 0 });
  });

  it("ORDRE INVERSE : une file saisie a l'envers part dans l'ordre de saisie, et le resultat est identique", async () => {
    // Saisies 50..1 : la cle (localId) croit quand la date decroit.
    for (let n = 50; n >= 1; n--) deposer(n, { createdAt: new Date(Date.UTC(2026, 9, 20, 8, 0, 51 - n)).toISOString() });
    await syncPendingOfflineData();
    const l = await mesurer("file saisie a l'envers, une passe");
    expect(l).toMatchObject({ enFile: 0, serveur: 50, doublons: 0 });
    // Le serveur a recu dans l'ordre de createdAt (la plus ancienne d'abord), pas dans l'ordre des cles.
    expect(sim.S.recues[0]).toBe(uuid(50));
    expect(sim.S.recues[49]).toBe(uuid(1));
  });

  it("REJEUX : la meme file rejouee depuis une sauvegarde de l'etat local, trois fois, n'ajoute rien", async () => {
    deposerN(50);
    const instantane = [...file.values()].map((o) => structuredClone(o));
    await syncPendingOfflineData();
    expect((await mesurer("passe unique")).serveur).toBe(50);
    // L'etat local d'avant est restaure (stockage restaure apres un incident) : la file reprend les 50.
    for (let i = 1; i <= 3; i++) {
      for (const o of instantane) file.set(o.localId, structuredClone(o));
      await syncPendingOfflineData();
      expect(await mesurer(`rejeu ${i} depuis l'instantane`)).toMatchObject({ enFile: 0, serveur: 50, doublons: 0 });
    }
    expect(sim.S.operations.size).toBe(50);   // une trace par operation, jamais plus
  });

  it("CHAOS reproductible : coupures, reponses perdues et erreurs 500 melangees sur 200 appels, 0 doublon, 0 perte, la file ne grossit jamais", async () => {
    deposerN(50);
    let graine = 20261023;
    const alea = () => { graine = (graine + 0x6d2b79f5) | 0; let t = Math.imul(graine ^ (graine >>> 15), 1 | graine); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    sim.S.panne = (a) => {
      if (a > 150) return "aucune";   // le reseau finit par revenir
      const r = alea();
      return r < 0.18 ? "coupure" : r < 0.34 ? "reponse_perdue" : r < 0.4 ? "http500" : "aucune";
    };
    let precedent = 50; let passes = 0;
    while (file.size > 0 && passes < 40) {
      passes += 1;
      // Un 500 compte comme un echec consecutif : on remet les tentatives a zero entre deux passes pour mesurer
      // la perte eventuelle, pas le plafond (teste a part ci-dessous).
      for (const o of file.values()) if (o.status === "abandonnee") o.status = "error";
      await syncPendingOfflineData();
      const l = await mesurer(`chaos, passe ${passes}`);
      expect(l.enFile).toBeLessThanOrEqual(precedent);   // jamais plus qu'avant : rien n'est ajoute
      expect(l.doublons).toBe(0);
      precedent = l.enFile;
    }
    const fin = await mesurer("chaos, fin");
    expect(fin).toMatchObject({ enFile: 0, serveur: 50, doublons: 0 });
    // 0 perte, mesure SUR LE SERVEUR : chaque saisie a sa ligne, sous sa cle.
    expect(new Set(sim.S.observations.map((o) => o.clientOperationId)).size).toBe(50);
  });
});

describe("Refus, erreurs et plafond : la file ne perd jamais une saisie, elle la marque", () => {
  it("un refus DEFINITIF (payload hors schema) marque l'observation abandonnee, VISIBLE, sans bloquer les 49 autres, et n'est pas retentee", async () => {
    deposerN(49);
    const mauvaise = deposer(50, {}, { type: "TYPE_INVENTE" });
    await syncPendingOfflineData();
    const l = await mesurer("1 refus definitif parmi 50");
    expect(l).toMatchObject({ enFile: 1, serveur: 49, doublons: 0 });
    const o = file.get(mauvaise)!;
    expect(o).toMatchObject({ status: "abandonnee", refusDefinitif: true });
    expect(o.errorMessage).toContain("PAYLOAD_INVALIDE:Observation");

    const appelsAvant = sim.S.appels;
    await syncPendingOfflineData();
    await syncPendingOfflineData();
    expect(sim.S.appels).toBe(appelsAvant);   // plus retentee: pas de boucle a chaque retour du reseau
    expect(file.has(mauvaise)).toBe(true);    // ... et pas effacee
  });

  it("une cle de plus dans la saisie suffit a faire refuser (schema serveur strict) : le refus est lisible, pas silencieux", async () => {
    const id = deposer(1, {}, { statut: "VALIDEE" });   // champ systeme, interdit au telephone
    await syncPendingOfflineData();
    expect(file.get(id)).toMatchObject({ status: "abandonnee", refusDefinitif: true });
    expect(sim.S.observations).toHaveLength(0);
  });

  it("un refus TEMPORAIRE (reference inconnue, reessayerDansMs) reste en file `error` et passe quand la reference arrive", async () => {
    const id = deposer(1, {}, { tronconId: "troncon-futur" });
    await syncPendingOfflineData();
    expect(file.get(id)).toMatchObject({ status: "error", tentatives: 1 });
    expect(file.get(id)!.refusDefinitif).toBeUndefined();
    sim.S.troncons.add("troncon-futur");
    await syncPendingOfflineData();
    expect((await mesurer("reference arrivee")).enFile).toBe(0);
    expect(sim.S.observations).toHaveLength(1);
  });

  it("5 erreurs serveur CONSECUTIVES : abandon marque et visible (jamais efface) ; `relancerObservation` la remet en file et elle passe", async () => {
    const id = deposer(1);
    sim.S.panne = () => "http500";
    for (let i = 0; i < 5; i++) await syncPendingOfflineData();
    expect(file.get(id)).toMatchObject({ status: "abandonnee", tentatives: 5 });
    expect(file.get(id)!.errorMessage).toMatch(/abandon après 5 échecs/);

    sim.S.panne = () => "aucune";
    await syncPendingOfflineData();
    expect(file.has(id)).toBe(true);   // abandonnee : plus retentee seule
    await relancerObservation(file.get(id) as never);
    expect(file.get(id)).toMatchObject({ status: "pending", tentatives: 0 });
    await syncPendingOfflineData();
    expect(file.size).toBe(0);
    expect(sim.S.observations).toHaveLength(1);
  });

  it("un reseau muet ne compte JAMAIS dans le plafond : 30 coupures de suite n'abandonnent rien", async () => {
    deposerN(50);
    sim.S.panne = () => "coupure";
    for (let i = 0; i < 30; i++) await syncPendingOfflineData();
    const l = await mesurer("30 passes sans reseau");
    expect(l).toMatchObject({ enFile: 50, serveur: 0, doublons: 0 });
    expect(parStatut()).toEqual({ error: 50 });
    sim.S.panne = () => "aucune";
    await syncPendingOfflineData();
    expect((await mesurer("le reseau revient")).enFile).toBe(0);
  });

  it("l'identifiant client est stable d'une tentative a l'autre et sert d'operationId ET d'entityId", async () => {
    const id = deposer(1);
    sim.S.panne = (a) => (a <= 3 ? "coupure" : "aucune");
    for (let i = 0; i < 4; i++) await syncPendingOfflineData();
    const ops = vi.mocked(api.post).mock.calls.filter((c) => c[0] === "/v2/sync/push").map((c) => (c[1] as { operations: Op[] }).operations[0]);
    expect(ops).toHaveLength(4);
    for (const op of ops) expect(op).toMatchObject({ operationId: id, entityId: id, entityType: "Observation", operation: "CREATE", baseVersion: null });
  });

  it("les saisies d'un AUTRE compte ne partent pas", async () => {
    deposer(1, { ownerUserId: "u2" });
    deposer(2);
    await syncPendingOfflineData();
    expect([...file.keys()]).toEqual([uuid(1)]);
    expect(sim.S.observations).toHaveLength(1);
  });
});

describe("A8 cote telephone : le conflit est signale, la saisie reste en file", () => {
  it("CONFLIT : l'observation RESTE en file, statut `conflit`, identifiant du conflit, comptee a part ET dans le total", async () => {
    deposerN(4);
    const enConflit = deposer(5);
    sim.S.entitesExistantes.add(enConflit);   // un autre appareil a deja cree cet objet
    await syncPendingOfflineData();
    const l = await mesurer("1 conflit parmi 5");
    expect(l).toMatchObject({ enFile: 1, serveur: 4, doublons: 0, compteur: 1 });
    const o = file.get(enConflit)!;
    expect(o).toMatchObject({ status: "conflit", conflitId: "conflit-1", motifConflit: "DEJA_EXISTANTE" });
    expect(o.errorMessage).toMatch(/Un responsable doit trancher/);
    expect(getSyncState()).toMatchObject({ pendingCount: 1, conflitCount: 1, abandonCount: 0 });
    expect(o.tentatives ?? 0).toBe(0);   // un conflit n'est pas un echec
  });

  it("renvoyee a chaque passe, elle rend le MEME conflit : jamais un second, jamais un succes, jamais retiree", async () => {
    const id = deposer(1);
    sim.S.entitesExistantes.add(id);
    for (let i = 0; i < 8; i++) await syncPendingOfflineData();
    expect(sim.S.conflits).toHaveLength(1);
    expect(file.get(id)).toMatchObject({ status: "conflit", conflitId: "conflit-1" });
    expect(sim.S.observations).toHaveLength(0);
    expect(file.get(id)!.tentatives ?? 0).toBe(0);   // 8 passes, aucun echec compte, jamais abandonnee
  });

  it("un reseau qui coupe pendant la verification NE FAIT PAS redevenir `erreur` une saisie en conflit", async () => {
    const id = deposer(1);
    sim.S.entitesExistantes.add(id);
    await syncPendingOfflineData();
    sim.S.panne = (a) => (a % 2 === 1 ? "coupure" : "http500");
    await syncPendingOfflineData();
    await syncPendingOfflineData();
    expect(file.get(id)).toMatchObject({ status: "conflit", conflitId: "conflit-1" });
  });

  it("quand un responsable retient la version du SERVEUR, la saisie est marquee abandonnee avec ce motif, et RESTE visible", async () => {
    const id = deposer(1);
    sim.S.entitesExistantes.add(id);
    await syncPendingOfflineData();
    trancherServeur("conflit-1");
    await syncPendingOfflineData();
    const o = file.get(id)!;
    expect(o).toMatchObject({ status: "abandonnee", refusDefinitif: true });
    expect(o.errorMessage).toMatch(/version du serveur/);
    expect(getSyncState()).toMatchObject({ pendingCount: 1, conflitCount: 0, abandonCount: 1 });
    // Plus retentee : le serveur a tranche.
    const avant = sim.S.appels;
    await syncPendingOfflineData();
    expect(sim.S.appels).toBe(avant);
  });

  it("si le conflit disparait cote serveur (la saisie est finalement acceptee), elle sort de la file sur REJOUEE/SYNCHRONISE", async () => {
    const id = deposer(1);
    sim.S.entitesExistantes.add(id);
    await syncPendingOfflineData();
    expect(file.get(id)!.status).toBe("conflit");
    // Le serveur "oublie" le conflit : l'objet concurrent n'existe plus et la trace est effacee (cas d'ecole).
    sim.S.entitesExistantes.clear();
    sim.S.operations.delete(uuid(1));
    await syncPendingOfflineData();
    expect(file.size).toBe(0);
    expect(sim.S.observations).toHaveLength(1);
  });
});
