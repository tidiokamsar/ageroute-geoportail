import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import { z } from "zod";
import type { Acteur } from "../projets-voirie/projets.service";
import { detailComparaison, lancerComparaison, listerComparaisons, listerResultats, ouvrirDossierDivergence, decoderCurseurResultats } from "../projets-voirie/sources/comparaison.service";
import { approuverRegleRapprochement, creerRegleRapprochement, FAMILLES_RESEAU, listerReglesRapprochement } from "../projets-voirie/sources/regles-rapprochement.service";
import { lirePrecisionParClasse } from "../projets-voirie/sources/regle-rapprochement.noyau";
import { vueSources } from "../projets-voirie/sources/sources.service";
import { STATUTS_RESULTAT_COMPARAISON } from "../projets-voirie/sources/types.noyau";
import { decoderCurseurAnalyse } from "../projets-voirie/conflits/curseurs.noyau";

/**
 * `/api/v2/projets-voirie/:id/{sources,regles-rapprochement,comparaisons}` -- SOURCES MULTIPLES ET COMPARAISON ENTRE SOURCES (lot S1).
 * Contrat : docs/projets-voirie/CONTRAT-SOURCES.md ; reference des reponses : docs/projets-voirie/API.md, section « Sources multiples ».
 *
 * Les routes sont montees sur le routeur du socle et en heritent TOUTES les gardes, dans le meme ordre : authentification -> cle de module
 * `projets-voirie` -> octet NUL (400) -> identifiants d URL en UUID (400) -> role (ecritures) -> PROJET DESIGNE (404 identique si inexistant ou
 * hors perimetre territorial) -> validation stricte des entrees (400) -> service.
 *
 *   - lecture : toute personne qui a la cle de module, limitee aux comparaisons dont les deux jeux lui sont lisibles ;
 *   - ecritures (regle, approbation ADMIN, comparaison, ouverture d un dossier) : ADMIN et GESTIONNAIRE, auditees ;
 *   - AUCUNE geometrie n est rendue ; AUCUNE route ne decide, ne fusionne ni ne modifie une source ; le seul effet metier (dossier de conflit
 *     DIVERGENCE_SOURCES) exige une action humaine justifiee.
 */
