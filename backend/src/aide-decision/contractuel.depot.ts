/**
 * Lecture SEULE de la copie gelee des objets contractuels (AD-LOT-5) : `marches`, `decomptes`, `avancement_marche`,
 * `marches_chantiers`, `chantiers`, `troncons`, `programmes_budgetaires`, `regions`. Aucune ecriture, aucune transaction
 * d'ecriture, aucun `$executeRaw`. Le noyau (`contractuel.noyau.ts`) arbitre la visibilite et les filtres : ce depot ne fait
 * que RAMENER les lignes, avec au plus une pre-selection par region qui n'est qu'une optimisation (le noyau a le dernier mot).
 *
 * Les lectures se font en SERIE (un pool de connexions partage avec le reste de l'application) et ne forment pas un instantane
 * atomique : un marche modifie entre deux lectures peut montrer un decompte plus recent que son avancement. La fraicheur
 * rendue est la plus recente `updatedAt` rencontree.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import type {
  AvancementEntree, ChantiersSansMarche, ChantierEntree, DecompteEntree, LienEntree, MarcheEntree, ProgrammeEntree, StatutMarche, TronconEntree,
} from "./contractuel.noyau";

export interface DemandeMarches {
  /** null : aucun filtre territorial (compte national sans filtre de region). */
  regions: readonly number[] | null;
  statutMarche?: readonly StatutMarche[];
  bailleurId?: number;
  marcheId?: string;
  /** Nombre maximal de marches ramenes ; le depot en lit un de plus pour savoir s'il y a troncature. */
  plafond: number;
}

export interface DonneesMarches {
  marches: MarcheEntree[];
  tronque: boolean;
  programmes: ProgrammeEntree[];
  marchesParTroncon: Map<string, Set<string>>;
}

export interface DemandeChantiersSansMarche { regions: readonly number[] | null; statutChantier?: readonly string[] }

export interface DepotContractuel {
  chargerMarches(d: DemandeMarches): Promise<DonneesMarches>;
  chargerRegions(): Promise<{ id: number; nom: string }[]>;
  chantiersSansMarche(d: DemandeChantiersSansMarche): Promise<ChantiersSansMarche>;
}

const SELECT_TRONCON = { id: true, code: true, nom: true, regionId: true, classe: true, etat: true, deletedAt: true } as const;

function versTroncon(t: { id: string; code: string; nom: string; regionId: number; classe: string; etat: string; deletedAt: Date | null } | null): TronconEntree | null {
  return t ? { id: t.id, code: t.code, nom: t.nom, regionId: t.regionId, classe: t.classe, etat: t.etat, archive: t.deletedAt !== null } : null;
}

function clauseRegions(regions: readonly number[]): Prisma.MarcheChantierWhereInput {
  const dansRegion = { in: [...regions] };
  return {
    OR: [
      { chantier: { regionId: dansRegion, deletedAt: null } },
      { troncon: { regionId: dansRegion, deletedAt: null } },
      { chantier: { deletedAt: null, troncon: { regionId: dansRegion, deletedAt: null } } },
    ],
  };
}

