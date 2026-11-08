/**
 * PROFILS EFFECTIFS ET MATRICE DES DROITS DU WORKFLOW (noyau pur ; contrat docs/projets-voirie/CONTRAT-WORKFLOW.md, sections 2 et 3).
 *
 * LA CORRESPONDANCE DES ROLES DU CAHIER EST UNE PROPOSITION PRUDENTE, PROVISOIRE : elle attend la decision du DSI. Elle n'ajoute AUCUN role
 * technique ni seconde authentification : un « referent concessionnaire » est un compte LECTEUR qui porte la cle de module `projets-voirie` et
 * un rattachement (attribut de compte). Le profil EFFECTIF d'un compte est donc `REFERENT` s'il a un rattachement actif, sinon son role technique.
 *
 * La matrice (action -> profils) a un DEFAUT prudent et peut etre MODIFIEE par la variable `PROJETS_VOIRIE_WORKFLOW_MATRICE` (JSON), dans des
 * limites fixees ici : seules les actions configurables, seuls les profils candidats de chaque action, ADMIN toujours present. Toute entree
 * invalide est IGNOREE (le defaut s'applique) et signalee : un reglage ne peut jamais ouvrir ce que le code interdit.
 */

export const PROFILS = ["ADMIN", "GESTIONNAIRE", "INSPECTEUR", "LECTEUR", "REFERENT"] as const;
export type ProfilEffectif = (typeof PROFILS)[number];

export const ACTIONS = [
  "referent.gerer", "referent.lire", "workflow.lire", "demande.ecrire", "tache.gerer", "tache.executer", "preuve.ajouter", "recolement.ecrire", "recolement.valider",
] as const;
export type ActionWorkflow = (typeof ACTIONS)[number];

interface DefinitionAction {
  libelle: string;
  defaut: readonly ProfilEffectif[];
  /** Profils qu'une configuration peut accorder ; `null` : action NON configurable. */
  candidats: readonly ProfilEffectif[] | null;
}

const ADMIN_GEST: readonly ProfilEffectif[] = ["ADMIN", "GESTIONNAIRE"];

export const DEFINITION_ACTIONS: Readonly<Record<ActionWorkflow, DefinitionAction>> = {
  "referent.gerer": { libelle: "Poser ou revoquer le rattachement d'un referent concessionnaire", defaut: ["ADMIN"], candidats: null },
  "referent.lire": { libelle: "Lister les rattachements des referents d'un projet", defaut: ADMIN_GEST, candidats: null },
  "workflow.lire": {
    libelle: "Lire demandes, taches, recolements, jeux (vue restreinte) et dossiers (vue concessionnaire)",
    defaut: ["ADMIN", "GESTIONNAIRE", "REFERENT"], candidats: PROFILS,
  },
  "demande.ecrire": { libelle: "Creer, modifier, enregistrer l'envoi, la reception, la cloture ou l'annulation d'une demande", defaut: ADMIN_GEST, candidats: ADMIN_GEST },
  "tache.gerer": { libelle: "Creer, modifier, reaffecter, annuler, valider une tache", defaut: ADMIN_GEST, candidats: ADMIN_GEST },
  "tache.executer": {
    libelle: "Faire avancer sa propre tache", defaut: ["ADMIN", "GESTIONNAIRE", "INSPECTEUR", "REFERENT"], candidats: ["ADMIN", "GESTIONNAIRE", "INSPECTEUR", "REFERENT"],
  },
  "preuve.ajouter": {
    libelle: "Ajouter une preuve (reference et empreinte)", defaut: ["ADMIN", "GESTIONNAIRE", "INSPECTEUR", "REFERENT"], candidats: ["ADMIN", "GESTIONNAIRE", "INSPECTEUR", "REFERENT"],
  },
  "recolement.ecrire": { libelle: "Creer, modifier, soumettre, retirer un recolement", defaut: ADMIN_GEST, candidats: ADMIN_GEST },
  "recolement.valider": { libelle: "Valider ou rejeter un recolement soumis", defaut: ["ADMIN"], candidats: ADMIN_GEST },
};

export type Matrice = Readonly<Record<ActionWorkflow, readonly ProfilEffectif[]>>;

export const MATRICE_DEFAUT: Matrice = Object.fromEntries(ACTIONS.map((a) => [a, [...DEFINITION_ACTIONS[a].defaut]])) as unknown as Matrice;

export const estProfil = (v: unknown): v is ProfilEffectif => typeof v === "string" && (PROFILS as readonly string[]).includes(v);
export const estAction = (v: unknown): v is ActionWorkflow => typeof v === "string" && (ACTIONS as readonly string[]).includes(v);

/** Profil effectif : REFERENT si le compte a un rattachement actif ; sinon son role technique (un role inconnu est traite comme LECTEUR : echec ferme). */
export function profilEffectif(role: string, referent: boolean): ProfilEffectif {
  if (referent) return "REFERENT";
  return role === "ADMIN" || role === "GESTIONNAIRE" || role === "INSPECTEUR" ? role : "LECTEUR";
}

export const estDecideurProfil = (p: ProfilEffectif): boolean => p === "ADMIN" || p === "GESTIONNAIRE";

export const autorise = (m: Matrice, action: ActionWorkflow, profil: ProfilEffectif): boolean => m[action].includes(profil);

export interface MatriceLue { matrice: Matrice; avertissements: string[] }

