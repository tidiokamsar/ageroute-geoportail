/**
 * PROPOSITION D'ASSOCIATION circuit logique -> infrastructure physique par SUPERPOSITION GEOMETRIQUE (lot B1 ; cahier v2, 20.1, 20.3, 22.2 point 5).
 *
 * UNE PROPOSITION N'EST PAS UNE ASSOCIATION. Une simple proximite ne prouve pas qu'un circuit est porte par une infrastructure : ce service
 * n'ecrit que des relations au statut PROPOSEE, origine AUTOMATIQUE, qui n'ont aucun effet (le comptage ne les prend pas pour un support
 * valide) tant qu'une personne identifiee ne les a pas VALIDEES avec justification (relations.service.ts). Une proposition deja connue, quel
 * que soit son statut (refusee, validee, revoquee), n'est JAMAIS reecrite : une proposition refusee ne revient pas.
 *
 * METHODE (enregistree dans chaque proposition) :
 *   - tolerance du couple = MAXIMUM de la tolerance de la classe de precision de chaque objet et de leurs precisions horizontales declarees
 *     (jamais leur somme : cahier 21.1) ; tolerances par classe configurables (config.ts), PROVISOIRES, a valider par la DSI ;
 *   - un circuit est propose pour une infrastructure si au moins `couvertureMin` de sa longueur est a moins de cette tolerance (UTM) ;
 *   - la classe E (« inconnue / sans geometrie ») est EXCLUE : pas de faux trace ; les deux objets doivent etre de meme type de reseau ;
 *   - au plus `parCircuitMax` propositions par circuit (les mieux couvertes) : un humain choisit.
 *
 * GARDES : jeux AUTORISE seulement ; verrou du projet (503 PROJET_OCCUPE) ; 3 calculs simultanes au plus par processus (503 SERVICE_OCCUPE) ;
 * delai cote BASE (504 ASSOCIATION_TROP_LONGUE) ; plafond de circuits (422 TROP_DE_CIRCUITS) ; cadence par projet (429 ASSOCIATION_TROP_FREQUENTE).
 * Aucune geometrie dans l'audit ni dans la reponse.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma";
import { logAuditTransactionnelle } from "../../utils/audit";
import { Budget, avecErreurDelai } from "../bd";
import { delaiAnalyseMs, delaiDepotMs, delaiVerrouMs } from "../config";
import { contexteSpatialDuProjet } from "../territoires/contexte-spatial";
import * as socle from "../analyse.depot";
import { verifierCadence } from "../conflits/cadence.noyau";
import { ErreurMetier, introuvable } from "../erreurs";
import { limiteurAnalyses } from "../limiteurs";
import { verrouillerProjet, type Acteur } from "../projets.service";
import { avecTraductionBase, exigerProjetActif } from "./commun";
import { associationIntervalleMinS, circuitsParExecutionMax, couvertureMinAssociation, propositionsParCircuitMax, tolerancesAssociation } from "./config";
import * as depot from "./reseaux.depot";
import { classeExclue, retenirPropositions, toleranceAssociation, type TableTolerances } from "./relations.noyau";
import type { ClassePrecision } from "./types.noyau";

export const VERSION_ASSOCIATION = "ASSOC-0.1";
/** Propositions au plus par execution (au-dela : `tronque`). */
export const PROPOSITIONS_MAX = 10_000;
const LOT = 500;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

export interface DemandeAssociation {
  /** Restreint les circuits examines a ce jeu (les infrastructures candidates viennent de tous les jeux autorises du projet). */
  jeuId?: string;
  couvertureMin?: number;
  parCircuitMax?: number;
  /** Tolerances par classe, fusionnees sur celles du serveur (config.ts). */
  tolerances?: Partial<Record<keyof TableTolerances, number>>;
}

