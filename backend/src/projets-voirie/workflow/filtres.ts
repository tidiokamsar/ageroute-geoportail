/**
 * Traduction d'un filtre de visibilite (noyau pur, `visibilite.noyau.ts`) en clauses `where` Prisma : la base ne remonte que ce que le compte
 * peut voir (jamais un filtrage apres lecture, qui ferait fuiter totaux et curseurs).
 */

import type { FiltreVisibilite } from "./visibilite.noyau";

export type Clause = Record<string, unknown>;

/**
 * `partage` : ce qui signifie « partage » pour la table : une colonne horodatee renseignee (`envoyeLe` d'une demande), un booleen vrai
 * (`partagee` d'une tache) ou un statut autre que BROUILLON (un recolement : un brouillon, meme rouvert apres un rejet, est interne). `avecConflit` : la table porte `conflitId` (taches, recolements).
 */
export type Partage = { renseignee: "envoyeLe" } | { vrai: "partagee" } | { statutNon: "BROUILLON" };
export function clausesVisibilite(f: FiltreVisibilite, partage: Partage, avecConflit: boolean): Clause[] {
  const c: Clause[] = [];
  if (f.concessionnaires !== null) c.push({ concessionnaireId: { in: [...f.concessionnaires] } });
  if (f.exigeConcessionnaire) c.push({ concessionnaireId: { not: null } });
  if (f.sansConflit && avecConflit) c.push({ conflitId: null });
  if (f.exigePartage) c.push("renseignee" in partage ? { [partage.renseignee]: { not: null } } : "vrai" in partage ? { [partage.vrai]: true } : { statut: { not: partage.statutNon } });
  return c;
}

/** Curseur de pagination `(createdAt, id)` decroissant, valide par `decoderCurseurConflit` (curseurs.noyau.ts). */
export const clauseCurseur = (curseur?: { t: Date; i: string }): Clause[] =>
  curseur ? [{ OR: [{ createdAt: { lt: curseur.t } }, { createdAt: curseur.t, id: { lt: curseur.i } }] }] : [];

/** Aujourd'hui a minuit UTC (echeance depassee : strictement avant). */
export const minuitUtc = (): Date => new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
