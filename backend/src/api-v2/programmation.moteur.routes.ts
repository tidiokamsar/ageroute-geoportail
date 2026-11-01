import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { prisma } from "../lib/prisma";
import * as moteur from "../programmation/moteur.service";
import * as depot from "../programmation/moteur.depot";
import * as ppe from "../programmation/ppe.service";
import { requireTerritoire, requireTerritoireMasque } from "../middleware/territoire.middleware";
import { regionsCorpsSimulation, regionsFicheIntervention, regionsScenario, regionsVisibles } from "../territoire/territoire.lecture";

/**
 * `/api/v2/programmation/moteur` : le moteur de risque et de programmation (paragraphe 7.7, A22).
 *
 *   GET  /parametres                      versions des ponderations et seuils (PROVISOIRES tant que non approuvees)
 *   POST /parametres                      cree une NOUVELLE version, provisoire (une version ne se modifie pas)
 *   POST /parametres/:id/approuver        ADMIN : pose l'approbation
 *   POST /parametres/:id/desapprouver     ADMIN : la retire, motif obligatoire
 *   GET  /simulations                     scenarios calcules
 *   POST /simulations                     calcule, justifie et enregistre un scenario annuel sous contrainte budgetaire
 *   GET  /simulations/:id                 le scenario complet, ligne par ligne, avec ses justifications
 *   GET  /praticabilite                   D-02 : « non branchee : aucune valeur approuvee » ou branchee EN LECTURE
 *   GET  /simulations/:id/praticabilite   signaux de lecture sur les lignes retenues (aucun effet sur le rang)
 *   POST /simulations/:id/rejouer         recalcule depuis les seules entrees stockees et compare octet pour octet
 *   POST /simulations/:id/supprimer       suppression LOGIQUE (refusee si une fiche figee le cite)
 *   POST /simulations/:id/fiches          fige les lignes retenues en fiches d'intervention
 *   GET  /fiches, GET /fiches/:id         les fiches figees et leur cycle de vie
 *   GET  /fiches/:id/verification         recalcule l'empreinte SHA-256 du texte stocke
 *   POST /fiches/:id/statut               fait avancer une fiche depuis le Geoportail (jusqu'a APPROUVE seulement)
 *
 * AUCUNE ROUTE NE MODIFIE NI NE SUPPRIME UNE FICHE : ni PUT, ni PATCH, ni DELETE. La base le refuse aussi.
 *
 * L'AUTEUR VIENT DE LA SESSION, jamais du corps. L'ORIGINE D'UN STATUT AUSSI : le corps de
 * `/fiches/:id/statut` ne connait ni `origine`, ni message DigitalRoad, ni inspection (schema
 * strict), si bien que TRANSMIS, EN_EXECUTION, ACHEVE et EVALUE sont refuses (403, ORIGINE_INTERDITE).
 *
 * LES MONTANTS SONT DES CHAINES DE CHIFFRES (GNF au-dela de 2^53, comme partout).
 *
 * NI ENGAGEMENT, NI MARCHE, NI ORDRE DE TRAVAUX : aucune de ces routes n'en cree.
 */
export const moteurProgrammationV2Router = Router();
moteurProgrammationV2Router.use(requireAuth, requireModuleAccess("programmation"));

const ecriture = requireRole("ADMIN", "GESTIONNAIRE");
const admin = requireRole("ADMIN");

/**
 * CONTROLE TERRITORIAL (A10). Un scenario porte la region de son perimetre (`perimetre.regionId`) ; une fiche figee, celle
 * de son troncon. Un compte regional ne calcule que sur UNE region de son perimetre (un calcul national lui est refuse :
 * 403) et ne lit, rejoue, supprime ou fait avancer que ce qui est dans son perimetre. Hors perimetre, la ressource est
 * INTROUVABLE (404, meme corps que la route : voir territoire.lecture.ts). Les versions de PARAMETRES (ponderations et
 * seuils) sont des reglages nationaux, pas des donnees regionales : elles ne sont pas filtrees.
 */
const scenarioVisible = (message = "scénario introuvable ou supprimé") =>
  requireTerritoireMasque((req) => regionsScenario(req.params.id), { corps: { error: message, code: "INTROUVABLE" } });
const ficheVisible = requireTerritoireMasque((req) => regionsFicheIntervention(req.params.id), { corps: { error: "fiche introuvable", code: "INTROUVABLE" } });
const simulationDansPerimetre = requireTerritoire((req) => regionsCorpsSimulation(req.body));

