import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./offlineSync", () => ({
  refreshPendingCount: vi.fn(async () => undefined),
  syncPendingOfflineData: vi.fn(async () => undefined),
}));
const ajoutees: unknown[] = [];
vi.mock("./offlineDb", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addPendingObservation: vi.fn(async (o: unknown) => { ajoutees.push(o); }),
}));

import {
  GRAVITES_OBSERVATION, TYPES_OBSERVATION,
} from "./offlineDb";
import {
  construireObservation, enregistrerObservation, estUuid, libelleStatutObservation, nouvelIdentifiant,
} from "./observationsTerrain";

/**
 * La saisie d'une observation ne doit emettre QUE ce que le serveur accepte. Son schema est strict : une cle
 * de plus fait refuser l'operation en entier, definitivement, au retour du reseau, quand l'agent ne peut plus
 * corriger. On valide donc sur le terrain ce que le serveur validera.
 */

const MAINTENANT = new Date("2026-10-23T09:30:00.000Z");
const ctx = { userId: "u1", maintenant: MAINTENANT, identifiant: "11111111-1111-4111-8111-111111111111" };

describe("construireObservation", () => {
  it("emet exactement les champs du protocole, la date du constat, et un statut `pending`", () => {
    const r = construireObservation({
      type: "DEGRADATION", gravite: "FORTE", description: "  Nid de poule profond  ",
      lat: 9.5, lon: -13.7, precisionM: 6, tronconId: "troncon-1", missionId: "22222222-2222-4222-8222-222222222222",
    }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.observation).toEqual({
      localId: ctx.identifiant, ownerUserId: "u1", createdAt: MAINTENANT.toISOString(), status: "pending",
      payload: {
        type: "DEGRADATION", gravite: "FORTE", description: "Nid de poule profond", lat: 9.5, lon: -13.7, precisionM: 6,
        tronconId: "troncon-1", missionId: "22222222-2222-4222-8222-222222222222", observeA: MAINTENANT.toISOString(),
      },
    });
  });

  it("n'emet AUCUNE cle vide ni aucun champ systeme (auteur, statut, version, validation)", () => {
    const r = construireObservation({ type: "AUTRE", description: "RAS" }, ctx);
    expect(r.ok && Object.keys(r.observation.payload).sort()).toEqual(["description", "observeA", "type"]);
  });

  it("refuse ce que le serveur refuserait, en le disant", () => {
    const cas: [Parameters<typeof construireObservation>[0], RegExp][] = [
      [{ type: "" , description: "x" }, /type/],
      [{ type: "INVENTE", description: "x" }, /type/],
      [{ type: "AUTRE", gravite: "TERRIBLE", description: "x" }, /gravité/],
      [{ type: "AUTRE", description: "x".repeat(5001) }, /5 000/],
      [{ type: "AUTRE", description: "x", lat: 9.5 }, /ensemble/],
      [{ type: "AUTRE", description: "x", lat: 91, lon: 0 }, /latitude/],
      [{ type: "AUTRE", description: "x", lat: 0, lon: 181 }, /longitude/],
      [{ type: "AUTRE", description: "x", lat: Number.NaN, lon: 0 }, /latitude/],
      [{ type: "AUTRE", description: "x", precisionM: -1 }, /précision/],
      [{ type: "AUTRE", description: "x", missionId: "pas-un-uuid" }, /mission/],
      [{ type: "AUTRE", description: "   " }, /Décrivez/],
    ];
    for (const [saisie, motif] of cas) {
      const r = construireObservation(saisie, ctx);
      expect(r.ok, JSON.stringify(saisie)).toBe(false);
      expect(!r.ok && r.erreurs.join(" "), JSON.stringify(saisie)).toMatch(motif);
    }
  });

  it("accepte une observation localisee sans description", () => {
    expect(construireObservation({ type: "INCIDENT", lat: 9.5, lon: -13.7 }, ctx).ok).toBe(true);
  });

  it("genere un identifiant UUID distinct a chaque saisie quand aucun n'est impose", () => {
    const a = construireObservation({ type: "AUTRE", description: "a" }, { userId: "u1" });
    const b = construireObservation({ type: "AUTRE", description: "a" }, { userId: "u1" });
    expect(a.ok && b.ok && a.observation.localId !== b.observation.localId).toBe(true);
    expect(a.ok && estUuid(a.observation.localId)).toBe(true);
  });
});

describe("nouvelIdentifiant", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rend un UUID v4 valide meme sans crypto.randomUUID (page hors contexte securise)", () => {
    vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array) => { for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) & 0xff; return a; } });
    const id = nouvelIdentifiant();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("rend un UUID v4 valide sans aucun crypto", () => {
    vi.stubGlobal("crypto", undefined);
    expect(estUuid(nouvelIdentifiant())).toBe(true);
  });
});

