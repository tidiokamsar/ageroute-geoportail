/**
 * Portions homogenes d'un troncon.
 *
 * LE PROBLEME
 *
 * Un troncon de reference porte aujourd'hui UN revetement et UN etat pour toute sa
 * longueur. La realite du terrain ne s'y plie pas : 8 km de bitume en bon etat, 5 km de
 * bitume degrade, 4 km de laterite, 3 km critiques, et c'est le meme troncon.
 *
 * Une PORTION decrit une partie homogene de ce troncon. Le troncon garde son identite et
 * sa geometrie de reference ; la portion dit ce qu'on observe entre deux abscisses.
 *
 * L'ABSCISSE LOCALE EST LA REFERENCE, PAS LE PK
 *
 * Une portion vit entre `debutM` et `finM`, mesures en metres depuis le debut de la
 * geometrie de reference. C'est ce que `ST_LineLocatePoint` rend, c'est ce que
 * `appariement.ts` produit deja, et c'est disponible partout.
 *
 * Le PK officiel reste une reference COMPLEMENTAIRE, calculee quand la calibration
 * existe. Mesure du 13/10/2026 : les 1 029 troncons regionaux portent 1 029 noms distincts
 * sans structure de route, donc leurs PK ne sont pas calculables. Faire dependre la
 * qualification du PK aurait rendu la voirie regionale inqualifiable.
 *
 * POURQUOI AUCUNE PORTION IMPLICITE
 *
 * La tentation est d'ecrire que, faute de portions, le troncon entier vaut une portion
 * portant son propre `revetement` et son propre `etat`. Mesure du 13/10/2026 en
 * production, qui l'interdit :
 *
 *   revetement : 258 961 NON_RENSEIGNE, 2 426 BITUME, et RIEN d'autre
 *                (zero laterite, zero terre, zero pave, sur un reseau ou la laterite
 *                 domine)
 *   etat       : 254 547 NON_EVALUE sur 261 387
 *
 * Deduire 261 387 portions de ces colonnes fabriquerait 258 961 portions qui n'affirment
 * rien et 2 426 qui affirment « bitume » sans source ni date. Un troncon sans portion est
 * donc NON QUALIFIE, et `couverture()` le dit comme un trou, pas comme un etat.
 *
 * CE MODULE NE TOUCHE JAMAIS LA GEOMETRIE DE REFERENCE
 *
 * Qualifier le terrain et corriger un trace sont deux operations distinctes, avec des
 * droits distincts. Ce module ne produit que des bornes le long d'une geometrie existante.
 * Rien ici ne peut deplacer une route.
 */

/** Revetements et etats restent les vocabulaires Prisma existants, cites par leur nom. */
export type CodeRevetement = string;
export type CodeEtat = string;
export type CodePraticabilite = string;

/**
 * Tolerance de jointure, en metres.
 *
 * Deux portions dont les bornes se touchent a 5 cm pres sont adjacentes : la difference
 * vient de l'arrondi d'un calcul en coordonnees geographiques, pas du terrain. Au-dela,
 * c'est un trou qu'il faut voir.
 */
export const TOLERANCE_M = 0.05;

/**
 * Longueur minimale d'une portion, en metres.
 *
 * 10 m est un plancher de BRUIT, pas une norme : en dessous, on decrit la derive d'un GPS
 * et non un changement de chaussee. Le seuil METIER (combien de metres de degradation
 * justifient une portion ?) appartient a AGEROUTE et vit dans une regle, comme les
 * coefficients du RCI. Celui-ci empeche seulement d'enregistrer du neant.
 */
export const LONGUEUR_MINIMALE_M = 10;

/**
 * D'ou vient une portion. Sans cela, un decoupage et un releve de terrain se ressemblent,
 * et l'historique devient illisible.
 */
export type OriginePortion =
  | "SAISIE_TERRAIN"
  | "DECOUPE"
  | "FUSION"
  | "REQUALIFICATION"
  | "IMPORT";

