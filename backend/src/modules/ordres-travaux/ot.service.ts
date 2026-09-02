import { prisma } from "../../lib/prisma";
import { nextNumeroOT } from "../../lib/numero";
import { logAudit } from "../../utils/audit";
import { ApiError } from "../../middleware/error.middleware";
import type { StatutOT, Role } from "@prisma/client";

// Seuil au-delà duquel un OT devrait devenir un chantier/marché (paramétrable plus tard
// via app_settings — défaut spec : 50 M GNF).
const SEUIL_CONVERSION_GNF = 50_000_000n;

const include = {
  region: { select: { nom: true } },
  troncon: { select: { id: true, code: true, nom: true } },
  ouvrage: { select: { id: true, nom: true, type: true } },
  pointNoir: { select: { id: true, description: true } },
  signalement: { select: { id: true, numeroPublic: true, typeProbleme: true } },
  assigneA: { select: { id: true, nomComplet: true } },
  creePar: { select: { id: true, nomComplet: true } },
  photos: { where: { deletedAt: null }, orderBy: { priseLe: "asc" as const } },
  _count: { select: { photos: { where: { deletedAt: null } } } },
};

// Transitions autorisées du workflow OT. ANNULE accessible depuis tout état non terminal.
const TRANSITIONS: Record<StatutOT, StatutOT[]> = {
  BROUILLON: ["ASSIGNE", "ANNULE"],
  ASSIGNE: ["EN_COURS", "BROUILLON", "ANNULE"],
  EN_COURS: ["SUSPENDU", "TERMINE", "ANNULE"],
  SUSPENDU: ["EN_COURS", "ANNULE"],
  TERMINE: [],
  ANNULE: [],
  CONVERTI_CHANTIER: [],
};

async function pushHistorique(otId: string, action: string, userId: string | null, opts?: {
  ancienStatut?: StatutOT; nouveauStatut?: StatutOT; commentaire?: string;
}) {
  await prisma.otHistorique.create({
    data: { otId, action, userId, ancienStatut: opts?.ancienStatut, nouveauStatut: opts?.nouveauStatut, commentaire: opts?.commentaire },
  });
}

async function list(params: {
  page?: number; pageSize?: number; statut?: string; priorite?: string;
  region?: string; assigneA?: string; type?: string; search?: string; aTraiter?: boolean; userId?: string;
}) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, params.pageSize ?? 20);
  const where: Record<string, unknown> = { deletedAt: null };
  if (params.statut) where.statut = params.statut;
  if (params.priorite) where.priorite = params.priorite;
  if (params.region) where.region = { nom: params.region };
  if (params.assigneA) where.assigneAId = params.assigneA;
  if (params.type) where.typeIntervention = params.type;
  if (params.search) where.OR = [
    { titre: { contains: params.search, mode: "insensitive" } },
    { numero: { contains: params.search, mode: "insensitive" } },
  ];
  // Vue terrain "mes OT" : uniquement ceux assignés à l'agent connecté, actifs
  if (params.aTraiter && params.userId) {
    where.assigneAId = params.userId;
    where.statut = { in: ["ASSIGNE", "EN_COURS", "SUSPENDU"] };
  }

  const [data, total] = await Promise.all([
    prisma.ordreTravaux.findMany({
      where, include,
      orderBy: [{ priorite: "asc" }, { createdAt: "desc" }],
      skip: (page - 1) * pageSize, take: pageSize,
    }),
    prisma.ordreTravaux.count({ where }),
  ]);
  return { data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
}

