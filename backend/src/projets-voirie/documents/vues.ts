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
  const x = exploitabilite({ format: l.format, jeuId: l.jeuId, jeuStatut: c.jeu?.statut ?? null });
  const decide = estDecideur(c.role);
  return {
    id: l.id, projetId: l.projetId, ligneeId: l.ligneeId, version: l.version, remplaceId: l.remplaceId,
    typeCode: l.typeCode, type: c.type ? { code: c.type.code, libelle: c.type.libelle, actif: c.type.actif && !c.type.deletedAt } : null,
    titre: l.titre, description: l.description, dateDocument: jour(l.dateDocument),
    concessionnaire: c.concessionnaire ? { id: c.concessionnaire.id, nom: c.concessionnaire.nom } : null,
    statut: l.statut,
    // Le jeu lie d'une piece n'est designe que s'il est lisible : sinon ni son identifiant ni son format ne sont rendus.
    piece: {
      reference: l.reference, nomFichier: l.jeuId && !jeuVisible ? null : l.nomFichier, format: l.jeuId && !jeuVisible ? null : l.format,
      sha256: l.sha256, tailleOctets: l.tailleOctets, jeuLie: l.jeuId !== null,
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
