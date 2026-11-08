import type { Request, Response, Router } from "express";
import { z } from "zod";
import { creerDemande, ficheDemande, listerDemandes, modifierDemande, changerStatutDemande, decoderCurseurDemande } from "../projets-voirie/workflow/demandes.service";
import { STATUTS_DEMANDE } from "../projets-voirie/workflow/demandes.noyau";
import { acteurWorkflow, gardeWorkflow } from "../projets-voirie/workflow/garde";
import { TYPES_PREUVE_WORKFLOW, type TypeObjet } from "../projets-voirie/workflow/preuves.noyau";
import { ajouterPreuve } from "../projets-voirie/workflow/preuves.service";
import { creerRattachement, listerReferents, monProfil, revoquerRattachement } from "../projets-voirie/workflow/referents.service";
import { STATUTS_RECOLEMENT } from "../projets-voirie/workflow/recolements.noyau";
import { changerStatutRecolement, creerRecolement, decoderCurseurRecolement, ficheRecolement, listerRecolements, modifierRecolement } from "../projets-voirie/workflow/recolements.service";
import { PRIORITES_TACHE, STATUTS_TACHE } from "../projets-voirie/workflow/taches.noyau";
import { changerStatutTache, creerTache, decoderCurseurTache, ficheTache, listerTaches, modifierTache } from "../projets-voirie/workflow/taches.service";
import { decoderCurseurVue, listerConflitsVue, listerJeuxVue } from "../projets-voirie/workflow/vues-restreintes.service";
import { STATUTS_CONFLIT, TYPES_CONFLIT } from "../projets-voirie/conflits/types.noyau";
import type { OutilsRoutes } from "./projets-voirie.conflits.routes";

/**
 * `/api/v2/projets-voirie/{workflow, :id/workflow}` -- WORKFLOW CONCESSIONNAIRE, ROLES DU CAHIER ET RECOLEMENT (lot B3). Contrat :
 * docs/projets-voirie/CONTRAT-WORKFLOW.md ; reference des reponses : docs/projets-voirie/API.md, section « Workflow ».
 *
 * Les routes sont montees sur le routeur du socle et en heritent les gardes : authentification -> cle de module `projets-voirie` -> octet NUL (400) ->
 * restriction du compte rattache a un concessionnaire (`gardeReferent`, 403 hors `/workflow/...`) -> identifiants d'URL en UUID (400) -> PROJET DESIGNE
 * (404 identique si inexistant ou hors perimetre territorial ; pour un referent : rattachement a ce projet) -> DROIT DE LA MATRICE (`gardeWorkflow`,
 * 403 ACTION_NON_AUTORISEE) -> validation du corps (400) -> service (qui filtre les lignes selon le profil et rend la meme 404 pour un element d'autrui).
 *
 * L'APPLICATION N'ENVOIE AUCUN MESSAGE : l'envoi d'une demande est un acte humain hors application, ici seulement ENREGISTRE.
 * AUCUNE route ne cree d'ordre, de deplacement ni de decision ; aucune route n'exporte de geometrie ; aucune n'ecrit dans le referentiel officiel.
 */
