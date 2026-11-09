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
 * Le compte est-il REFERENT d'un concessionnaire (au moins un rattachement actif, module Projets de voirie, lot B3) ? Un tel compte n'ouvre que les
 * routes `/workflow/...` du module ; il ne lit pas non plus l'historique d'audit des entites du module (`GET /api/audit`), qui porte les noms des
 * agents d'AGEROUTE et des motifs internes. Un ADMIN n'est jamais referent (aucune lecture).
 */
export async function compteRattache(user: CompteAuthentifie): Promise<boolean> {
  if (user.role === "ADMIN") return false;
  return (await prisma.referentConcessionnaire.count({ where: { userId: user.id, revoqueLe: null } })) > 0;
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
  // Module Projets de voirie et reseaux : l'historique (depot, autorisation, rejet, retrait, export) suit la cle de module des routes.
  // Les valeurs auditees ne portent AUCUNE geometrie (nom de fichier, empreinte, comptes, decisions).
  ProjetVoirie: "projets-voirie",
  JeuDonneesProjet: "projets-voirie",
  ConcessionnaireReseau: "projets-voirie",
  ExportProjetVoirie: "projets-voirie",
  // Consultation d'un jeu sensible par la carte ou l'analyse : une ligne par compte, par jeu et par fenetre de 15 minutes, sans geometrie.
  ConsultationJeuProjet: "projets-voirie",
  // Dossiers de conflit (lot RC-3) : analyses persistees, regles, dossiers (statuts, decisions, preuves) et leur export CSV. Aucune geometrie dans l'audit.
  AnalyseConflitProjet: "projets-voirie",
  RegleConflit: "projets-voirie",
  ConflitProjet: "projets-voirie",
  ExportConflitsProjetVoirie: "projets-voirie",
  // Workflow concessionnaire (lot B3) : rattachements des referents, demandes (envoi enregistre hors application), taches, recolements. Les preuves sont
  // auditees sous l'objet qui les porte. Aucune geometrie dans l'audit. C'est la voie de lecture de l'auditeur (GET /api/audit).
  ReferentConcessionnaire: "projets-voirie",
  DemandeConcessionnaire: "projets-voirie",
  TacheProjetVoirie: "projets-voirie",
  RecolementProjetVoirie: "projets-voirie",
  // Reseaux physiques et circuits logiques (lot B1) : descripteurs d objets, relations et propositions d associations. Aucune geometrie dans l audit.
  ReseauObjetDescripteur: "projets-voirie",
  ReseauRelation: "projets-voirie",
  AssociationsReseau: "projets-voirie",
  // Territoires, referentiels configurables et configuration nationale (lot T1) : ecritures ADMIN ; l'emprise d'un territoire n'est auditee que
  // par sa boite englobante et son empreinte, jamais la geometrie.
  TerritoireVoirie: "projets-voirie",
  ReferentielVoirie: "projets-voirie",
  ConfigurationVoirie: "projets-voirie",
  // Sources multiples et comparaison entre sources (lot S1) : regles de rapprochement, comparaisons persistees. Aucune geometrie dans l audit.
  RegleRapprochementSources: "projets-voirie",
  ComparaisonSources: "projets-voirie",
  User: null,
  AppSetting: null,
};

/**
 * Types d'entite journalises que ce compte peut voir dans un flux qui melange plusieurs modules (revue de la vague 1, m5 : `GET /api/dashboard/activity`).
 *
 * `null` = aucune restriction (ADMIN). Sinon la liste des types dont le module est autorise au compte, avec les memes regles que le journal d'audit
 * (`GET /api/audit`) : un type absent de `MODULE_PAR_ENTITE` ou reserve a l'ADMIN (module `null`) n'est jamais montre (echec ferme), et un compte RATTACHE a
 * un concessionnaire (referent, lot B3) ne voit aucun type du module Projets de voirie, meme s'il en porte la cle.
 */
export async function typesEntiteVisibles(user: CompteAuthentifie): Promise<string[] | null> {
  const modules = await modulesAutorisesDe(user);
  if (modules === null) return null;
  const rattache = modules.has("projets-voirie") ? await compteRattache(user) : false;
  return Object.entries(MODULE_PAR_ENTITE)
    .filter(([, m]) => m !== null && modules.has(m) && !(m === "projets-voirie" && rattache))
    .map(([type]) => type);
}
