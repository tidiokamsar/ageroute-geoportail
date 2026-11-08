import { Router, type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ClasseRoute, EtatPatrimoine, StatutChantier } from "@prisma/client";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { prisma } from "../lib/prisma";
import { moduleAutorise, modulesAutorisesDe } from "../lib/access";
import { droitMontantsContractuels } from "../modules/chantiers/chantiers.confidentialite";
import { perimetreDe } from "../territoire/territoire.service";
import { regionsScenario } from "../territoire/territoire.lecture";
import { verifierTerritoire, type Perimetre } from "../territoire/territoire.noyau";
import { logAuditTransactionnelle } from "../utils/audit";
import { listerBaremes, lireHistorique, lireIdBareme, voitLesIdentites } from "./baremes.routes";
import { depotPrisma } from "../aide-decision/synthese";
import { lireFiltres } from "../aide-decision/synthese.filtres";
import { lireRapportRegions } from "../aide-decision/rapport.regions";
import { FORMATS_EXPORT, MENTION_CONSULTATIVE, TYPES_EXPORT, partitionnerFiltres, type FiltresExport } from "../aide-decision/export.noyau";
import { produireExport, typeNecessiteScenario, type Fournisseurs, type Portee } from "../aide-decision/export.service";
import { fournisseursReels } from "../aide-decision/export.fournisseurs";

/**
 * `/api/v2/aide-decision` (lot 6) : barèmes et historique, rapports par région, exports gouvernés et leur journal. NON MONTÉ
 * ici : l'orchestrateur monte `aideDecisionExportsRouter` dans `api-v2/index.ts`, sous `/aide-decision`.
 *
 *   GET  /baremes                  barèmes (unité, devise, prix, source, validité, version, statut d'approbation)
 *   GET  /baremes/:id/historique   historique d'une ligne (avant/après, auteur, motif, commentaire)
 *   GET  /rapports/regions         état du réseau par région (km par état, non évalué à part)
 *   POST /exports                  export gouverné (CSV ou JSON) : le fichier est la réponse
 *   GET  /exports                  journal des exports
 *
 * PERMISSION D'EXPORT (PROVISOIRE, CONTRAT-AD paragraphe 2) : module `rapports` ET rôle ADMIN ou GESTIONNAIRE. Une liste
 * d'interventions ou un scénario sortent en plus du module `programmation` (leur donnée est celle de ce module : l'export
 * ne contourne pas le module d'origine).
 *
 * PÉRIMÈTRE, COTE SERVEUR. La portée vient du compte, jamais de la requête : un compte régional n'exporte que sa région, le
 * filtre `regionId` ne peut que la réduire (hors périmètre : 403 HORS_PERIMETRE ; scénario hors périmètre ou inexistant :
 * le MÊME 404). Aucune colonne financière sans droit financier (`droitMontantsContractuels` : ADMIN, `marches` ou `chantiers`, PROVISOIRE). Lignes archivées jamais
 * exportées. Plafond de lignes : 413, jamais de fichier tronqué.
 *
 * JOURNAL AVANT REMISE. Le journal (qui, quand, type, filtres, périmètre, nombre de lignes, empreinte SHA-256 du fichier)
 * et l'audit sont écrits dans UNE transaction AVANT l'envoi du fichier : si l'écriture échoue, aucun fichier ne part.
 *
 * CONSULTATIF, NON ENGAGEANT : chaque fichier porte la mention. Lecture des données : rien n'est modifié hors le journal.
 */

const dateJour = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date AAAA-MM-JJ attendue").refine((s) => {
  const [a, m, j] = s.split("-").map(Number);
  const d = new Date(Date.UTC(a, m - 1, j));
  return a >= 2000 && a <= 2100 && d.getUTCFullYear() === a && d.getUTCMonth() === m - 1 && d.getUTCDate() === j;
}, "date inexistante");

const liste = <T extends string>(valeurs: readonly T[]) => z.array(z.enum(valeurs as [T, ...T[]])).min(1).max(10);

const schemaFiltres = z.object({
  regionId: z.number().int().positive().optional(),
  classe: liste(Object.values(ClasseRoute)).optional(),
  etat: liste(Object.values(EtatPatrimoine)).optional(),
  statutChantier: liste(Object.values(StatutChantier)).optional(),
  depuis: dateJour.optional(),
  jusqua: dateJour.optional(),
}).strict().refine((f) => f.depuis === undefined || f.jusqua === undefined || f.depuis <= f.jusqua, "depuis doit etre anterieur ou egal a jusqua");

const schemaCorps = z.object({
  type: z.enum(TYPES_EXPORT),
  format: z.enum(FORMATS_EXPORT),
  filtres: schemaFiltres.optional(),
  scenarioId: z.string().uuid().optional(),
}).strict();

const schemaJournal = z.object({
  limite: z.coerce.number().int().min(1).max(100).default(20),
  decalage: z.coerce.number().int().min(0).max(100_000).default(0),
}).strict();

