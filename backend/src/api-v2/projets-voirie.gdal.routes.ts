import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import { z } from "zod";
import { ErreurMetier } from "../projets-voirie/erreurs";
import { annulerJob, chargerConversion, creerJob, lireJob, listerJobs, LISTE_JOBS_MAX } from "../projets-voirie/gdal/jobs.service";
import type { ConversionValidee } from "../projets-voirie/gdal/conversion.noyau";
import { UNITES_DXF } from "../projets-voirie/gdal/contrat.noyau";
import { regionsDuProjet, type Acteur } from "../projets-voirie/projets.service";
import type { JobImportProjet } from "@prisma/client";

/**
 * `/api/v2/projets-voirie/:id/import/jobs...` -- JOBS DE CONVERSION GDAL (lot B2) : GeoPackage, Shapefile ZIP, DXF. Contrat : docs/projets-voirie/CONTRAT-IMPORT.md
 * section 13 ; reponses reelles : docs/projets-voirie/API.md.
 *
 * Montees sur le routeur du socle, elles en heritent TOUTES les gardes dans le meme ordre : authentification -> cle de module -> octet NUL (400) -> identifiants
 * d'URL en UUID (400) -> role ADMIN ou GESTIONNAIRE -> PROJET DESIGNE (404 masque hors perimetre ; 404 `PROJET_INTROUVABLE` a tous les comptes si le projet est
 * inexistant ou retire) -> place de reception (depot) -> validation (400) -> service.
 *
 *   - un job d'un AUTRE projet repond le meme 404 qu'un job inexistant (aucune fuite entre projets) ;
 *   - desactive (interrupteur PROJETS_VOIRIE_GDAL), le depot repond 415 FORMAT_GDAL_DESACTIVE et les autres routes 503 GDAL_DESACTIVE, sans toucher au spool ;
 *   - AUCUNE route n'exporte la geometrie d'un job : le resume ne porte que des comptes, des CRS, des calques ; l'apercu garde son echantillon borne ;
 *   - AUCUNE route ne cree d'ordre, de deplacement ni de decision automatique : un job converti n'ecrit rien dans le referentiel ni dans les jeux.
 */

export interface OutilsGdalRoutes {
  ecriture: RequestHandler;
  gardeProjet: RequestHandler;
  acteurDe: (req: Request) => Acteur;
  enveloppe: (g: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => void;
  refuser: (res: Response, e: z.ZodError, code?: string) => void;
  placeDeReception: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  recevoir: (req: Request, res: Response, next: NextFunction) => void;
}

const vide = (v: unknown) => (v === "" ? undefined : v);
const opt = <T extends z.ZodTypeAny>(s: T) => z.preprocess(vide, s.optional());

/** Champs multipart de la creation d'un job : le CRS source confirme et, pour un DXF, les unites declarees. Un champ inconnu est refuse (400). */
export const champsJob = z.object({
  epsgSource: opt(z.coerce.number().int().min(1000).max(999999)),
  unitesDxf: opt(z.enum(UNITES_DXF)),
}).strict();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const jobIdOption = opt(z.string().regex(UUID, "UUID attendu"));

const requeteListe = z.object({ limite: z.preprocess(vide, z.coerce.number().int().min(1).max(LISTE_JOBS_MAX).default(20)) }).strict();

/** Source d'un depot ou d'un apercu issue d'un job : le resultat VALIDE, relu et controle (voir `chargerConversion`). */
export interface SourceConvertie { conversion: ConversionValidee; job: JobImportProjet; nomFichier: string }

/** Charge la conversion d'un job pour les routes `inventaire`, `apercu` et `jeux` : `jobId` et `fichier` s'excluent (400). */
export async function sourceConvertie(projetId: string, jobId: string, couche: string | undefined, aUnFichier: boolean): Promise<SourceConvertie> {
  if (aUnFichier) throw new ErreurMetier(400, "CHAMPS_INVALIDES", "jobId et fichier s'excluent : envoyez le fichier a la creation du job, puis seulement jobId.");
  const { job, conversion } = await chargerConversion(projetId, jobId, { couche });
  return { conversion, job, nomFichier: job.nomFichier };
}

export function monterRoutesGdal(router: Router, o: OutilsGdalRoutes): void {
  const { ecriture, gardeProjet, acteurDe, enveloppe, refuser, placeDeReception, recevoir } = o;

  router.param("jobId", (_req, res, next, valeur: string) => {
    if (!UUID.test(valeur)) { res.status(400).json({ error: "Identifiant de job invalide (UUID attendu)", code: "IDENTIFIANT_INVALIDE" }); return; }
    next();
  });

  /** Un projet inexistant ou RETIRE repond 404 a TOUS les comptes, nationaux compris : ni job, ni liste d'un projet supprime. */
  const projetExiste: RequestHandler = (req, res, next) => {
    regionsDuProjet(req.params.id).then((r) => {
      if (r.length === 0) { res.status(404).json({ error: "Projet introuvable", code: "PROJET_INTROUVABLE" }); return; }
      next();
    }).catch(next);
  };

  router.post("/:id/import/jobs", ecriture, gardeProjet, projetExiste, placeDeReception, recevoir, enveloppe(async (req, res) => {
    const c = champsJob.safeParse(req.body ?? {});
    if (!c.success) return refuser(res, c.error, "CHAMPS_INVALIDES");
    if (!req.file) { res.status(400).json({ error: "Fichier manquant (champ multipart « fichier »)", code: "FICHIER_MANQUANT" }); return; }
    const job = await creerJob({
      acteur: acteurDe(req), projetId: req.params.id, fichier: req.file.buffer, nomFichier: req.file.originalname, epsgSource: c.data.epsgSource, unitesDxf: c.data.unitesDxf,
    });
    res.status(202).json({ job });
  }));

  router.get("/:id/import/jobs", ecriture, gardeProjet, projetExiste, enveloppe(async (req, res) => {
    const q = requeteListe.safeParse(req.query);
    if (!q.success) return refuser(res, q.error);
    res.json(await listerJobs(req.params.id, q.data.limite));
  }));

  router.get("/:id/import/jobs/:jobId", ecriture, gardeProjet, projetExiste, enveloppe(async (req, res) => {
    res.json({ job: await lireJob(req.params.id, req.params.jobId) });
  }));

  router.post("/:id/import/jobs/:jobId/annuler", ecriture, gardeProjet, projetExiste, enveloppe(async (req, res) => {
    res.json({ job: await annulerJob(acteurDe(req), req.params.id, req.params.jobId) });
  }));
}
