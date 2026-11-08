import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  JournalScript, SEUIL_TRACE_PAR_ENTITE, TAILLE_LOT_TRACE,
  choisirAuteur, creerContexte, lireOption, modeExecution, planifierTrace,
  type Auteur, type ClientAudit, type ClientUtilisateurs, type ContexteExecution,
} from "./audit-script";

/**
 * Trace des scripts d'exploitation : ce que ces tests defendent.
 *   - la simulation est le DEFAUT, et une intention contradictoire est refusee ;
 *   - une ecriture demande un auteur responsable (ADMIN actif) ou un auteur systeme explicite ;
 *   - la trace d'une entite reste plate et porte l'identifiant d'execution ;
 *   - au-dela du seuil, une ligne par lot, qui garde identifiants et anciennes valeurs ;
 *   - en simulation, RIEN n'est ecrit en base ;
 *   - le client Prisma reel est accepte comme client de trace (verification de type).
 */

// Verification de type : un PrismaClient (ou un client de transaction) convient aux deux interfaces.
const _typeAudit = (p: PrismaClient): ClientAudit => p;
const _typeUsers = (p: PrismaClient): ClientUtilisateurs => p;
void _typeAudit; void _typeUsers;

const CTX: ContexteExecution = {
  script: "rattacher-troncons-region", executionId: "11111111-2222-3333-4444-555555555555", mode: "ECRITURE",
  debutLe: "2026-10-26T12:00:00.000Z", hote: "poste-test", parametres: { lot: "L1" },
};
const SYSTEME: Auteur = { userId: null, libelle: "systeme" };
const ADMIN: Auteur = { userId: "u-admin", libelle: "admin@exemple.test" };

describe("lireOption", () => {
  it("lit --nom=valeur et --nom valeur, et rend null si absente ou sans valeur", () => {
    expect(lireOption(["--auteur=a@b.c"], "auteur")).toBe("a@b.c");
    expect(lireOption(["--auteur", "a@b.c"], "auteur")).toBe("a@b.c");
    expect(lireOption(["--auteur"], "auteur")).toBeNull();
    expect(lireOption(["--auteur", "--apply"], "auteur")).toBeNull();
    expect(lireOption(["--auteur="], "auteur")).toBeNull();
    expect(lireOption([], "auteur")).toBeNull();
  });
});

describe("modeExecution : la simulation est le defaut", () => {
  it("sans argument : simulation", () => {
    expect(modeExecution([])).toEqual({ ecriture: false, origine: "defaut" });
    expect(modeExecution(["--lot=L1"], {})).toEqual({ ecriture: false, origine: "defaut" });
  });
  it("--dry-run est une simulation explicite", () => {
    expect(modeExecution(["--dry-run"])).toEqual({ ecriture: false, origine: "--dry-run" });
  });
  it("--apply ecrit ; APPLIQUER=1 ecrit (compatibilite import-ouvrages-doaa)", () => {
    expect(modeExecution(["--apply"])).toEqual({ ecriture: true, origine: "--apply" });
    expect(modeExecution([], { APPLIQUER: "1" })).toEqual({ ecriture: true, origine: "APPLIQUER=1" });
  });
  it("APPLIQUER=0 ou vide n'ecrit pas", () => {
    expect(modeExecution([], { APPLIQUER: "0" }).ecriture).toBe(false);
    expect(modeExecution([], { APPLIQUER: "" }).ecriture).toBe(false);
  });
  it("refuse --apply avec --dry-run, et APPLIQUER=1 avec --dry-run", () => {
    expect(() => modeExecution(["--apply", "--dry-run"])).toThrow(/contredit/);
    expect(() => modeExecution(["--dry-run"], { APPLIQUER: "1" })).toThrow(/contredit/);
  });
});

describe("creerContexte", () => {
  it("porte le script, le mode, la date, la machine et les parametres injectes", () => {
    const { contexte, mode } = creerContexte({
      script: "x", argv: ["--apply"], maintenant: new Date("2026-10-26T12:00:00Z"), executionId: "id-1", hote: "h", parametres: { lot: "L1" },
    });
    expect(mode.ecriture).toBe(true);
    expect(contexte).toEqual({ script: "x", executionId: "id-1", mode: "ECRITURE", debutLe: "2026-10-26T12:00:00.000Z", hote: "h", parametres: { lot: "L1" } });
  });
  it("tire un UUID different a chaque execution quand il n'est pas injecte", () => {
    const a = creerContexte({ script: "x", argv: [] }).contexte;
    const b = creerContexte({ script: "x", argv: [] }).contexte;
    expect(a.executionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.executionId).not.toBe(b.executionId);
    expect(a.mode).toBe("SIMULATION");
  });
});

