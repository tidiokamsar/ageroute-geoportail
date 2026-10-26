import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { prisma } from "../lib/prisma";
import {
  DemandeInvalide, FORMATS_ADMIS, LIMITE_LIGNES, ServiceOccupe, TAILLE_MAX_OCTETS, exporterErreurs, recevoirLot,
} from "../import/import.service";
import { apercuDuLot, detailDuLot, listerLots, sourcesDeLots } from "../import/lots.lecture";
import { STATUTS_LIGNE_APERCU, STATUTS_LOT, decoderCurseur } from "../import/lots.vue.noyau";
import { APERCU_LIMITE_MAX, estImprimable, verifierAutorisationRef } from "../import/reception.noyau";

/**
 * `/api/v2/imports` -- reception de lots au format pivot.
 *
 * LES ROUTES (contrat : docs/imports/CONTRAT-API-LOTS-IMPORT.md) ; AUCUNE N'ECRIT DANS LE REFERENTIEL
 *
 *   POST /                 recoit un fichier, l'empreinte, le verifie, enregistre le lot et ses
 *                          lignes avec leur statut ; rend 201, ou 200 si le fichier etait deja
 *                          recu (idempotence : rien n'est ecrit)
 *   GET  /                 liste filtree (statut, source, q, du, au), paginee par curseur stable
 *   GET  /meta             formats, plafonds et statuts annonces : la source de verite de l'interface
 *   GET  /sources          sources deja recues (texte libre, jamais un referentiel)
 *   GET  /:id              le lot enrichi : empreinte, controle, etapes, actions permises, historique
 *   GET  /:id/apercu       un extrait borne et tronque des lignes du lot
 *   GET  /:id/erreurs.csv  les lignes rejetees et ignorees, exportables (T-04)
 *
 * `/meta` et `/sources` sont declarees AVANT `/:id`, sinon `:id` les avalerait.
 *
 * L'application d'un lot -- creer des propositions dans le referentiel -- n'a pas de route,
 * parce qu'elle n'a pas de service : voir l'en-tete d'import.service.ts. Un test parcourt la pile
 * de ce routeur et echoue si une route d'ecriture autre que POST / y apparait.
 *
 * POURQUOI UN ROLE ET NON UN MODULE
 *
 * Importer est un acte d'administration des donnees, pas un module metier qu'on delegue par
 * compte. ADMIN et GESTIONNAIRE seulement ; un LECTEUR recoit 403, en lecture comme en ecriture.
 * Et l'importateur est TOUJOURS l'utilisateur authentifie, jamais un champ du corps. Ces routes
 * n'ont ni perimetre territorial ni cle de module : DECISION DSI en attente, rien n'est change ici.
 *
 * LES 400 ET LES 201
 *
 * Un fichier illisible ou un CRS refuse ne sont PAS des 400 : la demande etait bien formee, le
 * lot est enregistre REJETE avec son motif, et c'est un 201. La source doit pouvoir voir
 * pourquoi son fichier a ete refuse, et le voir dans le journal. Les 400 sont reserves a la
 * demande elle-meme, avec un `code` stable : FICHIER_MANQUANT, CHAMPS_INVALIDES, FORMAT_NON_ADMIS,
 * FORMAT_INCOHERENT, ENCODAGE_NON_UTF8, FICHIER_VIDE, FICHIER_TROP_GROS, TROP_DE_LIGNES,
 * TELEVERSEMENT_INVALIDE. Un 503 SERVICE_OCCUPE (avec Retry-After) dit qu'AUCUN lot n'a ete cree.
 */
export const importsV2Router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  // `defParamCharset` : multer 2.x decode le nom du fichier en latin1 par defaut (`relevé` devenait
  // `relevÃ©`) ; les navigateurs l'envoient en UTF-8.
  defParamCharset: "utf8",
  limits: { fileSize: TAILLE_MAX_OCTETS, files: 1, fields: 20, fieldSize: 10_000, parts: 25 },
  // L'option existe dans multer 2.x (index.js) mais pas dans @types/multer.
} as multer.Options & { defParamCharset: string });

const texteImprimable = (max: number) =>
  z.string().trim().min(1).max(max).refine(estImprimable, "caracteres imprimables uniquement");