describe("enregistrerObservation", () => {
  it("met l'observation en file AVANT de tenter l'envoi, et ne met rien en file si la saisie est invalide", async () => {
    ajoutees.length = 0;
    const ordre: string[] = [];
    const sync = await import("./offlineSync");
    vi.mocked(sync.refreshPendingCount).mockImplementation(async () => { ordre.push("compteur"); });
    vi.mocked(sync.syncPendingOfflineData).mockImplementation(async () => { ordre.push("envoi"); });
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });

    const invalide = await enregistrerObservation({ type: "" }, "u1");
    expect(invalide.ok).toBe(false);
    expect(ajoutees).toHaveLength(0);

    const ok = await enregistrerObservation({ type: "AUTRE", description: "RAS" }, "u1");
    expect(ok.ok).toBe(true);
    expect(ajoutees).toHaveLength(1);
    expect(ordre).toEqual(["compteur", "envoi"]);
  });
});

describe("libelleStatutObservation", () => {
  it("dit ce que l'agent doit faire, par statut", () => {
    expect(libelleStatutObservation({ status: "conflit" }).action).toMatch(/responsable doit trancher/);
    expect(libelleStatutObservation({ status: "abandonnee", refusDefinitif: true }).libelle).toBe("Refusée");
    expect(libelleStatutObservation({ status: "abandonnee" }).libelle).toBe("Abandonnée");
    expect(libelleStatutObservation({ status: "error" }).action).toMatch(/retour du réseau/);
    expect(libelleStatutObservation({ status: "pending" }).libelle).toMatch(/attente/);
  });

  it("une saisie en quarantaine pour droits n'est NI « en attente d'envoi » NI « abandonnee » : libelle et action propres", () => {
    const q = libelleStatutObservation({ status: "refus_droits" });
    expect(q.libelle).toBe("Refusée : droits modifiés");
    expect(q.libelle).not.toMatch(/attente/);
    // L'action qui revient a l'agent : contacter le responsable, puis renvoyer depuis le panneau. Pas un « elle partira » qui serait faux.
    expect(q.action).toMatch(/responsable/);
    expect(q.action).toMatch(/Saisies refusées : droits modifiés/);
    expect(q.action).toMatch(/ne part pas toute seule/);
    expect(q.action).not.toMatch(/partira/);
  });

  it("chaque statut a un libelle et une action non vides, tous distincts les uns des autres (rien ne tombe dans le cas par defaut)", () => {
    const statuts = ["pending", "error", "abandonnee", "conflit", "refus_droits"] as const;
    const libelles = statuts.map((status) => libelleStatutObservation({ status }));
    for (const l of libelles) { expect(l.libelle.length).toBeGreaterThan(0); expect(l.action.length).toBeGreaterThan(0); }
    expect(new Set(libelles.map((l) => l.libelle)).size).toBe(statuts.length);
    expect(libelles[0]).toEqual({ libelle: "En attente d'envoi", action: "Son envoi sera tenté dès que le réseau le permet." });
    expect(libelles[1].action).toMatch(/retour du réseau/);
    // Seuls pending et error promettent un envoi ; les trois autres statuts ne partent pas seuls.
    expect(libelles[2].action).toMatch(/Plus retentée automatiquement/);
    expect(libelles[3].action).toMatch(/Rien à refaire/);
  });
});

/**
 * GARDE CONTRE LA DERIVE. Les listes de `type` et `gravite`, et les noms de champs, sont copies du schema
 * serveur. Si le serveur les change, ce test echoue au lieu de laisser le telephone emettre des valeurs que le
 * serveur refusera definitivement. Il ne s'execute que si le dossier backend est present (le frontend peut etre
 * teste seul).
 */
describe("accord avec le schema serveur (observation-sync-payload.ts)", () => {
  const chemin = join(__dirname, "..", "..", "..", "backend", "src", "field", "observation-sync-payload.ts");
  const present = existsSync(chemin);

  it.skipIf(!present)("les valeurs de `type` sont celles du serveur", () => {
    const source = readFileSync(chemin, "utf8");
    const bloc = /type:\s*z\.enum\(\[([\s\S]*?)\]\)/.exec(source)![1];
    const valeurs = [...bloc.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
    expect([...TYPES_OBSERVATION]).toEqual(valeurs);
  });

  it.skipIf(!present)("les valeurs de `gravite` sont celles du serveur", () => {
    const source = readFileSync(chemin, "utf8");
    const bloc = /gravite:\s*z\.enum\(\[([\s\S]*?)\]\)/.exec(source)![1];
    expect([...GRAVITES_OBSERVATION]).toEqual([...bloc.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]));
  });

  it.skipIf(!present)("le payload emis n'utilise que des champs que le serveur declare", () => {
    const source = readFileSync(chemin, "utf8");
    const champsServeur = new Set([...source.matchAll(/^\s{2}(\w+):\s*z\./gm)].map((m) => m[1]));
    const r = construireObservation({
      type: "AUTRE", gravite: "FAIBLE", description: "x", lat: 1, lon: 1, precisionM: 1, tronconId: "t",
      missionId: "22222222-2222-4222-8222-222222222222",
    }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) for (const cle of Object.keys(r.observation.payload)) expect(champsServeur.has(cle), cle).toBe(true);
    expect(champsServeur.size).toBeGreaterThanOrEqual(12);
  });
});
