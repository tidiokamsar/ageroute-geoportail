import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireModuleAccess } from "../../middleware/module-access.middleware";
import { longueurReseau } from "../../lib/reseau";

export const dashboardRouter = Router();

dashboardRouter.get("/kpis", requireAuth, requireModuleAccess("dashboard"), async (_req, res, next) => {
  try {
    const notDeleted = { deletedAt: null };

    const [
      tronconsCount,
      ouvragesCount,
      pointsNoirsCount,
      postesCount,
      documentsCount,
      chantiersEnCours,
      tronconsParEtat,
      ouvragesParEtat,
      chantiersParStatut,
      longueurTotale,
      alertesTroncons,
      alertesOuvrages,
      reseau,
    ] = await Promise.all([
      prisma.troncon.count({ where: notDeleted }),
      prisma.ouvrage.count({ where: notDeleted }),
      prisma.pointNoir.count({ where: notDeleted }),
      prisma.poste.count({ where: notDeleted }),
      prisma.document.count({ where: notDeleted }),
      prisma.chantier.count({ where: { ...notDeleted, statut: "EN_COURS" } }),
      prisma.troncon.groupBy({ by: ["etat"], where: notDeleted, _count: { _all: true } }),
      prisma.ouvrage.groupBy({ by: ["etat"], where: notDeleted, _count: { _all: true } }),
      prisma.chantier.groupBy({ by: ["statut"], where: notDeleted, _count: { _all: true } }),
      prisma.troncon.aggregate({ where: notDeleted, _sum: { longueurKm: true } }),
      prisma.troncon.count({ where: { ...notDeleted, etat: { in: ["MAUVAIS", "CRITIQUE"] } } }),
      prisma.ouvrage.count({ where: { ...notDeleted, etat: { in: ["MAUVAIS", "CRITIQUE"] } } }),
      longueurReseau(),
    ]);

    res.json({
      tronconsCount,
      ouvragesCount,
      pointsNoirsCount,
      postesCount,
      documentsCount,
      chantiersEnCours,
      // Conserve pour ne pas casser les clients existants. C'est la longueur SAISIE,
      // pas la longueur du reseau : `reseau` ci-dessous porte la distinction.
      longueurTotaleKm: longueurTotale._sum.longueurKm ?? 0,
      // La longueur saisie et la longueur calculee, separees et ventilees par classe.
      // L'ecart — 7 933 km contre 21 156 — ne vient pas d'une donnee abimee mais d'un
      // champ jamais renseigne sur les 1 029 regionales. Voir lib/reseau.ts.
      reseau,
      alertesCount: alertesTroncons + alertesOuvrages,
      tronconsParEtat: tronconsParEtat.map((r) => ({ etat: r.etat, total: r._count._all })),
      ouvragesParEtat: ouvragesParEtat.map((r) => ({ etat: r.etat, total: r._count._all })),
      chantiersParStatut: chantiersParStatut.map((r) => ({ statut: r.statut, total: r._count._all })),
    });
  } catch (err) {
    next(err);
  }
});

