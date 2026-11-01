import path from "path";
import { unlink } from "node:fs/promises";
import { ApiError } from "../middleware/error.middleware";
import { prisma } from "./prisma";
import { construireAudit } from "../utils/audit";
import { PHOTOS_UPLOAD_DIR } from "../middleware/upload-photo.middleware";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrismaDelegate = any;

/**
 * Ajout/retrait de photos partage par Ouvrage et Inspection (tous deux ont un champ
 * `photos String[]`) : evite de dupliquer la meme logique de tableau dans chaque service.
 *
 * P1-02 : chaque ajout et chaque retrait est desormais audite (regle 3 d'AGENTS.md) —
 * une photo retiree sans trace etait une disparition de preuve invisible.
 */
/**
 * L'option `auditTransactionnel` a disparu le 13/10/2026 : ses deux appelants la
 * passaient, la branche fail-soft etait donc du code mort, et un code mort de cette
 * nature est un piege — il suffisait d'instancier sans l'option pour retrouver un audit
 * perdable en silence. L'ecriture et sa trace partent desormais ensemble, toujours.
 */
export function createPhotoService(model: PrismaDelegate, entityName: string) {
  async function addPhoto(id: string, filename: string, userId: string) {
    const item = await model.findFirst({ where: { id, deletedAt: null }, select: { photos: true } });
    if (!item) throw new ApiError(404, `${entityName} introuvable`);
    const photos = [...item.photos, filename];
    // Une photo ajoutee sans trace, c'est une preuve qui apparait sans auteur ; une photo
    // retiree sans trace, une preuve qui disparait. Les deux sont indissociables de leur
    // ligne d'audit.
    const [updated] = await prisma.$transaction([
      model.update({ where: { id }, data: { photos } }),
      construireAudit({ userId, action: "CREATE", entityType: `${entityName}Photo`, entityId: id, after: { filename } }),
    ]);
    return updated;
  }

  async function removePhoto(id: string, filename: string, userId: string) {
    const item = await model.findFirst({ where: { id, deletedAt: null }, select: { photos: true } });
    if (!item) throw new ApiError(404, `${entityName} introuvable`);
    if (!item.photos.includes(filename)) throw new ApiError(404, "Photo introuvable");
    const restantes = item.photos.filter((p: string) => p !== filename);
    const [updated] = await prisma.$transaction([
      model.update({ where: { id }, data: { photos: restantes } }),
      construireAudit({ userId, action: "DELETE", entityType: `${entityName}Photo`, entityId: id, before: { filename } }),
    ]);
    return updated;
  }

  return { addPhoto, removePhoto };
}

/**
 * Supprime le fichier televerse quand l'enregistrement n'a PAS eu lieu.
 *
 * LE DEFAUT QU'ELLE FERME
 *
 * `multer` ecrit le fichier avant que le gestionnaire de route ne s'execute. Les trois
 * gestionnaires de photos — inspections, ouvrages, ordres de travaux — appelaient ensuite
 * leur service et laissaient toute erreur partir a `next(err)`. Le fichier restait alors
 * sur le disque sans aucune ligne en base pour le referencer : un orphelin que rien ne
 * reclame et que personne ne vient nettoyer.
 *
 * Le cas le plus courant est banal : un identifiant inconnu rend 404 apres que les
 * octets soient ecrits.
 *
 * ET LA MIGRATION DE L'ADR 11 LE REND PLUS PROBABLE
 *
 * Depuis que l'audit des photos d'inspection rejoint la transaction metier, une panne de
 * journalisation FAIT LEVER la ou l'erreur etait avalee. Le chemin d'erreur, jusque-la
 * rare, devient un chemin normal — c'est exactement ce que l'ADR demandait de verifier
 * avant d'etendre la migration.
 *
 * POURQUOI UN DRAPEAU ET PAS UN SIMPLE `catch`
 *
 * Nettoyer dans tout `catch` supprimerait un fichier DEJA REFERENCE si l'ecriture a
 * reussi et que seule la reponse a echoue. Le drapeau distingue « jamais enregistree » de
 * « enregistree puis probleme ailleurs », et seule la premiere justifie une suppression.
 */
export async function supprimerTeleversementNonEnregistre(
  enregistree: boolean,
  fichier: { path: string } | undefined,
): Promise<void> {
  if (enregistree || !fichier) return;
  await unlink(fichier.path).catch(() => undefined);
}

export function photoAbsolutePath(filename: string): string {
  // Empeche la traversee de repertoire (ex: filename = "../../etc/passwd") : seul le nom
  // de base est conserve, peu importe ce que le client envoie.
  return path.join(PHOTOS_UPLOAD_DIR, path.basename(filename));
}