export interface Portion {
  id: string;
  tronconId: string;
  /** Abscisse de debut, en metres depuis le debut de la geometrie de reference. */
  debutM: number;
  /** Abscisse de fin. Toujours strictement superieure a `debutM`. */
  finM: number;
  revetement: CodeRevetement | null;
  etat: CodeEtat | null;
  /**
   * Praticabilite, distincte du revetement ET de l'etat.
   *
   * Une piste en laterite peut etre en bon etat et devenir impraticable apres les pluies.
   * Les confondre perd exactement l'information qui decide d'une mission.
   */
  praticabilite: CodePraticabilite | null;
  largeurM: number | null;
  /** D'ou vient l'observation. Nulle quand personne ne l'a dit. */
  source: string | null;
  /** Date du CONSTAT, pas de la saisie. Nulle quand elle est inconnue. */
  observeeLe: Date | null;
  confiance: "HIGH" | "MEDIUM" | "LOW" | null;
  statutValidation: "A_VALIDER" | "VALIDE" | "REJETE" | "A_CORRIGER";
  origine: OriginePortion;
  /**
   * Cle d'idempotence generee par l'appareil. Nulle pour une saisie console.
   *
   * Sans elle, une reponse perdue en zone blanche fait renvoyer l'operation et cree une
   * seconde portion sur la meme emprise. Deux PROPOSITIONS sur les memes metres ne violent
   * pas la contrainte d'exclusion, qui ne porte que sur le valide : le doublon passerait
   * donc sans bruit jusqu'a l'arbitrage.
   */
  clientOperationId: string | null;
  /** Date a laquelle cette version a ete remplacee. Nulle si elle est courante. */
  remplaceeLe: Date | null;
  /**
   * Suppression logique (regle 2 d'AGENTS.md).
   *
   * DISTINCT de `remplaceeLe`, et la distinction porte : `remplaceeLe` dit « ceci etait
   * vrai et ne l'est plus », `deletedAt` dit « ceci n'aurait jamais du etre saisi ». Les
   * confondre rendrait l'historique du reseau inexplicable.
   */
  deletedAt: Date | null;
}

export type RefusPortion =
  | "BORNES_INVERSEES"
  | "HORS_TRONCON"
  | "TROP_COURTE"
  | "LONGUEUR_TRONCON_INCONNUE";

/**
 * Une portion tient-elle debout sur un troncon de cette longueur ?
 *
 * `longueurTronconM` doit etre la longueur REELLE de la geometrie, pas `longueurKm` : les
 * deux divergent, et la regle du depot interdit d'ecraser l'une par l'autre. L'appelant
 * fournit celle qu'il a mesuree.
 */
export function refusPortion(
  p: Pick<Portion, "debutM" | "finM">,
  longueurTronconM: number | null,
): RefusPortion | null {
  if (longueurTronconM === null || !Number.isFinite(longueurTronconM) || longueurTronconM <= 0) {
    return "LONGUEUR_TRONCON_INCONNUE";
  }
  if (!Number.isFinite(p.debutM) || !Number.isFinite(p.finM)) return "BORNES_INVERSEES";
  if (p.finM <= p.debutM) return "BORNES_INVERSEES";
  // Une portion qui depasse le troncon decrirait une route qui n'existe pas. La tolerance
  // absorbe l'arrondi de la longueur, pas une erreur de saisie.
  if (p.debutM < -TOLERANCE_M || p.finM > longueurTronconM + TOLERANCE_M) return "HORS_TRONCON";
  if (p.finM - p.debutM < LONGUEUR_MINIMALE_M) return "TROP_COURTE";
  return null;
}

/**
 * Les portions COURANTES : ni remplacees, ni supprimees logiquement.
 *
 * Les deux exclusions ne disent pas la meme chose, mais une portion remplacee comme une
 * portion effacee ne decrit plus l'etat actuel du reseau. Toute la suite du module part
 * d'ici, pour qu'aucun calcul n'ait a se souvenir de filtrer.
 */
export function courantes(portions: readonly Portion[]): Portion[] {
  return portions.filter((p) => p.remplaceeLe === null && p.deletedAt === null);
}

