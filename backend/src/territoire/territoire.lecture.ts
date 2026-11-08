/**
 * Controle d'acces territorial (A10), du cote de la LECTURE et des ecritures par identifiant sur les
 * domaines qui ne portent pas leur region dans la fabrique CRUD : ordres de travaux, missions,
 * previsions de programmation, observations, defauts. La regle elle-meme est dans `territoire.noyau.ts`.
 *
 * LA REGLE, EN UNE PHRASE
 *
 * Un compte a perimetre regional ne voit, ne modifie et ne cree que ce dont la region est dans son
 * perimetre ; une region INCONNUE est hors perimetre (meme sens que pour les ecritures : on ne deduit
 * pas une localisation de son absence). Un compte national (ADMIN, ou aucun rattachement) ne change en rien.
 *
 * POURQUOI 404 ET NON 403 SUR UNE RESSOURCE DESIGNEE PAR SON IDENTIFIANT
 *
 * Une ressource hors perimetre n'existe pas POUR CE COMPTE : lui repondre 403 lui apprendrait qu'elle
 * existe (et dans quelle region, par elimination). Elle recoit donc la MEME reponse que pour un
 * identifiant inconnu, comme les observations et les defauts le font deja pour « n'est pas a vous ».
 * Une CREATION n'a pas de ressource a masquer : elle garde le 403 et ses codes (`HORS_PERIMETRE`,
 * `REGION_INCONNUE`) de `requireTerritoire`.
 *
 * CE MODULE IMPORTE `perimetreDe` DEPUIS `territoire.service` (et non l'inverse) pour que les tests des
 * routes, qui declarent un compte national en simulant ce module, s'appliquent a ces lectures aussi.
 */

import { prisma } from "../lib/prisma";
import { perimetreDe, regionDuTroncon, regionsFiche } from "./territoire.service";

type Region = number | null;
type Compte = { id: string; role: string };

/**
 * Regions que le compte voit ; `null` = toutes (compte national). Relu en base a chaque requete,
 * comme les modules autorises : un rattachement retire s'applique a la requete suivante.
 */
export async function regionsVisibles(user: Compte): Promise<readonly number[] | null> {
  const p = await perimetreDe(user);
  return p.national ? null : [...p.regions];
}

/**
 * Fragment `where` Prisma pour une colonne de region portee par la ligne elle-meme (`ordres_travaux`,
 * `missions`). Vide pour un compte national. Une region nulle ne satisfait jamais `in` : une ligne sans
 * region est invisible d'un compte regional.
 */
export async function filtreRegion(user: Compte, colonne = "regionId"): Promise<Record<string, unknown>> {
  const regions = await regionsVisibles(user);
  return regions === null ? {} : { [colonne]: { in: [...regions] } };
}

/**
 * Fragment `where` pour une prevision de programmation : sa region est celle de son troncon. Une
 * prevision sans troncon n'a pas de region : invisible d'un compte regional.
 */
export async function filtreRegionDuTroncon(user: Compte): Promise<Record<string, unknown>> {
  const regions = await regionsVisibles(user);
  return regions === null ? {} : { troncon: { regionId: { in: [...regions] } } };
}

/**
 * Region d'un objet rattache a des liens facultatifs, DANS L'ORDRE de `territoire.v2.regionDesLiens` :
 * troncon, puis ouvrage, puis chantier, puis mission. Chaque branche exige l'absence des precedentes :
 * c'est ce qui fait que la region d'une observation ne depend que du premier lien renseigne.
 */
export function filtreRegionObservation(regions: readonly number[]): Record<string, unknown> {
  const dans = { in: [...regions] };
  return {
    OR: [
      { tronconId: { not: null }, troncon: { regionId: dans } },
      { tronconId: null, ouvrageId: { not: null }, ouvrage: { regionId: dans } },
      { tronconId: null, ouvrageId: null, chantierId: { not: null }, chantier: { regionId: dans } },
      { tronconId: null, ouvrageId: null, chantierId: null, mission: { regionId: dans } },
    ],
  };
}

/**
 * Meme derivation pour un defaut, comme `territoire.v2.regionDefaut` : troncon, ouvrage, mission, et a defaut
 * l'observation qui le contient (qui suit alors sa propre derivation).
 */
export function filtreRegionDefaut(regions: readonly number[]): Record<string, unknown> {
  const dans = { in: [...regions] };
  return {
    OR: [
      { tronconId: { not: null }, troncon: { regionId: dans } },
      { tronconId: null, ouvrageId: { not: null }, ouvrage: { regionId: dans } },
      { tronconId: null, ouvrageId: null, missionId: { not: null }, mission: { regionId: dans } },
      { tronconId: null, ouvrageId: null, missionId: null, observation: filtreRegionObservation(regions) },
    ],
  };
}

/** Combine deux fragments `where` sans qu'une cle `OR` ecrase l'autre. */
export function et(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const aVide = Object.keys(a).length === 0;
  const bVide = Object.keys(b).length === 0;
  if (aVide) return b;
  if (bVide) return a;
  return { AND: [a, b] };
}