const montant = z.string().regex(/^\d{1,18}$/, "chiffres attendus, en chaîne (GNF entiers, 18 chiffres au plus)");
const identifiant = z.string().min(1).max(64);

const corpsParametres = z.object({
  version: z.string().min(3).max(64),
  valeurs: z.record(z.unknown()),
  motif: z.string().trim().min(3).max(1000).nullish(),
}).strict();

const corpsDesapprobation = z.object({ motif: z.string().trim().min(3).max(1000) }).strict();

const corpsSimulation = z.object({
  annee: z.number().int().min(2000).max(2100),
  intitule: z.string().trim().min(3).max(300),
  budgetGnf: montant,
  regionId: z.number().int().positive().nullish(),
  classe: z.enum(["RN", "RR", "RU", "PISTE", "NON_CLASSEE"]).nullish(),
  plafondsRegionauxGnf: z.record(z.string().regex(/^\d{1,6}$/), montant).optional(),
  parametresId: identifiant.nullish(),
}).strict();

const corpsFiches = z.object({
  tronconIds: z.array(identifiant).min(1).max(500).optional(),
  sourceFinancement: z.string().trim().min(2).max(120).nullish(),
}).strict();

const STATUTS_SAISISSABLES = ["BROUILLON", "PROPOSE", "ARBITRE", "APPROUVE", "TRANSMIS", "EN_EXECUTION", "ACHEVE", "EVALUE"] as const;
const corpsStatut = z.object({
  vers: z.enum(STATUTS_SAISISSABLES),
  motif: z.string().trim().min(3).max(1000).nullish(),
}).strict();

function page(req: Request) {
  const p = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? "20"), 10) || 20));
  return { page: p, pageSize, decalage: (p - 1) * pageSize };
}

function contexte(req: Request): moteur.Contexte {
  return { userId: req.user!.id, email: req.user!.email ?? null, ipAddress: req.ip };
}

function refus(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof moteur.RefusMoteur) { res.status(err.http).json({ error: err.message, code: err.code }); return; }
  next(err);
}

function invalide(res: Response, details: unknown) {
  res.status(400).json({ error: "corps invalide", details });
}

// ----- parametres -----

moteurProgrammationV2Router.get("/parametres", async (_req, res, next) => {
  try { res.json({ data: await moteur.listerParametres(prisma) }); } catch (err) { next(err); }
});

moteurProgrammationV2Router.post("/parametres", ecriture, async (req, res, next) => {
  const p = corpsParametres.safeParse(req.body);
  if (!p.success) { invalide(res, p.error.flatten().fieldErrors); return; }
  try { res.status(201).json(await moteur.creerParametres(prisma, p.data, contexte(req))); } catch (err) { refus(err, res, next); }
});

moteurProgrammationV2Router.post("/parametres/:id/approuver", admin, async (req, res, next) => {
  try { res.json(await moteur.approuverParametres(prisma, req.params.id, contexte(req))); } catch (err) { refus(err, res, next); }
});

moteurProgrammationV2Router.post("/parametres/:id/desapprouver", admin, async (req, res, next) => {
  const p = corpsDesapprobation.safeParse(req.body);
  if (!p.success) { invalide(res, p.error.flatten().fieldErrors); return; }
  try { res.json(await moteur.desapprouverParametres(prisma, req.params.id, p.data.motif, contexte(req))); } catch (err) { refus(err, res, next); }
});

// ----- simulations -----

moteurProgrammationV2Router.get("/simulations", async (req, res, next) => {
  try {
    const { page: p, pageSize, decalage } = page(req);
    const annee = req.query.annee ? Number(req.query.annee) : null;
    if (annee !== null && !Number.isInteger(annee)) { res.status(400).json({ error: "annee : entier attendu" }); return; }
    const r = await depot.listerScenarios(prisma, { annee, limite: pageSize, decalage, regions: await regionsVisibles(req.user!) });
    res.json({ data: r.lignes.map(moteur.resumeScenarioApi), total: r.total, page: p, pageSize });
  } catch (err) { next(err); }
});

