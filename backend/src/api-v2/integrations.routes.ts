import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { prisma } from "../lib/prisma";
import { lireConfigIntegrations, resumerConfig } from "../integrations/config";
import { creerAdaptateurs } from "../integrations/adaptateurs";
import { CHAMPS_A_CONFIRMER, CONTRAT_VERSION } from "../integrations/contrats";
import { depotSql } from "../integrations/outbox.depot";
import { lecteurSourcesSql } from "../integrations/sources.depot";
import {
  RefusOutbox, abandonnerEvenement, detailEvenement, enregistrerEvenement, etatOutbox, listerEvenements,
  relancerEvenement, rejouerEvenement, traiterLot, type CodeRefus, type DepsOutbox,
} from "../integrations/outbox.service";
import { DESTINATIONS, ROUTES, STATUTS_OUTBOX, TYPES_SOURCE, type EvenementOutbox } from "../integrations/types";

/**
 * `/api/v2/integrations` -- administration de l'outbox des integrations sortantes (A13, 7.10, 7.15).
 *
 *   GET  /                          configuration (sans jeton ni URL), etat de l'outbox par statut
 *   GET  /contrats                  routes et LISTE EXACTE de ce qui reste a confirmer, par destination
 *   GET  /outbox                    evenements (filtre statut, destination ; pagine), sans la charge
 *   GET  /outbox/:id                un evenement, ses tentatives, son journal d'audit ; ?avecCharge=true pour la charge
 *   POST /outbox                    inscrit un evenement pour une source VALIDEE (corps strict)
 *   POST /outbox/:id/relancer       remet en file un evenement ECHEC ou ABANDONNE (motif obligatoire)
 *   POST /outbox/:id/abandonner     sort un evenement de la file sans l'effacer (motif obligatoire)
 *   POST /outbox/:id/rejouer        emet maintenant ; sans effet si deja ENVOYE
 *   POST /outbox/traiter            emet un lot d'evenements dus
 *
 * RESERVE AU ROLE ADMIN. Il n'existe pas de cle de module « integrations » dans lib/modules.ts :
 * en creer une imposerait de la propager au frontend et aux profils, et la regle de ce fichier
 * est celle de « administration », qui reste strictement reservee a ADMIN. requireModuleAccess
 * serait ici sans objet (ADMIN passe toujours, les autres sont deja refuses par le role).
 * Si AGEROUTE veut deleguer ces actions, il faudra creer la cle de module puis l'ajouter ici.
 *
 * Toute ecriture est auditee par le service, dans la transaction de la transition. L'auteur vient
 * de la session, jamais du corps. Les corps sont STRICTS : une cle inconnue est un 400.
 *
 * RIEN N'EST EMIS TANT QU'UNE DESTINATION N'EST PAS ACTIVEE par l'environnement (config.ts) : sans
 * elle, POST /outbox repond 409 DESTINATION_DESACTIVEE et les actions d'emission ne contactent
 * personne. Aucun ordonnanceur n'est demarre par ce module.
 */

const STATUT_HTTP: Record<CodeRefus, number> = {
  DESTINATION_DESACTIVEE: 409,
  SOURCE_NON_EMISSIBLE: 409,
  SOURCE_INCONNUE: 404,
  CHARGE_NON_CONSTRUISIBLE: 422,
  CHARGE_NON_CONFORME: 422,
  CHAMP_INTERNE_DANS_CHARGE: 422,
  CHARGE_TROP_GROSSE: 422,
  EVENEMENT_INTROUVABLE: 404,
  TRANSITION_INTERDITE: 409,
  DEJA_ENVOYE: 409,
  MOTIF_REQUIS: 400,
  VERROU_ACTIF: 409,
};

const corpsInscription = z.object({
  destination: z.enum(DESTINATIONS),
  sourceType: z.enum(TYPES_SOURCE),
  sourceId: z.string().trim().min(1).max(200),
}).strict();

const corpsMotif = z.object({ motif: z.string().trim().min(3).max(480) }).strict();
const corpsLot = z.object({ limite: z.number().int().min(1).max(200).optional() }).strict();
const parametreId = z.object({ id: z.string().uuid() });

