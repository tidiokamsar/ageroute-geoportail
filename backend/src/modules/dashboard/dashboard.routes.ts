import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireModuleAccess } from "../../middleware/module-access.middleware";
import { Prisma } from "@prisma/client";
import { longueurReseau, WHERE_RESEAU_CLASSE } from "../../lib/reseau";
import { estimerPourDecision } from "../../engines/decision.estimation";
import type { LigneBareme } from "../../engines/cout.noyau";
import { REGISTRE } from "../../tableau-de-bord/indicateurs.registre";
import { evaluer } from "../../tableau-de-bord/tableau-de-bord.service";
import { filtreRegion, regionsVisibles } from "../../territoire/territoire.lecture";
import type { NextFunction, Request, Response } from "express";

/**
 * Le reseau classe : tout sauf les troncons issus de la promotion de voirie.
 *
 * Le IS NULL n'est pas decoratif — les 1 690 troncons anterieurs n'ont pas de
 * `sourceReference`, et un simple `not: { startsWith }` les exclurait tous.
 */
/**
 * L'inventaire de reference des ouvrages : tout sauf les franchissements repris d'une
 * source externe. Meme raison que pour les troncons — 963 ponts repris noieraient les
 * 126 inventories par AGEROUTE, et « ouvrages d'art » cesserait de designer ce que
 * l'agence a visite.
 */
const INVENTAIRE_REFERENCE: Prisma.OuvrageWhereInput = {
  OR: [
    { sourceReference: null },
    { sourceReference: { not: { startsWith: "ouvrage_osm:" } } },
  ],
};

/** Importe plutot que recopie : le predicat vit dans lib/reseau.ts, une seule fois. */
const RESEAU_REFERENCE: Prisma.TronconWhereInput = WHERE_RESEAU_CLASSE;

export const dashboardRouter = Router();

/**
 * PERIMETRE TERRITORIAL DES ROUTES HERITEES DE L'AIDE A LA DECISION (lot AD-7, constat 3).
 *
 * `/decision`, `/programmation` et `/tendances` rendent des TOTAUX NATIONAUX sans colonne de region exploitable (agregats SQL
 * sur tous les chantiers, instantanes nationaux de l'historique). Les filtrer par region demanderait de reecrire leurs
 * requetes ; or ces routes sont DEPRECIEES (l'ecran n'en depend plus : CONTRAT-AD.md, section 4). Le choix le plus simple et le
 * plus sur est de les REFUSER aux comptes regionaux, plutot que de leur servir un total national. Un compte national
 * (ADMIN, ou sans rattachement regional) garde exactement le comportement d'avant.
 *
 * `/programmation/lignes` et `/rapport-regions` ont une region par ligne : elles sont FILTREES (regions du compte), pas refusees.
 * La region est relue en base a chaque requete (`regionsVisibles`), comme les modules : un rattachement retire s'applique tout de suite.
 */
const nationalSeulement = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if ((await regionsVisibles(req.user!)) !== null) {
      res.status(403).json({
        error: "Cette vue agrège des totaux nationaux : elle n'est pas disponible pour un compte rattaché à une région.",
        code: "PERIMETRE_NATIONAL_REQUIS",
      });
      return;
    }
    next();
  } catch (err) { next(err); }
};

const ANNEE = /^\d{4}$/;
const STATUTS_CHANTIER = ["PLANIFIE", "EN_COURS", "SUSPENDU", "TERMINE"] as const;
/** Une date ISO complete ou partielle (AAAA-MM-JJ, AAAA-MM) qui designe un jour qui existe ; sinon `null`. */
function dateIso(v: string): Date | null {
  if (!/^\d{4}-\d{2}(-\d{2})?(T[\d:.]+Z?)?$/.test(v)) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  // new Date("2026-02-31") deborde silencieusement sur mars dans certains moteurs : on relit le jour.
  const [a, m, j] = v.slice(0, 10).split("-").map(Number);
  if (j !== undefined && (d.getUTCFullYear() !== a || d.getUTCMonth() + 1 !== m || d.getUTCDate() !== j)) return null;
  return d;
}

