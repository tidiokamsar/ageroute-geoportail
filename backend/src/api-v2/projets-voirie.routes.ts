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
import { reserverReception } from "../projets-voirie/limiteurs";
import { monterRoutesConflits } from "./projets-voirie.conflits.routes";
import { champsImport, monterRoutesImport, optionsDepuis } from "./projets-voirie.import.routes";
import { monterRoutesGdal, sourceConvertie } from "./projets-voirie.gdal.routes";
import { consommerDansTx, purgerApresDepot } from "../projets-voirie/gdal/jobs.service";
import { monterRoutesWorkflow } from "./projets-voirie.workflow.routes";
import { gardeReferent } from "../projets-voirie/workflow/garde";
import { monterRoutesReseaux } from "./projets-voirie.reseaux.routes";
import { monterRoutesSources } from "./projets-voirie.sources.routes";
import { METHODES_ACQUISITION } from "../projets-voirie/config";
import { deposerJeu } from "../projets-voirie/import.service";
import {
  creerConcessionnaire, creerProjet, decider, decoderCurseur, ficheProjet, listerConcessionnaires, listerJeux, listerProjets,
  modifierProjet, regionDuTerritoire, regionsDuProjet, retirerJeu, retirerProjet, voitTousLesJeux, type Acteur, type Portee,
} from "../projets-voirie/projets.service";
import { monterRoutesTerritoires } from "./projets-voirie.territoires.routes";

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
// Lot B3 : un compte rattache a un concessionnaire (referent) n'ouvre que les routes /workflow/... ; toute autre route du module lui repond 403 avant lecture.
projetsVoirieV2Router.use(gardeReferent);

// ENTREES : identifiants et caracteres (revue de securite, m3). Un identifiant de l'URL qui n'est pas un UUID, ou un texte qui contient
// un octet NUL (refuse par PostgreSQL : 500 sinon), est un 400 explicite avant tout acces a la base.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
projetsVoirieV2Router.param("id", (_req, res, next, valeur: string) => {
  if (!UUID.test(valeur)) { res.status(400).json({ error: "Identifiant de projet invalide (UUID attendu)", code: "IDENTIFIANT_INVALIDE" }); return; }
  next();
});
projetsVoirieV2Router.param("jeuId", (_req, res, next, valeur: string) => {
  if (!UUID.test(valeur)) { res.status(400).json({ error: "Identifiant de jeu invalide (UUID attendu)", code: "IDENTIFIANT_INVALIDE" }); return; }
  next();
});
function contientNul(v: unknown, profondeur = 0): boolean {
  if (typeof v === "string") return v.includes("\u0000");
  if (profondeur > 8 || !v || typeof v !== "object") return false;
  return Object.entries(v).some(([k, x]) => k.includes("\u0000") || contientNul(x, profondeur + 1));
}
const refuserNul = (req: Request, res: Response, next: NextFunction): void => {
  if (contientNul(req.query) || contientNul(req.body) || (req.file && req.file.originalname.includes("\u0000"))) {
    res.status(400).json({ error: "Caractere nul interdit dans les parametres", code: "PARAMETRES_INVALIDES" });
    return;
  }
  next();
};
projetsVoirieV2Router.use(refuserNul);
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
  if (e instanceof ErreurMetier) {
    // 429 : le delai a attendre (secondes) est aussi dans l'en-tete Retry-After.
    if (typeof e.extra.retryAfterS === "number") res.setHeader("Retry-After", String(e.extra.retryAfterS));
    res.status(e.status).json({ error: e.message, code: e.code, ...e.extra });
    return;
  }
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
  // Lot T1 : projets du territoire ET de ses descendants.
  territoireId: optionnel(z.string().regex(UUID, "UUID attendu")),
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
  res.json(await listerProjets(await porteeDe(req), { q: p.data.q, limite: p.data.limite, curseur, tousLesJeux: voitTousLesJeux(req.user!.role), territoireId: p.data.territoireId }));
}));

const codeReferentiel = z.string().trim().min(2).max(64).transform((s) => s.toUpperCase()).pipe(z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,63}$/, "lettres, chiffres, tirets et soulignés"));