const requeteListe = z.object({
  statut: z.enum(STATUTS_OUTBOX).optional(),
  destination: z.enum(DESTINATIONS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

/** L'evenement tel que l'API le montre : sans la charge, avec sa taille. */
export function evenementApi(e: EvenementOutbox) {
  const { chargeCanonique, ...reste } = e;
  return { ...reste, tailleCharge: chargeCanonique.length };
}

export type FabriqueDeps = () => DepsOutbox;

export function depsParDefaut(): DepsOutbox {
  const config = lireConfigIntegrations(process.env);
  return {
    depot: depotSql(prisma),
    sources: lecteurSourcesSql(prisma),
    adaptateurs: creerAdaptateurs(config),
    politique: config.politique,
    verrouMs: config.verrouMs,
  };
}

export function creerRouteurIntegrations(fabrique: FabriqueDeps = depsParDefaut, lireConfig: () => ReturnType<typeof lireConfigIntegrations> = () => lireConfigIntegrations(process.env)): Router {
  const routeur = Router();
  routeur.use(requireAuth, requireRole("ADMIN"));

  const erreurs = (res: Response, next: NextFunction) => (err: unknown) => {
    if (err instanceof RefusOutbox) {
      res.status(STATUT_HTTP[err.code]).json({ error: err.message, code: err.code });
      return;
    }
    next(err);
  };
  const refuserSiInvalide = (res: Response, parse: { success: false; error: z.ZodError }) => {
    res.status(400).json({ error: "requete invalide", details: parse.error.flatten() });
  };

  routeur.get("/", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const deps = fabrique();
      res.json({
        contrat: CONTRAT_VERSION,
        avertissement: "Les contrats sont des hypotheses testees contre des simulateurs ecrits par AGEROUTE. Aucun systeme reel (DigitalRoad, SharePoint, BDR / L2R) n'a ete atteint.",
        configuration: resumerConfig(lireConfig()),
        outbox: await etatOutbox(deps),
      });
    } catch (err) { next(err); }
  });

  routeur.get("/contrats", (_req: Request, res: Response) => {
    res.json({
      contrat: CONTRAT_VERSION,
      routes: DESTINATIONS.map((d) => ({ destination: d, ...ROUTES[d], aConfirmer: CHAMPS_A_CONFIRMER[d] })),
    });
  });

  routeur.get("/outbox", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = requeteListe.safeParse(req.query);
      if (!q.success) return refuserSiInvalide(res, q);
      const { evenements, total } = await listerEvenements(fabrique(), {
        statut: q.data.statut, destination: q.data.destination, limite: q.data.pageSize, decalage: (q.data.page - 1) * q.data.pageSize,
      });
      res.json({ evenements: evenements.map(evenementApi), total, page: q.data.page, pageSize: q.data.pageSize });
    } catch (err) { erreurs(res, next)(err); }
  });

  routeur.get("/outbox/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const p = parametreId.safeParse(req.params);
      if (!p.success) return refuserSiInvalide(res, p);
      const d = await detailEvenement(fabrique(), p.data.id);
      const avecCharge = req.query.avecCharge === "true";
      res.json({
        evenement: avecCharge ? { ...evenementApi(d.evenement), charge: JSON.parse(d.evenement.chargeCanonique) } : evenementApi(d.evenement),
        tentatives: d.tentatives,
        journal: d.journal,
      });
    } catch (err) { erreurs(res, next)(err); }
  });

  routeur.post("/outbox", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const c = corpsInscription.safeParse(req.body);
      if (!c.success) return refuserSiInvalide(res, c);
      const r = await enregistrerEvenement(fabrique(), { ...c.data, creeParId: req.user!.id, ipAddress: req.ip });
      res.status(r.dejaEnregistre ? 200 : 201).json({ evenement: evenementApi(r.evenement), dejaEnregistre: r.dejaEnregistre });
    } catch (err) { erreurs(res, next)(err); }
  });

  routeur.post("/outbox/traiter", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const c = corpsLot.safeParse(req.body ?? {});
      if (!c.success) return refuserSiInvalide(res, c);
      const config = lireConfig();
      const r = await traiterLot(fabrique(), Math.min(c.data.limite ?? config.lotMax, config.lotMax));
      res.json(r);
    } catch (err) { erreurs(res, next)(err); }
  });

  routeur.post("/outbox/:id/relancer", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const p = parametreId.safeParse(req.params);
      if (!p.success) return refuserSiInvalide(res, p);
      const c = corpsMotif.safeParse(req.body);
      if (!c.success) return refuserSiInvalide(res, c);
      const e = await relancerEvenement(fabrique(), p.data.id, { utilisateurId: req.user!.id, motif: c.data.motif, ipAddress: req.ip });
      res.json({ evenement: evenementApi(e) });
    } catch (err) { erreurs(res, next)(err); }
  });

  routeur.post("/outbox/:id/abandonner", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const p = parametreId.safeParse(req.params);
      if (!p.success) return refuserSiInvalide(res, p);
      const c = corpsMotif.safeParse(req.body);
      if (!c.success) return refuserSiInvalide(res, c);
      const e = await abandonnerEvenement(fabrique(), p.data.id, { utilisateurId: req.user!.id, motif: c.data.motif, ipAddress: req.ip });
      res.json({ evenement: evenementApi(e) });
    } catch (err) { erreurs(res, next)(err); }
  });

  routeur.post("/outbox/:id/rejouer", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const p = parametreId.safeParse(req.params);
      if (!p.success) return refuserSiInvalide(res, p);
      const r = await rejouerEvenement(fabrique(), p.data.id);
      // Un rejeu qui n'emet rien (deja envoye, abandonne, destination desactivee) n'est pas une erreur :
      // c'est le comportement voulu, et la reponse dit pourquoi.
      res.json(r);
    } catch (err) { erreurs(res, next)(err); }
  });

  return routeur;
}

export const integrationsV2Router = creerRouteurIntegrations();