async function exigerCadence(lecteur: Pick<typeof prisma, "auditLog">, projetId: string): Promise<void> {
  const derniere = await lecteur.auditLog.findFirst({ where: { entityType: "AssociationsReseau", entityId: projetId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  const v = verifierCadence({ derniereTermineeLe: derniere?.createdAt ?? null, maintenant: new Date(), intervalleS: associationIntervalleMinS() });
  if (!v.ok) {
    throw new ErreurMetier(429, "ASSOCIATION_TROP_FREQUENTE",
      `Une proposition d'associations de ce projet date de moins de ${associationIntervalleMinS()} s : réessayez dans ${v.retryAfterS} s (le résultat serait identique tant que les données ne changent pas).`,
      { retryAfterS: v.retryAfterS });
  }
}

export async function proposerAssociations(acteur: Acteur, projetId: string, d: DemandeAssociation) {
  await exigerProjetActif(projetId);
  await exigerCadence(prisma, projetId);
  // Lot T1 : CRS metrique du territoire du projet, sinon regle par bandes de la configuration nationale.
  const ctx = await contexteSpatialDuProjet(projetId);

  const tolerances: TableTolerances = { ...tolerancesAssociation(), ...(d.tolerances ?? {}) };
  const couvertureMin = d.couvertureMin ?? couvertureMinAssociation();
  const parCircuitMax = d.parCircuitMax ?? propositionsParCircuitMax();

  const jeux = await prisma.jeuDonneesProjet.findMany({
    where: { projetId, role: { in: ["RESEAU_TIERS", "AUTRE"] }, statut: { not: "RETIRE" } }, select: { id: true, statut: true },
  });
  if (d.jeuId) {
    const j = jeux.find((x) => x.id === d.jeuId);
    if (!j) throw introuvable("Jeu de données", "JEU_INTROUVABLE");
    if (j.statut !== "AUTORISE") {
      throw new ErreurMetier(409, "JEU_NON_AUTORISE", "Les propositions d'association ne portent que sur des jeux autorisés : autorisez d'abord ce jeu.", { statut: j.statut });
    }
  }
  const autorises = jeux.filter((j) => j.statut === "AUTORISE").map((j) => j.id);
  const jeuxCircuits = d.jeuId ? [d.jeuId] : autorises;

  const delai = delaiAnalyseMs();
  const trop = () => new ErreurMetier(504, "ASSOCIATION_TROP_LONGUE", `La proposition d'associations a dépassé ${Math.round(delai / 1000)} s et a été interrompue : restreignez-la à un jeu (jeuId).`);

  return avecTraductionBase(() => limiteurAnalyses.executer(() => avecErreurDelai("ASSOCIATION_TROP_LONGUE", trop().message, () => prisma.$transaction(async (tx) => {
    await verrouillerProjet(tx, projetId);
    // Deux demandes simultanees : la seconde passe ici apres la premiere (verrou du projet) et voit sa ligne d'audit.
    await exigerCadence(tx, projetId);
    const budget = new Budget(tx, delai, delaiVerrouMs(), trop);

    const eligibles = await budget.etape(() => depot.compterEligibles(tx, { jeuxCircuits, jeuxInfra: autorises }), "eligibles");
    if (eligibles.circuits > circuitsParExecutionMax()) {
      throw new ErreurMetier(422, "TROP_DE_CIRCUITS", `${eligibles.circuits} circuits logiques à examiner, maximum ${circuitsParExecutionMax()} par exécution : restreignez la proposition à un jeu (jeuId).`, { circuits: eligibles.circuits, maximum: circuitsParExecutionMax() });
    }
    const etendue = eligibles.circuits > 0 && eligibles.infrastructures > 0 ? await budget.etape(() => socle.etendueLongitude(tx, autorises), "etendue") : null;
    const epsg = etendue ? ctx.epsgPour((etendue.ouest + etendue.est) / 2) : ctx.epsgDefaut;
    const bruts = eligibles.circuits > 0 && eligibles.infrastructures > 0
      ? await budget.etape(() => depot.candidatsAssociation(tx, { jeuxCircuits, jeuxInfra: autorises, epsg, tolerances, couvertureMin, parCircuitMax, limite: PROPOSITIONS_MAX + 1 }), "candidats")
      : [];
    const tronque = bruts.length > PROPOSITIONS_MAX;
    const candidats = retenirPropositions(tronque ? bruts.slice(0, PROPOSITIONS_MAX) : bruts, parCircuitMax);
    const parCouple = new Map(bruts.map((b) => [`${b.circuitId}>${b.infraId}`, b] as const));

    const lot: depot.PropositionAEcrire[] = candidats.map((c) => {
      const b = parCouple.get(`${c.circuitId}>${c.infraId}`)!;
      if (classeExclue(b.classeCircuit as ClassePrecision | null) || classeExclue(b.classeInfra as ClassePrecision | null)) throw new Error("classe E retenue : incoherence interne");
      const t = toleranceAssociation({
        classeCircuit: b.classeCircuit as ClassePrecision | null, classeInfra: b.classeInfra as ClassePrecision | null,
        precisionCircuitM: b.precisionCircuitM, precisionInfraM: b.precisionInfraM, table: tolerances,
      });
      // La base et le noyau calculent la meme tolerance : un ecart serait un defaut, pas une donnee (ne jamais ecrire une proposition incoherente).
      if (Math.abs(t.toleranceM - b.toleranceM) > 1e-6) throw new Error(`tolerance incoherente entre la base (${b.toleranceM}) et le noyau (${t.toleranceM})`);
      return {
        id: randomUUID(), source: c.circuitId, cible: c.infraId,
        proposition: JSON.stringify({
          methode: "SUPERPOSITION_TOLERANCE", version: VERSION_ASSOCIATION, statutParametres: "PROVISOIRE_A_VALIDER",
          toleranceM: t.toleranceM, composantes: t.composantes, methodeTolerance: t.methode,
          couverture: r4(b.couverture), couvertureMin, longueurCircuitM: r2(b.longueurCircuitM), longueurDansToleranceM: r2(b.longueurDansToleranceM),
          projection: `EPSG:${epsg}`,
        }),
      };
    });
    const creees: string[] = [];
    for (let i = 0; i < lot.length; i += LOT) creees.push(...await depot.insererPropositions(tx, projetId, acteur.id, lot.slice(i, i + LOT)));

    const bilan = {
      circuitsExamines: eligibles.circuits, infrastructuresExaminees: eligibles.infrastructures,
      classeEExclus: { circuits: eligibles.circuitsClasseE, infrastructures: eligibles.infrastructuresClasseE },
      propositionsCalculees: lot.length, creees: creees.length, dejaConnues: lot.length - creees.length, tronque,
    };
    const parametres = {
      version: VERSION_ASSOCIATION, statut: "PROVISOIRE_A_VALIDER" as const, methodeTolerance: "maximum" as const,
      tolerancesParClasseM: tolerances, couvertureMin, parCircuitMax, projection: `EPSG:${epsg}`, jeuId: d.jeuId ?? null,
    };
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: "CREATE", entityType: "AssociationsReseau", entityId: projetId,
      after: { parametres, bilan, idsCrees: creees.slice(0, 200), geometries: false }, ipAddress: acteur.ip,
    });
    const avertissements = [
      "Ce sont des PROPOSITIONS : aucune association n'est appliquée tant qu'une personne ne l'a pas validée (avec justification).",
      "Une simple superposition géométrique ne prouve pas qu'un circuit est porté par une infrastructure.",
      "Tolérances et seuil de couverture PROVISOIRES, à valider par la DSI (cahier v2, 20.2).",
      ...(bilan.classeEExclus.circuits + bilan.classeEExclus.infrastructures > 0 ? [`${bilan.classeEExclus.circuits + bilan.classeEExclus.infrastructures} objet(s) de classe E exclus : pas de faux tracé.`] : []),
      ...(eligibles.circuits === 0 ? ["Aucun circuit logique linéaire autorisé à examiner : déclarez la nature des objets (descripteur) ou du jeu."] : []),
      ...(eligibles.circuits > 0 && eligibles.infrastructures === 0 ? ["Aucune infrastructure physique linéaire autorisée n'est déclarée : le support des circuits reste inconnu."] : []),
      ...(tronque ? [`Résultat tronqué à ${PROPOSITIONS_MAX} propositions : restreignez la proposition à un jeu (jeuId).`] : []),
    ];
    return { statut: "PROPOSITIONS_A_VALIDER" as const, parametres, bilan, idsCrees: creees.slice(0, 200), avertissements };
  }, { timeout: delai + delaiDepotMs() + 15_000, maxWait: 10_000 }))));
}
