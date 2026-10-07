/**
 * Regles de mission : perimetre de visibilite et cycle de vie.
 *
 * POURQUOI CE FICHIER EXISTE A PART DES ROUTES
 *
 * Ces deux regles sont des fonctions pures, et elles portent ce qui compte. Les
 * laisser dans `missions.routes.ts` les rendait intestables : importer ce fichier
 * entraine les middlewares, donc `config/env`, qui appelle `process.exit(1)` quand il
 * ne trouve pas de `.env`. Le test ne tombait meme pas en echec, il ne demarrait pas.
 *
 * C'est la troisieme fois dans ce programme que la decision est sortie de sa couche
 * technique — apres l'appariement et la synchronisation — et chaque fois pour la meme
 * raison : une regle qui ne se teste qu'avec toute l'application allumee ne se teste
 * pas.
 */

/**
 * Transitions autorisees d'une mission.
 *
 * Un statut qui se modifie librement finit par decrire autre chose que la realite :
 * une mission « terminee » qui repasse « en cours » sans trace, ou « telechargee »
 * sans avoir jamais ete planifiee. Un responsable lirait alors un tableau de bord qui
 * ment.
 */
export const TRANSITIONS: Record<string, readonly string[]> = {
  BROUILLON: ["PLANIFIEE", "ANNULEE"],
  PLANIFIEE: ["TELECHARGEE", "EN_COURS", "ANNULEE"],
  TELECHARGEE: ["EN_COURS", "ANNULEE"],
  EN_COURS: ["SUSPENDUE", "TERMINEE", "ANNULEE"],
  SUSPENDUE: ["EN_COURS", "ANNULEE"],
  // Une mission terminee peut encore attendre que son appareil vide sa file.
  TERMINEE: ["SYNC_EN_ATTENTE"],
  SYNC_EN_ATTENTE: ["TERMINEE"],
  ANNULEE: [],
};

export function transitionPermise(de: string, vers: string): boolean {
  return (TRANSITIONS[de] ?? []).includes(vers);
}

/**
 * Ce qu'un compte a le droit de voir.
 *
 * Le ROLE dit ce qu'on a le droit de faire, le PERIMETRE dit sur quoi. Deux agents de
 * terrain portent le meme role et ne doivent pas voir les missions l'un de l'autre :
 * aucune verification de role ne les separera jamais.
 *
 * Le defaut est RESTREINT. Le cahier des charges decrit neuf roles metier quand le
 * systeme en connait quatre ; le jour ou un cinquieme arrive, il doit tomber du cote
 * restreint sans que personne ait a y penser.
 */
export function perimetre(user: { id: string; role: string }) {
  if (user.role === "ADMIN" || user.role === "GESTIONNAIRE") return { deletedAt: null };
  return { deletedAt: null, OR: [{ assigneId: user.id }, { createurId: user.id }] };
}
