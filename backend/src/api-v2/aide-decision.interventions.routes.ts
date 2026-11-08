import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { requireTerritoireMasque } from "../middleware/territoire.middleware";
import { prisma } from "../lib/prisma";
import { regionsVisibles } from "../territoire/territoire.lecture";
import { regionsFiche } from "../territoire/territoire.service";
import { RefusMoteur, type Contexte } from "../programmation/moteur.service";
import * as service from "../programmation/priorite.service";
import { CRITERES_TECHNIQUES } from "../programmation/priorite.parametres";
import { estIdentifiant, lireFiltresDetail, lireFiltresGeo, lireFiltresListe } from "../programmation/priorite.requete";

/**
 * `/api/v2/aide-decision` : INTERVENTIONS PRIORISEES et PARAMETRES DE PRIORITE (module d'aide a la decision, lot 3).
 * Le routeur est MONTE PAR L'ORCHESTRATEUR (`api-v2/index.ts`) ; chaque chemin ci-dessous est relatif a ce prefixe.
 *
 *   GET  /interventions                          liste classee, pagination par curseur, filtres du contrat (paragraphe 3)
 *   GET  /interventions.geojson?bbox=...         carte : emprise OBLIGATOIRE et bornee, plafond avec `tronque` et `total`
 *   GET  /interventions/:id                      fiche : motif, contributions, limites, fiches figees, actions, historique
 *   GET  /priorites/parametres                   versions des criteres et poids (PROVISOIRES tant que non approuvees)
 *   POST /priorites/parametres                   cree une NOUVELLE version provisoire (ADMIN, GESTIONNAIRE)
 *   POST /priorites/parametres/:id/approuver     ADMIN : pose l'approbation (point d'accroche de la separation des taches : lot 7)
 *   POST /priorites/parametres/:id/desapprouver  ADMIN : la retire, motif obligatoire
 *
 * ORDRE DES GARDES (le meme partout, il ferme l'oracle d'existence) :
 *   authentification -> module `decision` -> role -> RESSOURCE DESIGNEE (404 identique si inexistante, hors perimetre,
 *   supprimee, hors reseau classe ou d'identifiant mal forme) -> validation des entrees (400) -> service.
 *
 * LECTURE seule pour les interventions : aucune table n'est ecrite. Les ecritures de parametres sont deleguees au moteur
 * (`moteur.service`), qui les audite dans la meme transaction ; l'auteur vient de la SESSION, jamais du corps.
 *
 * TERRITOIRE. Un compte regional ne voit que les troncons de ses regions, et tous les totaux (`total`, `selection`,
 * `resume`, `horsGeometrie`) sont ceux de SON perimetre : aucun total national ne lui est rendu. Une region demandee hors
 * de son perimetre repond 403 `HORS_PERIMETRE`. Les versions de PARAMETRES sont des reglages nationaux, pas des donnees
 * regionales : elles ne sont pas filtrees (comme `/programmation/moteur/parametres`).
 *
 * Toute entree hostile (parametre inconnu, valeur hors enumeration, emprise trop grande, curseur falsifie, corps hors
 * schema) repond 400 avec une phrase, jamais 500. Les lectures ne sont pas auditees.
 */
export const aideDecisionInterventionsRouter = Router();

aideDecisionInterventionsRouter.use((_req, res, next) => {
  // Donnees privees derriere un jeton : jamais conservees par un cache partage.
  res.setHeader("Cache-Control", "private, no-cache");
  res.setHeader("Vary", "Authorization");
  next();
});
aideDecisionInterventionsRouter.use(requireAuth, requireModuleAccess("decision"));

const ecriture = requireRole("ADMIN", "GESTIONNAIRE");
const admin = requireRole("ADMIN");

const INTROUVABLE = { error: "intervention introuvable", code: "INTROUVABLE" } as const;

const interventionVisible = requireTerritoireMasque(
  async (req) => (estIdentifiant(req.params.id) ? regionsFiche("troncon", req.params.id) : []),
  { corps: INTROUVABLE },
);

type Gestionnaire = (req: Request, res: Response) => Promise<void>;

function h(fn: Gestionnaire): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch((err) => {
      if (err instanceof RefusMoteur) { res.status(err.http).json({ error: err.message, code: err.code }); return; }
      next(err);
    });
  };
}

function entreeInvalide(res: Response, message: string) {
  res.status(400).json({ error: message, code: "ENTREE_INVALIDE" });
}

function contexte(req: Request): Contexte {
  // Le role de la SESSION est transmis au moteur : il sert a la separation des taches (approuver ses propres parametres) sans
  // reposer sur l'hypothese que la route l'a deja garde.
  return { userId: req.user!.id, email: req.user!.email ?? null, ipAddress: req.ip, role: req.user!.role };
}

