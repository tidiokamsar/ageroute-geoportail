import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { evaluerCriteres, calculerScore } from "../../lib/priorisation";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireRole } from "../../middleware/rbac.middleware";
import { requireModuleAccess } from "../../middleware/module-access.middleware";
import { computeAlertesContractuelles } from "./alertes.service";
import { sendAlertesEmail } from "../../jobs/alertes-contractuelles";
import {
  listHandler, getHandler, createHandler, updateHandler, deleteHandler,
  attachChantierHandler, detachChantierHandler,
  listAvancementsHandler, upsertAvancementHandler,
  listBailleursHandler, createBailleurHandler, updateBailleurHandler, deleteBailleurHandler,
} from "./marches.controller";
import {
  listHandler as listDecomptesHandler, createHandler as createDecompteHandler,
  updateHandler as updateDecompteHandler, deleteHandler as deleteDecompteHandler,
  sumByBailleurHandler,
} from "./decomptes.controller";

export const marchesRouter = Router();

// ── Helpers partagés priorisation ─────────────────────────────────────────────
//
// Trois tables de valeurs de repli ont ete SUPPRIMEES ici (T8) :
//
//   STRATEGIC_SCORE      criticite deduite de la classe de route
//   COUT_REHAB_M_PAR_KM  cout deduit de longueur x tarif au km selon l'etat
//   ETAT_SCORE           attribuait 20/100 a NON_EVALUE, faisant passer un troncon
//                        jamais evalue pour un troncon en assez bon etat
//
// Elles comblaient l'absence des trois criteres vides — trafic, criticite et cout
// sont a 0 sur les 1 690 troncons — et le resultat etait ensuite affiche au meme
// titre que l'etat reellement constate. C'est ce que le §41 interdit : presenter une
// estimation comme une donnee reelle.
//
// La logique de score vit desormais dans lib/priorisation.ts, ou elle est testee.

type ScoredTroncon = {
  tronconId: string; code: string; nom: string; region: string;
  etat: string; classe: string; longueurKm: number;
  // Valeurs brutes, nullables : l'absence doit se voir.
  traficMoyenJma: number | null;
  criticiteStrategique: number | null;
  coutRehabEstimeMd: number | null;
  /** Null quand le score n'est pas calculable. Jamais 0 : 0 serait un classement. */
  score: number | null;
  calculable: boolean;
  criteresManquants: string[];
  explication: string;
  criteres: import("../../lib/priorisation").CritereEvalue[];
};

