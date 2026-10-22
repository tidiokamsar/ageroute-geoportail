import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { EXPLICATIONS_TERRITOIRE, verdictTerritorial, type DomaineTerritorial, type Perimetre } from "./perimetre";

/**
 * Application du perimetre territorial aux ecritures des huit domaines (A10). La regle est dans
 * `perimetre.ts` ; ici, on lit les perimetres du compte et la region des objets touches.
 *
 * LA REGION D'UN OBJET se lit en base, jamais dans ce que le client affirme d'un objet existant :
 * pour une modification, c'est la region ACTUELLE qui compte, et la nouvelle si le corps en
 * demande une. Un defaut ou une observation prend la region de son troncon, a defaut celle de sa
 * mission (la regle des delegations, `api-v2/defauts.routes.ts`) ; une portion, celle de son troncon.
 */

type DepotPerimetre = Pick<typeof prisma, "perimetreTerritorial" | "troncon" | "ouvrage" | "pointNoir" | "poste" | "chantier" | "defaut" | "observation" | "portion" | "mission">;

export async function perimetresDuCompte(depot: Pick<DepotPerimetre, "perimetreTerritorial">, userId: string): Promise<Perimetre[]> {
  return depot.perimetreTerritorial.findMany({
    where: { userId, revoqueLe: null },
    select: { regionId: true, debutLe: true, finLe: true, revoqueLe: true },
  });
}

/** Region actuelle d'un objet existant. `undefined` : objet introuvable (la route rendra 404). */
export async function regionDeLObjet(depot: DepotPerimetre, domaine: DomaineTerritorial, id: string): Promise<number | null | undefined> {
  const viaTroncon = { troncon: { select: { regionId: true } }, mission: { select: { regionId: true } } } as const;
  switch (domaine) {
    case "TRONCON": return (await depot.troncon.findUnique({ where: { id }, select: { regionId: true } }))?.regionId;
    case "OUVRAGE": return (await depot.ouvrage.findUnique({ where: { id }, select: { regionId: true } }))?.regionId;
    case "POINT_NOIR": return (await depot.pointNoir.findUnique({ where: { id }, select: { regionId: true } }))?.regionId;
    case "POSTE": return (await depot.poste.findUnique({ where: { id }, select: { regionId: true } }))?.regionId;
    case "CHANTIER": return (await depot.chantier.findUnique({ where: { id }, select: { regionId: true } }))?.regionId;
    case "DEFAUT": {
      const d = await depot.defaut.findUnique({ where: { id }, select: viaTroncon });
      return d === null ? undefined : d.troncon?.regionId ?? d.mission?.regionId ?? null;
    }
    case "OBSERVATION": {
      const o = await depot.observation.findUnique({ where: { id }, select: viaTroncon });
      return o === null ? undefined : o.troncon?.regionId ?? o.mission?.regionId ?? null;
    }
    case "PORTION": {
      const p = await depot.portion.findUnique({ where: { id }, select: { troncon: { select: { regionId: true } } } });
      return p === null ? undefined : p.troncon?.regionId ?? null;
    }
  }
}

const chaine = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const entier = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

/** Region d'un objet a creer, d'apres ce que le corps reference (troncon, mission) ou declare. */
export async function regionDUneCreation(depot: DepotPerimetre, domaine: DomaineTerritorial, corps: Record<string, unknown>): Promise<number | null> {
  const tronconId = chaine(corps.tronconId);
  const depuisTroncon = async () => (tronconId ? (await depot.troncon.findUnique({ where: { id: tronconId }, select: { regionId: true } }))?.regionId ?? null : null);
  switch (domaine) {
    case "TRONCON": case "OUVRAGE": case "POINT_NOIR": case "POSTE":
      return entier(corps.regionId);
    case "CHANTIER":
      return entier(corps.regionId) ?? (await depuisTroncon());
    case "PORTION":
      return depuisTroncon();
    case "DEFAUT": case "OBSERVATION": {
      const r = await depuisTroncon();
      if (r !== null) return r;
      const missionId = chaine(corps.missionId);
      return missionId ? (await depot.mission.findUnique({ where: { id: missionId }, select: { regionId: true } }))?.regionId ?? null : null;
    }
  }
}

/** Regions touchees par l'ecriture, ou INTROUVABLE quand l'objet vise n'existe pas (la route rendra 404). */
export type Resolveur = (req: Request) => Promise<(number | null)[] | "INTROUVABLE">;

/** Creation : la region de l'objet a naitre. */
export const aLaCreation = (domaine: DomaineTerritorial): Resolveur =>
  async (req) => [await regionDUneCreation(prisma, domaine, (req.body ?? {}) as Record<string, unknown>)];

