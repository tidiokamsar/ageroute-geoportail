import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { requireTerritoire } from "../middleware/territoire.middleware";
import { prisma } from "../lib/prisma";
import { perimetreDe, regionsFiche } from "../territoire/territoire.service";
import { GROUPES, regionsDuPerimetre, type Groupe, type Portee } from "../tableau-de-bord/indicateurs.noyau";
import { REGISTRE } from "../tableau-de-bord/indicateurs.registre";
import { controler, evaluer } from "../tableau-de-bord/tableau-de-bord.service";
import { controlTower } from "../tableau-de-bord/control-tower.service";
import { voletPortions, voletProgrammation } from "../tableau-de-bord/fiche360.service";
import { aControler, voletConstats } from "../tableau-de-bord/historique.service";

/**
 * `/api/v2/tableau-de-bord` -- le tableau de bord executif (7.12) et la Control Tower.
 *
 *   GET /indicateurs?groupes=reseau,portions   indicateurs du registre, avec leur perimetre
 *   GET /control-tower                         synthese d'exploitation, module par module
 *   GET /controle                              rapproche chaque indicateur de sa requete de controle (A12)
 *
 * LA PORTEE VIENT DU COMPTE, PAS DE LA REQUETE (A10). Un compte a perimetre regional ne recoit que les
 * valeurs de SES regions ; un indicateur qui ne se ventile pas par region lui est refuse (statut
 * INDISPONIBLE), jamais remplace par le national. Aucun parametre ne peut elargir la portee.
 *
 * Lecture seule : rien n'est ecrit, donc rien n'est audite.
 */
export const tableauDeBordV2Router = Router();
tableauDeBordV2Router.use(requireAuth, requireModuleAccess("dashboard"));

async function porteeDe(req: Request): Promise<Portee> {
  const perimetre = await perimetreDe(req.user!);
  return { regions: regionsDuPerimetre(perimetre), maintenant: new Date() };
}

async function descriptionPortee(portee: Portee) {
  if (portee.regions === null) return { national: true as const, regions: [] as { id: number; nom: string }[] };
  const regions = await prisma.region.findMany({ where: { id: { in: [...portee.regions] } }, select: { id: true, nom: true }, orderBy: { nom: "asc" } });
  return { national: false as const, regions };
}

const requeteIndicateurs = z.object({
  groupes: z.string().optional().transform((v) => (v ? v.split(",").map((g) => g.trim()).filter(Boolean) : ["reseau", "portions", "qualite"])),
}).transform((q, ctx) => {
  const inconnus = q.groupes.filter((g) => !(GROUPES as readonly string[]).includes(g));
  if (inconnus.length > 0) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: `groupe inconnu : ${inconnus.join(", ")}` }); return z.NEVER; }
  return { groupes: q.groupes as Groupe[] };
});

tableauDeBordV2Router.get("/indicateurs", async (req, res, next) => {
  const q = requeteIndicateurs.safeParse(req.query);
  if (!q.success) { res.status(400).json({ error: "groupes invalides", details: q.error.flatten() }); return; }
  try {
    const portee = await porteeDe(req);
    res.json({
      genereLe: portee.maintenant.toISOString(),
      portee: await descriptionPortee(portee),
      indicateurs: await evaluer(prisma, REGISTRE, portee, { groupes: q.data.groupes }),
    });
  } catch (err) { next(err); }
});

tableauDeBordV2Router.get("/control-tower", async (req, res, next) => {
  try {
    const portee = await porteeDe(req);
    res.json({ portee: await descriptionPortee(portee), ...(await controlTower(prisma, REGISTRE, portee)) });
  } catch (err) { next(err); }
});

/** Le rapprochement relance chaque requete deux fois : reserve a qui administre ou gere la donnee. */
tableauDeBordV2Router.get("/controle", requireRole("ADMIN", "GESTIONNAIRE"), async (req, res, next) => {
  try {
    const portee = await porteeDe(req);
    res.json({ portee: await descriptionPortee(portee), ...(await controler(prisma, REGISTRE, portee)) });
  } catch (err) { next(err); }
});

// ===================================================================================== Fiche 360

/**
 * `/api/v2/fiche-360` -- les volets portion et programmation de la fiche d'un troncon.
 *
 * LECTURE REFUSEE HORS PERIMETRE (A10) : un compte regional qui demande un troncon d'une autre region
 * (ou d'une region inconnue) recoit 403, pas la fiche. Un troncon introuvable repond 404.
 */
export const fiche360V2Router = Router();
fiche360V2Router.use(requireAuth);

const horsPerimetre = requireTerritoire((req) => regionsFiche("troncon", req.params.id));

fiche360V2Router.get("/troncons/:id/portions", horsPerimetre, async (req, res, next) => {
  try {
    const volet = await voletPortions(prisma, req.params.id);
    if (!volet) { res.status(404).json({ error: "tronçon introuvable ou supprimé", code: "INTROUVABLE" }); return; }
    res.json(volet);
  } catch (err) { next(err); }
});

// Les montants prevus sont des donnees de programmation : meme module que l'ecran de programmation.
fiche360V2Router.get("/troncons/:id/programmation", requireModuleAccess("programmation"), horsPerimetre, async (req, res, next) => {
  try {
    const volet = await voletProgrammation(prisma, req.params.id);
    if (!volet) { res.status(404).json({ error: "tronçon introuvable ou supprimé", code: "INTROUVABLE" }); return; }
    res.json(volet);
  } catch (err) { next(err); }
});

// ===================================================================================== Historique et « à contrôler » (phase 6)

/**
 * `GET /api/v2/fiche-360/troncons/:id/constats` : l'HISTOIRE d'une section issue du terrain (defauts et observations
 * rattaches), par jour de constat, avec les recurrences. Confirmes et proposes restent separes. Meme perimetre (A10) que les
 * autres volets. Voir `tableau-de-bord/historique.noyau.ts` pour les regles.
 */
fiche360V2Router.get("/troncons/:id/constats", requireModuleAccess("inspections"), horsPerimetre, async (req, res, next) => {
  try {
    const volet = await voletConstats(prisma, req.params.id);
    if (!volet) { res.status(404).json({ error: "tronçon introuvable ou supprimé", code: "INTROUVABLE" }); return; }
    res.json(volet);
  } catch (err) { next(err); }
});

/**
 * `GET /api/v2/fiche-360/a-controler?region=&limite=` : les troncons a CONTROLER en premier, classes avec leurs facteurs.
 * Aide au controle, pas une decision. Le perimetre vient du COMPTE (A10) : une region demandee hors de ses regions est refusee
 * (403), jamais elargie.
 */
const paramsAControler = z.object({
  region: z.coerce.number().int().positive().optional(),
  limite: z.coerce.number().int().min(1).max(200).optional(),
}).strict();

fiche360V2Router.get("/a-controler", requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const p = paramsAControler.safeParse(req.query);
    if (!p.success) { res.status(400).json({ error: "paramètres invalides : region (identifiant), limite (1 à 200)", details: p.error.flatten().fieldErrors }); return; }
    const perimetre = await perimetreDe(req.user!);
    let regionIds: number[] | null = perimetre.national ? null : [...perimetre.regions];
    if (p.data.region !== undefined) {
      if (regionIds !== null && !regionIds.includes(p.data.region)) { res.status(403).json({ error: "Cette région est hors de votre périmètre.", code: "HORS_PERIMETRE" }); return; }
      regionIds = [p.data.region];
    }
    res.json(await aControler(prisma, { regionIds, limite: p.data.limite ?? 50 }));
  } catch (err) { next(err); }
});
