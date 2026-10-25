import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { logAuditTransactionnelle } from "../utils/audit";

/**
 * Liens entre un chantier et les troncons ou sections qu'il touche (BDRI, lot G).
 *
 * Le BDRI RELIE, il ne gere pas les travaux : aucune quantite, aucun montant, aucun statut contractuel ne passe
 * par ici. Chaque ecriture part avec sa ligne d'audit dans la meme transaction ; un lien se retire avec son auteur
 * et son motif, il ne s'efface jamais (declencheur en base).
 */

export class RefusSection extends Error {
  constructor(public readonly http: number, public readonly code: string, message: string) { super(message); }
}

export interface NouvelleSection {
  tronconId: string;
  portionId?: string | null;
  debutM?: number | null;
  finM?: number | null;
  commentaire?: string | null;
}

const AVEC = {
  troncon: { select: { id: true, code: true, nom: true } },
  portion: { select: { id: true, debutM: true, finM: true } },
  creePar: { select: { nomComplet: true } },
  retirePar: { select: { nomComplet: true } },
} as const;

export async function lister(chantierId: string) {
  return prisma.chantierSection.findMany({ where: { chantierId }, include: AVEC, orderBy: [{ retireLe: { sort: "asc", nulls: "first" } }, { creeLe: "asc" }] });
}

/**
 * Les chantiers d'un troncon, pour sa fiche : celui dont c'est le troncon PRINCIPAL (`chantiers.tronconId`) et
 * ceux qui le touchent par une section. Un lien retire reste visible, marque : l'historique d'un troncon garde les
 * chantiers qui l'ont touche.
 */
export async function parTroncon(tronconId: string) {
  const champs = { id: true, intitule: true, entreprise: true, statut: true, avancementPct: true, dateDebutPrevue: true, dateFinPrevue: true, dateDebutReelle: true, dateFinReelle: true } as const;
  const [principaux, sections] = await Promise.all([
    prisma.chantier.findMany({ where: { tronconId, deletedAt: null }, select: champs }),
    prisma.chantierSection.findMany({ where: { tronconId, chantier: { deletedAt: null } }, include: { chantier: { select: champs }, portion: { select: { debutM: true, finM: true } } }, orderBy: { creeLe: "asc" } }),
  ]);
  const parId = new Map<string, { chantier: (typeof principaux)[number]; principal: boolean; sections: { id: string; debutM: number | null; finM: number | null; portionId: string | null; retireLe: Date | null }[] }>();
  for (const c of principaux) parId.set(c.id, { chantier: c, principal: true, sections: [] });
  for (const s of sections) {
    const e = parId.get(s.chantierId) ?? { chantier: s.chantier, principal: false, sections: [] };
    e.sections.push({ id: s.id, debutM: s.debutM ?? s.portion?.debutM ?? null, finM: s.finM ?? s.portion?.finM ?? null, portionId: s.portionId, retireLe: s.retireLe });
    parId.set(s.chantierId, e);
  }
  return [...parId.values()];
}

export async function ajouter(chantierId: string, c: NouvelleSection, userId: string, ip?: string) {
  const chantier = await prisma.chantier.findFirst({ where: { id: chantierId, deletedAt: null }, select: { id: true } });
  if (!chantier) throw new RefusSection(404, "CHANTIER_INTROUVABLE", "Chantier introuvable ou archivé.");
  const troncon = await prisma.troncon.findFirst({ where: { id: c.tronconId, deletedAt: null }, select: { id: true } });
  if (!troncon) throw new RefusSection(404, "TRONCON_INTROUVABLE", "Tronçon introuvable ou archivé.");
  const intervalle = c.debutM != null || c.finM != null;
  if (c.portionId && intervalle) throw new RefusSection(422, "DEUX_DEFINITIONS", "Une section est une portion OU un intervalle, pas les deux.");
  if (intervalle && !(c.debutM != null && c.finM != null && c.debutM >= 0 && c.finM > c.debutM)) {
    throw new RefusSection(422, "INTERVALLE_INVALIDE", "L'intervalle exige un début et une fin (en mètres), la fin après le début.");
  }
  if (c.portionId) {
    const p = await prisma.portion.findFirst({ where: { id: c.portionId, deletedAt: null }, select: { tronconId: true, remplaceeLe: true } });
    if (!p || p.tronconId !== c.tronconId) throw new RefusSection(422, "PORTION_HORS_TRONCON", "Cette portion n'appartient pas à ce tronçon.");
    if (p.remplaceeLe) throw new RefusSection(409, "PORTION_REMPLACEE", "Cette portion est de l'historique : choisir la version courante.");
  }
  if (intervalle) {
    // La fin ne depasse pas le trace, a 1 % pres (arrondis de saisie) ; sans trace, l'intervalle n'est pas verifiable
    // et il est refuse plutot que cru.
    const [l] = await prisma.$queryRaw<{ m: number | null }[]>`SELECT CASE WHEN geom IS NOT NULL AND ST_IsValid(geom) THEN ST_Length(geom::geography) END AS m FROM troncons WHERE id = ${c.tronconId}`;
    if (l?.m == null) throw new RefusSection(422, "SANS_TRACE", "Ce tronçon n'a pas de tracé exploitable : un intervalle en mètres n'y est pas vérifiable. Lier le tronçon entier, ou une portion.");
    if (c.finM! > Number(l.m) * 1.01) throw new RefusSection(422, "HORS_TRONCON", `La fin (${c.finM} m) dépasse la longueur du tracé (${Math.round(Number(l.m))} m).`);
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const cree = await tx.chantierSection.create({
        data: { chantierId, tronconId: c.tronconId, portionId: c.portionId ?? null, debutM: c.debutM ?? null, finM: c.finM ?? null, commentaire: c.commentaire?.trim() || null, creeParId: userId },
        include: AVEC,
      });
      await logAuditTransactionnelle(tx, { userId, action: "CREATE", entityType: "ChantierSection", entityId: cree.id, before: null, after: { chantierId, tronconId: c.tronconId, portionId: cree.portionId, debutM: cree.debutM, finM: cree.finM }, ipAddress: ip });
      return cree;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new RefusSection(409, "DEJA_LIE", "Ce chantier est déjà lié à cette section.");
    throw e;
  }
}

export async function retirer(id: string, motif: string, userId: string, ip?: string) {
  if (motif.trim().length < 3) throw new RefusSection(422, "MOTIF_EXIGE", "Un retrait se motive (3 caractères au moins).");
  return prisma.$transaction(async (tx) => {
    const avant = await tx.chantierSection.findUnique({ where: { id } });
    if (!avant) throw new RefusSection(404, "INTROUVABLE", "Lien introuvable.");
    const maj = await tx.chantierSection.updateMany({ where: { id, retireLe: null }, data: { retireLe: new Date(), retireParId: userId, motifRetrait: motif.trim() } });
    if (maj.count !== 1) throw new RefusSection(409, "DEJA_RETIRE", "Ce lien est déjà retiré.");
    await logAuditTransactionnelle(tx, { userId, action: "DELETE", entityType: "ChantierSection", entityId: id, before: { retireLe: null }, after: { retireLe: new Date().toISOString(), motif: motif.trim() }, ipAddress: ip });
    return tx.chantierSection.findUnique({ where: { id }, include: AVEC });
  });
}
