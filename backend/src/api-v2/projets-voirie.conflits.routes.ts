import type { NextFunction, RequestHandler, Request, Response, Router } from "express";
import { z } from "zod";
import { lancerAnalyse } from "../projets-voirie/conflits/analyse-conflits.service";
import {
  ajouterPreuve, changerStatut, decoderCurseurConflit, exporterConflitsCsv, ficheConflit, listerConflits, modifierConflit, proposerDecision, trancherDecision,
  type FiltresConflits,
} from "../projets-voirie/conflits/dossiers.service";
import { approuverRegle, comparerAnalyses, creerRegle, decoderCurseurAnalyse, detailAnalyse, listerAnalyses, listerRegles } from "../projets-voirie/conflits/regles-analyses.service";
import { OPTIONS_DECISION, RISQUES_CONFLIT, STATUTS_CONFLIT, TYPES_CONFLIT, TYPES_PREUVE } from "../projets-voirie/conflits/types.noyau";
import type { Acteur } from "../projets-voirie/projets.service";

/**
 * `/api/v2/projets-voirie/:id/{regles,analyses,conflits}` -- DOSSIERS DE CONFLIT (lot RC-3). Contrat : docs/projets-voirie/CONTRAT-CONFLITS.md ;
 * reference des reponses : docs/projets-voirie/API.md, section « Dossiers de conflit ».
 *
 * Les routes sont montees sur le routeur du socle et en heritent TOUTES les gardes, dans le meme ordre : authentification -> cle de module
 * `projets-voirie` -> octet NUL (400) -> identifiants d'URL en UUID (400) -> role (ecritures) -> PROJET DESIGNE (404 identique si inexistant ou
 * hors perimetre territorial) -> validation des entrees (400) -> service.
 *
 *   - lecture : toute personne qui a la cle de module ; la geometrie d'un reseau de tiers n'est rendue (et sa consultation tracee) que
 *     selon les regles du socle (voir dossiers.service.ts) ;
 *   - ecritures : ADMIN et GESTIONNAIRE ; certaines transitions et l'approbation d'une regle sont reservees a l'ADMIN (le service le dit en 403) ;
 *   - export CSV : ADMIN et GESTIONNAIRE, audite, agregats seulement ;
 *   - AUCUNE route ni aucun champ ne cree d'ordre, de deplacement ni de decision automatique.
 */