dashboardRouter.get("/kpis", requireAuth, requireModuleAccess("dashboard"), async (_req, res, next) => {
  try {
    const notDeleted = { deletedAt: null };

    // LES NOMBRES PARTAGES VIENNENT DU REGISTRE (A12). Chacun a son perimetre et sa requete de
    // controle, rapprochees par le banc d'integration et par GET /api/v2/tableau-de-bord/controle :
    // le chiffre affiche ici est celui qui est controle, pas une seconde implementation. Cette route
    // reste NATIONALE (comportement v1 conserve) ; le filtrage par region est celui des routes v2.
    const registre = await evaluer(prisma, REGISTRE, { regions: null, maintenant: new Date() }, {
      codes: ["troncons_classes", "ouvrages_inventories", "points_noirs", "postes", "documents", "chantiers_en_cours",
        "troncons_mauvais_critique", "ouvrages_mauvais_critique", "portions_validees", "portions_validees_km"],
      // Cette route n'affiche pas « aucune donnee » : inutile d'interroger les tables sources.
      sansSource: true,
    });
    const indicateur = (code: string): number => {
      const i = registre.find((r) => r.code === code);
      // Un indicateur en erreur fait echouer la route (500) : un zero fabrique serait lu comme un constat.
      if (!i || i.statut !== "CALCULE" || typeof i.valeur !== "number") throw new Error(`Indicateur ${code} non calculable`);
      return i.valeur;
    };

    const [
      tronconsParEtat,
      ouvragesParEtat,
      chantiersParStatut,
      longueurTotale,
      reseau,
      voirieRattacheeCount,
      franchissementsRepisCount,
      qualiteParStatut,
    ] = await Promise.all([
      // Le RESEAU CLASSE, pas le registre entier. La promotion de la voirie a porte
      // `troncons` a 261 386 lignes ; compter le tout ferait annoncer 185 264 km de
      // reseau routier, c'est-a-dire les sentiers d'OpenStreetMap. Le reseau classe
      // de Guinee fait environ 21 000 km. La voirie rattachee est comptee a part,
      // plus bas, et dite explicitement.
      prisma.troncon.groupBy({ by: ["etat"], where: { ...notDeleted, ...RESEAU_REFERENCE }, _count: { _all: true } }),
      prisma.ouvrage.groupBy({ by: ["etat"], where: { ...notDeleted, ...INVENTAIRE_REFERENCE }, _count: { _all: true } }),
      prisma.chantier.groupBy({ by: ["statut"], where: notDeleted, _count: { _all: true } }),
      prisma.troncon.aggregate({ where: { ...notDeleted, ...RESEAU_REFERENCE }, _sum: { longueurKm: true } }),
      longueurReseau("reference"),
      // Compte a part : ces troncons sont au registre et doivent se voir, mais ils ne
      // sont pas le reseau classe et ne peuvent pas se fondre dans ses indicateurs.
      prisma.troncon.count({ where: { ...notDeleted, sourceReference: { startsWith: "voirie_locale:" } } }),
      prisma.ouvrage.count({ where: { ...notDeleted, sourceReference: { startsWith: "ouvrage_osm:" } } }),
      // CE QUE L'ON SAIT REELLEMENT des valeurs : observe, importe non verifie, derive, en
      // conflit, inconnu. C'est la reponse a « ces chiffres sont-ils constates ? ».
      prisma.valeurQualite.groupBy({ by: ["statut"], _count: { _all: true } }),
    ]);

    const tronconsCount = indicateur("troncons_classes");
    const ouvragesCount = indicateur("ouvrages_inventories");
    const pointsNoirsCount = indicateur("points_noirs");
    const postesCount = indicateur("postes");
    const documentsCount = indicateur("documents");
    const chantiersEnCours = indicateur("chantiers_en_cours");
    const alertesTroncons = indicateur("troncons_mauvais_critique");
    const alertesOuvrages = indicateur("ouvrages_mauvais_critique");
    // PORTIONS HOMOGENES VALIDEES : la verite de l'etat (arbitrage D6). Le tableau de bord les
    // ignorait, et annoncait donc un etat du reseau fonde sur des valeurs d'import. Le meme
    // predicat que la contrainte d'exclusion : VALIDE, non remplacee, non supprimee.
    const portionsValidees = indicateur("portions_validees");
    const kmPortionsValidees = [{ km: indicateur("portions_validees_km") }];

    res.json({
      // LE PERIMETRE, DIT D'ABORD. Chaque indicateur de cette reponse porte sur le reseau classe
      // SAISI, pas sur le reseau national annonce par les TDR de la BDR (environ 45 300 km) :
      // la base en porte 48 %. Un tableau de bord qui tairait ce denominateur ferait passer une
      // couverture partielle pour un etat du pays (paragraphe 7.12, decision D-06).
      perimetre: {
        code: "RESEAU_CLASSE_SAISI",
        libelle: "Réseau classé saisi",
        avertissement: "Les indicateurs portent sur le réseau classé saisi dans la base, pas sur le réseau national annoncé par les TDR de la BDR. La voirie rattachée est comptée à part.",
      },
      portions: {
        validees: portionsValidees,
        kmValides: Math.round(Number(kmPortionsValidees[0]?.km ?? 0) * 10) / 10,
        // Ce que les portions disent du reseau : zero portion, zero kilometre d'etat CONSTATE.
        // Le reste des indicateurs d'etat vient de `troncons.etat`, une valeur d'IMPORT.
        avertissement: portionsValidees === 0
          ? "Aucune portion validée : les états affichés sont des valeurs d'import, pas des constats de terrain."
          : null,
      },
      qualite: {
        parStatut: qualiteParStatut.map((q) => ({ statut: q.statut, total: q._count._all })),
        total: qualiteParStatut.reduce((s, q) => s + q._count._all, 0),
      },
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
      // Rendu explicite pour que l'interface puisse le dire, plutot que de laisser
      // croire que le registre se limite au reseau classe.
      voirieRattachee: {
        troncons: voirieRattacheeCount,
        ouvrages: franchissementsRepisCount,
      },
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
dashboardRouter.get("/rapport-regions", requireAuth, requireModuleAccess("rapports"), async (req, res, next) => {
  try {
    // Un compte regional ne recoit que les lignes de SES regions (une ligne par region : le filtre est exact).
    const visibles = await regionsVisibles(req.user!);
    const regions = await prisma.region.findMany({
      ...(visibles === null ? {} : { where: { id: { in: [...visibles] } } }),
      orderBy: { nom: "asc" },
    });
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
dashboardRouter.get("/decision", requireAuth, requireModuleAccess("decision"), nationalSeulement, async (_req, res, next) => {
  try {
    const notDeleted = { deletedAt: null };
    const now = new Date();

    const [longueurAgg, etatsRaw, tronconsRaw, chantiersRaw, parBailleurRaw, budgetRow, baremesRaw] = await Promise.all([
      prisma.troncon.aggregate({ where: { ...notDeleted, ...RESEAU_REFERENCE }, _sum: { longueurKm: true } }),
      prisma.troncon.groupBy({ by: ["etat"], where: notDeleted, _sum: { longueurKm: true }, _count: { _all: true } }),
      prisma.troncon.findMany({
        where: { ...notDeleted, etat: { in: ["MAUVAIS", "CRITIQUE"] } },
        select: { id: true, code: true, nom: true, classe: true, etat: true, revetement: true, longueurKm: true, traficMoyenJma: true, region: { select: { nom: true } } },
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
      // Les baremes de la BASE, et eux seuls, servent a estimer. Voir engines/decision.estimation.ts.
      prisma.baremeIntervention.findMany({ where: { actif: true } }),
    ]);

    const baremes: LigneBareme[] = baremesRaw.map((b) => ({
      id: b.id, code: b.code, familleRevetement: b.familleRevetement, etatDepart: b.etatDepart,
      typeIntervention: b.typeIntervention, coutKmGnf: b.coutKmGnf, uniteCout: b.uniteCout, devise: b.devise,
      anneeReference: b.anneeReference, largeurChausseeM: b.largeurChausseeM === null ? null : Number(b.largeurChausseeM),
      approuveLe: b.approuveLe, actif: b.actif,
    }));

    const longueur = longueurAgg._sum.longueurKm ?? 0;
    const etatMap = Object.fromEntries(etatsRaw.map((e) => [e.etat, { km: e._sum.longueurKm ?? 0, nb: e._count._all }]));
    const kmOf = (e: string) => etatMap[e]?.km ?? 0;
    const pct = (e: string) => longueur > 0 ? parseFloat(((kmOf(e) / longueur) * 100).toFixed(1)) : 0;

    // PLUS AUCUN BAREME CODE EN DUR. Cette route portait deux tarifs inventes -- 800/500/150
    // millions GNF par km selon l'etat, et une criticite de 90/70/50/30 selon la classe -- qui
    // contredisaient les neuf baremes de la base (3,5 milliards/km pour une reconstruction
    // bitume). Le moteur de cout les remplace, et il REFUSE quand aucune ligne ne couvre le cas :
    // le montant est alors nul, avec son motif, au lieu d'un chiffre plausible. Voir
    // engines/decision.estimation.ts.
    const tronconsPrio = tronconsRaw.map((t) => ({
      id: t.id, code: t.code, nom: t.nom,
      region: t.region?.nom ?? "—",
      etat: t.etat, classe: t.classe, revetement: t.revetement,
      longueurKm: t.longueurKm ?? 0,
      // Valeurs REELLES : null quand elles manquent, jamais 0. Un 0 se lirait comme
      // « aucun trafic », alors qu'il signifie « aucun comptage ».
      traficMoyenJma: t.traficMoyenJma,
      criticiteStrategique: null as number | null,
      coutRehabEstime: null as number | null,
      ...estimerPourDecision(
        { etat: t.etat, revetement: t.revetement, longueurKm: t.longueurKm, traficMoyenJma: t.traficMoyenJma },
        baremes,
      ),
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
dashboardRouter.get("/programmation", requireAuth, requireModuleAccess("programmation"), nationalSeulement, async (_req, res, next) => {
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

    // Valeur invalide : 400 net et sans appel a la base (avant, `Number("abc")` donnait une date invalide transmise a Prisma).
    if (annee && !ANNEE.test(annee)) {
      res.status(400).json({ error: "annee : une année à quatre chiffres est attendue (ex. 2027)" }); return;
    }
    if (statut && !(STATUTS_CHANTIER as readonly string[]).includes(statut)) {
      res.status(400).json({ error: `statut : l'une des valeurs ${STATUTS_CHANTIER.join(", ")}` }); return;
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const size = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 20));

    // Chaque chantier porte sa region : un compte regional ne voit que les chantiers de son perimetre.
    const where: Record<string, unknown> = { deletedAt: null, ...(await filtreRegion(req.user!)) };
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
dashboardRouter.get("/tendances", requireAuth, requireModuleAccess("rapports"), nationalSeulement, async (req, res, next) => {
  try {
    const { periode_debut, periode_fin } = req.query as { periode_debut?: string; periode_fin?: string };

    const debut = periode_debut ? dateIso(periode_debut) : undefined;
    const fin = periode_fin ? dateIso(periode_fin) : undefined;
    if (debut === null || fin === null) {
      res.status(400).json({ error: "periode_debut et periode_fin : une date AAAA-MM-JJ (ou AAAA-MM) est attendue" }); return;
    }

    const where: Record<string, unknown> = {};
    if (debut) where["periode"] = { ...(where["periode"] as object ?? {}), gte: debut };
    if (fin)   where["periode"] = { ...(where["periode"] as object ?? {}), lte: fin };

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
