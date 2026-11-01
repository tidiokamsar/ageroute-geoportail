/**
 * Lecture du perimetre d'un compte et des regions qu'une ecriture touche, pour les huit domaines
 * (A10). La regle elle-meme est dans `territoire.noyau.ts`.
 *
 * Le perimetre est relu en base a chaque requete, comme les modules autorises : un rattachement
 * retire s'applique a la requete suivante, sans attendre l'expiration du jeton.
 */

import { prisma } from "../lib/prisma";
import { ApiError } from "../middleware/error.middleware";
import { perimetreDeRegions, verifierTerritoire, type Perimetre } from "./territoire.noyau";

export async function perimetreDe(user: { id: string; role: string }): Promise<Perimetre> {
  if (user.role === "ADMIN") return perimetreDeRegions("ADMIN", []);
  return perimetreDeRegions(user.role, await regionsDuCompte(user.id));
}

/**
 * Regions rattachees a un compte. Requete parametree plutot que le delegue Prisma : la table est
 * declaree dans `schema.prisma` (controle de derive), mais le client n'a pas a etre regenere pour
 * la lire, et la lecture reste la meme en developpement et en production.
 */
export async function regionsDuCompte(userId: string): Promise<number[]> {
  const lignes = await prisma.$queryRaw<{ regionId: number }[]>`SELECT "regionId" FROM "perimetres_comptes" WHERE "userId" = ${userId}`;
  return lignes.map((l) => Number(l.regionId));
}

type Region = number | null;

/** Les cinq entites du patrimoine qui portent leur propre region (API v1). */
export type EntiteRegionale = "troncon" | "ouvrage" | "pointNoir" | "poste" | "chantier";

async function regionDe(entite: EntiteRegionale, id: string): Promise<Region | undefined> {
  const args = { where: { id }, select: { regionId: true } } as const;
  let ligne: { regionId: number | null } | null;
  switch (entite) {
    case "troncon": ligne = await prisma.troncon.findUnique(args); break;
    case "ouvrage": ligne = await prisma.ouvrage.findUnique(args); break;
    case "pointNoir": ligne = await prisma.pointNoir.findUnique(args); break;
    case "poste": ligne = await prisma.poste.findUnique(args); break;
    case "chantier": ligne = await prisma.chantier.findUnique(args); break;
  }
  // Fiche introuvable : `undefined`, la route repondra elle-meme son 404.
  return ligne ? ligne.regionId : undefined;
}

/** Regions de plusieurs fiches (archivage et restauration en masse). Les introuvables sont ignorees. */
export async function regionsDe(entite: EntiteRegionale, ids: readonly string[]): Promise<Region[]> {
  const args = { where: { id: { in: [...ids] } }, select: { regionId: true as const } };
  switch (entite) {
    case "troncon": return (await prisma.troncon.findMany(args)).map((l) => l.regionId);
    case "ouvrage": return (await prisma.ouvrage.findMany(args)).map((l) => l.regionId);
    case "pointNoir": return (await prisma.pointNoir.findMany(args)).map((l) => l.regionId);
    case "poste": return (await prisma.poste.findMany(args)).map((l) => l.regionId);
    case "chantier": return (await prisma.chantier.findMany(args)).map((l) => l.regionId);
  }
}

/** Region d'une fiche existante ; `[]` si elle n'existe pas (la route rend son 404). */
export async function regionsFiche(entite: EntiteRegionale, id: string): Promise<Region[]> {
  const r = await regionDe(entite, id);
  return r === undefined ? [] : [r];
}

/** Region d'un troncon, pour les entites qui en heritent (defaut, observation, portion). */
export async function regionDuTroncon(tronconId: string | null | undefined): Promise<Region> {
  if (!tronconId) return null;
  const r = await regionDe("troncon", tronconId);
  return r === undefined ? null : r;
}

/** Region d'une mission (nullable en base). */
export async function regionDeMission(missionId: string | null | undefined): Promise<Region> {
  if (!missionId) return null;
  const m = await prisma.mission.findUnique({ where: { id: missionId }, select: { regionId: true } });
  return m?.regionId ?? null;
}

/**
 * Region d'un defaut ou d'une observation : celle de son troncon, sinon celle de sa mission --
 * la meme derivation que les decisions de validation (`defauts.routes.ts`, `observations.routes.ts`).
 */
export async function regionTronconOuMission(liens: { tronconId?: string | null; missionId?: string | null }): Promise<Region> {
  return (await regionDuTroncon(liens.tronconId)) ?? (await regionDeMission(liens.missionId));
}

/**
 * Controle par l'identifiant seul, pour les services qui ne recoivent que l'auteur (fabrique CRUD,
 * imports ligne a ligne). Leve un 403 hors perimetre. Compte introuvable : refuse plutot qu'accorde.
 */
export async function exigerTerritoire(userId: string, regionsTouchees: readonly (number | null | undefined)[]): Promise<void> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!u) throw new ApiError(403, "Compte introuvable : ecriture refusee.");
  const regions = u.role === "ADMIN" ? [] : await regionsDuCompte(userId);
  const verdict = verifierTerritoire(perimetreDeRegions(u.role, regions), regionsTouchees);
  if (!verdict.ok) throw new ApiError(403, verdict.motif);
}
