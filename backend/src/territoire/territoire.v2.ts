/**
 * Gardes territoriales (A10) des routes v2 et de la synchronisation terrain.
 *
 * Defauts, observations et portions ne portent pas de region : ils heritent de celle de leur
 * troncon (sinon ouvrage, chantier, mission), comme les decisions de validation le font deja. Une
 * fiche localisee seulement par GPS a une region INCONNUE : un compte regional ne l'ecrit pas
 * (voir `territoire.noyau.ts`).
 */

import type { Request } from "express";
import { prisma } from "../lib/prisma";
import { requireTerritoire } from "../middleware/territoire.middleware";
import { verifierTerritoire, type Perimetre, type VerdictTerritoire } from "./territoire.noyau";
import { regionDeMission, regionDuTroncon, regionsFiche } from "./territoire.service";

type Region = number | null;
const texte = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

interface Liens { tronconId?: string | null; ouvrageId?: string | null; chantierId?: string | null; missionId?: string | null }

/** Region d'un ensemble de liens : troncon, puis ouvrage, chantier, mission. */
async function regionDesLiens(l: Liens): Promise<Region> {
  if (l.tronconId) return regionDuTroncon(l.tronconId);
  if (l.ouvrageId) return (await regionsFiche("ouvrage", l.ouvrageId))[0] ?? null;
  if (l.chantierId) return (await regionsFiche("chantier", l.chantierId))[0] ?? null;
  return regionDeMission(l.missionId);
}

export async function regionObservation(id: string): Promise<Region | undefined> {
  const o = await prisma.observation.findUnique({ where: { id }, select: { tronconId: true, ouvrageId: true, chantierId: true, missionId: true } });
  return o ? regionDesLiens(o) : undefined;
}

export async function regionDefaut(id: string): Promise<Region | undefined> {
  const d = await prisma.defaut.findUnique({ where: { id }, select: { tronconId: true, ouvrageId: true, missionId: true, observationId: true } });
  if (!d) return undefined;
  if (d.tronconId || d.ouvrageId || d.missionId) return regionDesLiens(d);
  return d.observationId ? ((await regionObservation(d.observationId)) ?? null) : null;
}

export async function regionPortion(id: string): Promise<Region | undefined> {
  const p = await prisma.portion.findUnique({ where: { id }, select: { tronconId: true } });
  return p ? regionDuTroncon(p.tronconId) : undefined;
}

const liste = (r: Region | undefined): Region[] => (r === undefined ? [] : [r]);

/** Region d'une anomalie du registre du referentiel : celle de son troncon. */
export async function regionAnomalie(id: string): Promise<Region | undefined> {
  const a = await prisma.anomalieReferentiel.findUnique({ where: { id }, select: { tronconId: true } });
  return a ? regionDuTroncon(a.tronconId) : undefined;
}
export const territoireAnomalie = requireTerritoire(async (req: Request) => liste(await regionAnomalie(req.params.id)));
/** Application groupee : TOUTES les regions touchees doivent etre dans le perimetre, sinon rien ne passe. */
export const territoireAnomaliesGroupe = requireTerritoire(async (req: Request) => {
  const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 200) : [];
  const lignes = await prisma.anomalieReferentiel.findMany({ where: { id: { in: ids } }, select: { troncon: { select: { regionId: true } } } });
  return lignes.map((l) => l.troncon.regionId);
});
/** Analyse : la region examinee (null pour une analyse nationale, reservee a l'administrateur par la route). */
export const territoireAnalyseReferentiel = requireTerritoire(async (req: Request) => [typeof req.body?.regionId === "number" ? req.body.regionId : null]);

/** Creation d'un defaut : son troncon, sinon sa mission, sinon l'observation qui le contient. */
async function regionCreationDefaut(c: Record<string, unknown>): Promise<Region> {
  const tronconId = texte(c.tronconId); const ouvrageId = texte(c.ouvrageId); const missionId = texte(c.missionId);
  if (tronconId || ouvrageId || missionId) return regionDesLiens({ tronconId, ouvrageId, missionId });
  const observationId = texte(c.observationId);
  return observationId ? ((await regionObservation(observationId)) ?? null) : null;
}

export const territoireCreationDefaut = requireTerritoire(async (req: Request) => [await regionCreationDefaut(req.body ?? {})]);

/** Ecriture sur un defaut existant ; l'appariement confirme ajoute la region du troncon retenu. */
export const territoireDefaut = requireTerritoire(async (req: Request) => {
  const regions = liste(await regionDefaut(req.params.id));
  const tronconId = texte(req.body?.tronconId);
  return tronconId ? [...regions, await regionDuTroncon(tronconId)] : regions;
});

export const territoireObservation = requireTerritoire(async (req: Request) => liste(await regionObservation(req.params.id)));

export const territoireCreationPortion = requireTerritoire(async (req: Request) => [await regionDuTroncon(texte(req.body?.tronconId))]);

export const territoirePortion = requireTerritoire(async (req: Request) => liste(await regionPortion(req.params.id)));

export const territoireFusionPortions = requireTerritoire(async (req: Request) => [
  ...liste(await regionPortion(String(req.body?.idA ?? ""))), ...liste(await regionPortion(String(req.body?.idB ?? ""))),
]);

/**
 * Synchronisation terrain : regions qu'une operation toucherait. Une operation hors perimetre est
 * rejetee SEULE (le reste du lot passe), et n'est pas enregistree : si le perimetre change, le
 * reessai du telephone aboutit.
 */
export async function verdictOperationSync(
  perimetre: Perimetre,
  op: { entityType: string; operation: string; entityId: string; payload?: unknown },
): Promise<VerdictTerritoire> {
  if (perimetre.national) return { ok: true };
  const p = (op.payload && typeof op.payload === "object" ? op.payload : {}) as Record<string, unknown>;
  const regions: Region[] = [];
  if (op.entityType === "Defaut") regions.push(await regionCreationDefaut(p));
  if (op.entityType === "Portion") regions.push(await regionDuTroncon(texte(p.tronconId)));
  if (op.entityType === "Observation") {
    if (op.operation !== "CREATE") regions.push(...liste(await regionObservation(op.entityId)));
    const nouveaux = { tronconId: texte(p.tronconId), ouvrageId: texte(p.ouvrageId), chantierId: texte(p.chantierId), missionId: texte(p.missionId) };
    if (op.operation === "CREATE" || Object.values(nouveaux).some(Boolean)) regions.push(await regionDesLiens(nouveaux));
  }
  return verifierTerritoire(perimetre, regions);
}
