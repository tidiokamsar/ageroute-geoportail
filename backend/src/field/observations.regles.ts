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

/**
 * LA PORTE DE VALIDATION N'EST PLUS ICI.
 *
 * Ce fichier portait son propre `validationPermise`, avec son propre
 * `ROLES_VALIDATEURS`. Cette copie etait devenue MORTE le jour ou la regle a ete
 * centralisee dans `governance/validation` : la route des observations importe la version
 * partagee, et celle-ci n'etait plus importee que par son propre test.
 *
 * C'est exactement le danger que la centralisation visait a supprimer, et il s'etait
 * reinstalle sans bruit. La copie n'avait notamment PAS la verification de delegation
 * ajoutee le 13/10/2026 : quiconque l'aurait importee aurait obtenu la regle d'avant, en
 * croyant appliquer la regle courante, et ses tests l'auraient confirme.
 *
 * Ce qui RESTE ici est propre aux observations et n'est pas redondant : la machine a
 * etats BROUILLON / PROPOSEE / VALIDEE / REJETEE / CONVERTIE, qui est celle de l'enum en
 * base. La porte de validation, elle, vient de la gouvernance.
 */
export {
  validationPermise,
  ROLES_VALIDATEURS,
  EXPLICATIONS as EXPLICATIONS_VALIDATION,
  type DemandeValidation,
  type RefusValidation,
} from "../governance/validation";

/**
 * LES MESSAGES NON PLUS NE SONT PLUS ICI.
 *
 * Ce fichier portait son propre dictionnaire d'explications, et la divergence y etait
 * DEJA visible : il nommait un motif `MOTIF_REQUIS` qui n'existe pas dans la gouvernance,
 * laquelle dit `COMMENTAIRE_REQUIS`. Deux vocabulaires pour la meme regle, dont un que
 * plus aucune route ne lisait.
 *
 * C'est la preuve que la copie n'etait pas seulement redondante : elle avait commence a
 * s'ecarter. Les messages viennent desormais de `governance/validation`, reexportes
 * ci-dessus sous `EXPLICATIONS_VALIDATION`.
 */