const corpsProjet = z.object({
  code: codeReferentiel,
  nom: texte(200),
  commune: z.string().trim().max(200).nullable().optional(),
  prefecture: z.string().trim().max(200).nullable().optional(),
  regionId: z.number().int().positive().nullable().optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  largeurEmpriseM: largeur.optional(),
  largeurChausseeM: largeur.optional(),
  // Lot T1 : territoire obligatoire (CONTRAT-TERRITOIRES.md, section 7) et categorie facultative (referentiel CATEGORIE_PROJET).
  territoireId: z.string().regex(UUID, "UUID attendu"),
  categorieCode: codeReferentiel.nullable().optional(),
}).strict();

const UUID_SOUPLE = /^[0-9a-f-]{36}$/i;

projetsVoirieV2Router.post(
  "/",
  ecriture,
  // Creation : un compte regional ne cree que dans sa region (403 sinon) ; une region inconnue lui est refusee. Lot T1 : sans `regionId`,
  // la region touchee est la region effective du territoire (un territoire inconnu vaut region inconnue pour un compte regional).
  requireTerritoire(async (req) => {
    if (typeof req.body?.regionId === "number") return [req.body.regionId];
    const tid = typeof req.body?.territoireId === "string" && UUID_SOUPLE.test(req.body.territoireId) ? req.body.territoireId : undefined;
    return [await regionDuTerritoire(tid)];
  }),
  enveloppe(async (req, res) => {
    if (req.body && typeof req.body === "object" && !Array.isArray(req.body) && req.body.territoireId === undefined) {
      res.status(400).json({ error: "Le territoire du projet est obligatoire (territoireId)", code: "TERRITOIRE_REQUIS" });
      return;
    }
    const p = corpsProjet.safeParse(req.body);
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.status(201).json({ projet: await creerProjet(acteurDe(req), p.data) });
  }),
);

// Lot T1 : territoires, referentiels et configuration. Routes LITTERALES, montees AVANT `/:id` (sinon `:id` les avalerait).
monterRoutesTerritoires(projetsVoirieV2Router, { administrateur, acteurDe, porteeDe, enveloppe, refuser, UUID });

// `/concessionnaires` AVANT `/:id`, sinon `:id` l'avalerait.
projetsVoirieV2Router.get("/concessionnaires", enveloppe(async (_req, res) => { res.json(await listerConcessionnaires()); }));

const corpsConcessionnaire = z.object({
  nom: texte(200),
  // Lot T1 : la famille (enumeration) OU le code du referentiel TYPE_RESEAU (la famille en est derivee) ; au moins l'un des deux.
  typeReseau: z.enum(TYPES_RESEAU).optional(),
  typeReseauCode: codeReferentiel.optional(),
  contact: z.string().trim().max(300).nullable().optional(),
}).strict().refine((c) => c.typeReseau !== undefined || c.typeReseauCode !== undefined, { message: "typeReseau ou typeReseauCode requis", path: ["typeReseau"] });

projetsVoirieV2Router.post("/concessionnaires", ecriture, enveloppe(async (req, res) => {
  const p = corpsConcessionnaire.safeParse(req.body);
  if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
  res.status(201).json({ concessionnaire: await creerConcessionnaire(acteurDe(req), p.data) });
}));

projetsVoirieV2Router.get("/:id", gardeProjet, enveloppe(async (req, res) => { res.json({ projet: await ficheProjet(req.params.id, voitTousLesJeux(req.user!.role)) }); }));

const corpsModif = z.object({
  nom: texte(200).optional(),
  commune: z.string().trim().max(200).nullable().optional(),
  prefecture: z.string().trim().max(200).nullable().optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  largeurEmpriseM: largeur.optional(),
  largeurChausseeM: largeur.optional(),
  statutParametres: z.enum(["THEORIQUE", "VALIDE"]).optional(),
  territoireId: z.string().regex(UUID, "UUID attendu").optional(),
  categorieCode: codeReferentiel.nullable().optional(),
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
  // Revue de la vague 1, m1 : le depot admet jusqu'a 26 champs texte (champsDepot + champsImport) ; 40 champs et 45 parties (fichier compris) laissent une marge.
  limits: { fileSize: TAILLE_MAX_OCTETS, files: 1, fields: 40, fieldSize: 10_000, parts: 45 },
} as multer.Options & { defParamCharset: string });

