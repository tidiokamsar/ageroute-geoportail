import type { ModuleKey } from "./modules";

/**
 * Les onze profils metier du cahier des charges, et comment ils se posent sur les quatre
 * roles techniques.
 *
 * LE PROBLEME
 *
 * Le paragraphe 5 du cahier RAI V3.1 decrit ONZE profils avec leurs usages. L'application
 * connait QUATRE roles : ADMIN, GESTIONNAIRE, INSPECTEUR, LECTEUR. Aucun mapping n'etait
 * ecrit nulle part, si bien que creer un compte « Ingenieur reseau » consistait a choisir
 * un role au jugement, sans trace de ce qu'on avait voulu dire.
 *
 * CE QU'UN PROFIL EST ICI, ET CE QU'IL N'EST PAS
 *
 * Un profil est un PREREGLAGE NOMME par-dessus ce qui autorise deja : le role technique
 * et la liste `modulesAutorises`. Ce n'est PAS un second mecanisme d'autorisation.
 *
 * Le cloisonnement par module existe, il est eprouve, et sa regle a deja ete corrigee une
 * fois — une liste vide valait « aucune restriction », ce qui ouvrait tout compte dont la
 * configuration avait ete oubliee (voir `lib/access.ts`). Ajouter un second chemin
 * d'autorisation a cote reviendrait a refaire cette erreur en plus grand : deux
 * implementations de la meme regle finissent par diverger, et la divergence est
 * silencieuse.
 *
 * Appliquer un profil ECRIT donc `role` et `modulesAutorises`, puis disparait. Un compte
 * ne « porte » pas son profil : il porte ce que le profil lui a donne, et c'est le journal
 * d'audit qui dit quel profil a ete applique, par qui et quand.
 *
 * POURQUOI CETTE TABLE EST DANS LE CODE ET NON EN BASE
 *
 * J'avais d'abord recommande une table administrable, par analogie avec le catalogue des
 * defauts. C'etait une mauvaise analogie, et je me corrige : un catalogue de degradations
 * decrit le monde, une table de profils DISTRIBUE DES PRIVILEGES.
 *
 * Rendre ces correspondances modifiables en base creerait un chemin d'elevation de
 * privileges administrable depuis l'interface : il suffirait de changer une ligne pour
 * que le prochain « Auditeur » devienne ADMIN. En code, toute modification passe par une
 * revue et un deploiement, ce qui est le bon niveau de ceremonie pour cela.
 *
 * Si AGEROUTE veut les rendre administrables, c'est une decision a prendre en connaissant
 * cette consequence.
 *
 * CE QUI EST VERBATIM, ET CE QUI EST UNE PROPOSITION
 *
 * `libelle` et `usages` sont repris MOT POUR MOT du paragraphe 5. Ils ne sont pas
 * negociables : ils disent ce que le cahier a commande.
 *
 * `role` et `modules` sont des PROPOSITIONS, deduites de ces phrases et des seize modules
 * existants. Elles ne sont pas validees. Les questions ouvertes sont listees a la fin de
 * ce fichier, et elles ne se tranchent pas en lisant du code : elles demandent de savoir
 * qui, chez AGEROUTE, valide quoi.
 */

export type RoleTechnique = "ADMIN" | "GESTIONNAIRE" | "INSPECTEUR" | "LECTEUR";

export interface ProfilMetier {
  /** Code stable, utilise par l'API. Le libelle peut changer, lui non. */
  code: string;
  /** Verbatim du paragraphe 5. */
  libelle: string;
  /** Verbatim du paragraphe 5. */
  usages: string;
  /** PROPOSITION. */
  role: RoleTechnique;
  /**
   * PROPOSITION. Vide pour un ADMIN : son role ne connait aucune restriction de module,
   * et lui en lister serait trompeur.
   */
  modules: readonly ModuleKey[];
  /** Ce qui reste a trancher sur ce profil, quand quelque chose reste a trancher. */
  aArbitrer?: string;
}

/** Les modules de consultation que presque tous les profils partagent. */
const SOCLE_LECTURE: readonly ModuleKey[] = ["dashboard", "geoportail", "troncons", "ouvrages"];

