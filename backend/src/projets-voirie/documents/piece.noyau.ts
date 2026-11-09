/**
 * PIECE D'UN DOCUMENT (noyau pur, lot D1 ; contrat CONTRAT-DOCUMENTS.md, sections 5 et 7). Le fichier televerse n'est JAMAIS conserve : on en lit le
 * format par sa SIGNATURE (jamais par l'extension) et on en calcule l'empreinte ; aucun octet n'est ecrit ni en base ni sur disque.
 *
 * Formats admis comme fichier : PDF (`%PDF-`) et DWG (`AC10xx`). Tout autre contenu est refuse (415) : un plan geographique passe par l'import (jeu de
 * donnees en quarantaine), puis se lie au document par `jeuId`.
 */

import { createHash } from "node:crypto";
import { AIDE_DWG, AIDE_PDF } from "./etats.noyau";

export type FormatFichierDocument = "PDF" | "DWG";

export function detecterFormatPiece(b: Buffer): FormatFichierDocument | null {
  if (b.length >= 5 && b.subarray(0, 5).toString("latin1") === "%PDF-") return "PDF";
  if (b.length >= 6 && /^AC10\d\d$/.test(b.subarray(0, 6).toString("latin1"))) return "DWG";
  return null;
}

export const empreinteSha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** Nom de fichier conserve : 255 caracteres au plus, sans caractere de controle ni chemin (seul le dernier segment). */
export function nomFichierSur(nom: string): string {
  const dernier = nom.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const propre = dernier.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 255);
  return propre || "fichier";
}

export interface AvertissementDocument { code: "DWG_NON_EXPLOITABLE" | "PDF_REFERENCE" | "JEU_NON_AUTORISE"; message: string }

/** Avertissements d'un depot de piece (jamais bloquants : le depot est conserve, statut RECU). */
export function avertissementsPiece(p: { format: string | null; jeuId: string | null; jeuStatut: string | null }): AvertissementDocument[] {
  const a: AvertissementDocument[] = [];
  if (p.format === "DWG") a.push({ code: "DWG_NON_EXPLOITABLE", message: AIDE_DWG });
  if (p.format === "PDF") a.push({ code: "PDF_REFERENCE", message: AIDE_PDF });
  if (p.jeuId !== null && p.jeuStatut !== "AUTORISE") a.push({ code: "JEU_NON_AUTORISE", message: `Le jeu lie est en ${p.jeuStatut ?? "statut inconnu"} : la piece ne deviendra exploitable qu'une fois le jeu autorise.` });
  return a;
}
