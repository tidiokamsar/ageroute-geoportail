import type { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import { requireTerritoireMasque } from "../middleware/territoire.middleware";
import type { Acteur, Portee } from "../projets-voirie/projets.service";
import { regionsDuTerritoire } from "../projets-voirie/territoires/territoires.service";
import { tableauNational, tableauTerritoire } from "../projets-voirie/tableaux/tableau.service";

/**
 * `/api/v2/projets-voirie/tableau-de-bord[/territoires/:tid]` -- TABLEAUX DE BORD NATIONAL ET PAR TERRITOIRE (lot X1). Contrat :
 * docs/projets-voirie/CONTRAT-EXPORTS.md, section 6.
 *
 * Routes LITTERALES, montees AVANT `/:id` par le routeur du socle (sinon `:id` les avalerait). Memes gardes que le socle, dans le meme ordre :
 * authentification -> cle de module -> compte referent confine au workflow (403) -> octet NUL (400) -> identifiant de territoire en UUID (400) ->
 * TERRITOIRE DESIGNE (404 identique si inexistant, retire ou hors perimetre) -> validation (aucun parametre admis, 400) -> service.
 *
 *   - lecture : toute personne qui a la cle de module ; AGREGATS SEULEMENT, filtres par le perimetre du compte et, pour un compte qui ne decide pas,
 *     calcules sur ce qu'il peut lire (aucun comptage de quarantaine, ni pieces en cours, ni referents) ;
 *   - aucune ecriture, aucune geometrie, aucun nom d'objet.
 */
export interface OutilsRoutesTableaux {
  acteurDe: (req: Request) => Acteur;
  porteeDe: (req: Request) => Promise<Portee>;
  enveloppe: (g: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => void;
  refuser: (res: Response, e: z.ZodError, code?: string) => void;
}

const TERRITOIRE_INTROUVABLE = { error: "Territoire introuvable", code: "TERRITOIRE_INTROUVABLE" } as const;

export function monterRoutesTableaux(router: Router, o: OutilsRoutesTableaux): void {
  const { acteurDe, porteeDe, enveloppe, refuser } = o;
  const gardeTerritoire = requireTerritoireMasque(async (req) => regionsDuTerritoire(req.params.tid), { corps: TERRITOIRE_INTROUVABLE });
  const aucunParametre = z.object({}).strict();

  router.get("/tableau-de-bord", enveloppe(async (req, res) => {
    const p = aucunParametre.safeParse(req.query);
    if (!p.success) return refuser(res, p.error);
    res.json(await tableauNational(acteurDe(req), await porteeDe(req)));
  }));

  router.get("/tableau-de-bord/territoires/:tid", gardeTerritoire, enveloppe(async (req, res) => {
    const p = aucunParametre.safeParse(req.query);
    if (!p.success) return refuser(res, p.error);
    res.json(await tableauTerritoire(acteurDe(req), await porteeDe(req), req.params.tid));
  }));
}
