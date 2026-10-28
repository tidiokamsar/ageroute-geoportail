import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { requireTerritoire, requireTerritoireMasque } from "../middleware/territoire.middleware";
import { perimetreDe } from "../territoire/territoire.service";
import { ServiceOccupe } from "../import/limiteur";
import { ErreurMetier } from "../projets-voirie/erreurs";
import { ErreurLecture, TAILLE_MAX_OCTETS } from "../projets-voirie/lecture.noyau";
import { analyser, exporterCsv } from "../projets-voirie/analyse.service";
import { carte } from "../projets-voirie/carte.service";
import { deposerJeu } from "../projets-voirie/import.service";
import {
  creerConcessionnaire, creerProjet, decider, decoderCurseur, ficheProjet, listerConcessionnaires, listerJeux, listerProjets,
  modifierProjet, regionsDuProjet, retirerJeu, retirerProjet, type Acteur, type Portee,
} from "../projets-voirie/projets.service";

/**
 * `/api/v2/projets-voirie` -- Projets de voirie et reseaux (contrat : docs/projets-voirie/CONTRAT.md, v2 ; reference :
 * docs/projets-voirie/API.md).
 *
 * ORDRE DES GARDES (le meme partout) : authentification -> module `projets-voirie` -> role (ecritures) -> RESSOURCE DESIGNEE
 * (404 identique si le projet n'existe pas ou est hors du perimetre territorial du compte) -> validation des entrees (400) -> service.
 *
 *   - lecture : toute personne qui a la cle de module ;
 *   - ecritures : ADMIN et GESTIONNAIRE (depot, autorisation, rejet, retrait, creation, modification) ; DELETE d'un projet : ADMIN ;
 *   - export CSV de l'analyse : ADMIN et GESTIONNAIRE, audite ; agregats seulement, AUCUNE geometrie ;
 *   - aucune route n'exporte les geometries d'un jeu (ni fichier GeoJSON, ni KML) ; la carte est une couche d'affichage bornee ;
 *   - un projet sans region n'est visible que des comptes nationaux ; un projet d'une region visible des seuls comptes de cette region.
 *
 * Donnees sensibles (traces d'infrastructure de tiers) : `Cache-Control: no-store`, `nosniff`, et JAMAIS dans l'API publique.
 */
export const projetsVoirieV2Router = Router();

projetsVoirieV2Router.use(requireAuth, requireModuleAccess("projets-voirie"));
projetsVoirieV2Router.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

const ecriture = requireRole("ADMIN", "GESTIONNAIRE");
const administrateur = requireRole("ADMIN");

const PROJET_INTROUVABLE = { error: "Projet introuvable", code: "PROJET_INTROUVABLE" } as const;
/** Un projet hors perimetre ou inexistant : la MEME reponse (404), pour ne rien reveler de son existence. */
const gardeProjet = requireTerritoireMasque(async (req) => regionsDuProjet(req.params.id.length > 64 ? "" : req.params.id), { corps: PROJET_INTROUVABLE });

// ------------------------------------------------------------------------------------------------
// Outils
// ------------------------------------------------------------------------------------------------

const acteurDe = (req: Request): Acteur => ({ id: req.user!.id, role: req.user!.role, ip: req.ip });

function refuser(res: Response, e: z.ZodError, code = "PARAMETRES_INVALIDES"): void {
  res.status(400).json({ error: "Paramètres invalides", code, details: e.flatten().fieldErrors });
}

const STATUT_LECTURE: Record<string, number> = { FICHIER_TROP_GROS: 413, FORMAT_NON_SUPPORTE: 415 };

/** Rend une erreur metier ou de lecture au format `{ error, code, ... }` ; toute autre erreur va au gestionnaire commun. */
function traiter(res: Response, next: NextFunction, e: unknown): void {
  if (e instanceof ErreurMetier) { res.status(e.status).json({ error: e.message, code: e.code, ...e.extra }); return; }
  if (e instanceof ErreurLecture) { res.status(STATUT_LECTURE[e.code] ?? 422).json({ error: e.message, code: e.code }); return; }
  if (e instanceof ServiceOccupe) { res.setHeader("Retry-After", String(e.retryAfterS)); res.status(503).json({ error: e.message, code: e.code }); return; }
  next(e);
}

