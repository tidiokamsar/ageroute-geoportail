/**
 * Mise en forme des lignes de la base pour l'API (contrat v2). Les `Decimal` Prisma deviennent des nombres, les dates de jour
 * des chaines `AAAA-MM-JJ`. AUCUNE GEOMETRIE ici : les vues de projet et de jeu n'en portent jamais.
 */

import type { Prisma } from "@prisma/client";

type Dec = Prisma.Decimal | null | undefined;
const num = (d: Dec): number | null => (d === null || d === undefined ? null : Number(d));
const jour = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

export interface LigneProjet {
  id: string; code: string; nom: string; commune: string | null; prefecture: string | null; regionId: number | null;
  description: string | null; largeurEmpriseM: Prisma.Decimal; largeurChausseeM: Prisma.Decimal; statutParametres: string;
  creeParId: string; createdAt: Date; updatedAt: Date; deletedAt?: Date | null;
}

export function vueProjet(p: LigneProjet) {
  return {
    id: p.id, code: p.code, nom: p.nom, commune: p.commune, prefecture: p.prefecture, regionId: p.regionId, description: p.description,
    largeurEmpriseM: Number(p.largeurEmpriseM), largeurChausseeM: Number(p.largeurChausseeM), statutParametres: p.statutParametres,
    creeParId: p.creeParId, createdAt: p.createdAt, updatedAt: p.updatedAt,
  };
}

export interface LigneJeu {
  id: string; projetId: string; role: string; concessionnaireId: string | null; typeReseau: string | null; nomFichier: string; format: string;
  sha256: string; tailleOctets: number; nbObjets: number; longueurTotaleM: number; longueurTraceFusionneM: number;
  dateDonnees: Date | null; origineFichier: string | null; classePrecision: string | null;
  precisionHorizontaleM: Dec; precisionVerticaleM: Dec; methode: string | null; dateConstat: Date | null;
  natureObjets: string; confidentialite: string; statut: string; version: number; remplaceId: string | null;
  avertissements: unknown; resume: unknown; decideParId: string | null; decideLe: Date | null; justificationDecision: string | null;
  creeParId: string; createdAt: Date; deletedAt: Date | null;
  concessionnaire?: { id: string; nom: string; typeReseau: string } | null;
  creePar?: { id: string; nomComplet: string } | null;
  decidePar?: { id: string; nomComplet: string } | null;
}

export function vueJeu(j: LigneJeu, options: { sansId?: boolean } = {}) {
  return {
    id: options.sansId ? null : j.id,
    projetId: j.projetId,
    role: j.role,
    concessionnaire: j.concessionnaire ? { id: j.concessionnaire.id, nom: j.concessionnaire.nom, typeReseau: j.concessionnaire.typeReseau } : null,
    concessionnaireId: j.concessionnaireId,
    typeReseau: j.typeReseau,
    nomFichier: j.nomFichier,
    format: j.format,
    sha256: j.sha256,
    tailleOctets: j.tailleOctets,
    nbObjets: j.nbObjets,
    libelleNbObjets: "circuits ou objets du fichier",
    longueurTotaleM: Math.round(j.longueurTotaleM * 100) / 100,
    longueurTraceFusionneM: Math.round(j.longueurTraceFusionneM * 100) / 100,
    dateDonnees: jour(j.dateDonnees),
    origineFichier: j.origineFichier,
    classePrecision: j.classePrecision,
    precisionHorizontaleM: num(j.precisionHorizontaleM),
    precisionVerticaleM: num(j.precisionVerticaleM),
    methode: j.methode,
    dateConstat: jour(j.dateConstat),
    natureObjets: j.natureObjets,
    confidentialite: j.confidentialite,
    statut: j.statut,
    nonAutorise: j.statut === "CONTROLE" || j.statut === "RECU",
    version: j.version,
    remplaceId: j.remplaceId,
    avertissements: j.avertissements,
    resume: j.resume,
    creePar: j.creePar ? { id: j.creePar.id, nomComplet: j.creePar.nomComplet } : null,
    createdAt: j.createdAt,
    decision: j.decideLe
      ? { par: j.decidePar ? { id: j.decidePar.id, nomComplet: j.decidePar.nomComplet } : null, le: j.decideLe, justification: j.justificationDecision }
      : null,
  };
}

/** Relations lues avec un jeu pour en faire une vue. */
export const INCLURE_JEU = {
  concessionnaire: { select: { id: true, nom: true, typeReseau: true } },
  creePar: { select: { id: true, nomComplet: true } },
  decidePar: { select: { id: true, nomComplet: true } },
} as const;
