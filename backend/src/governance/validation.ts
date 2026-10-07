/**
 * La porte entre une donnee presente et une donnee officielle, pour TOUTES les entites.
 *
 * LA REGLE, GENERALISEE
 *
 * Observation ou import n'est pas donnee officielle. Cette phrase etait d'abord une
 * regle des observations de terrain, puis des defauts. Elle vaut en realite pour tout
 * objet du geoportail : troncons, ouvrages, defauts, points noirs, postes, chantiers.
 *
 * Le systeme ne la tenait nulle part. Deux consequences mesurees sur la production :
 *
 *   - 81 ouvrages issus du document DTOAA sont publics, 78 en confiance HIGH, et AUCUN
 *     ne porte de marqueur de validation. Rien ne distingue, pour qui les consulte, un
 *     ouvrage releve et contredit d'un ouvrage lu dans un PDF.
 *
 *   - 7 troncons situes hors du territoire guineen sont comptes dans les 21 157 km
 *     publies, parce que leur exclusion repose sur un PREFIXE de chaine de caractere
 *     (`hors_territoire:` dans `sourceReference`) et non sur un statut.
 *
 * POURQUOI UN SEUL ETAT D'ATTENTE ET NON DEUX
 *
 * Un objet importe attend une decision ; un defaut propose sur le terrain attend la
 * meme decision, du meme type de personne, avec les memes consequences. Garder deux
 * noms (IMPORTE et PROPOSE) obligerait chaque requete de l'application a ecrire
 * `IN ('IMPORTE','PROPOSE')`, et un oubli quelque part laisserait passer pour officiel
 * ce qui ne l'est pas. L'origine est une information, elle va dans `source` ; l'etat
 * d'attente est unique.
 *
 * VALIDATION ET PERIMETRE SONT DEUX QUESTIONS DIFFERENTES
 *
 * « Cet objet est-il officiel » et « cet objet compte-t-il dans les statistiques
 * nationales » ne sont pas la meme question. Un troncon malien a la frontiere est une
 * donnee parfaitement juste et hors perimetre national. Le marquer REJETE serait faux :
 * il existe, il n'est simplement pas guineen. Le perimetre vit donc ailleurs
 * (`PerimetreReseau`), et les deux axes se combinent sans se confondre.
 */

/**
 * Etat de validation d'un objet.
 *
 * A_VALIDER est l'etat par defaut de tout objet entrant, quelle que soit son origine :
 * releve de terrain, import de document, reprise de base ancienne.
 */
export type StatutValidation = "A_VALIDER" | "VALIDE" | "REJETE" | "A_CORRIGER";

export const TRANSITIONS: Record<StatutValidation, readonly StatutValidation[]> = {
  A_VALIDER: ["VALIDE", "REJETE", "A_CORRIGER"],
  // A_CORRIGER porte la boucle : l'objet existe, le releve ne suffit pas.
  A_CORRIGER: ["A_VALIDER"],
  // VALIDE ne revient jamais en arriere. Une donnee devenue officielle a pu etre lue,
  // citee, chiffree, inscrite dans un marche ; la devalider en silence reecrirait
  // l'histoire. Pour revenir dessus on constate a nouveau, et les deux constats restent.
  VALIDE: [],
  // REJETE est terminal, puisque A_CORRIGER existe pour ce qu'il faut reprendre.
  // Les confondre ferait disparaitre des objets reels pour un motif de forme.
  REJETE: [],
};

export function transitionPermise(de: string, vers: string): boolean {
  return (TRANSITIONS[de as StatutValidation] ?? []).includes(vers as StatutValidation);
}

/**
 * Entites soumises a validation.
 *
 * Volontairement une liste fermee et non « toute entite » : une table de parametrage ou
 * de referentiel administratif n'a pas a passer par une validation metier, et l'y
 * soumettre produirait une file d'attente que personne ne traiterait.
 */
export const ENTITES_VALIDABLES = new Set([
  "Troncon",
  "Ouvrage",
  "Defaut",
  "Observation",
  "PointNoir",
  "Poste",
  "Chantier",
]);

/** Roles habilites a trancher. Un agent de terrain propose, il ne valide pas. */
export const ROLES_VALIDATEURS = new Set(["ADMIN", "GESTIONNAIRE"]);

export type RefusValidation =
  | "ENTITE_NON_VALIDABLE"
  | "ROLE_INSUFFISANT"
  | "AUTO_VALIDATION"
  | "TRANSITION_INTERDITE"
  | "COMMENTAIRE_REQUIS";

