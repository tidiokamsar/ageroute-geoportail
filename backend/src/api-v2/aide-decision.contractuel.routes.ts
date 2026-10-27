import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { requireTerritoire } from "../middleware/territoire.middleware";
import { lireRequete, type RequeteContractuel } from "../aide-decision/contractuel.filtres";
import { lireContractuel, lireMarche } from "../aide-decision/contractuel.service";

/**
 * `/api/v2/aide-decision/contractuel` : suivi contractuel de l'aide a la decision (AD-LOT-5). Routeur monte par l'orchestrateur
 * sous `/aide-decision` (`api-v2/index.ts`) ; ce fichier ne monte rien.
 *
 *   GET /contractuel               marches recenses, montants SEPARES, avancement declare et constate, retards, liens
 *                                  marche-chantier-troncon, controles de coherence, synthese ; pagination par curseur
 *   GET /contractuel/marches/:id   fiche d'un marche (decomptes compris)
 *
 * LES GARDES, DANS L'ORDRE : jeton (`requireAuth`, compte relu en base), modules `marches` ET `decision`, entree (400),
 * territoire (403 pour une region demandee hors perimetre). Le perimetre territorial des RESULTATS est ensuite applique par le
 * service, marche par marche. La confidentialite financiere (D-C1-1) n'est pas tranchee : le module `marches` fait office de
 * droit financier, et sans lui aucun montant ne sort (voir `contractuel.service.ts`).
 *
 * LECTURE SEULE : aucune ecriture, donc aucun audit. Reponses `Cache-Control: no-store` (donnees financieres).
 *
 * @openapi
 * /api/v2/aide-decision/contractuel:
 *   get:
 *     summary: Suivi contractuel (copie gelee, DigitalRoad non integre)
 *     tags: [Aide a la decision]
 */
export const aideDecisionContractuelRouter = Router();

const REPONSE_INTROUVABLE = { error: "Marché introuvable", code: "MARCHE_INTROUVABLE" } as const;

aideDecisionContractuelRouter.use("/contractuel", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

function lireEntree(req: Request, res: Response, next: NextFunction): void {
  const l = lireRequete(req.query);
  if (!l.ok) { res.status(400).json({ error: "Paramètres invalides", code: "PARAMETRES_INVALIDES", details: l.erreurs }); return; }
  res.locals.requete = l.requete;
  next();
}

aideDecisionContractuelRouter.get(
  "/contractuel",
  requireAuth,
  requireModuleAccess("marches"),
  requireModuleAccess("decision"),
  lireEntree,
  // Un compte regional ne demande que sa region (403 HORS_PERIMETRE sinon). Sans `regionId`, le service restreint les
  // resultats au perimetre : il n'y a rien a refuser.
  requireTerritoire(async (req) => {
    const r = (req.res?.locals.requete as RequeteContractuel | undefined)?.filtres.regionId;
    return r === undefined ? [] : [r];
  }, { nature: "lecture" }),
  async (req, res, next) => {
    try {
      const requete = res.locals.requete as RequeteContractuel;
      res.json(await lireContractuel({ id: req.user!.id, role: req.user!.role }, requete));
    } catch (err) { next(err); }
  },
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

aideDecisionContractuelRouter.get(
  "/contractuel/marches/:id",
  requireAuth,
  requireModuleAccess("marches"),
  requireModuleAccess("decision"),
  async (req, res, next) => {
    try {
      // Identifiant mal forme, inexistant, supprime ou hors perimetre : UNE reponse, au meme corps (aucun oracle d'existence).
      const id = req.params.id;
      if (!UUID.test(id)) { res.status(404).json(REPONSE_INTROUVABLE); return; }
      const fiche = await lireMarche({ id: req.user!.id, role: req.user!.role }, id.toLowerCase());
      if (!fiche) { res.status(404).json(REPONSE_INTROUVABLE); return; }
      res.json(fiche);
    } catch (err) { next(err); }
  },
);