export interface DependancesExports {
  fournisseurs: Fournisseurs;
  maintenant: () => Date;
  nouvelId: () => string;
}

type CompteReq = { id: string; role: string; email: string };

/** Portée du compte, réduite au filtre `regionId`. `refus` : la réponse HTTP à rendre. */
async function calculerPortee(
  user: CompteReq, regionId: number | undefined,
): Promise<{ ok: true; portee: Portee; perimetre: Perimetre } | { ok: false; statut: number; corps: Record<string, unknown> }> {
  const perimetre = await perimetreDe(user);
  let regions: number[] | null;
  if (perimetre.national) {
    regions = regionId === undefined ? null : [regionId];
  } else {
    const v = verifierTerritoire(perimetre, regionId === undefined ? [] : [regionId], "lecture");
    if (!v.ok) return { ok: false, statut: 403, corps: { error: v.motif, code: v.code } };
    regions = regionId === undefined ? [...perimetre.regions].sort((a, b) => a - b) : [regionId];
  }
  let noms: { id: number; nom: string }[] = [];
  if (regions !== null) {
    noms = await prisma.region.findMany({ where: { id: { in: regions } }, select: { id: true, nom: true } });
    // Une region inexistante est introuvable (meme reponse qu'une region hors perimetre pour un compte national).
    if (regionId !== undefined && noms.length === 0) return { ok: false, statut: 404, corps: { error: "Région introuvable", code: "INTROUVABLE" } };
  }
  const regionDemandee = regionId !== undefined ? (noms.find((n) => n.id === regionId)?.nom ?? null) : null;
  return {
    ok: true, perimetre,
    portee: { national: perimetre.national && regionId === undefined, regions, regionNoms: noms.map((n) => n.nom).sort((a, b) => a.localeCompare(b, "fr")), regionDemandee },
  };
}