type Gestionnaire = (req: Request, res: Response) => Promise<void>;
const enveloppe = (g: Gestionnaire) => (req: Request, res: Response, next: NextFunction): void => { g(req, res).catch((e) => traiter(res, next, e)); };

const vide = (v: unknown) => (v === "" ? undefined : v);
const optionnel = <T extends z.ZodTypeAny>(s: T) => z.preprocess(vide, s.optional());
const texte = (max: number) => z.string().trim().min(1).max(max);
const jourIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && d.getUTCFullYear() >= 1900 && d.getUTCFullYear() <= 2100;
}, "date AAAA-MM-JJ valide attendue");
const booleenRequete = z.preprocess(vide, z.enum(["true", "false"]).optional()).transform((v) => v === "true");
const largeur = z.coerce.number().positive().max(200);

const TYPES_RESEAU = ["TELECOM", "EAU_POTABLE", "ELECTRICITE", "ASSAINISSEMENT", "GAZ_HYDROCARBURES", "AUTRE"] as const;

// ------------------------------------------------------------------------------------------------
// Projets
// ------------------------------------------------------------------------------------------------

const requeteListe = z.object({
  q: optionnel(texte(100)),
  limite: z.preprocess(vide, z.coerce.number().int().min(1).max(100).default(25)),
  curseur: optionnel(z.string().max(300)),
}).strict();

/** Regions visibles du compte : `null` = pays entier. */
async function porteeDe(req: Request): Promise<Portee> {
  const p = await perimetreDe(req.user!);
  return p.national ? null : [...p.regions].sort((a, b) => a - b);
}

projetsVoirieV2Router.get("/", enveloppe(async (req, res) => {
  const p = requeteListe.safeParse(req.query);
  if (!p.success) return refuser(res, p.error);
  let curseur;
  if (p.data.curseur !== undefined) {
    curseur = decoderCurseur(p.data.curseur) ?? undefined;
    if (!curseur) { res.status(400).json({ error: "Curseur invalide : repartez de la première page", code: "CURSEUR_INVALIDE" }); return; }
  }
  res.json(await listerProjets(await porteeDe(req), { q: p.data.q, limite: p.data.limite, curseur }));
}));

const corpsProjet = z.object({
  code: z.string().trim().min(2).max(64).transform((s) => s.toUpperCase()).pipe(z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,63}$/, "lettres, chiffres, tirets et soulignés")),
  nom: texte(200),
  commune: z.string().trim().max(200).nullable().optional(),
  prefecture: z.string().trim().max(200).nullable().optional(),
  regionId: z.number().int().positive().nullable().optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  largeurEmpriseM: largeur.optional(),
  largeurChausseeM: largeur.optional(),
}).strict();

projetsVoirieV2Router.post(
  "/",
  ecriture,
  // Creation : un compte regional ne cree que dans sa region (403 sinon) ; une region inconnue lui est refusee.
  requireTerritoire(async (req) => [typeof req.body?.regionId === "number" ? req.body.regionId : null]),
  enveloppe(async (req, res) => {
    const p = corpsProjet.safeParse(req.body);
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.status(201).json({ projet: await creerProjet(acteurDe(req), p.data) });
  }),
);

// `/concessionnaires` AVANT `/:id`, sinon `:id` l'avalerait.
projetsVoirieV2Router.get("/concessionnaires", enveloppe(async (_req, res) => { res.json(await listerConcessionnaires()); }));

const corpsConcessionnaire = z.object({
  nom: texte(200),
  typeReseau: z.enum(TYPES_RESEAU),
  contact: z.string().trim().max(300).nullable().optional(),
}).strict();

projetsVoirieV2Router.post("/concessionnaires", ecriture, enveloppe(async (req, res) => {
  const p = corpsConcessionnaire.safeParse(req.body);
  if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
  res.status(201).json({ concessionnaire: await creerConcessionnaire(acteurDe(req), p.data) });
}));

projetsVoirieV2Router.get("/:id", gardeProjet, enveloppe(async (req, res) => { res.json({ projet: await ficheProjet(req.params.id) }); }));

