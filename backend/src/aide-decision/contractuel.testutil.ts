/**
 * Fabriques de lignes SYNTHETIQUES pour les tests du suivi contractuel (noyau, service, routes). Jamais importe par du code de
 * production. Les valeurs sont celles d'un jeu de test (contrat §10), aucune ne vient de la base.
 */
import type { ChantierEntree, DecompteEntree, LienEntree, MarcheEntree, TronconEntree } from "./contractuel.noyau";

export const T0 = new Date("2026-10-26T12:00:00.000Z");
export const jours = (n: number): Date => new Date(T0.getTime() + n * 86_400_000);

export const troncon = (o: Partial<TronconEntree> = {}): TronconEntree => ({
  id: "t1", code: "RN1-1", nom: "Route 1", regionId: 1, classe: "RN", etat: "MOYEN", archive: false, ...o,
});

export const chantier = (o: Partial<ChantierEntree> = {}): ChantierEntree => ({
  id: "c1", intitule: "Chantier 1", entreprise: "SOGEA", bailleur: null, regionId: 1, tronconId: "t1", troncon: troncon(),
  avancementPct: 40, statut: "EN_COURS", dateDebutPrevue: null, dateFinPrevue: null, dateDebutReelle: null, dateFinReelle: null,
  numContrat: null, archive: false, nbMarches: 1, ...o,
});

export const lien = (o: Partial<LienEntree> = {}): LienEntree => ({ chantier: chantier(), tronconId: null, troncon: null, ...o });

export const decompte = (o: Partial<DecompteEntree> = {}): DecompteEntree => ({
  id: "d1", numero: 1, type: "DECOMPTE", statut: "EMIS", montantGnf: BigInt(100), dateEmission: null, datePaiement: null, updatedAt: jours(-5), ...o,
});

export const marche = (o: Partial<MarcheEntree> = {}): MarcheEntree => ({
  id: "m1", intitule: "Marché 1", statut: "EN_COURS", devise: "GNF", montantTotal: BigInt(1_000_000),
  bailleurId: 1, bailleurNom: "BAD", bailleurType: "multilateral",
  dateSignature: null, dateDebutPrevue: null, dateFinPrevue: null, dateReceptionProvisoire: null, garantieBonneExecutionExp: null, tauxPenaliteRetardPct: null,
  createdAt: jours(-100), updatedAt: jours(-10), liens: [lien()], decomptes: [], avancements: [], ...o,
});
