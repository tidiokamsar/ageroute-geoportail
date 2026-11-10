import type { NextFunction, RequestHandler, Request, Response, Router } from "express";
import { z } from "zod";
import { requireTerritoireMasque } from "../middleware/territoire.middleware";
import type { Acteur, Portee } from "../projets-voirie/projets.service";
import { voitTousLesJeux } from "../projets-voirie/projets.service";
import { ecrireConfiguration, lireCle, lireConfiguration } from "../projets-voirie/territoires/configuration.service";
import { NIVEAUX } from "../projets-voirie/territoires/hierarchie.noyau";
import { creerValeur, lireValeur, listerDomaines, listerValeurs, modifierValeur, retirerValeur } from "../projets-voirie/territoires/referentiels.service";
import { comptesParTerritoire, creerTerritoire, exigerCadenceComptes, ficheTerritoire, listerTerritoires, modifierTerritoire, regionsDuTerritoire, retirerTerritoire } from "../projets-voirie/territoires/territoires.service";

/**
 * `/api/v2/projets-voirie/{territoires,referentiels,configuration}` -- TERRITOIRES HIERARCHIQUES, REFERENTIELS CONFIGURABLES, CONFIGURATION
 * NATIONALE (lot T1). Contrat : docs/projets-voirie/CONTRAT-TERRITOIRES.md, section 7 ; reference : docs/projets-voirie/API.md.
 *
 * Montees sur le routeur du module, elles en heritent toutes les gardes, dans le meme ordre : authentification -> cle de module -> octet NUL
 * (400) -> identifiants d'URL en UUID (400) -> role (ecritures : ADMIN seul) -> ressource designee (territoire : 404 identique si inexistant,
 * retire ou hors du perimetre regional du compte) -> validation des entrees (400) -> service.
 *
 *   - lecture : toute personne qui a la cle de module ; la liste et les comptes des territoires sont filtres par perimetre dans le service ;
 *     les referentiels et la configuration sont nationaux (aucune donnee regionale) ;
 *   - ecritures : ADMIN seul, auditees, historisees ; aucune geometrie dans l'audit.
 * Les routes litterales (`/territoires`, `/referentiels`, `/configuration`) sont montees AVANT `/:id` par le routeur du socle.
 */
