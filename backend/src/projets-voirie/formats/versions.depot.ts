/**
 * Acces base du DELTA DE VERSIONS et du statut des SUPPRESSIONS (lot A1). Contrat : docs/projets-voirie/CONTRAT-IMPORT.md, section 8.
 * Ce module n'importe pas `projets.service.ts` (qui l'appelle pour garder l'autorisation) : aucun cycle.
 *
 * Le statut des suppressions est a part du statut du jeu : `AUCUNE` (rien n'est retire), `A_REVOIR`, `ACCEPTEES`, `REFUSEES`. Il se lit dans
 * le dernier evenement de revue du jeu, et ne vaut que pour l'ensemble retire EXACT sur lequel la revue a porte (empreinte du delta).
 */

import type { Prisma } from "@prisma/client";
import { ErreurMetier } from "../erreurs";
import { calculerDeltaDetaille, cleDe, type DeltaDetaille, type ObjetDelta } from "./delta-detaille.noyau";

type Tx = Prisma.TransactionClient;

export type StatutSuppressions = "AUCUNE" | "A_REVOIR" | "ACCEPTEES" | "REFUSEES";

export interface RevueSuppressions {
  par: { id: string; nomComplet: string } | null;
  le: Date;
  decision: "ACCEPTER" | "REFUSER";
  justification: string;
}

/** Colonne `identifiant` du mapping enregistre dans `resume.import.mapping`, ou `null`. */
export function colonneIdentifiant(resume: unknown): string | null {
  const c = (resume as { import?: { mapping?: { identifiant?: unknown } } } | null)?.import?.mapping?.identifiant;
  return typeof c === "string" && c !== "" ? c : null;
}

export async function chargerObjetsDelta(tx: Tx, jeuId: string, colonne: string | null): Promise<ObjetDelta[]> {
  const l = await tx.$queryRaw<{ id: string; nom: string | null; empreinte: string; attr: string | null }[]>`
    SELECT "id"::text AS "id", "nom", "empreinte",
           CASE WHEN ${colonne}::text IS NULL THEN NULL ELSE "attributs" ->> ${colonne}::text END AS "attr"
      FROM "projets_voirie_objets" WHERE "jeuId" = ${jeuId} ORDER BY "ordre"`;
  return l.map((x) => ({
    cle: colonne !== null ? cleDe(x.nom, { [colonne]: x.attr }, colonne) : cleDe(x.nom, null, null),
    nom: x.nom, empreinte: x.empreinte, ref: x.id,
  }));
}

export interface DeltaJeux extends DeltaDetaille {
  cleComparaison: "identifiant" | "nom";
}

/** Delta entre un jeu (le nouveau) et celui qu'il remplace (l'ancien) : les deux se lisent en base, objets immuables. */
export async function deltaEntreJeux(tx: Tx, nouveau: { id: string; colonneId: string | null }, ancien: { id: string; resume: unknown }): Promise<DeltaJeux> {
  const ca = colonneIdentifiant(ancien.resume);
  const colonne = nouveau.colonneId !== null && ca !== null ? { nouveau: nouveau.colonneId, ancien: ca } : null;
  const [n, a] = await Promise.all([
    chargerObjetsDelta(tx, nouveau.id, colonne?.nouveau ?? null),
    chargerObjetsDelta(tx, ancien.id, colonne?.ancien ?? null),
  ]);
  return { ...calculerDeltaDetaille(n, a), cleComparaison: colonne ? "identifiant" : "nom" };
}

const TYPES_REVUE = ["SUPPRESSIONS_ACCEPTEES", "SUPPRESSIONS_REFUSEES"] as const;

export async function statutSuppressions(tx: Tx, jeuId: string, delta: Pick<DeltaDetaille, "retires" | "empreinteRetires"> | null): Promise<{ statut: StatutSuppressions; nb: number; revue: RevueSuppressions | null }> {
  if (!delta || delta.retires === 0) return { statut: "AUCUNE", nb: 0, revue: null };
  const e = await tx.evenementImportProjet.findFirst({ where: { jeuId, type: { in: [...TYPES_REVUE] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  if (!e) return { statut: "A_REVOIR", nb: delta.retires, revue: null };
  const acteur = await tx.user.findUnique({ where: { id: e.acteurId }, select: { id: true, nomComplet: true } });
  const revue: RevueSuppressions = { par: acteur, le: e.createdAt, decision: e.type === "SUPPRESSIONS_ACCEPTEES" ? "ACCEPTER" : "REFUSER", justification: e.justification };
  // Une revue ne couvre que l'ensemble retire sur lequel elle a porte : un autre contenu est de nouveau « a revoir ».
  if ((e.details as { empreinteDelta?: unknown } | null)?.empreinteDelta !== delta.empreinteRetires) return { statut: "A_REVOIR", nb: delta.retires, revue };
  return { statut: e.type === "SUPPRESSIONS_ACCEPTEES" ? "ACCEPTEES" : "REFUSEES", nb: delta.retires, revue };
}

/**
 * Garde de l'AUTORISATION : un jeu qui remplace un jeu autorise ne s'autorise que si ses suppressions ont ete acceptees par une revue
 * humaine. 409 `SUPPRESSIONS_A_REVOIR` ou `SUPPRESSIONS_REFUSEES` sinon. Aucune suppression n'est jamais appliquee « par defaut ».
 */
export async function verifierSuppressionsRevues(tx: Tx, jeu: { id: string; resume: unknown }, ancienAutorise: { id: string; resume: unknown }): Promise<void> {
  const delta = await deltaEntreJeux(tx, { id: jeu.id, colonneId: colonneIdentifiant(jeu.resume) }, ancienAutorise);
  if (delta.retires === 0) return;
  const s = await statutSuppressions(tx, jeu.id, delta);
  if (s.statut === "ACCEPTEES") return;
  if (s.statut === "REFUSEES") {
    throw new ErreurMetier(409, "SUPPRESSIONS_REFUSEES", "La revue des suppressions de cette version est un refus : elle ne peut plus qu'etre rejetee ou retiree, ou remplacee par un fichier corrige.", { jeuId: jeu.id, nb: delta.retires });
  }
  throw new ErreurMetier(409, "SUPPRESSIONS_A_REVOIR",
    `Cette version retire ${delta.retires} objet(s) de la version autorisee : une revue explicite des suppressions (acceptation justifiee) est exigee avant l'autorisation. Aucune suppression n'est appliquee sans revue.`,
    { jeuId: jeu.id, nb: delta.retires });
}