/**
 * Place de reception AVANT la lecture du corps (revue de securite, m4) : un fichier de 25 Mo est tenu en memoire pendant tout le
 * televersement ; 4 receptions simultanees au plus, 2 par compte (503 SERVICE_OCCUPE au-dela).
 */
async function placeDeReception(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const liberer = await reserverReception(req.user!.id);
    res.once("finish", liberer);
    res.once("close", liberer);
    next();
  } catch (e) { traiter(res, next, e); }
}

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
  concessionnaireId: optionnel(z.string().regex(UUID, "UUID attendu")),
  typeReseau: optionnel(z.enum(TYPES_RESEAU)),
  typeReseauCode: optionnel(codeReferentiel),
  dateDonnees: optionnel(jourIso),
  origineFichier: optionnel(z.string().trim().min(1).max(500)),
  confidentialite: optionnel(z.enum(["PUBLIC", "INTERNE", "RESTREINT_PROJET", "CONFIDENTIEL_CONCESSIONNAIRE", "INFRASTRUCTURE_SENSIBLE"])),
  natureObjets: optionnel(z.enum(["ACTIF_PHYSIQUE", "CIRCUIT_LOGIQUE", "EQUIPEMENT", "AXE", "EMPRISE", "INCONNUE"])),
  classePrecision: optionnel(z.enum(["A", "B", "C", "D", "E"])),
  precisionHorizontaleM: optionnel(z.coerce.number().positive().max(100_000)),
  precisionVerticaleM: optionnel(z.coerce.number().positive().max(100_000)),
  methode: optionnel(z.string().trim().min(1).max(200)),
  dateConstat: optionnel(jourIso),
  // Lot S1 : methode d'acquisition, code de la liste du serveur (deux methodes = deux sources d'un reseau de concessionnaire).
  methodeAcquisition: optionnel(z.enum(METHODES_ACQUISITION)),
}).merge(champsImport).strict();

const requeteDepot = z.object({ simuler: booleenRequete }).strict();

projetsVoirieV2Router.post("/:id/jeux", ecriture, gardeProjet, placeDeReception, recevoir, refuserNul, enveloppe(async (req, res) => {
  const q = requeteDepot.safeParse(req.query);
  if (!q.success) return refuser(res, q.error);
  const c = champsDepot.safeParse(req.body);
  if (!c.success) return refuser(res, c.error, "CHAMPS_INVALIDES");
  // Lot B2 : `jobId` = resultat valide d'une conversion GDAL (GeoPackage, Shapefile ZIP, DXF) a la place du fichier ; MEME depot ensuite (quarantaine, CRS, delta).
  const src = c.data.jobId !== undefined ? await sourceConvertie(req.params.id, c.data.jobId, c.data.couche, req.file !== undefined) : null;
  if (!src && !req.file) { res.status(400).json({ error: "Fichier manquant (champ multipart « fichier »)", code: "FICHIER_MANQUANT" }); return; }
  const acteur = acteurDe(req);
  const r = await deposerJeu({
    acteur, projetId: req.params.id, fichier: src ? Buffer.alloc(0) : req.file!.buffer, nomFichier: src ? src.nomFichier : req.file!.originalname, champs: c.data, simuler: q.data.simuler,
    // Lot A1 : couche, CRS, colonnes CSV, mapping, confirmation, empreinte attendue (CONTRAT-IMPORT.md).
    options: optionsDepuis(c.data), sha256Attendu: c.data.sha256Attendu,
    ...(src ? { conversion: src.conversion, apresDepot: (tx, jeuId) => consommerDansTx(tx, src.job.id, jeuId, acteur) } : {}),
  });
  if (src && !r.simulation) await purgerApresDepot(src.job.id);
  res.status(r.simulation ? 200 : 201).json(r);
}));

projetsVoirieV2Router.get("/:id/jeux", gardeProjet, enveloppe(async (req, res) => { res.json(await listerJeux(req.params.id, voitTousLesJeux(req.user!.role))); }));

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

