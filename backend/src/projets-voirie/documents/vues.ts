/**
 * Vues des documents d'un projet (lot D1). AUCUN contenu de fichier (il n'est jamais conserve) ni geometrie. Le jeu lie n'est rendu que s'il est lisible
 * par le compte (`jeuLisible` : jamais un jeu RETIRE ; pour un compte qui ne decide pas, seulement AUTORISE).
 */

import type { StatutDocumentProjetVoirie } from "@prisma/client";
import { jeuLisible } from "../conflits/visibilite.noyau";
import { estDecideur } from "../conflits/types.noyau";
import { AIDE_DWG, AIDE_PDF, exploitabilite, transitionsDemandables } from "./etats.noyau";

export interface LigneDocument {
  id: string; projetId: string; ligneeId: string; version: number; remplaceId: string | null; typeCode: string; titre: string; description: string | null;
  dateDocument: Date | null; concessionnaireId: string | null; statut: StatutDocumentProjetVoirie; reference: string | null; nomFichier: string | null;
  format: string | null; sha256: string | null; tailleOctets: number | null; jeuId: string | null; creeParId: string; createdAt: Date;
  deposeParId: string | null; deposeLe: Date | null; valideParId: string | null; valideLe: Date | null;
  derniereActionParId: string; derniereActionLe: Date; derniereJustification: string | null; updatedAt: Date; deletedAt: Date | null;
}

const jour = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

/** Instantane pour l'audit (avant/apres) : la ligne sans rien d'autre (aucun contenu de fichier n'existe). */
export function instantaneDocument(l: LigneDocument) {
  return {
    id: l.id, projetId: l.projetId, ligneeId: l.ligneeId, version: l.version, remplaceId: l.remplaceId, typeCode: l.typeCode, titre: l.titre, statut: l.statut,
    reference: l.reference, nomFichier: l.nomFichier, format: l.format, sha256: l.sha256, tailleOctets: l.tailleOctets, jeuId: l.jeuId, concessionnaireId: l.concessionnaireId,
    deposeParId: l.deposeParId, valideParId: l.valideParId, justification: l.derniereJustification, deletedAt: l.deletedAt,
  };
}

/**
 * Revue D1, m4 : details d'une ligne d'historique (ecrits par la base : format, empreinte, nom du fichier, reference, jeu lie). Quand le jeu lie n'est pas
 * lisible par le compte (jamais un jeu RETIRE, meme pour un decideur), son identifiant, le nom de son fichier et son format sont retires.
 */
export function detailsHistoriqueVisibles(details: unknown, jeuLisible: boolean): unknown {
  if (!details || typeof details !== "object" || Array.isArray(details)) return details;
  const d = details as Record<string, unknown>;
  if (jeuLisible || typeof d.jeuId !== "string") return details;
  const { jeuId: _j, nomFichier: _n, format: _f, ...reste } = d;
  void _j; void _n; void _f;
  return { ...reste, jeuMasque: true };
}

/** Revue D1, m7 : lignes lues en ordre DECROISSANT avec `max + 1` au plus : garde les `max` plus recentes, rendues en ordre croissant, troncature dite. */
export function bornerDecroissant<T>(lignesDecroissantes: readonly T[], max: number): { lignes: T[]; tronque: boolean } {
  return { lignes: lignesDecroissantes.slice(0, max).reverse(), tronque: lignesDecroissantes.length > max };
}

export interface ContexteVue {
  role: string;
  type: { code: string; libelle: string; actif: boolean; deletedAt: Date | null } | null;
  concessionnaire: { id: string; nom: string } | null;
  jeu: { id: string; statut: string; role: string; version: number; format: string } | null;
  personnes: Map<string, { id: string; nomComplet: string }>;
}

export function vueDocument(l: LigneDocument, c: ContexteVue) {
  const personne = (id: string | null) => (id ? c.personnes.get(id) ?? { id, nomComplet: null } : null);
  const jeuVisible = c.jeu && jeuLisible(c.role, c.jeu.statut) ? { id: c.jeu.id, statut: c.jeu.statut, role: c.jeu.role, version: c.jeu.version, format: c.jeu.format } : null;
  const decide = estDecideur(c.role);
  // Revue D1, m5 : l'exploitabilite d'une piece liee a un jeu que le compte ne voit pas trahirait le statut du jeu : elle n'est pas rendue (nulle).
  const jeuIllisible = l.jeuId !== null && !jeuVisible;
  const x = jeuIllisible ? null : exploitabilite({ format: l.format, jeuId: l.jeuId, jeuStatut: c.jeu?.statut ?? null });
  return {
    id: l.id, projetId: l.projetId, ligneeId: l.ligneeId, version: l.version, remplaceId: l.remplaceId,
    typeCode: l.typeCode, type: c.type ? { code: c.type.code, libelle: c.type.libelle, actif: c.type.actif && !c.type.deletedAt } : null,
    titre: l.titre, description: l.description, dateDocument: jour(l.dateDocument),
    concessionnaire: c.concessionnaire ? { id: c.concessionnaire.id, nom: c.concessionnaire.nom } : null,
    statut: l.statut,
    // Le jeu lie d'une piece n'est designe que s'il est lisible : sinon ni son identifiant ni son format ne sont rendus.
    piece: {
      reference: l.reference, nomFichier: l.jeuId && !jeuVisible ? null : l.nomFichier, format: l.jeuId && !jeuVisible ? null : l.format,
      // Un compte qui ne decide pas n'apprend pas qu'un jeu qu'il ne voit plus etait lie (nul : inconnu pour lui).
      sha256: l.sha256, tailleOctets: l.tailleOctets, jeuLie: jeuIllisible && !decide ? null : l.jeuId !== null,
    },
    jeu: jeuVisible,
    exploitable: x,
    aide: l.format === "DWG" ? AIDE_DWG : l.format === "PDF" ? AIDE_PDF : null,
    creePar: personne(l.creeParId), createdAt: l.createdAt,
    deposePar: personne(l.deposeParId), deposeLe: l.deposeLe,
    validePar: personne(l.valideParId), valideLe: l.valideLe,
    derniereAction: { par: personne(l.derniereActionParId), le: l.derniereActionLe, justification: decide ? l.derniereJustification : null },
    ...(decide ? { transitionsPossibles: transitionsDemandables(l.statut) } : {}),
  };
}