export interface OutilsRoutes {
  ecriture: RequestHandler;
  administrateur: RequestHandler;
  gardeProjet: RequestHandler;
  acteurDe: (req: Request) => Acteur;
  enveloppe: (g: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => void;
  refuser: (res: Response, e: z.ZodError, code?: string) => void;
  UUID: RegExp;
}

const FAMILLES = ["TELECOM", "EAU_POTABLE", "ELECTRICITE", "ASSAINISSEMENT", "GAZ_HYDROCARBURES", "AUTRE"] as const;
const MONTANT_MAX = 9_999_999_999_999;

export function monterRoutesConflits(router: Router, o: OutilsRoutes): void {
  const { ecriture, administrateur, gardeProjet, acteurDe, enveloppe, refuser, UUID } = o;

  for (const [param, libelle] of [["cid", "conflit"], ["aid", "analyse"], ["did", "decision"], ["regleId", "regle"]] as const) {
    router.param(param, (_req, res, next, valeur: string) => {
      if (!UUID.test(valeur)) { res.status(400).json({ error: `Identifiant de ${libelle} invalide (UUID attendu)`, code: "IDENTIFIANT_INVALIDE" }); return; }
      next();
    });
  }

  const vide = (v: unknown) => (v === "" ? undefined : v);
  const uuid = z.string().regex(UUID, "UUID attendu");
  const jourIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
    const d = new Date(`${s}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && d.getUTCFullYear() >= 1900 && d.getUTCFullYear() <= 2100;
  }, "date AAAA-MM-JJ valide attendue");
  const triEtat = z.preprocess(vide, z.enum(["true", "false"]).optional()).transform((v) => (v === undefined ? undefined : v === "true"));
  const listeEnum = <T extends string>(valeurs: readonly [T, ...T[]]) => z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v),
    z.array(z.enum(valeurs)).min(1).max(20).optional(),
  );
  const opt = <T extends z.ZodTypeAny>(s: T) => z.preprocess(vide, s.optional());

  // ------------------------------------------------------------------------------------------------ Regles
  router.get("/:id/regles", gardeProjet, enveloppe(async (req, res) => { res.json(await listerRegles(req.params.id)); }));

  const corpsRegle = z.object({
    famille: z.enum(FAMILLES).nullable().optional(),
    code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/, "lettres, chiffres, point, tiret et souligne"),
    toleranceProximiteM: z.number().min(0).max(1000),
    margeIncertitude: z.number().min(0).max(100).default(1),
    justification: z.string().trim().max(2000).optional(),
  }).strict();
  router.post("/:id/regles", ecriture, gardeProjet, enveloppe(async (req, res) => {
    const p = corpsRegle.safeParse(req.body ?? {});
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.status(201).json(await creerRegle(acteurDe(req), req.params.id, { ...p.data, justification: p.data.justification ?? "" }));
  }));

  const corpsApprobation = z.object({ justification: z.string().trim().max(2000).optional(), derogation: z.string().trim().max(2000).optional() }).strict();
  router.post("/:id/regles/:regleId/approuver", administrateur, gardeProjet, enveloppe(async (req, res) => {
    const p = corpsApprobation.safeParse(req.body ?? {});
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.json(await approuverRegle(acteurDe(req), req.params.id, req.params.regleId, p.data));
  }));

  // ------------------------------------------------------------------------------------------------ Analyses
  router.post("/:id/analyses", ecriture, gardeProjet, enveloppe(async (req, res) => {
    const p = z.object({}).strict().safeParse(req.body ?? {});
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.status(201).json(await lancerAnalyse(acteurDe(req), req.params.id));
  }));

  const requeteAnalyses = z.object({ limite: z.preprocess(vide, z.coerce.number().int().min(1).max(100).default(25)), curseur: opt(z.string().max(300)) }).strict();
  router.get("/:id/analyses", gardeProjet, enveloppe(async (req, res) => {
    const p = requeteAnalyses.safeParse(req.query);
    if (!p.success) return refuser(res, p.error);
    let avant: number | undefined;
    if (p.data.curseur !== undefined) {
      avant = decoderCurseurAnalyse(p.data.curseur) ?? undefined;
      if (avant === undefined) { res.status(400).json({ error: "Curseur invalide : repartez de la première page", code: "CURSEUR_INVALIDE" }); return; }
    }
    res.json(await listerAnalyses(acteurDe(req), req.params.id, p.data.limite, avant));
  }));

  router.get("/:id/analyses/:aid", gardeProjet, enveloppe(async (req, res) => { res.json(await detailAnalyse(acteurDe(req), req.params.id, req.params.aid)); }));

  router.get("/:id/analyses/:aid/comparaison", gardeProjet, enveloppe(async (req, res) => {
    const p = z.object({ avec: uuid }).strict().safeParse(req.query);
    if (!p.success) { res.status(400).json({ error: "Paramètre « avec » : identifiant d'analyse (UUID) attendu", code: "IDENTIFIANT_INVALIDE", details: p.error.flatten().fieldErrors }); return; }
    res.json(await comparerAnalyses(acteurDe(req), req.params.id, req.params.aid, p.data.avec));
  }));

  // ------------------------------------------------------------------------------------------------ Conflits : liste et export
  const filtres = {
    statut: listeEnum(STATUTS_CONFLIT), type: listeEnum(TYPES_CONFLIT), axe: opt(z.string().trim().min(1).max(300)),
    concessionnaireId: opt(uuid), responsableId: opt(uuid), aReexaminer: triEtat, echeanceDepassee: triEtat, q: opt(z.string().trim().min(1).max(100)),
  };
  const requeteListe = z.object({ ...filtres, limite: z.preprocess(vide, z.coerce.number().int().min(1).max(200).default(50)), curseur: opt(z.string().max(300)) }).strict();
  const requeteExport = z.object(filtres).strict();
  const versFiltres = (d: z.infer<typeof requeteExport>): FiltresConflits => ({
    statuts: d.statut, types: d.type, axe: d.axe, concessionnaireId: d.concessionnaireId, responsableId: d.responsableId,
    aReexaminer: d.aReexaminer, echeanceDepassee: d.echeanceDepassee, q: d.q,
  });

  router.get("/:id/conflits", gardeProjet, enveloppe(async (req, res) => {
    const p = requeteListe.safeParse(req.query);
    if (!p.success) return refuser(res, p.error);
    let curseur;
    if (p.data.curseur !== undefined) {
      curseur = decoderCurseurConflit(p.data.curseur) ?? undefined;
      if (!curseur) { res.status(400).json({ error: "Curseur invalide : repartez de la première page", code: "CURSEUR_INVALIDE" }); return; }
    }
    res.json(await listerConflits(acteurDe(req), req.params.id, versFiltres(p.data), p.data.limite, curseur));
  }));

  // `export.csv` AVANT `:cid`, sinon `:cid` l'avalerait (et refuserait « export.csv » comme identifiant).
  router.get("/:id/conflits/export.csv", ecriture, gardeProjet, enveloppe(async (req, res) => {
    const p = requeteExport.safeParse(req.query);
    if (!p.success) return refuser(res, p.error);
    const r = await exporterConflitsCsv(acteurDe(req), req.params.id, versFiltres(p.data));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${r.nomFichier}"`);
    res.setHeader("X-Lignes-Exportees", String(r.nbLignes));
    res.send(r.csv);
  }));

  // ------------------------------------------------------------------------------------------------ Conflits : fiche et ecritures
  router.get("/:id/conflits/:cid", gardeProjet, enveloppe(async (req, res) => { res.json(await ficheConflit(acteurDe(req), req.params.id, req.params.cid)); }));

  const nul = <T extends z.ZodTypeAny>(s: T) => s.nullable().optional();
  const corpsPatch = z.object({
    responsableId: nul(uuid), echeance: nul(jourIso), risque: nul(z.enum(RISQUES_CONFLIT)),
    actionProposee: z.string().trim().max(2000).nullable().optional().transform((v) => (v === "" ? null : v)),
    aReexaminer: z.literal(false).optional(), justification: z.string().trim().max(2000).optional(),
  }).strict().refine((o) => Object.keys(o).some((k) => k !== "justification"), "au moins un champ à modifier");
  router.patch("/:id/conflits/:cid", ecriture, gardeProjet, enveloppe(async (req, res) => {
    const p = corpsPatch.safeParse(req.body);
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.json(await modifierConflit(acteurDe(req), req.params.id, req.params.cid, p.data));
  }));

  const corpsStatut = z.object({
    vers: z.enum(STATUTS_CONFLIT), justification: z.string().trim().max(2000).optional(), derogation: z.string().trim().max(2000).optional(),
    recolementAValider: z.boolean().optional(),
  }).strict();
  router.post("/:id/conflits/:cid/statut", ecriture, gardeProjet, enveloppe(async (req, res) => {
    const p = corpsStatut.safeParse(req.body);
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.json(await changerStatut(acteurDe(req), req.params.id, req.params.cid, p.data));
  }));

  const corpsPreuve = z.object({
    type: z.enum(TYPES_PREUVE), texte: z.string().trim().min(1).max(4000), reference: z.string().trim().max(500).nullable().optional(),
  }).strict();
  router.post("/:id/conflits/:cid/preuves", ecriture, gardeProjet, enveloppe(async (req, res) => {
    const p = corpsPreuve.safeParse(req.body);
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.status(201).json(await ajouterPreuve(acteurDe(req), req.params.id, req.params.cid, p.data));
  }));

  const montant = z.number().min(0).max(MONTANT_MAX).nullable().optional();
  const corpsDecision = z.object({
    option: z.enum(OPTIONS_DECISION), justification: z.string().trim().max(2000).optional(), contraintes: z.string().trim().max(4000).nullable().optional(),
    coutEstime: montant, coutReel: montant, deviseCout: z.string().regex(/^[A-Z]{3}$/, "code de devise sur trois lettres majuscules").nullable().optional(),
    dateDebutPrevue: nul(jourIso), dateFinPrevue: nul(jourIso),
  }).strict().refine((o) => !((o.coutEstime ?? null) !== null || (o.coutReel ?? null) !== null) || (o.deviseCout ?? null) !== null, { message: "deviseCout est requise quand un coût est donné", path: ["deviseCout"] });
  router.post("/:id/conflits/:cid/decisions", ecriture, gardeProjet, enveloppe(async (req, res) => {
    const p = corpsDecision.safeParse(req.body);
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.status(201).json(await proposerDecision(acteurDe(req), req.params.id, req.params.cid, { ...p.data, justification: p.data.justification ?? "" }));
  }));

  const corpsTranchage = z.object({ motif: z.string().trim().max(2000).optional(), derogation: z.string().trim().max(2000).optional() }).strict();
  for (const [action, verdict] of [["approuver", "APPROUVEE"], ["refuser", "REFUSEE"]] as const) {
    router.post(`/:id/conflits/:cid/decisions/:did/${action}`, ecriture, gardeProjet, enveloppe(async (req, res) => {
      const p = corpsTranchage.safeParse(req.body ?? {});
      if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
      res.json(await trancherDecision(acteurDe(req), req.params.id, req.params.cid, req.params.did, verdict, p.data));
    }));
  }
}
