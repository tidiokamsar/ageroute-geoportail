import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import { z } from "zod";
import type { Acteur } from "../projets-voirie/projets.service";
import {
  changerStatut, creerDocument, decoderCurseurDocuments, deposerPiece, ficheDocument, listerDocuments, nouvelleVersion, retirerDocument, type PieceDepot,
} from "../projets-voirie/documents/documents.service";
import { completudeProjet } from "../projets-voirie/documents/completude.service";
import { STATUTS_DOCUMENT } from "../projets-voirie/documents/etats.noyau";

/**
 * `/api/v2/projets-voirie/:id/{documents,completude}` -- DOCUMENTS DU DOSSIER ET « CE QUE LES DOCUMENTS PERMETTENT » (lot D1).
 * Contrat : docs/projets-voirie/CONTRAT-DOCUMENTS.md ; reference des reponses : docs/projets-voirie/API.md, section « Documents du projet ».
 *
 * Les routes sont montees sur le routeur du socle et en heritent TOUTES les gardes, dans le meme ordre : authentification -> cle de module
 * `projets-voirie` -> compte referent confine au workflow (403) -> octet NUL (400) -> identifiants d URL en UUID (400) -> role (ecritures) -> PROJET
 * DESIGNE (404 identique si inexistant ou hors perimetre territorial ; 404 PROJET_INTROUVABLE a tous pour un projet retire, par le service) ->
 * reception du fichier (place, 25 Mo) -> validation stricte (400) -> service.
 *
 *   - lecture : toute personne qui a la cle de module ; un compte qui ne decide pas ne voit que les documents VALIDE ;
 *   - ecritures (creation, depot, version, statut, retrait) : ADMIN et GESTIONNAIRE, auditees ; retrait d une piece VALIDE : ADMIN (service) ;
 *   - AUCUN fichier n est conserve : le contenu televerse ne sert qu a l empreinte et au format ; AUCUNE geometrie n est rendue.
 */
export interface OutilsRoutesDocuments {
  ecriture: RequestHandler;
  gardeProjet: RequestHandler;
  acteurDe: (req: Request) => Acteur;
  enveloppe: (g: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => void;
  refuser: (res: Response, e: z.ZodError, code?: string) => void;
  UUID: RegExp;
  placeDeReception: RequestHandler;
  recevoir: RequestHandler;
  refuserNul: RequestHandler;
}

const vide = (v: unknown) => (v === "" ? undefined : v);
const opt = <T extends z.ZodTypeAny>(s: T) => z.preprocess(vide, s.optional());
const jourIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && d.getUTCFullYear() >= 1900 && d.getUTCFullYear() <= 2100;
}, "date AAAA-MM-JJ valide attendue");
const codeType = z.string().trim().min(2).max(64).transform((s) => s.toUpperCase()).pipe(z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,63}$/, "code du referentiel TYPE_DOCUMENT"));
const justification = z.string().trim().max(2000);

