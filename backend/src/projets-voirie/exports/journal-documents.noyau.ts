/**
 * JOURNAL DES DOCUMENTS DU DOSSIER TECHNIQUE (noyau pur, lot X1 ; contrat CONTRAT-EXPORTS.md, section 4.2).
 *
 * Entrees : les vues des documents du lot D1 (deja masquees pour le compte : jeu lie rendu seulement s'il est lisible) et les lignes d'historique ecrites
 * par la base. Ce noyau masque, dans les DETAILS d'historique, ce qui designe un jeu non lisible (jamais un jeu RETIRE : identifiant, nom de fichier,
 * format), puis produit le JSON et le CSV. Le CSV passe chaque cellule par `celluleCsv` (neutralisation des formules : =, +, -, @, tabulation, retour).
 */

import { celluleCsv } from "../analyse.service";

export interface LigneHistoriqueDoc {
  id: number; documentId: string; version: number; action: string; statutAvant: string | null; statutApres: string;
  par: { id: string; nomComplet: string | null }; justification: string | null; details: unknown; le: Date;
}

export interface VueDocumentJournal {
  id: string; ligneeId: string; version: number; typeCode: string; titre: string; statut: string;
  piece: { reference: string | null; nomFichier: string | null; format: string | null; sha256: string | null };
}

/** Details d'une ligne d'historique sans ce qui designe un jeu non lisible par le compte. */
export function masquerDetails(details: unknown, jeuxLisibles: ReadonlySet<string>): Record<string, unknown> {
  if (!details || typeof details !== "object" || Array.isArray(details)) return {};
  const d = { ...(details as Record<string, unknown>) };
  if (typeof d.jeuId === "string" && !jeuxLisibles.has(d.jeuId)) {
    delete d.jeuId; delete d.nomFichier; delete d.format;
    d.jeuMasque = true;
  }
  return d;
}

export const ENTETE_CSV_JOURNAL = [
  "documentId", "ligneeId", "version", "typeCode", "titre", "statutCourant", "action", "statutAvant", "statutApres", "par", "le", "justification",
  "reference", "nomFichier", "format", "sha256",
] as const;

/** CSV du journal : une ligne par geste (historique), avec les informations courantes du document ; neutralise contre l'injection de formules. */
export function journalCsv(documents: readonly VueDocumentJournal[], historique: readonly LigneHistoriqueDoc[], jeuxLisibles: ReadonlySet<string>): string {
  const parId = new Map(documents.map((d) => [d.id, d]));
  const lignes = historique.map((h) => {
    const d = parId.get(h.documentId);
    const det = masquerDetails(h.details, jeuxLisibles);
    const txt = (v: unknown) => (typeof v === "string" ? v : "");
    return [
      h.documentId, d?.ligneeId ?? "", h.version, d?.typeCode ?? "", d?.titre ?? "", d?.statut ?? "", h.action, h.statutAvant ?? "", h.statutApres,
      h.par.nomComplet ?? h.par.id, h.le.toISOString(), h.justification ?? "", txt(det.reference), txt(det.nomFichier), txt(det.format), txt(det.sha256),
    ];
  });
  return "﻿" + [ENTETE_CSV_JOURNAL.join(";"), ...lignes.map((l) => l.map((v) => celluleCsv(v as string | number)).join(";"))].join("\r\n") + "\r\n";
}
