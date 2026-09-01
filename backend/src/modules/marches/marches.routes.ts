import { Router } from "express";
import { prisma } from "../../lib/prisma";
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

const ETAT_SCORE: Record<string, number> = { CRITIQUE: 100, MAUVAIS: 70, MOYEN: 40, BON: 10, NON_EVALUE: 20 };
const STRATEGIC_SCORE: Record<string, number> = { RN: 90, RR: 70, RU: 50, PISTE: 30 };
const COUT_REHAB_M_PAR_KM: Record<string, number> = { CRITIQUE: 800, MAUVAIS: 500, MOYEN: 150, BON: 0, NON_EVALUE: 200 };

function normalize(values: number[]): Map<number, number> {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  return new Map(values.map((v, i) => [i, ((v - min) / range) * 100]));
}

type ScoredTroncon = {
  tronconId: string; code: string; nom: string; region: string;
  etat: string; classe: string; longueurKm: number;
  traficMoyenJma: number; criticiteStrategique: number; coutRehabEstimeMd: number;
  score: number;
  detail: { etat: number; trafic: number; strategique: number; cout: number };
};

async function computeScores(opts: {
  wEtat: number; wTrafic: number; wStrat: number; wCout: number;
  region?: string; classe?: string; limit?: number;
}): Promise<ScoredTroncon[]> {
  const { wEtat, wTrafic, wStrat, wCout, region, classe, limit = 200 } = opts;
  const total = wEtat + wTrafic + wStrat + wCout || 1;

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
      region: { select: { nom: true } },
    },
    take: limit,
  });

  if (rows.length === 0) return [];

  // Normalisation min-max sur le sous-ensemble
  const trafics = rows.map((r) => r.traficMoyenJma ?? 0);
  const couts   = rows.map((r) =>
    r.coutRehabEstime != null
      ? Number(r.coutRehabEstime)
      : ((r.longueurKm ?? 0) * (COUT_REHAB_M_PAR_KM[r.etat] ?? 200)) / 1000
  );
  const traficNorm = normalize(trafics);
  const coutNorm   = normalize(couts);

  return rows.map((r, i) => {
    const sEtat = ETAT_SCORE[r.etat] ?? 20;
    const sTrafic = traficNorm.get(i) ?? 0;
    const sStrat = r.criticiteStrategique ?? (STRATEGIC_SCORE[r.classe] ?? 50);
    const sCout = coutNorm.get(i) ?? 0;
    const score = parseFloat(
      ((sEtat * wEtat + sTrafic * wTrafic + sStrat * wStrat + sCout * wCout) / total).toFixed(1)
    );
    return {
      tronconId: r.id, code: r.code, nom: r.nom,
      region: r.region?.nom ?? "—",
      etat: r.etat, classe: r.classe,
      longueurKm: r.longueurKm,
      traficMoyenJma: r.traficMoyenJma ?? 0,
      criticiteStrategique: sStrat,
      coutRehabEstimeMd: couts[i],
      score,
      detail: {
        etat: Math.round(sEtat),
        trafic: Math.round(sTrafic),
        strategique: Math.round(sStrat),
        cout: Math.round(sCout),
      },
    };
  }).sort((a, b) => b.score - a.score);
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

    // Greedy knapsack — tri par score (déjà trié), sélection tant que cumul <= enveloppe
    let budgetUtilise = 0;
    let lineaireKm = 0;
    const selection = scored.map((t) => {
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
    const nbCritiqueBefore = scored.filter((t) => t.etat === "CRITIQUE").length;
    const nbCritiqueFinance = finances.filter((s) =>
      scored.find((t) => t.tronconId === s.tronconId)?.etat === "CRITIQUE"
    ).length;
    const impactEstime = nbCritiqueBefore > 0
      ? parseFloat(((nbCritiqueFinance / nbCritiqueBefore) * -100).toFixed(1))
      : 0;

    res.json({
      enveloppe: enveloppe_md_gnf,
      budget_utilise: parseFloat(budgetUtilise.toFixed(1)),
      nb_troncons_finances: finances.length,
      lineaire_traite_km: parseFloat(lineaireKm.toFixed(1)),
      impact_estime_pct_critique: impactEstime,
      selection,
    });
  } catch (err) { next(err); }
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