export function monterRoutesWorkflow(router: Router, o: Pick<OutilsRoutes, "gardeProjet" | "acteurDe" | "enveloppe" | "refuser" | "UUID">): void {
  const { gardeProjet, enveloppe, refuser, UUID } = o;

  for (const [param, libelle] of [["demandeId", "demande"], ["tacheId", "tâche"], ["recolementId", "récolement"], ["rattachementId", "rattachement"]] as const) {
    router.param(param, (_req, res, next, valeur: string) => {
      if (!UUID.test(valeur)) { res.status(400).json({ error: `Identifiant de ${libelle} invalide (UUID attendu)`, code: "IDENTIFIANT_INVALIDE" }); return; }
      next();
    });
  }

  const A = (req: Request, res: Response) => acteurWorkflow(req, res);
  const vide = (v: unknown) => (v === "" ? undefined : v);
  const opt = <T extends z.ZodTypeAny>(s: T) => z.preprocess(vide, s.optional());
  const uuid = z.string().regex(UUID, "UUID attendu");
  const jourIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date AAAA-MM-JJ attendue").refine((s) => {
    const d = new Date(`${s}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && d.getUTCFullYear() >= 1900 && d.getUTCFullYear() <= 2100;
  }, "date AAAA-MM-JJ valide attendue");
  const triEtat = z.preprocess(vide, z.enum(["true", "false"]).optional()).transform((v) => (v === undefined ? undefined : v === "true"));
  const listeEnum = <T extends string>(valeurs: readonly [T, ...T[]]) => z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v),
    z.array(z.enum(valeurs)).min(1).max(20).optional(),
  );
  const pagination = { limite: z.preprocess(vide, z.coerce.number().int().min(1).max(100).default(25)), curseur: opt(z.string().max(300)) };
  const nul = <T extends z.ZodTypeAny>(s: T) => s.nullable().optional();
  const texteNul = (max: number) => z.string().max(max).nullable().optional();

  /** Decode un curseur ; rend `undefined` s'il est absent, `"invalide"` (et ecrit la 400) s'il est forge. */
  const curseurDe = (brut: string | undefined, decoder: (s: string) => { t: Date; i: string } | null, res: Response): { t: Date; i: string } | undefined | "invalide" => {
    if (brut === undefined) return undefined;
    const c = decoder(brut);
    if (!c) { res.status(400).json({ error: "Curseur invalide : repartez de la première page", code: "CURSEUR_INVALIDE" }); return "invalide"; }
    return c;
  };

  // ------------------------------------------------------------------------------------------------ Profil et rattachements
  router.get("/workflow/mon-profil", enveloppe(async (req, res) => { res.json(await monProfil(await A(req, res))); }));

  router.get("/:id/workflow/referents", gardeProjet, gardeWorkflow("referent.lire"), enveloppe(async (req, res) => { res.json(await listerReferents(req.params.id)); }));

  const corpsReferent = z.object({ userId: uuid, concessionnaireId: uuid, motif: z.string().trim().max(2000) }).strict();
  router.post("/:id/workflow/referents", gardeProjet, gardeWorkflow("referent.gerer"), enveloppe(async (req, res) => {
    const p = corpsReferent.safeParse(req.body);
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.status(201).json(await creerRattachement(await A(req, res), req.params.id, p.data));
  }));

  const corpsRevocation = z.object({ motif: z.string().trim().max(2000) }).strict();
  router.post("/:id/workflow/referents/:rattachementId/revoquer", gardeProjet, gardeWorkflow("referent.gerer"), enveloppe(async (req, res) => {
    const p = corpsRevocation.safeParse(req.body);
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.json(await revoquerRattachement(await A(req, res), req.params.id, req.params.rattachementId, p.data));
  }));

  // ------------------------------------------------------------------------------------------------ Vues restreintes (jeux, dossiers de conflit)
  router.get("/:id/workflow/jeux", gardeProjet, gardeWorkflow("workflow.lire"), enveloppe(async (req, res) => { res.json(await listerJeuxVue(await A(req, res), req.params.id)); }));

  const requeteConflits = z.object({ statut: listeEnum(STATUTS_CONFLIT), type: listeEnum(TYPES_CONFLIT), ...pagination }).strict();
  router.get("/:id/workflow/conflits", gardeProjet, gardeWorkflow("workflow.lire"), enveloppe(async (req, res) => {
    const p = requeteConflits.safeParse(req.query);
    if (!p.success) return refuser(res, p.error);
    const curseur = curseurDe(p.data.curseur, decoderCurseurVue, res);
    if (curseur === "invalide") return;
    res.json(await listerConflitsVue(await A(req, res), req.params.id, { statuts: p.data.statut, types: p.data.type }, p.data.limite, curseur));
  }));

  // ------------------------------------------------------------------------------------------------ Demandes
  const requeteDemandes = z.object({ statut: listeEnum(STATUTS_DEMANDE), concessionnaireId: opt(uuid), echeanceDepassee: triEtat, ...pagination }).strict();
  router.get("/:id/workflow/demandes", gardeProjet, gardeWorkflow("workflow.lire"), enveloppe(async (req, res) => {
    const p = requeteDemandes.safeParse(req.query);
    if (!p.success) return refuser(res, p.error);
    const curseur = curseurDe(p.data.curseur, decoderCurseurDemande, res);
    if (curseur === "invalide") return;
    res.json(await listerDemandes(await A(req, res), req.params.id, { statuts: p.data.statut, concessionnaireId: p.data.concessionnaireId, echeanceDepassee: p.data.echeanceDepassee }, p.data.limite, curseur));
  }));

  const corpsDemande = z.object({
    concessionnaireId: uuid, objet: z.string().trim().min(1).max(200), description: texteNul(4000), echeance: nul(jourIso),
  }).strict();
  router.post("/:id/workflow/demandes", gardeProjet, gardeWorkflow("demande.ecrire"), enveloppe(async (req, res) => {
    const p = corpsDemande.safeParse(req.body);
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.status(201).json(await creerDemande(await A(req, res), req.params.id, p.data));
  }));

  router.get("/:id/workflow/demandes/:demandeId", gardeProjet, gardeWorkflow("workflow.lire"), enveloppe(async (req, res) => { res.json(await ficheDemande(await A(req, res), req.params.id, req.params.demandeId)); }));

  const corpsModifDemande = z.object({
    objet: z.string().trim().min(1).max(200).optional(), description: texteNul(4000), echeance: nul(jourIso), jeuRecuId: nul(uuid), justification: z.string().max(2000).optional(),
  }).strict().refine((b) => ["objet", "description", "echeance", "jeuRecuId"].some((k) => (b as Record<string, unknown>)[k] !== undefined), "au moins un champ à modifier");
  router.patch("/:id/workflow/demandes/:demandeId", gardeProjet, gardeWorkflow("demande.ecrire"), enveloppe(async (req, res) => {
    const p = corpsModifDemande.safeParse(req.body);
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.json(await modifierDemande(await A(req, res), req.params.id, req.params.demandeId, p.data));
  }));

  const corpsStatutDemande = z.discriminatedUnion("vers", [
    z.object({ vers: z.literal("ENVOYEE"), canalEnvoi: z.string().max(100), dateEnvoi: jourIso, referenceEnvoi: texteNul(200), interlocuteur: texteNul(200) }).strict(),
    z.object({ vers: z.literal("RECUE"), dateReception: jourIso, jeuRecuId: nul(uuid), note: texteNul(2000) }).strict(),
    z.object({ vers: z.enum(["CLOTUREE", "ANNULEE"]), justification: z.string().max(2000) }).strict(),
  ]);
  router.post("/:id/workflow/demandes/:demandeId/statut", gardeProjet, gardeWorkflow("demande.ecrire"), enveloppe(async (req, res) => {
    const p = corpsStatutDemande.safeParse(req.body);
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.json(await changerStatutDemande(await A(req, res), req.params.id, req.params.demandeId, p.data));
  }));

  // ------------------------------------------------------------------------------------------------ Taches
  const requeteTaches = z.object({
    statut: listeEnum(STATUTS_TACHE), responsableId: opt(uuid), conflitId: opt(uuid), demandeId: opt(uuid), concessionnaireId: opt(uuid), echeanceDepassee: triEtat, ...pagination,
  }).strict();
  router.get("/:id/workflow/taches", gardeProjet, gardeWorkflow(["workflow.lire", "tache.executer"]), enveloppe(async (req, res) => {
    const p = requeteTaches.safeParse(req.query);
    if (!p.success) return refuser(res, p.error);
    const curseur = curseurDe(p.data.curseur, decoderCurseurTache, res);
    if (curseur === "invalide") return;
    const { statut, limite, curseur: _c, ...filtres } = p.data;
    void _c;
    res.json(await listerTaches(await A(req, res), req.params.id, { statuts: statut, ...filtres }, limite, curseur));
  }));

  const corpsTache = z.object({
    titre: z.string().trim().min(1).max(200), description: texteNul(4000), responsableId: uuid, echeance: nul(jourIso), priorite: z.enum(PRIORITES_TACHE).optional(),
    validationRequise: z.boolean().optional(), conflitId: nul(uuid), demandeId: nul(uuid), concessionnaireId: nul(uuid), partagee: z.boolean().optional(),
  }).strict();
  router.post("/:id/workflow/taches", gardeProjet, gardeWorkflow("tache.gerer"), enveloppe(async (req, res) => {
    const p = corpsTache.safeParse(req.body);
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.status(201).json(await creerTache(await A(req, res), req.params.id, p.data));
  }));

  router.get("/:id/workflow/taches/:tacheId", gardeProjet, gardeWorkflow(["workflow.lire", "tache.executer"]), enveloppe(async (req, res) => { res.json(await ficheTache(await A(req, res), req.params.id, req.params.tacheId)); }));

  // Un agent de terrain (INSPECTEUR) n'a pas `workflow.lire` : la liste et le detail des taches lui sont ouverts par `tache.executer`, et le service ne lui rend QUE les taches dont il est le responsable.
  const corpsModifTache = z.object({
    titre: z.string().trim().min(1).max(200).optional(), description: texteNul(4000), echeance: nul(jourIso), priorite: z.enum(PRIORITES_TACHE).optional(), responsableId: uuid.optional(),
    partagee: z.boolean().optional(), justification: z.string().max(2000).optional(),
  }).strict().refine((b) => Object.keys(b).some((k) => k !== "justification" && (b as Record<string, unknown>)[k] !== undefined), "au moins un champ à modifier");
  router.patch("/:id/workflow/taches/:tacheId", gardeProjet, gardeWorkflow("tache.gerer"), enveloppe(async (req, res) => {
    const p = corpsModifTache.safeParse(req.body);
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.json(await modifierTache(await A(req, res), req.params.id, req.params.tacheId, p.data));
  }));

  const corpsStatutTache = z.object({ vers: z.enum(STATUTS_TACHE), justification: z.string().max(2000).optional(), derogation: z.string().max(2000).optional() }).strict();
  router.post("/:id/workflow/taches/:tacheId/statut", gardeProjet, gardeWorkflow("tache.executer"), enveloppe(async (req, res) => {
    const p = corpsStatutTache.safeParse(req.body);
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.json(await changerStatutTache(await A(req, res), req.params.id, req.params.tacheId, p.data));
  }));

  // ------------------------------------------------------------------------------------------------ Recolements
  const requeteRecolements = z.object({ statut: listeEnum(STATUTS_RECOLEMENT), conflitId: opt(uuid), jeuId: opt(uuid), ...pagination }).strict();
  router.get("/:id/workflow/recolements", gardeProjet, gardeWorkflow("workflow.lire"), enveloppe(async (req, res) => {
    const p = requeteRecolements.safeParse(req.query);
    if (!p.success) return refuser(res, p.error);
    const curseur = curseurDe(p.data.curseur, decoderCurseurRecolement, res);
    if (curseur === "invalide") return;
    res.json(await listerRecolements(await A(req, res), req.params.id, { statuts: p.data.statut, conflitId: p.data.conflitId, jeuId: p.data.jeuId }, p.data.limite, curseur));
  }));

  const corpsRecolement = z.object({
    conflitId: nul(uuid), jeuId: nul(uuid), objet: z.string().trim().min(1).max(200), constat: texteNul(4000), ecarts: texteNul(4000), dateRecolement: nul(jourIso),
  }).strict();
  router.post("/:id/workflow/recolements", gardeProjet, gardeWorkflow("recolement.ecrire"), enveloppe(async (req, res) => {
    const p = corpsRecolement.safeParse(req.body);
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.status(201).json(await creerRecolement(await A(req, res), req.params.id, p.data));
  }));

  router.get("/:id/workflow/recolements/:recolementId", gardeProjet, gardeWorkflow("workflow.lire"), enveloppe(async (req, res) => { res.json(await ficheRecolement(await A(req, res), req.params.id, req.params.recolementId)); }));

  const corpsModifRecolement = z.object({
    objet: z.string().trim().min(1).max(200).optional(), constat: texteNul(4000), ecarts: texteNul(4000), dateRecolement: nul(jourIso), justification: z.string().max(2000).optional(),
  }).strict().refine((b) => ["objet", "constat", "ecarts", "dateRecolement"].some((k) => (b as Record<string, unknown>)[k] !== undefined), "au moins un champ à modifier");
  router.patch("/:id/workflow/recolements/:recolementId", gardeProjet, gardeWorkflow("recolement.ecrire"), enveloppe(async (req, res) => {
    const p = corpsModifRecolement.safeParse(req.body);
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.json(await modifierRecolement(await A(req, res), req.params.id, req.params.recolementId, { ...p.data, justification: p.data.justification ?? "" }));
  }));

  // `recolement.ecrire` ouvre la route ; valider et rejeter exigent en plus `recolement.valider` (verifie par le noyau, 403 ACTION_NON_AUTORISEE).
  // Un compte qui n'a que `recolement.valider` (configuration) passe aussi : la garde de la route est donc la plus large des deux.
  const corpsStatutRecolement = z.object({ vers: z.enum(STATUTS_RECOLEMENT), justification: z.string().max(2000).optional(), derogation: z.string().max(2000).optional() }).strict();
  router.post("/:id/workflow/recolements/:recolementId/statut", gardeProjet, gardeWorkflow("recolement.ecrire"), enveloppe(async (req, res) => {
    const p = corpsStatutRecolement.safeParse(req.body);
    if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
    res.json(await changerStatutRecolement(await A(req, res), req.params.id, req.params.recolementId, p.data));
  }));

  // ------------------------------------------------------------------------------------------------ Preuves (references et empreintes ; aucun fichier)
  const corpsPreuve = z.object({
    type: z.enum(TYPES_PREUVE_WORKFLOW), texte: z.string().trim().min(1).max(4000), reference: texteNul(500), nomFichier: texteNul(255), sha256: texteNul(128),
    tailleOctets: z.number().int().min(0).max(2_147_483_647).nullable().optional(), partagee: z.boolean().optional(),
  }).strict();
  const CIBLES: readonly (readonly [string, TypeObjet, string])[] = [["demandes", "DEMANDE", "demandeId"], ["taches", "TACHE", "tacheId"], ["recolements", "RECOLEMENT", "recolementId"]];
  for (const [segment, type, param] of CIBLES) {
    router.post(`/:id/workflow/${segment}/:${param}/preuves`, gardeProjet, gardeWorkflow("preuve.ajouter"), enveloppe(async (req, res) => {
      const p = corpsPreuve.safeParse(req.body);
      if (!p.success) return refuser(res, p.error, "CHAMPS_INVALIDES");
      res.status(201).json(await ajouterPreuve(await A(req, res), req.params.id, type, req.params[param], p.data));
    }));
  }
}