export const depotPrisma: DepotContractuel = {
  async chargerMarches(d) {
    const where: Prisma.MarcheWhereInput = { deletedAt: null };
    if (d.statutMarche?.length) where.statut = { in: [...d.statutMarche] };
    if (d.bailleurId !== undefined) where.bailleurId = d.bailleurId;
    if (d.marcheId) where.id = d.marcheId;
    if (d.regions !== null) where.chantiers = { some: clauseRegions(d.regions) };

    const lignes = await prisma.marche.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: d.plafond + 1,
      include: {
        bailleur: { select: { nom: true, type: true } },
        decomptes: { where: { deletedAt: null }, orderBy: { numero: "asc" }, take: 500 },
        avancements: { orderBy: { periode: "desc" }, take: 120 },
        chantiers: {
          include: {
            chantier: { include: { troncon: { select: SELECT_TRONCON } } },
            troncon: { select: SELECT_TRONCON },
          },
        },
      },
    });
    const tronque = lignes.length > d.plafond;
    const gardees = lignes.slice(0, d.plafond);

    // Nombre de marches par chantier : l'ambiguite « chantier rattache a plusieurs marches » ne depend pas de qui regarde.
    const chantierIds = [...new Set(gardees.flatMap((m) => m.chantiers.map((l) => l.chantierId)))];
    const parChantier = new Map<string, number>();
    if (chantierIds.length > 0) {
      const g = await prisma.marcheChantier.groupBy({
        by: ["chantierId"], where: { chantierId: { in: chantierIds }, marche: { deletedAt: null } }, _count: { _all: true },
      });
      for (const x of g) parChantier.set(x.chantierId, x._count._all);
    }

    const marches: MarcheEntree[] = gardees.map((m) => ({
      id: m.id, intitule: m.intitule, statut: m.statut, devise: m.devise, montantTotal: m.montantTotal,
      bailleurId: m.bailleurId, bailleurNom: m.bailleur?.nom ?? null, bailleurType: m.bailleur?.type ?? null,
      dateSignature: m.dateSignature, dateDebutPrevue: m.dateDebutPrevue, dateFinPrevue: m.dateFinPrevue,
      dateReceptionProvisoire: m.dateReceptionProvisoire, garantieBonneExecutionExp: m.garantieBonneExecutionExp,
      tauxPenaliteRetardPct: m.tauxPenaliteRetardPct, createdAt: m.createdAt, updatedAt: m.updatedAt,
      liens: m.chantiers.map((l): LienEntree => {
        const c = l.chantier;
        const chantier: ChantierEntree = {
          id: c.id, intitule: c.intitule, entreprise: c.entreprise, bailleur: c.bailleur, regionId: c.regionId,
          tronconId: c.tronconId, troncon: versTroncon(c.troncon),
          avancementPct: c.avancementPct, statut: c.statut,
          dateDebutPrevue: c.dateDebutPrevue, dateFinPrevue: c.dateFinPrevue, dateDebutReelle: c.dateDebutReelle, dateFinReelle: c.dateFinReelle,
          numContrat: c.numContrat, archive: c.deletedAt !== null, nbMarches: parChantier.get(c.id) ?? 1,
        };
        return { chantier, tronconId: l.tronconId, troncon: versTroncon(l.troncon) };
      }),
      decomptes: m.decomptes.map((x): DecompteEntree => ({
        id: x.id, numero: x.numero, type: x.type, statut: x.statut, montantGnf: x.montantGnf,
        dateEmission: x.dateEmission, datePaiement: x.datePaiement, updatedAt: x.updatedAt,
      })),
      avancements: m.avancements.map((a): AvancementEntree => ({
        periode: a.periode, physiquePrevu: a.avancementPhysiquePrevu, physiqueReel: a.avancementPhysiqueReel,
        financierPrevu: a.avancementFinancierPrevu, financierReel: a.avancementFinancierReel, createdAt: a.createdAt,
      })),
    }));

    // Programmes retenus et marches qui partagent leurs troncons.
    const tronconIds = new Set<string>();
    for (const m of marches) for (const l of m.liens) {
      if (l.chantier.archive) continue;
      if (l.tronconId) tronconIds.add(l.tronconId);
      if (l.chantier.tronconId) tronconIds.add(l.chantier.tronconId);
    }
    const programmes: ProgrammeEntree[] = [];
    const marchesParTroncon = new Map<string, Set<string>>();
    if (tronconIds.size > 0) {
      const ids = [...tronconIds];
      const lignesP = await prisma.programmeBudgetaire.findMany({
        where: { deletedAt: null, statut: "RETENU", tronconId: { in: ids } },
        select: { id: true, annee: true, intitule: true, tronconId: true, montantPrevuGnf: true, statut: true },
      });
      for (const p of lignesP) programmes.push({ id: p.id, annee: p.annee, intitule: p.intitule, tronconId: p.tronconId, montantPrevuGnf: p.montantPrevuGnf, statut: p.statut });
      if (programmes.length > 0) {
        const liensP = await prisma.marcheChantier.findMany({
          where: {
            marche: { deletedAt: null }, chantier: { deletedAt: null },
            OR: [{ tronconId: { in: ids } }, { chantier: { tronconId: { in: ids } } }],
          },
          select: { marcheId: true, tronconId: true, chantier: { select: { tronconId: true } } },
        });
        for (const l of liensP) for (const t of [l.tronconId, l.chantier.tronconId]) {
          if (!t) continue;
          const s = marchesParTroncon.get(t) ?? new Set<string>();
          s.add(l.marcheId);
          marchesParTroncon.set(t, s);
        }
      }
    }
    return { marches, tronque, programmes, marchesParTroncon };
  },

  async chargerRegions() {
    return prisma.region.findMany({ select: { id: true, nom: true }, orderBy: { id: "asc" } });
  },

  async chantiersSansMarche(d) {
    const base: Prisma.ChantierWhereInput = { deletedAt: null };
    if (d.regions !== null) base.regionId = { in: [...d.regions] };
    if (d.statutChantier?.length) base.statut = { in: d.statutChantier as ("PLANIFIE" | "EN_COURS" | "SUSPENDU" | "TERMINE")[] };
    const orphelins: Prisma.ChantierWhereInput = { ...base, marches: { none: { marche: { deletedAt: null } } } };
    const surTotal = await prisma.chantier.count({ where: base });
    const nombre = await prisma.chantier.count({ where: orphelins });
    const exemples = nombre === 0 ? [] : await prisma.chantier.findMany({ where: orphelins, select: { id: true, intitule: true }, orderBy: [{ intitule: "asc" }, { id: "asc" }], take: 5 });
    return { nombre, surTotal, exemples };
  },
};