export interface OutilsRoutesTerritoires {
  administrateur: RequestHandler;
  acteurDe: (req: Request) => Acteur;
  porteeDe: (req: Request) => Promise<Portee>;
  enveloppe: (g: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => void;
  refuser: (res: Response, e: z.ZodError, code?: string) => void;
  UUID: RegExp;
}

const TERRITOIRE_INTROUVABLE = { error: "Territoire introuvable", code: "TERRITOIRE_INTROUVABLE" } as const;

export function monterRoutesTerritoires(router: Router, o: OutilsRoutesTerritoires): void {
  const { administrateur, acteurDe, porteeDe, enveloppe, refuser, UUID } = o;

  router.param("tid", (_req, res, next, valeur: string) => {
    if (!UUID.test(valeur)) { res.status(400).json({ error: "Identifiant de territoire invalide (UUID attendu)", code: "IDENTIFIANT_INVALIDE" }); return; }
    next();
  });
  /** Un territoire hors perimetre ou inexistant : la MEME reponse (404). */
  const gardeTerritoire = requireTerritoireMasque(async (req) => regionsDuTerritoire(req.params.tid), { corps: TERRITOIRE_INTROUVABLE });

  const vide = (v: unknown) => (v === "" ? undefined : v);
  const opt = <T extends z.ZodTypeAny>(s: T) => z.preprocess(vide, s.optional());
  const texte = (max: number) => z.string().trim().min(1).max(max);
  const booleen = z.preprocess(vide, z.enum(["true", "false"]).optional()).transform((v) => (v === undefined ? undefined : v === "true"));
  const codeRef = z.string().trim().min(2).max(64).transform((s) => s.toUpperCase()).pipe(z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,63}$/, "lettres majuscules, chiffres, tirets et soulignes"));
  const epsg = z.number().int().min(1024).max(32767);
  const entierPositif = z.number().int().positive();

  // ---------------------------------------------------------------------------------------------- Territoires

  const requeteListe = z.object({
    niveau: opt(z.enum(NIVEAUX)),
    parentId: opt(z.string().regex(UUID, "UUID attendu")),
    q: opt(texte(100)),
    actifs: booleen,
    limite: z.preprocess(vide, z.coerce.number().int().min(1).max(500).default(200)),
    curseur: opt(z.string().max(2000).regex(/^\/[0-9a-f/-]+$/i, "curseur invalide")),
  }).strict();

  router.get("/territoires", enveloppe(async (req, res) => {
    const p = requeteListe.safeParse(req.query);
    if (!p.success) return refuser(res, p.error);
    res.json(await listerTerritoires(await porteeDe(req), { niveau: p.data.niveau, parentId: p.data.parentId, q: p.data.q, actifs: p.data.actifs, limite: p.data.limite, curseur: p.data.curseur }));
  }));

  const requeteComptes = z.object({ territoireId: opt(z.string().regex(UUID, "UUID attendu")) }).strict();
  // `/territoires/comptes` AVANT `/territoires/:tid`.
  router.get("/territoires/comptes", enveloppe(async (req, res) => {
    const p = requeteComptes.safeParse(req.query);
    if (!p.success) return refuser(res, p.error);
    // Correctifs T1+S1 (m1) : cadence par compte (429 COMPTES_TROP_FREQUENTS, Retry-After), puis delai et limiteur dans le service.
    exigerCadenceComptes(req.user!.id);
    res.json(await comptesParTerritoire(await porteeDe(req), voitTousLesJeux(req.user!.role), p.data.territoireId));
  }));

  const emprise = z.object({ type: z.enum(["Polygon", "MultiPolygon"]), coordinates: z.array(z.unknown()).min(1) }).passthrough();
  const corpsTerritoire = z.object({
    code: codeRef,
    nom: texte(200),
    niveau: z.enum(NIVEAUX),
    parentId: z.string().regex(UUID, "UUID attendu").nullable().optional(),
    regionId: entierPositif.nullable().optional(),
    crsMetriqueEpsg: epsg.nullable().optional(),
    emprise: emprise.nullable().optional(),
    source: z.string().trim().max(500).nullable().optional(),
  }).strict();

  router.post("/territoires", administrateur, enveloppe(async (req, res) => {
    const p = corpsTerritoire.safeParse(req.body);
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.status(201).json(await creerTerritoire(acteurDe(req), p.data));
  }));

  router.get("/territoires/:tid", gardeTerritoire, enveloppe(async (req, res) => { res.json(await ficheTerritoire(req.params.tid)); }));

  const corpsModif = z.object({
    nom: texte(200).optional(),
    regionId: entierPositif.nullable().optional(),
    crsMetriqueEpsg: epsg.nullable().optional(),
    emprise: emprise.nullable().optional(),
    actif: z.boolean().optional(),
    source: z.string().trim().max(500).nullable().optional(),
  }).strict().refine((o2) => Object.keys(o2).length > 0, "au moins un champ à modifier");

  router.patch("/territoires/:tid", administrateur, gardeTerritoire, enveloppe(async (req, res) => {
    const p = corpsModif.safeParse(req.body);
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.json(await modifierTerritoire(acteurDe(req), req.params.tid, p.data));
  }));

  router.delete("/territoires/:tid", administrateur, gardeTerritoire, enveloppe(async (req, res) => { res.json(await retirerTerritoire(acteurDe(req), req.params.tid)); }));

  // ---------------------------------------------------------------------------------------------- Referentiels

  const domaine = z.string().regex(/^[A-Z_]{2,40}$/);
  const domaineValide = (req: Request, res: Response): boolean => {
    if (!domaine.safeParse(req.params.domaine).success) { res.status(404).json({ error: "Domaine de référentiel inconnu", code: "DOMAINE_INCONNU" }); return false; }
    return true;
  };
  const codeValide = (req: Request, res: Response): boolean => {
    if (!/^[A-Z0-9][A-Z0-9_-]{1,63}$/.test(req.params.code)) { res.status(404).json({ error: "Valeur de référentiel introuvable", code: "VALEUR_INTROUVABLE" }); return false; }
    return true;
  };

  router.get("/referentiels", enveloppe(async (_req, res) => { res.json(await listerDomaines()); }));

  const requeteValeurs = z.object({ tous: booleen }).strict();
  router.get("/referentiels/:domaine", enveloppe(async (req, res) => {
    if (!domaineValide(req, res)) return;
    const p = requeteValeurs.safeParse(req.query);
    if (!p.success) return refuser(res, p.error);
    res.json(await listerValeurs(req.params.domaine, p.data.tous === true));
  }));

  const corpsValeur = z.object({
    code: codeRef,
    libelle: texte(200),
    ordre: z.number().int().min(0).max(100_000).optional(),
    actif: z.boolean().optional(),
    parametres: z.record(z.unknown()).optional(),
  }).strict();

  router.post("/referentiels/:domaine", administrateur, enveloppe(async (req, res) => {
    if (!domaineValide(req, res)) return;
    const p = corpsValeur.safeParse(req.body);
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.status(201).json(await creerValeur(acteurDe(req), req.params.domaine, p.data));
  }));

  router.get("/referentiels/:domaine/:code", enveloppe(async (req, res) => {
    if (!domaineValide(req, res) || !codeValide(req, res)) return;
    res.json(await lireValeur(req.params.domaine, req.params.code));
  }));

  const corpsModifValeur = z.object({
    libelle: texte(200).optional(),
    ordre: z.number().int().min(0).max(100_000).optional(),
    actif: z.boolean().optional(),
    parametres: z.record(z.unknown()).optional(),
  }).strict().refine((o2) => Object.keys(o2).length > 0, "au moins un champ à modifier");

  router.patch("/referentiels/:domaine/:code", administrateur, enveloppe(async (req, res) => {
    if (!domaineValide(req, res) || !codeValide(req, res)) return;
    const p = corpsModifValeur.safeParse(req.body);
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.json(await modifierValeur(acteurDe(req), req.params.domaine, req.params.code, p.data));
  }));

  router.delete("/referentiels/:domaine/:code", administrateur, enveloppe(async (req, res) => {
    if (!domaineValide(req, res) || !codeValide(req, res)) return;
    res.json(await retirerValeur(acteurDe(req), req.params.domaine, req.params.code));
  }));

  // ---------------------------------------------------------------------------------------------- Configuration nationale

  const cleValide = (req: Request, res: Response): boolean => {
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(req.params.cle)) { res.status(404).json({ error: "Clé de configuration inconnue", code: "CLE_INCONNUE" }); return false; }
    return true;
  };

  router.get("/configuration", enveloppe(async (_req, res) => { res.json(await lireConfiguration()); }));
  router.get("/configuration/:cle", enveloppe(async (req, res) => {
    if (!cleValide(req, res)) return;
    res.json(await lireCle(req.params.cle));
  }));

  const corpsConfiguration = z.object({ valeur: z.record(z.unknown()), justification: z.string().trim().max(2000).optional() }).strict();
  router.put("/configuration/:cle", administrateur, enveloppe(async (req, res) => {
    if (!cleValide(req, res)) return;
    const p = corpsConfiguration.safeParse(req.body);
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.json(await ecrireConfiguration(acteurDe(req), req.params.cle, p.data.valeur, p.data.justification));
  }));
}