function fauxUsers(compte: { id: string; role: string; actif: boolean } | null): ClientUtilisateurs {
  return { user: { findUnique: vi.fn(async () => compte) } };
}

describe("choisirAuteur", () => {
  it("simulation : aucun auteur requis", async () => {
    expect(await choisirAuteur(fauxUsers(null), [], false)).toEqual({ userId: null, libelle: "systeme (simulation)" });
  });
  it("ecriture sans auteur : refusee", async () => {
    await expect(choisirAuteur(fauxUsers(null), ["--apply"], true)).rejects.toThrow(/sans auteur/);
  });
  it("--auteur-systeme : userId nul, explicite", async () => {
    expect(await choisirAuteur(fauxUsers(null), ["--auteur-systeme"], true)).toEqual({ userId: null, libelle: "systeme" });
  });
  it("--auteur et --auteur-systeme sont exclusifs", async () => {
    await expect(choisirAuteur(fauxUsers(null), ["--auteur=a@b.c", "--auteur-systeme"], true)).rejects.toThrow(/exclusifs/);
  });
  it("un ADMIN actif est accepte", async () => {
    expect(await choisirAuteur(fauxUsers({ id: "u1", role: "ADMIN", actif: true }), ["--auteur=a@b.c"], true)).toEqual({ userId: "u1", libelle: "a@b.c" });
  });
  it("un compte inconnu, non ADMIN ou desactive est refuse", async () => {
    await expect(choisirAuteur(fauxUsers(null), ["--auteur=a@b.c"], true)).rejects.toThrow(/introuvable/);
    await expect(choisirAuteur(fauxUsers({ id: "u1", role: "GESTIONNAIRE", actif: true }), ["--auteur=a@b.c"], true)).rejects.toThrow(/administrateur actif/);
    await expect(choisirAuteur(fauxUsers({ id: "u1", role: "ADMIN", actif: false }), ["--auteur=a@b.c"], true)).rejects.toThrow(/administrateur actif/);
  });
});

describe("planifierTrace", () => {
  it("une ligne par entite, plate, avec _execution", () => {
    const l = planifierTrace(CTX, ADMIN, {
      action: "UPDATE", entityType: "Troncon",
      entites: [{ id: "t1", before: { regionId: 3 }, after: { regionId: 5 } }, { id: "t2", after: { regionId: 5 } }],
    });
    expect(l).toHaveLength(2);
    expect(l[0]).toMatchObject({ userId: "u-admin", action: "UPDATE", entityType: "Troncon", entityId: "t1", before: { regionId: 3 } });
    expect(l[0].after).toEqual({ regionId: 5, _execution: { executionId: CTX.executionId, script: CTX.script, mode: "ECRITURE", auteur: "admin@exemple.test" } });
    expect(l[1].before).toBeNull();
  });
  it("un after non objet est range sous `valeur`, un after absent donne seulement _execution", () => {
    const l = planifierTrace(CTX, SYSTEME, { action: "UPDATE", entityType: "X", entites: [{ id: "a", after: "BON" }, { id: "b" }] });
    expect(l[0].after).toMatchObject({ valeur: "BON" });
    expect(Object.keys(l[1].after as object)).toEqual(["_execution"]);
    expect(l[0].userId).toBeNull();
  });
  it("ne mute pas l'entree", () => {
    const apres = { regionId: 5 };
    planifierTrace(CTX, SYSTEME, { action: "UPDATE", entityType: "X", entites: [{ id: "a", after: apres }] });
    expect(apres).toEqual({ regionId: 5 });
  });
  it(`au-dela de ${SEUIL_TRACE_PAR_ENTITE} entites : une ligne par lot de ${TAILLE_LOT_TRACE}, avec identifiants et anciennes valeurs`, () => {
    const entites = Array.from({ length: SEUIL_TRACE_PAR_ENTITE + 1 }, (_, i) => ({ id: `t${i}`, before: { etat: "NON_EVALUE" } }));
    const l = planifierTrace(CTX, SYSTEME, { action: "UPDATE", entityType: "Troncon", entites });
    expect(l).toHaveLength(Math.ceil((SEUIL_TRACE_PAR_ENTITE + 1) / TAILLE_LOT_TRACE));
    expect(l.every((x) => x.entityId === null)).toBe(true);
    expect((l[0].after as { ids: string[] }).ids).toHaveLength(TAILLE_LOT_TRACE);
    expect((l[0].before as { id: string }[])[0]).toEqual({ id: "t0", before: { etat: "NON_EVALUE" } });
    const tousLesIds = l.flatMap((x) => (x.after as { ids: string[] }).ids);
    expect(tousLesIds).toHaveLength(SEUIL_TRACE_PAR_ENTITE + 1);
    expect(new Set(tousLesIds).size).toBe(SEUIL_TRACE_PAR_ENTITE + 1);
  });
  it("exactement au seuil : encore une ligne par entite", () => {
    const entites = Array.from({ length: SEUIL_TRACE_PAR_ENTITE }, (_, i) => ({ id: `t${i}` }));
    expect(planifierTrace(CTX, SYSTEME, { action: "CREATE", entityType: "Troncon", entites })).toHaveLength(SEUIL_TRACE_PAR_ENTITE);
  });
  it("un lot sans ancienne valeur n'a pas de before", () => {
    const entites = Array.from({ length: SEUIL_TRACE_PAR_ENTITE + 1 }, (_, i) => ({ id: `t${i}` }));
    expect(planifierTrace(CTX, SYSTEME, { action: "CREATE", entityType: "Troncon", entites })[0].before).toBeNull();
  });
  it("aucune entite : aucune ligne", () => {
    expect(planifierTrace(CTX, SYSTEME, { action: "UPDATE", entityType: "X", entites: [] })).toEqual([]);
  });
});

