import { Router, type Response } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { chargerSession, listerSessions, porteeDuCompte, sessionVisible } from "../roulage/consultation.service";
import { estIdentifiantSession, lireOptionsDetail, lireParametresListe } from "../roulage/consultation.noyau";

/**
 * `/api/v2/roulage` : la CONSULTATION des releves enregistres en roulage.
 *
 * Un releve arrive par `POST /v2/sync/push` (entityType `SessionRoulage`) ; ces routes sont les seules qui le
 * relisent. Elles ne modifient rien et n'ecrivent aucune ligne d'audit (comme les autres lectures de l'API) ; la
 * creation du releve est, elle, auditee a l'ecriture.
 *
 * ACCES : compte authentifie + module `inspections`, le meme que la collecte (`sync/push`, `devices`, `missions`).
 * Au-dela du module, la VISIBILITE depend du compte (`consultation.noyau.ts`, `porteeDe`) :
 *   - INSPECTEUR, LECTEUR : leurs propres releves ;
 *   - GESTIONNAIRE rattache a des regions : les siens, plus ceux dont un troncon traverse est dans ses regions ;
 *   - ADMIN et GESTIONNAIRE national : tous.
 *
 * UN SEUL 404 : releve inexistant, supprime logiquement, hors portee, ou identifiant mal forme, tous rendent le MEME
 * corps. L'identifiant est valide AVANT tout parametre : une requete hostile sur un releve qu'on ne peut pas voir
 * ne revele rien de plus qu'une requete correcte.
 */
export const roulageV2Router = Router();

const NON_TROUVE = { error: "Releve introuvable", code: "RELEVE_INTROUVABLE" } as const;

/** Des positions d'agents : jamais de copie en cache partage. */
const sansCache = (res: Response) => { res.setHeader("Cache-Control", "private, no-store"); };

/**
 * @openapi
 * /api/v2/roulage/sessions:
 *   get:
 *     summary: Liste les releves en roulage visibles par le compte (pagination par curseur)
 *     description: |
 *       Parametres : `limite` (1 a 100, defaut 25), `curseur` (opaque, rendu par la page precedente), `userId`,
 *       `depuis` et `jusqua` (dates ISO 8601 sur la date de debut du releve). Tri : debut decroissant, puis identifiant.
 *       Reponse : `{ items, suivant, total }`.
 *     tags: [Roulage v2]
 */
roulageV2Router.get("/sessions", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const parametres = lireParametresListe(req.query as Record<string, unknown>);
    if (!parametres.ok) return res.status(400).json({ error: parametres.message, code: parametres.code });
    const portee = await porteeDuCompte(req.user!);
    sansCache(res);
    return res.json(await listerSessions(portee, parametres.valeur));
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/roulage/sessions/{id}:
 *   get:
 *     summary: Detail d'un releve en roulage (geometrie, marqueurs, evenements et portions, analyse)
 *     description: |
 *       `?avecPoints=1` ajoute les points bruts de la trace (20 000 au plus, sinon `trace.tronque`). La geometrie est
 *       simplifiee au-dela de 5 000 sommets (`simplifiee: true`).
 *     tags: [Roulage v2]
 */
roulageV2Router.get("/sessions/:id", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const id = req.params.id;
    // 1. L'identifiant d'abord : mal forme = introuvable, avec le meme corps qu'un releve qu'on ne peut pas voir.
    if (!estIdentifiantSession(id)) return res.status(404).json(NON_TROUVE);
    // 2. La visibilite ensuite, AVANT de regarder les autres parametres.
    const portee = await porteeDuCompte(req.user!);
    if (!(await sessionVisible(id, portee))) return res.status(404).json(NON_TROUVE);
    // 3. Seulement alors, les options : un parametre invalide sur un releve visible est un 400.
    const options = lireOptionsDetail(req.query as Record<string, unknown>);
    if (!options.ok) return res.status(400).json({ error: options.message, code: options.code });
    const detail = await chargerSession(id, portee, options.valeur);
    // Supprime entre les deux lectures : meme reponse que s'il n'avait jamais ete visible.
    if (!detail) return res.status(404).json(NON_TROUVE);
    sansCache(res);
    return res.json(detail);
  } catch (err) {
    return next(err);
  }
});