/**
 * Modification ou retrait de l'objet `req.params[param]` : sa region actuelle et, si le corps en
 * demande une autre, la nouvelle. Objet introuvable : rien a juger, la route rendra son 404.
 */
export const surLObjet = (domaine: DomaineTerritorial, param = "id"): Resolveur =>
  async (req) => {
    const actuelle = await regionDeLObjet(prisma, domaine, String(req.params[param] ?? ""));
    if (actuelle === undefined) return "INTROUVABLE";
    const nouvelle = entier((req.body as Record<string, unknown> | undefined)?.regionId);
    return nouvelle !== null && nouvelle !== actuelle ? [actuelle, nouvelle] : [actuelle];
  };

/**
 * Rattachement d'un objet existant a un AUTRE troncon (confirmation d'appariement) : la region
 * actuelle et celle du troncon cible doivent toutes deux etre dans le perimetre.
 */
export const surLObjetVersTroncon = (domaine: DomaineTerritorial, param = "id"): Resolveur =>
  async (req) => {
    const actuelle = await regionDeLObjet(prisma, domaine, String(req.params[param] ?? ""));
    if (actuelle === undefined) return "INTROUVABLE";
    const cible = chaine((req.body as Record<string, unknown> | undefined)?.tronconId);
    const r = cible ? (await prisma.troncon.findUnique({ where: { id: cible }, select: { regionId: true } }))?.regionId ?? null : null;
    return cible ? [actuelle, r] : [actuelle];
  };

/** Plusieurs objets designes par des champs du corps (fusion de portions). */
export const surLesObjets = (domaine: DomaineTerritorial, champs: string[]): Resolveur =>
  async (req) => {
    const corps = (req.body ?? {}) as Record<string, unknown>;
    const regions: (number | null)[] = [];
    for (const c of champs) {
      const id = chaine(corps[c]);
      const r = id ? await regionDeLObjet(prisma, domaine, id) : null;
      if (r !== undefined) regions.push(r);
    }
    return regions;
  };

/**
 * Import en masse : les lignes d'un fichier portent des regions que la route ne connait qu'apres
 * lecture. Un compte restreint n'importe donc pas ; un compte national, si.
 */
export const importNational: Resolveur = async () => [null];

const DOMAINE_DE_LA_SYNC: Record<string, DomaineTerritorial> = { Observation: "OBSERVATION", Defaut: "DEFAUT", Portion: "PORTION" };

/**
 * La meme regle pour une operation de synchronisation hors ligne : sans elle, un compte restreint
 * ecrirait hors de son perimetre en passant par la file de l'appareil au lieu de l'API.
 * Rend `null` quand l'operation est permise.
 */
export async function refusTerritorialSync(
  userId: string, op: { entityType: string; entityId: string; operation: string; payload?: unknown },
): Promise<"HORS_PERIMETRE" | "REGION_INCONNUE" | null> {
  const domaine = DOMAINE_DE_LA_SYNC[op.entityType];
  if (!domaine) return null;
  const perimetres = await perimetresDuCompte(prisma, userId);
  if (perimetres.length === 0) return null;
  const corps = (op.payload && typeof op.payload === "object" ? op.payload : {}) as Record<string, unknown>;
  let regions: (number | null)[];
  if (op.operation === "CREATE") {
    regions = [await regionDUneCreation(prisma, domaine, corps)];
  } else {
    const actuelle = await regionDeLObjet(prisma, domaine, op.entityId);
    // Objet introuvable : la synchronisation le traitera comme elle le fait deja.
    if (actuelle === undefined) return null;
    const cible = chaine(corps.tronconId);
    regions = cible ? [actuelle, (await prisma.troncon.findUnique({ where: { id: cible }, select: { regionId: true } }))?.regionId ?? null] : [actuelle];
  }
  const v = verdictTerritorial(perimetres, regions, new Date());
  return v.permis ? null : v.motif;
}

/**
 * Middleware : a poser APRES `requireAuth` et le controle de role. Un compte sans perimetre passe
 * (regle provisoire, voir `perimetre.ts`) ; sinon chaque region touchee doit lui appartenir.
 */
export function requireTerritoire(domaine: DomaineTerritorial, resoudre: Resolveur) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) { res.status(401).json({ error: "Authentification requise" }); return; }
    try {
      const perimetres = await perimetresDuCompte(prisma, req.user.id);
      if (perimetres.length === 0) { next(); return; }
      const regions = await resoudre(req);
      // Objet introuvable : la route dira 404 ; il n'y a rien a ecrire, donc rien a proteger.
      if (regions === "INTROUVABLE") { next(); return; }
      const v = verdictTerritorial(perimetres, regions, new Date());
      if (!v.permis) {
        res.status(403).json({ error: EXPLICATIONS_TERRITOIRE[v.motif], code: v.motif, domaine, regionsAutorisees: v.regionsAutorisees });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