function fauxClient() {
  const createMany = vi.fn(async (a: { data: never[] }) => ({ count: a.data.length }));
  const create = vi.fn(async () => ({}));
  return { client: { auditLog: { createMany, create } } as unknown as ClientAudit, createMany, create };
}

describe("JournalScript", () => {
  it("en ECRITURE : ecrit les lignes dans le client de transaction fourni", async () => {
    const { client, createMany } = fauxClient();
    const j = new JournalScript(CTX, ADMIN);
    const n = await j.tracer(client, { action: "UPDATE", entityType: "Troncon", entites: [{ id: "t1", after: { regionId: 5 } }, { id: "t2" }] });
    expect(n).toBe(2);
    expect(createMany).toHaveBeenCalledTimes(1);
    const lignes = createMany.mock.calls[0][0].data as unknown as { entityId: string; userId: string; action: string }[];
    expect(lignes.map((l) => l.entityId)).toEqual(["t1", "t2"]);
    expect(lignes[0]).toMatchObject({ userId: "u-admin", action: "UPDATE" });
    expect(j.lignes).toBe(2);
  });
  it("en SIMULATION : n'ecrit RIEN, mais compte ce qui aurait ete trace", async () => {
    const { client, createMany, create } = fauxClient();
    const j = new JournalScript({ ...CTX, mode: "SIMULATION" }, SYSTEME);
    expect(j.ecriture).toBe(false);
    await j.tracer(client, { action: "UPDATE", entityType: "Troncon", entites: [{ id: "t1" }, { id: "t2" }, { id: "t3" }] });
    await j.tracerExecution(client, "DEBUT");
    await j.tracerExecution(client, "FIN", { ecrits: 3 });
    expect(createMany).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(j.lignes).toBe(5);
  });
  it("sans entite, n'appelle pas la base", async () => {
    const { client, createMany } = fauxClient();
    await new JournalScript(CTX, SYSTEME).tracer(client, { action: "UPDATE", entityType: "X", entites: [] });
    expect(createMany).not.toHaveBeenCalled();
  });
  it("tracerExecution : une ligne ScriptExecution par phase, sans secret", async () => {
    const { client, create } = fauxClient();
    const j = new JournalScript(CTX, ADMIN);
    await j.tracerExecution(client, "DEBUT");
    await j.tracerExecution(client, "FIN", { ecrits: 12 });
    expect(create).toHaveBeenCalledTimes(2);
    const [debut, fin] = create.mock.calls.map((c) => (c as unknown as [{ data: Record<string, unknown> }])[0].data);
    expect(debut).toMatchObject({ action: "SECURITY_EVENT", entityType: "ScriptExecution", entityId: CTX.executionId, userId: "u-admin" });
    expect((debut.after as { phase: string }).phase).toBe("DEBUT");
    expect((fin.after as { phase: string; bilan: object }).bilan).toEqual({ ecrits: 12 });
    expect(JSON.stringify(fin)).not.toMatch(/postgres(ql)?:\/\/|password|motdepasse/i);
  });
  it("une panne d'audit remonte : l'ecriture metier de la meme transaction sera annulee", async () => {
    const client = { auditLog: { createMany: vi.fn(async () => { throw new Error("audit en panne"); }), create: vi.fn() } } as unknown as ClientAudit;
    await expect(new JournalScript(CTX, SYSTEME).tracer(client, { action: "UPDATE", entityType: "X", entites: [{ id: "a" }] })).rejects.toThrow("audit en panne");
  });
});