export interface Chevauchement {
  a: string;
  b: string;
  /** Metres communs aux deux portions. */
  longueurM: number;
}

/**
 * Chevauchements entre portions courantes du meme troncon.
 *
 * SIGNALE, NE CORRIGE PAS. Deux portions qui se recouvrent disent deux choses du meme
 * metre de route ; choisir automatiquement laquelle garder reviendrait a trancher une
 * contradiction de terrain depuis un serveur. C'est une proposition a arbitrer.
 *
 * Les portions remplacees sont ignorees : l'historique se recouvre par construction, et
 * c'est tout son interet.
 */
export function chevauchements(portions: readonly Portion[]): Chevauchement[] {
  const vivantes = courantes(portions).slice().sort((x, y) => x.debutM - y.debutM);
  const trouves: Chevauchement[] = [];
  for (let i = 0; i < vivantes.length; i++) {
    for (let j = i + 1; j < vivantes.length; j++) {
      const a = vivantes[i];
      const b = vivantes[j];
      // Triees par debut : des que b commence apres la fin de a, aucun suivant ne
      // chevauchera a.
      if (b.debutM >= a.finM - TOLERANCE_M) break;
      const commun = Math.min(a.finM, b.finM) - Math.max(a.debutM, b.debutM);
      if (commun > TOLERANCE_M) {
        trouves.push({ a: a.id, b: b.id, longueurM: arrondir(commun, 2) });
      }
    }
  }
  return trouves;
}

export interface Trou {
  debutM: number;
  finM: number;
  longueurM: number;
}

export interface Couverture {
  longueurTronconM: number;
  /** Metres couverts par au moins une portion courante. */
  qualifieM: number;
  /** Part de 0 a 1. */
  part: number;
  /** Les intervalles NON qualifies, nommes un par un. */
  trous: Trou[];
}

/**
 * Quelle part du troncon est qualifiee, et ou sont les trous.
 *
 * Les trous sont ENUMERES et non resumes a un pourcentage : « 60 % qualifie » n'envoie
 * personne nulle part, « non qualifie de 8 200 m a 11 400 m » envoie une equipe au bon
 * endroit. C'est la meme raison qui fait nommer les composantes absentes dans le RCI.
 *
 * Un troncon sans portion rend `part: 0` et un trou sur toute sa longueur. Il n'herite
 * jamais du `revetement` ni de l'`etat` porte par le troncon : voir l'en-tete du module.
 */
export function couverture(
  portions: readonly Portion[],
  longueurTronconM: number,
): Couverture {
  const vivantes = courantes(portions)
    .slice()
    .sort((x, y) => x.debutM - y.debutM);

  const trous: Trou[] = [];
  let qualifieM = 0;
  let curseur = 0;

  for (const p of vivantes) {
    const debut = Math.max(0, p.debutM);
    const fin = Math.min(longueurTronconM, p.finM);
    if (fin <= curseur) continue; // entierement recouverte par ce qui precede
    if (debut - curseur > TOLERANCE_M) {
      trous.push({
        debutM: arrondir(curseur, 2),
        finM: arrondir(debut, 2),
        longueurM: arrondir(debut - curseur, 2),
      });
    }
    qualifieM += fin - Math.max(curseur, debut);
    curseur = fin;
  }

  if (longueurTronconM - curseur > TOLERANCE_M) {
    trous.push({
      debutM: arrondir(curseur, 2),
      finM: arrondir(longueurTronconM, 2),
      longueurM: arrondir(longueurTronconM - curseur, 2),
    });
  }

  return {
    longueurTronconM: arrondir(longueurTronconM, 2),
    qualifieM: arrondir(qualifieM, 2),
    part: longueurTronconM > 0 ? arrondir(qualifieM / longueurTronconM, 4) : 0,
    trous,
  };
}

export type RefusDecoupe = "HORS_PORTION" | "MORCEAU_TROP_COURT" | "PORTION_REMPLACEE";

