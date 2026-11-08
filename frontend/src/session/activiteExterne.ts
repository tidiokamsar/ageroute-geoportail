/**
 * Pont minimal entre les ecrans et la session locale (Lot 1).
 *
 * POURQUOI : en roulant, l'agent ne touche pas l'ecran, alors que le releve ecrit son journal chiffre avec la cle de
 * donnees. Si la session comptait seulement les interactions, le verrou d'inactivite (5 min) ferait oublier la cle et le
 * journal ne s'ecrirait plus. Decision de conduite (PROVISOIRE, a confirmer par la DSI) : tant qu'un releve est ACTIF,
 * chaque point GNSS recu est une activite EXTERNE, qui differe le verrou d'inactivite.
 *
 * CE QUE CE PONT NE FAIT PAS (corrige apres la relecture independante) :
 *   - il n'est PAS une interaction : l'hote le traduit en evenement `ACTIVITE_EXTERNE`, distinct de `ACTIVITE`. Il ne remet
 *     jamais a zero le compteur d'arriere-plan : l'application mise en arriere-plan se verrouille apres 2 minutes quoi
 *     qu'il arrive, meme si des points GNSS continuent d'arriver ;
 *   - il est PLAFONNE : au-dela de `PLAFOND_ACTIVITE_EXTERNE_MS` (PROVISOIRE, 30 minutes) depuis la derniere interaction
 *     reelle de l'agent, il ne repousse plus rien. Le verrou tombe alors (au plus `plafond + inactivite` apres la derniere
 *     interaction), la cle est oubliee, et le journal de roulage retient ses entrees EN MEMOIRE jusqu'au deverrouillage
 *     (comportement de `roulageHote.ts`, jamais en clair). Contre-partie assumee : une page tuee pendant ce verrou perd ce
 *     tampon.
 *
 * Ce module ne contient AUCUNE logique de session : il ne fait que relayer. L'integrateur (useSessionLocale) s'abonne avec
 * `surActivite` et envoie l'evenement ACTIVITE_EXTERNE au noyau ; les pages appellent `signalerActivite` / `declarerRoulageActif`.
 */
type Ecouteur = () => void;

const ecouteurs = new Set<Ecouteur>();
let roulageActif = false;

export function surActivite(ecouteur: Ecouteur): () => void {
  ecouteurs.add(ecouteur);
  return () => { ecouteurs.delete(ecouteur); };
}

export function signalerActivite(): void {
  for (const e of [...ecouteurs]) e();
}

export function declarerRoulageActif(actif: boolean): void {
  roulageActif = actif;
  if (actif) signalerActivite();
}

export function roulageEstActif(): boolean {
  return roulageActif;
}