/** Un champ de formulaire laisse vide arrive comme une chaine vide : c'est « non fourni ». */
const videEstAbsent = (v: unknown) => (v === "" ? undefined : v);

const champs = z.object({
  systemeSource: texteImprimable(64),
  format: z.enum(FORMATS_ADMIS),
  methodeSource: texteImprimable(120),
  versionMapping: texteImprimable(64),
  autorisationRef: z.string().trim().max(120).superRefine((v, ctx) => {
    const motif = verifierAutorisationRef(v);
    if (motif) ctx.addIssue({ code: z.ZodIssueCode.custom, message: motif });
  }),
  auteurSource: z.preprocess(videEstAbsent, z.string().trim().max(200).refine(estImprimable, "caracteres imprimables uniquement").optional()),
  // Bornee : `-100000-01-01` et `+275760-09-13` sont des dates JavaScript valides que PostgreSQL refuse (500).
  dateSource: z.preprocess(videEstAbsent, z.coerce.date().min(new Date("1900-01-01T00:00:00Z")).max(new Date("2100-12-31T23:59:59Z")).optional()),
});

importsV2Router.use(requireAuth, requireRole("ADMIN", "GESTIONNAIRE"));

// Contenus d'un tiers, donnees de travail : jamais mis en cache, jamais reinterpretes par le navigateur.
importsV2Router.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

importsV2Router.post(
  "/",
  (req: Request, res: Response, next: NextFunction) => {
    upload.single("fichier")(req, res, (err: unknown) => {
      if (err) {
        const e = err as { code?: string };
        if (e.code === "LIMIT_FILE_SIZE") {
          res.status(400).json({ error: `fichier trop gros, maximum ${TAILLE_MAX_OCTETS} octets`, code: "FICHIER_TROP_GROS" });
        } else {
          res.status(400).json({ error: "televersement invalide", code: "TELEVERSEMENT_INVALIDE" });
        }
        return;
      }
      next();
    });
  },
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parse = champs.safeParse(req.body);
      if (!parse.success) {
        res.status(400).json({ error: "champs invalides", code: "CHAMPS_INVALIDES", details: parse.error.flatten().fieldErrors });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: "fichier manquant (champ multipart « fichier »)", code: "FICHIER_MANQUANT" });
        return;
      }
      const lot = await recevoirLot(prisma, {
        fichier: req.file.buffer,
        nomFichier: req.file.originalname,
        ...parse.data,
        // Toujours l'utilisateur authentifie : un `importeParId` du corps est ignore (zod le retire).
        importeParId: req.user!.id,
        ipAddress: req.ip,
      });
      res.status(lot.dejaRecu ? 200 : 201).json(lot);
    } catch (err) {
      if (err instanceof DemandeInvalide) {
        res.status(400).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof ServiceOccupe) {
        res.setHeader("Retry-After", String(err.retryAfterS));
        res.status(503).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  },
);

/* ===================================== Meta et sources ===================================== */

importsV2Router.get("/meta", (_req: Request, res: Response) => {
  res.json({
    formats: [
      {
        code: "csv", libelle: "CSV pivot",
        aide: "Séparateur point-virgule, première ligne = en-tête, encodage UTF-8. Colonnes obligatoires : systeme_source, type_objet, identifiant_source. Les autres colonnes sont conservées.",
      },
      {
        code: "geojson", libelle: "GeoJSON pivot",
        aide: "FeatureCollection en WGS 84 (SRID 4326), encodage UTF-8. Chaque entité porte ses propriétés ; les propriétés systeme_source, type_objet et identifiant_source sont obligatoires.",
      },
    ],
    // Valeur reellement appliquee par multer. La limite HTTP effective peut etre plus basse (25 Mo en
    // production tant que nginx n'est pas aligne) : voir docs/imports/RECEPTION-LOTS-IMPORT.md.
    tailleMaxOctets: TAILLE_MAX_OCTETS,
    limiteLignes: LIMITE_LIGNES,
    statuts: [...STATUTS_LOT],
  });
});

importsV2Router.get("/sources", async (_req: Request, res: Response, next: NextFunction) => {
  try { res.json(await sourcesDeLots(prisma)); } catch (err) { next(err); }
});

/* ========================================== Liste ========================================== */