async function getById(id: string) {
  const ot = await prisma.ordreTravaux.findFirst({
    where: { id, deletedAt: null },
    include: {
      ...include,
      historique: { include: { user: { select: { nomComplet: true } } }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!ot) throw new ApiError(404, "Ordre de travaux introuvable");
  return ot;
}

async function create(data: Record<string, unknown>, userId: string, _role: Role) {
  const numero = await nextNumeroOT();
  const { coutEstimeGnf, ...rest } = data;

  // Si l'OT est lié à un tronçon sans région explicite, hériter de celle du tronçon
  let regionId = rest.regionId as number | undefined;
  if (!regionId && rest.tronconId) {
    const t = await prisma.troncon.findUnique({ where: { id: rest.tronconId as string }, select: { regionId: true } });
    regionId = t?.regionId;
  }

  const created = await prisma.ordreTravaux.create({
    data: {
      ...rest,
      regionId,
      numero,
      coutEstimeGnf: coutEstimeGnf != null ? BigInt(Math.round(Number(coutEstimeGnf))) : undefined,
      // INSPECTEUR crée toujours en brouillon (validation par un gestionnaire ensuite)
      statut: "BROUILLON",
      creeParId: userId,
    } as never,
    include,
  });

  await pushHistorique(created.id, "Création", userId, { nouveauStatut: "BROUILLON" });
  await logAudit({ userId, action: "CREATE", entityType: "OrdreTravaux", entityId: created.id, after: { numero, titre: created.titre } });

  const suggestionConversion = created.coutEstimeGnf != null && created.coutEstimeGnf > SEUIL_CONVERSION_GNF;
  return { ...created, suggestionConversion };
}

async function update(id: string, data: Record<string, unknown>, userId: string) {
  const before = await prisma.ordreTravaux.findFirst({ where: { id, deletedAt: null } });
  if (!before) throw new ApiError(404, "Ordre de travaux introuvable");
  if (["TERMINE", "ANNULE", "CONVERTI_CHANTIER"].includes(before.statut)) {
    throw new ApiError(400, `OT ${before.statut.toLowerCase()} — modification impossible`);
  }
  const { coutEstimeGnf, coutReelGnf, ...rest } = data;
  const updated = await prisma.ordreTravaux.update({
    where: { id },
    data: {
      ...rest,
      coutEstimeGnf: coutEstimeGnf != null ? BigInt(Math.round(Number(coutEstimeGnf))) : undefined,
      coutReelGnf: coutReelGnf != null ? BigInt(Math.round(Number(coutReelGnf))) : undefined,
    } as never,
    include,
  });
  await logAudit({ userId, action: "UPDATE", entityType: "OrdreTravaux", entityId: id, before, after: updated });
  return updated;
}

async function assigner(id: string, data: { assigneAId: string; priorite?: string; dateEcheance?: Date }, userId: string) {
  const before = await getById(id);
  if (!["BROUILLON", "ASSIGNE"].includes(before.statut)) {
    throw new ApiError(400, "Seul un OT brouillon ou déjà assigné peut être (ré)assigné");
  }
  const cible = await prisma.user.findFirst({ where: { id: data.assigneAId, actif: true } });
  if (!cible) throw new ApiError(404, "Utilisateur cible introuvable ou inactif");

  const updated = await prisma.ordreTravaux.update({
    where: { id },
    data: { assigneAId: data.assigneAId, priorite: data.priorite as never, dateEcheance: data.dateEcheance, statut: "ASSIGNE" },
    include,
  });
  await pushHistorique(id, `Assigné à ${cible.nomComplet}`, userId, { ancienStatut: before.statut, nouveauStatut: "ASSIGNE" });
  return updated;
}

async function changeStatut(id: string, statut: StatutOT, commentaire: string | undefined, userId: string, role: Role) {
  const before = await prisma.ordreTravaux.findFirst({ where: { id, deletedAt: null } });
  if (!before) throw new ApiError(404, "Ordre de travaux introuvable");

  if (!TRANSITIONS[before.statut].includes(statut)) {
    throw new ApiError(400, `Transition ${before.statut} → ${statut} non autorisée`);
  }
  // INSPECTEUR : peut agir uniquement sur les OT qui lui sont assignés
  if (role === "INSPECTEUR" && before.assigneAId !== userId) {
    throw new ApiError(403, "Vous ne pouvez agir que sur les OT qui vous sont assignés");
  }

  const patch: Record<string, unknown> = { statut };
  if (statut === "EN_COURS" && !before.dateDebutReel) patch.dateDebutReel = new Date();
  if (statut === "TERMINE") patch.dateFinReelle = new Date();

  const updated = await prisma.ordreTravaux.update({ where: { id }, data: patch as never, include });
  await pushHistorique(id, `Statut : ${before.statut} → ${statut}`, userId, { ancienStatut: before.statut, nouveauStatut: statut, commentaire });
  await logAudit({ userId, action: "UPDATE", entityType: "OrdreTravaux", entityId: id, after: { statut } });
  return updated;
}

// Conversion en chantier : crée le chantier depuis l'OT (marché public au-delà du seuil)
async function convertirChantier(id: string, userId: string) {
  const ot = await getById(id);
  if (["TERMINE", "ANNULE", "CONVERTI_CHANTIER"].includes(ot.statut)) {
    throw new ApiError(400, "OT clos — conversion impossible");
  }
  if (!ot.regionId) throw new ApiError(400, "L'OT doit avoir une région pour créer un chantier");
  // Narrowing conserve hors closure : la garde ci-dessus ne traverse pas la
  // fonction passée à $transaction, on fige la valeur garant non nulle.
  const regionId = ot.regionId;

  // P2-04 : creation du chantier et bascule de l'OT dans une MEME transaction.
  // Avant, un echec de l'update apres le create laissait un chantier orphelin
  // et un OT encore actif — l'exact etat que la conversion devait eviter.
  const chantier = await prisma.$transaction(async (tx) => {
    const created = await tx.chantier.create({
      data: {
        intitule: `[Ex-${ot.numero}] ${ot.titre}`,
        entreprise: ot.entreprise ?? "À déterminer",
        regionId,
        tronconId: ot.tronconId,
        montantGnf: ot.coutEstimeGnf,
        statut: "PLANIFIE",
        observations: `Converti depuis l'ordre de travaux ${ot.numero}. ${ot.description ?? ""}`.trim(),
      },
    });
    await tx.ordreTravaux.update({ where: { id }, data: { statut: "CONVERTI_CHANTIER", chantierId: created.id } });
    return created;
  });

  await pushHistorique(id, `Converti en chantier ${chantier.id}`, userId, { ancienStatut: ot.statut, nouveauStatut: "CONVERTI_CHANTIER" });
  await logAudit({ userId, action: "CREATE", entityType: "Chantier", entityId: chantier.id, after: { fromOt: ot.numero } });
  return { chantierId: chantier.id };
}

async function addPhoto(otId: string, fileName: string, type: string, lat: number | undefined, lon: number | undefined, userId: string) {
  await getById(otId);
  const created = await prisma.otPhoto.create({
    data: { otId, fileName, type: type as never, lat, lon, priseParId: userId },
  });
  await logAudit({ userId, action: "CREATE", entityType: "OtPhoto", entityId: created.id, after: { otId, fileName, type } });
  return created;
}

// P1-02 : la photo doit appartenir à l'OT porté par l'URL, et celui-ci être actif.
// Connaître un identifiant de photo ne suffit plus pour agir sur elle ; un
// identifiant valide d'un autre OT reçoit la même réponse qu'un identifiant
// inconnu (404 uniforme, pas de révélation d'existence).
// Retrait logique : une photo d'OT est une preuve d'exécution, jamais un DELETE.
async function removePhoto(otId: string, photoId: string, userId: string) {
  const photo = await prisma.otPhoto.findFirst({
    where: { id: photoId, otId, deletedAt: null },
    select: { id: true, fileName: true, type: true, ot: { select: { deletedAt: true } } },
  });
  if (!photo || photo.ot.deletedAt) throw new ApiError(404, "Photo introuvable");
  await prisma.otPhoto.update({ where: { id: photoId }, data: { deletedAt: new Date() } });
  await logAudit({ userId, action: "DELETE", entityType: "OtPhoto", entityId: photoId, before: { otId, fileName: photo.fileName, type: photo.type } });
}

async function remove(id: string, userId: string) {
  const before = await prisma.ordreTravaux.findFirst({ where: { id, deletedAt: null } });
  if (!before) throw new ApiError(404, "Ordre de travaux introuvable");
  await prisma.ordreTravaux.update({ where: { id }, data: { deletedAt: new Date() } });
  await logAudit({ userId, action: "DELETE", entityType: "OrdreTravaux", entityId: id, before });
}

// KPI du module pour le tableau de bord exécutif
async function stats() {
  const notDeleted = { deletedAt: null };
  const [ouverts, parPriorite, parRegion, termines, avecPhotosApres] = await Promise.all([
    prisma.ordreTravaux.count({ where: { ...notDeleted, statut: { in: ["BROUILLON", "ASSIGNE", "EN_COURS", "SUSPENDU"] } } }),
    prisma.ordreTravaux.groupBy({ by: ["priorite"], where: { ...notDeleted, statut: { in: ["ASSIGNE", "EN_COURS", "SUSPENDU"] } }, _count: { _all: true } }),
    prisma.$queryRaw<{ region: string; nb: bigint }[]>`
      SELECT COALESCE(r.nom, 'Non renseignée') AS region, count(*) AS nb
      FROM ordres_travaux ot LEFT JOIN regions r ON r.id = ot."regionId"
      WHERE ot."deletedAt" IS NULL AND ot.statut IN ('BROUILLON','ASSIGNE','EN_COURS','SUSPENDU')
      GROUP BY 1 ORDER BY nb DESC`,
    prisma.ordreTravaux.findMany({
      where: { ...notDeleted, statut: "TERMINE", dateFinReelle: { not: null } },
      select: { createdAt: true, dateFinReelle: true, coutEstimeGnf: true, coutReelGnf: true },
    }),
    prisma.ordreTravaux.count({
      where: { ...notDeleted, statut: "TERMINE", photos: { some: { type: "APRES", deletedAt: null } } },
    }),
  ]);

  const delais = termines
    .filter((t) => t.dateFinReelle)
    .map((t) => (t.dateFinReelle!.getTime() - t.createdAt.getTime()) / 86400000);
  const delaiMoyenJours = delais.length ? Math.round(delais.reduce((s, d) => s + d, 0) / delais.length) : null;

  const derivesPct = termines
    .filter((t) => t.coutEstimeGnf && t.coutReelGnf && t.coutEstimeGnf > 0n)
    .map((t) => ((Number(t.coutReelGnf) - Number(t.coutEstimeGnf)) / Number(t.coutEstimeGnf)) * 100);
  const deriveCoutMoyenPct = derivesPct.length ? parseFloat((derivesPct.reduce((s, d) => s + d, 0) / derivesPct.length).toFixed(1)) : null;

  return {
    ouverts,
    termines: termines.length,
    delaiMoyenJours,
    deriveCoutMoyenPct,
    tauxPreuvePhotoPct: termines.length ? Math.round((avecPhotosApres / termines.length) * 100) : null,
    backlogParPriorite: parPriorite.map((p) => ({ priorite: p.priorite, nb: p._count._all })),
    backlogParRegion: parRegion.map((r) => ({ region: r.region, nb: Number(r.nb) })),
  };
}

// Liste des agents assignables (GESTIONNAIRE + INSPECTEUR actifs) — accessible aux rôles
// de gestion sans exposer la liste complète des comptes (réservée à l'ADMIN).
async function assignables() {
  return prisma.user.findMany({
    where: { actif: true, role: { in: ["GESTIONNAIRE", "INSPECTEUR"] } },
    select: { id: true, nomComplet: true, role: true },
    orderBy: { nomComplet: "asc" },
  });
}

export const otService = { list, getById, create, update, assigner, changeStatut, convertirChantier, addPhoto, removePhoto, remove, stats, assignables };