/**
 * Decoupe une portion a une abscisse, et rend les DEUX morceaux.
 *
 * La portion d'origine n'est pas modifiee : l'appelant la marque `remplaceeLe` et insere
 * les deux morceaux. Une portion qu'on modifierait en place perdrait ce qu'elle disait
 * avant, et les validations rendues sous elle deviendraient inexplicables.
 *
 * Decouper ne QUALIFIE pas : les deux morceaux heritent des attributs, de la source et de
 * la date de l'original. Leur donner d'office un etat different inventerait une
 * observation que personne n'a faite. C'est l'etape suivante, et elle est explicite.
 */
export function decouper(
  p: Portion,
  aM: number,
  nouveauxIds: [string, string],
): { refus: RefusDecoupe } | { refus: null; morceaux: [Portion, Portion] } {
  if (p.remplaceeLe !== null || p.deletedAt !== null) return { refus: "PORTION_REMPLACEE" };
  if (!Number.isFinite(aM) || aM <= p.debutM || aM >= p.finM) return { refus: "HORS_PORTION" };
  if (aM - p.debutM < LONGUEUR_MINIMALE_M || p.finM - aM < LONGUEUR_MINIMALE_M) {
    return { refus: "MORCEAU_TROP_COURT" };
  }
  return {
    refus: null,
    morceaux: [
      { ...p, id: nouveauxIds[0], finM: aM },
      { ...p, id: nouveauxIds[1], debutM: aM },
    ],
  };
}

export type RefusFusion =
  | "TRONCONS_DIFFERENTS"
  | "NON_ADJACENTES"
  | "ATTRIBUTS_DIFFERENTS"
  | "VALIDATIONS_DIFFERENTES"
  | "PORTION_REMPLACEE";

/**
 * Deux portions decrivent-elles la meme chose, bout a bout ?
 *
 * `null` quand elles sont fusionnables, sinon le motif du refus. Les attributs doivent
 * concorder EXACTEMENT : fusionner une portion en bon etat avec une portion en etat moyen
 * produirait une portion dont l'etat serait un choix du programme, pas une observation.
 *
 * Le statut de validation doit concorder aussi. Fusionner une portion validee avec une
 * proposition ferait entrer la seconde dans le referentiel officiel sans decision, ce que
 * le paragraphe 10 de la demande interdit explicitement.
 */
export function refusFusion(a: Portion, b: Portion): RefusFusion | null {
  if (a.remplaceeLe !== null || b.remplaceeLe !== null) return "PORTION_REMPLACEE";
  if (a.deletedAt !== null || b.deletedAt !== null) return "PORTION_REMPLACEE";
  if (a.tronconId !== b.tronconId) return "TRONCONS_DIFFERENTS";

  const [gauche, droite] = a.debutM <= b.debutM ? [a, b] : [b, a];
  if (Math.abs(droite.debutM - gauche.finM) > TOLERANCE_M) return "NON_ADJACENTES";

  if (
    a.revetement !== b.revetement
    || a.etat !== b.etat
    || a.praticabilite !== b.praticabilite
    || a.largeurM !== b.largeurM
  ) {
    return "ATTRIBUTS_DIFFERENTS";
  }
  if (a.statutValidation !== b.statutValidation) return "VALIDATIONS_DIFFERENTES";
  return null;
}

/**
 * Fusionne deux portions adjacentes et compatibles.
 *
 * La portion fusionnee prend la date d'observation la PLUS ANCIENNE et la confiance la
 * PLUS FAIBLE. Prendre la plus recente et la plus forte ferait paraitre l'ensemble mieux
 * connu qu'il ne l'est : on ne gagne pas en fraicheur en additionnant deux releves.
 *
 * La source est conservee quand les deux concordent ; sinon elle devient nulle, parce
 * qu'une portion issue de deux releves distincts ne vient pas d'un seul.
 */