// ------------------------------------------------------------------ Regions des ressources, par identifiant

/** Region d'un ordre de travaux ; `[]` s'il n'existe pas (la route rend son 404). */
export async function regionsOt(id: string): Promise<Region[]> {
  const ot = await prisma.ordreTravaux.findUnique({ where: { id }, select: { regionId: true } });
  return ot ? [ot.regionId] : [];
}

/** Region d'une mission ; `[]` si elle n'existe pas. */
export async function regionsMission(id: string): Promise<Region[]> {
  const m = await prisma.mission.findUnique({ where: { id }, select: { regionId: true } });
  return m ? [m.regionId] : [];
}

/** Region d'une prevision de programmation = celle de son troncon ; `[]` si elle n'existe pas, `[null]` sans troncon. */
export async function regionsPrevision(id: string): Promise<Region[]> {
  const p = await prisma.programmeBudgetaire.findUnique({ where: { id }, select: { troncon: { select: { regionId: true } } } });
  return p ? [p.troncon?.regionId ?? null] : [];
}

const texte = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const entier = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

/**
 * Regions que touche l'ecriture d'un ordre de travaux dont le CORPS designe region et/ou troncon
 * (creation : region explicite et region du troncon ; modification : region d'apres). Rien designe : `[]`
 * pour une modification partielle, `[null]` pour une creation (region inconnue, voir `creation`).
 */
export async function regionsCorpsOt(corps: Record<string, unknown> | undefined, creation: boolean): Promise<Region[]> {
  const regions: Region[] = [];
  const regionId = entier(corps?.regionId);
  if (regionId !== null) regions.push(regionId);
  const tronconId = texte(corps?.tronconId);
  if (tronconId) regions.push(await regionDuTroncon(tronconId));
  if (creation && regions.length === 0) regions.push(null);
  return regions;
}

/** Regions que touche la creation d'une mission : sa region, celle du chantier auquel elle se rattache. */
export async function regionsCorpsMission(corps: Record<string, unknown> | undefined): Promise<Region[]> {
  const regions: Region[] = [entier(corps?.regionId)];
  const chantierId = texte(corps?.chantierId);
  if (chantierId) regions.push(...(await regionsFiche("chantier", chantierId)));
  return regions;
}

/** Region que touche la creation ou le rattachement d'une prevision : celle du troncon designe, inconnue sans troncon. */
export async function regionsCorpsPrevision(corps: Record<string, unknown> | undefined, creation: boolean): Promise<Region[]> {
  const tronconId = texte(corps?.tronconId);
  if (tronconId) return [await regionDuTroncon(tronconId)];
  // Detacher une prevision de son troncon la laisse sans region : un compte regional ne le fait pas.
  if (creation || (corps && corps.tronconId === null)) return [null];
  return [];
}

// ------------------------------------------------------------------ Moteur de programmation (scenarios, fiches, plans)

/**
 * Region d'un scenario annuel ou d'un plan pluriannuel : celle de son PERIMETRE (`perimetre.regionId`, nulle pour un
 * calcul national). `[]` s'il n'existe pas. Un calcul national n'a pas de region : hors perimetre d'un compte regional.
 */
async function regionDuPerimetre(table: "scenarios_programmation" | "plans_pluriannuels", id: string): Promise<Region[]> {
  const lignes = table === "scenarios_programmation"
    ? await prisma.$queryRaw<{ r: string | null }[]>`SELECT "perimetre"->>'regionId' AS r FROM "scenarios_programmation" WHERE "id" = ${id}`
    : await prisma.$queryRaw<{ r: string | null }[]>`SELECT "perimetre"->>'regionId' AS r FROM "plans_pluriannuels" WHERE "id" = ${id}`;
  if (lignes.length === 0) return [];
  const r = lignes[0].r;
  return [r === null || r === undefined || Number.isNaN(Number(r)) ? null : Number(r)];
}

export const regionsScenario = (id: string) => regionDuPerimetre("scenarios_programmation", id);
export const regionsPlan = (id: string) => regionDuPerimetre("plans_pluriannuels", id);

/** Region d'une fiche d'intervention figee = celle de son troncon ; `[]` si la fiche n'existe pas. */
export async function regionsFicheIntervention(id: string): Promise<Region[]> {
  const l = await prisma.$queryRaw<{ r: number | null }[]>`
    SELECT t."regionId" AS r FROM "fiches_intervention" f LEFT JOIN "troncons" t ON t."id" = f."tronconId" WHERE f."id" = ${id}`;
  return l.length === 0 ? [] : [l[0].r === null ? null : Number(l[0].r)];
}

/** Region demandee par le corps d'une simulation (`regionId`) : aucune = calcul national, hors perimetre d'un compte regional. */
export async function regionsCorpsSimulation(corps: Record<string, unknown> | undefined): Promise<Region[]> {
  return [entier(corps?.regionId)];
}
