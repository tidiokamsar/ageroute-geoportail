import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import { z } from "zod";
import type { Acteur } from "../projets-voirie/projets.service";
import { exporterDossier, journalExports } from "../projets-voirie/exports/dossier.service";
import { creerDerogation, listerDerogations } from "../projets-voirie/exports/derogations.service";
import { DEROGATION_DUREE_MAX_H } from "../projets-voirie/exports/config";

/**
 * `/api/v2/projets-voirie/:id/export/...` -- EXPORT DU DOSSIER TECHNIQUE D'UN PROJET (lot X1). Contrat : docs/projets-voirie/CONTRAT-EXPORTS.md ; reference
 * des reponses : docs/projets-voirie/API.md, section « Export du dossier technique et tableaux de bord ».
 *
 * Montees sur le routeur du socle, elles en heritent TOUTES les gardes, dans le meme ordre : authentification -> cle de module `projets-voirie` -> compte
 * referent confine au workflow (403) -> octet NUL (400) -> identifiant de projet en UUID (400) -> ROLE -> PROJET DESIGNE (404 identique si inexistant ou
 * hors perimetre ; projet retire : 404 a tous, par le service) -> validation stricte (400) -> service.
 *
 *   - export et journal : ADMIN et GESTIONNAIRE (les comptes qui decident), audite AVANT la remise ;
 *   - derogation de confidentialite (creation, liste) : ADMIN seul ; nominative, justifiee, a usage unique ;
 *   - GeoJSON des seuls jeux AUTORISE d'un niveau exportable, ou couverts par une derogation citee ; jamais un jeu RETIRE, ni rien qui en vienne.
 */
export interface OutilsRoutesExports {
  ecriture: RequestHandler;
  administrateur: RequestHandler;
  gardeProjet: RequestHandler;
  acteurDe: (req: Request) => Acteur;
  enveloppe: (g: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => void;
  refuser: (res: Response, e: z.ZodError, code?: string) => void;
  UUID: RegExp;
}

export function monterRoutesExports(router: Router, o: OutilsRoutesExports): void {
  const { ecriture, administrateur, gardeProjet, acteurDe, enveloppe, refuser, UUID } = o;
  const vide = (v: unknown) => (v === "" ? undefined : v);
  const uuid = z.string().regex(UUID, "UUID attendu");

  const requeteExport = z.object({
    geojson: z.preprocess(vide, z.enum(["true", "false"]).default("true")).transform((v) => v === "true"),
    derogation: z.preprocess(vide, uuid.optional()),
  }).strict().refine((q) => q.derogation === undefined || q.geojson, { message: "une dérogation ne sert qu'à un export avec GeoJSON", path: ["derogation"] });

  router.get("/:id/export/dossier", ecriture, gardeProjet, enveloppe(async (req, res) => {
    const p = requeteExport.safeParse(req.query);
    if (!p.success) return refuser(res, p.error);
    const r = await exporterDossier(acteurDe(req), req.params.id, { geojson: p.data.geojson, derogationId: p.data.derogation });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${r.nomFichier}"`);
    res.setHeader("X-Export-Id", r.exportId);
    res.setHeader("X-Empreinte-Sha256", r.sha256);
    res.setHeader("X-Fichiers", String(r.nbFichiers));
    res.setHeader("X-Jeux-Geojson", String(r.nbJeuxGeojson));
    res.status(200).end(r.archive);
  }));

  const requeteJournal = z.object({ limite: z.preprocess(vide, z.coerce.number().int().min(1).max(100).default(50)) }).strict();
  router.get("/:id/export/journal", ecriture, gardeProjet, enveloppe(async (req, res) => {
    const p = requeteJournal.safeParse(req.query);
    if (!p.success) return refuser(res, p.error);
    res.json(await journalExports(req.params.id, p.data.limite));
  }));

  const corpsDerogation = z.object({
    jeuxIds: z.array(uuid).min(1).max(20),
    justification: z.string().trim().min(20, "20 caractères au moins").max(2000),
    beneficiaireId: uuid.optional(),
    dureeHeures: z.number().int().min(1).max(DEROGATION_DUREE_MAX_H).optional(),
  }).strict();
  router.post("/:id/export/derogations", administrateur, gardeProjet, enveloppe(async (req, res) => {
    const p = corpsDerogation.safeParse(req.body ?? {});
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.status(201).json(await creerDerogation(acteurDe(req), req.params.id, p.data));
  }));

  router.get("/:id/export/derogations", administrateur, gardeProjet, enveloppe(async (req, res) => {
    const p = z.object({}).strict().safeParse(req.query);
    if (!p.success) return refuser(res, p.error);
    res.json(await listerDerogations(req.params.id));
  }));
}
