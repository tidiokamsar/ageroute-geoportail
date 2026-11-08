import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { queryBoolean } from "../lib/list-query";
import { territoireAnalyseReferentiel, territoireAnomalie, territoireAnomaliesGroupe } from "../territoire/territoire.v2";
import { CODES_REGLES, REGLES, STATUTS, TRANSITIONS } from "../referentiel/registre.noyau";
import {
  PLAFOND_GROUPE, RefusRegistre, analyser, annuler, appliquer, decider, detail, exporterCsv, lister, previsualiser,
} from "../referentiel/registre.service";
import { synthese } from "../referentiel/synthese.depot";

/**
 * Registre des anomalies du referentiel des troncons (BDRI, lot C) : `/api/v2/referentiel/troncons`.
 *
 *   GET  /regles                          catalogue des regles et transitions (lecture)
 *   GET  /synthese[?regionId]             tableau de bord du referentiel (lecture)
 *   GET  /anomalies[.csv]                 liste filtree, ou son export CSV (lecture)
 *   GET  /anomalies/:id                   fiche et journal des decisions (lecture)
 *   POST /analyse                         constate et enregistre (idempotent), par region
 *   POST /anomalies/:id/decision          examiner, proposer, valider, rejeter, rouvrir
 *   POST /anomalies/previsualisation      ce que l'application ferait, sans rien ecrire
 *   POST /anomalies/application           applique des corrections VALIDEES (tout ou rien)
 *   POST /anomalies/:id/annulation        rend l'ancienne valeur d'une correction appliquee
 *
 * LECTURE : tout compte ayant le module `troncons`. ECRITURE : ADMIN ou GESTIONNAIRE, dans son perimetre
 * territorial. L'analyse nationale est reservee a l'administrateur, comme le rapport de qualite.
 */
export const referentielV2Router = Router();
referentielV2Router.use(requireAuth, requireModuleAccess("troncons"));
const ecriture = requireRole("ADMIN", "GESTIONNAIRE");

function repondre(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof RefusRegistre) { res.status(err.http).json({ error: err.message, code: err.code }); return; }
  next(err);
}

const filtres = z.object({
  statut: z.enum(STATUTS).optional(),
  regle: z.enum(CODES_REGLES as [string, ...string[]]).optional(),
  gravite: z.enum(["BLOQUANTE", "MAJEURE", "MINEURE", "INFO"]).optional(),
  regionId: z.coerce.number().int().positive().optional(),
  tronconId: z.string().min(1).max(64).optional(),
  inclureDisparues: queryBoolean,
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
}).strict();

referentielV2Router.get("/regles", (_req, res) => {
  res.json({ regles: CODES_REGLES.map((code) => ({ code, ...REGLES[code] })), statuts: STATUTS, transitions: TRANSITIONS });
});

referentielV2Router.get("/synthese", async (req, res, next) => {
  try {
    const { regionId } = z.object({ regionId: z.coerce.number().int().positive().optional() }).strict().parse(req.query);
    res.json(await synthese(regionId ?? null));
  } catch (err) { repondre(err, res, next); }
});

referentielV2Router.get("/anomalies.csv", async (req, res, next) => {
  try {
    const csv = await exporterCsv(filtres.parse(req.query) as never);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="anomalies-referentiel-troncons.csv"');
    res.send(csv);
  } catch (err) { repondre(err, res, next); }
});

referentielV2Router.get("/anomalies", async (req, res, next) => {
  try { res.json(await lister(filtres.parse(req.query) as never)); } catch (err) { repondre(err, res, next); }
});

referentielV2Router.get("/anomalies/:id", async (req, res, next) => {
  try { res.json(await detail(req.params.id)); } catch (err) { repondre(err, res, next); }
});

const corpsAnalyse = z.object({
  regionId: z.number().int().positive().optional(),
  national: z.boolean().optional(),
  /** Seuils PARAMETRES de l'analyse : le cahier n'en fixe aucun ; ils sont enregistres avec chaque constat. */
  ecartLongueurPct: z.number().min(1).max(500).default(10),
  ecartPkPct: z.number().min(1).max(500).default(10),
}).strict();

referentielV2Router.post("/analyse", ecriture, territoireAnalyseReferentiel, async (req: Request, res, next) => {
  try {
    const c = corpsAnalyse.parse(req.body ?? {});
    const user = req.user!;
    if (c.national !== true && c.regionId === undefined) {
      return res.status(400).json({ code: "PORTEE_REQUISE", error: "Précisez regionId, ou national=true (réservé à l'administrateur)." });
    }
    if (c.national === true && user.role !== "ADMIN") {
      return res.status(403).json({ code: "NATIONAL_RESERVE_ADMIN", error: "L'analyse nationale est réservée aux administrateurs." });
    }
    const portee = { regionId: c.national === true ? null : (c.regionId ?? null) };
    return res.json(await analyser(portee, { ecartLongueurPct: c.ecartLongueurPct, ecartPkPct: c.ecartPkPct }, user.id, req.ip));
  } catch (err) { return repondre(err, res, next); }
});

const corpsDecision = z.object({
  statut: z.enum(STATUTS),
  commentaire: z.string().max(2000).nullish(),
  correction: z.object({
    champ: z.string().min(1).max(40),
    nouvelle: z.union([z.number(), z.string().max(40)]),
    justification: z.string().max(2000),
    source: z.string().max(500),
  }).strict().nullish(),
}).strict();

referentielV2Router.post("/anomalies/:id/decision", ecriture, territoireAnomalie, async (req, res, next) => {
  try { res.json(await decider(req.params.id, corpsDecision.parse(req.body) as never, req.user!.id, req.ip)); } catch (err) { repondre(err, res, next); }
});

const corpsIds = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(PLAFOND_GROUPE) }).strict();

referentielV2Router.post("/anomalies/previsualisation", async (req, res, next) => {
  try { res.json({ lignes: await previsualiser(corpsIds.parse(req.body).ids) }); } catch (err) { repondre(err, res, next); }
});

referentielV2Router.post("/anomalies/application", ecriture, territoireAnomaliesGroupe, async (req, res, next) => {
  try { res.json(await appliquer(corpsIds.parse(req.body).ids, req.user!.id, req.ip)); } catch (err) { repondre(err, res, next); }
});

const corpsAnnulation = z.object({ motif: z.string().min(1).max(2000) }).strict();

referentielV2Router.post("/anomalies/:id/annulation", ecriture, territoireAnomalie, async (req, res, next) => {
  try { res.json(await annuler(req.params.id, corpsAnnulation.parse(req.body).motif, req.user!.id, req.ip)); } catch (err) { repondre(err, res, next); }
});