async function contexteLecture(req: Request): Promise<service.ContexteLecture> {
  return { regions: await regionsVisibles(req.user!), maintenant: new Date() };
}

/** Une region demandee doit etre dans le perimetre du compte regional (403), sinon la requete n'a pas lieu. */
function regionHorsPerimetre(res: Response, regionId: number | undefined, regions: readonly number[] | null): boolean {
  if (regionId === undefined || regions === null || regions.includes(regionId)) return false;
  res.status(403).json({ error: "Cette demande vise une region hors de votre perimetre.", code: "HORS_PERIMETRE" });
  return true;
}

// ----- interventions -----

aideDecisionInterventionsRouter.get("/interventions", h(async (req, res) => {
  const maintenant = new Date();
  const f = lireFiltresListe(req.query, maintenant);
  if (!f.ok) return entreeInvalide(res, f.message);
  const ctx = await contexteLecture(req);
  if (regionHorsPerimetre(res, f.valeur.regionId, ctx.regions)) return;
  res.json(await service.listerInterventions(prisma, ctx, f.valeur));
}));

aideDecisionInterventionsRouter.get("/interventions.geojson", h(async (req, res) => {
  const f = lireFiltresGeo(req.query, new Date());
  if (!f.ok) return entreeInvalide(res, f.message);
  const ctx = await contexteLecture(req);
  if (regionHorsPerimetre(res, f.valeur.regionId, ctx.regions)) return;
  res.json(await service.interventionsGeoJson(prisma, ctx, f.valeur));
}));

aideDecisionInterventionsRouter.get("/interventions/:id", interventionVisible, h(async (req, res) => {
  // Un identifiant mal forme repond comme un identifiant inconnu (meme corps), pour un compte national aussi.
  if (!estIdentifiant(req.params.id)) { res.status(404).json(INTROUVABLE); return; }
  const f = lireFiltresDetail(req.query);
  if (!f.ok) return entreeInvalide(res, f.message);
  res.json(await service.detailIntervention(prisma, await contexteLecture(req), req.params.id, f.valeur));
}));

// ----- parametres de priorite -----

const reel = z.number().finite();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date AAAA-MM-JJ attendue");
const poids = z.object(Object.fromEntries(CRITERES_TECHNIQUES.map((c) => [c, reel.optional()])) as Record<(typeof CRITERES_TECHNIQUES)[number], z.ZodOptional<z.ZodNumber>>).strict();

const corpsParametres = z.object({
  version: z.string().min(3).max(64),
  motif: z.string().trim().min(3).max(1000).nullish(),
  baseParametresId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).nullish(),
  priorite: z.object({
    poids: poids.optional(),
    validiteDe: date.nullable().optional(),
    validiteA: date.nullable().optional(),
    couvertureMinimale: reel.optional(),
    registrePointsNoirsMinimum: z.number().int().optional(),
    urgenceAnciennetePlafondJours: z.number().int().optional(),
  }).strict(),
}).strict();

const corpsDesapprobation = z.object({ motif: z.string().trim().min(3).max(1000) }).strict();

const corpsDetails = (e: z.ZodError) => e.flatten().fieldErrors;

aideDecisionInterventionsRouter.get("/priorites/parametres", h(async (_req, res) => {
  res.json({ data: await service.listerParametresPriorite(prisma) });
}));

aideDecisionInterventionsRouter.post("/priorites/parametres", ecriture, h(async (req, res) => {
  const p = corpsParametres.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "corps invalide", code: "ENTREE_INVALIDE", details: corpsDetails(p.error) }); return; }
  res.status(201).json(await service.creerParametresPriorite(prisma, {
    version: p.data.version, motif: p.data.motif ?? null, baseParametresId: p.data.baseParametresId ?? null,
    priorite: p.data.priorite as service.DemandeParametresPriorite["priorite"],
  }, contexte(req)));
}));

const idParametres = (req: Request, res: Response): string | null => {
  if (estIdentifiant(req.params.id)) return req.params.id;
  res.status(404).json({ error: "version de paramètres introuvable", code: "INTROUVABLE" });
  return null;
};

aideDecisionInterventionsRouter.post("/priorites/parametres/:id/approuver", admin, h(async (req, res) => {
  const id = idParametres(req, res);
  if (id === null) return;
  res.json(await service.approuverParametresPriorite(prisma, id, contexte(req)));
}));

aideDecisionInterventionsRouter.post("/priorites/parametres/:id/desapprouver", admin, h(async (req, res) => {
  const id = idParametres(req, res);
  if (id === null) return;
  const p = corpsDesapprobation.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "corps invalide", code: "ENTREE_INVALIDE", details: corpsDetails(p.error) }); return; }
  res.json(await service.desapprouverParametresPriorite(prisma, id, p.data.motif, contexte(req)));
}));