export function monterRoutesDocuments(router: Router, o: OutilsRoutesDocuments): void {
  const { ecriture, gardeProjet, acteurDe, enveloppe, refuser, UUID, placeDeReception, recevoir, refuserNul } = o;
  const uuid = z.string().regex(UUID, "UUID attendu");

  router.param("docId", (_req, res, next, valeur: string) => {
    if (!UUID.test(valeur)) { res.status(400).json({ error: "Identifiant de document invalide (UUID attendu)", code: "IDENTIFIANT_INVALIDE" }); return; }
    next();
  });

  const fichierDe = (req: Request): PieceDepot["fichier"] => (req.file ? { contenu: req.file.buffer, nom: req.file.originalname } : undefined);
  const champsPiece = { reference: opt(z.string().trim().min(1).max(300)), jeuId: opt(uuid) };

  // ------------------------------------------------------------------------------------------------ Ce que les documents permettent
  router.get("/:id/completude", gardeProjet, enveloppe(async (req, res) => { res.json(await completudeProjet(acteurDe(req), req.params.id)); }));

  // ------------------------------------------------------------------------------------------------ Liste et fiche
  const listeStatuts = z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v),
    z.array(z.enum(STATUTS_DOCUMENT)).min(1).max(9).optional(),
  );
  const requeteListe = z.object({
    statut: listeStatuts, typeCode: opt(codeType), versions: z.preprocess(vide, z.enum(["courantes", "toutes"]).default("courantes")),
    limite: z.preprocess(vide, z.coerce.number().int().min(1).max(100).default(50)), curseur: opt(z.string().max(300)),
  }).strict();
  router.get("/:id/documents", gardeProjet, enveloppe(async (req, res) => {
    const p = requeteListe.safeParse(req.query);
    if (!p.success) return refuser(res, p.error);
    let curseur;
    if (p.data.curseur !== undefined) {
      curseur = decoderCurseurDocuments(p.data.curseur) ?? undefined;
      if (!curseur) { res.status(400).json({ error: "Curseur invalide : repartez de la première page", code: "CURSEUR_INVALIDE" }); return; }
    }
    res.json(await listerDocuments(acteurDe(req), req.params.id, { statuts: p.data.statut, typeCode: p.data.typeCode, toutesVersions: p.data.versions === "toutes", limite: p.data.limite, curseur }));
  }));

  router.get("/:id/documents/:docId", gardeProjet, enveloppe(async (req, res) => { res.json(await ficheDocument(acteurDe(req), req.params.id, req.params.docId)); }));

  // ------------------------------------------------------------------------------------------------ Ecritures (JSON ou multipart : fichier facultatif)
  const corpsCreation = z.object({
    typeCode: codeType, titre: z.string().trim().min(1).max(200), description: opt(z.string().trim().max(2000)), dateDocument: opt(jourIso),
    concessionnaireId: opt(uuid), ...champsPiece,
  }).strict();
  router.post("/:id/documents", ecriture, gardeProjet, placeDeReception, recevoir, refuserNul, enveloppe(async (req, res) => {
    const p = corpsCreation.safeParse(req.body ?? {});
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    const { reference, jeuId, ...d } = p.data;
    res.status(201).json(await creerDocument(acteurDe(req), req.params.id, d, { reference, jeuId, fichier: fichierDe(req) }));
  }));

  const corpsPiece = z.object(champsPiece).strict();
  router.post("/:id/documents/:docId/depot", ecriture, gardeProjet, placeDeReception, recevoir, refuserNul, enveloppe(async (req, res) => {
    const p = corpsPiece.safeParse(req.body ?? {});
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.json(await deposerPiece(acteurDe(req), req.params.id, req.params.docId, { ...p.data, fichier: fichierDe(req) }));
  }));

  router.post("/:id/documents/:docId/versions", ecriture, gardeProjet, placeDeReception, recevoir, refuserNul, enveloppe(async (req, res) => {
    const p = corpsPiece.safeParse(req.body ?? {});
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.status(201).json(await nouvelleVersion(acteurDe(req), req.params.id, req.params.docId, { ...p.data, fichier: fichierDe(req) }));
  }));

  const corpsStatut = z.object({ statut: z.string().trim().min(1).max(40), justification: opt(justification) }).strict();
  router.post("/:id/documents/:docId/statut", ecriture, gardeProjet, enveloppe(async (req, res) => {
    const p = corpsStatut.safeParse(req.body ?? {});
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.json(await changerStatut(acteurDe(req), req.params.id, req.params.docId, p.data.statut, p.data.justification));
  }));

  const corpsRetrait = z.object({ justification: justification.min(10, "10 caractères au moins") }).strict();
  router.delete("/:id/documents/:docId", ecriture, gardeProjet, enveloppe(async (req, res) => {
    const p = corpsRetrait.safeParse(req.body ?? {});
    if (!p.success) return refuser(res, p.error, "JUSTIFICATION_INVALIDE");
    res.json(await retirerDocument(acteurDe(req), req.params.id, req.params.docId, p.data.justification));
  }));
}