export interface OutilsRoutesSources {
  ecriture: RequestHandler;
  administrateur: RequestHandler;
  gardeProjet: RequestHandler;
  acteurDe: (req: Request) => Acteur;
  enveloppe: (g: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => void;
  refuser: (res: Response, e: z.ZodError, code?: string) => void;
  UUID: RegExp;
}

const vide = (v: unknown) => (v === "" ? undefined : v);
const opt = <T extends z.ZodTypeAny>(s: T) => z.preprocess(vide, s.optional());

export function monterRoutesSources(router: Router, o: OutilsRoutesSources): void {
  const { ecriture, administrateur, gardeProjet, acteurDe, enveloppe, refuser, UUID } = o;
  const uuid = z.string().regex(UUID, "UUID attendu");
  const listeEnum = <T extends string>(valeurs: readonly [T, ...T[]]) => z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v),
    z.array(z.enum(valeurs)).min(1).max(10).optional(),
  );

  for (const [param, libelle] of [["cmpId", "comparaison"], ["regleRapId", "règle de rapprochement"]] as const) {
    router.param(param, (_req, res, next, valeur: string) => {
      if (!UUID.test(valeur)) { res.status(400).json({ error: `Identifiant de ${libelle} invalide (UUID attendu)`, code: "IDENTIFIANT_INVALIDE" }); return; }
      next();
    });
  }
  const curseurInvalide = (res: Response) => { res.status(400).json({ error: "Curseur invalide : repartez de la première page", code: "CURSEUR_INVALIDE" }); };

  // ------------------------------------------------------------------------------------------------ Sources d un reseau
  router.get("/:id/sources", gardeProjet, enveloppe(async (req, res) => { res.json(await vueSources(acteurDe(req), req.params.id)); }));

  // ------------------------------------------------------------------------------------------------ Regles de rapprochement
  router.get("/:id/regles-rapprochement", gardeProjet, enveloppe(async (req, res) => { res.json(await listerReglesRapprochement(req.params.id)); }));

  const precisionsParClasse = z.object({ A: z.number().positive().max(100_000), B: z.number().positive().max(100_000), C: z.number().positive().max(100_000), D: z.number().positive().max(100_000) }).strict();
  const corpsRegle = z.object({
    famille: z.enum(FAMILLES_RESEAU).nullable().optional(),
    code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/, "lettres, chiffres, point, tiret et souligne"),
    margeM: z.number().min(0).max(100).default(1),
    rayonAppariementM: z.number().min(0.01).max(1000).default(10),
    partHorsCorridorMax: z.number().min(0).max(1).default(0),
    precisionParClasseM: precisionsParClasse.optional(),
    justification: z.string().trim().max(2000).optional(),
  }).strict();
  router.post("/:id/regles-rapprochement", ecriture, gardeProjet, enveloppe(async (req, res) => {
    const p = corpsRegle.safeParse(req.body ?? {});
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    const table = p.data.precisionParClasseM === undefined ? undefined : lirePrecisionParClasse(p.data.precisionParClasseM) ?? undefined;
    res.status(201).json(await creerRegleRapprochement(acteurDe(req), req.params.id, { ...p.data, precisionParClasseM: table, justification: p.data.justification ?? "" }));
  }));

  const corpsApprobation = z.object({ justification: z.string().trim().max(2000).optional(), derogation: z.string().trim().max(2000).optional() }).strict();
  router.post("/:id/regles-rapprochement/:regleRapId/approuver", administrateur, gardeProjet, enveloppe(async (req, res) => {
    const p = corpsApprobation.safeParse(req.body ?? {});
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.json(await approuverRegleRapprochement(acteurDe(req), req.params.id, req.params.regleRapId, p.data));
  }));

  // ------------------------------------------------------------------------------------------------ Comparaisons
  const corpsComparaison = z.object({ jeuAId: uuid, jeuBId: uuid }).strict();
  router.post("/:id/comparaisons", ecriture, gardeProjet, enveloppe(async (req, res) => {
    const p = corpsComparaison.safeParse(req.body ?? {});
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.status(201).json(await lancerComparaison(acteurDe(req), req.params.id, p.data));
  }));

  const requeteListe = z.object({ limite: z.preprocess(vide, z.coerce.number().int().min(1).max(100).default(25)), curseur: opt(z.string().max(300)), jeuId: opt(uuid) }).strict();
  router.get("/:id/comparaisons", gardeProjet, enveloppe(async (req, res) => {
    const p = requeteListe.safeParse(req.query);
    if (!p.success) return refuser(res, p.error);
    let avantNumero: number | undefined;
    if (p.data.curseur !== undefined) {
      avantNumero = decoderCurseurAnalyse(p.data.curseur) ?? undefined;
      if (avantNumero === undefined) return curseurInvalide(res);
    }
    res.json(await listerComparaisons(acteurDe(req), req.params.id, { limite: p.data.limite, avantNumero, jeuId: p.data.jeuId }));
  }));

  router.get("/:id/comparaisons/:cmpId", gardeProjet, enveloppe(async (req, res) => { res.json(await detailComparaison(acteurDe(req), req.params.id, req.params.cmpId)); }));

  const requeteResultats = z.object({
    statut: listeEnum(STATUTS_RESULTAT_COMPARAISON), limite: z.preprocess(vide, z.coerce.number().int().min(1).max(200).default(50)), curseur: opt(z.string().max(300)),
  }).strict();
  router.get("/:id/comparaisons/:cmpId/objets", gardeProjet, enveloppe(async (req, res) => {
    const p = requeteResultats.safeParse(req.query);
    if (!p.success) return refuser(res, p.error);
    let apresOrdre: number | undefined;
    if (p.data.curseur !== undefined) {
      apresOrdre = decoderCurseurResultats(p.data.curseur) ?? undefined;
      if (apresOrdre === undefined) return curseurInvalide(res);
    }
    res.json(await listerResultats(acteurDe(req), req.params.id, req.params.cmpId, { statuts: p.data.statut, limite: p.data.limite, apresOrdre }));
  }));

  // Ouverture d un dossier de conflit a investiguer : action HUMAINE, justifiee ; le serveur ne le fait jamais seul.
  const corpsDossier = z.object({ resultatId: uuid, justification: z.string().trim().max(2000).optional() }).strict();
  router.post("/:id/comparaisons/:cmpId/dossiers-conflit", ecriture, gardeProjet, enveloppe(async (req, res) => {
    const p = corpsDossier.safeParse(req.body ?? {});
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.status(201).json(await ouvrirDossierDivergence(acteurDe(req), req.params.id, req.params.cmpId, { resultatId: p.data.resultatId, justification: p.data.justification ?? "" }));
  }));
}
