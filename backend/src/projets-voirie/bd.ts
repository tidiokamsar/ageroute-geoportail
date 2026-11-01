/**
 * Delais cote BASE pour les transactions du module (revue de securite, M2) : `statement_timeout` et `lock_timeout` poses par
 * `set_config(..., true)` (equivalent de `SET LOCAL`, borne a la transaction, valeur LIEE et non concatenee), et traduction de
 * l'annulation en erreur typee.
 *
 * Le delai de transaction de Prisma ne suffit pas : il ferme la transaction cote application, la requete continue dans PostgreSQL
 * (415 s de calcul pour un delai de 120 s dans la revue). `statement_timeout` coupe la requete DANS la base (verifie : une requete
 * qui boucle sur des objets est annulee a 5,06 s pour un delai de 5 s ; les appels de la bibliotheque GEOS ne sont interrompus
 * qu'entre deux appels, d'ou la simplification et les plafonds de volume en amont, voir analyse.depot.ts).
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import { ErreurMetier } from "./erreurs";

export type TxMinimale = Pick<PrismaClient, "$queryRaw">;

export async function poserDelais(tx: TxMinimale, statementMs: number, verrouMs: number): Promise<void> {
  await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(Math.max(1, Math.round(statementMs)))}, true), set_config('lock_timeout', ${String(verrouMs)}, true)`;
}

/**
 * Budget de temps d'une transaction : chaque etape recoit en `statement_timeout` ce qui reste du budget total. Plusieurs requetes
 * successives ne peuvent donc pas, ensemble, depasser le delai annonce.
 */
export class Budget {
  private readonly fin: number;
  constructor(private readonly tx: TxMinimale, totalMs: number, private readonly verrouMs: number, private readonly erreur: () => Error) {
    this.fin = Date.now() + totalMs;
  }
  async etape<T>(travail: () => Promise<T>, nom = "etape"): Promise<T> {
    const reste = this.fin - Date.now();
    if (reste < 200) throw this.erreur();
    await poserDelais(this.tx, reste, this.verrouMs);
    const t = performance.now();
    try {
      return await travail();
    } finally {
      if (process.env.PV_TRACE === "1") console.info(`[projets-voirie] ${nom} : ${Math.round(performance.now() - t)} ms`);
    }
  }
}

/** Vrai si l'erreur est l'annulation d'une requete par `statement_timeout` (57014) ou par `lock_timeout` (55P03). */
export function estDelaiDepasse(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    const code = (e.meta as { code?: unknown } | undefined)?.code;
    if (code === "57014" || code === "55P03") return true;
  }
  const texte = e instanceof Error ? e.message : String(e);
  // Une requete coupee DANS un calcul GEOS ressort en XX000 « GEOS Error: InterruptedException: Interrupted! » (mesure du banc de
  // charge) : c'est le meme depassement de delai, pas une panne.
  return /statement timeout|lock timeout|InterruptedException|\b57014\b|\b55P03\b/i.test(texte);
}

/**
 * Execute `travail` ; si la base annule une requete pour depassement de delai, rend l'erreur typee `code` (504) au lieu d'un 500.
 * Toute autre erreur est relancee telle quelle.
 */
export async function avecErreurDelai<T>(code: string, message: string, travail: () => Promise<T>): Promise<T> {
  try {
    return await travail();
  } catch (e) {
    if (e instanceof ErreurMetier) throw e;
    if (estDelaiDepasse(e)) throw new ErreurMetier(504, code, message);
    throw e;
  }
}
