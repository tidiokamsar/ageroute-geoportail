/**
 * Outils communs aux services des reseaux (lot B1) : lisibilite des jeux par role, projet actif, lectures bornees dans le temps, traduction
 * des refus de la base en erreurs typees. Les regles de lisibilite sont CELLES du socle et de RC-3 (voir conflits/visibilite.noyau.ts) :
 *   - un jeu RETIRE n'est montre a PERSONNE ;
 *   - un jeu autre que AUTORISE n'est montre qu'a ADMIN et GESTIONNAIRE ;
 *   - un jeu AUTORISE est montre a tout compte qui a la cle du module.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { avecErreurDelai, poserDelais } from "../bd";
import { delaiCarteMs, delaiVerrouMs } from "../config";
import { jeuLisible } from "../conflits/visibilite.noyau";
import { ErreurMetier, introuvable } from "../erreurs";

export const STATUTS_JEU = ["RECU", "CONTROLE", "AUTORISE", "REJETE", "REMPLACE", "RETIRE"] as const;

/** Statuts de jeu que ce role peut lire (jamais RETIRE ; un lecteur : AUTORISE seulement). */
export const statutsLisibles = (role: string): string[] => STATUTS_JEU.filter((s) => jeuLisible(role, s));

/** Un objet ne se qualifie, et une relation ne se declare, que sur un jeu vivant : en attente ou autorise. */
export const STATUTS_QUALIFIABLES: readonly string[] = ["RECU", "CONTROLE", "AUTORISE"];

/** Un projet retire (suppression logique) ou inconnu n'existe pour personne, national compris (404 PROJET_INTROUVABLE). */
export async function exigerProjetActif(projetId: string): Promise<{ id: string; code: string; nom: string }> {
  const p = await prisma.projetVoirie.findFirst({ where: { id: projetId, deletedAt: null }, select: { id: true, code: true, nom: true } });
  if (!p) throw introuvable("Projet", "PROJET_INTROUVABLE");
  return p;
}

export const OBJET_INTROUVABLE = (): ErreurMetier => introuvable("Objet de réseau", "OBJET_INTROUVABLE");
export const RELATION_INTROUVABLE = (): ErreurMetier => introuvable("Relation", "RELATION_INTROUVABLE");
export const JEU_INTROUVABLE = (): ErreurMetier => introuvable("Jeu de données", "JEU_INTROUVABLE");

/**
 * Lecture dans une transaction `READ ONLY` dont les requetes sont coupees PAR LA BASE au bout de `PROJETS_VOIRIE_DELAI_CARTE_MS` (10 s par
 * defaut) : 504 LECTURE_TROP_LONGUE, jamais un 500 (revue RC-3 : cadence et bornes).
 */
export async function lireSousDelai<T>(travail: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const delai = delaiCarteMs();
  return avecErreurDelai("LECTURE_TROP_LONGUE", `La lecture a dépassé ${Math.round(delai / 1000)} s et a été interrompue : affinez les filtres.`, () =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await poserDelais(tx, delai, delaiVerrouMs());
      return travail(tx);
    }, { timeout: delai + 15_000, maxWait: 10_000 }));
}

/** Code SQLSTATE et message d'une erreur de requete brute Prisma (meta.code, meta.message). */
function detailBase(e: unknown): { code: string | null; message: string } {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    const m = (e.meta ?? {}) as { code?: unknown; message?: unknown };
    return { code: typeof m.code === "string" ? m.code : null, message: typeof m.message === "string" ? m.message : e.message };
  }
  return { code: null, message: e instanceof Error ? e.message : String(e) };
}

/**
 * Une contrainte ou un declencheur de la base qui refuse une ecriture est une erreur du CLIENT (donnees incoherentes), pas une panne :
 * 422 INCOHERENCE_REFUSEE avec le message de la base (ecrit par le module, sans secret) ; 409 si l'unicite est violee. Toute autre erreur
 * est relancee telle quelle.
 */
export function traduireErreurBase(e: unknown): never {
  const { code, message } = detailBase(e);
  const brut = /message:\s*"?([^"\n]*)"?/i.exec(message)?.[1] ?? message;
  const court = brut.replace(/^ERROR:\s*/i, "").slice(0, 400);
  if (code === "23505") throw new ErreurMetier(409, "DEJA_ENREGISTRE", "Cet enregistrement existe déjà.");
  if (code === "23514" || code === "23001" || code === "23503") throw new ErreurMetier(422, "INCOHERENCE_REFUSEE", `Refusé par la base : ${court}`);
  throw e;
}

/** Execute `travail` en traduisant les refus de la base (voir `traduireErreurBase`). */
export async function avecTraductionBase<T>(travail: () => Promise<T>): Promise<T> {
  try { return await travail(); } catch (e) {
    if (e instanceof ErreurMetier) throw e;
    return traduireErreurBase(e);
  }
}

export const jour = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
export const arrondi2 = (x: number): number => Math.round(x * 100) / 100;
