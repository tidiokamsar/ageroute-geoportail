/**
 * Validation des observations : qui peut, depuis quel etat, et vers lequel.
 *
 * LA REGLE FONDAMENTALE
 *
 * Point 13 du master prompt RAI V3 : une observation de terrain est une PROPOSITION.
 * Elle ne devient officielle qu'apres validation. Un agent qui constate un pont
 * endommage ne cree pas un ouvrage au referentiel national ; il propose, et quelqu'un
 * d'autre decide.
 *
 * Le systeme savait deja produire des observations, les remonter sans doublon et
 * conserver les conflits. Il ne savait pas VALIDER : tout ce qui montait du terrain
 * restait au statut PROPOSEE et n'alimentait rien. Toute la chaine de decision —
 * defaut, etat, traitement, quantite, cout, programmation — attendait cette porte.
 *
 * POURQUOI CES REGLES NE SONT PAS DANS LES ROUTES
 *
 * Quatrieme extraction de meme nature dans ce programme, apres l'appariement, la
 * synchronisation et les missions. Importer un fichier de routes entraine les
 * middlewares, donc `config/env`, qui appelle `process.exit(1)` faute de `.env` : le
 * test ne tombe pas en echec, il ne demarre pas.
 */

export type StatutObservation = "BROUILLON" | "PROPOSEE" | "VALIDEE" | "REJETEE" | "CONVERTIE";

/**
 * Transitions autorisees.
 *
 * REJETEE n'est pas terminal : un agent corrige ce qu'on lui a renvoye et represente.
 * VALIDEE ne revient jamais en arriere — une donnee devenue officielle a pu etre lue,
 * citee, reprise dans un marche ; la devalider en silence reecrirait l'histoire. Pour
 * revenir dessus, on produit une nouvelle observation, et les deux restent.
 *
 * CONVERTIE est terminal : l'observation a engendre un defaut ou un actif officiel,
 * et c'est desormais cet objet-la qui vit sa vie.
 */
export const TRANSITIONS: Record<StatutObservation, readonly StatutObservation[]> = {
  BROUILLON: ["PROPOSEE"],
  PROPOSEE: ["VALIDEE", "REJETEE"],
  REJETEE: ["PROPOSEE"],
  VALIDEE: ["CONVERTIE"],
  CONVERTIE: [],
};

export function transitionPermise(de: string, vers: string): boolean {
  return (TRANSITIONS[de as StatutObservation] ?? []).includes(vers as StatutObservation);
}

/** Roles habilites a trancher. Un agent de terrain propose, il ne valide pas. */
export const ROLES_VALIDATEURS = new Set(["ADMIN", "GESTIONNAIRE"]);

export type RefusValidation =
  | "ROLE_INSUFFISANT"
  | "AUTO_VALIDATION"
  | "TRANSITION_INTERDITE"
  | "MOTIF_REQUIS";

export interface DemandeValidation {
  statutActuel: string;
  /** Qui a produit l'observation. */
  agentId: string;
  /** Qui demande la validation. */
  validateurId: string;
  validateurRole: string;
  decision: "VALIDEE" | "REJETEE";
  motif?: string | null;
}

/**
 * Peut-on valider, et sinon pourquoi.
 *
 * LA SEPARATION DES ROLES EST LE POINT DELICAT
 *
 * Point 30 du master prompt : un utilisateur ne doit jamais pouvoir « valider sa
 * propre operation sensible si separation de role requise ». Ici elle l'est. Sans
 * cette regle, un gestionnaire qui releve lui-meme une degradation la rendrait
 * officielle d'un seul geste, et le controle a deux personnes que toute la chaine
 * suppose n'existerait que sur le papier.
 *
 * Elle est verifiee AVANT la transition : un agent qui tente de valider sa propre
 * observation doit lire « auto-validation », pas « transition interdite ». Un message
 * qui designe la mauvaise cause fait chercher au mauvais endroit.
 */
export function validationPermise(d: DemandeValidation): { permis: true } | { permis: false; motif: RefusValidation } {
  if (!ROLES_VALIDATEURS.has(d.validateurRole)) {
    return { permis: false, motif: "ROLE_INSUFFISANT" };
  }
  if (d.agentId === d.validateurId) {
    return { permis: false, motif: "AUTO_VALIDATION" };
  }
  if (!transitionPermise(d.statutActuel, d.decision)) {
    return { permis: false, motif: "TRANSITION_INTERDITE" };
  }
  // Un rejet sans raison est un rejet qu'on ne peut pas corriger : l'agent ignore ce
  // qu'on lui reproche et represente la meme chose.
  if (d.decision === "REJETEE" && !d.motif?.trim()) {
    return { permis: false, motif: "MOTIF_REQUIS" };
  }
  return { permis: true };
}

/** Message destine a l'agent, et non au developpeur. */
export const EXPLICATIONS: Record<RefusValidation, string> = {
  ROLE_INSUFFISANT: "La validation d'une observation relève d'un gestionnaire ou d'un administrateur.",
  AUTO_VALIDATION: "Une observation ne peut pas être validée par la personne qui l'a produite.",
  TRANSITION_INTERDITE: "L'observation n'est pas dans un état qui permet cette décision.",
  MOTIF_REQUIS: "Un rejet doit indiquer ce qui doit être corrigé.",
};