/** Date ISO (jour seul, ou jour et heure). `jour: true` = jour entier. Sans fuseau : UTC. */
function lireDateFiltre(s: string): { date: Date; jour: boolean } | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(Z|[+-]\d{2}:\d{2})?)?$/.exec(s);
  if (!m) return null;
  const date = new Date(m[2] ? `${m[1]}T${m[2]}${m[3] ?? "Z"}` : `${m[1]}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  // `2026-02-30` devient le 2 mars en JavaScript : on exige que le jour lu soit le jour ecrit.
  if (!m[2] && date.toISOString().slice(0, 10) !== m[1]) return null;
  return { date, jour: !m[2] };
}

const dateFiltre = z.string().refine((s) => lireDateFiltre(s) !== null, "date ISO attendue (AAAA-MM-JJ ou AAAA-MM-JJThh:mm:ss)");
const optionnel = <T extends z.ZodTypeAny>(s: T) => z.preprocess(videEstAbsent, s.optional());

const requeteListe = z.object({
  statut: optionnel(z.enum(STATUTS_LOT)),
  source: optionnel(z.string().trim().min(1).max(64)),
  q: optionnel(z.string().trim().min(1).max(100)),
  du: optionnel(dateFiltre),
  au: optionnel(dateFiltre),
  limite: z.preprocess(videEstAbsent, z.coerce.number().int().min(1).max(100).default(25)),
  curseur: optionnel(z.string().max(200)),
}).strict();

function refuserParametres(res: Response, e: z.ZodError): void {
  res.status(400).json({ error: "parametres invalides", code: "PARAMETRES_INVALIDES", details: e.flatten().fieldErrors });
}

importsV2Router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const p = requeteListe.safeParse(req.query);
    if (!p.success) { refuserParametres(res, p.error); return; }
    const q = p.data;
    let curseur;
    if (q.curseur !== undefined) {
      curseur = decoderCurseur(q.curseur);
      if (!curseur) { res.status(400).json({ error: "curseur invalide : repartez de la premiere page", code: "CURSEUR_INVALIDE" }); return; }
    }
    const du = q.du ? lireDateFiltre(q.du)!.date : undefined;
    const au = q.au ? lireDateFiltre(q.au)! : undefined;
    // `au=2026-10-25` inclut TOUTE la journee du 25 : la borne exclusive est le lendemain.
    const auExclusif = au ? new Date(au.date.getTime() + (au.jour ? 86_400_000 : 1)) : undefined;
    res.json(await listerLots(prisma, { statut: q.statut, source: q.source, q: q.q, du, auExclusif, limite: q.limite, curseur }));
  } catch (err) { next(err); }
});

/* ========================================== Un lot ========================================== */

const ID_MAX = 64;

importsV2Router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id;
    const lot = id.length > ID_MAX ? null : await detailDuLot(prisma, id, req.user!.role);
    if (!lot) { res.status(404).json({ error: "lot introuvable" }); return; }
    res.json(lot);
  } catch (err) { next(err); }
});

const requeteApercu = z.object({
  limite: z.preprocess(videEstAbsent, z.coerce.number().int().min(1).max(APERCU_LIMITE_MAX).default(20)),
  statut: optionnel(z.enum(STATUTS_LIGNE_APERCU)),
  apres: optionnel(z.coerce.number().int().min(0).max(2_147_483_647)),
}).strict();

importsV2Router.get("/:id/apercu", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const p = requeteApercu.safeParse(req.query);
    if (!p.success) { refuserParametres(res, p.error); return; }
    const id = req.params.id;
    const apercu = id.length > ID_MAX ? null : await apercuDuLot(prisma, id, p.data);
    if (!apercu) { res.status(404).json({ error: "lot introuvable" }); return; }
    res.json(apercu);
  } catch (err) { next(err); }
});

importsV2Router.get("/:id/erreurs.csv", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id;
    const lot = id.length > ID_MAX ? null : await prisma.lotImport.findUnique({ where: { id }, select: { id: true, reference: true } });
    if (!lot) { res.status(404).json({ error: "lot introuvable" }); return; }
    const sortie = await exporterErreurs(prisma, lot.id);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${lot.reference}-erreurs.csv"`);
    res.setHeader("X-Lignes-En-Erreur", String(sortie.total));
    res.setHeader("X-Lignes-Exportees", String(sortie.exportees));
    res.send(sortie.csv);
  } catch (err) { next(err); }
});
