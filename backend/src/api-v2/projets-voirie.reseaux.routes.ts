import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import { z } from "zod";
import { proposerAssociations } from "../projets-voirie/reseaux/associations.service";
import { comptageProjet } from "../projets-voirie/reseaux/comptage.service";
import { declarerDescripteur, ficheObjetReseau, listerObjetsReseau } from "../projets-voirie/reseaux/descripteurs.service";
import { decoderCurseurRelation, declarerRelation, listerRelationsProjet, transitionRelation } from "../projets-voirie/reseaux/relations.service";
import {
  ID_OBJET, NATURES_DECLARABLES, NIVEAUX_CONFIANCE, ORIGINES_RELATION, STATUTS_QUALITE, STATUTS_RELATION, TYPES_RELATION,
} from "../projets-voirie/reseaux/types.noyau";
import { voitTousLesJeux, type Acteur } from "../projets-voirie/projets.service";

/**
 * `/api/v2/projets-voirie/:id/reseau/...` -- RESEAUX PHYSIQUES ET CIRCUITS LOGIQUES (lot B1). Contrat : docs/projets-voirie/CONTRAT-RESEAUX.md ;
 * reference des reponses : docs/projets-voirie/API.md, section « Reseaux physiques et circuits logiques (lot B1) ».
 *
 * Les routes sont montees sur le routeur du socle et en heritent TOUTES les gardes, dans le meme ordre : authentification -> cle de module
 * `projets-voirie` -> octet NUL (400) -> identifiants d'URL (400) -> role (ecritures) -> PROJET DESIGNE (404 identique si inexistant ou hors
 * perimetre territorial) -> validation stricte des entrees (400) -> service.
 *
 *   - lecture : toute personne qui a la cle de module, limitee aux jeux qu'elle peut lire (un lecteur : AUTORISE ; jamais RETIRE) ;
 *   - ecritures (descripteur, relation, proposition, validation, refus, revocation) : ADMIN et GESTIONNAIRE, auditees ;
 *   - AUCUNE geometrie n'est rendue ni exportee ; AUCUNE route ne cree d'ordre, de deplacement ni de decision automatique ;
 *   - une association automatique n'est jamais qu'une PROPOSITION : seule une personne la valide.
 */