export function fusionner(
  a: Portion,
  b: Portion,
  nouvelId: string,
): { refus: RefusFusion } | { refus: null; portion: Portion } {
  const refus = refusFusion(a, b);
  if (refus !== null) return { refus };

  const [gauche, droite] = a.debutM <= b.debutM ? [a, b] : [b, a];
  return {
    refus: null,
    portion: {
      ...gauche,
      id: nouvelId,
      debutM: gauche.debutM,
      finM: droite.finM,
      source: a.source === b.source ? a.source : null,
      observeeLe: plusAncienne(a.observeeLe, b.observeeLe),
      confiance: plusFaible(a.confiance, b.confiance),
    },
  };
}

/**
 * La portion courante a une abscisse donnee, ou `null`.
 *
 * Rend `null` et non une portion voisine quand l'abscisse tombe dans un trou. Repondre
 * « la portion d'a cote » a la question « ou suis-je » est precisement le rattachement
 * arbitraire que l'appariement refuse deja.
 *
 * En cas de chevauchement non arbitre, rend la portion la plus recemment OBSERVEE, et
 * `chevauchements()` reste la pour signaler que la contradiction existe.
 */
export function portionA(portions: readonly Portion[], abscisseM: number): Portion | null {
  const candidates = courantes(portions).filter(
    (p) => abscisseM >= p.debutM - TOLERANCE_M && abscisseM < p.finM + TOLERANCE_M,
  );
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  return candidates.reduce((meilleure, p) => {
    const t = p.observeeLe?.getTime() ?? Number.NEGATIVE_INFINITY;
    const tm = meilleure.observeeLe?.getTime() ?? Number.NEGATIVE_INFINITY;
    return t > tm ? p : meilleure;
  });
}

export interface RepartitionLigne {
  cle: string;
  longueurM: number;
  part: number;
}

/**
 * Longueurs par revetement, par etat ou par praticabilite.
 *
 * `cle` vaut `"NON_QUALIFIE"` pour les trous, et cette ligne est TOUJOURS presente quand
 * il en reste. Une repartition qui ne montrerait que les portions connues laisserait
 * croire le reseau entierement inventorie.
 *
 * `publiables` ne retient que les portions VALIDEES. Compter les propositions gonflerait
 * les statistiques officielles avec ce que personne n'a encore accepte.
 */
export function repartition(
  portions: readonly Portion[],
  longueurTronconM: number,
  champ: "revetement" | "etat" | "praticabilite",
  options: { publiablesSeules?: boolean } = {},
): RepartitionLigne[] {
  const retenues = courantes(portions).filter(
    (p) => !options.publiablesSeules || p.statutValidation === "VALIDE",
  );

  const parCle = new Map<string, number>();
  for (const p of retenues) {
    const cle = p[champ] ?? "NON_RENSEIGNE";
    parCle.set(cle, (parCle.get(cle) ?? 0) + (p.finM - p.debutM));
  }

  const nonQualifie = couverture(retenues, longueurTronconM).trous
    .reduce((s, t) => s + t.longueurM, 0);
  if (nonQualifie > TOLERANCE_M) parCle.set("NON_QUALIFIE", nonQualifie);

  return [...parCle.entries()]
    .map(([cle, longueurM]) => ({
      cle,
      longueurM: arrondir(longueurM, 2),
      part: longueurTronconM > 0 ? arrondir(longueurM / longueurTronconM, 4) : 0,
    }))
    .sort((x, y) => y.longueurM - x.longueurM);
}

function plusAncienne(a: Date | null, b: Date | null): Date | null {
  // Une date absente n'est pas ancienne : elle est inconnue, et inconnu est pire que
  // vieux. La fusion perd donc la date des qu'un des deux releves n'en a pas.
  if (a === null || b === null) return null;
  return a.getTime() <= b.getTime() ? a : b;
}

const RANG: Record<"HIGH" | "MEDIUM" | "LOW", number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

function plusFaible(
  a: "HIGH" | "MEDIUM" | "LOW" | null,
  b: "HIGH" | "MEDIUM" | "LOW" | null,
): "HIGH" | "MEDIUM" | "LOW" | null {
  if (a === null || b === null) return null;
  return RANG[a] <= RANG[b] ? a : b;
}

