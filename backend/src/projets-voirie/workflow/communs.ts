/**
 * Socle commun des services du workflow (lot B3) : acteur et profil, transaction d'ecriture du projet, erreurs typees, noms des personnes,
 * historique en ajout seul, cadence et quotas de creation.
 *
 * TOUTE ECRITURE du workflow passe par `transactionProjet` : delais cote base (comme le depot du socle), verification que le projet existe et
 * n'est pas retire (404 pour tous, nationaux compris : le controle territorial laisse passer un compte national sans rien lire), puis un VERROU
 * CONSULTATIF PROPRE AU WORKFLOW du projet : les ecritures d'un meme projet se serialisent (transactions courtes), ce qui rend exacts les
 * plafonds et la cadence sans bloquer les depots ni les analyses (verrous differents).
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { estDelaiDepasse, poserDelais } from "../bd";
import { delaiDepotMs, delaiVerrouMs } from "../config";
import { ErreurMetier, introuvable } from "../erreurs";
import type { Acteur } from "../projets.service";
import { verifierCadenceCreation, verifierQuota } from "./cadence.noyau";
import { creationsParMinute } from "./config";
import type { ProfilEffectif } from "./profils.noyau";
import type { Refus } from "./validation.noyau";
import type { ContexteLecture } from "./visibilite.noyau";

export type Tx = Prisma.TransactionClient;

export interface Rattachement { id: string; projetId: string; concessionnaireId: string }

/** Acteur du workflow : l'acteur du socle, son profil effectif et ses rattachements ACTIFS (tous projets). */
export interface ActeurWorkflow extends Acteur {
  profil: ProfilEffectif;
  referent: boolean;
  rattachements: readonly Rattachement[];
}

/** Concessionnaires rattaches a ce projet (referent) ; vide pour un autre profil. */
export const concessionnairesDuProjet = (a: ActeurWorkflow, projetId: string): string[] =>
  a.referent ? [...new Set(a.rattachements.filter((r) => r.projetId === projetId).map((r) => r.concessionnaireId))] : [];

export const contexteDe = (a: ActeurWorkflow, projetId: string): ContexteLecture => ({ profil: a.profil, concessionnaires: concessionnairesDuProjet(a, projetId) });

/** Leve l'erreur typee d'un refus du noyau (un delai a attendre devient `retryAfterS`). */
export function lever(r: Refus | { ok: true }): void {
  if (r.ok) return;
  const retry = (r as { retryAfterS?: number }).retryAfterS;
  throw new ErreurMetier(r.status, r.code, r.message, retry === undefined ? {} : { retryAfterS: retry });
}

export const PROJET_INTROUVABLE = (): ErreurMetier => introuvable("Projet", "PROJET_INTROUVABLE");

export async function exigerProjetActif(projetId: string): Promise<{ id: string; regionId: number | null }> {
  const p = await prisma.projetVoirie.findFirst({ where: { id: projetId, deletedAt: null }, select: { id: true, regionId: true } });
  if (!p) throw PROJET_INTROUVABLE();
  return p;
}

/** Transaction d'ecriture d'un projet : delais, projet actif, verrou consultatif du workflow. */
export async function transactionProjet<T>(projetId: string, travail: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(async (tx) => {
      await poserDelais(tx, delaiDepotMs(), delaiVerrouMs());
      const p = await tx.projetVoirie.findFirst({ where: { id: projetId, deletedAt: null }, select: { id: true } });
      if (!p) throw PROJET_INTROUVABLE();
      await tx.$queryRaw`SELECT 1 AS "ok" FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`pv-workflow|${projetId}`}, 0))) v`;
      return travail(tx);
    });
  } catch (e) {
    if (estDelaiDepasse(e)) throw new ErreurMetier(503, "PROJET_OCCUPE", "Le projet est occupé par une autre opération : réessayez dans quelques instants.");
    throw e;
  }
}

export interface Personne { id: string; nomComplet: string }