// Flux d'activite recente (qui a fait quoi) pour donner un vrai air de "tableau de
// bord" vivant a la page d'accueil, plutot que des stats figees.
dashboardRouter.get("/activity", requireAuth, requireModuleAccess("dashboard"), async (_req, res, next) => {
  try {
    const rows = await prisma.auditLog.findMany({
      include: { user: { select: { nomComplet: true } } },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    res.json(
      rows.map((r) => ({
        id: r.id,
        action: r.action,
        entityType: r.entityType,
        auteur: r.user?.nomComplet ?? "Système",
        createdAt: r.createdAt,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// Alertes operationnelles : transforme l'inventaire passif en outil de pilotage en
// remontant ce qui demande une action concrete (priorise par gravite/retard).
dashboardRouter.get("/alertes", requireAuth, requireModuleAccess("alertes"), async (_req, res, next) => {
  try {
    const notDeleted = { deletedAt: null };
    const now = new Date();

    const [ouvragesCritiques, chantiersEnRetard, tronconsCritiquesNonInspectes, tronconsJamaisInspectes] = await Promise.all([
      // Ouvrages d'art en mauvais/critique : risque structurel direct.
      prisma.ouvrage.findMany({
        where: { ...notDeleted, etat: { in: ["MAUVAIS", "CRITIQUE"] } },
        select: { id: true, code: true, nom: true, etat: true, derniereInspectionDate: true, region: { select: { nom: true } }, troncon: { select: { code: true } } },
        orderBy: { etat: "desc" },
        take: 50,
      }),
      // Chantiers en cours dont la date de fin prevue est depassee.
      prisma.chantier.findMany({
        where: { ...notDeleted, statut: "EN_COURS", dateFinPrevue: { lt: now } },
        select: { id: true, intitule: true, dateFinPrevue: true, avancementPct: true, entreprise: true, region: { select: { nom: true } } },
        orderBy: { dateFinPrevue: "asc" },
        take: 50,
      }),
      // Troncons mauvais/critiques sans inspection : etat connu mais jamais formellement constate.
      prisma.troncon.findMany({
        where: { ...notDeleted, etat: { in: ["MAUVAIS", "CRITIQUE"] }, inspections: { none: {} } },
        select: { id: true, code: true, nom: true, etat: true, classe: true, longueurKm: true, region: { select: { nom: true } } },
        orderBy: { etat: "desc" },
        take: 50,
      }),
      // Tous les troncons sans aucune inspection (toutes classes confondues) : couverture terrain a combler.
      prisma.troncon.findMany({
        where: { ...notDeleted, inspections: { none: {} } },
        select: { id: true, code: true, nom: true, etat: true, classe: true, longueurKm: true, region: { select: { nom: true } } },
        orderBy: [{ etat: "desc" }, { longueurKm: "desc" }],
        take: 100,
      }),
    ]);

    res.json({
      ouvragesCritiques: ouvragesCritiques.map((o) => ({
        id: o.id, code: o.code ?? null, nom: o.nom, etat: o.etat, region: o.region?.nom ?? null,
        troncon: o.troncon?.code ?? null, derniereInspection: o.derniereInspectionDate,
      })),
      chantiersEnRetard: chantiersEnRetard.map((c) => ({
        id: c.id, intitule: c.intitule, dateFinPrevue: c.dateFinPrevue,
        avancementPct: c.avancementPct, entreprise: c.entreprise, region: c.region?.nom ?? null,
      })),
      tronconsCritiquesNonInspectes: tronconsCritiquesNonInspectes.map((t) => ({
        id: t.id, code: t.code, nom: t.nom, etat: t.etat, classe: t.classe, longueurKm: t.longueurKm, region: t.region?.nom ?? null,
      })),
      tronconsJamaisInspectes: tronconsJamaisInspectes.map((t) => ({
        id: t.id, code: t.code, nom: t.nom, etat: t.etat, classe: t.classe, longueurKm: t.longueurKm, region: t.region?.nom ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Synthese par region pour les rapports : etat du reseau + activite, agrege cote serveur.
dashboardRouter.get("/rapport-regions", requireAuth, requireModuleAccess("rapports"), async (_req, res, next) => {
  try {
    const regions = await prisma.region.findMany({ orderBy: { nom: "asc" } });
    const notDeleted = { deletedAt: null };

    const lignes = await Promise.all(
      regions.map(async (r) => {
        const [troncons, longueur, ouvrages, chantiersEnCours, parEtat] = await Promise.all([
          prisma.troncon.count({ where: { ...notDeleted, regionId: r.id } }),
          prisma.troncon.aggregate({ where: { ...notDeleted, regionId: r.id }, _sum: { longueurKm: true } }),
          prisma.ouvrage.count({ where: { ...notDeleted, regionId: r.id } }),
          prisma.chantier.count({ where: { ...notDeleted, regionId: r.id, statut: "EN_COURS" } }),
          prisma.troncon.groupBy({ by: ["etat"], where: { ...notDeleted, regionId: r.id }, _sum: { longueurKm: true } }),
        ]);
        const km = (etat: string) => parEtat.find((e) => e.etat === etat)?._sum.longueurKm ?? 0;
        return {
          region: r.nom,
          troncons,
          longueurKm: longueur._sum.longueurKm ?? 0,
          ouvrages,
          chantiersEnCours,
          kmBon: km("BON"),
          kmMoyen: km("MOYEN"),
          kmMauvais: km("MAUVAIS"),
          kmCritique: km("CRITIQUE"),
          kmNonEvalue: km("NON_EVALUE"),
        };
      })
    );

    res.json(lignes.filter((l) => l.troncons > 0 || l.ouvrages > 0));
  } catch (err) {
    next(err);
  }
});

// ── Module Aide à la Décision ─────────────────────────────────────────────────
// Endpoint unique qui alimente les 4 onglets du module décisionnel : KPIs exécutifs,
// tronçons à prioriser (avec métadonnées pour score multicritère), chantiers pour
// la courbe en S et les alertes contractuelles, répartition budgétaire par bailleur.
dashboardRouter.get("/decision", requireAuth, requireModuleAccess("decision"), async (_req, res, next) => {
  try {
    const notDeleted = { deletedAt: null };
    const now = new Date();

    const [longueurAgg, etatsRaw, tronconsRaw, chantiersRaw, parBailleurRaw, budgetRow] = await Promise.all([
      prisma.troncon.aggregate({ where: notDeleted, _sum: { longueurKm: true } }),
      prisma.troncon.groupBy({ by: ["etat"], where: notDeleted, _sum: { longueurKm: true }, _count: { _all: true } }),
      prisma.troncon.findMany({
        where: { ...notDeleted, etat: { in: ["MAUVAIS", "CRITIQUE"] } },
        select: { id: true, code: true, nom: true, classe: true, etat: true, longueurKm: true, traficMoyenJma: true, region: { select: { nom: true } } },
        orderBy: [{ etat: "desc" }, { longueurKm: "desc" }],
        take: 100,
      }),
      prisma.chantier.findMany({
        where: { ...notDeleted, statut: { in: ["EN_COURS", "PLANIFIE", "SUSPENDU"] } },
        select: { id: true, intitule: true, avancementPct: true, dateDebutPrevue: true, dateFinPrevue: true, dateDebutReelle: true, montantGnf: true, statut: true, entreprise: true, bailleur: true, region: { select: { nom: true } } },
        orderBy: { montantGnf: "desc" },
        take: 50,
      }),
      prisma.$queryRaw<{ bailleur: string; nb: bigint; montant: string }[]>`
        SELECT COALESCE(NULLIF(bailleur,''),'Non renseigné') AS bailleur,
               count(*) AS nb,
               COALESCE(SUM("montantGnf"),0)::text AS montant
        FROM chantiers WHERE "deletedAt" IS NULL
        GROUP BY 1 ORDER BY SUM("montantGnf") DESC NULLS LAST LIMIT 8`,
      prisma.$queryRaw<{ montant: string; nb: bigint }[]>`
        SELECT COALESCE(SUM("montantGnf"),0)::text AS montant, count(*) AS nb
        FROM chantiers WHERE "deletedAt" IS NULL`,
    ]);

    const longueur = longueurAgg._sum.longueurKm ?? 0;
    const etatMap = Object.fromEntries(etatsRaw.map((e) => [e.etat, { km: e._sum.longueurKm ?? 0, nb: e._count._all }]));
    const kmOf = (e: string) => etatMap[e]?.km ?? 0;
    const pct = (e: string) => longueur > 0 ? parseFloat(((kmOf(e) / longueur) * 100).toFixed(1)) : 0;

    // Baremes d'ESTIMATION, et rien d'autre (T8).
    //
    // Ces deux tables produisent des valeurs plausibles la ou la base est vide : le
    // cout de rehabilitation et la criticite strategique sont a 0 sur les 1 690
    // troncons. Elles etaient auparavant servies sous les noms `strategicScore` et
    // `montantRehabEstimeMd`, sans rien qui les distingue d'une donnee relevee, puis
    // ponderees dans le score au meme titre que l'etat reellement constate.
    //
    // Elles restent utiles — un ordre de grandeur vaut mieux que rien pour degrossir —
    // mais elles portent desormais le suffixe `Estime` et un drapeau explicite. Le
    // client doit pouvoir dire a l'utilisateur d'ou vient chaque chiffre.
    const COUT_REHAB_ESTIME_M_PAR_KM: Record<string, number> = { CRITIQUE: 800, MAUVAIS: 500, MOYEN: 150, BON: 0, NON_EVALUE: 200 };
    const CRITICITE_ESTIMEE_PAR_CLASSE: Record<string, number> = { RN: 90, RR: 70, RU: 50, PISTE: 30 };

    const tronconsPrio = tronconsRaw.map((t) => ({
      id: t.id, code: t.code, nom: t.nom,
      region: t.region?.nom ?? "—",
      etat: t.etat, classe: t.classe,
      longueurKm: t.longueurKm ?? 0,
      // Valeurs REELLES : null quand elles manquent, jamais 0. Un 0 se lirait comme
      // « aucun trafic », alors qu'il signifie « aucun comptage ».
      traficMoyenJma: t.traficMoyenJma,
      criticiteStrategique: null as number | null,
      coutRehabEstime: null as number | null,
      // Valeurs ESTIMEES, clairement nommees comme telles.
      criticiteEstimee: CRITICITE_ESTIMEE_PAR_CLASSE[t.classe] ?? 50,
      montantRehabEstimeMd: ((t.longueurKm ?? 0) * (COUT_REHAB_ESTIME_M_PAR_KM[t.etat] ?? 200)) / 1000,
      estimations: {
        criticite: "déduite de la classe de route, non renseignée en base",
        cout: "longueur × tarif au km selon l'état, non renseigné en base",
      },
      // Ce que le client doit savoir pour ne pas presenter un classement comme fonde.
      criteresReels: {
        etat: t.etat !== "NON_EVALUE",
        trafic: t.traficMoyenJma != null,
        criticite: false,
        cout: false,
      },
    }));

    const chantiersDecision = chantiersRaw.map((c) => {
      const enRetard = c.statut === "EN_COURS" && !!c.dateFinPrevue && new Date(c.dateFinPrevue) < now;
      // Avancement prévu : interpolation linéaire entre dateDebut et dateFin
      let avancementPrevu = 0;
      if (c.dateDebutPrevue && c.dateFinPrevue) {
        const debut = new Date(c.dateDebutReelle ?? c.dateDebutPrevue).getTime();
        const fin = new Date(c.dateFinPrevue).getTime();
        const elapsed = now.getTime() - debut;
        const total = fin - debut;
        avancementPrevu = total > 0 ? Math.min(100, Math.round((elapsed / total) * 100)) : 0;
      }
      return {
        id: c.id, intitule: c.intitule, avancementPct: c.avancementPct,
        avancementPrevu, enRetard, statut: c.statut,
        entreprise: c.entreprise ?? "—",
        bailleur: c.bailleur ?? "Non renseigné",
        region: c.region?.nom ?? "—",
        dateDebutPrevue: c.dateDebutPrevue,
        dateFinPrevue: c.dateFinPrevue,
        montantGnf: c.montantGnf?.toString() ?? "0",
      };
    });

    res.json({
      kpis: {
        longueurTotaleKm: Math.round(longueur),
        kmCritique: Math.round(kmOf("CRITIQUE")),
        kmMauvais: Math.round(kmOf("MAUVAIS")),
        pctCritique: pct("CRITIQUE"),
        pctMauvais: pct("MAUVAIS"),
        chantiersEnCours: chantiersRaw.filter((c) => c.statut === "EN_COURS").length,
        chantiersEnRetard: chantiersRaw.filter((c) => c.statut === "EN_COURS" && !!c.dateFinPrevue && new Date(c.dateFinPrevue) < now).length,
        budgetTotal: budgetRow[0]?.montant ?? "0",
        marcheTotal: Number(budgetRow[0]?.nb ?? 0),
      },
      etatsActuels: { BON: pct("BON"), MOYEN: pct("MOYEN"), MAUVAIS: pct("MAUVAIS"), CRITIQUE: pct("CRITIQUE"), NON_EVALUE: pct("NON_EVALUE") },
      tronconsPrio,
      chantiersDecision,
      parBailleur: parBailleurRaw.map((r) => ({ bailleur: r.bailleur, nb: Number(r.nb), montant: r.montant })),
    });
  } catch (err) { next(err); }
});

// Programmation budgetaire : agregation des chantiers (montants de marche) par annee et
// par source de financement. Les montants (BigInt GNF) sont renvoyes en chaine pour eviter
// toute perte de precision JS. Inspire du volet "Programmation" de l'observatoire de ref.
dashboardRouter.get("/programmation", requireAuth, requireModuleAccess("programmation"), async (_req, res, next) => {
  try {
    const parAnnee = await prisma.$queryRaw<{ annee: number; nb: bigint; montant: string; enCours: bigint; termine: bigint }[]>`
      SELECT EXTRACT(YEAR FROM "dateDebutPrevue")::int AS annee,
             count(*) AS nb,
             COALESCE(SUM("montantGnf"), 0)::text AS montant,
             count(*) FILTER (WHERE statut = 'EN_COURS') AS "enCours",
             count(*) FILTER (WHERE statut = 'TERMINE') AS termine
      FROM chantiers
      WHERE "deletedAt" IS NULL AND "dateDebutPrevue" IS NOT NULL
      GROUP BY annee ORDER BY annee DESC
    `;

    const parBailleur = await prisma.$queryRaw<{ bailleur: string; nb: bigint; montant: string }[]>`
      SELECT COALESCE(NULLIF(bailleur, ''), 'Non renseigné') AS bailleur,
             count(*) AS nb,
             COALESCE(SUM("montantGnf"), 0)::text AS montant
      FROM chantiers
      WHERE "deletedAt" IS NULL
      GROUP BY 1 ORDER BY SUM("montantGnf") DESC NULLS LAST
    `;

    const [montantTotal] = await prisma.$queryRaw<{ montant: string; nb: bigint }[]>`
      SELECT COALESCE(SUM("montantGnf"), 0)::text AS montant, count(*) AS nb
      FROM chantiers WHERE "deletedAt" IS NULL
    `;

    res.json({
      parAnnee: parAnnee.map((r) => ({
        annee: r.annee, nb: Number(r.nb), montant: r.montant,
        enCours: Number(r.enCours), termine: Number(r.termine),
      })),
      parBailleur: parBailleur.map((r) => ({ bailleur: r.bailleur, nb: Number(r.nb), montant: r.montant })),
      total: { nb: Number(montantTotal.nb), montant: montantTotal.montant },
    });
  } catch (err) {
    next(err);
  }
});

// Référentiel de programmation : détail ligne-par-ligne des "marchés" (en réalité des
// chantiers porteurs d'un montant budgétaire) qui alimentent les agrégats de /programmation.
// Permet de descendre du chiffre global (488 marchés) jusqu'à la ligne individuelle.
dashboardRouter.get("/programmation/lignes", requireAuth, requireModuleAccess("programmation"), async (req, res, next) => {
  try {
    const { annee, bailleur, statut, page = "1", pageSize = "20" } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const size = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 20));

    const where: Record<string, unknown> = { deletedAt: null };
    if (annee) {
      const y = Number(annee);
      where["dateDebutPrevue"] = { gte: new Date(Date.UTC(y, 0, 1)), lt: new Date(Date.UTC(y + 1, 0, 1)) };
    }
    if (bailleur) where["bailleur"] = bailleur === "Non renseigné" ? { in: [null, ""] } : bailleur;
    if (statut) where["statut"] = statut;

    const [total, rows] = await Promise.all([
      prisma.chantier.count({ where }),
      prisma.chantier.findMany({
        where,
        select: {
          id: true, intitule: true, entreprise: true, bailleur: true, montantGnf: true,
          statut: true, avancementPct: true, dateDebutPrevue: true, dateFinPrevue: true,
          region: { select: { nom: true } }, troncon: { select: { code: true } },
        },
        orderBy: { dateDebutPrevue: "desc" },
        skip: (pageNum - 1) * size,
        take: size,
      }),
    ]);

    res.json({
      data: rows.map((r) => ({
        id: r.id, intitule: r.intitule, entreprise: r.entreprise,
        bailleur: r.bailleur || "Non renseigné",
        montantGnf: r.montantGnf?.toString() ?? "0",
        statut: r.statut, avancementPct: r.avancementPct,
        dateDebutPrevue: r.dateDebutPrevue, dateFinPrevue: r.dateFinPrevue,
        region: r.region?.nom ?? "—", troncon: r.troncon?.code ?? null,
      })),
      total, page: pageNum, pageSize: size, totalPages: Math.ceil(total / size) || 1,
    });
  } catch (err) {
    next(err);
  }
});

// Tendances historiques du réseau — lit indicateurs_reseau_historique.
// Si la table est vide (aucun snapshot encore), renvoie un tableau vide sans erreur.
dashboardRouter.get("/tendances", requireAuth, requireModuleAccess("rapports"), async (req, res, next) => {
  try {
    const { periode_debut, periode_fin } = req.query as { periode_debut?: string; periode_fin?: string };

    const where: Record<string, unknown> = {};
    if (periode_debut) where["periode"] = { ...(where["periode"] as object ?? {}), gte: new Date(periode_debut) };
    if (periode_fin)   where["periode"] = { ...(where["periode"] as object ?? {}), lte: new Date(periode_fin) };

    const rows = await prisma.indicateurReseauHistorique.findMany({
      where,
      orderBy: { periode: "asc" },
    });

    res.json(
      rows.map((r) => ({
        periode: r.periode.toISOString().slice(0, 7), // "YYYY-MM"
        pctBon: r.pctBon,
        pctMoyen: r.pctMoyen,
        pctMauvais: r.pctMauvais,
        pctCritique: r.pctCritique,
        pctNonEvalue: r.pctNonEvalue,
        lineaireTraiteKm: r.lineaireTraiteKm,
        budgetEngageCumul: r.budgetEngageCumul.toString(),
        budgetDecaisseCumul: r.budgetDecaisseCumul.toString(),
      }))
    );
  } catch (err) {
    next(err);
  }
});
