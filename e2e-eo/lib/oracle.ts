import { connecter, td, type Reponse } from "./api";
import { compter, requete } from "./base";
import type { CompteRun } from "./donnees";

/**
 * Sources de verite INDEPENDANTES de l'ecran : l'API REELLE (jeton du meme compte) et des comptages SQL DIRECTS. L'ecran n'est jamais
 * compare a une constante : il est compare a ce que le serveur et la base disent au moment du test.
 */

const jetons = new Map<string, { jeton: string; le: number }>();
/** Jeton d'acces d'un compte (renouvele apres 10 minutes : il expire a 15). */
export async function jeton(c: CompteRun): Promise<string> {
  const j = jetons.get(c.email);
  if (j && Date.now() - j.le < 10 * 60_000) return j.jeton;
  const t = await connecter(c);
  jetons.set(c.email, { jeton: t, le: Date.now() });
  return t;
}

export async function api<T = any>(c: CompteRun, methode: string, chemin: string, corps?: unknown): Promise<Reponse<T>> {
  return td<T>(await jeton(c), methode, chemin, corps);
}

export interface ComptesSql { aVerifier: number; enAttente: number; nonConcluantes: number; confirmees: number; infirmees: number; prioritaires: number; total: number }

/** Comptages directs des propositions (donnees non synthetiques), eventuellement limites a des regions. */
export async function comptesSql(regions: number[] | null = null): Promise<ComptesSql> {
  const filtre = regions ? `AND "regionId" = ANY($1::int[])` : "";
  const p = regions ? [regions] : [];
  const n = (statut: string) => compter(`SELECT count(*) FROM propositions_teledetection WHERE NOT synthetique AND statut = '${statut}' ${filtre}`, p);
  return {
    aVerifier: await n("A_VERIFIER"), enAttente: await n("EN_ATTENTE"), nonConcluantes: await n("NON_CONCLUANTE"),
    confirmees: await n("CONFIRMEE"), infirmees: await n("INFIRMEE"),
    prioritaires: await compter(`SELECT count(*) FROM propositions_teledetection WHERE NOT synthetique AND "prioriteNiveau" = 'HAUTE' AND statut IN ('A_VERIFIER','EN_ATTENTE','NON_CONCLUANTE') ${filtre}`, p),
    total: await compter(`SELECT count(*) FROM propositions_teledetection WHERE NOT synthetique ${filtre}`, p),
  };
}

export interface LignePropositionSql {
  id: string; type: string; statut: string; prioriteNiveau: string | null; tronconId: string | null; regionId: number | null; missionId: string | null;
  motifAttente: string | null; constatRef: string | null; verifieeParId: string | null; motifVerdict: string | null; dateAcquisition: Date;
  tronconCode: string | null;
}

export function propositionsSql(where = "TRUE", params: unknown[] = []): Promise<LignePropositionSql[]> {
  return requete<LignePropositionSql>(
    `SELECT pt.id, pt.type, pt.statut, pt."prioriteNiveau", pt."tronconId", pt."regionId", pt."missionId", pt."motifAttente", pt."constatRef",
            pt."verifieeParId", pt."motifVerdict", p."dateAcquisition", t.code AS "tronconCode"
       FROM propositions_teledetection pt JOIN earth_observation_products p ON p.id = pt."produitId" LEFT JOIN troncons t ON t.id = pt."tronconId"
      WHERE NOT pt.synthetique AND (${where}) ORDER BY p."dateAcquisition" DESC, pt.id`, params);
}

export interface LigneJournal { de: string; vers: string; auteurId: string; motif: string; commentaire: string | null; motifAttente: string | null }
export function journalDe(propositionId: string): Promise<LigneJournal[]> {
  return requete<LigneJournal>(
    `SELECT de, vers, "auteurId", motif, commentaire, "motifAttente" FROM propositions_teledetection_transitions WHERE "propositionId" = $1 ORDER BY "creeLe", id`, [propositionId]);
}

export async function lignesJournalTotal(): Promise<number> {
  return compter(`SELECT count(*) FROM propositions_teledetection_transitions`);
}

/** Formate comme l'ecran (`formaterDate` : jour calendaire UTC, fr-FR). */
export function dateEcran(d: Date | string): string {
  return new Date(d).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export const LIBELLE_TYPE: Record<string, string> = { NOUVELLE_ROUTE: "Nouvelle route", COUPURE_PROBABLE: "Coupure probable", VEGETATION: "Végétation", INONDATION: "Inondation" };