function arrondir(v: number, decimales: number): number {
  const f = 10 ** decimales;
  return Math.round(v * f) / f;
}

/** Ce que le referentiel dit d'un revetement, reduit a ce dont les indicateurs ont besoin. */
export interface FlagRevetement {
  bitumineux: boolean;
}

/** Idem pour un etat de chaussee. */
export interface FlagEtat {
  critique: boolean;
}

export interface IndicateursPortions {
  longueurTronconM: number;
  qualifieM: number;
  nonQualifieM: number;
  /** Portions dont le revetement est declare bitumineux au referentiel. */
  bitumineM: number;
  /** Portions dont le revetement est declare NON bitumineux. */
  nonBitumineM: number;
  /**
   * Portions qualifiees dont le revetement est inconnu : absent, ou portant un code que
   * le referentiel ne connait pas.
   *
   * CE SEAU EXISTE POUR NE PAS MENTIR. Le ranger dans `nonBitumineM` ferait passer
   * « on ne sait pas » pour « ce n'est pas du bitume », ce qui est l'erreur la plus facile
   * et la plus couteuse : elle sous-estime le reseau revetu, donc le patrimoine a
   * entretenir.
   */
  revetementInconnuM: number;
  /** Portions dont l'etat est declare critique au referentiel. */
  critiqueM: number;
  /** Portions qualifiees dont l'etat est inconnu. Meme raisonnement. */
  etatInconnuM: number;
}

/**
 * Longueurs par revetement et par etat, en s'appuyant sur les DRAPEAUX du referentiel.
 *
 * POURQUOI LE REFERENTIEL EST UN PARAMETRE
 *
 * « Longueur bitumee » ne se deduit pas d'un code : avec un vocabulaire administrable, un
 * libelle ajoute demain ne dira pas au programme s'il est bitumineux. La propriete est
 * declaree sur la valeur, et cette fonction la LIT au lieu de la devenir.
 *
 * Un code que le referentiel ne connait pas tombe dans `revetementInconnuM`, jamais dans
 * `nonBitumineM` : une valeur qu'on ne sait pas interpreter n'est pas une valeur negative.
 *
 * `publiablesSeules` ne retient que les portions VALIDEES. Compter les propositions
 * gonflerait les indicateurs officiels avec ce que personne n'a accepte.
 */
export function indicateurs(
  portions: readonly Portion[],
  longueurTronconM: number,
  referentiel: {
    revetements: ReadonlyMap<string, FlagRevetement>;
    etats: ReadonlyMap<string, FlagEtat>;
  },
  options: { publiablesSeules?: boolean } = {},
): IndicateursPortions {
  const retenues = courantes(portions).filter(
    (p) => !options.publiablesSeules || p.statutValidation === "VALIDE",
  );

  let bitumineM = 0;
  let nonBitumineM = 0;
  let revetementInconnuM = 0;
  let critiqueM = 0;
  let etatInconnuM = 0;

  for (const p of retenues) {
    const longueur = p.finM - p.debutM;

    const flagR = p.revetement === null ? undefined : referentiel.revetements.get(p.revetement);
    if (flagR === undefined) revetementInconnuM += longueur;
    else if (flagR.bitumineux) bitumineM += longueur;
    else nonBitumineM += longueur;

    const flagE = p.etat === null ? undefined : referentiel.etats.get(p.etat);
    if (flagE === undefined) etatInconnuM += longueur;
    else if (flagE.critique) critiqueM += longueur;
  }

  const c = couverture(retenues, longueurTronconM);
  return {
    longueurTronconM: c.longueurTronconM,
    qualifieM: c.qualifieM,
    nonQualifieM: arrondir(c.longueurTronconM - c.qualifieM, 2),
    bitumineM: arrondir(bitumineM, 2),
    nonBitumineM: arrondir(nonBitumineM, 2),
    revetementInconnuM: arrondir(revetementInconnuM, 2),
    critiqueM: arrondir(critiqueM, 2),
    etatInconnuM: arrondir(etatInconnuM, 2),
  };
}
