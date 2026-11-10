/**
 * Concurrence du lot X1 (contrat CONTRAT-EXPORTS.md, sections 4.4 et 6.4). Portee : le PROCESSUS (plusieurs instances multiplient les limites ; la cadence
 * des exports, elle, est comptee en base).
 *   - exports : 2 simultanes, 5 s d'attente au plus ; 1 par compte (refus immediat) ;
 *   - tableaux de bord : 4 simultanes, 5 s d'attente au plus.
 * Au-dela : 503 SERVICE_OCCUPE avec Retry-After, jamais une file sans fin.
 */

import { Limiteur, ServiceOccupe } from "../../import/limiteur";
import { EXPORTS_PAR_COMPTE_MAX, EXPORTS_SIMULTANES_MAX, TABLEAUX_SIMULTANES_MAX } from "./config";

export const limiteurExports = new Limiteur(EXPORTS_SIMULTANES_MAX, 5_000);
export const limiteurTableaux = new Limiteur(TABLEAUX_SIMULTANES_MAX, 5_000);

const exportsParCompte = new Map<string, number>();

/** Reserve la place d'export du compte (rendue par la fonction retournee, idempotente) ; `ServiceOccupe` si le compte en a deja une. */
export function reserverExportCompte(compte: string): () => void {
  const n = exportsParCompte.get(compte) ?? 0;
  if (n >= EXPORTS_PAR_COMPTE_MAX) throw new ServiceOccupe("Un export de ce compte est déjà en cours : attendez qu'il se termine.", 10);
  exportsParCompte.set(compte, n + 1);
  let fait = false;
  return () => {
    if (fait) return;
    fait = true;
    const reste = (exportsParCompte.get(compte) ?? 1) - 1;
    if (reste <= 0) exportsParCompte.delete(compte); else exportsParCompte.set(compte, reste);
  };
}

/** Execute sous un limiteur ; l'attente depassee devient un 503 au message du lot (le message du limiteur commun parle des imports). */
export async function sousLimiteur<T>(l: Limiteur, message: string, travail: () => Promise<T>): Promise<T> {
  let lance = false;
  try {
    return await l.executer(() => { lance = true; return travail(); });
  } catch (e) {
    if (e instanceof ServiceOccupe && !lance) throw new ServiceOccupe(message, e.retryAfterS);
    throw e;
  }
}

export const etatExports = () => ({ comptes: exportsParCompte.size, global: limiteurExports.etat });