export const PROFILS_METIER: readonly ProfilMetier[] = [
  {
    code: "ADMIN_PLATEFORME",
    libelle: "Administrateur plateforme",
    usages: "Utilisateurs, rôles, paramètres, sécurité, audit.",
    role: "ADMIN",
    // Vide volontairement : le role ADMIN ne connait aucune restriction de module, et
    // `utilisateurs` comme `administration` ne figurent meme pas parmi les cles
    // configurables — ils lui sont strictement reserves.
    modules: [],
  },
  {
    code: "ADMIN_SIG",
    libelle: "Administrateur SIG",
    usages: "Référentiels, géométries, couches et validation spatiale.",
    role: "GESTIONNAIRE",
    modules: [...SOCLE_LECTURE, "points-noirs", "postes", "documents"],
    aArbitrer:
      "Ce profil edite des geometries, ce qui modifie le lineaire publie. Faut-il le " +
      "distinguer d'un gestionnaire ordinaire, qui n'a pas vocation a toucher aux traces ?",
  },
  {
    code: "AGENT_TERRAIN",
    libelle: "Agent terrain",
    usages: "Missions, GPS, observations, photos, mesures.",
    role: "INSPECTEUR",
    modules: [...SOCLE_LECTURE, "inspections"],
  },
  {
    code: "COORDONNATEUR",
    libelle: "Coordonnateur",
    usages: "Supervision des missions, contrôle des données et validation selon délégation.",
    role: "GESTIONNAIRE",
    modules: [...SOCLE_LECTURE, "inspections", "alertes", "rapports", "signalements"],
    aArbitrer:
      "« Validation selon delegation » n'a aucun equivalent dans le code : la validation " +
      "est aujourd'hui ouverte a tout GESTIONNAIRE, sans perimetre ni delegation. Une " +
      "delegation suppose de savoir QUI delegue, SUR QUOI et JUSQU'OU.",
  },
  {
    code: "INGENIEUR_RESEAU",
    libelle: "Ingénieur réseau",
    usages: "Inspection, état, risque, traitement et programmation.",
    role: "GESTIONNAIRE",
    modules: [...SOCLE_LECTURE, "inspections", "programmation", "decision", "rapports"],
  },
  {
    code: "ENTRETIEN_MAINTENANCE",
    libelle: "Entretien & Maintenance",
    usages: "Défauts, traitements, quantités, programmes.",
    role: "GESTIONNAIRE",
    modules: [...SOCLE_LECTURE, "inspections", "ordres-travaux", "chantiers", "programmation"],
  },
  {
    code: "PLANIFICATION",
    libelle: "Planification",
    usages: "Scénarios et arbitrages budgétaires.",
    role: "GESTIONNAIRE",
    modules: [...SOCLE_LECTURE, "programmation", "decision", "rapports", "marches"],
  },
  {
    code: "CONTROLE_GESTION",
    libelle: "Contrôle de gestion",
    usages: "Coûts, budgets et indicateurs.",
    role: "LECTEUR",
    modules: [...SOCLE_LECTURE, "marches", "programmation", "rapports"],
    aArbitrer:
      "LECTEUR propose : « couts, budgets et indicateurs » se lit comme de l'analyse. Mais " +
      "si ce profil doit SAISIR des decomptes ou des montants, il lui faut GESTIONNAIRE — " +
      "et alors il ecrit sur des donnees financieres.",
  },
  {
    code: "DIRECTION_TECHNIQUE",
    libelle: "Direction Technique",
    usages: "Validation et arbitrage technique.",
    role: "GESTIONNAIRE",
    // GESTIONNAIRE et non LECTEUR : `ROLES_VALIDATEURS` dans `governance/validation.ts`
    // n'admet que ADMIN et GESTIONNAIRE. Un profil dont l'usage est « validation » ne
    // peut pas etre LECTEUR sans etre contredit par le code.
    modules: [...SOCLE_LECTURE, "inspections", "programmation", "decision", "rapports", "marches"],
  },
  {
    code: "DIRECTION_GENERALE",
    libelle: "Direction Générale",
    usages: "Pilotage et décisions.",
    role: "LECTEUR",
    // `dashboard` vient deja du socle : le repeter passait inapercu et un test l'a vu.
    modules: [...SOCLE_LECTURE, "rapports", "decision", "programmation", "alertes"],
    aArbitrer:
      "LECTEUR propose. « Decisions » peut vouloir dire arbitrer DANS l'outil, et il " +
      "faudrait alors GESTIONNAIRE — ou bien decider hors de l'outil et s'y informer, et " +
      "LECTEUR suffit. Les deux lectures sont defendables ; seul AGEROUTE sait laquelle.",
  },
  {
    code: "AUDITEUR",
    libelle: "Auditeur",
    usages: "Consultation des historiques et journaux.",
    role: "LECTEUR",
    modules: [
      ...SOCLE_LECTURE, "points-noirs", "postes", "chantiers", "programmation",
      "marches", "inspections", "documents", "ordres-travaux", "rapports",
    ],
    aArbitrer:
      "L'historique se lit par ENTITE (`/api/audit` exige entityType et entityId), module " +
      "par module. Il n'existe aucune vue de journal GLOBAL, que « consultation des " +
      "journaux » suppose pourtant. C'est une fonction manquante, pas un probleme de role.",
  },
];

export function profilParCode(code: string): ProfilMetier | undefined {
  return PROFILS_METIER.find((p) => p.code === code);
}

/**
 * Ce qu'il faut ecrire sur un compte pour lui appliquer un profil.
 *
 * Fonction PURE et separee de l'ecriture : elle se teste sans base, et surtout elle rend
 * visible le fait qu'un profil n'est rien d'autre que ces deux champs. Aucune colonne
 * `profil` n'est ajoutee au modele — un profil applique puis modifie a la main ne doit pas
 * continuer d'afficher un nom qui ne correspond plus a ce que le compte peut faire.
 */
export function effetDuProfil(profil: ProfilMetier): {
  role: RoleTechnique;
  modulesAutorises: ModuleKey[];
} {
  return { role: profil.role, modulesAutorises: [...profil.modules] };
}

/**
 * Les profils dont la correspondance reste a trancher.
 *
 * Exposee pour que l'interface puisse le DIRE a l'administrateur au moment ou il applique
 * un profil, au lieu de laisser croire que la question est reglee.
 */
export function profilsAArbitrer(): readonly ProfilMetier[] {
  return PROFILS_METIER.filter((p) => p.aArbitrer !== undefined);
}
