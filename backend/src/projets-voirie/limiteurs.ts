/**
 * Limiteurs de concurrence du module (revue de securite, M2 et m4). Les connexions de la base sont partagees avec l'authentification
 * de TOUS les comptes : un module qui en monopolise plusieurs prive les autres de service (mode de panne deja constate pour les
 * imports, voir import/limiteur.ts). Portee : le processus.
 *
 *   - depots (travail en base)          : 2 simultanes, 15 s d'attente (limiteurDepots, dans import.service.ts) ;
 *   - receptions de fichiers (memoire)   : 4 simultanes au total et 2 par compte AVANT la lecture du corps : un fichier de 25 Mo est
 *                                          tenu en memoire pendant tout le televersement ;
 *   - analyses et exports                : 3 simultanes, 10 s d'attente ;
 *   - cartes                             : 6 simultanees, 5 s d'attente.
 *
 * Au-dela : 503 SERVICE_OCCUPE avec Retry-After (jamais une file sans fin).
 */

import { Limiteur, ServiceOccupe } from "../import/limiteur";

export const limiteurAnalyses = new Limiteur(3, 10_000);
export const limiteurCartes = new Limiteur(6, 5_000);
export const limiteurReceptions = new Limiteur(4, 5_000);

/** Receptions en cours par compte. */
const receptionsParCompte = new Map<string, number>();
export const RECEPTIONS_PAR_COMPTE_MAX = 2;

/**
 * Reserve une place de reception pour `compte`, rendue par la fonction retournee (idempotente). Rejette `ServiceOccupe` si le compte
 * en a deja `RECEPTIONS_PAR_COMPTE_MAX` ou si le processus n'a plus de place.
 */
export async function reserverReception(compte: string): Promise<() => void> {
  const n = receptionsParCompte.get(compte) ?? 0;
  if (n >= RECEPTIONS_PAR_COMPTE_MAX) throw new ServiceOccupe("Ce compte a deja deux televersements en cours : attendez qu'ils se terminent.", 5);
  receptionsParCompte.set(compte, n + 1);
  let liberer!: () => void;
  const tenue = new Promise<void>((resolve) => { liberer = resolve; });
  try {
    // La place globale est tenue jusqu'a la liberation.
    await new Promise<void>((pret, echec) => {
      limiteurReceptions.executer(() => { pret(); return tenue; }).catch(echec);
    });
  } catch (e) {
    receptionsParCompte.set(compte, (receptionsParCompte.get(compte) ?? 1) - 1);
    if ((receptionsParCompte.get(compte) ?? 0) <= 0) receptionsParCompte.delete(compte);
    throw e;
  }
  let fait = false;
  return () => {
    if (fait) return;
    fait = true;
    const reste = (receptionsParCompte.get(compte) ?? 1) - 1;
    if (reste <= 0) receptionsParCompte.delete(compte); else receptionsParCompte.set(compte, reste);
    liberer();
  };
}

/** Etat observable (tests). */
export const etatReceptions = () => ({ comptes: receptionsParCompte.size, global: limiteurReceptions.etat });
