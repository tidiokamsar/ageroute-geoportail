import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { prisma } from "../lib/prisma";
import { RefusMoteur, type Contexte } from "../programmation/moteur.service";
import * as ppe from "../programmation/ppe.service";
import * as depot from "../programmation/ppe.depot";
import { MAX_ANNEES_PPE, MIN_ANNEES_PPE } from "../programmation/ppe.noyau";

/**
 * `/api/v2/programmation/moteur/ppe` : la programmation PLURIANNUELLE minimale (PPE).
 *
 *   POST /simulations                     calcule, justifie et enregistre un plan de 2 a 5 annees
 *   GET  /simulations                     plans calcules
 *   GET  /simulations/:id                 le plan complet, annee par annee, ligne par ligne
 *   GET  /simulations/:id/praticabilite   lecture D-02 : branchee seulement si une valeur approuvee existe
 *   POST /simulations/:id/rejouer         recalcule depuis les seules entrees stockees et compare octet pour octet
 *   POST /simulations/:id/supprimer       suppression LOGIQUE
 *
 * CE QUE C'EST : le chainage de scenarios annuels par une methode GLOUTONNE et DETERMINISTE (un troncon retenu
 * une annee n'est pas reutilise ensuite). CE QUE CE N'EST PAS : une optimisation (aucun PLNE), ni une repartition
 * de budget : chaque enveloppe annuelle est SAISIE par l'utilisateur, aucune n'est inventee ni reportee.
 *
 * L'AUTEUR VIENT DE LA SESSION, jamais du corps ; corps `strict` (une cle inconnue est un 400, jamais ignoree) ;
 * montants en chaines de chiffres ; chaque ecriture est auditee dans sa transaction. Aucune route PUT, PATCH ou
 * DELETE. Lecture : tout compte du module `programmation` ; ecriture : ADMIN et GESTIONNAIRE.
 *
 * NI ENGAGEMENT, NI MARCHE, NI ORDRE DE TRAVAUX, NI FICHE : aucune de ces routes n'en cree.
 */
export const ppeProgrammationV2Router = Router();
ppeProgrammationV2Router.use(requireAuth, requireModuleAccess("programmation"));

const ecriture = requireRole("ADMIN", "GESTIONNAIRE");

const montant = z.string().regex(/^\d{1,18}$/, "chiffres attendus, en chaîne (GNF entiers, 18 chiffres au plus)");

const corpsPlan = z.object({
  anneeDebut: z.number().int().min(2000).max(2100),
  intitule: z.string().trim().min(3).max(300),
  enveloppes: z.array(z.object({
    budgetGnf: montant,
    plafondsRegionauxGnf: z.record(z.string().regex(/^\d{1,6}$/), montant).optional(),
  }).strict()).min(MIN_ANNEES_PPE).max(MAX_ANNEES_PPE),
  regionId: z.number().int().positive().nullish(),
  classe: z.enum(["RN", "RR", "RU", "PISTE", "NON_CLASSEE"]).nullish(),
  parametresId: z.string().min(1).max(64).nullish(),
}).strict();

function contexte(req: Request): Contexte {
  return { userId: req.user!.id, email: req.user!.email ?? null, ipAddress: req.ip };
}

function refus(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof RefusMoteur) { res.status(err.http).json({ error: err.message, code: err.code }); return; }
  next(err);
}

ppeProgrammationV2Router.get("/simulations", async (req, res, next) => {
  try {
    const p = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? "20"), 10) || 20));
    const debut = req.query.anneeDebut ? Number(req.query.anneeDebut) : null;
    if (debut !== null && !Number.isInteger(debut)) { res.status(400).json({ error: "anneeDebut : entier attendu" }); return; }
    const r = await depot.listerPlans(prisma, { anneeDebut: debut, limite: pageSize, decalage: (p - 1) * pageSize });
    res.json({ data: r.lignes.map(ppe.resumePlanApi), total: r.total, page: p, pageSize });
  } catch (err) { next(err); }
});

ppeProgrammationV2Router.post("/simulations", ecriture, async (req, res, next) => {
  const p = corpsPlan.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "corps invalide", details: p.error.flatten().fieldErrors }); return; }
  try {
    const r = await ppe.simulerPlan(prisma, {
      anneeDebut: p.data.anneeDebut, intitule: p.data.intitule,
      enveloppes: p.data.enveloppes.map((e) => ({
        budgetGnf: BigInt(e.budgetGnf),
        plafondsRegionauxGnf: Object.fromEntries(Object.entries(e.plafondsRegionauxGnf ?? {}).map(([k, v]) => [k, BigInt(v)])),
      })),
      regionId: p.data.regionId ?? null, classe: p.data.classe ?? null, parametresId: p.data.parametresId ?? null,
    }, contexte(req));
    res.status(201).json(r);
  } catch (err) { refus(err, res, next); }
});

ppeProgrammationV2Router.get("/simulations/:id", async (req, res, next) => {
  try { res.json(await ppe.lirePlanComplet(prisma, req.params.id)); } catch (err) { refus(err, res, next); }
});

ppeProgrammationV2Router.get("/simulations/:id/praticabilite", async (req, res, next) => {
  try {
    const { resultat } = await ppe.lirePlanComplet(prisma, req.params.id);
    res.json(await ppe.alertesPraticabilite(prisma, ppe.tronconsRetenusDe(resultat)));
  } catch (err) { refus(err, res, next); }
});

ppeProgrammationV2Router.post("/simulations/:id/rejouer", async (req, res, next) => {
  try { res.json(await ppe.rejouerPlan(prisma, req.params.id)); } catch (err) { refus(err, res, next); }
});

ppeProgrammationV2Router.post("/simulations/:id/supprimer", ecriture, async (req, res, next) => {
  try { res.json(await ppe.supprimerPlan(prisma, req.params.id, contexte(req))); } catch (err) { refus(err, res, next); }
});
