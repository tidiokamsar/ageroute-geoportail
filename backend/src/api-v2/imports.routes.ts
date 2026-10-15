import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { prisma } from "../lib/prisma";
import {
  DemandeInvalide, FORMATS_ADMIS, TAILLE_MAX_OCTETS, erreursDuLot, recevoirLot,
} from "../import/import.service";

/**
 * `/api/v2/imports` -- reception de lots au format pivot.
 *
 * TROIS ROUTES, ET AUCUNE N'ECRIT DANS LE REFERENTIEL
 *
 *   POST /                 recoit un fichier, l'empreinte, le verifie, enregistre le lot et ses
 *                          lignes avec leur statut ; rend 201, ou 200 si le fichier etait deja
 *                          recu (idempotence : rien n'est ecrit)
 *   GET  /:id              le lot, ses compteurs, son rapport
 *   GET  /:id/erreurs.csv  les lignes rejetees et ignorees, exportables (T-04)
 *
 * L'application d'un lot -- creer des propositions dans le referentiel -- n'a pas de route,
 * parce qu'elle n'a pas de service : voir l'en-tete d'import.service.ts.
 *
 * POURQUOI UN ROLE ET NON UN MODULE
 *
 * Importer est un acte d'administration des donnees, pas un module metier qu'on delegue par
 * compte. ADMIN et GESTIONNAIRE seulement ; un LECTEUR recoit 403. Et l'importateur est TOUJOURS
 * l'utilisateur authentifie, jamais un champ du corps.
 *
 * LES 400 ET LES 201
 *
 * Un fichier illisible ou un CRS refuse ne sont PAS des 400 : la demande etait bien formee, le
 * lot est enregistre REJETE avec son motif, et c'est un 201. La source doit pouvoir voir
 * pourquoi son fichier a ete refuse, et le voir dans le journal. Les 400 sont reserves a la
 * demande elle-meme : format non admis, champ manquant, fichier vide ou trop gros.
 */
export const importsV2Router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: TAILLE_MAX_OCTETS, files: 1 } });

const champs = z.object({
  systemeSource: z.string().trim().min(1).max(64),
  format: z.enum(FORMATS_ADMIS),
  methodeSource: z.string().trim().min(1).max(120),
  versionMapping: z.string().trim().min(1).max(64),
  autorisationRef: z.string().trim().min(1).max(120),
  auteurSource: z.string().trim().max(200).optional(),
  dateSource: z.coerce.date().optional(),
});

importsV2Router.use(requireAuth, requireRole("ADMIN", "GESTIONNAIRE"));

importsV2Router.post(
  "/",
  (req: Request, res: Response, next: NextFunction) => {
    upload.single("fichier")(req, res, (err: unknown) => {
      if (err) {
        const e = err as { code?: string; message?: string };
        res.status(400).json({ error: e.code === "LIMIT_FILE_SIZE" ? `fichier trop gros, maximum ${TAILLE_MAX_OCTETS} octets` : "televersement invalide" });
        return;
      }
      next();
    });
  },
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parse = champs.safeParse(req.body);
      if (!parse.success) {
        res.status(400).json({ error: "champs invalides", details: parse.error.flatten().fieldErrors });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: "fichier manquant (champ multipart « fichier »)" });
        return;
      }
      const lot = await recevoirLot(prisma, {
        fichier: req.file.buffer,
        nomFichier: req.file.originalname,
        ...parse.data,
        importeParId: req.user!.id,
        ipAddress: req.ip,
      });
      res.status(lot.dejaRecu ? 200 : 201).json(lot);
    } catch (err) {
      if (err instanceof DemandeInvalide) {
        res.status(400).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  },
);

importsV2Router.get("/", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const lots = await prisma.lotImport.findMany({
      orderBy: { importeLe: "desc" }, take: 100,
      select: {
        id: true, reference: true, systemeSource: true, format: true, nomFichier: true, statut: true,
        importeLe: true, importeParId: true, lignesLues: true, lignesValidees: true, lignesImportees: true,
        lignesRejetees: true, lignesEnConflit: true, lignesIgnorees: true,
      },
    });
    res.json({ lots });
  } catch (err) { next(err); }
});

importsV2Router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const lot = await prisma.lotImport.findUnique({ where: { id: req.params.id } });
    if (!lot) { res.status(404).json({ error: "lot introuvable" }); return; }
    res.json({ ...lot, tailleOctets: lot.tailleOctets.toString() });
  } catch (err) { next(err); }
});

importsV2Router.get("/:id/erreurs.csv", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const lot = await prisma.lotImport.findUnique({ where: { id: req.params.id }, select: { id: true, reference: true } });
    if (!lot) { res.status(404).json({ error: "lot introuvable" }); return; }
    const csv = await erreursDuLot(prisma, lot.id);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${lot.reference}-erreurs.csv"`);
    res.send(csv);
  } catch (err) { next(err); }
});