export interface DemandeValidation {
  entityType: string;
  statutActuel: string;
  /**
   * Qui a produit l'objet. NUL quand l'origine est un import sans auteur identifie :
   * dans ce cas la separation des roles n'a personne a opposer, et c'est la seule
   * situation ou elle ne s'applique pas.
   */
  auteurId?: string | null;
  validateurId: string;
  validateurRole: string;
  decision: "VALIDE" | "REJETE" | "A_CORRIGER";
  commentaire?: string | null;
}

/**
 * Peut-on valider, et sinon pourquoi.
 *
 * LA SEPARATION DES ROLES EST LE POINT DELICAT
 *
 * Nul ne rend officiel ce qu'il a lui-meme produit. Sans cette regle, un gestionnaire
 * qui releve une degradation la chiffre et la programme d'un seul geste, et le controle
 * a deux personnes dont depend toute la chaine — metre, quantite, cout, marche —
 * n'existe que sur le papier.
 *
 * L'ORDRE DES CONTROLES EST UNE DECISION, PAS UN HASARD
 *
 * Le motif rendu doit designer la VRAIE cause, parce qu'un message qui en designe une
 * autre fait chercher au mauvais endroit. Un agent qui tente de valider son propre
 * constat deja valide doit lire « auto-validation », pas « transition interdite ».
 */
export function validationPermise(
  d: DemandeValidation,
): { permis: true } | { permis: false; motif: RefusValidation } {
  if (!ENTITES_VALIDABLES.has(d.entityType)) {
    return { permis: false, motif: "ENTITE_NON_VALIDABLE" };
  }
  if (!ROLES_VALIDATEURS.has(d.validateurRole)) {
    return { permis: false, motif: "ROLE_INSUFFISANT" };
  }
  // Un import sans auteur n'a personne a opposer au validateur. C'est le cas des
  // 81 ouvrages DTOAA : ils viennent d'un document, pas d'une personne.
  if (d.auteurId != null && d.auteurId === d.validateurId) {
    return { permis: false, motif: "AUTO_VALIDATION" };
  }
  if (!transitionPermise(d.statutActuel, d.decision)) {
    return { permis: false, motif: "TRANSITION_INTERDITE" };
  }
  // Un refus sans raison est un refus qu'on ne peut pas corriger : l'auteur ignore ce
  // qu'on lui reproche et represente la meme chose.
  if (d.decision !== "VALIDE" && !d.commentaire?.trim()) {
    return { permis: false, motif: "COMMENTAIRE_REQUIS" };
  }
  return { permis: true };
}

/**
 * Perimetre statistique : un objet compte-t-il dans les chiffres nationaux.
 *
 * TROIS RESEAUX QUI NE SE CONFONDENT PAS
 *
 * Le fond cartographique charge peut contenir des troncons hors Guinee, et il le doit :
 * sans eux la carte s'arrete net a la frontiere et la continuite des axes devient
 * illisible. Le reseau national publie, lui, ne doit compter que ce qui est guineen.
 *
 * Ce que ce champ remplace : l'exclusion reposait sur un PREFIXE dans `sourceReference`
 * (`hors_territoire:`, `voirie_locale:`). Un prefixe de chaine n'est pas un statut : il
 * ne porte ni pays, ni motif, ni date, ni validateur, et une faute de frappe le rend
 * muet sans que rien ne le signale.
 */
export type PerimetreReseau = "NATIONAL" | "HORS_TERRITOIRE_NATIONAL" | "VOIRIE_LOCALE";

/** Perimetres comptes dans les indicateurs du reseau national publie. */
export const PERIMETRES_PUBLIES = new Set<PerimetreReseau>(["NATIONAL"]);

export function comptePourLeReseauNational(perimetre: string | null | undefined): boolean {
  // Un perimetre absent compte comme NATIONAL : les 1 691 troncons du reseau classe
  // existaient avant ce champ, et les exclure par defaut effacerait le reseau entier.
  // C'est l'inverse du choix fait pour la validation, et pour une raison opposee :
  // ici l'omission est une absence de classement, pas une absence de decision.
  if (perimetre == null) return true;
  return PERIMETRES_PUBLIES.has(perimetre as PerimetreReseau);
}

/** Message destine a un agent, et non a un developpeur. */
export const EXPLICATIONS: Record<RefusValidation, string> = {
  ENTITE_NON_VALIDABLE: "Ce type d'objet ne passe pas par une validation métier.",
  ROLE_INSUFFISANT: "La validation relève d'un gestionnaire ou d'un administrateur.",
  AUTO_VALIDATION: "Un objet ne peut pas être validé par la personne qui l'a produit.",
  TRANSITION_INTERDITE: "L'objet n'est pas dans un état qui permet cette décision.",
  COMMENTAIRE_REQUIS: "Un refus ou une demande de correction doit indiquer ce qui doit être repris.",
};