const corpsModif = z.object({
  nom: texte(200).optional(),
  commune: z.string().trim().max(200).nullable().optional(),
  prefecture: z.string().trim().max(200).nullable().optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  largeurEmpriseM: largeur.optional(),
  largeurChausseeM: largeur.optional(),
  statutParametres: z.enum(["THEORIQUE", "VALIDE"]).optional(),
}).strict().refine((o) => Object.keys(o).length > 0, "au moins un champ à modifier");

projetsVoirieV2Router.patch("/:id", ecriture, gardeProjet, enveloppe(async (req, res) => {
  const p = corpsModif.safeParse(req.body);
  if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
  res.json({ projet: await modifierProjet(acteurDe(req), req.params.id, p.data) });
}));

projetsVoirieV2Router.delete("/:id", administrateur, gardeProjet, enveloppe(async (req, res) => { res.json(await retirerProjet(acteurDe(req), req.params.id)); }));

// ------------------------------------------------------------------------------------------------
// Jeux de donnees
// ------------------------------------------------------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  // multer 2.x decode le nom du fichier en latin1 par defaut ; les navigateurs l'envoient en UTF-8.
  defParamCharset: "utf8",
  limits: { fileSize: TAILLE_MAX_OCTETS, files: 1, fields: 20, fieldSize: 10_000, parts: 25 },
} as multer.Options & { defParamCharset: string });

function recevoir(req: Request, res: Response, next: NextFunction): void {
  upload.single("fichier")(req, res, (err: unknown) => {
    if (err) {
      const code = (err as { code?: string }).code;
      if (code === "LIMIT_FILE_SIZE") res.status(413).json({ error: `Fichier trop gros, maximum ${TAILLE_MAX_OCTETS} octets`, code: "FICHIER_TROP_GROS" });
      else res.status(400).json({ error: "Téléversement invalide", code: "TELEVERSEMENT_INVALIDE" });
      return;
    }
    next();
  });
}

const champsDepot = z.object({
  role: z.enum(["AXES_TRAVAUX", "RESEAU_TIERS", "LIMITES_ROUTE", "AUTRE"]),
  concessionnaireId: optionnel(z.string().trim().min(1).max(64)),
  typeReseau: optionnel(z.enum(TYPES_RESEAU)),
  dateDonnees: optionnel(jourIso),
  origineFichier: optionnel(z.string().trim().min(1).max(500)),
  confidentialite: optionnel(z.enum(["PUBLIC", "INTERNE", "RESTREINT_PROJET", "CONFIDENTIEL_CONCESSIONNAIRE", "INFRASTRUCTURE_SENSIBLE"])),
  natureObjets: optionnel(z.enum(["ACTIF_PHYSIQUE", "CIRCUIT_LOGIQUE", "EQUIPEMENT", "AXE", "EMPRISE", "INCONNUE"])),
  classePrecision: optionnel(z.enum(["A", "B", "C", "D", "E"])),
  precisionHorizontaleM: optionnel(z.coerce.number().positive().max(100_000)),
  precisionVerticaleM: optionnel(z.coerce.number().positive().max(100_000)),
  methode: optionnel(z.string().trim().min(1).max(200)),
  dateConstat: optionnel(jourIso),
}).strict();

const requeteDepot = z.object({ simuler: booleenRequete }).strict();

projetsVoirieV2Router.post("/:id/jeux", ecriture, gardeProjet, recevoir, enveloppe(async (req, res) => {
  const q = requeteDepot.safeParse(req.query);
  if (!q.success) return refuser(res, q.error);
  const c = champsDepot.safeParse(req.body);
  if (!c.success) return refuser(res, c.error, "CHAMPS_INVALIDES");
  if (!req.file) { res.status(400).json({ error: "Fichier manquant (champ multipart « fichier »)", code: "FICHIER_MANQUANT" }); return; }
  const r = await deposerJeu({
    acteur: acteurDe(req), projetId: req.params.id, fichier: req.file.buffer, nomFichier: req.file.originalname, champs: c.data, simuler: q.data.simuler,
  });
  res.status(r.simulation ? 200 : 201).json(r);
}));

projetsVoirieV2Router.get("/:id/jeux", gardeProjet, enveloppe(async (req, res) => { res.json(await listerJeux(req.params.id)); }));