/** Noms des personnes (relations Prisma absentes : une requete pour tous les identifiants d'une page). */
export async function nomsDe(ids: readonly (string | null | undefined)[]): Promise<Map<string, Personne>> {
  const uniques = [...new Set(ids.filter((i): i is string => typeof i === "string"))];
  if (uniques.length === 0) return new Map();
  const l = await prisma.user.findMany({ where: { id: { in: uniques } }, select: { id: true, nomComplet: true } });
  return new Map(l.map((u) => [u.id, u]));
}
export const personneDe = (m: Map<string, Personne>, id: string | null | undefined): Personne | null => (id ? m.get(id) ?? { id, nomComplet: "" } : null);

export const jour = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
export const dateJour = (s: string | null | undefined): Date | null => (s ? new Date(`${s}T00:00:00.000Z`) : null);
export const aujourdhui = (): string => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------------------------------------
// Historique (ajout seul)
// ------------------------------------------------------------------------------------------------

export interface LigneHistorique {
  projetId: string;
  objetType: "DEMANDE" | "TACHE" | "RECOLEMENT";
  objetId: string;
  action: "CREATION" | "MODIFICATION" | "STATUT" | "PREUVE";
  ancienStatut?: string | null;
  nouveauStatut?: string | null;
  justification?: string | null;
  donnees?: Record<string, unknown>;
}

export async function ajouterHistorique(tx: Tx, acteur: ActeurWorkflow, l: LigneHistorique): Promise<void> {
  await tx.historiqueWorkflowProjet.create({
    data: {
      projetId: l.projetId, objetType: l.objetType, objetId: l.objetId, action: l.action, ancienStatut: l.ancienStatut ?? null,
      nouveauStatut: l.nouveauStatut ?? null, justification: l.justification ?? null, acteurId: acteur.id, acteurProfil: acteur.profil,
      donnees: (l.donnees ?? {}) as Prisma.InputJsonValue,
    },
  });
}

export async function lireHistorique(objetType: "DEMANDE" | "TACHE" | "RECOLEMENT", objetId: string) {
  const l = await prisma.historiqueWorkflowProjet.findMany({ where: { objetType, objetId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 1000 });
  const noms = await nomsDe(l.map((h) => h.acteurId));
  return l.map((h) => ({
    id: h.id, action: h.action, ancienStatut: h.ancienStatut, nouveauStatut: h.nouveauStatut, justification: h.justification,
    acteur: personneDe(noms, h.acteurId), acteurProfil: h.acteurProfil, donnees: h.donnees, createdAt: h.createdAt,
  }));
}

// ------------------------------------------------------------------------------------------------
// Cadence et quotas de creation
// ------------------------------------------------------------------------------------------------

/**
 * Cadence : creations de ce compte sur ce projet dans la fenetre (demandes, taches, recolements, preuves). A appeler SOUS le verrou du projet
 * (transactionProjet) : le comptage et l'insertion ne peuvent pas se croiser.
 */
export async function verifierCadence(tx: Tx, acteur: ActeurWorkflow, projetId: string): Promise<void> {
  const plafond = creationsParMinute();
  const maintenant = new Date();
  const depuis = new Date(maintenant.getTime() - 60_000);
  const dates = async (l: Promise<{ createdAt: Date }[]>) => (await l).map((x) => x.createdAt);
  const [a, b, c, d] = await Promise.all([
    dates(tx.demandeConcessionnaire.findMany({ where: { projetId, creeParId: acteur.id, createdAt: { gt: depuis } }, select: { createdAt: true }, orderBy: { createdAt: "desc" }, take: plafond })),
    dates(tx.tacheProjetVoirie.findMany({ where: { projetId, creeParId: acteur.id, createdAt: { gt: depuis } }, select: { createdAt: true }, orderBy: { createdAt: "desc" }, take: plafond })),
    dates(tx.recolementProjetVoirie.findMany({ where: { projetId, creeParId: acteur.id, createdAt: { gt: depuis } }, select: { createdAt: true }, orderBy: { createdAt: "desc" }, take: plafond })),
    dates(tx.preuveWorkflowProjet.findMany({ where: { projetId, auteurId: acteur.id, createdAt: { gt: depuis } }, select: { createdAt: true }, orderBy: { createdAt: "desc" }, take: plafond })),
  ]);
  lever(verifierCadenceCreation({ creationsRecentes: [...a, ...b, ...c, ...d], maintenant, plafond }));
}

export const exigerQuota = (nb: number, max: number, libelle: string): void => lever(verifierQuota({ nb, max, libelle }));