async function computeScores(opts: {
  wEtat: number; wTrafic: number; wStrat: number; wCout: number;
  region?: string; classe?: string; limit?: number;
}): Promise<ScoredTroncon[]> {
  const { wEtat, wTrafic, wStrat, wCout, region, classe, limit = 200 } = opts;

  const notDeleted = { deletedAt: null };
  const where: Record<string, unknown> = {
    ...notDeleted,
    etat: { in: ["MAUVAIS", "CRITIQUE", "MOYEN"] },
  };
  if (region) where["region"] = { nom: region };
  if (classe) where["classe"] = classe;

  const rows = await prisma.troncon.findMany({
    where,
    select: {
      id: true, code: true, nom: true, classe: true, etat: true,
      longueurKm: true, traficMoyenJma: true,
      criticiteStrategique: true, coutRehabEstime: true,
      dateDerniereEvaluation: true,
      region: { select: { nom: true } },
    },
    take: limit,
  });

  if (rows.length === 0) return [];

  // Bornes de normalisation, calculees sur les seules valeurs REELLES. La version
  // precedente comblait les manques : le cout se derivait de longueur x tarif au km
  // choisi selon l'etat, et la criticite d'une valeur deduite de la classe de route.
  // Ces deux estimations etaient ensuite presentees a l'ecran au meme titre que
  // l'etat reellement constate — ce que le §41 interdit.
  const traficMax = Math.max(0, ...rows.map((r) => r.traficMoyenJma ?? 0));
  const coutMax = Math.max(0, ...rows.map((r) => (r.coutRehabEstime != null ? Number(r.coutRehabEstime) : 0)));

  const poids = { etat: wEtat, trafic: wTrafic, criticite: wStrat, cout: wCout };

  return rows.map((r) => {
    const criteres = evaluerCriteres(
      {
        etat: r.etat,
        traficMoyenJma: r.traficMoyenJma,
        criticiteStrategique: r.criticiteStrategique,
        coutRehabEstime: r.coutRehabEstime != null ? Number(r.coutRehabEstime) : null,
        dateDerniereEvaluation: r.dateDerniereEvaluation ?? null,
      },
      poids,
      { traficMax, coutMax }
    );
    const resultat = calculerScore(criteres);

    return {
      tronconId: r.id, code: r.code, nom: r.nom,
      region: r.region?.nom ?? "—",
      etat: r.etat, classe: r.classe,
      longueurKm: r.longueurKm,
      traficMoyenJma: r.traficMoyenJma,
      criticiteStrategique: r.criticiteStrategique,
      coutRehabEstimeMd: r.coutRehabEstime != null ? Number(r.coutRehabEstime) : null,
      // null, jamais 0 : un 0 se lirait comme « le moins prioritaire ».
      score: resultat.score,
      calculable: resultat.calculable,
      criteresManquants: resultat.criteresManquants,
      explication: resultat.explication,
      criteres: resultat.criteres,
    };
  }).sort((a, b) => {
    // Les troncons non classables vont en fin de liste plutot que d'etre melanges
    // aux scores : ils ne valent pas « zero », ils ne se comparent pas.
    if (a.score == null && b.score == null) return 0;
    if (a.score == null) return 1;
    if (b.score == null) return -1;
    return b.score - a.score;
  });
}

// ── GET /priorisation/scores ───────────────────────────────────────────────────

marchesRouter.get("/priorisation/scores", requireAuth, requireModuleAccess("decision"), async (req, res, next) => {
  try {
    const {
      poids_etat = "35", poids_trafic = "25", poids_strategique = "20", poids_cout = "20",
      region, classe, limit = "100",
    } = req.query as Record<string, string>;

    const wE = Math.max(0, Number(poids_etat));
    const wT = Math.max(0, Number(poids_trafic));
    const wS = Math.max(0, Number(poids_strategique));
    const wC = Math.max(0, Number(poids_cout));

    const resultats = await computeScores({
      wEtat: wE, wTrafic: wT, wStrat: wS, wCout: wC,
      region: region as string | undefined,
      classe: classe as string | undefined,
      limit: Math.min(Number(limit), 500),
    });

    res.json({
      ponderation: { etat: wE, trafic: wT, strategique: wS, cout: wC },
      resultats,
    });
  } catch (err) { next(err); }
});

// ── POST /simulateur/budget ────────────────────────────────────────────────────

