import { prisma } from "./prisma";
import type { ModuleKey } from "./modules";

export interface CompteAuthentifie {
  id: string;
  role: string;
}

/**
 * Modules auxquels un compte a droit.
 *
 * Renvoie `null` lorsqu'il n'y a AUCUNE restriction — le seul cas est le role ADMIN.
 * Renvoie sinon l'ensemble des cles autorisees, eventuellement vide.
 *
 * UNE LISTE VIDE N'EST PAS UNE AUTORISATION (correction du 05/09/2026)
 *
 * Elle valait « aucune restriction », par report d'un comportement anterieur a
 * l'existence meme des modules. Mesure du 05/09 sur la production : l'unique
 * GESTIONNAIRE et l'unique LECTEUR actifs ont tous deux `modulesAutorises` vide.
 * Le cloisonnement etait donc inopérant pour la totalite des comptes non-ADMIN,
 * pendant que l'interface presentait l'affectation de modules comme une restriction.
 *
 * Le defaut portait sur le sens du vide : un compte que l'on vient de creer, et dont
 * personne n'a encore choisi les modules, obtenait TOUS les modules. Le systeme
 * s'ouvrait exactement au moment ou la configuration avait ete oubliee.
 *
 * Une liste vide vaut desormais « aucun module ». C'est un changement de
 * comportement en production : les comptes sans modules perdent l'acces tant que
 * personne ne leur en attribue — ce qui est la question qu'il fallait poser.
 *
 * Cette fonction est la source unique de la regle : `requireModuleAccess` s'appuie
 * dessus, comme les routes qui doivent filtrer plusieurs types d'entites a la fois
 * (recherche globale, journal d'audit). Deux implementations separees finiraient par
 * diverger, et c'est exactement ainsi que /api/search s'est retrouve sans controle.
 */
export async function modulesAutorisesDe(user: CompteAuthentifie): Promise<Set<ModuleKey> | null> {
  if (user.role === "ADMIN") return null;
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { modulesAutorises: true },
  });
  // Compte introuvable (supprime entre l'emission du jeton et l'appel) : on n'accorde
  // rien plutot que tout.
  if (!row) return new Set<ModuleKey>();
  return new Set(row.modulesAutorises as ModuleKey[]);
}

export function moduleAutorise(modules: Set<ModuleKey> | null, cle: ModuleKey): boolean {
  return modules === null || modules.has(cle);
}

/**
 * Module dont releve chaque type d'entite journalise, pour aligner la lecture du
 * journal d'audit sur les droits deja accordes sur l'entite elle-meme.
 *
 * `null` signifie « reserve au role ADMIN » : ni les comptes utilisateurs ni les
 * parametres applicatifs ne relevent d'un module configurable (cf. lib/modules.ts).
 * Un type absent de cette table est refuse — on echoue fermé.
 */
export const MODULE_PAR_ENTITE: Record<string, ModuleKey | null> = {
  Troncon: "troncons",
  Ouvrage: "ouvrages",
  PointNoir: "points-noirs",
  Poste: "postes",
  Chantier: "chantiers",
  Inspection: "inspections",
  OrdreTravaux: "ordres-travaux",
  OtPhoto: "ordres-travaux",
  Marche: "marches",
  Decompte: "marches",
  Bailleur: "marches",
  // Module Aide a la decision (lot AD-7). Ces objets sont ecrits ET audites par le moteur de programmation, mais l'historique
  // etait illisible (type absent de la table, donc refuse a tous, ADMIN compris). Ils suivent le module des routes qui les
  // ecrivent : le moteur v2 (parametres, scenarios, fiches, plans pluriannuels) et les previsions sont sous `programmation` ;
  // les baremes (/api/v2/baremes) sont sous `decision`. Un LECTEUR qui a le module lit donc l'historique, comme pour les autres
  // entites : les valeurs avant/apres sont celles qu'il peut deja lire par l'API du module.
  ParametresProgrammation: "programmation",
  ScenarioProgrammation: "programmation",
  FicheIntervention: "programmation",
  PlanPluriannuel: "programmation",
  ProgrammeBudgetaire: "programmation",
  BaremeIntervention: "decision",
  ExportJournal: "rapports",
  // Trace de l'export d'un scenario du simulateur (GET /api/v2/aide-decision/scenarios/:id/export, entityId = identifiant du
  // scenario) : meme module que le journal des exports. Le contenu audite (format, intitule, periode, perimetre, territoire,
  // nombre de lignes, droit financier) ne porte aucun montant.
  ExportScenario: "rapports",
  Document: "documents",
  SignalementCitoyen: "signalements",
  User: null,
  AppSetting: null,
};
