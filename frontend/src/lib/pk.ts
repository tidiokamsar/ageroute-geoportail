/**
 * Notation du point kilometrique, en un seul endroit.
 *
 * LE BOGUE CORRIGE, ET POURQUOI IL EXISTAIT EN DEUX EXEMPLAIRES
 *
 * Deux fonctions `fmtPk` vivaient dans le depot — `pages/geoportail/DetailPanel.tsx` et
 * `pages/TronconsPage.tsx` — avec le meme calcul et deux sorties differentes. Toutes deux
 * faisaient :
 *
 *     const km = Math.floor(v);
 *     const m  = Math.round((v - km) * 1000);
 *
 * `Math.round` peut rendre 1000, qui n'est pas un decalage metrique valide dans un kilometre :
 * 1,9999 km s'affichait « PK 1+1000 » au lieu de « PK 2+000 ». Le paragraphe 1 du mandat v2.1
 * citait ce bogue parmi les constats d'audit.
 *
 * LA CORRECTION TIENT A L'UNITE DE TRAVAIL
 *
 * La notation « 188+420 » exprime des METRES ENTIERS : 188 kilometres et 420 metres. Le calcul
 * se fait donc en metres entiers, et le report du kilometre devient une division, non un cas
 * particulier a rattraper :
 *
 *     const metres = Math.round(pk * 1000);
 *     km = Math.floor(metres / 1000);  m = metres % 1000;
 *
 * Arrondir AVANT de separer, plutot qu'apres, supprime la classe entiere de bogues : aucun
 * reste ne peut plus valoir 1000.
 *
 * CE MODULE NE CALCULE PAS DE PK, IL LE MET EN FORME
 *
 * Le paragraphe 7.2 du mandat est explicite : « Le PK n'est jamais obligatoire. Il est calcule
 * et affiche uniquement si une calibration fiable existe. » Sur 1 029 troncons regionaux, il
 * n'est pas calculable faute de rattachement a un axe — voir
 * `docs/rai-v3/REFERENTIEL_AXES_REGIONAUX.md`. Ce module recoit donc un PK deja calcule, ou
 * rien, et dit lequel des deux.
 */

/**
 * Ce qui s'affiche quand il n'y a pas de PK.
 *
 * UNE PHRASE, PAS UN TIRET. « — » se lit « la valeur existe mais manque » et invite a la
 * saisir. Or sur la majorite du reseau regional le PK n'est pas calculable : c'est une
 * impossibilite documentee, pas une lacune de saisie. Dire « non calculable » evite qu'un
 * agent cherche a remplir un champ qui ne peut pas l'etre.
 */
export const PK_NON_CALCULABLE = "non calculable";

export interface OptionsPk {
  /** Prefixer par « PK ». Vrai par defaut ; faux dans une colonne dont l'en-tete le dit deja. */
  prefixe?: boolean;
}

/**
 * Met en forme un PK exprime en kilometres decimaux.
 *
 * Rend `PK_NON_CALCULABLE` pour tout ce qui n'est pas un PK : absence, valeur negative, valeur
 * non finie. Un PK negatif n'a pas de sens — l'origine d'un troncon est son point zero — et le
 * formater donnerait « PK -1+500 », qui a l'air d'une donnee alors que c'est une faute.
 */
export function formaterPk(
  pk: number | null | undefined,
  options: OptionsPk = {},
): string {
  if (pk === null || pk === undefined) return PK_NON_CALCULABLE;
  if (!Number.isFinite(pk) || pk < 0) return PK_NON_CALCULABLE;

  // Arrondi AVANT la separation : c'est ce qui empeche un reste de valoir 1000.
  const metres = Math.round(pk * 1000);
  const km = Math.floor(metres / 1000);
  const m = metres % 1000;

  const corps = `${km}+${String(m).padStart(3, "0")}`;
  return options.prefixe === false ? corps : `PK ${corps}`;
}

/**
 * Intervalle de PK, pour une plage de troncon.
 *
 * Le prefixe n'apparait qu'une fois : « PK 12+000 → 18+400 » se lit mieux que
 * « PK 12+000 → PK 18+400 », et c'est la forme employee dans les documents routiers.
 *
 * Quand une seule borne manque, l'intervalle entier devient non calculable : afficher
 * « PK 12+000 → non calculable » laisserait croire que la plage commence quelque part, alors
 * qu'une plage sans fin n'en est pas une.
 */
export function formaterPlagePk(
  debut: number | null | undefined,
  fin: number | null | undefined,
): string {
  const d = formaterPk(debut, { prefixe: false });
  const f = formaterPk(fin, { prefixe: false });
  if (d === PK_NON_CALCULABLE || f === PK_NON_CALCULABLE) return PK_NON_CALCULABLE;
  return `PK ${d} → ${f}`;
}