marchesRouter.post("/simulateur/budget", requireAuth, requireModuleAccess("programmation"), async (req, res, next) => {
  try {
    const {
      enveloppe_md_gnf = 2000,
      ponderation = { etat: 35, trafic: 25, strategique: 20, cout: 20 },
      filtres = {},
    } = req.body as {
      enveloppe_md_gnf?: number;
      ponderation?: { etat?: number; trafic?: number; strategique?: number; cout?: number };
      filtres?: { region?: string; classe?: string };
    };

    const { etat = 35, trafic = 25, strategique = 20, cout = 20 } = ponderation;

    const scored = await computeScores({
      wEtat: etat, wTrafic: trafic, wStrat: strategique, wCout: cout,
      region: filtres.region,
      classe: filtres.classe,
      limit: 500,
    });

    // Un plan de financement suppose des couts. Le cout de rehabilitation est vide sur
    // les 1 690 troncons ; la version precedente le fabriquait — longueur x tarif au km
    // choisi selon l'etat — et rendait une selection budgetaire d'apparence solide,
    // batie sur des montants que personne n'avait etablis.
    //
    // On ne simule que sur les troncons dont le cout ET le score sont connus. Si aucun
    // ne l'est, la reponse le dit au lieu de rendre un plan vide ou invente.
    const exploitables = scored.filter(
      (t): t is typeof t & { coutRehabEstimeMd: number; score: number } =>
        t.coutRehabEstimeMd != null && t.score != null
    );

    if (exploitables.length === 0) {
      return res.status(200).json({
        enveloppe: enveloppe_md_gnf,
        simulable: false,
        motif:
          "Simulation impossible : aucun tronçon ne porte à la fois un score calculable et un coût de réhabilitation. " +
          "Le coût est absent sur les 1 690 tronçons.",
        troncons_examines: scored.length,
        troncons_exploitables: 0,
        selection: [],
      });
    }

    // Greedy knapsack — tri par score (déjà trié), sélection tant que cumul <= enveloppe
    let budgetUtilise = 0;
    let lineaireKm = 0;
    const selection = exploitables.map((t) => {
      const finance = budgetUtilise + t.coutRehabEstimeMd <= enveloppe_md_gnf;
      if (finance) {
        budgetUtilise += t.coutRehabEstimeMd;
        lineaireKm += t.longueurKm;
      }
      return {
        tronconId: t.tronconId, code: t.code, nom: t.nom, score: t.score,
        cout: parseFloat(t.coutRehabEstimeMd.toFixed(1)),
        cumul_budget: parseFloat(budgetUtilise.toFixed(1)),
        finance,
      };
    });

    const finances = selection.filter((s) => s.finance);
    const nbCritiqueBefore = exploitables.filter((t) => t.etat === "CRITIQUE").length;
    const nbCritiqueFinance = finances.filter((s) =>
      exploitables.find((t) => t.tronconId === s.tronconId)?.etat === "CRITIQUE"
    ).length;
    const impactEstime = nbCritiqueBefore > 0
      ? parseFloat(((nbCritiqueFinance / nbCritiqueBefore) * -100).toFixed(1))
      : 0;

    return res.json({
      enveloppe: enveloppe_md_gnf,
      simulable: true,
      // Rendus explicitement : une simulation portant sur 12 troncons sur 500 n'a pas
      // la meme portee qu'une simulation portant sur tout le reseau.
      troncons_examines: scored.length,
      troncons_exploitables: exploitables.length,
      budget_utilise: parseFloat(budgetUtilise.toFixed(1)),
      nb_troncons_finances: finances.length,
      lineaire_traite_km: parseFloat(lineaireKm.toFixed(1)),
      impact_estime_pct_critique: impactEstime,
      selection,
    });
  } catch (err) { return next(err); }
});

// ── Bailleurs ──────────────────────────────────────────────────────────────────

marchesRouter.get("/bailleurs", requireAuth, requireModuleAccess("marches"), listBailleursHandler);
marchesRouter.post("/bailleurs", requireAuth, requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("marches"), createBailleurHandler);
marchesRouter.put("/bailleurs/:id", requireAuth, requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("marches"), updateBailleurHandler);
marchesRouter.delete("/bailleurs/:id", requireAuth, requireRole("ADMIN"), requireModuleAccess("marches"), deleteBailleurHandler);

// ── Marchés — CRUD ───────────────────────────────────────────────────────────

marchesRouter.get("/marches", requireAuth, requireModuleAccess("marches"), listHandler);
marchesRouter.post("/marches", requireAuth, requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("marches"), createHandler);

// ── GET /marches/alertes ───────────────────────────────────────────────────────

marchesRouter.get("/marches/alertes", requireAuth, requireModuleAccess("marches"), async (_req, res, next) => {
  try {
    const alertes = await computeAlertesContractuelles();
    res.json({ total: alertes.length, alertes });
  } catch (err) { next(err); }
});

// Déclenchement manuel de l'email de synthèse (utile pour vérifier la config SMTP sans
// attendre le tick quotidien de 01h00 UTC).
marchesRouter.post("/marches/alertes/notifier", requireAuth, requireRole("ADMIN"), async (_req, res, next) => {
  try {
    await sendAlertesEmail();
    res.status(204).send();
  } catch (err) { next(err); }
});