/**
 * Lit `PROJETS_VOIRIE_WORKFLOW_MATRICE`. Absente ou vide : le defaut. Illisible : le defaut et un avertissement. Entree par entree : une action
 * inconnue ou non configurable, une liste mal formee, un profil inconnu ou non candidat pour cette action sont ignores avec un avertissement ;
 * ADMIN est ajoute d'office ; les doublons sont retires.
 */
export function lireMatrice(brut: string | undefined): MatriceLue {
  const avertissements: string[] = [];
  if (brut === undefined || brut.trim() === "") return { matrice: MATRICE_DEFAUT, avertissements };
  let o: unknown;
  try { o = JSON.parse(brut); } catch { return { matrice: MATRICE_DEFAUT, avertissements: ["PROJETS_VOIRIE_WORKFLOW_MATRICE est illisible (JSON attendu) : la matrice par defaut s'applique."] }; }
  if (o === null || typeof o !== "object" || Array.isArray(o)) {
    return { matrice: MATRICE_DEFAUT, avertissements: ["PROJETS_VOIRIE_WORKFLOW_MATRICE doit etre un objet { action: [profils] } : la matrice par defaut s'applique."] };
  }
  const m: Record<string, readonly ProfilEffectif[]> = { ...MATRICE_DEFAUT };
  for (const [action, liste] of Object.entries(o as Record<string, unknown>)) {
    if (!estAction(action)) { avertissements.push(`Action inconnue ignoree : ${action.slice(0, 60)}.`); continue; }
    const def = DEFINITION_ACTIONS[action];
    if (def.candidats === null) { avertissements.push(`L'action ${action} n'est pas configurable : ignoree.`); continue; }
    if (!Array.isArray(liste) || liste.length > PROFILS.length * 2) { avertissements.push(`Liste de profils invalide pour ${action} : ignoree.`); continue; }
    const invalide = liste.find((p) => !estProfil(p) || !def.candidats!.includes(p));
    if (invalide !== undefined) { avertissements.push(`Profil non permis pour ${action} (${String(invalide).slice(0, 40)}) : entree ignoree.`); continue; }
    m[action] = [...new Set<ProfilEffectif>(["ADMIN", ...(liste as ProfilEffectif[])])];
  }
  return { matrice: m as Matrice, avertissements };
}

/** Droits (identifiants d'actions) d'un profil selon une matrice. */
export const droitsDe = (m: Matrice, profil: ProfilEffectif): ActionWorkflow[] => ACTIONS.filter((a) => m[a].includes(profil));

// ------------------------------------------------------------------------------------------------
// Correspondance des roles du cahier (documentaire, rendue par `GET /workflow/mon-profil`)
// ------------------------------------------------------------------------------------------------

export interface LigneCorrespondance { roleCahier: string; compte: string; attribut: string; resume: string }

export const CORRESPONDANCE_CAHIER: readonly LigneCorrespondance[] = [
  { roleCahier: "Administrateur BDRI", compte: "ADMIN", attribut: "aucun", resume: "Tout, y compris poser et revoquer un rattachement de referent." },
  { roleCahier: "Gestionnaire de projet AGEROUTE", compte: "GESTIONNAIRE", attribut: "cle de module projets-voirie", resume: "Ecrit le workflow ; ne valide pas un recolement." },
  { roleCahier: "Referent concessionnaire", compte: "LECTEUR", attribut: "cle de module projets-voirie et rattachement (compte, concessionnaire, projet)", resume: "Lit et complete uniquement les elements partages de son concessionnaire ; aucune route du socle." },
  { roleCahier: "Responsable de validation AGEROUTE", compte: "GESTIONNAIRE ou ADMIN selon l'acte", attribut: "cle de module projets-voirie", resume: "Valide selon la matrice (recolement : ADMIN par defaut) avec separation des taches ; pas de role « validateur »." },
  { roleCahier: "Auditeur", compte: "LECTEUR (profil AUDITEUR)", attribut: "cle de module projets-voirie", resume: "Aucune ecriture ; lit le journal par GET /api/audit ; lecture du workflow non ouverte par defaut." },
  { roleCahier: "Agent terrain", compte: "INSPECTEUR (profil AGENT_TERRAIN)", attribut: "cle de module projets-voirie", resume: "Execute ses propres taches et y ajoute des preuves de releve." },
  { roleCahier: "Observateur / lecture seule", compte: "LECTEUR", attribut: "cle de module projets-voirie", resume: "Socle en lecture seule ; lecture du workflow non ouverte par defaut." },
];

/** Actes du socle et de RC-3 : rappel de qui peut quoi AUJOURD'HUI. Non configurable ici, applique par le socle. */
export const DROITS_SOCLE: readonly { acte: string; roles: readonly string[]; separation: string }[] = [
  { acte: "Autoriser ou rejeter un jeu", roles: ["ADMIN", "GESTIONNAIRE"], separation: "non bloquante (memePersonne note dans l'audit)" },
  { acte: "Retirer un jeu", roles: ["ADMIN", "GESTIONNAIRE"], separation: "non" },
  { acte: "Approuver une regle de conflit", roles: ["ADMIN"], separation: "l'auteur n'approuve pas sans derogation motivee" },
  { acte: "Approuver ou refuser une decision de conflit", roles: ["ADMIN", "GESTIONNAIRE"], separation: "le proposant ne tranche pas sans derogation motivee (ADMIN pour un deplacement ou des deux comptes habilites)" },
  { acte: "Clore un dossier de conflit", roles: ["ADMIN"], separation: "le proposeur de la cloture ne clot pas sans derogation d'un ADMIN" },
];