export function creerRouteurExports(deps: Partial<DependancesExports> = {}): Router {
  const d: DependancesExports = {
    fournisseurs: deps.fournisseurs ?? fournisseursReels,
    maintenant: deps.maintenant ?? (() => new Date()),
    nouvelId: deps.nouvelId ?? randomUUID,
  };
  const router = Router();
  const erreurInterne = (next: NextFunction, err: unknown) => next(err);

  // ---------------------------------------------------------------- barèmes (lecture, module decision)
  router.get("/baremes", requireAuth, requireModuleAccess("decision"), async (req, res, next) => {
    try {
      const data = await listerBaremes(voitLesIdentites(req.user?.role));
      res.set("Cache-Control", "no-store").json({ data, mention: "Barèmes consultatifs : un prix non approuvé est provisoire, aucune estimation n'engage AGEROUTE." });
    } catch (err) { erreurInterne(next, err); }
  });

  router.get("/baremes/:id/historique", requireAuth, requireModuleAccess("decision"), async (req, res, next) => {
    try {
      const lu = lireIdBareme(req.params.id);
      if (!lu.ok) { res.status(lu.statut).set("Cache-Control", "no-store").json(lu.corps); return; }
      const r = await lireHistorique(lu.id, voitLesIdentites(req.user?.role));
      if (!r) { res.status(404).json({ error: "ligne de barème introuvable", code: "INTROUVABLE" }); return; }
      res.set("Cache-Control", "no-store").json({ data: r.historique, bareme: r.bareme });
    } catch (err) { erreurInterne(next, err); }
  });

  // ---------------------------------------------------------------- rapport par région (module rapports)
  router.get("/rapports/regions", requireAuth, requireModuleAccess("rapports"), async (req, res, next) => {
    try {
      const lecture = lireFiltres(req.query);
      if (!lecture.ok) { res.status(400).json({ error: "Filtres invalides", code: "FILTRE_INVALIDE", details: lecture.details }); return; }
      const f = lecture.filtres;
      const p = await calculerPortee(req.user as CompteReq, f.regionId);
      if (!p.ok) { res.status(p.statut).json(p.corps); return; }
      const r = await lireRapportRegions(depotPrisma(prisma), { regions: p.portee.regions, classes: f.classe ?? null, maintenant: d.maintenant() });
      const demandes: FiltresExport = { regionId: f.regionId, classe: f.classe, etat: f.etat, statutChantier: f.statutChantier, depuis: f.depuis, jusqua: f.jusqua };
      const { appliques, nonAppliques } = partitionnerFiltres("reseau_regions", demandes);
      res.set("Cache-Control", "no-store").json({ rapport: r, filtres: { appliques, nonAppliques }, mention: MENTION_CONSULTATIVE });
    } catch (err) { erreurInterne(next, err); }
  });

  // ---------------------------------------------------------------- export gouverné
  const gardeExport = [requireAuth, requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("rapports")];

  router.post("/exports", ...gardeExport, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const corps = schemaCorps.safeParse(req.body);
      if (!corps.success) {
        res.status(400).json({ error: "corps invalide", code: "CORPS_INVALIDE", details: corps.error.flatten() }); return;
      }
      const { type, format, scenarioId } = corps.data;
      const filtres: FiltresExport = corps.data.filtres ?? {};
      const user = req.user as CompteReq;

      const modules = await modulesAutorisesDe(user);
      if (typeNecessiteScenario(type) && !moduleAutorise(modules, "programmation")) {
        res.status(403).json({ error: "Cet export reprend des données du module Programmation, non autorisé pour votre compte", code: "MODULE_NON_AUTORISE" }); return;
      }

      const p = await calculerPortee(user, filtres.regionId);
      if (!p.ok) { res.status(p.statut).json(p.corps); return; }

      // Une ressource designee par identifiant hors perimetre ou inexistante : le MEME 404.
      if (scenarioId && typeNecessiteScenario(type)) {
        const regs = await regionsScenario(scenarioId);
        const v = verifierTerritoire(p.perimetre, regs, "lecture");
        if (regs.length === 0 || !v.ok) { res.status(404).json({ error: "scenario introuvable", code: "INTROUVABLE" }); return; }
      }

      const maintenant = d.maintenant();
      const exportId = d.nouvelId();
      // UNE seule regle pour les montants contractuels et le titulaire (D-C1-1, PROVISOIRE) : celle des lectures de chantiers, de la
      // synthese, du suivi contractuel, de l'export par selection et de l'export de scenario.
      const droitFinancier = droitMontantsContractuels(modules);
      const r = await produireExport({
        compte: { id: user.id, role: user.role, email: user.email ?? "" },
        maintenant, exportId, type, format, filtres, scenarioId: scenarioId ?? null,
        portee: p.portee,
        droits: { financier: droitFinancier, marches: droitFinancier, programmation: moduleAutorise(modules, "programmation") },
      }, d.fournisseurs);
      if (!r.ok) { res.status(r.statut).json({ error: r.error, code: r.code }); return; }

      // JOURNAL + AUDIT AVANT REMISE, dans une transaction : pas de fichier sans trace.
      await prisma.$transaction(async (tx) => {
        await tx.exportJournal.create({
          data: {
            id: exportId, type, format, auteurId: user.id, auteurEmail: user.email ?? "", auteurRole: user.role,
            filtres: r.entete.filtresAppliques as never,
            perimetre: { libelle: r.entete.perimetre.libelle, national: r.entete.perimetre.national, regionIds: r.entete.perimetre.regionIds } as never,
            nbLignes: r.nbLignes, tailleOctets: r.tailleOctets, empreinteSha256: r.empreinteSha256,
            droitFinancier: r.entete.droitFinancier, colonnesRetirees: r.colonnesRetirees as never,
          },
        });
        await logAuditTransactionnelle(tx, {
          userId: user.id, action: "CREATE", entityType: "ExportJournal", entityId: exportId,
          after: { type, format, filtres: r.entete.filtresAppliques, perimetre: r.entete.perimetre, nbLignes: r.nbLignes, empreinteSha256: r.empreinteSha256 },
          ipAddress: req.ip,
        });
      });

      res.set({
        "Content-Type": r.contentType,
        "Content-Disposition": `attachment; filename="${r.nomFichier}"`,
        "Cache-Control": "no-store",
        "X-Export-Id": exportId,
        "X-Export-Empreinte-Sha256": r.empreinteSha256,
        "X-Export-Nb-Lignes": String(r.nbLignes),
        "X-Content-Type-Options": "nosniff",
      });
      res.send(r.contenu);
    } catch (err) { erreurInterne(next, err); }
  });

  router.get("/exports", ...gardeExport, async (req, res, next) => {
    try {
      const q = schemaJournal.safeParse(req.query);
      if (!q.success) { res.status(400).json({ error: "paramètres invalides", code: "PARAMETRES_INVALIDES", details: q.error.flatten() }); return; }
      const user = req.user as CompteReq;
      // ADMIN : tout le journal. Autres : leurs propres exports (le journal dit qui a sorti quoi : il est lui-même sensible).
      const where = user.role === "ADMIN" ? {} : { auteurId: user.id };
      const [total, lignes] = await Promise.all([
        prisma.exportJournal.count({ where }),
        prisma.exportJournal.findMany({ where, orderBy: [{ creeLe: "desc" }, { id: "asc" }], take: q.data.limite, skip: q.data.decalage }),
      ]);
      res.set("Cache-Control", "no-store").json({
        total,
        data: lignes.map((l) => ({
          id: l.id, type: l.type, format: l.format, auteur: { id: l.auteurId, email: l.auteurEmail, role: l.auteurRole },
          filtres: l.filtres, perimetre: l.perimetre, nbLignes: l.nbLignes, tailleOctets: l.tailleOctets,
          empreinteSha256: l.empreinteSha256, droitFinancier: l.droitFinancier, colonnesRetirees: l.colonnesRetirees, creeLe: l.creeLe,
        })),
      });
    } catch (err) { erreurInterne(next, err); }
  });

  return router;
}

export const aideDecisionExportsRouter = creerRouteurExports();