// ── GET /marches/:id/courbe-s ──────────────────────────────────────────────────

marchesRouter.get("/marches/:id/courbe-s", requireAuth, requireModuleAccess("marches"), async (req, res, next) => {
  try {
    const marche = await prisma.marche.findUnique({
      where: { id: req.params.id },
      include: { bailleur: true, avancements: { orderBy: { periode: "asc" } } },
    });

    if (!marche) {
      res.status(404).json({ error: "Marché introuvable" });
      return;
    }

    const base = {
      marche_id: marche.id,
      intitule: marche.intitule,
      bailleur: marche.bailleur?.nom ?? null,
      statut: marche.statut,
    };

    // Données saisies manuellement
    if (marche.avancements.length > 0) {
      res.json({
        ...base,
        series: marche.avancements.map((a) => ({
          periode: a.periode.toISOString().slice(0, 7),
          physique_prevu: a.avancementPhysiquePrevu,
          physique_reel: a.avancementPhysiqueReel,
          financier_prevu: a.avancementFinancierPrevu,
          financier_reel: a.avancementFinancierReel,
        })),
      });
      return;
    }

    // Courbe en S théorique par interpolation linéaire
    const series: { periode: string; physique_prevu: number; physique_reel: number | null; financier_prevu: number }[] = [];
    if (marche.dateDebutPrevue && marche.dateFinPrevue) {
      const debut = marche.dateDebutPrevue;
      const fin = marche.dateFinPrevue;
      const now = new Date();
      const totalMs = fin.getTime() - debut.getTime();
      let cursor = new Date(Date.UTC(debut.getUTCFullYear(), debut.getUTCMonth(), 1));
      while (cursor <= fin) {
        const elapsed = Math.min(cursor.getTime() - debut.getTime(), totalMs);
        const pct = totalMs > 0 ? Math.max(0, Math.min(100, (elapsed / totalMs) * 100)) : 0;
        series.push({
          periode: cursor.toISOString().slice(0, 7),
          physique_prevu: parseFloat(pct.toFixed(1)),
          physique_reel: cursor <= now ? null : null,
          financier_prevu: parseFloat((pct * 0.9).toFixed(1)),
        });
        cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
      }
    }

    res.json({ ...base, series });
  } catch (err) { next(err); }
});

// ── Liaison marché ↔ chantiers ──────────────────────────────────────────────────

marchesRouter.post("/marches/:id/chantiers", requireAuth, requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("marches"), attachChantierHandler);
marchesRouter.delete("/marches/:id/chantiers/:chantierId", requireAuth, requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("marches"), detachChantierHandler);

// ── Avancement mensuel (courbe en S) ────────────────────────────────────────────

marchesRouter.get("/marches/:id/avancement", requireAuth, requireModuleAccess("marches"), listAvancementsHandler);
marchesRouter.post("/marches/:id/avancement", requireAuth, requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("marches"), upsertAvancementHandler);

// ── Décaissements (décomptes) ───────────────────────────────────────────────────

marchesRouter.get("/decaissements/par-bailleur", requireAuth, requireModuleAccess("marches"), sumByBailleurHandler);
marchesRouter.get("/marches/:id/decomptes", requireAuth, requireModuleAccess("marches"), listDecomptesHandler);
marchesRouter.post("/marches/:id/decomptes", requireAuth, requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("marches"), createDecompteHandler);
marchesRouter.put("/decomptes/:decompteId", requireAuth, requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("marches"), updateDecompteHandler);
marchesRouter.delete("/decomptes/:decompteId", requireAuth, requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("marches"), deleteDecompteHandler);

// ── Marché — un seul (doit rester après les routes littérales /marches/alertes etc.) ──

marchesRouter.get("/marches/:id", requireAuth, requireModuleAccess("marches"), getHandler);
marchesRouter.put("/marches/:id", requireAuth, requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("marches"), updateHandler);
marchesRouter.delete("/marches/:id", requireAuth, requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("marches"), deleteHandler);
