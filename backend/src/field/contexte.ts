/**
 * « Ou suis-je, et que sais-je de cet endroit ? »
 *
 * C'est la premiere question du mode terrain, et elle en contient cinq : sur quel troncon,
 * a quelle abscisse, sur quelle portion, dans quel etat connu, et quels actifs autour.
 *
 * CE SERVICE NE DEVINE RIEN
 *
 * Chaque reponse absente porte un MOTIF, parce que les motifs n'appellent pas la meme
 * action de l'agent :
 *
 *   AUCUN_CANDIDAT_SUR      le GPS ne permet pas de conclure. Se rapprocher, attendre une
 *                           meilleure precision, ou saisir en GPS brut.
 *   TRONCON_NON_QUALIFIE    le troncon n'a AUCUNE portion. Il faut commencer l'inventaire.
 *   TROU_DE_QUALIFICATION   des portions existent mais pas ici. Il faut combler.
 *
 * Confondre les deux derniers enverrait l'agent faire le mauvais geste : commencer un
 * inventaire la ou il faut completer, ou l'inverse.
 *
 * LES SOURCES SONT INJECTEES
 *
 * La composition ci-dessous est pure et se teste sans base. L'implementation Prisma vit
 * dans `contexte.prisma.ts`. C'est la meme separation que `reseau/portions.ts`, et pour la
 * meme raison : ce qui est difficile ici est le RAISONNEMENT, pas la requete.
 */
import type { Appariement, OptionsAppariement, PositionGps } from "../geo/appariement";
import { couverture, portionA, type Couverture, type Portion } from "../reseau/portions";

export interface ActifProche {
  id: string;
  type: string;
  nom: string | null;
  /** Distance a la position de l'agent, en metres. */
  distanceM: number;
  etat: string | null;
  derniereInspectionLe: Date | null;
}

export interface SourcesContexte {
  apparier(p: PositionGps, o?: OptionsAppariement): Promise<Appariement | null>;
  /**
   * Longueur REELLE de la geometrie, en metres. Jamais `longueurKm` : les deux divergent,
   * et la regle du depot interdit d'ecraser l'une par l'autre.
   *
   * Nulle quand le troncon n'a pas de geometrie exploitable.
   */
  longueurTronconM(tronconId: string): Promise<number | null>;
  portionsDuTroncon(tronconId: string): Promise<Portion[]>;
  actifsProches(p: PositionGps, rayonM: number): Promise<ActifProche[]>;
}

export type MotifSansTroncon = "AUCUN_CANDIDAT_SUR";
export type MotifSansPortion =
  | "TRONCON_NON_QUALIFIE"
  | "TROU_DE_QUALIFICATION"
  | "LONGUEUR_TRONCON_INCONNUE";

export interface ContexteTerrain {
  position: PositionGps;
  /** Nul quand l'appariement n'a pas conclu. */
  troncon: Appariement | null;
  motifSansTroncon: MotifSansTroncon | null;
  /** Nulle quand aucune portion ne couvre l'abscisse. */
  portion: Portion | null;
  motifSansPortion: MotifSansPortion | null;
  /** Nulle quand il n'y a pas de troncon, ou pas de longueur mesurable. */
  couverture: Couverture | null;
  actifsProches: ActifProche[];
  /**
   * `true` quand un autre troncon est a portee de l'incertitude GPS. L'ecran doit alors
   * proposer un choix au lieu d'afficher une certitude.
   */
  ambigu: boolean;
}

/**
 * Rayon de recherche des actifs, en metres.
 *
 * 150 m est ce qu'un agent voit depuis son vehicule sur une route rase. Plus large
 * ramenerait des ouvrages qu'il ne peut pas constater ; plus etroit en masquerait un juste
 * derriere un virage. Reglable par l'appelant.
 */
export const RAYON_ACTIFS_M = 150;

export async function contexteTerrain(
  position: PositionGps,
  sources: SourcesContexte,
  options: { appariement?: OptionsAppariement; rayonActifsM?: number } = {},
): Promise<ContexteTerrain> {
  const rayon = options.rayonActifsM ?? RAYON_ACTIFS_M;

  // Les actifs se cherchent autour de la POSITION, pas autour du troncon : ils doivent
  // apparaitre meme quand l'appariement echoue, sinon l'agent perd la seule information
  // exploitable la ou il en a le plus besoin.
  const [appariement, actifsProches] = await Promise.all([
    sources.apparier(position, options.appariement),
    sources.actifsProches(position, rayon),
  ]);

  if (appariement === null) {
    return {
      position,
      troncon: null,
      motifSansTroncon: "AUCUN_CANDIDAT_SUR",
      portion: null,
      motifSansPortion: null,
      couverture: null,
      actifsProches,
      ambigu: false,
    };
  }

  const [longueurM, portions] = await Promise.all([
    sources.longueurTronconM(appariement.tronconId),
    sources.portionsDuTroncon(appariement.tronconId),
  ]);

  if (longueurM === null) {
    // Sans longueur mesuree, la couverture n'a pas de denominateur. On rend quand meme la
    // portion si une la contient : l'abscisse, elle, est connue.
    const p = portionA(portions, appariement.abscisseM);
    return {
      position,
      troncon: appariement,
      motifSansTroncon: null,
      portion: p,
      motifSansPortion: p === null ? "LONGUEUR_TRONCON_INCONNUE" : null,
      couverture: null,
      actifsProches,
      ambigu: appariement.ambigu,
    };
  }

  const portion = portionA(portions, appariement.abscisseM);
  const c = couverture(portions, longueurM);

  return {
    position,
    troncon: appariement,
    motifSansTroncon: null,
    portion,
    // La distinction qui compte : rien d'inventorie, ou un trou dans un inventaire
    // commence. Les deux appellent un geste different.
    motifSansPortion: portion !== null
      ? null
      : c.qualifieM === 0 ? "TRONCON_NON_QUALIFIE" : "TROU_DE_QUALIFICATION",
    couverture: c,
    actifsProches,
    ambigu: appariement.ambigu,
  };
}
