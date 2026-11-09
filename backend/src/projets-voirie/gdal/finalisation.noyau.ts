/**
 * CLASSIFICATION D'UNE ERREUR DE FINALISATION (lot V2, correction M3 de la revue). Sans E/S, sans base.
 *
 * Quand le conteneur a rendu `termine`, le backend relit et valide le resultat. Deux familles d'erreurs :
 *   - DEFINITIVES, imputables a la sortie du conteneur : `ErreurSortie` (schema, coherence, plafonds), `ErreurLecture` (regle de CRS ou d'unites), fichier
 *     annonce absent (ENOENT, ENOTDIR : le worker ecrit resultat.json AVANT statut.json, un resultat manquant est une rupture du contrat). Le job passe ECHEC.
 *   - TRANSITOIRES, imputables au backend ou a l'hote : limiteur sature (`ServiceOccupe` apres 15 s), erreur de la base (Prisma), EMFILE, EIO, EACCES, garde
 *     de delai du sondage... Le job RESTE EN_COURS et la validation est retentee au tour suivant, bornee par l'expiration du job. Un conteneur honnete
 *     n'est jamais declare hostile pour une panne du backend.
 */

import { ErreurLecture } from "../lecture.types";
import { ERREURS_JOB } from "./contrat.noyau";
import { ErreurSortie, codeDeErreurSortie } from "./sortie.noyau";

export type VerdictFinalisation = { type: "ECHEC"; code: string } | { type: "REESSAYER"; raison: string };

const CODES_FICHIER_ABSENT = new Set(["ENOENT", "ENOTDIR"]);

export function classerErreurFinalisation(e: unknown): VerdictFinalisation {
  if (e instanceof ErreurSortie) return { type: "ECHEC", code: codeDeErreurSortie(e) };
  if (e instanceof ErreurLecture) {
    return { type: "ECHEC", code: Object.prototype.hasOwnProperty.call(ERREURS_JOB, e.code) ? e.code : "SORTIE_INVALIDE" };
  }
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string" && CODES_FICHIER_ABSENT.has(code)) return { type: "ECHEC", code: "SORTIE_INVALIDE" };
  // Jamais de message d'erreur brut dans la raison : le nom du type et, s'il existe, le code errno ou applicatif.
  const nom = e instanceof Error ? e.name : "erreur";
  return { type: "REESSAYER", raison: typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? `${nom} (${code})` : nom };
}