const ID_MAX = 64;
const jeuIdValide = (req: Request, res: Response): boolean => {
  if (req.params.jeuId.length > ID_MAX) { res.status(404).json({ error: "Jeu de données introuvable", code: "JEU_INTROUVABLE" }); return false; }
  return true;
};

projetsVoirieV2Router.delete("/:id/jeux/:jeuId", ecriture, gardeProjet, enveloppe(async (req, res) => {
  if (!jeuIdValide(req, res)) return;
  res.json(await retirerJeu(acteurDe(req), req.params.id, req.params.jeuId));
}));

const corpsDecision = z.object({ justification: z.string().trim().min(10, "10 caractères au moins").max(2000) }).strict();

for (const [action, decision] of [["autoriser", "AUTORISE"], ["rejeter", "REJETE"]] as const) {
  projetsVoirieV2Router.post(`/:id/jeux/:jeuId/${action}`, ecriture, gardeProjet, enveloppe(async (req, res) => {
    if (!jeuIdValide(req, res)) return;
    const p = corpsDecision.safeParse(req.body);
    if (!p.success) return refuser(res, p.error, "JUSTIFICATION_INVALIDE");
    res.json(await decider(acteurDe(req), req.params.id, req.params.jeuId, decision, p.data.justification));
  }));
}

// ------------------------------------------------------------------------------------------------
// Carte et analyse
// ------------------------------------------------------------------------------------------------

const requeteCarte = z.object({
  jeux: optionnel(z.string().max(4000)),
  bbox: optionnel(z.string().max(200)),
  zoom: optionnel(z.coerce.number().int().min(0).max(22)),
  inclureNonAutorises: booleenRequete,
}).strict();

function lireBbox(s: string | undefined): [number, number, number, number] | null | "invalide" {
  if (s === undefined) return null;
  const v = s.split(",").map((x) => (x.trim() === "" ? NaN : Number(x)));
  if (v.length !== 4 || v.some((x) => !Number.isFinite(x))) return "invalide";
  const [w, so, e, n] = v;
  if (w < -180 || e > 180 || so < -90 || n > 90 || w >= e || so >= n) return "invalide";
  return [w, so, e, n];
}

projetsVoirieV2Router.get("/:id/carte", gardeProjet, enveloppe(async (req, res) => {
  const p = requeteCarte.safeParse(req.query);
  if (!p.success) return refuser(res, p.error);
  const bbox = lireBbox(p.data.bbox);
  if (bbox === "invalide") { res.status(400).json({ error: "bbox invalide : ouest,sud,est,nord en degrés, ouest < est et sud < nord", code: "PARAMETRES_INVALIDES" }); return; }
  let jeuxIds: string[] | undefined;
  if (p.data.jeux !== undefined) {
    jeuxIds = p.data.jeux.split(",").map((x) => x.trim()).filter(Boolean);
    if (jeuxIds.length === 0 || jeuxIds.length > 50 || jeuxIds.some((x) => x.length > ID_MAX)) {
      res.status(400).json({ error: "jeux invalide : 1 à 50 identifiants séparés par des virgules", code: "PARAMETRES_INVALIDES" });
      return;
    }
  }
  res.json(await carte({ projetId: req.params.id, jeuxIds, bbox: bbox ?? undefined, zoom: p.data.zoom, inclureNonAutorises: p.data.inclureNonAutorises }));
}));

const requeteAnalyse = z.object({
  largeurEmpriseM: optionnel(largeur),
  largeurChausseeM: optionnel(largeur),
  inclureNonAutorises: booleenRequete,
}).strict();

projetsVoirieV2Router.get("/:id/analyse", gardeProjet, enveloppe(async (req, res) => {
  const p = requeteAnalyse.safeParse(req.query);
  if (!p.success) return refuser(res, p.error);
  res.json(await analyser({ projetId: req.params.id, ...p.data }));
}));

projetsVoirieV2Router.get("/:id/analyse/export.csv", ecriture, gardeProjet, enveloppe(async (req, res) => {
  const p = requeteAnalyse.safeParse(req.query);
  if (!p.success) return refuser(res, p.error);
  const r = await exporterCsv(acteurDe(req), { projetId: req.params.id, ...p.data });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${r.nomFichier}"`);
  res.setHeader("X-Lignes-Exportees", String(r.nbLignes));
  res.send(r.csv);
}));