/** La quarantaine (jeux non autorises) n'est visible que des roles qui peuvent decider (revue de securite, m1). */
function quarantaineAutorisee(req: Request, res: Response, demandee: boolean): boolean {
  if (demandee && !voitTousLesJeux(req.user!.role)) {
    res.status(403).json({ error: "inclureNonAutorises est reserve aux comptes ADMIN et GESTIONNAIRE : la quarantaine n'est pas lisible par un lecteur", code: "QUARANTAINE_RESERVEE" });
    return false;
  }
  return true;
}

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
    if (jeuxIds.length === 0 || jeuxIds.length > 50 || jeuxIds.some((x) => !UUID.test(x))) {
      res.status(400).json({ error: "jeux invalide : 1 à 50 identifiants séparés par des virgules", code: "PARAMETRES_INVALIDES" });
      return;
    }
  }
  if (!quarantaineAutorisee(req, res, p.data.inclureNonAutorises)) return;
  res.json(await carte({ projetId: req.params.id, jeuxIds, bbox: bbox ?? undefined, zoom: p.data.zoom, inclureNonAutorises: p.data.inclureNonAutorises, acteur: acteurDe(req) }));
}));

const requeteAnalyse = z.object({
  largeurEmpriseM: optionnel(largeur),
  largeurChausseeM: optionnel(largeur),
  inclureNonAutorises: booleenRequete,
}).strict();

projetsVoirieV2Router.get("/:id/analyse", gardeProjet, enveloppe(async (req, res) => {
  const p = requeteAnalyse.safeParse(req.query);
  if (!p.success) return refuser(res, p.error);
  if (!quarantaineAutorisee(req, res, p.data.inclureNonAutorises)) return;
  res.json(await analyser({ projetId: req.params.id, ...p.data }, acteurDe(req)));
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

// ------------------------------------------------------------------------------------------------
// Dossiers de conflit (lot RC-3) : regles, analyses persistees, conflits. Memes gardes, meme ordre (voir projets-voirie.conflits.routes.ts).
// ------------------------------------------------------------------------------------------------

monterRoutesConflits(projetsVoirieV2Router, { ecriture, administrateur, gardeProjet, acteurDe, enveloppe, refuser, UUID });

// ------------------------------------------------------------------------------------------------
// Formats d'import ouverts, CRS, mapping, delta et retour arriere (lot A1) : memes gardes, meme ordre (voir projets-voirie.import.routes.ts).
// ------------------------------------------------------------------------------------------------

monterRoutesImport(projetsVoirieV2Router, { ecriture, gardeProjet, acteurDe, enveloppe, refuser, placeDeReception, recevoir });
// Jobs de conversion GDAL (lot B2) : memes gardes, meme ordre (voir projets-voirie.gdal.routes.ts). Interrupteur PROJETS_VOIRIE_GDAL, desactive par defaut.
monterRoutesGdal(projetsVoirieV2Router, { ecriture, gardeProjet, acteurDe, enveloppe, refuser, placeDeReception, recevoir });
// Workflow concessionnaire, referents, taches, preuves et recolement (lot B3). Memes gardes, meme ordre (voir projets-voirie.workflow.routes.ts).
// ------------------------------------------------------------------------------------------------

monterRoutesWorkflow(projetsVoirieV2Router, { gardeProjet, acteurDe, enveloppe, refuser, UUID });
// Reseaux physiques et circuits logiques (lot B1) : descripteurs d objets, relations, propositions d associations, comptage par nature.
// Memes gardes, meme ordre (voir projets-voirie.reseaux.routes.ts).
// ------------------------------------------------------------------------------------------------

monterRoutesReseaux(projetsVoirieV2Router, { ecriture, gardeProjet, acteurDe, enveloppe, refuser, UUID });
// Sources multiples, regles de rapprochement et comparaison entre sources (lot S1) : memes gardes, meme ordre (voir projets-voirie.sources.routes.ts).
// ------------------------------------------------------------------------------------------------

monterRoutesSources(projetsVoirieV2Router, { ecriture, administrateur, gardeProjet, acteurDe, enveloppe, refuser, UUID });