moteurProgrammationV2Router.post("/simulations", ecriture, simulationDansPerimetre, async (req, res, next) => {
  const p = corpsSimulation.safeParse(req.body);
  if (!p.success) { invalide(res, p.error.flatten().fieldErrors); return; }
  try {
    const r = await moteur.simuler(prisma, {
      annee: p.data.annee, intitule: p.data.intitule, budgetGnf: BigInt(p.data.budgetGnf),
      regionId: p.data.regionId ?? null, classe: p.data.classe ?? null, parametresId: p.data.parametresId ?? null,
      plafondsRegionauxGnf: Object.fromEntries(Object.entries(p.data.plafondsRegionauxGnf ?? {}).map(([k, v]) => [k, BigInt(v)])),
    }, contexte(req));
    res.status(201).json(r);
  } catch (err) { refus(err, res, next); }
});

moteurProgrammationV2Router.get("/simulations/:id", scenarioVisible(), async (req, res, next) => {
  try { res.json(await moteur.lireScenarioComplet(prisma, req.params.id)); } catch (err) { refus(err, res, next); }
});

// D-02 : la praticabilite n'est lue que si une valeur APPROUVEE existe ; sinon la reponse le dit.
moteurProgrammationV2Router.get("/praticabilite", async (_req, res, next) => {
  try { res.json(await ppe.statutPraticabilite(prisma)); } catch (err) { next(err); }
});

moteurProgrammationV2Router.get("/simulations/:id/praticabilite", scenarioVisible(), async (req, res, next) => {
  try {
    const { resultat } = await moteur.lireScenarioComplet(prisma, req.params.id);
    res.json(await ppe.alertesPraticabilite(prisma, ppe.tronconsRetenusDe(resultat)));
  } catch (err) { refus(err, res, next); }
});

moteurProgrammationV2Router.post("/simulations/:id/rejouer", scenarioVisible(), async (req, res, next) => {
  try { res.json(await moteur.rejouer(prisma, req.params.id)); } catch (err) { refus(err, res, next); }
});

moteurProgrammationV2Router.post("/simulations/:id/supprimer", ecriture, scenarioVisible("scénario introuvable ou déjà supprimé"), async (req, res, next) => {
  try { res.json(await moteur.supprimerScenario(prisma, req.params.id, contexte(req))); } catch (err) { refus(err, res, next); }
});

moteurProgrammationV2Router.post("/simulations/:id/fiches", ecriture, scenarioVisible(), async (req, res, next) => {
  const p = corpsFiches.safeParse(req.body ?? {});
  if (!p.success) { invalide(res, p.error.flatten().fieldErrors); return; }
  try { res.status(201).json(await moteur.figerFiches(prisma, req.params.id, p.data, contexte(req))); } catch (err) { refus(err, res, next); }
});

// ----- fiches -----

moteurProgrammationV2Router.get("/fiches", async (req, res, next) => {
  try {
    const { page: p, pageSize, decalage } = page(req);
    const annee = req.query.annee ? Number(req.query.annee) : null;
    if (annee !== null && !Number.isInteger(annee)) { res.status(400).json({ error: "annee : entier attendu" }); return; }
    const r = await depot.listerFiches(prisma, {
      annee, scenarioId: req.query.scenarioId ? String(req.query.scenarioId) : null,
      statut: req.query.statut ? String(req.query.statut) : null, limite: pageSize, decalage,
      regions: await regionsVisibles(req.user!),
    });
    res.json({ data: r.lignes.map(moteur.ficheCouranteApi), total: r.total, page: p, pageSize });
  } catch (err) { next(err); }
});

moteurProgrammationV2Router.get("/fiches/:id", ficheVisible, async (req, res, next) => {
  try { res.json(await moteur.lireFicheComplete(prisma, req.params.id)); } catch (err) { refus(err, res, next); }
});

moteurProgrammationV2Router.get("/fiches/:id/verification", ficheVisible, async (req, res, next) => {
  try { res.json(await moteur.verifierFicheStockee(prisma, req.params.id)); } catch (err) { refus(err, res, next); }
});

moteurProgrammationV2Router.post("/fiches/:id/statut", ecriture, ficheVisible, async (req, res, next) => {
  const p = corpsStatut.safeParse(req.body);
  if (!p.success) { invalide(res, p.error.flatten().fieldErrors); return; }
  try { res.status(201).json(await moteur.changerStatutFiche(prisma, req.params.id, p.data.vers, p.data.motif ?? null, contexte(req))); } catch (err) { refus(err, res, next); }
});
