/**
 * LIEN ENTRE LE RECOLEMENT ET LA CLOTURE D'UN DOSSIER DE CONFLIT (extension minimale de RC-3, contrat docs/projets-voirie/CONTRAT-WORKFLOW.md,
 * section 7 ; CONTRAT-CONFLITS.md, section 9, point 35).
 *
 * Deux lectures seulement, faites DANS la transaction de la cloture : le recolement designe existe-t-il pour CE dossier, et est-il VALIDE ?
 * Rien n'est ecrit ici : valider un recolement ne modifie ni le dossier, ni un jeu, ni le referentiel.
 */

import type { Prisma } from "@prisma/client";
import { ErreurMetier, introuvable } from "../erreurs";

type Lecture = Pick<Prisma.TransactionClient, "recolementProjetVoirie">;

/** Le recolement designe est un recolement VALIDE de ce dossier, sinon 404 RECOLEMENT_INTROUVABLE (autre dossier, autre projet) ou 409 RECOLEMENT_NON_VALIDE. */
export async function exigerRecolementValide(tx: Lecture, projetId: string, conflitId: string, recolementId: string): Promise<void> {
  const r = await tx.recolementProjetVoirie.findFirst({ where: { id: recolementId, projetId, conflitId }, select: { statut: true } });
  if (!r) throw introuvable("Récolement", "RECOLEMENT_INTROUVABLE");
  if (r.statut !== "VALIDE") {
    throw new ErreurMetier(409, "RECOLEMENT_NON_VALIDE", `Le récolement désigné n'est pas validé (statut actuel : ${r.statut}) : il doit l'être, par un tiers, avant la clôture.`, { statut: r.statut });
  }
}

/**
 * Identifiant du dernier recolement VALIDE du dossier, ou `null` s'il n'en a pas. Le reglage « recolement obligatoire » (PROJETS_VOIRIE_RECOLEMENT_OBLIGATOIRE)
 * s'en sert : sans `recolementId` explicite, la cloture retient ce recolement-la (et le dit dans l'historique), ou refuse s'il n'existe pas.
 */
export async function dernierRecolementValide(tx: Lecture, projetId: string, conflitId: string): Promise<string | null> {
  const r = await tx.recolementProjetVoirie.findFirst({ where: { projetId, conflitId, statut: "VALIDE" }, orderBy: [{ decideLe: "desc" }, { id: "desc" }], select: { id: true } });
  return r?.id ?? null;
}
