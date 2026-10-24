import { prisma } from "../../lib/prisma";
import { createCrudService, type ListParams } from "../../lib/crud-factory";
import { createPhotoService } from "../../lib/photos";
import { construireAudit } from "../../utils/audit";
import { construireQualite } from "../../lib/qualite";

/**
 * Inspection est la premiere migration explicite de l'ADR 11 hors du lot terrain.
 *
 * Ce module a ete choisi parce que c'est le seul evenement de la base qui produise une
 * valeur REELLEMENT constatee — datee, attribuee, de methode connue — et parce qu'il
 * propage cet etat au troncon ou a l'ouvrage inspecte. Une trace perdue y laisse un etat
 * patrimonial modifie sans auteur ni date, sur le champ meme qui commande la
 * programmation des travaux.
 *
 * Les sept autres services qui partagent ces fabriques restent sur le helper historique
 * jusqu'a leur propre migration, comme l'ADR le prevoit.
 */
const base = createCrudService(prisma.inspection, "Inspection", {
  include: { troncon: true, ouvrage: true, inspecteur: { select: { nomComplet: true } } },
  // Le delegue est DESIGNE, pas devine : c'est ce qui distingue ce montage de celui que
  // 4eb1525 avait du retirer, lequel derivait le nom du modele depuis l'entite et
  // court-circuitait le delegue injecte dans la fabrique.
  delegueTransactionnel: (tx) => (tx as typeof prisma).inspection,
});
const photos = createPhotoService(prisma.inspection, "Inspection");

interface InspectionListParams extends ListParams {
  tronconId?: string;
  ouvrageId?: string;
}

async function list(params: InspectionListParams) {
  const where: Record<string, unknown> = { ...params.where };
  if (params.tronconId) where.tronconId = params.tronconId;
  if (params.ouvrageId) where.ouvrageId = params.ouvrageId;
  return base.list({ ...params, where });
}

// Boucle metier centrale : une inspection EST le constat humain de l'etat reel d'un
// element. On propage donc l'etat observe a l'element inspecte (troncon ou ouvrage),
// ce qui maintient l'inventaire a jour au lieu de le laisser figer. NON_EVALUE n'est
// volontairement PAS propage : enregistrer "non evalue" lors d'une inspection ne doit
// pas effacer un etat deja connu. Chaque propagation est tracee dans l'audit.
async function propagateEtat(
  data: { tronconId?: string | null; ouvrageId?: string | null; etatObserve?: string; dateInspection?: Date | string },
  userId: string
) {
  if (!data.etatObserve || data.etatObserve === "NON_EVALUE") return;
  const etat = data.etatObserve as never;
  // La date du CONSTAT, pas celle de la saisie : c'est ce que dit dateInspection.
  const dateConstat = data.dateInspection ? new Date(data.dateInspection) : new Date();

  /**
   * UNE SEULE TRANSACTION POUR LES TROIS ECRITURES.
   *
   * L'etat, sa trace d'audit et sa ligne de qualite partent ensemble ou pas du tout.
   *
   * Avant, les deux premieres etaient atomiques et la troisieme suivait, hors
   * transaction : un echec apres le commit laissait un etat trace SANS sa provenance.
   * La base affirmait alors « etat BON » sans pouvoir dire qu'il venait d'un releve de
   * terrain date et attribue — l'asymetrie meme que le modele de qualite existe pour
   * supprimer, et celle constatee le 04/09/2026 sur « 2e Boulevard ».
   *
   * UN DEFAUT CORRIGE AU PASSAGE
   *
   * La ligne de qualite s'ecrivait HORS des gardes `if (before)`. Quand la cible etait
   * introuvable, aucun etat n'etait propage et une ligne de qualite etait pourtant
   * ecrite, affirmant une provenance de releve terrain pour une valeur jamais posee.
   * Regrouper les trois ecritures sous une seule garde ferme ce cas par construction
   * plutot que par vigilance.
   */
  const cible = data.ouvrageId
    ? { entityType: "Ouvrage" as const, entityId: data.ouvrageId }
    : data.tronconId
      ? { entityType: "Troncon" as const, entityId: data.tronconId }
      : null;
  if (!cible) return;

  // Lecture branchee et non via un delegue unifie : les deux types de delegue Prisma ne
  // s'unifient pas en une signature appelable, et contourner par un cast ferait perdre
  // la verification des champs selectionnes.
  const before = cible.entityType === "Ouvrage"
    ? await prisma.ouvrage.findUnique({ where: { id: cible.entityId }, select: { etat: true } })
    : await prisma.troncon.findUnique({ where: { id: cible.entityId }, select: { etat: true } });
  if (!before) return;

  // `dateDerniereEvaluation` n'etait JAMAIS ecrite : le champ existe depuis l'origine et
  // vaut 0 sur les 1 690 troncons. Les ouvrages recevaient bien leur date d'inspection,
  // pas les troncons. Consequence : les 647 troncons dont l'etat est connu ne sont pas
  // comparables entre eux — un « BON » de cette annee et un « BON » d'il y a dix ans
  // occupent la meme case.
  const majEtat = cible.entityType === "Ouvrage"
    ? prisma.ouvrage.update({
        where: { id: cible.entityId },
        data: { etat, derniereInspectionDate: dateConstat },
      })
    : prisma.troncon.update({
        where: { id: cible.entityId },
        data: { etat, dateDerniereEvaluation: dateConstat },
      });

  await prisma.$transaction([
    majEtat,
    construireAudit({
      userId, action: "UPDATE", entityType: cible.entityType, entityId: cible.entityId,
      before: { etat: before.etat }, after: { etat: data.etatObserve, source: "inspection" },
    }),
    // Une inspection est le SEUL evenement de la base qui produise une valeur reellement
    // constatee : datee, attribuee, et de methode connue. C'est ici que le modele de
    // qualite cesse d'etre descriptif pour devenir alimente.
    construireQualite({
      entityType: cible.entityType,
      entityId: cible.entityId,
      champ: "etat",
      statut: "OBSERVED",
      source: "INSPECTION_TERRAIN",
      methode: "RELEVE_TERRAIN",
      observedAt: dateConstat,
      observedById: userId,
      confiance: "HIGH",
      note: null,
    }),
  ]);
}

async function create(data: Record<string, unknown>, userId: string) {
  const created = await base.create(data, userId);
  await propagateEtat(data as Parameters<typeof propagateEtat>[0], userId);
  return created;
}

async function update(id: string, data: Record<string, unknown>, userId: string) {
  const updated = await base.update(id, data, userId);
  // En edition partielle, l'etat observe (et la cible) peuvent ne pas etre dans le payload :
  // on retombe sur les valeurs persistees pour ne pas rater la propagation.
  const full = updated as { tronconId?: string | null; ouvrageId?: string | null; etatObserve?: string; dateInspection?: Date };
  await propagateEtat(
    {
      tronconId: (data.tronconId as string | undefined) ?? full.tronconId,
      ouvrageId: (data.ouvrageId as string | undefined) ?? full.ouvrageId,
      etatObserve: (data.etatObserve as string | undefined) ?? full.etatObserve,
      dateInspection: (data.dateInspection as Date | undefined) ?? full.dateInspection,
    },
    userId
  );
  return updated;
}

export const inspectionsService = { ...base, list, create, update, addPhoto: photos.addPhoto, removePhoto: photos.removePhoto };