export interface OutilsRoutesReseaux {
  ecriture: RequestHandler;
  gardeProjet: RequestHandler;
  acteurDe: (req: Request) => Acteur;
  enveloppe: (g: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => void;
  refuser: (res: Response, e: z.ZodError, code?: string) => void;
  UUID: RegExp;
}

const vide = (v: unknown) => (v === "" ? undefined : v);
const opt = <T extends z.ZodTypeAny>(s: T) => z.preprocess(vide, s.optional());
const nul = <T extends z.ZodTypeAny>(s: T) => s.nullable().optional().transform((v) => v ?? null);
const CODE_TYPE = /^[A-Z][A-Z0-9_]{1,39}$/;
const r2 = (x: number) => Math.round(x * 100) / 100;

export function monterRoutesReseaux(router: Router, o: OutilsRoutesReseaux): void {
  const { ecriture, gardeProjet, acteurDe, enveloppe, refuser, UUID } = o;
  const uuid = z.string().regex(UUID, "UUID attendu");
  const idObjet = z.string().regex(ID_OBJET, "identifiant d'objet attendu (entier positif)");
  const jourIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
    const d = new Date(`${s}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && d.getUTCFullYear() >= 1900 && d.getUTCFullYear() <= 2100;
  }, "date AAAA-MM-JJ valide attendue");
  const triEtat = z.preprocess(vide, z.enum(["true", "false"]).optional()).transform((v) => v === "true");
  const listeEnum = <T extends string>(valeurs: readonly [T, ...T[]]) => z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v),
    z.array(z.enum(valeurs)).min(1).max(10).optional(),
  );

  router.param("objetId", (_req, res, next, valeur: string) => {
    if (!ID_OBJET.test(valeur)) { res.status(400).json({ error: "Identifiant d'objet invalide (entier positif attendu)", code: "IDENTIFIANT_INVALIDE" }); return; }
    next();
  });
  router.param("relId", (_req, res, next, valeur: string) => {
    if (!UUID.test(valeur)) { res.status(400).json({ error: "Identifiant de relation invalide (UUID attendu)", code: "IDENTIFIANT_INVALIDE" }); return; }
    next();
  });

  // ------------------------------------------------------------------------------------------------ Objets et descripteurs
  const requeteObjets = z.object({
    jeuId: opt(uuid),
    nature: opt(z.enum([...NATURES_DECLARABLES, "INCONNUE"])),
    typeObjet: opt(z.string().regex(CODE_TYPE, "code de type en majuscules")),
    q: opt(z.string().trim().min(1).max(100)),
    limite: z.preprocess(vide, z.coerce.number().int().min(1).max(200).default(50)),
    curseur: opt(z.string().max(100)),
  }).strict();

  router.get("/:id/reseau/objets", gardeProjet, enveloppe(async (req, res) => {
    const p = requeteObjets.safeParse(req.query);
    if (!p.success) return refuser(res, p.error);
    res.json(await listerObjetsReseau(acteurDe(req), req.params.id, p.data));
  }));

  router.get("/:id/reseau/objets/:objetId", gardeProjet, enveloppe(async (req, res) => {
    res.json(await ficheObjetReseau(acteurDe(req), req.params.id, req.params.objetId));
  }));

  /** Precision : au centimetre (la colonne) puis strictement positive, jamais nulle apres arrondi. */
  const precision = z.number().positive().max(100_000).transform(r2).refine((v) => v > 0, "au moins 0,01 m");
  const corpsDescripteur = z.object({
    nature: nul(z.enum(NATURES_DECLARABLES)),
    typeObjet: nul(z.string().trim().regex(CODE_TYPE, "code de type en majuscules (lettres, chiffres, soulignes)")),
    classePrecision: nul(z.enum(["A", "B", "C", "D", "E"])),
    precisionHorizontaleM: nul(precision),
    precisionVerticaleM: nul(precision),
    methodeCollecte: nul(z.string().trim().min(1).max(200)),
    dateConstat: nul(jourIso),
    niveauConfiance: nul(z.enum(NIVEAUX_CONFIANCE)),
    statutQualite: z.enum(STATUTS_QUALITE).default("INCONNU"),
    profondeurM: nul(z.number().min(0).max(10_000)),
    altitudeM: nul(z.number().min(-500).max(9_000)),
    referenceVerticale: nul(z.string().trim().min(1).max(120)),
    justification: z.string().trim().min(10, "10 caractères au moins").max(2000),
  }).strict();

  // PUT : le descripteur est REMPLACE. Une valeur omise est INCONNUE (nulle), jamais heritee ni deduite. Pas de DELETE : on corrige.
  router.put("/:id/reseau/objets/:objetId/descripteur", ecriture, gardeProjet, enveloppe(async (req, res) => {
    const p = corpsDescripteur.safeParse(req.body);
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    const r = await declarerDescripteur(acteurDe(req), req.params.id, req.params.objetId, p.data);
    res.status(r.cree ? 201 : 200).json({ objet: r.objet });
  }));

  // ------------------------------------------------------------------------------------------------ Relations
  const requeteRelations = z.object({
    statut: listeEnum(STATUTS_RELATION),
    type: opt(z.enum(TYPES_RELATION)),
    objetId: opt(idObjet),
    origine: opt(z.enum(ORIGINES_RELATION)),
    limite: z.preprocess(vide, z.coerce.number().int().min(1).max(200).default(50)),
    curseur: opt(z.string().max(300)),
  }).strict();

  router.get("/:id/reseau/relations", gardeProjet, enveloppe(async (req, res) => {
    const p = requeteRelations.safeParse(req.query);
    if (!p.success) return refuser(res, p.error);
    let curseur;
    if (p.data.curseur !== undefined) {
      curseur = decoderCurseurRelation(p.data.curseur) ?? undefined;
      if (!curseur) { res.status(400).json({ error: "Curseur invalide : repartez de la première page", code: "CURSEUR_INVALIDE" }); return; }
    }
    res.json(await listerRelationsProjet(acteurDe(req), req.params.id, { statuts: p.data.statut, type: p.data.type, objetId: p.data.objetId, origine: p.data.origine, curseur, limite: p.data.limite }));
  }));

  const corpsRelation = z.object({
    type: z.enum(TYPES_RELATION), sourceObjetId: idObjet, cibleObjetId: idObjet, justification: z.string().trim().min(10, "10 caractères au moins").max(2000),
  }).strict();
  router.post("/:id/reseau/relations", ecriture, gardeProjet, enveloppe(async (req, res) => {
    const p = corpsRelation.safeParse(req.body);
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.status(201).json(await declarerRelation(acteurDe(req), req.params.id, p.data));
  }));

  const corpsJustification = z.object({ justification: z.string().trim().min(10, "10 caractères au moins").max(2000) }).strict();
  for (const action of ["valider", "refuser", "revoquer"] as const) {
    router.post(`/:id/reseau/relations/:relId/${action}`, ecriture, gardeProjet, enveloppe(async (req, res) => {
      const p = corpsJustification.safeParse(req.body);
      if (!p.success) return refuser(res, p.error, "JUSTIFICATION_INVALIDE");
      res.json(await transitionRelation(acteurDe(req), req.params.id, req.params.relId, action, p.data.justification));
    }));
  }

  // ------------------------------------------------------------------------------------------------ Propositions automatiques
  const tolerance = z.number().min(0.01).max(100);
  const corpsProposition = z.object({
    jeuId: uuid.optional(),
    couvertureMin: z.number().min(0.5).max(1).optional(),
    parCircuitMax: z.number().int().min(1).max(20).optional(),
    tolerances: z.object({ A: tolerance.optional(), B: tolerance.optional(), C: tolerance.optional(), D: tolerance.optional(), INCONNUE: tolerance.optional() }).strict().optional(),
  }).strict();
  router.post("/:id/reseau/associations/proposer", ecriture, gardeProjet, enveloppe(async (req, res) => {
    const p = corpsProposition.safeParse(req.body ?? {});
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.status(201).json(await proposerAssociations(acteurDe(req), req.params.id, p.data));
  }));

  // ------------------------------------------------------------------------------------------------ Comptage
  const requeteComptage = z.object({ jeuId: opt(uuid), inclureNonAutorises: triEtat }).strict();
  router.get("/:id/reseau/comptage", gardeProjet, enveloppe(async (req, res) => {
    const p = requeteComptage.safeParse(req.query);
    if (!p.success) return refuser(res, p.error);
    // La quarantaine n'est lisible que des roles qui decident (comme la carte et l'analyse du socle).
    if (p.data.inclureNonAutorises && !voitTousLesJeux(req.user!.role)) {
      res.status(403).json({ error: "inclureNonAutorises est reserve aux comptes ADMIN et GESTIONNAIRE : la quarantaine n'est pas lisible par un lecteur", code: "QUARANTAINE_RESERVEE" });
      return;
    }
    res.json(await comptageProjet(acteurDe(req), req.params.id, { jeuId: p.data.jeuId, inclureNonAutorises: p.data.inclureNonAutorises }));
  }));
}
